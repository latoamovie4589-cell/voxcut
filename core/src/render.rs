//! FFmpeg での書き出し。引数の組み立て（テスト可能な純粋関数）と、実行・進捗の読み取り。

use crate::lipsync;
use crate::model::{ClipBody, Ease, Effect, Look, MediaKind, Project, ShapeClip, TextClip, Transform};
use crate::{Error, Result};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub ffmpeg: PathBuf,
    pub out: PathBuf,
    /// プロジェクトファイルのあるフォルダ（素材の相対パスの基準）
    pub project_dir: PathBuf,
    pub crf: u8,
    /// x264 の preset。速さ優先で veryfast を既定にする
    pub preset: String,
    /// 出力の高さ（None ならプロジェクトの大きさのまま）。字幕は元の大きさで描いてから縮める
    pub out_height: Option<u32>,
    /// 動画のエンコーダー（グラフィックボードを使うと速い）
    pub encoder: Encoder,
    /// テキスト・図形アイテムの画像（クリップ id → PNG のパス）。画面側で描いて渡す
    pub item_images: std::collections::HashMap<String, PathBuf>,
    /// 1 文字ずつ出す字幕などの、画像を順に出す ffconcat（クリップ id → パス。prepare_sequences で作る）
    pub item_sequences: std::collections::HashMap<String, PathBuf>,
    /// PSD 立ち絵の、状態ごとの画像（キャラクター id → 状態の番号 → PNG のパス）。画面側で合成して渡す
    pub portrait_frames: std::collections::HashMap<String, std::collections::HashMap<usize, PathBuf>>,
}

impl ExportOptions {
    pub fn new(ffmpeg: impl Into<PathBuf>, out: impl Into<PathBuf>, project_dir: impl Into<PathBuf>) -> Self {
        Self {
            ffmpeg: ffmpeg.into(),
            out: out.into(),
            project_dir: project_dir.into(),
            crf: 20,
            preset: "veryfast".into(),
            out_height: None,
            encoder: Encoder::X264,
            item_images: Default::default(),
            item_sequences: Default::default(),
            portrait_frames: Default::default(),
        }
    }
}

/// H.264 のエンコーダー
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Encoder {
    /// CPU（どの PC でも動く）
    #[default]
    X264,
    /// NVIDIA
    Nvenc,
    /// Intel
    Qsv,
    /// AMD
    Amf,
}

impl Encoder {
    pub const HARDWARE: [Encoder; 3] = [Encoder::Nvenc, Encoder::Qsv, Encoder::Amf];

    pub fn codec(&self) -> &'static str {
        match self {
            Encoder::X264 => "libx264",
            Encoder::Nvenc => "h264_nvenc",
            Encoder::Qsv => "h264_qsv",
            Encoder::Amf => "h264_amf",
        }
    }

    /// 画質（x264 の CRF 相当の数値）からエンコーダーごとの引数を作る
    pub fn args(&self, crf: u8, preset: &str) -> Vec<String> {
        let q = crf.to_string();
        let v: Vec<&str> = match self {
            Encoder::X264 => vec!["-c:v", "libx264", "-preset", preset, "-crf", &q, "-pix_fmt", "yuv420p"],
            Encoder::Nvenc => vec!["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", &q, "-b:v", "0", "-pix_fmt", "yuv420p"],
            Encoder::Qsv => vec!["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", &q, "-pix_fmt", "nv12"],
            Encoder::Amf => vec!["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", &q, "-qp_p", &q, "-pix_fmt", "yuv420p"],
        };
        v.into_iter().map(String::from).collect()
    }
}

