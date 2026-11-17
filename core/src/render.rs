//! FFmpeg での書き出し。引数の組み立て（テスト可能な純粋関数）と、実行・進捗の読み取り。

use crate::lipsync;
use crate::model::{ClipBody, Ease, Effect, Look, MediaKind, MotionKind, Project, ShapeClip, TextClip, Transform};
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
    /// 背景を消す型（素材のパス → 型の動画・画像）。ai::make_matte で作ったもの
    pub mattes: std::collections::HashMap<String, PathBuf>,
    /// PSD 立ち絵の、状態ごとの画像（キャラクター id → 状態の番号 → PNG のパス）。画面側で合成して渡す
    pub portrait_frames: std::collections::HashMap<String, std::collections::HashMap<usize, PathBuf>>,
    /// 静止画を 1 枚だけ書き出すときの時刻（秒）。音は作らない
    pub still_at: Option<f64>,
    /// 一部だけ書き出すときの範囲（始まりと終わりの秒）。無ければ全体
    pub range: Option<(f64, f64)>,
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
            mattes: Default::default(),
            portrait_frames: Default::default(),
            still_at: None,
            range: None,
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
                Effect::Grade { .. } | Effect::Temperature { .. } => chain.extend(grade_filters(e).into_iter().map(|f| format!("{f}:{en}"))),
                Effect::Lut { path, strength } if *strength > 0.0 => chain.push(format!("lut3d=file={}:{en}", escape_filter_path(Path::new(path)))),
                Effect::Lut { .. } => {}
                Effect::Wave { .. } | Effect::Swirl { .. } => {
                    // 大きさを変えた後なので、px はそのまま画面の px。時刻は動画の頭から
                    if let Some(g) = distort_geq(e, 1.0) {
                        chain.push(format!("{g}:{en}"));
                    }
                }
                // そのほかは立ち絵のセリフごとのエフェクトでは使わない（画面も同じ）
                _ => {}
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
    // つなぎ目の切り替えは、前後のアイテムの登場・退場・フェードと覆う図形に置き換えて描く
    let owned = p.with_transitions();
    let p = &owned;
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
                ClipBody::Shape(ShapeClip { transform, look, region: Some(rg), .. }) => {
                    // モザイク・ぼかし範囲：図形を透明な画面に置いて形を取り、その形の中だけ、下の絵を加工したものに替える
                    let Some(img) = opt.item_images.get(&c.id) else {
                        return Err(Error::Other(format!("アイテム {} の画像が用意されていません", c.id)));
                    };
                    push_input(
                        &mut args,
                        vec!["-loop".into(), "1".into(), "-framerate".into(), v.fps.to_string(), "-t".into(), format!("{dur:.3}")],
                        img.to_string_lossy().into_owned(),
                    );
                    fc.push(format!("[{last_v}]split[rgb{idx}][rgc{idx}]"));
                    fc.push(format!("[rgc{idx}]format=rgba,drawbox=c=black@0:t=fill:replace=1[rgt{idx}]"));
                    let plain_look = Look { blend: None, ..look.clone() };
                    let lay = visual_filters(&mut fc, idx, &format!("{idx}:v"), &format!("rgt{idx}"), v.fps, transform, &plain_look, start, dur);
                    fc.push(format!("[{lay}]format=rgba,alphaextract[rga{idx}]"));
                    fc.push(format!("[rgb{idx}]split[rg1{idx}][rg2{idx}]"));
                    let k = rg.strength.max(1.0);
                    let fx = match rg.kind {
                        crate::model::RegionKind::Mosaic => format!("pixelize=w={b}:h={b}", b = k.round().max(2.0) as u32),
                        crate::model::RegionKind::Blur => format!("gblur=sigma={k:.2}"),
                    };
                    fc.push(format!("[rg2{idx}]{fx},format=rgba[rgf{idx}]"));
                    fc.push(format!("[rgf{idx}][rga{idx}]alphamerge[rgm{idx}]"));
                    fc.push(format!("[rg1{idx}][rgm{idx}]overlay=format=rgb[rgo{idx}]"));
                    last_v = format!("rgo{idx}");
                    idx += 1;
                }
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
                    last_v = visual_filters(&mut fc, idx, &format!("{idx}:v"), &last_v, v.fps, transform, look, start, dur);
                    idx += 1;
                }
                ClipBody::Media(m) => {
                    let src = resolve(&opt.project_dir, &m.src);
                    let in_s = v.frames_to_secs(m.in_point);
                    // 速さ・逆再生・静止：素材から切り出す長さと、映像・音の前処理
                    let fx = &m.src_fx;
                    let span = if fx.freeze { 1.0 / v.fps as f64 } else { fx.advance(dur, dur) };
                    let (vpre, apre) = source_filters(fx, dur, v.fps);
                    // 音の加工（素材の時間のまま）→ 逆再生・速さ
                    let achain = fx.audio_fx.as_ref().map(crate::audiofx::audio_chain).unwrap_or_default();
                    // やまびこの残りがクリップの後ろへはみ出さないよう、クリップの長さで切る
                    let apre = if achain.is_empty() { apre } else { format!("{achain}{apre}atrim=0:{dur:.3},") };
                    match m.media_kind {
                        MediaKind::Audio => {
                            push_input(&mut args, vec!["-ss".into(), format!("{in_s:.3}"), "-t".into(), format!("{span:.3}")], src);
                            if !fx.freeze {
                                let l = format!("a{idx}");
                                fc.push(format!("[{idx}:a]{apre}aresample={},adelay=delays={delay_ms}:all=1,volume={:.3}{duck}[{l}]", v.sample_rate, m.volume));
                                audio_labels.push(l);
                            }
                        }
                        MediaKind::Image | MediaKind::Video => {
                            let pre = if m.media_kind == MediaKind::Image {
                                vec!["-loop".into(), "1".into(), "-framerate".into(), v.fps.to_string(), "-t".into(), format!("{dur:.3}")]
                            } else {
                                // 静止は 1 コマあれば足りるが、読み損ねないよう少し長めに取る
                                vec!["-ss".into(), format!("{in_s:.3}"), "-t".into(), format!("{:.3}", if fx.freeze { 0.5 } else { span })]
                            };
                            push_input(&mut args, pre.clone(), src);
                            // 背景を消す型（素材と同じ範囲を読む。型は素材の時刻のまま）
                            let matte_in = match fx.matte.as_ref() {
                                Some(_) => {
                                    let Some(mp) = opt.mattes.get(&m.src) else {
                                        return Err(Error::Other(format!("「{}」の背景を消す準備ができていません（プロパティの「背景を消す」で作ってください）", m.src)));
                                    };
                                    push_input(&mut args, pre, mp.to_string_lossy().into_owned());
                                    Some(idx + 1)
                                }
                                None => None,
                            };
                            // 映像と音が 1 つのクリップの動画（分離した動画の音は、音声トラックのクリップで鳴らす）
                            if m.media_kind == MediaKind::Video && m.has_audio && track_audible && !fx.freeze {
                                let l = format!("a{idx}");
                                // 切り替えで映像だけを延ばしたときは、音を元の長さで切る
                                let cut = m.audio_frames.map(|f| format!("atrim=0:{:.3},", v.frames_to_secs(f))).unwrap_or_default();
                                fc.push(format!("[{idx}:a]{apre}{cut}aresample={},adelay=delays={delay_ms}:all=1,volume={:.3}{duck}[{l}]", v.sample_rate, m.volume));
                                audio_labels.push(l);
                            }
                            // 速さなど（動画だけ）→ 切り抜き → 色を抜く・形で切り抜く
                            // 手ぶれ補正は素材の時間のまま（速さより前。プレビューは同じ deshake を掛けたプロキシ）
                            let video = m.media_kind == MediaKind::Video;
                            let pre = format!("{}{}{}", if video && fx.stabilize { "deshake," } else { "" }, if video { vpre.as_str() } else { "" }, spatial_filters(fx));
                            // 型を素材の大きさに合わせ、白いところを残す（不透明度にする）
                            let base = match matte_in {
                                Some(mi) => {
                                    fc.push(format!("[{mi}:v]format=gray[mg{idx}]"));
                                    fc.push(format!("[mg{idx}][{idx}:v]scale2ref=w=iw:h=ih[mk{idx}][ms{idx}]"));
                                    fc.push(format!("[ms{idx}]format=rgba[mr{idx}]"));
                                    fc.push(format!("[mr{idx}][mk{idx}]alphamerge[am{idx}]"));
                                    format!("am{idx}")
                                }
                                None => format!("{idx}:v"),
                            };
                            let input = if !pre.is_empty() {
                                fc.push(format!("[{base}]{}[s{idx}]", pre.trim_end_matches(',')));
                                format!("s{idx}")
                            } else {
                                base
                            };
                            // 背景をぼかして埋める：同じ素材を画面いっぱいに広げてぼかし、その上に素材を重ねる
                            let input = match fx.fill_blur.filter(|b| *b > 0.0) {
                                Some(b) => {
                                    let (vw, vh) = (v.width, v.height);
                                    fc.push(format!("[{input}]split[fa{idx}][fb{idx}]"));
                                    fc.push(format!(
                                        "[fa{idx}]fps={},scale={vw}:{vh}:force_original_aspect_ratio=increase,crop={vw}:{vh},gblur=sigma={b:.2},format=rgba,setpts=PTS-STARTPTS+{start:.3}/TB[fg{idx}]",
                                        v.fps
                                    ));
                                    fc.push(format!("[{last_v}][fg{idx}]overlay=0:0:enable='between(t,{start:.3},{:.3})':eof_action=pass[fo{idx}]", start + dur));
                                    last_v = format!("fo{idx}");
                                    format!("fb{idx}")
                                }
                                None => input,
                            };
                            last_v = visual_filters(&mut fc, idx, &input, &last_v, v.fps, &m.transform, &m.look, start, dur);
                            if matte_in.is_some() {
                                idx += 1;
                            }
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
                last_v = visual_filters(&mut fc, idx, &format!("{idx}:v"), &last_v, v.fps, &sc.transform, &sc.look, start, dur);
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
    // 音声だけ（.wav）に書き出すときは、映像は作らずに捨てる
    let ext = opt.out.extension().and_then(|e| e.to_str()).unwrap_or("");
    let audio_only = ext.eq_ignore_ascii_case("wav");
    let gif = ext.eq_ignore_ascii_case("gif") && opt.still_at.is_none();
    if audio_only {
        fc.push(format!("[{last_v}]nullsink"));
    } else if gif {
        // GIF：範囲を切ってから、コマ数を 15 まで落とし、その範囲の色で 256 色の表を作って使う（音はなし）
        let (a, b) = match opt.range {
            Some((a, b)) => (a.clamp(0.0, total_s), b.clamp(a.clamp(0.0, total_s), total_s)),
            None => (0.0, total_s),
        };
        let gfps = v.fps.min(GIF_FPS);
        fc.push(format!(
            "[{last_v}]trim=start={a:.3}:end={:.3},setpts=PTS-STARTPTS,fps={gfps}{resize},split[gif1][gif2];[gif1]palettegen=stats_mode=diff[gifp];[gif2][gifp]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[vout]",
            b.max(a + 0.04)
        ));
        for l in &audio_labels {
            fc.push(format!("[{l}]anullsink"));
        }
        args.extend(["-filter_complex".into(), fc.join(";"), "-map".into(), "[vout]".into(), "-loop".into(), "0".into(), "-progress".into(), "pipe:1".into(), "-nostats".into(), opt.out.to_string_lossy().into_owned()]);
        return Ok(args);
    } else {
        fc.push(format!("[{last_v}]null{resize}[vout]"));
    }
    // 静止画：その時刻の 1 枚だけ。音は混ぜずに捨てる
    if let Some(at) = opt.still_at {
        for l in &audio_labels {
            fc.push(format!("[{l}]anullsink"));
        }
        args.extend([
            "-filter_complex".into(),
            fc.join(";"),
            "-map".into(),
            "[vout]".into(),
            "-ss".into(),
            format!("{:.3}", at.clamp(0.0, (total_s - 1.0 / v.fps as f64).max(0.0))),
            "-frames:v".into(),
            "1".into(),
            "-update".into(),
            "1".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            opt.out.to_string_lossy().into_owned(),
        ]);
        return Ok(args);
    }
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

    if audio_only {
        args.extend([
            "-filter_complex".into(),
            fc.join(";"),
            "-map".into(),
            "[aout]".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            "-ar".into(),
            v.sample_rate.to_string(),
        ]);
        args.extend(range_args(opt.range, total_s));
        args.extend([
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            opt.out.to_string_lossy().into_owned(),
        ]);
        return Ok(args);
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
    ]);
    args.extend(range_args(opt.range, total_s));
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        opt.out.to_string_lossy().into_owned(),
    ]);
    Ok(args)
}

