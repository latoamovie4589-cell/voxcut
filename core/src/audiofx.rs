//! 素材の音の加工（CapCut の「ノイズ除去」「音量を均一に」「ボイスチェンジャー」）と、拍の検出。
//! 加工は書き出しと同じフィルターで、プレビュー用に素材まるごとを加工した WAV も作る（同じ音になる）。

use crate::model::{AudioFilter, Reverb};
use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 声の変え方
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VoiceFx {
    /// 高い声（ヘリウム）
    High,
    /// 低い声
    Low,
    /// ロボット
    Robot,
    /// ラジオ・電話
    Radio,
    /// やまびこ
    Echo,
    /// 拡声器
    Megaphone,
}

/// 素材の音の加工。画面側の model.ts の MediaAudioFx と同じ
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaAudioFx {
    /// 雑音を減らす
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub denoise: bool,
    /// 声を変える
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceFx>,
    /// 音量をそろえるための増減（dB）。「音量を均一に」を入れたときに素材を測って決める
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain_db: Option<f64>,
    /// 音の高さ（半音。長さは変えない。±12）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pitch: Option<f64>,
    /// 音声エフェクト（イコライザー・コンプレッサー・リミッターなど。上から順に掛ける）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<AudioFilter>,
    /// リバーブ（部屋・ホールの響き）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverb: Option<Reverb>,
}

impl MediaAudioFx {
    pub fn is_plain(&self) -> bool {
        !self.denoise
            && self.voice.is_none()
            && self.gain_db.is_none_or(|g| g.abs() < 1e-6)
            && self.pitch.is_none_or(|p| p.abs() < 0.05)
            && self.filters.iter().all(|f| filter_ff(f).is_empty())
            && self.reverb.as_ref().is_none_or(|r| reverb_plan(r).is_none())
    }
}

/// 音声エフェクト 1 つ分のフィルター（何も変えない設定なら空）。セリフ（render.rs）も素材の音もこれを使う
pub fn filter_ff(f: &AudioFilter) -> String {
    match f {
        AudioFilter::Highpass { hz } => format!("highpass=f={:.1}:width_type=q:width=0.7071", hz.max(1.0)),
        AudioFilter::Lowpass { hz } => format!("lowpass=f={:.1}:width_type=q:width=0.7071", hz.max(1.0)),
        AudioFilter::Eq { low_db, mid_db, high_db, mid_hz } => {
            // 低音・高音は 2 次の棚（Q=0.7071。画面の lowshelf / highshelf と同じ）、中音は Q=1 の山
            let mut v: Vec<String> = vec![];
            if low_db.abs() >= 0.05 {
                v.push(format!("bass=g={:.2}:f={EQ_LOW_HZ}:width_type=q:w=0.7071", low_db.clamp(-24.0, 24.0)));
            }
            if mid_db.abs() >= 0.05 {
                v.push(format!("equalizer=f={:.1}:width_type=q:w={EQ_MID_Q}:g={:.2}", mid_hz.clamp(100.0, 8000.0), mid_db.clamp(-24.0, 24.0)));
            }
            if high_db.abs() >= 0.05 {
                v.push(format!("treble=g={:.2}:f={EQ_HIGH_HZ}:width_type=q:w=0.7071", high_db.clamp(-24.0, 24.0)));
            }
            v.join(",")
        }
        AudioFilter::Compressor { threshold_db, ratio, attack_ms, release_ms, makeup_db } => {
            let th = db_to_lin(threshold_db.clamp(-60.0, 0.0)).clamp(0.000976563, 1.0);
            let mut s = format!(
                "acompressor=threshold={th:.6}:ratio={:.2}:attack={:.1}:release={:.1}:knee={COMP_KNEE}",
                ratio.clamp(1.0, 20.0),
                attack_ms.clamp(0.01, 2000.0),
                release_ms.clamp(0.01, 9000.0)
            );
            if makeup_db.abs() >= 0.05 {
                s.push_str(&format!(",volume={:.2}dB", makeup_db.clamp(-24.0, 24.0)));
            }
            s
        }
        AudioFilter::Limiter { ceiling_db } => format!("alimiter=limit={:.4}:attack=5:release=50:level=0", db_to_lin(ceiling_db.clamp(-24.0, 0.0)).clamp(0.0625, 1.0)),
    }
}

