//! 素材の音の加工（CapCut の「ノイズ除去」「音量を均一に」「ボイスチェンジャー」）と、拍の検出。
//! 加工は書き出しと同じフィルターで、プレビュー用に素材まるごとを加工した WAV も作る（同じ音になる）。

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
}

impl MediaAudioFx {
    pub fn is_plain(&self) -> bool {
        !self.denoise && self.voice.is_none() && self.gain_db.is_none_or(|g| g.abs() < 1e-6)
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_and_gain() {
        assert_eq!(audio_chain(&MediaAudioFx::default()), "");
        let c = audio_chain(&MediaAudioFx { denoise: true, voice: Some(VoiceFx::High), gain_db: Some(3.0) });
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
            let fx = MediaAudioFx { denoise: true, voice: Some(v), gain_db: Some(normalize_gain(mean, max)) };
            let p = make_processed(Path::new("ffmpeg"), &src, d.path(), &fx).unwrap();
            assert!(p.is_file());
            // 長さは変わらない（48kHz・2ch・16bit で約 1 秒。やまびこは残りの分だけ長い）
            let len = std::fs::metadata(&p).unwrap().len() as f64 / (48000.0 * 4.0);
            let want = if v == VoiceFx::Echo { 1.36 } else { 1.0 };
            assert!((len - want).abs() < 0.08, "{v:?} {len}");
        }
    }
}