/// GIF の 1 秒あたりのコマ数の上限（重くしすぎない）
pub const GIF_FPS: u32 = 15;

/// 書き出す範囲（出力側で頭を飛ばして、長さで切る）。範囲が無ければ全体の長さで切る
fn range_args(range: Option<(f64, f64)>, total_s: f64) -> Vec<String> {
    match range {
        Some((a, b)) => {
            let a = a.clamp(0.0, total_s);
            let b = b.clamp(a, total_s);
            vec!["-ss".into(), format!("{a:.3}"), "-t".into(), format!("{:.3}", (b - a).max(0.04))]
        }
        None => vec!["-t".into(), format!("{total_s:.3}")],
    }
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

/// 始まり a →（途中 m = [(通る割合, 値)…]、割合の順）→ 終わり b。区間ごとに e の動き方を掛ける（キーフレーム）
fn tween3(a: f64, m: &[(f64, f64)], b: f64, e: Ease, t: &str, dur: f64) -> String {
    if m.is_empty() {
        return tween(a, b, e, t, dur);
    }
    if m.iter().all(|(_, v)| (a - v).abs() < 1e-9) && (a - b).abs() < 1e-9 {
        return format!("{a:.4}");
    }
    let p = format!("clip({t}/{d:.4},0,1)", d = dur.max(1e-3));
    let pts: Vec<(f64, f64)> = std::iter::once((0.0, a)).chain(m.iter().copied()).chain(std::iter::once((1.0, b))).collect();
    // 後ろの区間から入れ子にする：if(p<次の点, この区間, それより後)
    let seg = |i: usize| {
        let ((p0, v0), (p1, v1)) = (pts[i], pts[i + 1]);
        let q = format!("clip(({p}-{p0:.4})/{r:.4},0,1)", r = (p1 - p0).max(1e-6));
        format!("{v0:.4}+({:.4})*{}", v1 - v0, ease_expr(e, &q))
    };
    let mut out = seg(pts.len() - 2);
    for i in (0..pts.len() - 2).rev() {
        out = format!("if(lt({p},{:.4}),{},{out})", pts[i + 1].0, seg(i));
    }
    out
}

/// 色を抜く（クロマキー）の係数：抜く色らしさ score = wr·R + wg·G + wb·B（0〜1 の値で。抜く色そのもので 1、灰色で 0）。
/// 抜く色が灰色に近いと色で見分けられないので None。画面側の chromaWeights と同じ
pub fn chroma_weights(color: &str) -> Option<[f64; 3]> {
    let h = color.trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let c: Vec<f64> = (0..3).map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).map(|v| v as f64 / 255.0)).collect::<std::result::Result<_, _>>().ok()?;
    let m = (c[0] + c[1] + c[2]) / 3.0;
    let d: Vec<f64> = c.iter().map(|v| v - m).collect();
    let n = d.iter().map(|v| v * v).sum::<f64>();
    if n < 1e-3 {
        return None;
    }
    Some([d[0] / n, d[1] / n, d[2] / n])
}

/// 切り抜き・色を抜く・形で切り抜く（素材の大きさのまま、大きさを変える前に掛ける）。末尾に「,」（なければ空）
pub fn spatial_filters(fx: &crate::model::SourceFx) -> String {
    let mut out = String::new();
    if let Some(c) = fx.crop {
        let (l, t) = (c.left.clamp(0.0, 0.95), c.top.clamp(0.0, 0.95));
        let (w, h) = ((1.0 - l - c.right.clamp(0.0, 0.95)).max(0.05), (1.0 - t - c.bottom.clamp(0.0, 0.95)).max(0.05));
        if (w - 1.0).abs() > 1e-6 || (h - 1.0).abs() > 1e-6 {
            out.push_str(&format!("crop=w=iw*{w:.5}:h=ih*{h:.5}:x=iw*{l:.5}:y=ih*{t:.5},"));
        }
    }
    let mut alpha: Vec<String> = vec![];
    if let Some(k) = fx.chroma.as_ref() {
        if let Some([wr, wg, wb]) = chroma_weights(&k.color) {
            let hi = 1.0 - k.similarity.clamp(0.0, 1.0);
            let b = k.blend.clamp(0.01, 1.0);
            alpha.push(format!("clip(({hi:.5}-({wr:.5}*r(X,Y)+{wg:.5}*g(X,Y)+{wb:.5}*b(X,Y))/255)/{b:.5},0,1)"));
        }
    }
    if let Some(m) = fx.mask {
        let (w, h) = (m.w.clamp(0.01, 2.0), m.h.clamp(0.01, 2.0));
        let (cx, cy) = (format!("W*{:.5}", 0.5 + m.x), format!("H*{:.5}", 0.5 + m.y));
        let (hw, hh) = (format!("(W*{:.5})", w / 2.0), format!("(H*{:.5})", h / 2.0));
        let mn = format!("min({hw},{hh})");
        // 形の内側がマイナスになる、縁からの距離（px）
        let sd = match m.shape {
            crate::model::MaskShape::Ellipse => format!("(hypot((X-{cx})/{hw},(Y-{cy})/{hh})-1)*{mn}"),
            crate::model::MaskShape::Rect => {
                let r = format!("({mn}*{:.5})", (m.radius.clamp(0.0, 0.5) * 2.0).min(1.0));
                let (qx, qy) = (format!("(abs(X-{cx})-{hw}+{r})"), format!("(abs(Y-{cy})-{hh}+{r})"));
                format!("(hypot(max({qx},0),max({qy},0))+min(max({qx},{qy}),0)-{r})")
            }
        };
        let f = m.feather.clamp(0.0, 0.5);
        let inside = if f > 1e-6 { format!("clip(0.5-{sd}/(min(W,H)*{f:.5}),0,1)") } else { format!("lte({sd},0)") };
        alpha.push(if m.invert { format!("(1-{inside})") } else { inside });
    }
    if !alpha.is_empty() {
        out.push_str(&format!("format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*{}',", alpha.join("*")));
    }
    out
}

/// 素材の速さ・逆再生・静止の前処理（映像、音）。どちらも末尾に「,」が付く（なければ空）。d はクリップの長さ（秒）
pub fn source_filters(fx: &crate::model::SourceFx, d: f64, fps: u32) -> (String, String) {
    if !fx.is_retimed() {
        return (String::new(), String::new());
    }
    if fx.freeze {
        // 頭の 1 コマを、クリップの長さだけ出し続ける
        return (format!("trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={d:.3},"), String::new());
    }
    let (a, b) = fx.speeds();
    let mut vf = String::new();
    let mut af = String::new();
    if fx.reverse {
        vf.push_str("reverse,");
        af.push_str("areverse,");
    }
    if (a - b).abs() < 1e-9 {
        if (a - 1.0).abs() > 1e-9 {
            vf.push_str(&format!("setpts=(PTS-STARTPTS)/{a:.6},"));
        }
    } else {
        // だんだん変わる速さ：素材の T 秒目は、t = (√(a²+2kT) − a) / k 秒目に出る（k は速さの変わり方）
        let k = (b - a) / d.max(1e-6);
        vf.push_str(&format!("setpts='(sqrt({:.6}+{:.6}*(PTS-STARTPTS)*TB)-{a:.6})/{k:.6}/TB',", a * a, 2.0 * k));
    }
    // なめらかスロー：遅くなったところのコマを、前後のコマの動きから作る
    if fx.smooth && a.min(b) < 0.999 {
        vf.push_str(&format!("minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none,"));
    }
    // 音は平均の速さで（音の高さは変えない）。atempo は 1 段で 0.5〜2 倍なので重ねる
    let mut f = fx.advance(d, d) / d.max(1e-6);
    if (f - 1.0).abs() > 1e-6 {
        while f > 2.0 {
            af.push_str("atempo=2,");
            f /= 2.0;
        }
        while f < 0.5 {
            af.push_str("atempo=0.5,");
            f /= 0.5;
        }
        af.push_str(&format!("atempo={f:.6},"));
    }
    (vf, af)
}