/// イコライザーの帯域（画面の BiquadFilter と同じ値）
pub const EQ_LOW_HZ: f64 = 200.0;
pub const EQ_HIGH_HZ: f64 = 5000.0;
pub const EQ_MID_Q: f64 = 1.0;
/// コンプレッサーの肩の丸さ（FFmpeg の knee。画面の DynamicsCompressor は 3dB）
pub const COMP_KNEE: f64 = 2.82843;

fn db_to_lin(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// リバーブの反射：2 段に重ねる（1 段目 5 つ、2 段目 4 つ。基準の遅れは ms）。画面（playback.ts の reverbPlan）と同じ
pub const REVERB_BASE: [&[f64]; 2] = [&[31.0, 53.0, 79.0, 113.0, 151.0], &[167.0, 229.0, 311.0, 401.0]];

/// 1 段ごとの（遅れ ms、大きさ）と、全体の音量の補正。混ざる量がほぼ 0 なら None
pub struct ReverbPlan {
    pub stages: [Vec<(f64, f64)>; 2],
    pub gain: f64,
}

pub fn reverb_plan(r: &Reverb) -> Option<ReverbPlan> {
    let wet = r.wet.clamp(0.0, 1.0);
    if wet < 0.005 {
        return None;
    }
    let k = 0.5 + 1.5 * r.size.clamp(0.0, 1.0);
    let f = 0.45 + 0.5 * r.decay.clamp(0.0, 1.0);
    let stage = |base: &[f64]| {
        let w: Vec<f64> = (0..base.len()).map(|i| f.powi(i as i32)).collect();
        let sum: f64 = w.iter().sum();
        base.iter().zip(&w).map(|(b, w)| ((b * k).round(), wet * 0.6 * w / sum)).collect::<Vec<_>>()
    };
    Some(ReverbPlan { stages: [stage(REVERB_BASE[0]), stage(REVERB_BASE[1])], gain: 1.0 / (1.0 + 0.8 * wet) })
}

/// リバーブのフィルター（混ざる量がほぼ 0 なら空）
pub fn reverb_ff(r: &Reverb) -> String {
    let Some(p) = reverb_plan(r) else { return String::new() };
    let mut v: Vec<String> = p
        .stages
        .iter()
        .map(|st| {
            let d: Vec<String> = st.iter().map(|(d, _)| format!("{d:.0}")).collect();
            let a: Vec<String> = st.iter().map(|(_, a)| format!("{a:.4}")).collect();
            format!("aecho=1:1:{}:{}", d.join("|"), a.join("|"))
        })
        .collect();
    v.push(format!("volume={:.4}", p.gain));
    v.join(",")
}

/// 音の高さを変える（長さは変えない）。入力は 48kHz にそろえてあること
fn pitch_ff(semitones: f64) -> String {
    let r = 2f64.powf(semitones.clamp(-12.0, 12.0) / 12.0);
    format!("asetrate=48000*{r:.6},aresample=48000,atempo={:.6}", 1.0 / r)
}

/// 音の加工のフィルター（素材の時間のまま掛ける）。末尾に「,」（なければ空）
pub fn audio_chain(fx: &MediaAudioFx) -> String {
    if fx.is_plain() {
        return String::new();
    }
    // 声の高さを変えるため、先に 48kHz にそろえる
    let mut f: Vec<String> = vec!["aresample=48000".into()];
    if fx.denoise {
        f.push("afftdn=nf=-30".into());
    }
    match fx.voice {
        // 高さだけ変える：速く（遅く）回して高さを変え、長さを元に戻す
        Some(VoiceFx::High) => f.push("asetrate=48000*1.35,aresample=48000,atempo=0.740741".into()),
        Some(VoiceFx::Low) => f.push("asetrate=48000*0.75,aresample=48000,atempo=1.333333".into()),
        Some(VoiceFx::Robot) => f.push("afftfilt=real='hypot(re,im)':imag='0':win_size=512:overlap=0.75".into()),
        Some(VoiceFx::Radio) => f.push("highpass=f=400,lowpass=f=3200,acompressor=threshold=0.1:ratio=4".into()),
        Some(VoiceFx::Echo) => f.push("aecho=0.8:0.7:180|360:0.4|0.25".into()),
        Some(VoiceFx::Megaphone) => f.push("highpass=f=700,lowpass=f=2600,volume=2,alimiter=limit=0.9".into()),
        None => {}
    }
    if let Some(p) = fx.pitch.filter(|p| p.abs() >= 0.05) {
        f.push(pitch_ff(p));
    }
    for flt in &fx.filters {
        let s = filter_ff(flt);
        if !s.is_empty() {
            f.push(s);
        }
    }
    if let Some(r) = &fx.reverb {
        let s = reverb_ff(r);
        if !s.is_empty() {
            f.push(s);
        }
    }
    if let Some(g) = fx.gain_db.filter(|g| g.abs() > 1e-6) {
        f.push(format!("volume={g:.2}dB"));
    }
    format!("{},", f.join(","))
}

/// プレビュー用に加工した WAV の置き場所（元の素材と加工の中身で決まる）
pub fn processed_path(root: &Path, src: &Path, fx: &MediaAudioFx) -> Result<PathBuf> {
    let key = crate::proxy::proxy_key(src)?;
    let mut h = Sha256::new();
    h.update(b"audiofx-v1|");
    h.update(key.as_bytes());
    h.update(audio_chain(fx).as_bytes());
    let name: String = h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect();
    Ok(root.join(format!("{name}.wav")))
}

/// 素材まるごとの音を加工した WAV を作る（できていればそのまま返す）
pub fn make_processed(ffmpeg: &Path, src: &Path, root: &Path, fx: &MediaAudioFx) -> Result<PathBuf> {
    let dst = processed_path(root, src, fx)?;
    if dst.is_file() {
        return Ok(dst);
    }
    std::fs::create_dir_all(root)?;
    let tmp = dst.with_extension("part.wav");
    let chain = audio_chain(fx);
    let af = if chain.is_empty() { "anull".to_string() } else { chain.trim_end_matches(',').to_string() };
    let out = crate::tts::hidden_command(ffmpeg)
        .args(["-v", "error", "-y", "-i"])
        .arg(src)
        .args(["-vn", "-af", &af, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le"])
        .arg(&tmp)
        .output()?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(crate::Error::Other(format!("音を加工できません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    std::fs::rename(&tmp, &dst)?;
    Ok(dst)
}

/// 素材の音の大きさ（平均と最大、dBFS）を測る
pub fn measure(ffmpeg: &Path, src: &Path) -> Result<(f64, f64)> {
    let out = crate::tts::hidden_command(ffmpeg).args(["-v", "info", "-nostats", "-i"]).arg(src).args(["-vn", "-af", "volumedetect", "-f", "null", "-"]).output()?;
    let text = String::from_utf8_lossy(&out.stderr);
    let pick = |key: &str| text.lines().find_map(|l| l.split(key).nth(1)).and_then(|v| v.trim().trim_end_matches("dB").trim().parse::<f64>().ok());
    match (pick("mean_volume:"), pick("max_volume:")) {
        (Some(m), Some(x)) => Ok((m, x)),
        _ => Err(crate::Error::Other("音の大きさを測れませんでした（音が入っていない素材かもしれません）".into())),
    }
}

/// 音量をそろえる増減（dB）：平均を -20 dBFS に。ただし割れないよう、最大が -1 dBFS を超えない分まで
pub fn normalize_gain(mean_db: f64, max_db: f64) -> f64 {
    (-20.0 - mean_db).min(-1.0 - max_db).clamp(-20.0, 20.0)
}

/// 音の強まり（立ち上がり）の大きさの列。hop サンプルごと
fn onset_envelope(samples: &[f32], hop: usize) -> Vec<f64> {
    let energy: Vec<f64> = samples.chunks(hop).map(|c| (c.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / c.len().max(1) as f64).sqrt()).collect();
    let mut out = vec![0.0; energy.len()];
    for i in 1..energy.len() {
        out[i] = (energy[i] - energy[i - 1]).max(0.0);
    }
    out
}

/// 拍の時刻（秒）を求める：強まりの列の自己相関で拍の間隔（60〜200 BPM）を決め、強まりがいちばん重なる位置に並べる
pub fn beats_from_samples(samples: &[f32], rate: u32) -> Vec<f64> {
    let hop = (rate as usize / 100).max(1); // 10ms ごと
    let env = onset_envelope(samples, hop);
    if env.len() < 50 {
        return vec![];
    }
    let fps = rate as f64 / hop as f64;
    let (lo, hi) = ((fps * 60.0 / 200.0) as usize, (fps * 60.0 / 60.0) as usize);
    let mut best = (0usize, 0.0f64);
    for lag in lo.max(1)..=hi.min(env.len() / 2) {
        let s: f64 = (0..env.len() - lag).map(|i| env[i] * env[i + lag]).sum::<f64>() / (env.len() - lag) as f64;
        if s > best.1 {
            best = (lag, s);
        }
    }
    let lag = best.0;
    if lag == 0 || best.1 <= 0.0 {
        return vec![];
    }
    // 並べ始める位置：拍の間隔のうち、強まりの合計がいちばん大きいずれ
    let phase = (0..lag).max_by(|&a, &b| {
        let sum = |p: usize| (p..env.len()).step_by(lag).map(|i| env[i]).sum::<f64>();
        sum(a).total_cmp(&sum(b))
    });
    let phase = phase.unwrap_or(0);
    (phase..env.len()).step_by(lag).map(|i| i as f64 / fps).collect()
}

/// 素材の拍の時刻（秒、素材の頭から）
pub fn detect_beats(ffmpeg: &Path, src: &Path) -> Result<Vec<f64>> {
    let rate = 11025u32;
    let out = crate::tts::hidden_command(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(src)
        .args(["-vn", "-ac", "1", "-ar", &rate.to_string(), "-f", "f32le", "-"])
        .output()?;
    if !out.status.success() {
        return Err(crate::Error::Other(format!("音を読めません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    let samples: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    Ok(beats_from_samples(&samples, rate))
}

/// 静かなところ（秒、素材の頭から。[始め, 終わり]）。threshold_db より小さい音が min_len 秒以上続くところ
pub fn detect_silence(ffmpeg: &Path, src: &Path, threshold_db: f64, min_len: f64) -> Result<Vec<(f64, f64)>> {
    let out = crate::tts::hidden_command(ffmpeg)
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(src)
        .args(["-vn", "-af", &format!("silencedetect=noise={threshold_db:.1}dB:d={min_len:.3}"), "-f", "null", "-"])
        .output()?;
    if !out.status.success() {
        return Err(crate::Error::Other(format!("音を読めません: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or(""))));
    }
    Ok(parse_silence(&String::from_utf8_lossy(&out.stderr)))
}

/// silencedetect の出力を読む（最後まで静かなら、終わりは素材の終わりまで＝大きな値）
pub fn parse_silence(log: &str) -> Vec<(f64, f64)> {
    let num = |l: &str, key: &str| l.split(key).nth(1).and_then(|r| r.split_whitespace().next()).and_then(|v| v.trim_end_matches('|').parse::<f64>().ok());
    let mut out = vec![];
    let mut open: Option<f64> = None;
    for l in log.lines() {
        if let Some(v) = num(l, "silence_start:") {
            open = Some(v.max(0.0));
        } else if let Some(v) = num(l, "silence_end:") {
            if let Some(a) = open.take() {
                out.push((a, v));
            }
        }
    }
    if let Some(a) = open {
        out.push((a, f64::MAX));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_log() {
        let log = "[silencedetect @ 0x1] silence_start: -0.002\n[silencedetect @ 0x1] silence_end: 1.25 | silence_duration: 1.25\nfoo\n[silencedetect @ 0x1] silence_start: 3.5\n";
        assert_eq!(parse_silence(log), vec![(0.0, 1.25), (3.5, f64::MAX)]);
    }

    #[test]
    fn silence_in_a_real_file() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("s.wav");
        // 1 秒鳴って、1 秒静か、1 秒鳴る
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='if(between(t,1,2),0,0.5*sin(2*PI*440*t))':s=16000:d=3"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let s = detect_silence(Path::new("ffmpeg"), &src, -40.0, 0.3).unwrap();
        assert_eq!(s.len(), 1, "{s:?}");
        assert!((s[0].0 - 1.0).abs() < 0.05 && (s[0].1 - 2.0).abs() < 0.05, "{s:?}");
    }

    #[test]
    fn chain_and_gain() {
        assert_eq!(audio_chain(&MediaAudioFx::default()), "");
        let c = audio_chain(&MediaAudioFx { denoise: true, voice: Some(VoiceFx::High), gain_db: Some(3.0), ..Default::default() });
        assert_eq!(c, "aresample=48000,afftdn=nf=-30,asetrate=48000*1.35,aresample=48000,atempo=0.740741,volume=3.00dB,");
        // 平均 -30 → +10 dB。ただし最大 -5 なら +4 dB まで
        assert_eq!(normalize_gain(-30.0, -15.0), 10.0);
        assert_eq!(normalize_gain(-30.0, -5.0), 4.0);
    }

    #[test]
    fn beats_of_a_click_track() {
        // 120 BPM（0.5 秒ごと）のクリック。0.25 秒目から
        let rate = 11025u32;
        let mut s = vec![0.0f32; rate as usize * 8];
        for k in 0..16 {
            let at = ((0.25 + k as f64 * 0.5) * rate as f64) as usize;
            for i in 0..200 {
                if at + i < s.len() {
                    s[at + i] = if i % 2 == 0 { 0.8 } else { -0.8 };
                }
            }
        }
        let b = beats_from_samples(&s, rate);
        assert!(b.len() >= 14, "{b:?}");
        let gaps: Vec<f64> = b.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(gaps.iter().all(|g| (g - 0.5).abs() < 0.02), "{gaps:?}");
        assert!((b[0] - 0.25).abs() < 0.03, "{b:?}");
    }

    #[test]
    fn processed_audio_with_real_ffmpeg() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("s.wav");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=1", "-ar", "44100"]).arg(&src).status().unwrap().success());
        let (mean, max) = measure(Path::new("ffmpeg"), &src).unwrap();
        assert!(mean < -10.0 && max < 0.0, "{mean} {max}");
        for v in [VoiceFx::High, VoiceFx::Low, VoiceFx::Robot, VoiceFx::Radio, VoiceFx::Echo, VoiceFx::Megaphone] {
            let fx = MediaAudioFx { denoise: true, voice: Some(v), gain_db: Some(normalize_gain(mean, max)), ..Default::default() };
            let p = make_processed(Path::new("ffmpeg"), &src, d.path(), &fx).unwrap();
            assert!(p.is_file());
            // 長さは変わらない（48kHz・2ch・16bit で約 1 秒。やまびこは残りの分だけ長い）
            let len = std::fs::metadata(&p).unwrap().len() as f64 / (48000.0 * 4.0);
            let want = if v == VoiceFx::Echo { 1.36 } else { 1.0 };
            assert!((len - want).abs() < 0.08, "{v:?} {len}");
        }
    }

    #[test]
    fn filter_strings() {
        assert_eq!(filter_ff(&AudioFilter::Eq { low_db: 0.0, mid_db: 0.0, high_db: 0.0, mid_hz: 1000.0 }), "");
        assert_eq!(
            filter_ff(&AudioFilter::Eq { low_db: 4.0, mid_db: -3.0, high_db: 2.5, mid_hz: 1500.0 }),
            "bass=g=4.00:f=200:width_type=q:w=0.7071,equalizer=f=1500.0:width_type=q:w=1:g=-3.00,treble=g=2.50:f=5000:width_type=q:w=0.7071"
        );
        // -18dB = 0.125、makeup は volume で
        assert_eq!(
            filter_ff(&AudioFilter::Compressor { threshold_db: -18.0, ratio: 4.0, attack_ms: 10.0, release_ms: 120.0, makeup_db: 3.0 }),
            "acompressor=threshold=0.125893:ratio=4.00:attack=10.0:release=120.0:knee=2.82843,volume=3.00dB"
        );
        assert_eq!(filter_ff(&AudioFilter::Limiter { ceiling_db: -1.0 }), "alimiter=limit=0.8913:attack=5:release=50:level=0");
        assert_eq!(reverb_ff(&Reverb { size: 0.5, decay: 0.5, wet: 0.0 }), "");
        let r = reverb_ff(&Reverb { size: 0.0, decay: 0.0, wet: 1.0 });
        // 広さ 0 は基準の半分の遅れ、2 段、最後に音量の補正
        assert!(r.starts_with("aecho=1:1:16|27|40|57|76:") && r.contains(",aecho=1:1:84|115|156|201:") && r.ends_with(",volume=0.5556"), "{r}");
        // 大きさの合計は 1 段あたり wet*0.6
        let p = reverb_plan(&Reverb { size: 0.3, decay: 0.8, wet: 0.5 }).unwrap();
        for st in &p.stages {
            assert!((st.iter().map(|x| x.1).sum::<f64>() - 0.3).abs() < 1e-9);
            assert!(st.windows(2).all(|w| w[1].1 < w[0].1 && w[1].0 > w[0].0));
        }
    }

    #[test]
    fn chain_with_pitch_and_filters() {
        let fx = MediaAudioFx {
            pitch: Some(3.0),
            filters: vec![AudioFilter::Highpass { hz: 80.0 }, AudioFilter::Limiter { ceiling_db: -2.0 }],
            reverb: Some(Reverb::default()),
            ..Default::default()
        };
        assert!(!fx.is_plain());
        let c = audio_chain(&fx);
        assert!(c.starts_with("aresample=48000,asetrate=48000*1.189207,aresample=48000,atempo=0.840896,highpass=f=80.0"), "{c}");
        assert!(c.contains(",alimiter=limit=0.7943") && c.contains("aecho=") && c.ends_with(","), "{c}");
        // 何も変えない設定は「加工なし」
        let none = MediaAudioFx { pitch: Some(0.0), filters: vec![AudioFilter::Eq { low_db: 0.0, mid_db: 0.0, high_db: 0.0, mid_hz: 1000.0 }], reverb: Some(Reverb { wet: 0.0, ..Default::default() }), ..Default::default() };
        assert!(none.is_plain());
        assert_eq!(audio_chain(&none), "");
        // 保存した形（camelCase）
        let j = serde_json::to_value(&MediaAudioFx { filters: vec![AudioFilter::Compressor { threshold_db: -20.0, ratio: 3.0, attack_ms: 5.0, release_ms: 80.0, makeup_db: 0.0 }], pitch: Some(2.0), ..Default::default() }).unwrap();
        assert_eq!(j["filters"][0]["kind"], "compressor");
        assert_eq!(j["filters"][0]["thresholdDb"], -20.0);
        let back: MediaAudioFx = serde_json::from_value(j).unwrap();
        assert_eq!(back.pitch, Some(2.0));
    }

    #[test]
    fn new_filters_with_real_ffmpeg() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("s.wav");
        // 440Hz と 3kHz を混ぜた 1 秒（大きめ）
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='0.45*sin(2*PI*440*t)+0.3*sin(2*PI*3000*t)|0.45*sin(2*PI*440*t)+0.3*sin(2*PI*3000*t)':s=48000:d=1"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let (_m0, x0) = measure(Path::new("ffmpeg"), &src).unwrap();
        let level = |fx: &MediaAudioFx| {
            let p = make_processed(Path::new("ffmpeg"), &src, d.path(), fx).unwrap();
            let len = std::fs::metadata(&p).unwrap().len() as f64 / (48000.0 * 4.0);
            let (m, x) = measure(Path::new("ffmpeg"), &p).unwrap();
            (m, x, len)
        };
        // 帯域ごとに、その高さの音だけで確かめる（低音 80Hz / 中音 1kHz / 高音 10kHz）
        let tone = |hz: u32| {
            let t = d.path().join(format!("t{hz}.wav"));
            assert!(std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("sine=f={hz}:d=1:r=48000"), "-ac", "2"])
                .arg(&t)
                .status()
                .unwrap()
                .success());
            t
        };
        let shift = |hz: u32, f: AudioFilter| {
            let t = tone(hz);
            let (m0, _) = measure(Path::new("ffmpeg"), &t).unwrap();
            let p = make_processed(Path::new("ffmpeg"), &t, d.path(), &MediaAudioFx { filters: vec![f], ..Default::default() }).unwrap();
            measure(Path::new("ffmpeg"), &p).unwrap().0 - m0
        };
        let eq = |low_db, mid_db, high_db| AudioFilter::Eq { low_db, mid_db, high_db, mid_hz: 1000.0 };
        let (lo, mid, hi) = (shift(80, eq(8.0, 0.0, 0.0)), shift(1000, eq(0.0, -9.0, 0.0)), shift(10000, eq(0.0, 0.0, -10.0)));
        assert!((lo - 8.0).abs() < 1.5 && (mid + 9.0).abs() < 1.0 && (hi + 10.0).abs() < 1.5, "{lo} {mid} {hi}");
        // 触っていない帯域は変わらない
        assert!(shift(1000, eq(8.0, 0.0, -10.0)).abs() < 1.5);
        let (_, _, len) = level(&MediaAudioFx { filters: vec![eq(0.0, 0.0, -12.0)], ..Default::default() });
        assert!((len - 1.0).abs() < 0.08, "{len}");
        // コンプレッサーで最大が下がる
        let (_, x, _) = level(&MediaAudioFx { filters: vec![AudioFilter::Compressor { threshold_db: -24.0, ratio: 8.0, attack_ms: 1.0, release_ms: 50.0, makeup_db: 0.0 }], ..Default::default() });
        assert!(x < x0 - 2.0, "{x} {x0}");
        // リミッターは天井を超えない
        let (_, x, len) = level(&MediaAudioFx { filters: vec![AudioFilter::Limiter { ceiling_db: -6.0 }], ..Default::default() });
        assert!(x <= -5.5 && (len - 1.0).abs() < 0.15, "{x} {len}");
        // 音の高さは長さを変えない
        for st in [-12.0, -5.0, 7.0, 12.0] {
            let (_, _, len) = level(&MediaAudioFx { pitch: Some(st), ..Default::default() });
            assert!((len - 1.0).abs() < 0.08, "{st} {len}");
        }
        // リバーブは響きの分だけ長くなる（広い部屋ほど）
        let (_, _, small) = level(&MediaAudioFx { reverb: Some(Reverb { size: 0.0, decay: 0.5, wet: 0.5 }), ..Default::default() });
        let (_, _, big) = level(&MediaAudioFx { reverb: Some(Reverb { size: 1.0, decay: 0.5, wet: 0.5 }), ..Default::default() });
        assert!(small > 1.05 && big > small + 0.2, "{small} {big}");
    }
}