/// この PC の FFmpeg で実際に使えるハードウェアエンコーダーを調べる（小さな映像を試しに作る）
pub fn detect_hw_encoders(ffmpeg: &Path) -> Vec<Encoder> {
    Encoder::HARDWARE
        .into_iter()
        .filter(|e| {
            let mut cmd = crate::tts::hidden_command(ffmpeg);
            cmd.args(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30:d=0.2"]);
            cmd.args(e.args(23, "veryfast"));
            cmd.args(["-frames:v", "3", "-f", "null", "-"]);
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
            cmd.status().is_ok_and(|s| s.success())
        })
        .collect()
}

/// BGM を下げる区間（秒）。セリフ同士の間が短いときは 1 つにまとめる（音量が上下にばたつかないように）
pub const DUCK_RAMP: f64 = 0.25;
const DUCK_MERGE_GAP: f64 = 0.6;

pub fn voice_intervals(p: &Project) -> Vec<(f64, f64)> {
    let v = &p.video;
    let voice_tracks = p.audible_tracks();
    let mut iv: Vec<(f64, f64)> = p
        .clips
        .iter()
        .filter(|c| c.as_voice().is_some() && voice_tracks.contains(c.track_id.as_str()))
        .map(|c| (v.frames_to_secs(c.start), v.frames_to_secs(c.end())))
        .collect();
    iv.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = vec![];
    for (s, e) in iv {
        match out.last_mut() {
            Some(last) if s - last.1 < DUCK_MERGE_GAP => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

/// FFmpeg の volume フィルタに渡す式。区間の前後 DUCK_RAMP 秒で滑らかに下げ・戻す。
/// プレビュー（app/src/ducking.ts）と同じ形
pub fn duck_expr(intervals: &[(f64, f64)], level: f64) -> String {
    if intervals.is_empty() {
        return "1".into();
    }
    let r = DUCK_RAMP;
    let terms: Vec<String> = intervals
        .iter()
        .map(|(s, e)| format!("min(clip((t-{a:.3})/{r},0,1),clip(({b:.3}-t)/{r},0,1))", a = s - r, b = e + r))
        .collect();
    let l = level.clamp(0.0, 1.0);
    format!("1-{d:.3}*min(1,{})", terms.join("+"), d = 1.0 - l)
}

/// フィルタグラフが長いときは、ファイルに書き出してそれを読ませる（Windows のコマンドの長さ制限を避ける）。
/// `new_syntax` は FFmpeg 7 以降の `-/filter_complex <ファイル>` を使うか
pub fn externalize_filter(args: &mut [String], script: &Path, new_syntax: bool, threshold: usize) -> Result<bool> {
    let Some(i) = args.iter().position(|a| a == "-filter_complex") else { return Ok(false) };
    if args[i + 1].len() <= threshold {
        return Ok(false);
    }
    std::fs::write(script, &args[i + 1])?;
    args[i] = if new_syntax { "-/filter_complex".into() } else { "-filter_complex_script".into() };
    args[i + 1] = script.to_string_lossy().into_owned();
    Ok(true)
}

/// FFmpeg のフィルタ引数の中に書くパス（Windows の "C:\..." の ":" と "\" を逃がす）
pub fn escape_filter_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    format!("'{}'", s.replace(':', "\\:").replace('\'', "\\'"))
}

fn hex_color(c: &str) -> String {
    format!("0x{}", c.trim_start_matches('#'))
}

/// 立ち絵 1 人分の入力（状態ごとの画像を並べた ffconcat と、置き方）
#[derive(Debug, Clone)]
pub struct PortraitInput {
    pub concat: PathBuf,
    pub transform: Transform,
    /// 描く映像トラック（そのトラックの素材の上・字幕の下に重ねる）
    pub track: String,
    /// 喋っているときだけ表示する場合の、表示する区間（秒）。None ならいつも
    pub only: Option<Vec<(f64, f64)>>,
    /// セリフの間だけ掛けるエフェクト（区間（秒）とエフェクト）
    pub fx: Vec<((f64, f64), Vec<Effect>)>,
}

/// セリフの立ち絵エフェクト：そのキャラクターの、鳴るトラックにあるセリフのうちエフェクトを付けたものの区間（秒）
pub fn line_portrait_effects(p: &Project, character_id: &str) -> Vec<((f64, f64), Vec<Effect>)> {
    let audible = p.audible_tracks();
    p.clips
        .iter()
        .filter(|c| audible.contains(c.track_id.as_str()))
        .filter_map(|c| {
            let v = c.as_voice().filter(|v| v.character_id == character_id)?;
            let fx = &v.portrait.as_ref()?.effects;
            (!fx.is_empty()).then(|| ((p.video.frames_to_secs(c.start), p.video.frames_to_secs(c.end())), fx.clone()))
        })
        .collect()
}

/// 1 文字ずつ出す字幕（「個別に設定」で間隔を決めたもの）の ffconcat を作る。
/// 画像は画面側が文字数ごとに用意する（id#1 = 1 文字目まで、id#2 = 2 文字目まで…）。k 文字目は (k−1)·間隔 フレームから出る
pub fn prepare_sequences(p: &Project, images: &std::collections::HashMap<String, PathBuf>, work: &Path) -> Result<std::collections::HashMap<String, PathBuf>> {
    let mut out = std::collections::HashMap::new();
    let fps = p.video.fps as f64;
    for c in &p.clips {
        let Some(sc) = p.line_of_subtitle(c).and_then(|v| v.subtitle_custom.as_deref()) else { continue };
        if sc.interval <= 0 {
            continue;
        }
        let frames: Vec<&PathBuf> = (1..).map_while(|k| images.get(&format!("{}#{k}", c.id))).collect();
        if frames.is_empty() {
            continue;
        }
        let mut list = String::from("ffconcat version 1.0\n");
        let mut used = 0;
        let mut last = frames[0];
        for (k, img) in frames.iter().enumerate() {
            let left = c.duration - used;
            if left <= 0 {
                break;
            }
            // 最後の画像はクリップの終わりまで
            let n = if k + 1 == frames.len() { left } else { sc.interval.min(left) };
            list.push_str(&format!("file {}\nduration {:.6}\n", concat_quote(img), n as f64 / fps));
            used += n;
            last = img;
        }
        // concat demuxer は最後の duration を無視するので、最後の画像をもう一度書く
        list.push_str(&format!("file {}\n", concat_quote(last)));
        let path = work.join(format!("seq_{}.ffconcat", c.id));
        std::fs::write(&path, list)?;
        out.insert(c.id.clone(), path);
    }
    Ok(out)
}

/// モノラルは左右に同じ大きさで、ステレオはそのまま
const STEREO: &str = "pan=stereo|FL=FL+FC|FR=FR+FC";

/// セリフの声に掛けるフィルタ（aresample の後ろにつなぐ。先頭は「,」）。dur はクリップの長さ（秒）。
/// 画面（preview/playback.ts）と同じ順：再生開始位置 → 音声エフェクト → エコー → フェード → 左右
pub fn voice_audio_filters(vc: &crate::model::VoiceClip, fps: u32, dur: f64) -> String {
    let off = vc.start_offset() as f64 / fps as f64;
    let mut f = if off > 0.0 { format!(",atrim={off:.3}:{:.3},asetpts=PTS-STARTPTS", off + dur) } else { format!(",atrim=0:{dur:.3}") };
    let Some(a) = &vc.audio_fx else { return f };
    for flt in &a.filters {
        match flt {
            crate::model::AudioFilter::Highpass { hz } => f.push_str(&format!(",highpass=f={:.1}:width_type=q:width=0.7071", hz.max(1.0))),
            crate::model::AudioFilter::Lowpass { hz } => f.push_str(&format!(",lowpass=f={:.1}:width_type=q:width=0.7071", hz.max(1.0))),
        }
    }
    if let Some(e) = &a.echo {
        if e.delay_ms > 0.0 && e.decay > 0.0 {
            f.push_str(&format!(",aecho=1:1:{:.1}:{:.3}", e.delay_ms.min(5000.0), e.decay.clamp(0.0, 1.0)));
        }
    }
    if a.fade_in > 0 {
        f.push_str(&format!(",afade=t=in:st=0:d={:.3}", a.fade_in as f64 / fps as f64));
    }
    if a.fade_out > 0 {
        let d = a.fade_out as f64 / fps as f64;
        f.push_str(&format!(",afade=t=out:st={:.3}:d={d:.3}", (dur - d).max(0.0)));
    }
    if a.pan.abs() > 1e-6 {
        let (l, r) = pan_gains(a.pan);
        f.push_str(&format!(",aformat=channel_layouts=mono,pan=stereo|FL={l:.4}*FC|FR={r:.4}*FC"));
    }
    f
}

/// 左右の大きさ（寄せた側はそのまま、反対側だけ小さく）
pub fn pan_gains(pan: f64) -> (f64, f64) {
    let p = pan.clamp(-1.0, 1.0);
    ((1.0 - p).min(1.0), (1.0 + p).min(1.0))
}

/// 区間だけ効くエフェクトのフィルタ（timeline の enable を付ける）と、揺れの足し算（x, y の式）
fn timed_effects(fx: &[((f64, f64), Vec<Effect>)]) -> (Vec<String>, String, String) {
    let mut chain = vec![];
    let (mut dx, mut dy) = (String::new(), String::new());
    for ((a, b), effects) in fx {
        let on = format!("between(t,{a:.3},{:.3})", b - 0.0005);
        let en = format!("enable='{on}'");
        for e in effects {
            match e {
                Effect::Color { brightness, contrast, saturation } => {
                    if (brightness - 1.0).abs() > 1e-6 || (contrast - 1.0).abs() > 1e-6 {
                        let v = format!("clip(((val*{brightness:.4})-127.5)*{contrast:.4}+127.5,0,255)");
                        chain.push(format!("lutrgb=r='{v}':g='{v}':b='{v}':{en}"));
                    }
                    if (saturation - 1.0).abs() > 1e-6 {
                        chain.push(format!("{}:{en}", saturate_mixer(*saturation)));
                    }
                }
                Effect::Mono => chain.push(format!("{}:{en}", saturate_mixer(0.0))),
                Effect::Invert => chain.push(format!("negate={en}")),
                Effect::Blur { radius } if *radius > 0.0 => chain.push(format!("gblur=sigma={radius:.3}:{en}")),
                Effect::Blur { .. } => {}
                Effect::Shake { amount, speed } => {
                    dx.push_str(&format!("+{on}*{amount:.3}*sin(2*PI*{speed:.4}*t)"));
                    dy.push_str(&format!("+{on}*{amount:.3}*cos(2*PI*{speed:.4}*t*1.37)"));
                }
                Effect::Wave { .. } | Effect::Swirl { .. } => {
                    // 大きさを変えた後なので、px はそのまま画面の px。時刻は動画の頭から
                    if let Some(g) = distort_geq(e, 1.0) {
                        chain.push(format!("{g}:{en}"));
                    }
                }
            }
        }
    }
    (chain, dx, dy)
}

/// キャラクターが喋っている区間（秒）：そのキャラクターの、鳴るトラックにあるセリフの間。続いている区間はまとめる
pub fn speaking_intervals(p: &Project, character_id: &str) -> Vec<(f64, f64)> {
    let audible = p.audible_tracks();
    let mut iv: Vec<(f64, f64)> = p
        .clips
        .iter()
        .filter(|c| c.as_voice().is_some_and(|v| v.character_id == character_id) && audible.contains(c.track_id.as_str()))
        .map(|c| (p.video.frames_to_secs(c.start), p.video.frames_to_secs(c.end())))
        .collect();
    iv.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = vec![];
    for (s, e) in iv {
        match out.last_mut() {
            Some(last) if s <= last.1 + 1e-6 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

fn concat_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"))
}

/// 立ち絵の書き出し準備（立ち絵アイテムのあるキャラクターの PSD 立ち絵だけ）。キャラクターごとに
/// 1) フレームごとの状態（口パク・目パチ・表情）を計算し
/// 2) 画面側で PSD から作った状態ごとの画像（psd_frames）を
/// 3) 「この画像を何秒」の並びにして ffconcat に書く。
///
/// それを立ち絵アイテムごとに、そのアイテムの間（「喋っているときだけ」ならセリフの間と重なるところ）だけ重ねる。
///
/// 1 本の映像として重ねるので、フレームごとの切り替えでもフィルタが増えない。
pub fn prepare_portraits(
    p: &Project,
    _project_dir: &Path,
    _ffmpeg: &Path,
    work: &Path,
    peaks_for: &dyn Fn(&str) -> Option<Vec<i8>>,
    psd_frames: &std::collections::HashMap<String, std::collections::HashMap<usize, PathBuf>>,
) -> Result<Vec<PortraitInput>> {
    let total = p.duration();
    let fps = p.video.fps as f64;
    let mut out = vec![];
    for (ci, ch) in p.characters.iter().enumerate() {
        let Some(pt) = ch.portrait.as_ref().filter(|pt| pt.visible && pt.psd.is_some()) else { continue };
        let items: Vec<&crate::model::Clip> = p.clips.iter().filter(|c| matches!(&c.body, ClipBody::Portrait(pc) if pc.character_id == ch.id)).collect();
        if items.is_empty() {
            continue;
        }
        // 立ち絵アイテムごとに、既定の表情を当てた状態の並びを作る（既定の表情が同じアイテムは同じ並びを使う）
        let mut concats: std::collections::HashMap<u8, PathBuf> = Default::default();
        let speaking = speaking_intervals(p, &ch.id);
        for (k, item) in items.into_iter().enumerate() {
            let ClipBody::Portrait(pc) = &item.body else { continue };
            let default_expr = pt.expression_index(pc.expression.as_deref());
            let concat = match concats.get(&default_expr) {
                Some(c) => c.clone(),
                None => {
                    let states = lipsync::portrait_track_with(p, ch, total, peaks_for, default_expr);
                    let runs = lipsync::runs(&states);
                    let mut images: std::collections::HashMap<usize, PathBuf> = Default::default();
                    for (st, _) in &runs {
                        if images.contains_key(&st.index()) {
                            continue;
                        }
                        let img = psd_frames
                            .get(&ch.id)
                            .and_then(|m| m.get(&st.index()))
                            .ok_or_else(|| Error::Other(format!("「{}」の PSD 立ち絵の画像（状態 {}）が用意されていません", ch.name, st.index())))?;
                        images.insert(st.index(), img.clone());
                    }
                    let mut list = String::from("ffconcat version 1.0\n");
                    for (st, n) in &runs {
                        list.push_str(&format!("file {}\nduration {:.6}\n", concat_quote(&images[&st.index()]), *n as f64 / fps));
                    }
                    // concat demuxer は最後の duration を無視するので、最後の画像をもう一度書く
                    if let Some((st, _)) = runs.last() {
                        list.push_str(&format!("file {}\n", concat_quote(&images[&st.index()])));
                    }
                    let c = work.join(format!("portrait{ci}_{k}.ffconcat"));
                    std::fs::write(&c, list)?;
                    concats.insert(default_expr, c.clone());
                    c
                }
            };
            let (a, b) = (p.video.frames_to_secs(item.start), p.video.frames_to_secs(item.end()));
            let only_speaking = pc.only_while_speaking.unwrap_or(pt.only_while_speaking);
            let only: Vec<(f64, f64)> = if only_speaking {
                speaking.iter().map(|(s, e)| (s.max(a), e.min(b))).filter(|(s, e)| e > s).collect()
            } else {
                vec![(a, b)]
            };
            if only.is_empty() {
                continue; // この間に一度も喋らないなら出さない
            }
            let fx = line_portrait_effects(p, &ch.id).into_iter().map(|((s, e), fx)| ((s.max(a), e.min(b)), fx)).filter(|((s, e), _)| e > s).collect();
            out.push(PortraitInput { concat, transform: pc.transform.clone(), track: item.track_id.clone(), only: Some(only), fx });
        }
    }
    Ok(out)
}

/// 同じ大きさの透過 PNG を重ねて 1 枚にする
pub fn compose_layers(ffmpeg: &Path, layers: &[String], dst: &Path) -> Result<()> {
    let mut cmd = crate::tts::hidden_command(ffmpeg);
    cmd.args(["-hide_banner", "-v", "error", "-y"]);
    for l in layers {
        cmd.arg("-i").arg(l);
    }
    let mut fc = String::new();
    let mut last = "0:v".to_string();
    for i in 1..layers.len() {
        let o = format!("l{i}");
        fc.push_str(&format!("[{last}][{i}:v]overlay=0:0:format=auto[{o}];"));
        last = o;
    }
    fc.push_str(&format!("[{last}]format=rgba[out]"));
    let out = cmd.args(["-filter_complex", &fc, "-map", "[out]", "-frames:v", "1"]).arg(dst).output()?;
    if !out.status.success() {
        return Err(Error::Ffmpeg(format!("立ち絵を合成できません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(())
}

/// 書き出しに使う FFmpeg の引数を組み立てる。
/// `voice_wav` はクリップ ID → 合成済み WAV のパス。`captions` は映像トラック → そのトラックの字幕（ASS）。
/// 映像トラックは V1 から順に重ね、各トラックの上に、そのトラックの立ち絵と字幕を重ねる（Premiere Pro と同じく番号の大きいほど手前）
pub fn build_args(
    p: &Project,
    voice_wav: &dyn Fn(&str) -> Option<PathBuf>,
    portraits: &[PortraitInput],
    captions: &[(String, PathBuf)],
    opt: &ExportOptions,
) -> Result<Vec<String>> {
    let v = &p.video;
    let total = p.duration().max(1);
    let total_s = v.frames_to_secs(total);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];
    let push_input = |args: &mut Vec<String>, pre: Vec<String>, path: String| {
        args.extend(pre);
        args.push("-i".into());
        args.push(path);
    };
    // 入力 0：背景
    push_input(
        &mut args,
        vec!["-f".into(), "lavfi".into()],
        format!("color=c={}:s={}x{}:r={}:d={:.3}", hex_color(&v.background), v.width, v.height, v.fps, total_s),
    );
    let mut idx = 1usize;
    let mut fc: Vec<String> = vec![];
    let mut audio_labels: Vec<String> = vec![];
    let mut last_v = "0:v".to_string();

    let intervals = voice_intervals(p);
    let audible = p.audible_tracks();
    let video_ids: std::collections::HashSet<&str> = p.video_tracks().map(|t| t.id.as_str()).collect();
    // 立ち絵を重ねる（素材より手前、字幕より奥）
    let overlay_portrait = |args: &mut Vec<String>, fc: &mut Vec<String>, idx: &mut usize, last_v: &mut String, pi: &PortraitInput| {
        args.extend(["-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), pi.concat.to_string_lossy().into_owned()]);
        let i = *idx;
        let t = &pi.transform;
        let src_l = format!("p{i}");
        // セリフの間だけのエフェクト（大きさを変えた後に掛けるので、ぼかしの半径はそのまま画面の px）
        let (fx, dx, dy) = timed_effects(&pi.fx);
        let fx: String = fx.iter().map(|f| format!(",{f}")).collect();
        fc.push(format!("[{i}:v]fps={},scale=iw*{s:.4}:ih*{s:.4},format=rgba,colorchannelmixer=aa={o:.3}{fx}[{src_l}]", v.fps, s = t.scale, o = t.opacity.clamp(0.0, 1.0)));
        let out_l = format!("ov{i}");
        // 喋っているときだけ表示する立ち絵は、その区間だけ重ねる
        let enable = match &pi.only {
            Some(iv) => format!(":enable='{}'", iv.iter().map(|(a, b)| format!("between(t,{a:.3},{:.3})", b - 0.0005)).collect::<Vec<_>>().join("+")),
            None => String::new(),
        };
        let pos = if dx.is_empty() {
            format!("x=(W-w)/2+{x:.1}:y=(H-h)/2+{y:.1}", x = t.x, y = t.y)
        } else {
            format!("x='(W-w)/2+{x:.1}{dx}':y='(H-h)/2+{y:.1}{dy}'", x = t.x, y = t.y)
        };
        fc.push(format!("[{last_v}][{src_l}]overlay={pos}:eof_action=pass{enable}[{out_l}]"));
        *last_v = out_l;
        *idx += 1;
    };
    let mut sub_n = 0;
    // 映像は V1 から順に（後ろのトラックほど手前）。音声トラックは音だけ
    for track in p.tracks.iter() {
        // 映像トラックの目を消すと、そのトラックは映像も音も出さない。音はミュート・ソロにも従う
        let track_audible = audible.contains(track.id.as_str());
        if track.hidden {
            continue;
        }
        // BGM を下げる設定のトラックは、音量をセリフに合わせて動かす
        let duck = if track.duck && !intervals.is_empty() {
            format!(",volume='{}':eval=frame", duck_expr(&intervals, track.duck_level))
        } else {
            String::new()
        };
        let mut clips: Vec<_> = p.clips.iter().filter(|c| c.track_id == track.id).collect();
        clips.sort_by_key(|c| c.start);
        // 「個別に設定」した字幕（立ち絵の上、ほかの字幕と同じ高さに重ねる）
        let mut custom_subs: Vec<(&crate::model::Clip, &crate::model::SubtitleCustom)> = vec![];
        for c in clips {
            {
                if let Some(sc) = p.line_of_subtitle(c).filter(|v| !v.subtitle.as_deref().unwrap_or(&v.text).trim().is_empty()).and_then(|v| v.subtitle_custom.as_deref()) {
                    custom_subs.push((c, sc));
                }
            }
            let start = v.frames_to_secs(c.start);
            let dur = v.frames_to_secs(c.duration);
            let delay_ms = (start * 1000.0).round() as u64;
            match &c.body {
                ClipBody::Voice(_) if !track_audible => {}
                ClipBody::Voice(vc) => {
                    let Some(wav) = voice_wav(&c.id) else {
                        return Err(Error::Other(format!("クリップ {} の音声がまだ合成されていません", c.id)));
                    };
                    let vol = p.effective_voice(vc).map(|v| v.params.volume).unwrap_or(1.0);
                    push_input(&mut args, vec![], wav.to_string_lossy().into_owned());
                    let l = format!("a{idx}");
                    let fx = voice_audio_filters(vc, v.fps, dur);
                    fc.push(format!("[{idx}:a]aresample={}{fx},adelay=delays={delay_ms}:all=1,volume={vol:.3}[{l}]", v.sample_rate));
                    audio_labels.push(l);
                    idx += 1;
                }
                // 字幕・立ち絵はトラックの最後にまとめて重ねる
                ClipBody::Caption(_) | ClipBody::Portrait(_) => {}
                ClipBody::Text(TextClip { transform, look, .. }) | ClipBody::Shape(ShapeClip { transform, look, .. }) => {
                    // テキスト・図形は画面側で描いた画像を、静止画と同じように重ねる
                    let Some(img) = opt.item_images.get(&c.id) else {
                        return Err(Error::Other(format!("アイテム {} の画像が用意されていません", c.id)));
                    };
                    push_input(
                        &mut args,
                        vec!["-loop".into(), "1".into(), "-framerate".into(), v.fps.to_string(), "-t".into(), format!("{dur:.3}")],
                        img.to_string_lossy().into_owned(),
                    );
                    last_v = visual_filters(&mut fc, idx, &last_v, v.fps, transform, look, start, dur);
                    idx += 1;
                }
                ClipBody::Media(m) => {
                    let src = resolve(&opt.project_dir, &m.src);
                    let in_s = v.frames_to_secs(m.in_point);
                    match m.media_kind {
                        MediaKind::Audio => {
                            push_input(&mut args, vec!["-ss".into(), format!("{in_s:.3}"), "-t".into(), format!("{dur:.3}")], src);
                            let l = format!("a{idx}");
                            fc.push(format!("[{idx}:a]aresample={},adelay=delays={delay_ms}:all=1,volume={:.3}{duck}[{l}]", v.sample_rate, m.volume));
                            audio_labels.push(l);
                        }
                        MediaKind::Image | MediaKind::Video => {
                            let pre = if m.media_kind == MediaKind::Image {
                                vec!["-loop".into(), "1".into(), "-framerate".into(), v.fps.to_string(), "-t".into(), format!("{dur:.3}")]
                            } else {
                                vec!["-ss".into(), format!("{in_s:.3}"), "-t".into(), format!("{dur:.3}")]
                            };
                            push_input(&mut args, pre, src);
                            // 映像と音が 1 つのクリップの動画（分離した動画の音は、音声トラックのクリップで鳴らす）
                            if m.media_kind == MediaKind::Video && m.has_audio && track_audible {
                                let l = format!("a{idx}");
                                fc.push(format!("[{idx}:a]aresample={},adelay=delays={delay_ms}:all=1,volume={:.3}{duck}[{l}]", v.sample_rate, m.volume));
                                audio_labels.push(l);
                            }
                            last_v = visual_filters(&mut fc, idx, &last_v, v.fps, &m.transform, &m.look, start, dur);
                        }
                    }
                    idx += 1;
                }
            }
        }
        {
            for pi in portraits.iter().filter(|pi| pi.track == track.id) {
                overlay_portrait(&mut args, &mut fc, &mut idx, &mut last_v, pi);
            }
            for (c, sc) in custom_subs {
                let Some(img) = opt.item_images.get(&c.id).or_else(|| opt.item_images.get(&format!("{}#1", c.id))) else {
                    return Err(Error::Other(format!("字幕 {} の画像が用意されていません", c.id)));
                };
                let (start, dur) = (v.frames_to_secs(c.start), v.frames_to_secs(c.duration));
                match opt.item_sequences.get(&c.id) {
                    // 1 文字ずつ出す字幕
                    Some(seq) => args.extend(["-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), seq.to_string_lossy().into_owned()]),
                    None => push_input(
                        &mut args,
                        vec!["-loop".into(), "1".into(), "-framerate".into(), v.fps.to_string(), "-t".into(), format!("{dur:.3}")],
                        img.to_string_lossy().into_owned(),
                    ),
                }
                last_v = visual_filters(&mut fc, idx, &last_v, v.fps, &sc.transform, &sc.look, start, dur);
                idx += 1;
            }
            if let Some((_, a)) = captions.iter().find(|(t, _)| *t == track.id) {
                let l = format!("sub{sub_n}");
                sub_n += 1;
                fc.push(format!("[{last_v}]ass={}[{l}]", escape_filter_path(a)));
                last_v = l;
            }
        }
    }
    // 描くトラックが分からない立ち絵は一番手前に
    for pi in portraits.iter().filter(|pi| !video_ids.contains(pi.track.as_str())) {
        overlay_portrait(&mut args, &mut fc, &mut idx, &mut last_v, pi);
    }

    // 出力の大きさ
    let resize = match opt.out_height {
        Some(oh) if oh != v.height => format!(",scale=-2:{oh}:flags=lanczos"),
        _ => String::new(),
    };
    fc.push(format!("[{last_v}]null{resize}[vout]"));
    // 音声（なければ無音）
    if audio_labels.is_empty() {
        fc.push(format!("anullsrc=r={}:cl=stereo,atrim=0:{total_s:.3}[aout]", v.sample_rate));
    } else {
        // どれもステレオにそろえてから混ぜる（モノラルは左右に同じ大きさで。そろえないと左右に振った声が真ん中に戻る）
        for l in &audio_labels {
            fc.push(format!("[{l}]{STEREO}[s{l}]"));
        }
        let ins: String = audio_labels.iter().map(|l| format!("[s{l}]")).collect();
        fc.push(format!("{ins}amix=inputs={}:normalize=0:duration=longest,apad,atrim=0:{total_s:.3}[aout]", audio_labels.len()));
    }

    args.extend([
        "-filter_complex".into(),
        fc.join(";"),
        "-map".into(),
        "[vout]".into(),
        "-map".into(),
        "[aout]".into(),
    ]);
    args.extend(opt.encoder.args(opt.crf, &opt.preset));
    args.extend([
        "-r".into(),
        v.fps.to_string(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-t".into(),
        format!("{total_s:.3}"),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        opt.out.to_string_lossy().into_owned(),
    ]);
    Ok(args)
}

fn resolve(base: &Path, src: &str) -> String {
    let p = Path::new(src);
    if p.is_absolute() { p.to_path_buf() } else { base.join(p) }.to_string_lossy().into_owned()
}

/// 書き出しを実行する。`on_progress` には 0.0〜1.0 が渡る。
pub fn run(args: &[String], ffmpeg: &Path, total_secs: f64, on_progress: &mut dyn FnMut(f64)) -> Result<()> {
    run_cancellable(args, ffmpeg, total_secs, on_progress, None)
}

/// `cancel` が立ったら FFmpeg を止めて `Error::Cancelled` を返す（書きかけのファイルは消す）
pub fn run_cancellable(
    args: &[String],
    ffmpeg: &Path,
    total_secs: f64,
    on_progress: &mut dyn FnMut(f64),
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<()> {
    let mut child = crate::tts::hidden_command(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Ffmpeg(format!("FFmpeg を起動できません（{}）: {e}", ffmpeg.display())))?;
    // stderr はエラー表示用に別スレッドで溜める（パイプが詰まらないように）
    let stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut tail: std::collections::VecDeque<String> = Default::default();
        for l in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            if tail.len() >= 20 {
                tail.pop_front();
            }
            tail.push_back(l);
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });
    let is_cancelled = || cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed));
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(std::result::Result::ok) {
        if is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = err_thread.join();
            if let Some(out) = args.last() {
                let _ = std::fs::remove_file(out);
            }
            return Err(Error::Cancelled);
        }
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|s| s.trim().parse::<f64>().ok()) {
            on_progress((us / 1e6 / total_secs.max(0.001)).clamp(0.0, 1.0));
        } else if line.trim() == "progress=end" {
            on_progress(1.0);
        }
    }
    let status = child.wait()?;
    let err = err_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(Error::Ffmpeg(err));
    }
    Ok(())
}

/// 動き方の式。p は 0〜1 の進み具合の式
fn ease_expr(e: Ease, p: &str) -> String {
    match e {
        Ease::Linear => format!("({p})"),
        Ease::In => format!("(({p})*({p}))"),
        Ease::Out => format!("(1-(1-({p}))*(1-({p})))"),
        Ease::InOut => format!("if(lt({p},0.5),2*({p})*({p}),1-2*(1-({p}))*(1-({p})))"),
    }
}

/// a から b へ、e の動き方で（t は アイテムの頭からの秒）
fn tween(a: f64, b: f64, e: Ease, t: &str, dur: f64) -> String {
    if (a - b).abs() < 1e-9 {
        return format!("{a:.4}");
    }
    let p = format!("clip({t}/{d:.4},0,1)", d = dur.max(1e-3));
    format!("({a:.4}+({d:.4})*{e})", d = b - a, e = ease_expr(e, &p))
}

/// 画像・動画・テキスト・図形を重ねるフィルター（入力 idx の映像を last_v に重ね、新しいラベルを返す）。
/// 順番：色の効果 → 回転 → ぼかし → 不透明度 → フェード → 大きさ（大きさが変わるのは最後にして、
/// 大きさの変化に対応しないフィルターを通さない）→ 時刻をずらす → 位置（揺れを含む）で重ねる。
/// 画面（preview/visual.ts）と同じ計算になるようにそろえる
#[allow(clippy::too_many_arguments)]
pub fn visual_filters(fc: &mut Vec<String>, idx: usize, last_v: &str, fps: u32, t: &Transform, look: &Look, start: f64, dur: f64) -> String {
    let plain = look.is_plain();
    let src_l = format!("v{idx}");
    let out_l = format!("ov{idx}");
    let end = start + dur;
    if plain {
        // 今までどおり（動きも効果もないとき）
        fc.push(format!(
            "[{idx}:v]fps={fps},scale=iw*{s:.4}:ih*{s:.4},format=rgba,colorchannelmixer=aa={o:.3},setpts=PTS-STARTPTS+{start:.3}/TB[{src_l}]",
            s = t.scale,
            o = t.opacity.clamp(0.0, 1.0)
        ));
        fc.push(format!(
            "[{last_v}][{src_l}]overlay=x=(W-w)/2+{x:.1}:y=(H-h)/2+{y:.1}:enable='between(t,{start:.3},{end:.3})':eof_action=pass[{out_l}]",
            x = t.x,
            y = t.y
        ));
        return out_l;
    }
    let to = look.anim.as_ref();
    let e = to.map(|a| a.ease).unwrap_or_default();
    let (sx, sy, ss, so, sr) = (t.x, t.y, t.scale, t.opacity.clamp(0.0, 1.0), look.rotation);
    let (ex, ey, es, eo, er) = to.map(|a| (a.to.x, a.to.y, a.to.scale, a.to.opacity.clamp(0.0, 1.0), a.rotation)).unwrap_or((sx, sy, ss, so, sr));
    let mut chain: Vec<String> = vec![format!("fps={fps}"), "format=rgba".into()];
    let mut shake = (0.0, 0.0);
    let mut blur = 0.0f64;
    for fx in &look.effects {
        match fx {
            Effect::Color { brightness, contrast, saturation } => {
                if (brightness - 1.0).abs() > 1e-6 || (contrast - 1.0).abs() > 1e-6 {
                    let v = format!("clip(((val*{brightness:.4})-127.5)*{contrast:.4}+127.5,0,255)");
                    chain.push(format!("lutrgb=r='{v}':g='{v}':b='{v}'"));
                }
                if (saturation - 1.0).abs() > 1e-6 {
                    chain.push(saturate_mixer(*saturation));
                }
            }
            Effect::Mono => chain.push(saturate_mixer(0.0)),
            Effect::Invert => chain.push("negate".into()),
            Effect::Blur { radius } => blur += radius.max(0.0),
            Effect::Shake { amount, speed } => shake = (*amount, *speed),
            // 波・渦巻きは元の大きさで掛けるので、px は始まりの大きさで割る（時刻はアイテムの頭から）
            Effect::Wave { .. } | Effect::Swirl { .. } => {
                if let Some(g) = distort_geq(fx, 1.0 / ss.max(0.01)) {
                    chain.push(g);
                }
            }
        }
    }
    if sr.abs() > 1e-9 || er.abs() > 1e-9 {
        chain.push(format!("rotate=a='{}*PI/180':c=black@0:ow='hypot(iw,ih)':oh='hypot(iw,ih)'", tween(sr, er, e, "t", dur)));
    }
    if blur > 0.0 {
        // 半径は画面上の px。この時点では元の大きさなので、始まりの大きさで割る
        chain.push(format!("gblur=sigma={:.3}", blur / ss.max(0.01)));
    }
    if (so - eo).abs() > 1e-9 {
        chain.push(format!("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*{}'", tween(so, eo, e, "T", dur)));
    } else if so < 1.0 {
        chain.push(format!("colorchannelmixer=aa={so:.3}"));
    }
    if look.fade_in > 0 {
        chain.push(format!("fade=t=in:st=0:d={:.3}:alpha=1", look.fade_in as f64 / fps as f64));
    }
    if look.fade_out > 0 {
        let d = look.fade_out as f64 / fps as f64;
        chain.push(format!("fade=t=out:st={:.3}:d={d:.3}:alpha=1", (dur - d).max(0.0)));
    }
    if (ss - es).abs() > 1e-9 {
        let k = tween(ss, es, e, "t", dur);
        chain.push(format!("scale=w='max(1,iw*{k})':h='max(1,ih*{k})':eval=frame"));
    } else {
        chain.push(format!("scale=iw*{ss:.4}:ih*{ss:.4}"));
    }
    chain.push(format!("setpts=PTS-STARTPTS+{start:.3}/TB"));
    fc.push(format!("[{idx}:v]{}[{src_l}]", chain.join(",")));
    let lt = format!("(t-{start:.3})");
    let mut x = format!("(W-w)/2+{}", tween(sx, ex, e, &lt, dur));
    let mut y = format!("(H-h)/2+{}", tween(sy, ey, e, &lt, dur));
    if shake.0 > 0.0 {
        x.push_str(&format!("+{a:.3}*sin(2*PI*{f:.4}*t)", a = shake.0, f = shake.1));
        y.push_str(&format!("+{a:.3}*cos(2*PI*{f:.4}*t*1.37)", a = shake.0, f = shake.1));
    }
    fc.push(format!("[{last_v}][{src_l}]overlay=x='{x}':y='{y}':enable='between(t,{start:.3},{end:.3})':eof_action=pass[{out_l}]"));
    out_l
}

/// 彩度（CSS の saturate() と同じ行列）
/// 波・渦巻きのフィルタ（geq で画素を読む場所をずらす）。k は画面の 1px が元の何 px か。
/// 画面（preview/visual.ts の distort）と同じ式：
/// 波 = 横に amount·sin(2π(y/length + speed·T)) ずらす、渦巻き = 中心からの距離 r で angle·(1 − r/R)² だけ回す（R は短い辺の半分）
pub(crate) fn distort_geq(fx: &Effect, k: f64) -> Option<String> {
    let geq = |x: &str, y: &str| format!("geq=r='r({x},{y})':g='g({x},{y})':b='b({x},{y})':a='alpha({x},{y})'");
    match fx {
        Effect::Wave { amount, length, speed } if amount.abs() > 1e-6 && *length > 0.0 => {
            let d = format!("{a:.4}*sin(2*PI*(Y/{l:.4}+{speed:.4}*T))", a = amount * k, l = length * k);
            Some(geq(&format!("X-{d}"), "Y"))
        }
        Effect::Swirl { angle } if angle.abs() > 1e-6 => {
            let a = format!("{:.6}*pow(max(0,1-hypot(X-W/2,Y-H/2)/(min(W,H)/2)),2)", angle.to_radians());
            let x = format!("W/2+(X-W/2)*cos({a})+(Y-H/2)*sin({a})");
            let y = format!("H/2-(X-W/2)*sin({a})+(Y-H/2)*cos({a})");
            Some(geq(&x, &y))
        }
        _ => None,
    }
}

fn saturate_mixer(s: f64) -> String {
    let (r, g, b) = (0.213, 0.715, 0.072);
    format!(
        "colorchannelmixer=rr={:.4}:rg={:.4}:rb={:.4}:gr={:.4}:gg={:.4}:gb={:.4}:br={:.4}:bg={:.4}:bb={:.4}",
        r + (1.0 - r) * s,
        g - g * s,
        b - b * s,
        r - r * s,
        g + (1.0 - g) * s,
        b - b * s,
        r - r * s,
        g - g * s,
        b + (1.0 - b) * s
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn with_media(mut p: Project) -> Project {
        p.clips.push(Clip {
            id: "m1".into(),
            track_id: "V1".into(),
            start: 0,
            duration: 270,
            link_id: None,
            body: ClipBody::Media(MediaClip {
                src: "bg.png".into(),
                media_kind: MediaKind::Image,
                has_audio: false,
                in_point: 0,
                volume: 1.0,
                transform: Transform { scale: 0.5, ..Default::default() },
                look: Default::default(),
            }),
        });
        p
    }

    #[test]
    fn ducking_lowers_bgm_only_during_lines() {
        let mut p = Project::sample();
        p.clips.push(Clip {
            id: "bgm".into(),
            track_id: "V6".into(),
            start: 0,
            duration: 300,
            link_id: None,
            body: ClipBody::Media(MediaClip {
                src: "/m/bgm.mp3".into(),
                media_kind: MediaKind::Audio,
                has_audio: true,
                in_point: 0,
                volume: 1.0,
                transform: Transform::default(),
                look: Default::default(),
            }),
        });
        // サンプルの 3 行は続いているので 1 つにまとまる
        assert_eq!(voice_intervals(&p), vec![(0.0, 9.0)]);
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        let wav = |id: &str| Some(PathBuf::from(format!("/c/{id}.wav")));
        let fc = |p: &Project| {
            let a = build_args(p, &wav, &[], &[], &opt).unwrap();
            a[a.iter().position(|x| x == "-filter_complex").unwrap() + 1].clone()
        };
        assert!(!fc(&p).contains("eval=frame"), "既定では下げない");
        p.tracks.iter_mut().find(|t| t.id == "V6").unwrap().duck = true;
        let g = fc(&p);
        assert!(g.contains("volume='1-0.700*min(1,min(clip((t--0.250)/0.25,0,1),clip((9.250-t)/0.25,0,1)))':eval=frame"), "{g}");
        // 離れたセリフは別の区間
        p.clips[2].start = 300;
        assert_eq!(voice_intervals(&p).len(), 2);
    }

    #[test]
    fn encoder_args() {
        assert_eq!(Encoder::X264.args(20, "veryfast")[..4], ["-c:v", "libx264", "-preset", "veryfast"]);
        assert!(Encoder::Nvenc.args(20, "x").contains(&"h264_nvenc".to_string()));
        let mut opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        opt.encoder = Encoder::Qsv;
        let a = build_args(&Project::sample(), &|id| Some(PathBuf::from(format!("/c/{id}.wav"))), &[], &[], &opt).unwrap();
        assert!(a.windows(2).any(|w| w[0] == "-c:v" && w[1] == "h264_qsv"));
        assert!(!a.contains(&"libx264".to_string()));
    }

    #[test]
    fn long_filter_goes_to_a_file() {
        let d = tempfile::tempdir().unwrap();
        let mut a: Vec<String> = ["-i", "x", "-filter_complex", "abc", "-map"].map(String::from).to_vec();
        let f = d.path().join("g.txt");
        assert!(!externalize_filter(&mut a, &f, true, 10).unwrap());
        a[3] = "x".repeat(20);
        assert!(externalize_filter(&mut a, &f, true, 10).unwrap());
        assert_eq!(a[2], "-/filter_complex");
        assert_eq!(std::fs::read_to_string(&f).unwrap().len(), 20);
    }

    #[test]
    fn escape_windows_path() {
        assert_eq!(escape_filter_path(Path::new(r"C:\Users\me\sub.ass")), r"'C\:/Users/me/sub.ass'");
    }

    #[test]
    fn args_contain_expected_graph() {
        let p = with_media(Project::sample());
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        let args = build_args(&p, &|id| Some(PathBuf::from(format!("/cache/{id}.wav"))), &[], &[("V2".into(), PathBuf::from("/tmp/s.ass"))], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("adelay=delays=3000:all=1"), "{fc}");
        assert!(fc.contains("amix=inputs=3"));
        assert!(fc.contains("overlay=x=(W-w)/2+0.0"));
        // 字幕はそのトラック（V2）の順番で焼き込む：V1 の画像の上
        let ov = fc.find("overlay=x=(W-w)/2+0.0").unwrap();
        assert!(fc.find("ass='/tmp/s.ass'[sub0]").unwrap() > ov, "{fc}");
        assert!(fc.contains("[sub0]null[vout]"));
        assert!(args.contains(&Path::new("/proj").join("bg.png").to_string_lossy().into_owned()));
        // 背景の長さ＝最後のクリップの終わり（270 フレーム = 9 秒）
        assert!(args.iter().any(|a| a.ends_with(":d=9.000")));
    }

    /// 分離した動画：映像（音を使わない）と、リンクした音声クリップ（音声トラック）
    fn video_with_audio(p: &mut Project, track: &str, src: &str, start: Frame, in_point: Frame, volume: f64) {
        let media = |kind| MediaClip { src: src.into(), media_kind: kind, has_audio: kind == MediaKind::Audio, in_point, volume, transform: Transform::default(), look: Default::default() };
        p.clips.push(Clip { id: "v1".into(), track_id: track.into(), start, duration: 60, link_id: Some("lkv".into()), body: ClipBody::Media(media(MediaKind::Video)) });
        p.clips.push(Clip { id: "v1a".into(), track_id: "V6".into(), start, duration: 60, link_id: Some("lkv".into()), body: ClipBody::Media(media(MediaKind::Audio)) });
    }

    #[test]
    fn video_audio_is_mixed_only_when_present() {
        let mut p = Project::sample();
        video_with_audio(&mut p, "V1", "/m/a.mp4", 30, 15, 0.5);
        p.validate().unwrap();
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        let wav = |id: &str| Some(PathBuf::from(format!("/c/{id}.wav")));
        let args = build_args(&p, &wav, &[], &[], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("amix=inputs=4"), "{fc}");
        assert!(fc.contains("adelay=delays=1000:all=1,volume=0.500"));
        // 切り出し位置 15 フレーム = 0.5 秒
        let i = args.iter().rposition(|a| a == "/m/a.mp4").unwrap();
        assert_eq!(&args[i - 5..i - 1], &["-ss", "0.500", "-t", "2.000"]);
        // 音声クリップを消すと、動画の音は鳴らない
        p.clips.retain(|c| c.id != "v1a");
        let args = build_args(&p, &wav, &[], &[], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("amix=inputs=3"));
        // 映像と音が 1 つのクリップなら、その動画の音が鳴る。目を消したトラックでは鳴らない
        if let ClipBody::Media(m) = &mut p.clips.iter_mut().find(|c| c.id == "v1").unwrap().body {
            m.has_audio = true;
        }
        let args = build_args(&p, &wav, &[], &[], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("amix=inputs=4") && fc.contains("volume=0.500"), "{fc}");
        p.tracks[0].hidden = true;
        let args = build_args(&p, &wav, &[], &[], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("amix=inputs=3"), "{fc}");
        // ミュート・ソロ
        let mut q = Project::sample();
        q.clips[1].track_id = "V5".into(); // c2 を分離して A2 へ
        q.tracks.iter_mut().find(|t| t.id == "V5").unwrap().solo = true;
        let args = build_args(&q, &wav, &[], &[], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("amix=inputs=1:"), "ソロの A2 の 1 行だけ: {fc}");
    }

    #[test]
    fn output_height_scales_after_subtitles() {
        let p = Project::sample();
        let mut opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        opt.out_height = Some(720);
        let wav = |id: &str| Some(PathBuf::from(format!("/c/{id}.wav")));
        let args = build_args(&p, &wav, &[], &[("V2".into(), PathBuf::from("/s.ass"))], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("[0:v]ass='/s.ass'[sub0]") && fc.contains("[sub0]null,scale=-2:720:flags=lanczos[vout]"), "{fc}");
        opt.out_height = Some(1080); // 同じ高さなら縮めない
        let args = build_args(&p, &wav, &[], &[("V2".into(), PathBuf::from("/s.ass"))], &opt).unwrap();
        assert!(!args.iter().any(|a| a.contains("scale=-2")));
    }

    #[test]
    fn cancel_stops_ffmpeg_and_removes_output() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("long.mp4");
        // 長い映像を作らせ、最初の進捗で取り消す
        let args: Vec<String> = ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=120", "-c:v", "libx264", "-preset", "veryslow", "-progress", "pipe:1", "-nostats"]
            .iter()
            .map(|s| s.to_string())
            .chain([out.to_string_lossy().into_owned()])
            .collect();
        let flag = std::sync::atomic::AtomicBool::new(false);
        let t = std::time::Instant::now();
        let r = run_cancellable(&args, Path::new("ffmpeg"), 120.0, &mut |_| flag.store(true, std::sync::atomic::Ordering::Relaxed), Some(&flag));
        assert!(matches!(r, Err(Error::Cancelled)), "{r:?}");
        assert!(t.elapsed().as_secs() < 30);
        assert!(!out.exists());
    }

    #[test]
    fn missing_voice_is_an_error() {
        let p = Project::sample();
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        assert!(build_args(&p, &|_| None, &[], &[], &opt).is_err());
    }

    /// 実際に FFmpeg で書き出す（FFmpeg が入っている環境だけ）
    #[test]
    fn renders_real_file_when_ffmpeg_available() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            eprintln!("ffmpeg がないので省略");
            return;
        }
        let d = tempfile::tempdir().unwrap();
        // 素材画像
        let st = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "color=c=0x336699:s=320x180", "-frames:v", "1"])
            .arg(d.path().join("bg.png"))
            .status()
            .unwrap();
        assert!(st.success());
        let mut p = with_media(Project::sample());
        p.video.width = 640;
        p.video.height = 360;
        for (i, c) in p.clips.iter_mut().filter(|c| c.as_voice().is_some()).enumerate() {
            let w = d.path().join(format!("{}.wav", c.id));
            crate::wav::write_tone(&w, 24000, 800 + i as u32 * 200, 300.0 + i as f32 * 100.0);
            c.as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: c.id.clone(), duration_ms: 0 });
        }
        // 立ち絵（体・目・口の 3 層。目と口は状態ごとに色を変えて、合成されたか確かめる）
        let mk = |name: &str, filter: &str| {
            let st = std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-f", "lavfi", "-i", "color=c=black@0.0:s=200x300,format=rgba"])
                .args(["-vf", filter, "-frames:v", "1"])
                .arg(d.path().join(name))
                .status()
                .unwrap();
            assert!(st.success());
        };
        mk("body.png", "drawbox=x=40:y=40:w=120:h=240:color=0xff9f0a@1:t=fill");
        mk("eye0.png", "drawbox=x=70:y=90:w=60:h=10:color=white@1:t=fill");
        mk("eye2.png", "drawbox=x=70:y=95:w=60:h=2:color=white@1:t=fill");
        mk("mouth0.png", "drawbox=x=90:y=140:w=20:h=3:color=red@1:t=fill");
        mk("mouth2.png", "drawbox=x=85:y=135:w=30:h=20:color=red@1:t=fill");
        // 画面側で PSD から作る状態ごとの画像の代わりに、パーツを重ねた画像を用意する
        let pt = Portrait {
            base: "body.png".into(),
            eyes: [Some("eye0.png".into()), None, Some("eye2.png".into())],
            mouth: [Some("mouth0.png".into()), None, Some("mouth2.png".into())],
            transform: Transform { x: 180.0, y: 20.0, scale: 0.8, opacity: 1.0 },
            visible: true,
            only_while_speaking: true, // 実際の FFmpeg で enable の式が通るか
            expressions: vec![],
            psd: Some(crate::model::PsdPortrait { src: "a.psd".into(), ..Default::default() }),
        };
        let mut frames: std::collections::HashMap<usize, PathBuf> = Default::default();
        for eyes in 0..3 {
            for mouth in 0..3 {
                let layers: Vec<String> = pt.layers(eyes, mouth, 0).into_iter().map(|l| d.path().join(l).to_string_lossy().into_owned()).collect();
                let dst = d.path().join(format!("state{}.png", eyes * 3 + mouth));
                compose_layers(Path::new("ffmpeg"), &layers, &dst).unwrap();
                frames.insert(eyes * 3 + mouth, dst);
            }
        }
        p.characters[0].portrait = Some(pt);
        // 立ち絵アイテム（V1 の画像の上に足したトラック、全体）
        p.tracks.insert(1, crate::model::Track::new("VP", crate::model::TrackKind::Video));
        portrait_item(&mut p, "ch_a", "VP", 0, 270);
        let dir2 = d.path().to_path_buf();
        let all = std::collections::HashMap::from([("ch_a".to_string(), frames)]);
        let portraits = prepare_portraits(&p, d.path(), Path::new("ffmpeg"), d.path(), &|key| {
            crate::waveform::peaks(&dir2.join(format!("{key}.wav")), crate::lipsync::PEAKS_PER_SEC).ok()
        }, &all)
        .unwrap();
        assert_eq!(portraits.len(), 1);
        assert_eq!(portraits[0].track, "VP");
        let list = std::fs::read_to_string(&portraits[0].concat).unwrap();
        assert!(list.starts_with("ffconcat version 1.0"));
        assert!(list.lines().filter(|l| l.starts_with("duration")).count() > 3, "{list}");

        // 動画素材（音声付き）と字幕アニメーション
        let st = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=660:d=3"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest"])
            .arg(d.path().join("clip.mp4"))
            .status()
            .unwrap();
        assert!(st.success());
        video_with_audio(&mut p, "V1", "clip.mp4", 60, 15, 0.8);
        if let ClipBody::Media(m) = &mut p.clips.iter_mut().find(|c| c.id == "v1").unwrap().body {
            m.transform = Transform { x: -150.0, y: -80.0, ..Default::default() };
        }
        p.characters[0].subtitle.animation = SubtitleAnimation::Pop;
        p.characters[1].subtitle.animation = SubtitleAnimation::Typewriter;

        let captions: Vec<(String, PathBuf)> = crate::subtitle::caption_tracks(&p)
            .into_iter()
            .map(|t| {
                let f = d.path().join(format!("s_{t}.ass"));
                std::fs::write(&f, crate::subtitle::build_ass_for(&p, Some(&t))).unwrap();
                (t, f)
            })
            .collect();
        assert_eq!(captions.len(), 2);
        let out = d.path().join("out.mp4");
        let opt = ExportOptions::new("ffmpeg", &out, d.path());
        let dir = d.path().to_path_buf();
        let args = build_args(&p, &move |id| Some(dir.join(format!("{id}.wav"))), &portraits, &captions, &opt).unwrap();
        let mut last = 0.0;
        run(&args, Path::new("ffmpeg"), p.video.frames_to_secs(p.duration()), &mut |x| last = x).unwrap();
        assert_eq!(last, 1.0);
        let probe = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "default=nw=1"])
            .arg(&out)
            .output()
            .unwrap();
        let s = String::from_utf8_lossy(&probe.stdout);
        assert!(s.contains("codec_type=video") && s.contains("codec_type=audio"), "{s}");
        let dur: f64 = s.lines().find_map(|l| l.strip_prefix("duration=")).unwrap().parse().unwrap();
        assert!((dur - 9.0).abs() < 0.1, "duration={dur}");
    }

    #[test]
    fn portrait_only_while_speaking() {
        let mut p = Project::sample();
        p.clips[2].start = 300; // c3 を離す
        let iv = speaking_intervals(&p, "ch_a");
        assert_eq!(iv, vec![(0.0, 3.0), (10.0, 13.0)]);
        assert_eq!(speaking_intervals(&p, "ch_b"), vec![(3.0, 6.0)]);
        let pi = PortraitInput { concat: PathBuf::from("/c/p.ffconcat"), transform: Transform::default(), track: "V2".into(), only: Some(iv), fx: vec![] };
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        let args = build_args(&p, &|id| Some(PathBuf::from(format!("/c/{id}.wav"))), &[pi], &[], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains(":enable='between(t,0.000,2.999)+between(t,10.000,12.999)'"), "{fc}");
    }

    fn portrait_item(p: &mut Project, ch: &str, track: &str, start: Frame, duration: Frame) {
        let transform = p.character(ch).and_then(|c| c.portrait.as_ref()).map(|pt| pt.transform.clone()).unwrap_or_default();
        p.clips.push(Clip { id: format!("pi_{ch}_{start}"), track_id: track.into(), start, duration, link_id: None, body: ClipBody::Portrait(crate::model::PortraitClip { character_id: ch.into(), transform, only_while_speaking: None, expression: None }) });
    }

    #[test]
    fn psd_portrait_uses_given_frames() {
        let mut p = Project::sample();
        p.characters[0].portrait = Some(crate::model::Portrait {
            base: String::new(),
            eyes: Default::default(),
            mouth: Default::default(),
            transform: Transform::default(),
            visible: true,
            only_while_speaking: false,
            expressions: vec![],
            psd: Some(crate::model::PsdPortrait { src: "/a.psd".into(), ..Default::default() }),
        });
        let d = tempfile::tempdir().unwrap();
        // 立ち絵アイテムが無ければ出さない
        assert!(prepare_portraits(&p, d.path(), Path::new("ffmpeg"), d.path(), &|_| None, &Default::default()).unwrap().is_empty());
        portrait_item(&mut p, "ch_a", "V1", 30, 60);
        portrait_item(&mut p, "ch_a", "V1", 200, 40);
        // 画像が渡されていなければ、わかる言葉で止める
        let e = prepare_portraits(&p, d.path(), Path::new("ffmpeg"), d.path(), &|_| None, &Default::default()).unwrap_err();
        assert!(e.to_string().contains("PSD 立ち絵"), "{e}");
        let mut frames: std::collections::HashMap<usize, PathBuf> = Default::default();
        for i in 0..9 {
            frames.insert(i, PathBuf::from(format!("/c/s{i}.png")));
        }
        let all = std::collections::HashMap::from([("ch_a".to_string(), frames)]);
        let out = prepare_portraits(&p, d.path(), Path::new("ffmpeg"), d.path(), &|_| None, &all).unwrap();
        assert_eq!(out.len(), 2, "アイテムごとに 1 つ");
        assert_eq!(out[0].only, Some(vec![(1.0, 3.0)]));
        assert!(std::fs::read_to_string(&out[0].concat).unwrap().contains("/c/s0.png"));
        // 喋っているときだけ：アイテムの間とセリフの間（0〜3 秒・6〜9 秒）が重なるところだけ
        p.characters[0].portrait.as_mut().unwrap().only_while_speaking = true;
        let out = prepare_portraits(&p, d.path(), Path::new("ffmpeg"), d.path(), &|_| None, &all).unwrap();
        assert_eq!(out.iter().map(|o| o.only.clone().unwrap()).collect::<Vec<_>>(), vec![vec![(1.0, 3.0)], vec![(6.666666666666667, 8.0)]]);
    }

    #[test]
    fn text_and_animated_items() {
        use crate::model::{Anim, Clip, Ease, Effect, Look, ShapeClip, TextClip};
        let mut p = Project::sample();
        let look = Look {
            rotation: 10.0,
            anim: Some(Anim { to: Transform { x: 100.0, y: 0.0, scale: 2.0, opacity: 0.5 }, rotation: 90.0, ease: Ease::InOut }),
            fade_in: 15,
            fade_out: 0,
            effects: vec![Effect::Blur { radius: 4.0 }, Effect::Shake { amount: 5.0, speed: 2.0 }, Effect::Mono, Effect::Color { brightness: 1.2, contrast: 1.0, saturation: 1.0 }],
        };
        p.clips.push(Clip {
            id: "t1".into(),
            track_id: "V1".into(),
            start: 30,
            duration: 60,
            link_id: None,
            body: ClipBody::Text(TextClip {
                text: "やあ".into(),
                font_family: "Yu Gothic UI".into(),
                font_size: 80,
                color: "#FFFFFF".into(),
                outline_color: "#000000".into(),
                outline_width: 4,
                bold: true,
                italic: false,
                align: "center".into(),
                transform: Transform::default(),
                look,
            }),
        });
        p.clips.push(Clip {
            id: "s1".into(),
            track_id: "V1".into(),
            start: 120,
            duration: 30,
            link_id: None,
            body: ClipBody::Shape(ShapeClip {
                shape: "rect".into(),
                width: 200.0,
                height: 100.0,
                fill: "#FF0000".into(),
                stroke: String::new(),
                stroke_width: 0.0,
                transform: Transform::default(),
                look: Look::default(),
            }),
        });
        let mut opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        let wav = |id: &str| Some(PathBuf::from(format!("/c/{id}.wav")));
        // 画像が無ければ、わかる言葉で止める
        assert!(build_args(&p, &wav, &[], &[], &opt).unwrap_err().to_string().contains("画像が用意されていません"));
        opt.item_images.insert("t1".into(), PathBuf::from("/c/t1.png"));
        opt.item_images.insert("s1".into(), PathBuf::from("/c/s1.png"));
        let a = build_args(&p, &wav, &[], &[], &opt).unwrap();
        let g = &a[a.iter().position(|x| x == "-filter_complex").unwrap() + 1];
        assert!(a.iter().any(|x| x == "/c/t1.png") && a.iter().any(|x| x == "/c/s1.png"));
        assert!(g.contains("rotate=a='(10.0000+(80.0000)*if(lt(clip(t/2.0000,0,1),0.5)"), "{g}");
        assert!(g.contains("c=black@0"), "回転の外は透明に");
        assert!(g.contains("geq=") && g.contains("fade=t=in:st=0:d=0.500:alpha=1") && g.contains("eval=frame"), "{g}");
        assert!(g.contains("gblur=sigma=4.000") && g.contains("lutrgb=") && g.contains("colorchannelmixer=rr=0.2130"), "{g}");
        assert!(g.contains("+5.000*sin(2*PI*2.0000*t)"), "{g}");
        // 動きの無い図形は今までと同じ形
        assert!(g.contains("scale=iw*1.0000:ih*1.0000,format=rgba,colorchannelmixer=aa=1.000,setpts=PTS-STARTPTS+4.000/TB"), "{g}");
    }

    /// 実際の FFmpeg で、動き・効果つきのアイテムが書き出せるか（FFmpeg が無い環境では何もしない）
    #[test]
    fn animated_items_export_with_real_ffmpeg() {
        use crate::model::{Anim, Clip, Ease, Effect, Look, TextClip};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| assert!(std::process::Command::new("ffmpeg").args(args).status().unwrap().success());
        let png = d.path().join("t.png");
        let wav = d.path().join("v.wav");
        run(&["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red@0.8:s=120x60,format=rgba", "-frames:v", "1", png.to_str().unwrap()]);
        run(&["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.5", wav.to_str().unwrap()]);
        let mut p = Project::sample();
        p.video.width = 320;
        p.video.height = 180;
        for c in p.clips.iter_mut() {
            c.duration = 15;
            c.start /= 6;
        }
        p.clips.push(Clip {
            id: "t1".into(),
            track_id: "V1".into(),
            start: 3,
            duration: 30,
            link_id: None,
            body: ClipBody::Text(TextClip {
                text: "x".into(),
                font_family: "a".into(),
                font_size: 10,
                color: "#fff".into(),
                outline_color: String::new(),
                outline_width: 0,
                bold: false,
                italic: false,
                align: "center".into(),
                transform: Transform { x: -50.0, y: 0.0, scale: 0.5, opacity: 1.0 },
                look: Look {
                    rotation: 0.0,
                    anim: Some(Anim { to: Transform { x: 50.0, y: 10.0, scale: 1.5, opacity: 0.3 }, rotation: 180.0, ease: Ease::Out }),
                    fade_in: 5,
                    fade_out: 5,
                    effects: vec![
                        Effect::Blur { radius: 1.5 },
                        Effect::Shake { amount: 3.0, speed: 4.0 },
                        Effect::Invert,
                        Effect::Color { brightness: 1.1, contrast: 1.2, saturation: 0.5 },
                        Effect::Wave { amount: 4.0, length: 30.0, speed: 2.0 },
                        Effect::Swirl { angle: -120.0 },
                    ],
                },
            }),
        });
        let out = d.path().join("o.mp4");
        let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
        opt.item_images.insert("t1".into(), png.clone());
        let w = wav.clone();
        let args = build_args(&p, &move |_: &str| Some(w.clone()), &[], &[], &opt).unwrap();
        let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        assert!(std::fs::metadata(&out).unwrap().len() > 0);
    }

    #[test]
    fn line_portrait_effects_and_custom_subtitle_export_with_real_ffmpeg() {
        use crate::model::{Effect, LinePortrait, SubtitleCustom};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| assert!(std::process::Command::new("ffmpeg").args(args).status().unwrap().success());
        let png = d.path().join("t.png");
        let wav = d.path().join("v.wav");
        run(&["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red@0.8:s=120x60,format=rgba", "-frames:v", "1", png.to_str().unwrap()]);
        run(&["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.5", wav.to_str().unwrap()]);
        let concat = d.path().join("p.ffconcat");
        std::fs::write(&concat, format!("ffconcat version 1.0\nfile {}\nduration 2\nfile {}\n", concat_quote(&png), concat_quote(&png))).unwrap();
        let mut p = Project::sample();
        p.video.width = 320;
        p.video.height = 180;
        for c in p.clips.iter_mut() {
            c.duration = 15;
            c.start /= 6;
        }
        let fx = vec![
            Effect::Mono,
            Effect::Invert,
            Effect::Blur { radius: 2.0 },
            Effect::Shake { amount: 4.0, speed: 3.0 },
            Effect::Color { brightness: 1.2, contrast: 1.1, saturation: 0.5 },
            Effect::Wave { amount: 6.0, length: 40.0, speed: 1.0 },
            Effect::Swirl { angle: 90.0 },
        ];
        {
            let v = p.clips[0].as_voice_mut().unwrap();
            v.portrait = Some(LinePortrait { effects: fx.clone(), ..Default::default() });
            v.subtitle_custom = Some(Box::new(serde_json::from_value::<SubtitleCustom>(serde_json::json!({
                "fontFamily": "a", "fontSize": 20, "color": "#fff",
                "transform": {"x": 0.0, "y": 50.0, "scale": 1.0, "opacity": 1.0},
                "look": {"fadeIn": 3}, "interval": 2
            })).unwrap()));
            v.audio_fx = Some(Box::new(crate::model::LineAudio {
                pan: -0.5,
                fade_in: 3,
                fade_out: 3,
                start_offset: 2,
                echo: Some(crate::model::Echo { delay_ms: 120.0, decay: 0.4 }),
                filters: vec![crate::model::AudioFilter::Highpass { hz: 300.0 }, crate::model::AudioFilter::Lowpass { hz: 3400.0 }],
            }));
        }
        // 個別に設定した字幕は ASS に入らない
        let ass = crate::subtitle::build_ass_for(&p, Some("V2"));
        assert!(!ass.contains(&p.clips[0].as_voice().unwrap().text));
        let eff = line_portrait_effects(&p, "ch_a");
        assert_eq!(eff.len(), 1);
        let pi = PortraitInput { concat, transform: Transform::default(), track: "V2".into(), only: None, fx: eff };
        let out = d.path().join("o.mp4");
        let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
        // 1 文字ずつ出す字幕は、文字数ごとの画像（id#1, id#2, …）を順に出す
        let n = p.clips[0].as_voice().unwrap().text.chars().count();
        for k in 1..=n {
            opt.item_images.insert(format!("c1#{k}"), png.clone());
        }
        opt.item_sequences = prepare_sequences(&p, &opt.item_images, d.path()).unwrap();
        assert!(opt.item_sequences.contains_key("c1"));
        let list = std::fs::read_to_string(&opt.item_sequences["c1"]).unwrap();
        assert!(list.contains("duration 0.066667"), "{list}");
        let w = wav.clone();
        let args = build_args(&p, &move |_: &str| Some(w.clone()), &[pi], &[], &opt).unwrap();
        let fcs = args.iter().find(|a| a.contains("overlay")).unwrap();
        assert!(fcs.contains("negate=enable=") && fcs.contains("geq=") && fcs.contains("aecho") && fcs.contains("FL=1.0000*FC|FR=0.5000*FC"), "{fcs}");
        let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        // 画像が無ければ分かるように止まる
        let opt2 = ExportOptions::new("ffmpeg", &out, d.path());
        let w = wav.clone();
        assert!(build_args(&p, &move |_: &str| Some(w.clone()), &[], &[], &opt2).is_err());
    }
}