/// 画像・動画・テキスト・図形を重ねるフィルター（入力 idx の映像を last_v に重ね、新しいラベルを返す）。
/// 順番：色の効果 → 回転 → ぼかし → 不透明度 → フェード → 大きさ（大きさが変わるのは最後にして、
/// 大きさの変化に対応しないフィルターを通さない）→ 時刻をずらす → 位置（揺れを含む）で重ねる。
/// 画面（preview/visual.ts）と同じ計算になるようにそろえる
#[allow(clippy::too_many_arguments)]
pub fn visual_filters(fc: &mut Vec<String>, idx: usize, input: &str, last_v: &str, fps: u32, t: &Transform, look: &Look, start: f64, dur: f64) -> String {
    let plain = look.is_plain();
    let src_l = format!("v{idx}");
    let out_l = format!("ov{idx}");
    let end = start + dur;
    if plain {
        // 今までどおり（動きも効果もないとき）
        fc.push(format!(
            "[{input}]fps={fps},scale=iw*{s:.4}:ih*{s:.4},format=rgba,colorchannelmixer=aa={o:.3},setpts=PTS-STARTPTS+{start:.3}/TB[{src_l}]",
            s = t.scale,
            o = t.opacity.clamp(0.0, 1.0)
        ));
        let pos = format!("x=(W-w)/2+{x:.1}:y=(H-h)/2+{y:.1}:enable='between(t,{start:.3},{end:.3})':eof_action=pass", x = t.x, y = t.y);
        place(fc, idx, last_v, &src_l, &pos, look.blend, &out_l);
        return out_l;
    }
    let to = look.anim.as_ref();
    let e = to.map(|a| a.ease).unwrap_or_default();
    let (sx, sy, ss, so, sr) = (t.x, t.y, t.scale, t.opacity.clamp(0.0, 1.0), look.rotation);
    let (ex, ey, es, eo, er) = to.map(|a| (a.to.x, a.to.y, a.to.scale, a.to.opacity.clamp(0.0, 1.0), a.rotation)).unwrap_or((sx, sy, ss, so, sr));
    // 途中の状態（キーフレーム。始まり → 途中…→ 終わりの順に通る）
    let pts = to.map(|a| a.waypoints()).unwrap_or_default();
    let via = |pick: &dyn Fn(&crate::model::AnimMid) -> f64| pts.iter().map(|m| (m.at, pick(m))).collect::<Vec<_>>();
    let (mx, my, ms, mo, mr) = (via(&|m| m.transform.x), via(&|m| m.transform.y), via(&|m| m.transform.scale), via(&|m| m.transform.opacity.clamp(0.0, 1.0)), via(&|m| m.rotation));
    let moving = |a: f64, m: &[(f64, f64)], b: f64| (a - b).abs() > 1e-9 || m.iter().any(|(_, v)| (a - v).abs() > 1e-9);
    // 登場・退場（滑り込む向きのずれと、大きさの倍率）
    let fpsf = fps as f64;
    let enter = look.enter.as_ref().filter(|m| m.frames > 0).map(|m| (m.kind, (m.frames as f64 / fpsf).min(dur.max(1e-3))));
    let exit = look.exit.as_ref().filter(|m| m.frames > 0).map(|m| (m.kind, (m.frames as f64 / fpsf).min(dur.max(1e-3))));
    let enter_smooth = look.enter.as_ref().is_some_and(|m| m.smooth);
    let exit_smooth = look.exit.as_ref().is_some_and(|m| m.smooth);
    // 登場の残り（1 → 0。だんだん遅く）と、退場の進み（0 → 1。だんだん速く）。lt はアイテムの頭からの秒の式
    // なめらか（押し出し）：3p²−2p³ で、出ていく側と入る側の和がいつも 1（くっついたまま動く）
    let smooth = |p: String| format!("(({p})*({p})*(3-2*({p})))");
    let enter_k = |lt: &str, d: f64| {
        let p = format!("clip({lt}/{d:.4},0,1)");
        if enter_smooth { format!("(1-{})", smooth(p)) } else { format!("pow(1-{p},2)") }
    };
    let exit_k = |lt: &str, d: f64| {
        let p = format!("clip(({lt}-{s:.4})/{d:.4},0,1)", s = (dur - d).max(0.0));
        if exit_smooth { smooth(p) } else { format!("pow({p},2)") }
    };
    let slide = |lt: &str, horizontal: bool| -> String {
        let mut out = String::new();
        let dim = if horizontal { "W" } else { "H" };
        let sign = |k: MotionKind| match (k, horizontal) {
            (MotionKind::SlideLeft, true) | (MotionKind::SlideUp, false) => Some("-"),
            (MotionKind::SlideRight, true) | (MotionKind::SlideDown, false) => Some("+"),
            _ => None,
        };
        if let Some((k, d)) = enter {
            if let Some(sg) = sign(k) {
                out.push_str(&format!("{sg}{dim}*{}", enter_k(lt, d)));
            }
        }
        if let Some((k, d)) = exit {
            if let Some(sg) = sign(k) {
                out.push_str(&format!("{sg}{dim}*{}", exit_k(lt, d)));
            }
        }
        out
    };
    let zoom_at = |lt: &str| {
        let mut zoom = String::new();
        if let Some((MotionKind::Zoom, d)) = enter {
            zoom.push_str(&format!("*(1-{})", enter_k(lt, d)));
        }
        if let Some((MotionKind::Zoom, d)) = exit {
            zoom.push_str(&format!("*(1-{})", exit_k(lt, d)));
        }
        zoom
    };
    let zoom = zoom_at("t");
    let mut chain: Vec<String> = vec![format!("fps={fps}"), "format=rgba".into()];
    let mut trail: Option<(u32, u32)> = None;
    let mut moves: Vec<&Effect> = vec![];
    // 反転は素材そのものを裏返す（エフェクト・クリッピング解除はその向きで掛かる）
    if look.flip_x {
        chain.push("hflip".into());
    }
    if look.flip_y {
        chain.push("vflip".into());
    }
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
            // フィルター・色温度：色を混ぜてから、色ごとの明るさの曲線（画面は同じ数の SVG フィルター）
            Effect::Grade { .. } | Effect::Temperature { .. } => chain.extend(grade_filters(fx)),
            // LUT：強さが 1 未満なら、元の色と混ぜる
            Effect::Lut { path, strength } if *strength > 0.0 => {
                let f = format!("lut3d=file={}", escape_filter_path(Path::new(path)));
                if *strength >= 0.999 {
                    chain.push(f);
                } else {
                    let n = chain.len();
                    chain.push(format!("split[lu{idx}a{n}][lu{idx}b{n}];[lu{idx}b{n}]{f}[lu{idx}c{n}];[lu{idx}a{n}][lu{idx}c{n}]blend=all_mode=normal:all_opacity={:.4}", strength.min(1.0)));
                }
            }
            Effect::Lut { .. } => {}
            Effect::Invert => chain.push("negate".into()),
            Effect::Blur { radius } => blur += radius.max(0.0),
            Effect::Shake { amount, speed } => shake = (*amount, *speed),
            // 波・渦巻きは元の大きさで掛けるので、px は始まりの大きさで割る（時刻はアイテムの頭から）
            Effect::Wave { .. } | Effect::Swirl { .. } => {
                if let Some(g) = distort_geq(fx, 1.0 / ss.max(0.01)) {
                    chain.push(g);
                }
            }
            Effect::Trail { count, interval } if *count > 0 && *interval > 0 => trail = Some((*count.min(&8), *interval)),
            Effect::Trail { .. } => {}
            Effect::Jitter { .. } | Effect::Oscillate { .. } => moves.push(fx),
            Effect::Blink { speed } if *speed > 0.0 => chain.push(format!("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(1-mod(floor(T*{:.4}),2))'", speed * 2.0)),
            Effect::Blink { .. } => {}
            _ => {
                let n = chain.len();
                chain.extend(pixel_effect(fx, 1.0 / ss.max(0.01), &format!("{idx}x{n}")));
            }
        }
    }
    // クリッピング解除（ワイプ）：見える範囲を、アイテムの頭からの秒 T で広げる・狭める（回す前の向きで）
    let mut wipe: Vec<String> = vec![];
    if let Some((k, d)) = enter {
        let v = enter_k("T", d);
        match k {
            MotionKind::WipeRight => wipe.push(format!("lt(X,W*(1-{v}))")),
            MotionKind::WipeLeft => wipe.push(format!("gte(X,W*{v})")),
            MotionKind::WipeDown => wipe.push(format!("lt(Y,H*(1-{v}))")),
            MotionKind::WipeUp => wipe.push(format!("gte(Y,H*{v})")),
            _ => {}
        }
    }
    if let Some((k, d)) = exit {
        let q = exit_k("T", d);
        match k {
            MotionKind::WipeRight => wipe.push(format!("gte(X,W*{q})")),
            MotionKind::WipeLeft => wipe.push(format!("lt(X,W*(1-{q}))")),
            MotionKind::WipeDown => wipe.push(format!("gte(Y,H*{q})")),
            MotionKind::WipeUp => wipe.push(format!("lt(Y,H*(1-{q}))")),
            _ => {}
        }
    }
    if !wipe.is_empty() {
        chain.push(format!("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*{}'", wipe.join("*")));
    }
    // 3D 回転（始まり → 終わりへ ease で）
    let r3a = look.rot3d.unwrap_or([0.0, 0.0]);
    let r3b = to.and_then(|a| a.rot3d).unwrap_or(r3a);
    if r3a.iter().chain(r3b.iter()).any(|v| v.abs() > 1e-9) {
        chain.extend(tilt_filters(&tween(r3a[0], r3b[0], e, "T", dur), &tween(r3a[1], r3b[1], e, "T", dur)));
    }
    if sr.abs() > 1e-9 || er.abs() > 1e-9 || mr.iter().any(|(_, v)| v.abs() > 1e-9) {
        chain.push(format!("rotate=a='{}*PI/180':c=black@0:ow='hypot(iw,ih)':oh='hypot(iw,ih)'", tween3(sr, &mr, er, e, "t", dur)));
    }
    if blur > 0.0 {
        // 半径は画面上の px。この時点では元の大きさなので、始まりの大きさで割る
        chain.push(format!("gblur=sigma={:.3}", blur / ss.max(0.01)));
    }
    if moving(so, &mo, eo) {
        chain.push(format!("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*{}'", tween3(so, &mo, eo, e, "T", dur)));
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
    let [kx, ky] = look.stretch.unwrap_or([1.0, 1.0]).map(|v| v.max(0.01));
    if moving(ss, &ms, es) || !zoom.is_empty() {
        let k = format!("{}{zoom}", tween3(ss, &ms, es, e, "t", dur));
        let m = |v: f64| if (v - 1.0).abs() > 1e-9 { format!("*{v:.4}") } else { String::new() };
        chain.push(format!("scale=w='max(1,iw*{k}{})':h='max(1,ih*{k}{})':eval=frame", m(kx), m(ky)));
    } else {
        chain.push(format!("scale=iw*{:.4}:ih*{:.4}", ss * kx, ss * ky));
    }
    chain.push(format!("setpts=PTS-STARTPTS+{start:.3}/TB"));
    fc.push(format!("[{input}]{}[{src_l}]", chain.join(",")));
    // 置く位置（delay 秒だけ前の時点の位置。残像に使う）
    let pos_at = |delay: f64| -> (String, String) {
        let t_abs = if delay > 0.0 { format!("(t-{delay:.4})") } else { "t".to_string() };
        let lt = if delay > 0.0 { format!("(t-{:.4})", start + delay) } else { format!("(t-{start:.3})") };
        let mut x = format!("(W-w)/2+{}{}", tween3(sx, &mx, ex, e, &lt, dur), slide(&lt, true));
        let mut y = format!("(H-h)/2+{}{}", tween3(sy, &my, ey, e, &lt, dur), slide(&lt, false));
        if shake.0 > 0.0 {
            x.push_str(&format!("+{a:.3}*sin(2*PI*{f:.4}*{t_abs})", a = shake.0, f = shake.1));
            y.push_str(&format!("+{a:.3}*cos(2*PI*{f:.4}*{t_abs}*1.37)", a = shake.0, f = shake.1));
        }
        // ランダム移動・反復移動（アイテムの頭からの秒で。画面の visualAt と同じ）
        for m in &moves {
            match m {
                Effect::Jitter { amount, speed } if *speed > 0.0 => {
                    let n = format!("floor({lt}*{speed:.4})");
                    x.push_str(&format!("+{amount:.3}*({}*2-1)", crate::model::hash01_expr(&n, "1")));
                    y.push_str(&format!("+{amount:.3}*({}*2-1)", crate::model::hash01_expr(&n, "2")));
                }
                Effect::Oscillate { x: ax, y: ay, speed } => {
                    x.push_str(&format!("+{ax:.3}*sin(2*PI*{speed:.4}*{lt})"));
                    y.push_str(&format!("+{ay:.3}*sin(2*PI*{speed:.4}*{lt})"));
                }
                _ => {}
            }
        }
        // 回転・拡大の中心：その点が位置に来るよう、中心から点までを回して大きさを掛けた分だけ戻す
        if let Some([ox, oy]) = look.pivot.filter(|p| p[0].abs() > 1e-9 || p[1].abs() > 1e-9) {
            let k = format!("({}{})", tween3(ss, &ms, es, e, &lt, dur), zoom_at(&lt));
            let a = format!("(({})*PI/180)", tween3(sr, &mr, er, e, &lt, dur));
            // 回してから縦横の倍率を掛ける（書き出しの順と同じ）
            x.push_str(&format!("-({ox:.3}*cos({a})-{oy:.3}*sin({a}))*{kx:.4}*{k}"));
            y.push_str(&format!("-({ox:.3}*sin({a})+{oy:.3}*cos({a}))*{ky:.4}*{k}"));
        }
        (x, y)
    };
    // 残像：古いものから、前の時点の姿と位置で薄く重ねる（k 番目は不透明度 1 − k/(数+1)）
    let mut under = last_v.to_string();
    if let Some((count, interval)) = trail {
        let n = count as usize;
        let outs: String = (0..=n).map(|k| format!("[tr{idx}s{k}]")).collect();
        fc.push(format!("[{src_l}]split={}{outs}", n + 1));
        for k in (1..=n).rev() {
            let delay = k as f64 * interval as f64 / fpsf;
            let a = 1.0 - k as f64 / (n as f64 + 1.0);
            fc.push(format!("[tr{idx}s{k}]setpts=PTS+{delay:.4}/TB,colorchannelmixer=aa={a:.4}[tr{idx}d{k}]"));
            let (x, y) = pos_at(delay);
            fc.push(format!("[{under}][tr{idx}d{k}]overlay=x='{x}':y='{y}':enable='between(t,{:.3},{end:.3})':eof_action=pass[tr{idx}o{k}]", start + delay));
            under = format!("tr{idx}o{k}");
        }
    }
    let main_src = if trail.is_some() { format!("tr{idx}s0") } else { src_l.clone() };
    let (x, y) = pos_at(0.0);
    let pos = format!("x='{x}':y='{y}':enable='between(t,{start:.3},{end:.3})':eof_action=pass");
    place(fc, idx, &under, &main_src, &pos, look.blend, &out_l);
    out_l
}

/// 色の文字（#RRGGBB）を 0〜255 の R・G・B に（読めなければ白）
pub(crate) fn rgb255(c: &str) -> [u8; 3] {
    let h = c.trim_start_matches('#');
    let h = if h.len() == 3 { h.chars().flat_map(|c| [c, c]).collect::<String>() } else { h.to_string() };
    let v = |i: usize| h.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok()).unwrap_or(255);
    [v(0), v(2), v(4)]
}

/// いくつかの点の平均（色は不透明度で重みを付ける。透明なところの色が混ざって暗くならないように。画面の canvas の重ね方と同じ）
fn average_geq(pts: &[String]) -> String {
    let n = pts.len();
    let sa = pts.iter().map(|p| format!("alpha({p})")).collect::<Vec<_>>().join("+");
    let ch = |f: &str| format!("({})/max({sa},0.001)", pts.iter().map(|p| format!("{f}({p})*alpha({p})")).collect::<Vec<_>>().join("+"));
    format!("geq=r='{}':g='{}':b='{}':a='({sa})/{n}'", ch("r"), ch("g"), ch("b"))
}

/// 縁取り・影・発光で、形を読む向き（16 方向）
pub const RING: usize = 16;

/// 画素を読むエフェクト（縁取り・影・発光・色ずれ・グリッチ・ノイズ・放射ブラー・方向ブラー・二値化）のフィルター。
/// k は画面の 1px が元の何 px か、tag はラベルの重なりを避ける印。広がるものは先に透明な余白を足す（真ん中はそのまま）。
/// 画面（preview/visual.ts の pixelEffect）と同じ式
pub(crate) fn pixel_effect(fx: &Effect, k: f64, tag: &str) -> Vec<String> {
    let pad = |p: f64| format!("pad=iw+{0}:ih+{0}:{1}:{1}:color=black@0", (p.ceil() as i64) * 2, p.ceil() as i64);
    // 形を色で塗ったもの（alpha は a の式）を後ろに敷く
    let under = |c: &str, a: &str, blur: f64| -> String {
        let [r, g, b] = rgb255(c);
        let bl = if blur > 0.0 { format!(",gblur=sigma={blur:.3}") } else { String::new() };
        format!("split[fa{tag}][fb{tag}];[fb{tag}]geq=r='{r}':g='{g}':b='{b}':a='{a}'{bl}[fc{tag}];[fc{tag}][fa{tag}]overlay=format=rgb,format=rgba")
    };
    match fx {
        Effect::Outline { color, width } if *width > 0.0 => {
            let w = width * k;
            // 16 方向の太さ w と w/2 の点のうち、いちばん濃いところ
            let mut a = "alpha(X,Y)".to_string();
            for r in [w, w / 2.0] {
                for i in 0..RING {
                    let t = i as f64 * std::f64::consts::TAU / RING as f64;
                    a = format!("max({a},alpha(X-{:.3},Y-{:.3}))", r * t.cos(), r * t.sin());
                }
            }
            vec![pad(w + 1.0), under(color, &a, 0.0)]
        }
        Effect::Shadow { color, blur, x, y, opacity } => {
            let (b, dx, dy) = (blur.max(0.0) * k, x * k, y * k);
            vec![pad(b * 3.0 + dx.abs().max(dy.abs()) + 1.0), under(color, &format!("alpha(X-{dx:.3},Y-{dy:.3})*{:.4}", opacity.clamp(0.0, 1.0)), b)]
        }
        Effect::Glow { color, blur, strength } => {
            let b = blur.max(0.0) * k;
            let n = strength.round().clamp(1.0, 5.0);
            // ぼかした形を n 回重ねた濃さ：1 − (1 − a)ⁿ
            let [r, g, bl] = rgb255(color);
            vec![
                pad(b * 3.0 + 1.0),
                format!(
                    "split[fa{tag}][fb{tag}];[fb{tag}]geq=r='{r}':g='{g}':b='{bl}':a='alpha(X,Y)',gblur=sigma={b:.3},geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*(1-pow(1-alpha(X,Y)/255,{n}))'[fc{tag}];[fc{tag}][fa{tag}]overlay=format=rgb,format=rgba"
                ),
            ]
        }
        Effect::RgbShift { amount } if amount.abs() > 0.0 => {
            let a = amount * k;
            vec![pad(a.abs() + 1.0), format!("geq=r='r(X-{a:.3},Y)':g='g(X,Y)':b='b(X+{a:.3},Y)':a='max(max(alpha(X-{a:.3},Y),alpha(X,Y)),alpha(X+{a:.3},Y))'")]
        }
        Effect::Glitch { amount, band, speed } if *band > 0.0 => {
            let a = amount * k;
            let row = format!("floor(Y/{:.4})", band * k);
            let n = format!("floor(T*{speed:.4})");
            // 帯ごと・時刻ごとに、4 割の帯だけ横にずらす
            let off = format!("if(gt({},0.6),{a:.3}*({}*2-1),0)", crate::model::hash01_expr(&format!("{row}+0.5"), &format!("{n}+7")), crate::model::hash01_expr(&row, &n));
            let ch = |f: &str| format!("{f}(X-{off},Y)");
            vec![pad(a.abs() + 1.0), format!("geq=r='{}':g='{}':b='{}':a='{}'", ch("r"), ch("g"), ch("b"), ch("alpha"))]
        }
        Effect::Noise { amount } if *amount > 0.0 => {
            let n = format!("({}-0.5)*{:.3}", crate::model::hash01_expr("X+Y*0.618", "N+0.37"), amount.min(1.0) * 255.0 * 2.0);
            let ch = |f: &str| format!("clip({f}(X,Y)+{n},0,255)");
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r"), ch("g"), ch("b"))]
        }
        Effect::RadialBlur { amount } if *amount > 0.0 => {
            let a = amount.clamp(0.0, 0.9);
            let ss: Vec<f64> = (0..8).map(|i| 1.0 - a * i as f64 / 7.0).collect();
            let pts: Vec<String> = ss.iter().map(|s| format!("W/2+(X-W/2)*{s:.4},H/2+(Y-H/2)*{s:.4}")).collect();
            vec![average_geq(&pts)]
        }
        Effect::DirBlur { length, angle } if *length > 0.0 => {
            let l = length * k;
            let (c, s) = (angle.to_radians().cos(), angle.to_radians().sin());
            let ds: Vec<f64> = (0..8).map(|i| l * (i as f64 / 7.0 - 0.5)).collect();
            let pts: Vec<String> = ds.iter().map(|d| format!("X-{:.3},Y-{:.3}", d * c, d * s)).collect();
            vec![pad(l / 2.0 + 1.0), average_geq(&pts)]
        }
        Effect::Threshold { level } => {
            let v = format!("255*gt(0.299*r(X,Y)+0.587*g(X,Y)+0.114*b(X,Y),{:.3})", level.clamp(0.0, 1.0) * 255.0);
            vec![format!("geq=r='{v}':g='{v}':b='{v}':a='alpha(X,Y)'")]
        }
        _ => vec![],
    }
}

/// 3D 回転の枠の広さ（元の大きさに対して。傾けて手前に来た側がはみ出さないように）
pub const TILT_PAD: f64 = 1.4;

/// 3D 回転：元の画像を TILT_PAD 倍の透明な枠の真ん中に置き、X 軸・Y 軸で傾けて奥行きのある見え方にする。
/// rx・ry は度の式（T はアイテムの頭からの秒）。カメラの距離は枠の長い辺 ×2÷TILT_PAD。
/// 画面の点ごとに、傾けた板のどこが見えるかを逆に解いて読む（画面の preview/visual.ts の tilt3d と同じ式）
pub fn tilt_filters(rx: &str, ry: &str) -> Vec<String> {
    let pre = format!(
        "st(0,({rx})*PI/180);st(1,({ry})*PI/180);st(2,max(W,H)*2/{TILT_PAD});st(3,X-W/2);st(4,Y-H/2);\
st(5,ld(2)*cos(ld(1))+ld(3)*sin(ld(1)));st(6,ld(2)*sin(ld(0))*sin(ld(1))-ld(3)*sin(ld(0))*cos(ld(1)));\
st(7,ld(4)*sin(ld(1)));st(8,ld(2)*cos(ld(0))-ld(4)*sin(ld(0))*cos(ld(1)));st(9,ld(5)*ld(8)-ld(6)*ld(7));\
st(6,ld(2)*(ld(3)*ld(8)-ld(4)*ld(6))/ld(9));st(7,ld(2)*(ld(5)*ld(4)-ld(7)*ld(3))/ld(9));"
    );
    let ok = "gt(ld(2)-ld(6)*sin(ld(1))+ld(7)*sin(ld(0))*cos(ld(1)),1)*gt(abs(ld(9)),1e-6)";
    let ch = |f: &str| format!("{pre}if({ok},{f}(ld(6)+W/2,ld(7)+H/2),0)");
    vec![
        format!("pad=w='ceil(iw*{TILT_PAD}/2)*2':h='ceil(ih*{TILT_PAD}/2)*2':x='(ow-iw)/2':y='(oh-ih)/2':color=black@0"),
        format!("geq=r='{}':g='{}':b='{}':a='{}'", ch("r"), ch("g"), ch("b"), ch("alpha")),
    ]
}

/// アイテムを下の絵に重ねる。合成モードがあれば、いったん透明な画面に置いてから下の絵と混ぜ、アイテムの不透明度の分だけ見せる
/// （canvas の合成と同じ：(1−α)·下 + α·B(下, アイテム)）
fn place(fc: &mut Vec<String>, idx: usize, last_v: &str, src: &str, pos: &str, blend: Option<crate::model::BlendMode>, out: &str) {
    let Some(mode) = blend else {
        fc.push(format!("[{last_v}][{src}]overlay={pos}[{out}]"));
        return;
    };
    let m = mode.ffmpeg();
    fc.push(format!("[{last_v}]format=rgba,split[bg{idx}][cv{idx}]"));
    fc.push(format!("[cv{idx}]drawbox=c=black@0:t=fill:replace=1[cl{idx}]"));
    fc.push(format!("[cl{idx}][{src}]overlay={pos}:format=rgb,format=rgba,split[la{idx}][lc{idx}]"));
    fc.push(format!("[la{idx}]alphaextract[al{idx}]"));
    fc.push(format!("[bg{idx}]split[b1{idx}][b2{idx}]"));
    fc.push(format!("[b1{idx}]format=gbrp[bb{idx}]"));
    fc.push(format!("[lc{idx}]format=gbrp[lr{idx}]"));
    fc.push(format!("[bb{idx}][lr{idx}]blend=all_mode={m},format=rgba[bx{idx}]"));
    fc.push(format!("[bx{idx}][al{idx}]alphamerge[bm{idx}]"));
    fc.push(format!("[b2{idx}][bm{idx}]overlay=format=rgb[{out}]"));
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

/// フィルター・色温度のフィルター（色を混ぜる → 色ごとの明るさの曲線）
fn grade_filters(fx: &Effect) -> Vec<String> {
    let Some((m, g)) = crate::model::color_grade(fx) else { return vec![] };
    let mut out = vec![format!(
        "colorchannelmixer=rr={:.4}:rg={:.4}:rb={:.4}:gr={:.4}:gg={:.4}:gb={:.4}:br={:.4}:bg={:.4}:bb={:.4}",
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]
    )];
    if g.iter().any(|[a, e, o]| (a - 1.0).abs() > 1e-6 || (e - 1.0).abs() > 1e-6 || o.abs() > 1e-6) {
        let c = |[a, e, o]: [f64; 3]| format!("'clip({a:.4}*pow(val/255,{e:.4})+{o:.4},0,1)*255'");
        out.push(format!("lutrgb=r={}:g={}:b={}", c(g[0]), c(g[1]), c(g[2])));
    }
    out
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
                audio_frames: None,
                src_fx: Default::default(),
            }),
        });
        p
    }

    #[test]
    fn transition_after_video_cuts_its_audio() {
        let mut p = Project::sample();
        let vid = |id: &str, start: Frame, kind: MediaKind| Clip {
            id: id.into(),
            track_id: "V1".into(),
            start,
            duration: 60,
            link_id: None,
            body: ClipBody::Media(MediaClip {
                src: format!("/m/{id}.mp4"),
                media_kind: kind,
                has_audio: kind == MediaKind::Video,
                in_point: 0,
                volume: 1.0,
                transform: Transform::default(),
                look: Default::default(),
                audio_frames: None,
                src_fx: Default::default(),
            }),
        };
        p.clips.push(vid("va", 0, MediaKind::Video));
        let mut b = vid("vb", 60, MediaKind::Image);
        if let ClipBody::Media(m) = &mut b.body {
            m.look.transition = Some(Transition { kind: TransitionKind::Dissolve, frames: 20 });
        }
        p.clips.push(b);
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.mp4", "/proj");
        let wav = |id: &str| Some(PathBuf::from(format!("/c/{id}.wav")));
        let a = build_args(&p, &wav, &[], &[], &opt).unwrap();
        let g = &a[a.iter().position(|x| x == "-filter_complex").unwrap() + 1];
        // 映像は延ばすが、音は元の 2 秒で切る
        assert!(g.contains("atrim=0:2.000,aresample"), "{g}");
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
                audio_frames: None,
                src_fx: Default::default(),
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

    /// 音声だけ（.wav）：映像は捨て、PCM の WAV にする（字幕・立ち絵は作らない）
    #[test]
    fn wav_export_is_audio_only() {
        let p = with_media(Project::sample());
        let opt = ExportOptions::new("ffmpeg", "/tmp/o.wav", "/proj");
        let args = build_args(&p, &|id| Some(PathBuf::from(format!("/cache/{id}.wav"))), &[], &[], &opt).unwrap();
        let fc = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("nullsink"), "{fc}");
        assert!(!fc.contains("[vout]"), "{fc}");
        assert!(args.windows(2).any(|w| w[0] == "-c:a" && w[1] == "pcm_s16le"));
        assert!(!args.iter().any(|a| a == "-c:v" || a == "-movflags"));
        assert_eq!(args.last().unwrap(), "/tmp/o.wav");
    }

    /// 分離した動画：映像（音を使わない）と、リンクした音声クリップ（音声トラック）
    fn video_with_audio(p: &mut Project, track: &str, src: &str, start: Frame, in_point: Frame, volume: f64) {
        let media = |kind| MediaClip { src: src.into(), media_kind: kind, has_audio: kind == MediaKind::Audio, in_point, volume, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: Default::default() };
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
            anim: Some(Anim { to: Transform { x: 100.0, y: 0.0, scale: 2.0, opacity: 0.5 }, rotation: 90.0, ease: Ease::InOut, mid: None, keys: vec![], rot3d: None }),
            fade_in: 15,
            fade_out: 0,
            enter: None,
            exit: None,
            transition: None,
            blend: None,
            ..Default::default()
        };
        let look = Look {
            effects: vec![Effect::Blur { radius: 4.0 }, Effect::Shake { amount: 5.0, speed: 2.0 }, Effect::Mono, Effect::Color { brightness: 1.2, contrast: 1.0, saturation: 1.0 }],
            ..look
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
                deco: Default::default(),
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
                region: None,
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
                    anim: Some(Anim { to: Transform { x: 50.0, y: 10.0, scale: 1.5, opacity: 0.3 }, rotation: 180.0, ease: Ease::Out, mid: None, keys: vec![], rot3d: None }),
                    fade_in: 5,
                    fade_out: 5,
                    enter: None,
                    exit: None,
                    transition: None,
                    blend: None,
                    effects: vec![
                        Effect::Blur { radius: 1.5 },
                        Effect::Shake { amount: 3.0, speed: 4.0 },
                        Effect::Invert,
                        Effect::Color { brightness: 1.1, contrast: 1.2, saturation: 0.5 },
                        Effect::Wave { amount: 4.0, length: 30.0, speed: 2.0 },
                        Effect::Swirl { angle: -120.0 },
                    ],
                    ..Default::default()
                },
                deco: Default::default(),
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

    /// 押し出し（なめらかな登場・退場）の式を FFmpeg が読める（FFmpeg があれば実際に 1 枚書く）
    #[test]
    fn smooth_push_expression_runs() {
        use crate::model::{Clip, Look, Motion, MotionKind, ShapeClip};
        let mut p = Project::sample();
        p.video.width = 320;
        p.video.height = 180;
        p.clips.retain(|c| c.as_voice().is_none());
        let shape = |id: &str, start, look: Look| Clip {
            id: id.into(),
            track_id: "V6".into(),
            start,
            duration: 30,
            link_id: None,
            body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: 320.0, height: 180.0, fill: "#fff".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform::default(), look, region: None }),
        };
        p.clips.push(shape("a", 0, Look { exit: Some(Motion { kind: MotionKind::SlideLeft, frames: 10, smooth: true }), ..Default::default() }));
        p.clips.push(shape("b", 30, Look { enter: Some(Motion { kind: MotionKind::SlideRight, frames: 10, smooth: true }), ..Default::default() }));
        let d = tempfile::tempdir().unwrap();
        let png = d.path().join("s.png");
        let out = d.path().join("still.png");
        let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
        opt.item_images.insert("a".into(), png.clone());
        opt.item_images.insert("b".into(), png.clone());
        opt.still_at = Some(1.1);
        let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
        let g = args.join(" ");
        assert!(g.contains("+W*(1-((clip((t-1.000)/0.3333,0,1))*(clip((t-1.000)/0.3333,0,1))*(3-2*(clip((t-1.000)/0.3333,0,1)))))") || g.contains("*(3-2*("), "{g}");
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1", png.to_str().unwrap()]).status().unwrap().success());
        let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    }

    /// 速さ・だんだん速く・逆再生・静止：実際に ffmpeg で書き出して、出たコマの明るさで素材のどこかを確かめる
    #[test]
    fn retimed_media_shows_the_right_frame() {
        use crate::model::{Clip, SourceFx};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        // 2 秒の素材。明るさが時間とともに 20 → 220 に上がる（音も入れる）
        let src = d.path().join("ramp.mp4");
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=30:d=2,format=gray,geq=lum='20+100*T',format=yuv420p", "-f", "lavfi", "-i", "sine=f=440:d=2", "-shortest", "-c:v", "libx264", "-g", "1", "-c:a", "aac"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let shot = |fx: SourceFx, in_point: Frame, duration: Frame, at: f64| -> f64 {
            let mut p = Project::sample();
            p.video.width = 64;
            p.video.height = 36;
            p.video.fps = 30;
            p.clips.clear();
            p.clips.push(Clip {
                id: "m".into(),
                track_id: "V1".into(),
                start: 0,
                duration,
                link_id: None,
                body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Video, has_audio: true, in_point, volume: 1.0, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: fx }),
            });
            let out = d.path().join("o.mp4");
            let opt = ExportOptions::new("ffmpeg", &out, d.path());
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let o = std::process::Command::new("ffmpeg").args(["-v", "error", "-ss", &format!("{at:.3}"), "-i"]).arg(&out).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap();
            assert!(!o.stdout.is_empty());
            o.stdout.iter().map(|&b| b as f64).sum::<f64>() / o.stdout.len() as f64
        };
        // 明るさ（limited range の誤差込み）から、素材の何秒目かを逆算
        let secs = |lum: f64| ((lum - 16.0) * 255.0 / 219.0 - 20.0) / 100.0;
        let near = |got: f64, want: f64| assert!((secs(got) - want).abs() < 0.12, "want {want}s, got {:.3}s", secs(got));
        // 2 倍速：0.5 秒目に素材の 1 秒目
        near(shot(SourceFx { speed: 2.0, ..Default::default() }, 0, 30, 0.5), 1.0);
        // 逆再生：0.5 秒目に素材の 1.5 秒目
        near(shot(SourceFx { reverse: true, ..Default::default() }, 0, 60, 0.5), 1.5);
        // 静止：ずっと切り出し位置（0.5 秒目）のコマ
        near(shot(SourceFx { freeze: true, ..Default::default() }, 15, 30, 0.8), 0.5);
        // だんだん速く（1 → 3 倍、1 秒で素材 2 秒）：0.5 秒目に素材の 0.75 秒目
        near(shot(SourceFx { speed: 1.0, speed_to: Some(3.0), ..Default::default() }, 0, 30, 0.5), 0.75);
        // 逆再生の 2 倍速：0.5 秒目に素材の 1 秒目
        near(shot(SourceFx { speed: 2.0, reverse: true, ..Default::default() }, 0, 30, 0.5), 1.0);
        // 手ぶれ補正を付けても時間はずれない
        near(shot(SourceFx { stabilize: true, ..Default::default() }, 0, 60, 0.5), 0.5);
    }

    /// 一部だけの書き出し：出力側で頭を飛ばして、その長さだけ書く（音だけのときも）
    #[test]
    fn range_export_cuts_output() {
        let p = Project::sample();
        let wav = |id: &str| Some(PathBuf::from(format!("/cache/{id}.wav")));
        let mut opt = ExportOptions::new("ffmpeg", Path::new("/o.mp4"), Path::new("/"));
        opt.range = Some((1.0, 2.5));
        let args = build_args(&p, &wav, &[], &[], &opt).unwrap();
        let tail = args[args.len() - 12..].join(" ");
        assert!(tail.contains("-ss 1.000 -t 1.500"), "{tail}");
        opt.out = PathBuf::from("/o.wav");
        let args = build_args(&p, &wav, &[], &[], &opt).unwrap();
        assert!(args.join(" ").contains("-ss 1.000 -t 1.500 -progress"), "{}", args.join(" "));
    }

    /// 途中の状態・登場・退場の式と、静止画の書き出し（FFmpeg があれば実際に 1 枚書く）
    /// 切り抜き・色を抜く・形で切り抜く：緑の背景に赤い四角の画像を、実際に ffmpeg で書き出して色を見る
    #[test]
    fn crop_chroma_mask_cut_the_right_pixels() {
        use crate::model::{Chroma, Clip, Crop, Mask, MaskShape, SourceFx};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("g.png");
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x00ff00:s=64x36,drawbox=x=16:y=9:w=32:h=18:c=0xff0000:t=fill", "-frames:v", "1"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let px = |fx: SourceFx| -> Vec<u8> {
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
            p.video.background = "#000000".into();
            p.clips.clear();
            p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 10, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: fx }) });
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            opt.still_at = Some(0.1);
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout
        };
        // (x, y) の色を、黒・緑・赤のどれかで
        let at = |img: &[u8], x: usize, y: usize| {
            let i = (y * 64 + x) * 3;
            let (r, g) = (img[i] as i32, img[i + 1] as i32);
            if r > 150 && g < 100 { 'R' } else if g > 150 && r < 100 { 'G' } else if r < 40 && g < 40 { 'K' } else { '?' }
        };
        let plain = px(SourceFx::default());
        assert_eq!((at(&plain, 2, 2), at(&plain, 32, 18)), ('G', 'R'));
        // 緑を抜くと、外側は背景の黒
        let k = px(SourceFx { chroma: Some(Chroma { color: "#00ff00".into(), similarity: 0.4, blend: 0.1 }), ..Default::default() });
        assert_eq!((at(&k, 2, 2), at(&k, 32, 18)), ('K', 'R'));
        // 楕円で切り抜くと、角は黒、真ん中は赤
        let e = px(SourceFx { mask: Some(Mask { shape: MaskShape::Ellipse, x: 0.0, y: 0.0, w: 0.6, h: 0.6, radius: 0.0, feather: 0.0, invert: false }), ..Default::default() });
        assert_eq!((at(&e, 2, 2), at(&e, 32, 18)), ('K', 'R'));
        // 外側を残すと逆
        let iv = px(SourceFx { mask: Some(Mask { shape: MaskShape::Rect, x: 0.0, y: 0.0, w: 0.6, h: 0.6, radius: 0.2, feather: 0.0, invert: true }), ..Default::default() });
        assert_eq!((at(&iv, 2, 2), at(&iv, 32, 18)), ('G', 'K'));
        // 右半分を切ると、左半分（緑と赤の左側）が真ん中に寄る
        let c = px(SourceFx { crop: Some(Crop { right: 0.5, ..Default::default() }), ..Default::default() });
        assert_eq!((at(&c, 20, 18), at(&c, 40, 18), at(&c, 60, 18)), ('G', 'R', 'K'));
    }

    /// クリッピング解除（ワイプ）：登場は左から広がって現れ、退場は上から消えていく（画面と同じ式）
    #[test]
    fn wipe_reveals_and_hides() {
        use crate::model::{Clip, Motion, MotionKind};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("w.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=40x20", "-frames:v", "1"]).arg(&src).status().unwrap().success());
        let shot = |enter: Option<MotionKind>, exit: Option<MotionKind>, at: f64| -> Vec<u8> {
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
            p.video.background = "#000000".into();
            p.clips.clear();
            let look = Look { enter: enter.map(|kind| Motion { kind, frames: 30, smooth: false }), exit: exit.map(|kind| Motion { kind, frames: 30, smooth: false }), ..Default::default() };
            p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 90, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform::default(), look, audio_frames: None, src_fx: Default::default() }) });
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            opt.still_at = Some(at);
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap().stdout
        };
        // 左右：アイテムは x = 12〜52。0.5 秒で残り (1-0.5)² = 0.25 → 左から 75%（x < 42）まで見える
        let a = shot(Some(MotionKind::WipeRight), None, 0.5);
        assert!(a[18 * 64 + 14] > 200 && a[18 * 64 + 38] > 200, "左は見える");
        assert!(a[18 * 64 + 46] < 50, "右はまだ見えない");
        // 退場（上下）：2.5 秒で進み 0.25 → 上から 25% が消えている（アイテムは y = 8〜28）
        let b = shot(None, Some(MotionKind::WipeDown), 2.5);
        assert!(b[9 * 64 + 32] < 50 && b[20 * 64 + 32] > 200, "上から消えていく");
    }

    /// 64×36 の黒い画面の真ん中に、lavfi で作った画像を look で 1 つ置き、at 秒の明るさ（gray）を返す
    pub(crate) fn shot_look(src: &str, look: Look, transform: Transform, at: f64) -> Vec<u8> {
        shot_fmt(src, look, transform, at, "gray")
    }

    /// shot_look の色つき（rgb24。1 画素 3 バイト）
    pub(crate) fn shot_rgb(src: &str, look: Look, at: f64) -> Vec<u8> {
        shot_fmt(src, look, Transform::default(), at, "rgb24")
    }

    fn shot_fmt(src: &str, look: Look, transform: Transform, at: f64, fmt: &str) -> Vec<u8> {
        use crate::model::Clip;
        let d = tempfile::tempdir().unwrap();
        let img = d.path().join("s.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", src, "-frames:v", "1"]).arg(&img).status().unwrap().success());
        let mut p = Project::sample();
        (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
        p.video.background = "#000000".into();
        p.clips.clear();
        p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 90, link_id: None, body: ClipBody::Media(MediaClip { src: img.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform, look, audio_frames: None, src_fx: Default::default() }) });
        let out = d.path().join("o.png");
        let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
        opt.still_at = Some(at);
        let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
        let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", fmt, "-"]).output().unwrap().stdout
    }

    fn has_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg").arg("-version").output().is_ok()
    }

    /// 反転・縦横の倍率・回転の中心・3D 回転（画面の e2e と同じ数で確かめる）
    #[test]
    fn flip_stretch_pivot_tilt() {
        if !has_ffmpeg() {
            return;
        }
        let half = "nullsrc=s=40x20,geq=lum='if(lt(X,20),235,16)':cb=128:cr=128";
        let row = |g: &[u8], y: usize| (0..64).map(|x| g[y * 64 + x]).collect::<Vec<_>>();
        // 左右反転：左が黒・右が白に
        let a = shot_look(half, Look { flip_x: true, ..Default::default() }, Transform::default(), 0.1);
        assert!(a[18 * 64 + 16] < 50 && a[18 * 64 + 48] > 200, "{:?}", row(&a, 18));
        // 横 2 倍・縦 0.5 倍：20×20 → 40×10（x = 12〜52、y = 13〜23）
        let b = shot_look("color=c=white:s=20x20", Look { stretch: Some([2.0, 0.5]), ..Default::default() }, Transform::default(), 0.1);
        assert!(b[18 * 64 + 14] > 200 && b[18 * 64 + 50] > 200 && b[18 * 64 + 9] < 50, "{:?}", row(&b, 18));
        assert!(b[11 * 64 + 32] < 50 && b[15 * 64 + 32] > 200, "縦は半分");
        // 中心を右に 10px、180° 回すと、真ん中は右へ 10px 動く（8×8 の四角が x = 38〜46 に）
        let c = shot_look("color=c=white:s=8x8", Look { rotation: 180.0, pivot: Some([10.0, 0.0]), ..Default::default() }, Transform::default(), 0.1);
        assert!(c[18 * 64 + 42] > 200 && c[18 * 64 + 32] < 50, "{:?}", row(&c, 18));
        // Y 軸で 60° 傾けると横が縮む（真ん中は白、元の端は黒）
        let t = shot_look("color=c=white:s=40x20", Look { rot3d: Some([0.0, 60.0]), ..Default::default() }, Transform::default(), 0.1);
        let w = row(&t, 18).iter().filter(|v| **v > 128).count();
        assert!(t[18 * 64 + 32] > 200 && (16..=26).contains(&w), "{w} {:?}", row(&t, 18));
        // X 軸で 60° なら縦が縮む
        let u = shot_look("color=c=white:s=40x20", Look { rot3d: Some([60.0, 0.0]), ..Default::default() }, Transform::default(), 0.1);
        let hgt = (0..36).filter(|y| u[y * 64 + 32] > 128).count();
        assert!((8..=13).contains(&hgt), "{hgt}");
    }

    /// 縁取り・影・発光・点滅・残像・色ずれ・グリッチ・ノイズ・放射ブラー・方向ブラー・二値化・ランダム移動・反復移動
    /// （画面の e2e「エフェクトを増やした」と同じ数で確かめる）
    #[test]
    fn more_effects() {
        if !has_ffmpeg() {
            return;
        }
        let sq = "color=c=white:s=10x10";
        let fx = |e: Effect| Look { effects: vec![e], ..Default::default() };
        let px = |g: &[u8], x: usize, y: usize| [g[(y * 64 + x) * 3], g[(y * 64 + x) * 3 + 1], g[(y * 64 + x) * 3 + 2]];
        // 縁取り（赤 4px）：四角（x = 27〜37）の右 2px は赤
        let a = shot_rgb(sq, fx(Effect::Outline { color: "#ff0000".into(), width: 4.0 }), 0.1);
        assert!(px(&a, 39, 18)[0] > 200 && px(&a, 39, 18)[1] < 60 && px(&a, 32, 18)[1] > 200, "{:?}", px(&a, 39, 18));
        // 影（赤・右へ 8px・ぼかしなし）
        let b = shot_rgb(sq, fx(Effect::Shadow { color: "#ff0000".into(), blur: 0.0, x: 8.0, y: 0.0, opacity: 1.0 }), 0.1);
        assert!(px(&b, 42, 18)[0] > 200 && px(&b, 42, 18)[1] < 60 && px(&b, 46, 18)[0] < 30, "{:?}", px(&b, 42, 18));
        // 発光（赤・広がり 3px）：すぐ外は赤みがかる
        let c = shot_rgb(sq, fx(Effect::Glow { color: "#ff0000".into(), blur: 3.0, strength: 2.0 }), 0.1);
        assert!(px(&c, 38, 18)[0] > 35 && px(&c, 38, 18)[1] < 30 && px(&c, 39, 18)[0] > 25, "{:?} {:?}", px(&c, 38, 18), px(&c, 39, 18));
        // 点滅（1 秒に 1 回）：0.1 秒は見え、0.6 秒は見えない
        let d1 = shot_look(sq, fx(Effect::Blink { speed: 1.0 }), Transform::default(), 0.1);
        let d2 = shot_look(sq, fx(Effect::Blink { speed: 1.0 }), Transform::default(), 0.6);
        assert!(d1[18 * 64 + 32] > 200 && d2[18 * 64 + 32] < 30);
        // 色ずれ 3px：右の外は赤、左の外は青
        let e = shot_rgb(sq, fx(Effect::RgbShift { amount: 3.0 }), 0.1);
        let (r, l) = (px(&e, 38, 18), px(&e, 25, 18));
        assert!(r[0] > r[1] + 80 && r[0] > r[2] + 80 && l[2] > l[0] + 80 && l[2] > l[1] + 80, "{r:?} {l:?}");
        // 方向ブラー（横 10px）：右の端のすぐ外が半端な明るさ
        let f = shot_look(sq, fx(Effect::DirBlur { length: 10.0, angle: 0.0 }), Transform::default(), 0.1);
        assert!((40..220).contains(&f[18 * 64 + 38]) && f[18 * 64 + 31] > 200, "{:?}", &f[18 * 64..19 * 64]);
        // 二値化（0.5）：40% の灰色は黒、60% は白
        let g1 = shot_look("color=c=0x666666:s=10x10", fx(Effect::Threshold { level: 0.5 }), Transform::default(), 0.1);
        let g2 = shot_look("color=c=0x999999:s=10x10", fx(Effect::Threshold { level: 0.5 }), Transform::default(), 0.1);
        assert!(g1[18 * 64 + 32] < 30 && g2[18 * 64 + 32] > 220, "{} {} {:?}", g1[18 * 64 + 32], g2[18 * 64 + 32], &g1[18 * 64..19 * 64]);
        // 放射ブラー・ノイズ・グリッチは掛かる（元と変わる）
        let half = "nullsrc=s=40x20,geq=lum='if(lt(X,20),235,16)':cb=128:cr=128";
        let plain = shot_look(half, Look::default(), Transform::default(), 0.1);
        for e in [Effect::RadialBlur { amount: 0.5 }, Effect::Noise { amount: 0.5 }, Effect::Glitch { amount: 8.0, band: 2.0, speed: 10.0 }] {
            let h = shot_look(half, fx(e.clone()), Transform::default(), 0.1);
            assert!(h != plain, "{e:?}");
        }
        // 反復移動（横 10px・1 秒に 0.25 回）：1 秒で右に 10px
        let o = shot_look("color=c=white:s=4x4", fx(Effect::Oscillate { x: 10.0, y: 0.0, speed: 0.25 }), Transform::default(), 1.0);
        assert!(o[18 * 64 + 42] > 200 && o[18 * 64 + 32] < 30);
        // ランダム移動：jitter_at と同じだけずれる
        let (jx, jy) = crate::model::jitter_at(10.0, 2.0, 1.0);
        let j = shot_look("color=c=white:s=2x2", fx(Effect::Jitter { amount: 10.0, speed: 2.0 }), Transform::default(), 1.0);
        let at = (31.0 + jx).round() as usize + 1 + ((18.0 + jy - 1.0).round() as usize) * 64;
        assert!(j[at] > 100, "{jx} {jy}");
    }

    /// 残像：前の時点の位置に、だんだん薄く重なる
    #[test]
    fn trail_behind() {
        if !has_ffmpeg() {
            return;
        }
        // 3 秒で x = −30 → 170（1 秒 66.7px）。0.6 秒の本体は x = 10、0.2 秒前（6 フレーム）は −3.3、0.4 秒前は −16.7
        let look = Look {
            anim: Some(Anim { to: Transform { x: 170.0, ..Default::default() }, rotation: 0.0, ease: Ease::Linear, mid: None, keys: vec![], rot3d: None }),
            effects: vec![Effect::Trail { count: 2, interval: 6 }],
            ..Default::default()
        };
        let g = shot_look("color=c=white:s=4x4", look, Transform { x: -30.0, ..Default::default() }, 0.6);
        let v = |x: usize| g[18 * 64 + x];
        assert!(v(42) > 220 && (140..200).contains(&v(29)) && (60..110).contains(&v(15)), "{} {} {}", v(42), v(29), v(15));
    }

    /// モザイク・ぼかし範囲：図形の中だけ下の絵がモザイク・ぼかしになり、外は変わらない
    #[test]
    fn region_mosaic_and_blur() {
        use crate::model::{Clip, Region, RegionKind};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        // 下の絵：1px ごとの白黒の縞
        let src = d.path().join("st.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=64x36,geq=lum='if(mod(X,2),235,16)':cb=128:cr=128", "-frames:v", "1"]).arg(&src).status().unwrap().success());
        // 範囲の形（左半分の四角。色は使わない）
        let shape = d.path().join("sh.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=32x36", "-frames:v", "1"]).arg(&shape).status().unwrap().success());
        for kind in [RegionKind::Mosaic, RegionKind::Blur] {
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
            p.clips.clear();
            p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 10, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: Default::default() }) });
            let v2 = p.tracks.iter().find(|t| t.kind == crate::model::TrackKind::Video && t.id != "V1").map(|t| t.id.clone()).unwrap_or_else(|| "V2".into());
            p.clips.push(Clip { id: "r".into(), track_id: v2, start: 0, duration: 10, link_id: None, body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: 32.0, height: 36.0, fill: "#f00".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform { x: -16.0, ..Default::default() }, look: Look::default(), region: Some(Region { kind, strength: 4.0 }) }) });
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            opt.still_at = Some(0.1);
            opt.item_images.insert("r".into(), shape.clone());
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let img = std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap().stdout;
            let row = |x0: usize, x1: usize| (x0..x1).map(|x| img[18 * 64 + x] as i32).collect::<Vec<_>>();
            let spread = |v: &[i32]| v.iter().max().unwrap() - v.iter().min().unwrap();
            assert!(spread(&row(4, 28)) < 40, "{kind:?} 範囲の中は縞が消える {:?}", row(4, 28));
            assert!(spread(&row(40, 60)) > 150, "{kind:?} 外は縞のまま {:?}", row(40, 60));
            assert!(img.iter().any(|&v| v > 200) && !row(4, 28).iter().any(|&v| v > 200), "{kind:?} 図形の色（赤）は出ない");
        }
    }

    /// なめらかスロー：4 分の 1 の速さでも、コマごとに絵が動く（くり返しにならない）
    #[test]
    fn smooth_slow_motion_makes_new_frames() {
        use crate::model::{Clip, SourceFx};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("mv.mp4");
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=30:d=2", "-f", "lavfi", "-i", "color=c=white:s=12x12:r=30:d=2", "-filter_complex", "[0][1]overlay=x='2+t*120':y=10", "-c:v", "libx264", "-g", "1", "-pix_fmt", "yuv420p"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let run = |smooth: bool| -> usize {
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
            p.clips.clear();
            let fx = SourceFx { speed: 0.25, smooth, ..Default::default() };
            p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 24, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Video, has_audio: false, in_point: 0, volume: 1.0, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: fx }) });
            let out = d.path().join(format!("o{smooth}.mp4"));
            let opt = ExportOptions::new("ffmpeg", &out, d.path());
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let raw = std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap().stdout;
            let fr: Vec<&[u8]> = raw.chunks(64 * 36).collect();
            // となりのコマと見た目が変わった数
            fr.windows(2).filter(|w| w[0].iter().zip(w[1]).map(|(a, b)| (*a as i32 - *b as i32).abs()).sum::<i32>() > 400).count()
        };
        let (plain, smooth) = (run(false), run(true));
        assert!(plain <= 8, "ふつうは 4 コマずつ同じ {plain}");
        assert!(smooth >= 14 && smooth > plain * 2, "なめらかならほぼ毎コマ動く {smooth} / {plain}");
    }

    /// GIF：範囲だけを、コマ数を落として、繰り返す GIF にする
    #[test]
    fn gif_export() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let mut p = Project::sample();
        (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
        p.clips.clear();
        let src = d.path().join("c.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1"]).arg(&src).status().unwrap().success());
        p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 60, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: Default::default() }) });
        let out = d.path().join("o.gif");
        let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
        opt.range = Some((0.5, 1.5));
        let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
        assert!(!args.iter().any(|a| a == "[aout]"), "音は使わない");
        let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let pr = std::process::Command::new("ffprobe").args(["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,nb_read_frames,width", "-of", "csv=p=0"]).arg(&out).output().unwrap();
        let s = String::from_utf8_lossy(&pr.stdout);
        assert!(s.starts_with("gif,64,"), "{s}");
        let n: i32 = s.trim().rsplit(',').next().unwrap().parse().unwrap();
        assert!((n - 15).abs() <= 1, "1 秒 × 15 コマ: {n}");
    }

    /// LUT：書き出しでは .cube のとおりに色が変わり、強さで元の色と混ざる
    #[test]
    fn lut_changes_colors() {
        use crate::model::{Clip, Effect};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("c.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x33b266:s=16x16", "-frames:v", "1"]).arg(&src).status().unwrap().success());
        let cube = d.path().join("swap it.cube");
        std::fs::write(&cube, crate::lut::sample_cube(9, |c| [c[1], c[0], c[2]])).unwrap();
        for (strength, want) in [(1.0, [0xb2, 0x33, 0x66]), (0.5, [0x72, 0x72, 0x66])] {
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (16, 16, 30);
            p.clips.clear();
            let look = Look { effects: vec![Effect::Lut { path: cube.to_string_lossy().into_owned(), strength }], ..Default::default() };
            p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 10, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform::default(), look, audio_frames: None, src_fx: Default::default() }) });
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            opt.still_at = Some(0.1);
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let img = std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout;
            let c = &img[(8 * 16 + 8) * 3..(8 * 16 + 8) * 3 + 3];
            for k in 0..3 {
                assert!((c[k] as i32 - want[k]).abs() < 8, "強さ {strength} ch{k}: {c:?} / {want:?}");
            }
        }
    }

    /// 合成モード：下の絵と式どおりに混ざり、不透明度の分だけ効く。アイテムの外は変わらない
    #[test]
    fn blend_modes_mix_with_what_is_below() {
        use crate::model::{BlendMode, Clip};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("b.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x2060c0:s=20x20", "-frames:v", "1"]).arg(&src).status().unwrap().success());
        // (下, 上) → 期待値（canvas の式。α = 0.5）
        let f = |m: BlendMode, b: f64, s: f64| -> f64 {
            let (b, s) = (b / 255.0, s / 255.0);
            let hard = |b: f64, s: f64| if s <= 0.5 { 2.0 * b * s } else { 1.0 - 2.0 * (1.0 - b) * (1.0 - s) };
            let v = match m {
                BlendMode::Multiply => b * s,
                BlendMode::Screen => 1.0 - (1.0 - b) * (1.0 - s),
                BlendMode::Overlay => hard(s, b),
                BlendMode::Darken => b.min(s),
                BlendMode::Lighten => b.max(s),
                BlendMode::HardLight => hard(b, s),
                BlendMode::Difference => (b - s).abs(),
                BlendMode::Add => (b + s).min(1.0),
            };
            (0.5 * b + 0.5 * v) * 255.0
        };
        for m in [BlendMode::Multiply, BlendMode::Screen, BlendMode::Overlay, BlendMode::Darken, BlendMode::Lighten, BlendMode::HardLight, BlendMode::Difference, BlendMode::Add] {
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
            p.video.background = "#a04020".into();
            p.clips.clear();
            let look = Look { blend: Some(m), ..Default::default() };
            p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 10, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform { opacity: 0.5, ..Default::default() }, look, audio_frames: None, src_fx: Default::default() }) });
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            opt.still_at = Some(0.1);
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let img = std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout;
            let px = |x: usize, y: usize| [img[(y * 64 + x) * 3] as f64, img[(y * 64 + x) * 3 + 1] as f64, img[(y * 64 + x) * 3 + 2] as f64];
            let bg = px(2, 2);
            assert!((bg[0] - 160.0).abs() < 6.0 && (bg[1] - 64.0).abs() < 6.0, "{m:?} 外は下の絵のまま {bg:?}");
            let c = px(32, 18);
            for (i, (b, s)) in [(160.0, 32.0), (64.0, 96.0), (32.0, 192.0)].into_iter().enumerate() {
                let want = f(m, b, s);
                assert!((c[i] - want).abs() < 8.0, "{m:?} ch{i}: {} / {want}", c[i]);
            }
        }
    }

    /// 背景を消す型：白いところだけ残り、黒いところは背景になる（型は小さくても素材の大きさに合う）
    #[test]
    fn matte_keeps_only_the_white_part() {
        use crate::model::{Clip, SourceFx};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("r.png");
        let mk = d.path().join("m.png");
        let ff = |args: &[&str], out: &std::path::Path| assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y"]).args(args).arg(out).status().unwrap().success());
        ff(&["-f", "lavfi", "-i", "color=c=0xff0000:s=64x36", "-frames:v", "1"], &src);
        ff(&["-f", "lavfi", "-i", "color=c=black:s=32x18,drawbox=x=0:y=0:w=16:h=18:c=white:t=fill", "-frames:v", "1", "-pix_fmt", "gray"], &mk);
        let mut p = Project::sample();
        (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
        p.video.background = "#000000".into();
        p.clips.clear();
        let fx = SourceFx { matte: Some("matte-fast".into()), ..Default::default() };
        p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 10, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: fx }) });
        let out = d.path().join("o.png");
        let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
        opt.still_at = Some(0.1);
        // 型がないと分かりやすく止まる
        assert!(build_args(&p, &|_: &str| None, &[], &[], &opt).is_err());
        opt.mattes.insert(src.to_string_lossy().into_owned(), mk.clone());
        let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
        let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let img = std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout;
        let r = |x: usize| img[(18 * 64 + x) * 3];
        assert!(r(10) > 200, "左は残る {}", r(10));
        assert!(r(54) < 30, "右は消える {}", r(54));
    }

    /// フィルター・色温度・背景をぼかして埋める：実際に ffmpeg で書き出して色を見る（画面の SVG フィルターと同じ数）
    #[test]
    fn grade_temperature_fill_blur() {
        use crate::model::{Clip, Effect, Look, SourceFx};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let run = |color: &str, w: u32, fx: SourceFx, effects: Vec<Effect>| -> Vec<u8> {
            let src = d.path().join(format!("s{w}.png"));
            assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("color=c={color}:s={w}x36"), "-frames:v", "1"]).arg(&src).status().unwrap().success());
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
            p.video.background = "#000000".into();
            p.clips.clear();
            let look = Look { effects, ..Default::default() };
            p.clips.push(Clip { id: "m".into(), track_id: "V1".into(), start: 0, duration: 10, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform::default(), look, audio_frames: None, src_fx: fx }) });
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            opt.still_at = Some(0.1);
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout
        };
        let px = |img: &[u8], x: usize, y: usize| { let i = (y * 64 + x) * 3; (img[i] as i32, img[i + 1] as i32, img[i + 2] as i32) };
        // 白黒のフィルター：赤が灰色になる
        let (r, g, b) = px(&run("0xff0000", 64, SourceFx::default(), vec![Effect::Grade { name: "noir".into(), strength: 1.0 }]), 32, 18);
        assert!((r - g).abs() < 12 && (g - b).abs() < 12, "{r} {g} {b}");
        // 強さ 0 なら元のまま
        let (r, g, _) = px(&run("0xff0000", 64, SourceFx::default(), vec![Effect::Grade { name: "noir".into(), strength: 0.0 }]), 32, 18);
        assert!(r > 230 && g < 25, "{r} {g}");
        // あたたかい色温度：灰色の赤が増えて青が減る
        let (r, _, b) = px(&run("0x808080", 64, SourceFx::default(), vec![Effect::Temperature { warm: 1.0, tint: 0.0 }]), 32, 18);
        assert!(r > b + 30, "{r} {b}");
        // 細い素材：そのままだと左端は背景の黒、埋めると素材の色
        assert!(px(&run("0xff0000", 16, SourceFx::default(), vec![]), 2, 18).0 < 30);
        assert!(px(&run("0xff0000", 16, SourceFx { fill_blur: Some(20.0), ..Default::default() }, vec![]), 2, 18).0 > 150);
    }

    /// 音の加工を付けた音声素材も、書き出しの ffmpeg がそのまま通る（ロボット・やまびこ・速さと逆再生と一緒に）
    #[test]
    fn audio_fx_exports() {
        use crate::audiofx::{MediaAudioFx, VoiceFx};
        use crate::model::{Clip, SourceFx};
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("s.wav");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3"]).arg(&src).status().unwrap().success());
        let mut p = Project::sample();
        p.clips.clear();
        for (i, v) in [VoiceFx::Robot, VoiceFx::Echo, VoiceFx::High].into_iter().enumerate() {
            let fx = SourceFx { speed: 1.5, reverse: i == 1, audio_fx: Some(MediaAudioFx { denoise: true, voice: Some(v), gain_db: Some(-3.0) }), ..Default::default() };
            p.clips.push(Clip { id: format!("a{i}"), track_id: "A1".into(), start: i as Frame * 40, duration: 30, link_id: None, body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Audio, has_audio: true, in_point: 0, volume: 1.0, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: fx }) });
        }
        if !p.tracks.iter().any(|t| t.id == "A1") {
            let mut t = p.tracks[0].clone();
            t.id = "A1".into();
            p.tracks.push(t);
        }
        let out = d.path().join("o.wav");
        let opt = ExportOptions::new("ffmpeg", &out, d.path());
        let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
        let g = args.join(" ");
        assert!(g.contains("afftfilt") && g.contains("aecho") && g.contains("areverse") && g.contains("atrim=0:1.000"), "{g}");
        let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    }

    /// キーフレーム：何点でも、通る順に入れ子の式になる（画面の animStateAt と同じ値）
    #[test]
    fn keyframes_nest_in_order() {
        let e = tween3(0.0, &[(0.25, 100.0), (0.5, -40.0)], 60.0, Ease::Linear, "t", 2.0);
        assert_eq!(e.matches("if(lt(").count(), 2, "{e}");
        assert!(e.starts_with("if(lt(clip(t/2.0000,0,1),0.2500),0.0000+(100.0000)*"), "{e}");
        // ffmpeg の式として評価して、点と点の間の値を確かめる（0.75 秒 = 37.5% → -40 と 100 の真ん中の 30）
        let ev = |t: f64| {
            let p = (t / 2.0f64).clamp(0.0, 1.0);
            let pts = [(0.0, 0.0), (0.25, 100.0), (0.5, -40.0), (1.0, 60.0)];
            let i = pts.windows(2).position(|w| p < w[1].0).unwrap_or(2);
            let (a, b) = (pts[i], pts[i + 1]);
            a.1 + (b.1 - a.1) * ((p - a.0) / (b.0 - a.0))
        };
        assert!((ev(0.75) - 30.0).abs() < 1e-9);
        let a = crate::model::Anim { to: Transform::default(), rotation: 0.0, ease: Ease::Linear, mid: Some(crate::model::AnimMid { at: 0.5, transform: Transform::default(), rotation: 0.0 }), keys: vec![crate::model::AnimMid { at: 0.2, transform: Transform::default(), rotation: 0.0 }, crate::model::AnimMid { at: 0.5, transform: Transform::default(), rotation: 1.0 }], rot3d: None };
        assert_eq!(a.waypoints().iter().map(|k| k.at).collect::<Vec<_>>(), vec![0.2, 0.5]);
    }

    #[test]
    fn mid_point_enter_exit_and_still() {
        use crate::model::{Anim, AnimMid, Clip, Ease, Look, Motion, MotionKind, TextClip};
        let mut p = Project::sample();
        p.video.width = 320;
        p.video.height = 180;
        p.clips.retain(|c| c.as_voice().is_none());
        p.clips.push(Clip {
            id: "t1".into(),
            track_id: "V6".into(),
            start: 0,
            duration: 60,
            link_id: None,
            body: ClipBody::Text(TextClip {
                text: "x".into(),
                transform: Transform::default(),
                look: Look {
                    anim: Some(Anim {
                        to: Transform { x: 100.0, ..Default::default() },
                        rotation: 0.0,
                        ease: Ease::Linear,
                        mid: Some(AnimMid { at: 0.5, transform: Transform { x: -50.0, y: 40.0, scale: 1.5, opacity: 1.0 }, rotation: 0.0 }),
                        keys: vec![],
                        rot3d: None,
                    }),
                    enter: Some(Motion { kind: MotionKind::SlideLeft, frames: 10, smooth: false }),
                    exit: Some(Motion { kind: MotionKind::Zoom, frames: 10, smooth: false }),
                    ..Default::default()
                },
                ..serde_json::from_str(r##"{"text":"","fontFamily":"a","fontSize":10,"color":"#fff","outlineColor":"#000","outlineWidth":0}"##).unwrap()
            }),
        });
        let d = tempfile::tempdir().unwrap();
        let png = d.path().join("t.png");
        let out = d.path().join("still.png");
        let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
        opt.item_images.insert("t1".into(), png.clone());
        opt.still_at = Some(1.0);
        let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
        let g = args.join(" ");
        // 途中を通る式（前半・後半）、左から入るずれ、退場で小さくなる倍率
        assert!(g.contains("if(lt(clip((t-0.000)/2.0000,0,1),0.5000),0.0000+(-50.0000)*"), "{g}");
        assert!(g.contains("-W*pow(1-clip((t-0.000)/0.3333,0,1),2)"), "{g}");
        assert!(g.contains("*(1-pow(clip((t-1.6667)/0.3333,0,1),2))"), "{g}");
        assert!(g.contains("-frames:v 1") && !g.contains("[aout]"), "{g}");
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red@0.8:s=120x60,format=rgba", "-frames:v", "1", png.to_str().unwrap()])
            .status()
            .unwrap()
            .success());
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
