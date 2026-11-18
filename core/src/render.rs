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
    /// 背景を透明のまま書き出す（.mov は ProRes 4444、.webm は VP9。背景の色は塗らない）
    pub transparent: bool,
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
            transparent: false,
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
    /// 呼吸（足もとを止めて縦に伸び縮み）
    pub breath: Option<crate::model::Breath>,
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
    // 最後まで行ったら頭に戻ってくり返す（粒）
    let mut looping = std::collections::HashSet::new();
    for c in &p.clips {
        // 1 文字ずつ出すテキスト：画面側がコマごとの画像を用意する（1 コマずつ。最後の画像は終わりまで）
        let step = match &c.body {
            // タイマー：表示が変わるごとの画像（100 分の 1 秒まで出すときは毎コマ、ほかは 1 秒ごと）
            ClipBody::Text(t) if t.deco.timer.is_some() => t.deco.timer.as_ref().map(|x| x.step(p.video.fps)).unwrap_or(1),
            ClipBody::Text(t) if t.deco.char_anim.is_some() => 1,
            ClipBody::Shape(sh) if sh.anim.is_some() => {
                let (step, looped) = sh.anim.as_ref().map(|a| a.sequence(sh.width, c.duration)).unwrap_or((1, false));
                if looped {
                    looping.insert(c.id.clone());
                }
                step
            }
            _ => match p.line_of_subtitle(c).and_then(|v| v.subtitle_custom.as_deref()) {
                Some(sc) if sc.interval > 0 => sc.interval,
                _ => continue,
            },
        };
        let frames: Vec<&PathBuf> = (1..).map_while(|k| images.get(&format!("{}#{k}", c.id))).collect();
        if frames.is_empty() {
            continue;
        }
        let mut list = String::from("ffconcat version 1.0\n");
        let mut used = 0;
        let mut last = frames[0];
        let looped = looping.contains(&c.id);
        let mut k = 0usize;
        loop {
            let left = c.duration - used;
            if left <= 0 {
                break;
            }
            let img = frames[k % frames.len()];
            // 最後の画像はクリップの終わりまで（くり返すときは頭に戻る）
            let n = if !looped && k + 1 == frames.len() { left } else { step.min(left) };
            list.push_str(&format!("file {}\nduration {:.6}\n", concat_quote(img), n as f64 / fps));
            used += n;
            last = img;
            k += 1;
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

/// 素材の音のフェード（クリップの頭・終わりから。dur は鳴らす長さの秒）。プレビューの playback.ts の soundFadeGain と同じ直線
fn sound_fades(fx: &crate::model::SourceFx, dur: f64, fps: u32) -> String {
    let mut f = String::new();
    if fx.sound_fade_in > 0 {
        f.push_str(&format!(",afade=t=in:st=0:d={:.3}", fx.sound_fade_in as f64 / fps as f64));
    }
    if fx.sound_fade_out > 0 {
        let d = (fx.sound_fade_out as f64 / fps as f64).min(dur);
        f.push_str(&format!(",afade=t=out:st={:.3}:d={d:.3}", (dur - d).max(0.0)));
    }
    f
}

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
            out.push(PortraitInput { concat, transform: pc.transform.clone(), track: item.track_id.clone(), only: Some(only), fx, breath: pt.breath.clone().filter(|b| b.amount > 0.0) });
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
    let r = build_args_inner(p, voice_wav, portraits, captions, opt);
    KEEP_ALPHA.with(|k| k.set(false));
    r
}

/// 字幕（ASS）を重ねる。透明のまま書き出すときは、黒と白の上に描いた差から透明度を求めて重ねる（透明な画面には ass が描けないので）
fn push_ass(fc: &mut Vec<String>, last_v: &mut String, sub_n: &mut usize, a: &Path, v: &crate::model::VideoSettings, total_s: f64, transparent: bool) {
    let l = format!("sub{}", *sub_n);
    let n = *sub_n;
    *sub_n += 1;
    let path = escape_filter_path(a);
    if !transparent {
        fc.push(format!("[{last_v}]ass={path}[{l}]"));
    } else {
        let src = |c: &str| format!("color=c={c}:s={}x{}:r={}:d={total_s:.3},format=rgb24,ass={path},format=gbrp", v.width, v.height, v.fps);
        let col = "'if(gt(255-(y-x),0),min(255,x*255/(255-(y-x))),0)'";
        fc.push(format!("{},split[sk{n}a][sk{n}b]", src("black")));
        fc.push(format!("{},split[sw{n}a][sw{n}b]", src("white")));
        fc.push(format!("[sk{n}a]extractplanes=g[skg{n}];[sw{n}a]extractplanes=g[swg{n}];[skg{n}][swg{n}]lut2=c0='255-(y-x)'[sal{n}]"));
        fc.push(format!("[sk{n}b][sw{n}b]lut2=c0={col}:c1={col}:c2={col}[scl{n}];[scl{n}][sal{n}]alphamerge,format=rgba[sly{n}]"));
        fc.push(format!("[{last_v}][sly{n}]overlay=0:0:eof_action=pass:format=auto[{l}]"));
    }
    *last_v = l;
}

#[allow(clippy::too_many_lines)]
fn build_args_inner(
    p: &Project,
    voice_wav: &dyn Fn(&str) -> Option<PathBuf>,
    portraits: &[PortraitInput],
    captions: &[(String, PathBuf)],
    opt: &ExportOptions,
) -> Result<Vec<String>> {
    // シーンアイテムはシーンのレイヤーとグループ制御に、つなぎ目の切り替えは前後のアイテムの登場・退場・フェードと覆う図形に置き換えて描く
    let owned = p.with_scenes().with_transitions();
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
        if opt.transparent {
            format!("color=c=black@0:s={}x{}:r={}:d={total_s:.3},format=rgba", v.width, v.height, v.fps)
        } else {
            format!("color=c={}:s={}x{}:r={}:d={:.3}", hex_color(&v.background), v.width, v.height, v.fps, total_s)
        },
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
        // 呼吸：高さだけをコマごとに変える（足もとは下の y の式で止める）
        let breath = pi.breath.as_ref().map(|b| format!(",scale=w=iw:h='max(2,trunc(ih*{}/2)*2)':eval=frame", b.ffmpeg_expr())).unwrap_or_default();
        fc.push(format!("[{i}:v]fps={},scale=iw*{s:.4}:ih*{s:.4},format=rgba,colorchannelmixer=aa={o:.3}{fx}{breath}[{src_l}]", v.fps, s = t.scale, o = t.opacity.clamp(0.0, 1.0)));
        let out_l = format!("ov{i}");
        // 喋っているときだけ表示する立ち絵は、その区間だけ重ねる
        let enable = match &pi.only {
            Some(iv) => format!(":enable='{}'", iv.iter().map(|(a, b)| format!("between(t,{a:.3},{:.3})", b - 0.0005)).collect::<Vec<_>>().join("+")),
            None => String::new(),
        };
        // 呼吸で伸ばしたときは、伸ばす前の高さ（h ÷ 倍率）の下端に合わせる
        let ytop = match &pi.breath {
            Some(b) => format!("(H+h/{e})/2-h", e = b.ffmpeg_expr()),
            None => "(H-h)/2".into(),
        };
        let pos = if dx.is_empty() && pi.breath.is_none() {
            format!("x=(W-w)/2+{x:.1}:y=(H-h)/2+{y:.1}", x = t.x, y = t.y)
        } else {
            format!("x='(W-w)/2+{x:.1}{dx}':y='{ytop}+{y:.1}{dy}'", x = t.x, y = t.y)
        };
        fc.push(format!("[{last_v}][{src_l}]overlay={pos}:eof_action=pass{enable}{}[{out_l}]", ov_fmt()));
        *last_v = out_l;
        *idx += 1;
    };
    let mut sub_n = 0;
    // グループ制御・カメラ：まとめるレイヤーは透明な画面に重ねてから、まとめて動かす
    let groups = group_ranges(p);
    let mut saved: Vec<String> = vec![];
    let mut uid = 0usize;
    let mut deferred_ass: Vec<PathBuf> = vec![];
    // 音声の波形・スペクトラムに渡す音（最後に混ぜた音を分けて渡す）
    let mut viz_labels: Vec<String> = vec![];
    let transparent = opt.transparent;
    let reset_alpha = |depth: usize| KEEP_ALPHA.with(|k| k.set(depth > 0 || transparent));
    reset_alpha(0);
    // 映像は V1 から順に（後ろのトラックほど手前）。音声トラックは音だけ
    for (ti, track) in p.tracks.iter().enumerate() {
        // このレイヤーのグループ制御：まとめた絵を、グループの時間の外はそのまま、中はアイテムの動きで重ねる
        if let Some((_, _, cs)) = groups.iter().find(|g| g.1 == ti) {
            if let Some(main) = saved.pop() {
                reset_alpha(saved.len());
                let l = std::mem::replace(&mut last_v, main);
                let outs: String = (0..=cs.len()).map(|k| format!("[gl{ti}s{k}]")).collect();
                fc.push(format!("[{l}]split={}{outs}", cs.len() + 1));
                let off: Vec<String> = cs.iter().map(|c| format!("between(t,{:.3},{:.3})", v.frames_to_secs(c.start), v.frames_to_secs(c.end()) - 0.0005)).collect();
                fc.push(format!("[{last_v}][gl{ti}s0]overlay=0:0:enable='not({})':eof_action=pass{}[gm{ti}]", off.join("+"), ov_fmt()));
                last_v = format!("gm{ti}");
                for (k, c) in cs.iter().enumerate() {
                    let ClipBody::Shape(sh) = &c.body else { continue };
                    let (start, dur) = (v.frames_to_secs(c.start), v.frames_to_secs(c.duration));
                    let (tr, lk) = if control_of(c).is_some_and(|x| x.kind == crate::model::ControlKind::Camera) { crate::model::camera_view(&sh.transform, &sh.look) } else { (sh.transform.clone(), sh.look.clone()) };
                    fc.push(format!("[gl{ti}s{}]trim=start={start:.3}:end={:.3},setpts=PTS-STARTPTS[gt{ti}s{k}]", k + 1, start + dur));
                    uid += 1;
                    last_v = visual_filters(&mut fc, 90000 + uid, &format!("gt{ti}s{k}"), &last_v, v.fps, &tr, &lk, start, dur);
                }
                if saved.is_empty() {
                    for a in deferred_ass.drain(..) {
                        push_ass(&mut fc, &mut last_v, &mut sub_n, &a, v, total_s, transparent);
                    }
                }
            }
        }
        // ここから上のグループにまとめるレイヤー：透明な画面に重ねはじめる（外側のグループから）
        let mut opening: Vec<&(usize, usize, Vec<&crate::model::Clip>)> = groups.iter().filter(|g| g.0 == ti).collect();
        opening.sort_by_key(|g| std::cmp::Reverse(g.1));
        for _ in opening {
            push_input(&mut args, vec!["-f".into(), "lavfi".into()], format!("color=c=black@0:s={}x{}:r={}:d={total_s:.3},format=rgba", v.width, v.height, v.fps));
            saved.push(std::mem::replace(&mut last_v, format!("{idx}:v")));
            idx += 1;
            reset_alpha(saved.len());
        }
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
                // 音声の波形・スペクトラム：できあがった音（最後に混ぜる音を分けたもの）を描いて、図形と同じように置く
                ClipBody::Shape(ShapeClip { viz: Some(vz), width, height, fill, transform, look, .. }) => {
                    let n = viz_labels.len();
                    viz_labels.push(format!("vz{n}"));
                    let (w, h) = ((width.round().max(2.0) as u32).div_ceil(2) * 2, (height.round().max(2.0) as u32).div_ceil(2) * 2);
                    let col = format!("{0}|{0}", hex_color(fill));
                    let f = match vz {
                        crate::model::AudioViz::Wave => format!("showwaves=s={w}x{h}:mode=cline:rate={}:colors={col}:scale=sqrt:draw=full", v.fps),
                        crate::model::AudioViz::Bars => format!("showfreqs=s={w}x{h}:mode=bar:fscale=log:ascale=sqrt:colors={col},fps={}", v.fps),
                    };
                    fc.push(format!("[vz{n}]{f},format=rgba,trim=start={start:.3}:end={:.3},setpts=PTS-STARTPTS[vzv{n}]", start + dur));
                    uid += 1;
                    last_v = visual_filters(&mut fc, 90000 + uid, &format!("vzv{n}"), &last_v, v.fps, transform, look, start, dur);
                }
                // 調整レイヤー：それまでに描いた絵に、このアイテムのエフェクト・不透明度・フェードを掛けて重ねる
                ClipBody::Shape(ShapeClip { transform, look, control: Some(ctl), .. }) => {
                    if ctl.kind == crate::model::ControlKind::Adjust {
                        uid += 1;
                        let u = 90000 + uid;
                        fc.push(format!("[{last_v}]split[ad{u}a][ad{u}b]"));
                        fc.push(format!("[ad{u}b]trim=start={start:.3}:end={:.3},setpts=PTS-STARTPTS[ad{u}c]", start + dur));
                        let lk = Look { effects: look.effects.clone(), fade_in: look.fade_in, fade_out: look.fade_out, blend: look.blend, ..Default::default() };
                        let tr = Transform { opacity: transform.opacity, ..Default::default() };
                        last_v = visual_filters(&mut fc, u, &format!("ad{u}c"), &format!("ad{u}a"), v.fps, &tr, &lk, start, dur);
                    }
                }
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
                    // テキスト・図形は画面側で描いた画像を、静止画と同じように重ねる（1 文字ずつ出すテキストは、コマごとの画像を並べる）
                    if let Some(seq) = opt.item_sequences.get(&c.id) {
                        args.extend(["-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), seq.to_string_lossy().into_owned()]);
                    } else {
                        let Some(img) = opt.item_images.get(&c.id) else {
                            return Err(Error::Other(format!("アイテム {} の画像が用意されていません", c.id)));
                        };
                        push_input(
                            &mut args,
                            vec!["-loop".into(), "1".into(), "-framerate".into(), v.fps.to_string(), "-t".into(), format!("{dur:.3}")],
                            img.to_string_lossy().into_owned(),
                        );
                    }
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
                                let fades = sound_fades(fx, dur, v.fps);
                                fc.push(format!("[{idx}:a]{apre}aresample={}{fades},adelay=delays={delay_ms}:all=1,volume={:.3}{duck}[{l}]", v.sample_rate, m.volume));
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
                                let fades = sound_fades(fx, m.audio_frames.map(|f| v.frames_to_secs(f)).unwrap_or(dur), v.fps);
                                fc.push(format!("[{idx}:a]{apre}{cut}aresample={}{fades},adelay=delays={delay_ms}:all=1,volume={:.3}{duck}[{l}]", v.sample_rate, m.volume));
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
                                    fc.push(format!("[{last_v}][fg{idx}]overlay=0:0:enable='between(t,{start:.3},{:.3})':eof_action=pass{}[fo{idx}]", start + dur, ov_fmt()));
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
                // まとめている間の字幕は、まとめた絵を重ねたあとに出す（透明な画面には描けないので。カメラでも字幕は動かない）
                if !saved.is_empty() {
                    deferred_ass.push(a.clone());
                } else {
                    push_ass(&mut fc, &mut last_v, &mut sub_n, a, v, total_s, transparent);
                }
            }
        }
    }
    // 閉じていないまとめ（ないはず）は、そのまま重ねる
    while let Some(main) = saved.pop() {
        reset_alpha(saved.len());
        let l = std::mem::replace(&mut last_v, main);
        fc.push(format!("[{last_v}][{l}]overlay=0:0:eof_action=pass{}[gx{}]", ov_fmt(), saved.len()));
        last_v = format!("gx{}", saved.len());
    }
    reset_alpha(0);
    for a in deferred_ass.drain(..) {
        push_ass(&mut fc, &mut last_v, &mut sub_n, &a, v, total_s, transparent);
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
    // 静止画・GIF は音を混ぜないので、波形・スペクトラムには無音を渡す
    let still_like = (gif || opt.still_at.is_some()) && !audio_only;
    if still_like && !viz_labels.is_empty() {
        let outs: String = viz_labels.iter().map(|l| format!("[{l}]")).collect();
        fc.push(format!("anullsrc=r={}:cl=stereo,atrim=0:{total_s:.3},asplit={}{outs}", v.sample_rate, viz_labels.len()));
    }
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
    // 音声（なければ無音）。波形・スペクトラムがあれば、混ぜた音を分けて渡す
    let mix_out = if viz_labels.is_empty() { "aout".to_string() } else { "amixed".to_string() };
    if audio_labels.is_empty() {
        fc.push(format!("anullsrc=r={}:cl=stereo,atrim=0:{total_s:.3}[{mix_out}]", v.sample_rate));
    } else {
        // どれもステレオにそろえてから混ぜる（モノラルは左右に同じ大きさで。そろえないと左右に振った声が真ん中に戻る）
        for l in &audio_labels {
            fc.push(format!("[{l}]{STEREO}[s{l}]"));
        }
        let ins: String = audio_labels.iter().map(|l| format!("[s{l}]")).collect();
        fc.push(format!("{ins}amix=inputs={}:normalize=0:duration=longest,apad,atrim=0:{total_s:.3}[{mix_out}]", audio_labels.len()));
    }
    if !viz_labels.is_empty() {
        let outs: String = viz_labels.iter().map(|l| format!("[{l}]")).collect();
        fc.push(format!("[amixed]asplit={}[aout]{outs}", viz_labels.len() + 1));
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
    let webm = ext.eq_ignore_ascii_case("webm");
    let alpha_mov = transparent && ext.eq_ignore_ascii_case("mov");
    if alpha_mov {
        // ProRes 4444（透明を持てる。編集ソフトに読み込みやすい）
        args.extend(["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", "-c:a", "pcm_s16le"].map(String::from));
    } else if webm {
        // WebM（VP9。透明を残すときは yuva420p）
        let pix = if transparent { "yuva420p" } else { "yuv420p" };
        args.extend(["-c:v".into(), "libvpx-vp9".into(), "-pix_fmt".into(), pix.into(), "-b:v".into(), "0".into(), "-crf".into(), (opt.crf as u32 + 10).min(63).to_string(), "-deadline".into(), "good".into(), "-cpu-used".into(), "4".into(), "-row-mt".into(), "1".into()]);
        args.extend(["-c:a", "libopus", "-b:a", "160k"].map(String::from));
    } else {
        args.extend(opt.encoder.args(opt.crf, &opt.preset));
        args.extend(["-c:a", "aac", "-b:a", "192k"].map(String::from));
    }
    args.extend(["-r".into(), v.fps.to_string()]);
    args.extend(range_args(opt.range, total_s));
    if !webm {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    args.extend([
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
    // 跳ねる登場・退場の大きさ（行きすぎてから戻る。画面の visualAt と同じ式）
    let back_out = |p: String| format!("(1+2.70158*pow(({p})-1,3)+1.70158*pow(({p})-1,2))");
    let back_in = |p: String| format!("(2.70158*pow({p},3)-1.70158*pow({p},2))");
    let zoom_at = |lt: &str| {
        let mut zoom = String::new();
        if let Some((MotionKind::Zoom | MotionKind::Spin, d)) = enter {
            zoom.push_str(&format!("*(1-{})", enter_k(lt, d)));
        }
        if let Some((MotionKind::Zoom | MotionKind::Spin, d)) = exit {
            zoom.push_str(&format!("*(1-{})", exit_k(lt, d)));
        }
        if let Some((MotionKind::Bounce, d)) = enter {
            zoom.push_str(&format!("*{}", back_out(format!("clip({lt}/{d:.4},0,1)"))));
        }
        if let Some((MotionKind::Bounce, d)) = exit {
            zoom.push_str(&format!("*(1-{})", back_in(format!("clip(({lt}-{:.4})/{d:.4},0,1)", (dur - d).max(0.0)))));
        }
        // 拍動：1 拍の頭でぐっと大きくなり、すぐ戻る
        for fx in &look.effects {
            if let Effect::Pulse { amount, bpm } = fx {
                if *bpm > 0.0 && *amount > 0.0 {
                    let ph = format!("mod({lt}*{:.6},1)", bpm / 60.0);
                    zoom.push_str(&format!("*(1+{:.5}*exp(-10*{ph})*(1-exp(-60*{ph})))", amount * PULSE_NORM));
                }
            }
        }
        zoom
    };
    // 回る量（度）：回転しながらの登場・退場と、回り続ける
    let spin_at = |lt: &str| {
        let mut r = String::new();
        if let Some((MotionKind::Spin, d)) = enter {
            r.push_str(&format!("-360*{}", enter_k(lt, d)));
        }
        if let Some((MotionKind::Spin, d)) = exit {
            r.push_str(&format!("+360*{}", exit_k(lt, d)));
        }
        for fx in &look.effects {
            if let Effect::Spin { rpm } = fx {
                if rpm.abs() > 0.0 {
                    r.push_str(&format!("+{:.6}*{lt}", rpm * 6.0));
                }
            }
        }
        r
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
            Effect::Jitter { .. } | Effect::Oscillate { .. } | Effect::Bounce { .. } => moves.push(fx),
            // 拍動・回り続けるは大きさ・回転の式に入れてある
            Effect::Pulse { .. } | Effect::Spin { .. } => {}
            Effect::Blink { speed } if *speed > 0.0 => chain.push(format!("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(1-mod(floor(T*{:.4}),2))'", speed * 2.0)),
            Effect::Blink { .. } => {}
            Effect::Plugin { ffmpeg, values, .. } => {
                if let Some(f) = crate::plugin::fill(ffmpeg, values) {
                    chain.push(f);
                }
            }
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
            MotionKind::Iris => wipe.push(format!("lt(hypot(X-W/2,Y-H/2),hypot(W,H)/2*(1-{v}))")),
            MotionKind::Blur => wipe.push(format!("(1-{v})")),
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
            MotionKind::Iris => wipe.push(format!("lt(hypot(X-W/2,Y-H/2),hypot(W,H)/2*(1-{q}))")),
            MotionKind::Blur => wipe.push(format!("(1-{q})")),
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
    let spin = spin_at("t");
    if sr.abs() > 1e-9 || er.abs() > 1e-9 || mr.iter().any(|(_, v)| v.abs() > 1e-9) || !spin.is_empty() {
        let a = if spin.is_empty() { tween3(sr, &mr, er, e, "t", dur) } else { format!("({}{spin})", tween3(sr, &mr, er, e, "t", dur)) };
        chain.push(format!("rotate=a='{a}*PI/180':c=black@0:ow='hypot(iw,ih)':oh='hypot(iw,ih)'"));
    }
    if blur > 0.0 {
        // 半径は画面上の px。この時点では元の大きさなので、始まりの大きさで割る
        chain.push(format!("gblur=sigma={:.3}", blur / ss.max(0.01)));
    }
    // ぼかしからの登場・退場：ぼかしの強さを 8 段に分けて、その時刻の段だけ掛ける（画面も同じ 8 段）
    // 外へにじむよう透明な余白を足し、色は不透明度を掛けてからぼかす（画面の canvas と同じく、縁が黒ずまない）
    let blur_motion: Vec<String> = [(enter, enter.map(|(_, d)| enter_k("t", d))), (exit, exit.map(|(_, d)| exit_k("t", d)))]
        .into_iter()
        .filter_map(|(m, v)| if let (Some((MotionKind::Blur, _)), Some(v)) = (m, v) { Some(v) } else { None })
        .collect();
    if !blur_motion.is_empty() {
        let p = (MOTION_BLUR * 3.0 / ss.max(0.01)).ceil() as i64;
        chain.push(format!("pad=iw+{0}:ih+{0}:{p}:{p}:color=black@0", p * 2));
        chain.push("geq=r='r(X,Y)*alpha(X,Y)/255':g='g(X,Y)*alpha(X,Y)/255':b='b(X,Y)*alpha(X,Y)/255':a='alpha(X,Y)'".into());
        for v in &blur_motion {
            for j in 1..=MOTION_BLUR_STEPS {
                let sg = MOTION_BLUR * j as f64 / MOTION_BLUR_STEPS as f64 / ss.max(0.01);
                chain.push(format!("gblur=sigma={sg:.3}:enable='eq(round({v}*{MOTION_BLUR_STEPS}),{j})'"));
            }
        }
        let un = |f: &str| format!("min(255,{f}(X,Y)*255/max(alpha(X,Y),1))");
        chain.push(format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", un("r"), un("g"), un("b")));
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
                Effect::Bounce { height, bpm } if *bpm > 0.0 => {
                    y.push_str(&format!("-{height:.3}*abs(sin(PI*{:.6}*{lt}))", bpm / 60.0));
                }
                _ => {}
            }
        }
        // 回転・拡大の中心：その点が位置に来るよう、中心から点までを回して大きさを掛けた分だけ戻す
        if let Some([ox, oy]) = look.pivot.filter(|p| p[0].abs() > 1e-9 || p[1].abs() > 1e-9) {
            let k = format!("({}{})", tween3(ss, &ms, es, e, &lt, dur), zoom_at(&lt));
            let a = format!("(({}{})*PI/180)", tween3(sr, &mr, er, e, &lt, dur), spin_at(&lt));
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
            fc.push(format!("[{under}][tr{idx}d{k}]overlay=x='{x}':y='{y}':enable='between(t,{:.3},{end:.3})':eof_action=pass{}[tr{idx}o{k}]", start + delay, ov_fmt()));
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

/// 色相の回転の行列（CSS の hue-rotate と同じ）。[定数・cos の係数・sin の係数] × [r, g, b]
pub(crate) const HUE_ROTATE: [[[f64; 3]; 3]; 3] = [
    [[0.213, 0.715, 0.072], [0.787, -0.715, -0.072], [-0.213, -0.715, 0.928]],
    [[0.213, 0.715, 0.072], [-0.213, 0.285, -0.072], [0.143, 0.140, -0.283]],
    [[0.213, 0.715, 0.072], [-0.213, -0.715, 0.928], [-0.787, 0.715, 0.072]],
];
/// ベベルで縁を読む距離（幅に対する割合）
pub(crate) const BEVEL_STEPS: [f64; 3] = [1.0 / 3.0, 2.0 / 3.0, 1.0];

/// 拍動の形 exp(−10φ)(1 − exp(−60φ)) のいちばん大きい値が 1 になる倍率（画面の PULSE_NORM と同じ）
pub(crate) const PULSE_NORM: f64 = 1.658;
/// ぼかしからの登場・退場：いちばん強いぼかし（画面の px）と、その段の数
pub(crate) const MOTION_BLUR: f64 = 24.0;
pub(crate) const MOTION_BLUR_STEPS: u32 = 8;

/// 不透明度を読む式。絵の外は透明として読む（geq は外を端の色で読むので。画面の alphaOut と同じ）
fn alpha_out(x: &str, y: &str) -> String {
    format!("if(between({x},0,W-1)*between({y},0,H-1),alpha({x},{y}),0)")
}

/// 明るさ（0〜255）を、ある点（「X,Y」の形の式）で読む式
fn lum_at(p: &str) -> String {
    format!("(0.299*r({p})+0.587*g({p})+0.114*b({p}))")
}

/// 色相（ラジアン。画面の preview/retro.ts の hueOf と同じ式）
pub(crate) fn hue_of(r: f64, g: f64, b: f64) -> f64 {
    (1.7320508 * (g - b)).atan2(2.0 * r - g - b)
}

/// レンズフレアのゴースト（真ん中への進み具合・半径。画面と同じ）
pub(crate) const FLARE_GHOSTS: [(f64, f64); 3] = [(0.5, 0.03), (1.2, 0.06), (1.7, 0.02)];

/// スクリーン合成で光を足す（light(i) は i 番目の色の光の式、0〜255）
fn screen_geq(light: &dyn Fn(usize) -> String) -> String {
    let ch = |f: &str, i: usize| format!("255-(255-{f}(X,Y))*(255-{})/255", light(i));
    format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r", 0), ch("g", 1), ch("b", 2))
}

/// 真ん中からの離れ方（真ん中 0・角 1）。周辺減光に使う（画面の preview/retro.ts と同じ）
const D2: &str = "((X/W-0.5)*(X/W-0.5)+(Y/H-0.5)*(Y/H-0.5))*2";

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
        Effect::Vhs { amount } if *amount > 0.0 => {
            let a = amount.min(1.0);
            let h = crate::model::hash01_expr;
            let row = format!("floor(Y/{:.4})", 2.0 * k);
            // 流れる帯（上から下へ。帯の中ほど大きく揺れ、ノイズが増える）
            let bk = "max(0,1-abs(Y-(mod(T*0.23,1)*1.2-0.1)*H)/(0.05*H))";
            let wob = format!("{:.4}*(2*({}*2-1)+24*{bk}*({}*2-1))", a * k, h(&row, "N"), h(&row, "N+3"));
            let c = 5.0 * a * k;
            let xs = format!("(X-{wob})");
            let sl = format!("(1-{:.4}*mod({row},2))", 0.2 * a);
            let nz = format!("({}-0.5)*{:.3}*(60+160*{bk})", h("X+Y*0.618", "N+0.37"), a);
            let ch = |f: &str, dx: f64| format!("clip({f}({xs}+{dx:.3},Y)*{sl}+{nz},0,255)");
            let al = format!("max(max(alpha({xs}-{c:.3},Y),alpha({xs},Y)),alpha({xs}+{c:.3},Y))");
            vec![pad(31.0 * a * k + 1.0), format!("geq=r='{}':g='{}':b='{}':a='{al}'", ch("r", -c), ch("g", 0.0), ch("b", c))]
        }
        Effect::HueCycle { rpm, offset } => {
            // 色相を回す（CSS の hue-rotate と同じ行列。画面も同じ式）
            let th = format!("(({:.6}*T+{:.4})*PI/180)", rpm * 6.0, offset);
            let (c, sn) = (format!("cos({th})"), format!("sin({th})"));
            let row = |m: [[f64; 3]; 3]| {
                ["r", "g", "b"]
                    .iter()
                    .enumerate()
                    .map(|(j, f)| format!("({:.4}+{:.4}*{c}+{:.4}*{sn})*{f}(X,Y)", m[0][j], m[1][j], m[2][j]))
                    .collect::<Vec<_>>()
                    .join("+")
            };
            let [r0, r1, r2] = HUE_ROTATE;
            vec![format!("geq=r='clip({},0,255)':g='clip({},0,255)':b='clip({},0,255)':a='alpha(X,Y)'", row(r0), row(r1), row(r2))]
        }
        Effect::Sharpen { amount } if *amount > 0.0 => {
            let a = amount.min(2.0);
            let ch = |f: &str| format!("clip({f}(X,Y)*{:.4}-{a:.4}*({f}(X+{k:.4},Y)+{f}(X-{k:.4},Y)+{f}(X,Y+{k:.4})+{f}(X,Y-{k:.4})),0,255)", 1.0 + 4.0 * a);
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r"), ch("g"), ch("b"))]
        }
        Effect::InnerShadow { color, blur, x, y, opacity } => {
            // 形の外（ずらした形の外側）を色で塗ってぼかし、形の中にだけ重ねる
            let [r, g, b] = rgb255(color);
            let (dx, dy, bl) = (x * k, y * k, blur.max(0.0) * k);
            let gb = if bl > 0.0 { format!(",gblur=sigma={bl:.3}") } else { String::new() };
            vec![format!(
                "split=3[is{tag}a][is{tag}b][is{tag}c];[is{tag}c]alphaextract[is{tag}m];[is{tag}b]geq=r='{r}':g='{g}':b='{b}':a='(255-{})*{:.4}'{gb}[is{tag}s];[is{tag}a][is{tag}s]overlay=format=rgb,format=rgba[is{tag}o];[is{tag}o][is{tag}m]alphamerge",
                alpha_out(&format!("X-{dx:.3}"), &format!("Y-{dy:.3}")),
                opacity.clamp(0.0, 1.0)
            )]
        }
        Effect::Bevel { size, strength, angle } if *size > 0.0 => {
            // 光の側の縁を明るく、反対側の縁を暗く（形の縁から size だけ内側まで）
            let (lx, ly) = (angle.to_radians().cos(), -angle.to_radians().sin());
            let s0 = size * k;
            let d = BEVEL_STEPS
                .iter()
                .map(|t| {
                    let (ox, oy) = (s0 * t * lx, s0 * t * ly);
                    format!("({}-{})", alpha_out(&format!("X-({ox:.4})"), &format!("Y-({oy:.4})")), alpha_out(&format!("X+({ox:.4})"), &format!("Y+({oy:.4})")))
                })
                .collect::<Vec<_>>()
                .join("+");
            let d = format!("(({d})/{:.1})", 255.0 * BEVEL_STEPS.len() as f64);
            let st = strength.clamp(0.0, 1.0);
            let ch = |f: &str| format!("clip({f}(X,Y)+max({d},0)*{st:.4}*(255-{f}(X,Y))+min({d},0)*{st:.4}*{f}(X,Y),0,255)");
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r"), ch("g"), ch("b"))]
        }
        Effect::Emboss { amount, angle, keep_color } => {
            let (lx, ly) = (angle.to_radians().cos(), -angle.to_radians().sin());
            let dd = 2.0 * k;
            let (ox, oy) = (dd * lx, dd * ly);
            let v = format!(
                "(({}-{})*{:.4})",
                lum_at(&format!("X-({ox:.4}),Y-({oy:.4})")),
                lum_at(&format!("X+({ox:.4}),Y+({oy:.4})")),
                0.5 + 1.5 * amount.clamp(0.0, 1.0)
            );
            let ch = |f: &str| if *keep_color { format!("clip({f}(X,Y)+{v},0,255)") } else { format!("clip(128+{v},0,255)") };
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r"), ch("g"), ch("b"))]
        }
        Effect::GlitchNoise { amount, rate, block } if *amount > 0.0 => {
            let a = amount.min(1.0);
            let h = crate::model::hash01_expr;
            // 1 秒に 12 回、乱れ方が変わる。rate の割合の時間だけ大きく乱れる
            let step = "floor(T*12)";
            let i = format!("({a:.4}*(0.15+0.85*lt({},{:.4})*(0.5+0.5*{})))", h(step, "1"), rate.clamp(0.0, 1.0), h(step, "2"));
            let b = block.max(2.0) * k;
            let band = format!("floor(Y/{:.4})", (b * 0.5).max(1.0));
            let bx = format!("floor(X/{:.4})", (b * 2.0).max(1.0));
            let off = format!("(gt({},0.55)*{i}*{:.4}*({}*2-1))", h(&band, &format!("{step}+3")), 40.0 * k, h(&band, &format!("{step}+4")));
            let (cr, cb) = (format!("({i}*{:.4}*{})", 8.0 * k, h(&band, &format!("{step}+5"))), format!("({i}*{:.4}*{})", 8.0 * k, h(&band, &format!("{step}+6"))));
            let xs = format!("(X-{off})");
            let corrupt = format!("gt({},1-0.1*{i})", h(&format!("{bx}+{band}*31.7"), &format!("{step}+7")));
            let line = format!("gt({},1-0.05*{i})", h(&format!("floor(Y/{k:.4})"), "N+9"));
            let noise = format!("{}*255", h("X+Y*0.37", "N+11"));
            let ch = |f: &str, at: &str| {
                let v = format!("{f}({at},Y)");
                format!("clip(if({line},{noise},{v}+{corrupt}*(255-2*{v})),0,255)")
            };
            let al = format!("max(max(alpha({xs}-{cr},Y),alpha({xs},Y)),alpha({xs}+{cb},Y))");
            vec![
                pad(48.0 * a * k + 1.0),
                format!("geq=r='{}':g='{}':b='{}':a='{al}'", ch("r", &format!("{xs}-{cr}")), ch("g", &xs), ch("b", &format!("{xs}+{cb}"))),
            ]
        }
        Effect::Film { amount } if *amount > 0.0 => {
            let a = amount.min(1.0);
            let h = crate::model::hash01_expr;
            let fl = format!("(1+{:.4}*({}-0.5))", 0.16 * a, h("N", "5"));
            let vig = format!("(1-{:.4}*{D2})", 0.6 * a);
            // 縦の傷（コマごとに 2 本まで。明るい線）
            let sc: Vec<String> = (0..2).map(|j| format!("gt({},0.4)*max(0,1-abs(X-{}*W)/{:.4})", h("N", &(21 + j).to_string()), h("N", &(11 + j).to_string()), 1.5 * k)).collect();
            let grain = format!("({}-0.5)*{:.3}", h("X+Y*0.618", "N+0.37"), 50.0 * a);
            let sep = |m: [f64; 3], f: &str| format!("({f}(X,Y)+({:.3}*r(X,Y)+{:.3}*g(X,Y)+{:.3}*b(X,Y)-{f}(X,Y))*{a:.4})", m[0], m[1], m[2]);
            let ch = |m: [f64; 3], f: &str| format!("clip({}*{fl}*{vig}+{grain}+{:.3}*({}),0,255)", sep(m, f), 110.0 * a, sc.join("+"));
            vec![format!(
                "geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'",
                ch([0.393, 0.769, 0.189], "r"),
                ch([0.349, 0.686, 0.168], "g"),
                ch([0.272, 0.534, 0.131], "b")
            )]
        }
        Effect::Crt { amount } if *amount > 0.0 => {
            let a = amount.min(1.0);
            let sl = format!("(1-{:.4}*(0.5-0.5*cos(2*PI*Y/{:.4})))", 0.45 * a, 3.0 * k);
            let col = format!("mod(floor(X/{:.4}),3)", 2.0 * k);
            let vig = format!("(1-{:.4}*{D2})", 0.5 * a);
            let ch = |f: &str, i: u8| format!("clip({f}(X,Y)*{sl}*(1-{:.4}*(1-eq({col},{i})))*{vig}*{:.4},0,255)", 0.35 * a, 1.0 + 0.35 * a);
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r", 0), ch("g", 1), ch("b", 2))]
        }
        Effect::Vignette { amount } if *amount > 0.0 => {
            let ch = |f: &str| format!("{f}(X,Y)*(1-{:.4}*pow({D2},1.5))", amount.min(1.0));
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r"), ch("g"), ch("b"))]
        }
        Effect::Posterize { levels } => {
            let q = levels.round().clamp(2.0, 16.0) - 1.0;
            let ch = |f: &str| format!("round({f}(X,Y)/255*{q})*255/{q}");
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r"), ch("g"), ch("b"))]
        }
        Effect::LineArt { amount, keep_color } => {
            // 明るさの差（左右・上下に画面の 1px ずつ）が大きい所に黒い線
            let d = k;
            let e = format!(
                "clip((abs({}-{})+abs({}-{}))*{:.4}/255,0,1)",
                lum_at(&format!("X+{d:.4},Y")),
                lum_at(&format!("X-{d:.4},Y")),
                lum_at(&format!("X,Y+{d:.4}")),
                lum_at(&format!("X,Y-{d:.4}")),
                1.0 + 7.0 * amount.clamp(0.0, 1.0)
            );
            let ch = |f: &str| if *keep_color { format!("{f}(X,Y)*(1-{e})") } else { format!("255*(1-{e})") };
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r"), ch("g"), ch("b"))]
        }
        Effect::Halftone { size, ink } if *size >= 2.0 => {
            let c = size * k;
            let (cx, cy) = (format!("((floor(X/{c:.4})+0.5)*{c:.4})"), format!("((floor(Y/{c:.4})+0.5)*{c:.4})"));
            let at = format!("{cx},{cy}");
            // 暗い所ほど大きな点（面積が暗さに比例）。縁は 1px でなめらかに
            let cov = format!("clip({:.4}*sqrt(max(0,1-{}/255))-hypot(X-{cx},Y-{cy})+0.5,0,1)", c * std::f64::consts::FRAC_1_SQRT_2, lum_at(&at));
            let ink = if ink.is_empty() { None } else { Some(rgb255(ink)) };
            let ch = |f: &str, i: usize| {
                let v = ink.map(|c| c[i].to_string()).unwrap_or_else(|| format!("{f}({at})"));
                format!("255+({v}-255)*{cov}")
            };
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r", 0), ch("g", 1), ch("b", 2))]
        }
        Effect::Duotone { dark, light, amount } => {
            let (d, l) = (rgb255(dark), rgb255(light));
            let t = format!("({}/255)", lum_at("X,Y"));
            let ch = |f: &str, i: usize| format!("{f}(X,Y)+({}+{}*{t}-{f}(X,Y))*{:.4}", d[i], l[i] as i32 - d[i] as i32, amount.clamp(0.0, 1.0));
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r", 0), ch("g", 1), ch("b", 2))]
        }
        Effect::LightLeak { color, amount } if *amount > 0.0 => {
            let c = rgb255(color);
            let g = |cx: &str, cy: &str, s: f64| format!("exp(-(pow(X-{cx},2)+pow(Y-{cy},2))/(2*pow({s}*max(W,H),2)))");
            let i = format!(
                "clip({:.4}*(0.9*{}+0.6*{}),0,1)",
                amount.min(1.0),
                g("W*(0.1+0.15*sin(T*0.4))", "H*(0.25+0.1*sin(T*0.31))", 0.3),
                g("W*(0.9-0.1*sin(T*0.27+1))", "H*(0.8+0.1*cos(T*0.35))", 0.22)
            );
            vec![screen_geq(&|j| format!("{}*{i}", c[j]))]
        }
        Effect::Bloom { threshold, amount, radius } if *amount > 0.0 && *radius > 0.0 => {
            let th = threshold.clamp(0.0, 0.99) * 255.0;
            let m = format!("clip(({}-{th:.3})/{:.3},0,1)*{:.4}", lum_at("X,Y"), 255.0 - th + 1.0, amount.min(2.0));
            let ch = |f: &str| format!("{f}(X,Y)*{m}");
            vec![format!(
                "split[bl{tag}a][bl{tag}b];[bl{tag}b]geq=r='{}':g='{}':b='{}':a='0',gblur=sigma={:.3}[bl{tag}c];[bl{tag}a][bl{tag}c]blend=all_mode=addition,format=rgba",
                ch("r"),
                ch("g"),
                ch("b"),
                radius * k
            )]
        }
        Effect::LensFlare { x, y, amount, color } if *amount > 0.0 => {
            let c = rgb255(color);
            let (px, py) = (format!("(W/2*(1+{:.4}))", x.clamp(-1.0, 1.0)), format!("(H/2*(1+{:.4}))", y.clamp(-1.0, 1.0)));
            let d2 = |ax: &str, ay: &str| format!("(pow(X-{ax},2)+pow(Y-{ay},2))");
            let gs = |d: &str, s: f64| format!("exp(-{d}/(2*pow({s}*max(W,H),2)))");
            let p0 = d2(&px, &py);
            let mut parts = vec![gs(&p0, 0.04), format!("0.35*{}", gs(&p0, 0.15))];
            // 横の光の筋
            parts.push(format!("0.6*exp(-pow(Y-{py},2)/(2*pow(0.006*max(W,H),2)))*exp(-pow(X-{px},2)/(2*pow(0.35*max(W,H),2)))"));
            // 真ん中をはさんだ反対側に、丸いゴースト
            for (t, r) in FLARE_GHOSTS {
                let (gx, gy) = (format!("({px}+(W/2-{px})*{t})"), format!("({py}+(H/2-{py})*{t})"));
                parts.push(format!("0.18*clip(({r}*max(W,H)-sqrt({}))/(0.01*max(W,H)),0,1)", d2(&gx, &gy)));
            }
            let i = format!("({:.4}*({}))", amount.min(1.0), parts.join("+"));
            let core = format!("{:.3}*{}", amount.min(1.0) * 255.0 * 0.6, gs(&p0, 0.04));
            vec![screen_geq(&|j| format!("min(255,{}*{i}+{core})", c[j]))]
        }
        Effect::Bulge { amount } if amount.abs() > 0.0 => {
            let a = 0.9 * amount.clamp(-1.0, 1.0);
            let rr = "(hypot(X-W/2,Y-H/2)/(min(W,H)/2))";
            let f = format!("(1-{a:.4}*pow(max(0,1-{rr}),2))");
            let at = format!("W/2+(X-W/2)*{f},H/2+(Y-H/2)*{f}");
            vec![format!("geq=r='r({at})':g='g({at})':b='b({at})':a='alpha({at})'")]
        }
        Effect::Mirror { mode, segments } => {
            let at = match mode.as_str() {
                "left" => "min(X,W-1-X),Y".to_string(),
                "right" => "max(X,W-1-X),Y".to_string(),
                "top" => "X,min(Y,H-1-Y)".to_string(),
                "bottom" => "X,max(Y,H-1-Y)".to_string(),
                "quad" => "min(X,W-1-X),min(Y,H-1-Y)".to_string(),
                _ => {
                    // 万華鏡：真ん中を中心に、扇形を折り返してくり返す
                    let seg = std::f64::consts::TAU / (*segments).clamp(2, 24) as f64;
                    let (dx, dy) = ("(X-(W-1)/2)", "(Y-(H-1)/2)");
                    let a = format!("({:.6}-abs(mod(atan2({dy},{dx}),{seg:.6})-{:.6}))", seg / 2.0, seg / 2.0);
                    format!("(W-1)/2+hypot({dx},{dy})*cos({a}),(H-1)/2+hypot({dx},{dy})*sin({a})")
                }
            };
            vec![format!("geq=r='r({at})':g='g({at})':b='b({at})':a='alpha({at})'")]
        }
        Effect::Tile { count, flip } if *count >= 2 => {
            let n = (*count).min(12);
            let axis = |v: &str, d: &str| {
                let u = format!("({v}*{n}/{d})");
                let f = format!("mod({u},1)");
                if *flip {
                    format!("({f}+mod(floor({u}),2)*(1-2*{f}))*{d}")
                } else {
                    format!("{f}*{d}")
                }
            };
            let at = format!("{},{}", axis("X", "W"), axis("Y", "H"));
            vec![format!("geq=r='r({at})':g='g({at})':b='b({at})':a='alpha({at})'")]
        }
        Effect::ColorKeep { color, range, soft } => {
            let c = rgb255(color);
            let h0 = hue_of(c[0] as f64, c[1] as f64, c[2] as f64);
            let h = "atan2(1.7320508*(g(X,Y)-b(X,Y)),2*r(X,Y)-g(X,Y)-b(X,Y))";
            let diff = format!("(abs(mod({h}-{h0:.6}+PI,2*PI)-PI)/PI)");
            let mx = "max(max(r(X,Y),g(X,Y)),b(X,Y))";
            let mn = "min(min(r(X,Y),g(X,Y)),b(X,Y))";
            let sat = format!("(({mx}-{mn})/max({mx},1))");
            let sf = soft.clamp(0.0, 1.0).max(0.001);
            let keep = format!("(clip(({:.4}-{diff})/{sf:.4},0,1)*clip({sat}*4,0,1))", range.clamp(0.0, 1.0) + sf);
            let l = lum_at("X,Y");
            let ch = |f: &str| format!("{l}+({f}(X,Y)-{l})*{keep}");
            vec![format!("geq=r='{}':g='{}':b='{}':a='alpha(X,Y)'", ch("r"), ch("g"), ch("b"))]
        }
        Effect::Pixelate { size } if *size >= 2.0 => {
            // 点ごとに、その真ん中の色（画面も同じ所を読む）
            let b = size * k;
            let at = format!("floor((floor(X/{b:.4})+0.5)*{b:.4}),floor((floor(Y/{b:.4})+0.5)*{b:.4})");
            vec![format!("geq=r='r({at})':g='g({at})':b='b({at})':a='alpha({at})'")]
        }
        _ => vec![],
    }
}

thread_local! {
    /// グループ制御・カメラでまとめる絵（透明な画面）に重ねている間は、重ねたあとも透明なところを残す
    static KEEP_ALPHA: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 重ねるときの形式（透明を残すときだけ auto。ふだんは今までどおり）
fn ov_fmt() -> &'static str {
    if KEEP_ALPHA.with(|k| k.get()) {
        ":format=auto"
    } else {
        ""
    }
}

/// グループ制御・カメラ：まとめるレイヤーの範囲（from 番目から at 番目の 1 つ下まで）と、そのアイテム（at 番目のレイヤーにある）。
/// 範囲は入れ子になるようにそろえる（はみ出す内側の範囲は、外側の範囲の中だけにする）。画面の Preview.tsx の groupRanges と同じ
pub fn group_ranges(p: &Project) -> Vec<(usize, usize, Vec<&crate::model::Clip>)> {
    let mut out: Vec<(usize, usize, Vec<&crate::model::Clip>)> = vec![];
    for (gi, t) in p.tracks.iter().enumerate() {
        if t.hidden {
            continue;
        }
        let cs: Vec<&crate::model::Clip> = p.clips.iter().filter(|c| c.track_id == t.id && control_of(c).is_some_and(|k| k.covers(gi) > 0)).collect();
        if let Some(n) = cs.iter().filter_map(|c| control_of(c)).map(|k| k.covers(gi)).max() {
            out.push((gi - n, gi, cs));
        }
    }
    // 下のグループから順に、上のグループの範囲の頭をまたいでいたら、その頭までにする
    for i in 0..out.len() {
        for j in i + 1..out.len() {
            let (fb, gb) = (out[j].0, out[j].1);
            let (fa, ga) = (out[i].0, out[i].1);
            if fa < fb && ga > fb && ga < gb {
                out[i].0 = fb;
            }
        }
    }
    out
}

fn control_of(c: &crate::model::Clip) -> Option<crate::model::Control> {
    match &c.body {
        ClipBody::Shape(ShapeClip { control: Some(k), .. }) => Some(*k),
        _ => None,
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
        fc.push(format!("[{last_v}][{src}]overlay={pos}{}[{out}]", ov_fmt()));
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
            breath: None,
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
        let pi = PortraitInput { concat: PathBuf::from("/c/p.ffconcat"), transform: Transform::default(), track: "V2".into(), only: Some(iv), fx: vec![], breath: None };
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
            breath: None,
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
                control: None,
                scene: None,
                viz: None,
                anim: None,
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
            body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: 320.0, height: 180.0, fill: "#fff".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform::default(), look, region: None, control: None, scene: None, viz: None, anim: None }),
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

    #[test]
    fn more_enter_exit_motions() {
        if !has_ffmpeg() {
            return;
        }
        use crate::model::Motion;
        let mo = |k: MotionKind, en: bool| {
            let m = Some(Motion { kind: k, frames: 15, smooth: false });
            if en {
                Look { enter: m, ..Default::default() }
            } else {
                Look { exit: m, ..Default::default() }
            }
        };
        let w = |g: &[u8], y: usize| g[y * 64..y * 64 + 64].iter().map(|&v| v as f64 / 255.0).sum::<f64>();
        // 回転しながら（0.25 秒：残り 25%）：-90° 回って 4 分の 3 の大きさ → 40×20 が縦長 15×30 に
        let a = shot_look("color=c=white:s=40x20", mo(MotionKind::Spin, true), Transform::default(), 0.25);
        assert!(w(&a, 18) < 19.0 && a[5 * 64 + 31] > 200, "{}", w(&a, 18));
        // 跳ねて（0.35 秒）：行きすぎて元より大きい
        let b = shot_look("color=c=white:s=20x20", mo(MotionKind::Bounce, true), Transform::default(), 0.35);
        assert!(w(&b, 18) > 20.5, "{}", w(&b, 18));
        // ぼかしから（0.2 秒）：ぼけて外へにじみ、薄い
        let c = shot_look("color=c=white:s=20x20", mo(MotionKind::Blur, true), Transform::default(), 0.2);
        assert!(c[18 * 64 + 16] > 10 && c[18 * 64 + 31] < 140, "{:?}", &c[18 * 64..19 * 64]);
        // 丸く広がる（0.25 秒）：真ん中の行は 33px ほど、上の方の行は狭い。退場の丸く狭まるも同じ大きさ
        let d = shot_look("color=c=white:s=40x20", mo(MotionKind::Iris, true), Transform::default(), 0.25);
        let e = shot_look("color=c=white:s=40x20", mo(MotionKind::Iris, false), Transform::default(), 2.75);
        assert!((w(&d, 18) - 34.0).abs() < 2.5 && w(&d, 10) < w(&d, 18) - 2.0 && (w(&e, 18) - w(&d, 18)).abs() < 3.0, "{} {} {}", w(&d, 18), w(&d, 10), w(&e, 18));
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
        // 映像加工（画面の preview/retro.ts と同じ式。e2e で同じ所の色を比べる）
        let gray = |c: &str| format!("color=c={c}:s=10x10");
        let p1 = shot_look(&gray("0x666666"), fx(Effect::Posterize { levels: 2.0 }), Transform::default(), 0.1);
        let p2 = shot_look(&gray("0x999999"), fx(Effect::Posterize { levels: 2.0 }), Transform::default(), 0.1);
        assert!(p1[18 * 64 + 32] < 10 && p2[18 * 64 + 32] > 245, "{} {}", p1[18 * 64 + 32], p2[18 * 64 + 32]);
        // 周辺減光（強さ 1）：真ん中はそのまま、辺の真ん中は 1 − 0.5^1.5 ≒ 0.65 倍（四角は x = 26〜35）
        let vg = shot_look(sq, fx(Effect::Vignette { amount: 1.0 }), Transform::default(), 0.1);
        assert!(vg[18 * 64 + 31] > 245 && (140..180).contains(&vg[18 * 64 + 26]) && vg[18 * 64 + 26] < vg[18 * 64 + 28], "{:?}", &vg[18 * 64 + 26..18 * 64 + 38]);
        // 古いフィルム：灰色がセピア（赤が青より明るい）
        let fm = shot_rgb(&gray("0x808080"), fx(Effect::Film { amount: 1.0 }), 0.1);
        assert!(px(&fm, 32, 18)[0] > px(&fm, 32, 18)[2] + 25, "{:?}", px(&fm, 32, 18));
        // ブラウン管：2px ごとに赤・緑・青の縦じま
        let ct = shot_rgb(sq, fx(Effect::Crt { amount: 1.0 }), 0.1);
        let (c0, c1) = (px(&ct, 26, 18), px(&ct, 28, 18));
        assert!(c0[0] > c0[1] + 40 && c1[1] > c1[0] + 40, "{c0:?} {c1:?}");
        // ドット絵風（5px）：点の中は同じ色
        let grad = "nullsrc=s=10x10,geq=lum='X*25':cb=128:cr=128";
        let dt = shot_look(grad, fx(Effect::Pixelate { size: 5.0 }), Transform::default(), 0.1);
        let row = &dt[18 * 64 + 26..18 * 64 + 36];
        assert!(row[0] == row[4] && row[5] == row[9] && row[5] > row[0] + 60, "{row:?}");
        // 漫画・光・変形・パートカラー（e2e で画面の同じ所と比べる。四角の左上は x = 26 − 幅/2 + 5）
        let half = "nullsrc=s=40x20,geq=lum='if(lt(X,20),235,16)':cb=128:cr=128";
        let at = |g: &[u8], x: usize| g[18 * 64 + x];
        // 線画風：境目（x = 32 あたり）だけ黒い線、ほかは白
        let la = shot_look(half, fx(Effect::LineArt { amount: 1.0, keep_color: false }), Transform::default(), 0.1);
        assert!(at(&la, 31).min(at(&la, 32)) < 60 && at(&la, 20) > 220 && at(&la, 45) > 220, "{:?}", &la[18 * 64 + 12..18 * 64 + 52]);
        // 網点（10px）：50% の灰色は、点の真ん中が黒く、点の間が白い
        let ht = shot_look("color=c=0x808080:s=20x20", fx(Effect::Halftone { size: 10.0, ink: "#000000".into() }), Transform::default(), 0.1);
        assert!(ht[13 * 64 + 27] < 60 && ht[8 * 64 + 22] > 200, "{} {}", ht[13 * 64 + 27], ht[8 * 64 + 22]);
        // デュオトーン：白は明るい所の色（黄）、黒は暗い所の色（紺）
        let du = |c: &str| shot_rgb(&format!("color=c={c}:s=10x10"), fx(Effect::Duotone { dark: "#000080".into(), light: "#FFFF00".into(), amount: 1.0 }), 0.1);
        let (dw, db) = (px(&du("white"), 31, 18), px(&du("black"), 31, 18));
        assert!(dw[0] > 220 && dw[2] < 60 && db[2] > 100 && db[0] < 40, "{dw:?} {db:?}");
        // 光漏れ・ブルーム・レンズフレア：光が足されて明るくなる
        let gray = "color=c=0x404040:s=20x20";
        let base = shot_look(gray, Look::default(), Transform::default(), 0.1);
        let ll = shot_look(gray, fx(Effect::LightLeak { color: "#FF9A3C".into(), amount: 1.0 }), Transform::default(), 0.1);
        assert!(ll[8 * 64 + 22] > base[8 * 64 + 22] + 30, "{} {}", ll[8 * 64 + 22], base[8 * 64 + 22]);
        let lf = shot_look(gray, fx(Effect::LensFlare { x: 0.0, y: 0.0, amount: 1.0, color: "#FFE0A0".into() }), Transform::default(), 0.1);
        assert!(lf[18 * 64 + 31] > base[18 * 64 + 31] + 100, "{}", lf[18 * 64 + 31]);
        let plain = shot_look(half, Look::default(), Transform::default(), 0.1);
        let bl = shot_look(half, fx(Effect::Bloom { threshold: 0.5, amount: 1.0, radius: 4.0 }), Transform::default(), 0.1);
        assert!(at(&bl, 34) > at(&plain, 34) + 15 && at(&bl, 45) < at(&plain, 45) + 10, "{:?}", &bl[18 * 64 + 12..18 * 64 + 52]);
        // 鏡写し（左を右へ）：右も白。タイル 2：白・黒・白・黒
        let mi = shot_look(half, fx(Effect::Mirror { mode: "left".into(), segments: 6 }), Transform::default(), 0.1);
        assert!(at(&mi, 45) > 200, "{:?}", &mi[18 * 64 + 12..18 * 64 + 52]);
        let ti = shot_look(half, fx(Effect::Tile { count: 2, flip: false }), Transform::default(), 0.1);
        assert!(at(&ti, 17) > 200 && at(&ti, 27) < 40 && at(&ti, 37) > 200 && at(&ti, 47) < 40, "{:?}", &ti[18 * 64 + 12..18 * 64 + 52]);
        // 魚眼：横の明るさの坂が、真ん中の近くでゆるやかになる（真ん中の色に近づく）
        let ramp = "nullsrc=s=40x20,geq=lum='16+X*5':cb=128:cr=128";
        let (r0, r1) = (shot_look(ramp, Look::default(), Transform::default(), 0.1), shot_look(ramp, fx(Effect::Bulge { amount: 1.0 }), Transform::default(), 0.1));
        assert!(at(&r1, 36) + 4 < at(&r0, 36) && at(&r1, 27) > at(&r0, 27) + 4, "{:?} {:?}", &r0[18 * 64 + 12..18 * 64 + 52], &r1[18 * 64 + 12..18 * 64 + 52]);
        // パートカラー（赤を残す）：赤はそのまま、緑は灰色
        let rg = "color=c=red:s=20x20[a];color=c=0x00ff00:s=20x20[b];[a][b]hstack";
        let ck = shot_rgb(rg, fx(Effect::ColorKeep { color: "#FF0000".into(), range: 0.1, soft: 0.1 }), 0.1);
        let (kr, kg) = (px(&ck, 20, 18), px(&ck, 44, 18));
        assert!(kr[0] > 200 && kr[1] < 60 && (kg[0] as i32 - kg[1] as i32).abs() < 20 && kg[1] > 80, "{kr:?} {kg:?}");
        // ずっと続く動き：拍動（拍の頭で 1.48 倍）・回り続ける（1/8 秒で 45°）・跳ねる（半拍で 10px 上）
        let sq20 = "color=c=white:s=20x20";
        let w = |g: &[u8], y: usize| g[y * 64..y * 64 + 64].iter().map(|&v| v as f64 / 255.0).sum::<f64>();
        let pu = shot_look(sq20, fx(Effect::Pulse { amount: 0.5, bpm: 60.0 }), Transform::default(), 0.05);
        assert!((w(&pu, 18) - 29.5).abs() < 2.0, "{}", w(&pu, 18));
        let sp = shot_look(sq20, fx(Effect::Spin { rpm: 60.0 }), Transform::default(), 0.125);
        assert!(w(&sp, 8) > 5.0 && w(&sp, 8) < 14.0 && w(&sp, 18) > 26.0, "{} {}", w(&sp, 8), w(&sp, 18));
        let bo = shot_look(sq20, fx(Effect::Bounce { height: 10.0, bpm: 60.0 }), Transform::default(), 0.5);
        assert!(bo[64 + 31] > 200 && bo[20 * 64 + 31] < 30, "上へ 10px");
        // 色相の回転：赤が 1/3 秒で 120° 回って緑に
        let hu = shot_rgb("color=c=red:s=20x20", fx(Effect::HueCycle { rpm: 60.0, offset: 0.0 }), 1.0 / 3.0);
        assert!(px(&hu, 31, 18)[1] > 90 && px(&hu, 31, 18)[0] < 20, "{:?}", px(&hu, 31, 18));
        // シャープ：境目の明るい側がもっと明るく、暗い側がもっと暗く
        let sh = shot_look("nullsrc=s=40x20,geq=lum='if(lt(X,20),150,100)':cb=128:cr=128", fx(Effect::Sharpen { amount: 1.0 }), Transform::default(), 0.1);
        assert!(sh[18 * 64 + 31] > sh[18 * 64 + 20] + 30 && sh[18 * 64 + 32] + 30 < sh[18 * 64 + 45], "{:?}", &sh[18 * 64..19 * 64]);
        // 内側の影（右下へ 3px・ぼかしなし）：左と上の内側 3px が黒い
        let ins = shot_look(sq20, fx(Effect::InnerShadow { color: "#000000".into(), blur: 0.0, x: 3.0, y: 3.0, opacity: 1.0 }), Transform::default(), 0.1);
        assert!(ins[18 * 64 + 23] < 30 && ins[18 * 64 + 26] > 220 && ins[9 * 64 + 31] < 30 && ins[12 * 64 + 31] > 220, "{:?}", &ins[18 * 64..19 * 64]);
        // ベベル（左上から光）：左上の縁は明るく、右下の縁は暗い
        let bv = shot_look("color=c=0x808080:s=20x20", fx(Effect::Bevel { size: 4.0, strength: 1.0, angle: 135.0 }), Transform::default(), 0.1);
        assert!(bv[18 * 64 + 22] > 200 && bv[18 * 64 + 40] < 60 && (120..136).contains(&bv[18 * 64 + 31]), "{:?}", &bv[18 * 64..19 * 64]);
        // エンボス（左から光）：平らな所は灰色、境目だけ暗い線
        let em = shot_look("nullsrc=s=40x20,geq=lum='if(lt(X,20),235,16)':cb=128:cr=128", fx(Effect::Emboss { amount: 1.0, angle: 180.0, keep_color: false }), Transform::default(), 0.1);
        assert!((120..136).contains(&em[18 * 64 + 20]) && em[18 * 64 + 31] < 30 && (120..136).contains(&em[18 * 64 + 45]), "{:?}", &em[18 * 64..19 * 64]);
        // 放射ブラー・ノイズ・グリッチは掛かる（元と変わる）
        let plain = shot_look(half, Look::default(), Transform::default(), 0.1);
        for e in [
            Effect::RadialBlur { amount: 0.5 },
            Effect::Noise { amount: 0.5 },
            Effect::Glitch { amount: 8.0, band: 2.0, speed: 10.0 },
            Effect::Vhs { amount: 1.0 },
            Effect::GlitchNoise { amount: 1.0, rate: 1.0, block: 4.0 },
            Effect::Mirror { mode: "kaleido".into(), segments: 6 },
            Effect::Tile { count: 3, flip: true },
            Effect::LineArt { amount: 0.5, keep_color: true },
            Effect::Halftone { size: 6.0, ink: String::new() },
        ] {
            let h = shot_look(half, fx(e.clone()), Transform::default(), 0.1);
            assert!(h != plain, "{e:?}");
        }
        // プラグインのエフェクト（赤と緑を消す式）：白い四角が青に
        let pl = Effect::Plugin { name: "t".into(), ffmpeg: "colorchannelmixer=rr={k}:gg={k}".into(), canvas: String::new(), values: [("k".to_string(), 0.0)].into(), params: vec![] };
        let q = shot_rgb(sq, fx(pl), 0.1);
        assert!(px(&q, 32, 18)[2] > 200 && px(&q, 32, 18)[0] < 60, "{:?}", px(&q, 32, 18));
        // 反復移動（横 10px・1 秒に 0.25 回）：1 秒で右に 10px
        let o = shot_look("color=c=white:s=4x4", fx(Effect::Oscillate { x: 10.0, y: 0.0, speed: 0.25 }), Transform::default(), 1.0);
        assert!(o[18 * 64 + 42] > 200 && o[18 * 64 + 32] < 30);
        // ランダム移動：jitter_at と同じだけずれる
        let (jx, jy) = crate::model::jitter_at(10.0, 2.0, 1.0);
        let j = shot_look("color=c=white:s=2x2", fx(Effect::Jitter { amount: 10.0, speed: 2.0 }), Transform::default(), 1.0);
        let at = (31.0 + jx).round() as usize + 1 + ((18.0 + jy - 1.0).round() as usize) * 64;
        assert!(j[at] > 100, "{jx} {jy}");
    }

    /// グループ制御・カメラ・調整レイヤー（画面の e2e「グループ制御」と同じ数）
    #[test]
    fn group_camera_adjust() {
        use crate::model::{Clip, Control, ControlKind, Track, TrackKind};
        if !has_ffmpeg() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let sq = d.path().join("sq.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=6x6", "-frames:v", "1"]).arg(&sq).status().unwrap().success());
        let img = |id: &str, track: &str, x: f64| Clip { id: id.into(), track_id: track.into(), start: 0, duration: 60, link_id: None, body: ClipBody::Media(MediaClip { src: sq.to_string_lossy().into_owned(), media_kind: MediaKind::Image, has_audio: false, in_point: 0, volume: 1.0, transform: Transform { x, ..Default::default() }, look: Look::default(), audio_frames: None, src_fx: Default::default() }) };
        let ctl = |kind: ControlKind, layers: u32, transform: Transform, look: Look| Clip { id: "g".into(), track_id: "V3".into(), start: 0, duration: 30, link_id: None, body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: 10.0, height: 10.0, fill: "#f00".into(), stroke: String::new(), stroke_width: 0.0, transform, look, region: None, control: Some(Control { kind, layers }), scene: None, viz: None, anim: None }) };
        let shot = |g: Clip, at: f64| -> Vec<u8> {
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
            p.video.background = "#000000".into();
            p.tracks = (1..=3).map(|n| Track::new(format!("V{n}"), TrackKind::Video)).collect();
            p.clips = vec![img("a", "V1", -12.0), img("b", "V2", 12.0), g];
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            opt.still_at = Some(at);
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap().stdout
        };
        let px = |g: &[u8], x: usize| g[18 * 64 + x];
        // 四角は x = 17〜22 と 41〜46。グループ（2 レイヤー）を右へ 5px：22〜27 と 46〜51
        let a = shot(ctl(ControlKind::Group, 2, Transform { x: 5.0, ..Default::default() }, Look::default()), 0.5);
        assert!(px(&a, 25) > 200 && px(&a, 49) > 200 && px(&a, 18) < 30, "{:?}", &a[18 * 64..19 * 64]);
        // グループの時間の外（1.5 秒）は元の位置
        let b = shot(ctl(ControlKind::Group, 2, Transform { x: 5.0, ..Default::default() }, Look::default()), 1.5);
        assert!(px(&b, 18) > 200 && px(&b, 25) < 30);
        // 1 レイヤーだけまとめると、すぐ下（V2）だけ動く
        let c = shot(ctl(ControlKind::Group, 1, Transform { x: 5.0, ..Default::default() }, Look::default()), 0.5);
        assert!(px(&c, 18) > 200 && px(&c, 49) > 200 && px(&c, 42) < 30, "{:?}", &c[18 * 64..19 * 64]);
        // 不透明度 50%：まとめて半分の明るさ
        let o = shot(ctl(ControlKind::Group, 2, Transform { opacity: 0.5, ..Default::default() }, Look::default()), 0.5);
        assert!((100..160).contains(&px(&o, 19)), "{}", px(&o, 19));
        // カメラを右へ 5px：絵は左へ 5px（12〜17 と 36〜41）
        let m = shot(ctl(ControlKind::Camera, 1, Transform { x: 5.0, ..Default::default() }, Look::default()), 0.5);
        assert!(px(&m, 14) > 200 && px(&m, 38) > 200 && px(&m, 20) < 30, "{:?}", &m[18 * 64..19 * 64]);
        // カメラで 2 倍に寄る：真ん中から 2 倍（四角は x = 2〜13 と 50〜61）
        let z = shot(ctl(ControlKind::Camera, 1, Transform { scale: 2.0, ..Default::default() }, Look::default()), 0.5);
        assert!(px(&z, 4) > 200 && px(&z, 59) > 200 && px(&z, 20) < 30, "{:?}", &z[18 * 64..19 * 64]);
        // 調整レイヤー（色の反転）：下の全部が反転する（黒い背景は白、四角は黒）
        let j = shot(ctl(ControlKind::Adjust, 1, Transform::default(), Look { effects: vec![Effect::Invert], ..Default::default() }), 0.5);
        assert!(px(&j, 30) > 220 && px(&j, 19) < 30 && px(&j, 43) < 30, "{:?}", &j[18 * 64..19 * 64]);
    }

    /// 1 文字ずつ出すテキスト：画面側が用意したコマごとの画像を 1 コマずつ並べ、最後の画像は終わりまで出す
    #[test]
    fn text_char_frames() {
        use crate::model::{CharAnim, Clip};
        if !has_ffmpeg() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let mk = |name: &str, c: &str| {
            let f = d.path().join(name);
            assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("color=c={c}:s=10x10"), "-frames:v", "1"]).arg(&f).status().unwrap().success());
            f
        };
        let (a, b, c) = (mk("a.png", "0x202020"), mk("b.png", "0x808080"), mk("c.png", "white"));
        let mut p = Project::sample();
        (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
        p.video.background = "#000000".into();
        let mut tc: TextClip = serde_json::from_str(r##"{"text":"ab","fontFamily":"a","fontSize":10,"color":"#fff","outlineColor":"#000","outlineWidth":0}"##).unwrap();
        tc.deco.char_anim = Some(CharAnim { kind: "fade".into(), interval: 1, length: 1 });
        p.clips = vec![Clip { id: "t".into(), track_id: "V1".into(), start: 0, duration: 60, link_id: None, body: ClipBody::Text(tc) }];
        let shot = |at: f64| {
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            for (k, f) in [&a, &b, &c].iter().enumerate() {
                opt.item_images.insert(format!("t#{}", k + 1), (*f).clone());
            }
            opt.item_sequences = prepare_sequences(&p, &opt.item_images, d.path()).unwrap();
            opt.still_at = Some(at);
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap().stdout[18 * 64 + 32]
        };
        // 0 コマ目は 1 枚目、1 コマ目は 2 枚目、それより後は最後の画像のまま
        assert!(shot(0.0) < 60, "{}", shot(0.0));
        let m = shot(1.0 / 30.0 + 0.001);
        assert!((90..170).contains(&m), "{m}");
        assert!(shot(1.5) > 220);
        // 出きるまでのコマ数（画面の charAnimFrames と同じ）
        assert_eq!(CharAnim { kind: "fade".into(), interval: 5, length: 10 }.frames(4), 25);
    }

    /// シーン：シーンアイテムの頭からシーンを再生し、アイテムの位置で置く（画面の e2e「シーン」と同じ数）
    #[test]
    fn scene_item() {
        use crate::model::{Clip, Scene, Track, TrackKind};
        if !has_ffmpeg() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let sq = d.path().join("sq.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=6x6", "-frames:v", "1"]).arg(&sq).status().unwrap().success());
        let shape = |id: &str, track: &str, start: Frame, duration: Frame, x: f64, scene: Option<&str>| Clip {
            id: id.into(),
            track_id: track.into(),
            start,
            duration,
            link_id: None,
            body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: 6.0, height: 6.0, fill: "#fff".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform { x, ..Default::default() }, look: Look::default(), region: None, control: None, scene: scene.map(Into::into), viz: None, anim: None }),
        };
        let mut p = Project::sample();
        (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
        p.video.background = "#000000".into();
        p.tracks = (1..=2).map(|n| Track::new(format!("V{n}"), TrackKind::Video)).collect();
        // シーン：頭から 20 フレームは x = −10、そのあとは x = +10 に四角
        p.scenes = vec![Scene { id: "sc".into(), name: "s".into(), tracks: vec![Track::new("S1", TrackKind::Video)], clips: vec![shape("s1", "S1", 0, 20, -10.0, None), shape("s2", "S1", 20, 100, 10.0, None)] }];
        p.clips = vec![shape("it", "V2", 30, 60, 5.0, Some("sc"))];
        let e = p.with_scenes();
        assert_eq!(e.tracks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["V1", "S1@it", "V2"]);
        assert!(e.clips.iter().any(|c| c.id == "s2@it" && c.start == 50 && c.duration == 40), "終わりで切る");
        let shot = |at: f64| {
            let out = d.path().join("o.png");
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            for id in ["s1@it", "s2@it", "it"] {
                opt.item_images.insert(id.into(), sq.clone());
            }
            opt.still_at = Some(at);
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            std::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out).args(["-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap().stdout
        };
        let px = |g: &[u8], x: usize| g[18 * 64 + x];
        // 1.2 秒（シーンの 6 フレーム目）：x = −10 + 5 → 四角は 24〜29
        let a = shot(1.2);
        assert!(px(&a, 26) > 200 && px(&a, 36) < 30, "{:?}", &a[18 * 64..19 * 64]);
        // 2 秒（シーンの 30 フレーム目）：x = +10 + 5 → 44〜49
        let b = shot(2.0);
        assert!(px(&b, 46) > 200 && px(&b, 26) < 30, "{:?}", &b[18 * 64..19 * 64]);
        // アイテムの前（0.5 秒）は何もない
        assert!(shot(0.5).iter().all(|v| *v < 30));
    }

    /// 音声の波形・スペクトラム：音のある間は、図形の大きさの中に塗りの色で描かれる
    #[test]
    fn audio_viz() {
        use crate::model::{AudioViz, Clip, Track, TrackKind};
        if !has_ffmpeg() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let wav = d.path().join("s.wav");
        // 色々な高さの音が混ざったもの（ノイズ）
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=3:a=0.5", "-ar", "48000"]).arg(&wav).status().unwrap().success());
        for kind in [AudioViz::Wave, AudioViz::Bars] {
            let mut p = Project::sample();
            (p.video.width, p.video.height, p.video.fps) = (64, 36, 30);
            p.video.background = "#000000".into();
            p.characters.clear();
            p.tracks = vec![Track::new("V1", TrackKind::Video), Track::new("A1", TrackKind::Audio)];
            p.clips = vec![
                Clip { id: "a".into(), track_id: "A1".into(), start: 0, duration: 90, link_id: None, body: ClipBody::Media(MediaClip { src: wav.to_string_lossy().into_owned(), media_kind: MediaKind::Audio, has_audio: true, in_point: 0, volume: 1.0, transform: Transform::default(), look: Look::default(), audio_frames: None, src_fx: Default::default() }) },
                Clip { id: "z".into(), track_id: "V1".into(), start: 0, duration: 90, link_id: None, body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: 48.0, height: 24.0, fill: "#ff0000".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform::default(), look: Look::default(), region: None, control: None, scene: None, viz: Some(kind), anim: None }) },
            ];
            // 動画に書き出して 1 秒目のコマを読む（静止画は音を混ぜないので）
            let out = d.path().join("o.mp4");
            let opt = ExportOptions::new("ffmpeg", &out, d.path());
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let g = std::process::Command::new("ffmpeg").args(["-v", "error", "-ss", "1", "-i"]).arg(&out).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout;
            let red = (0..64 * 36).filter(|i| g[i * 3] > 120 && g[i * 3 + 1] < 80).count();
            // 図形の外（左右 8px より外）には描かない
            let outside = (0..36).flat_map(|y| (0..6).chain(58..64).map(move |x| y * 64 + x)).filter(|i| g[i * 3] > 120).count();
            assert!(red > 20 && outside == 0, "{kind:?} {red} {outside}");
        }
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
            p.clips.push(Clip { id: "r".into(), track_id: v2, start: 0, duration: 10, link_id: None, body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: 32.0, height: 36.0, fill: "#f00".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform { x: -16.0, ..Default::default() }, look: Look::default(), region: Some(Region { kind, strength: 4.0 }), control: None, scene: None, viz: None, anim: None }) });
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
        let pi = PortraitInput { concat, transform: Transform::default(), track: "V2".into(), only: None, fx: eff, breath: None };
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

    /// 背景を透明のまま書き出す：.mov（ProRes 4444）と .webm（VP9）で、何もないところは透明、図形と字幕は不透明に残る
    #[test]
    fn transparent_export_keeps_alpha_with_real_ffmpeg() {
        use crate::model::{Clip, ShapeClip};
        let d = tempfile::tempdir().unwrap();
        let shape = d.path().join("r.png");
        assert!(std::process::Command::new("ffmpeg").args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=40x40", "-frames:v", "1"]).arg(&shape).output().unwrap().status.success());
        let ass = d.path().join("s.ass");
        std::fs::write(&ass, "[Script Info]\nPlayResX: 160\nPlayResY: 90\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: D,DejaVu Sans,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,8,0,0,2,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,D,,0,0,0,,HH\n").unwrap();
        let mut p = Project::sample();
        (p.video.width, p.video.height, p.video.fps) = (160, 90, 30);
        p.clips.clear();
        p.clips.push(Clip { id: "r".into(), track_id: "V1".into(), start: 0, duration: 30, link_id: None, body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: 40.0, height: 40.0, fill: "#f00".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform { y: 20.0, ..Default::default() }, look: Look::default(), region: None, control: None, scene: None, viz: None, anim: None }) });
        for name in ["o.mov", "o.webm"] {
            let out = d.path().join(name);
            let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
            opt.transparent = true;
            opt.item_images.insert("r".into(), shape.clone());
            let args = build_args(&p, &|_: &str| None, &[], &[("V1".into(), ass.clone())], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{name}: {}", String::from_utf8_lossy(&o.stderr));
            // VP9 の透明は libvpx で読まないと消える
            let mut c = std::process::Command::new("ffmpeg");
            c.args(["-v", "error"]);
            if name.ends_with("webm") {
                c.args(["-c:v", "libvpx-vp9"]);
            }
            let img = c.arg("-i").arg(&out).args(["-ss", "0.5", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).output().unwrap().stdout;
            assert_eq!(img.len(), 160 * 90 * 4, "{name}");
            let a = |x: usize, y: usize| img[(y * 160 + x) * 4 + 3];
            assert!(a(2, 88) < 10 && a(150, 50) < 10, "{name}: 何もないところは透明 {} {}", a(2, 88), a(150, 50));
            assert!(a(80, 65) > 245 && img[(65 * 160 + 80) * 4] > 200, "{name}: 図形は不透明な赤 {}", a(80, 65));
            let top = (0..20).flat_map(|y| (40..120).map(move |x| (x, y))).filter(|&(x, y)| a(x, y) > 200).count();
            assert!(top > 20, "{name}: 字幕は透明な画面にも残る {top}");
        }
        let probe = std::process::Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0"]).arg(d.path().join("o.mov")).output().unwrap().stdout;
        assert!(String::from_utf8_lossy(&probe).contains("prores,yuva444p"), "{}", String::from_utf8_lossy(&probe));
    }

    /// クロスフェード：前の音を延ばして消していき、次の音は大きくしていく（書き出しの WAV を実際に測る）
    #[test]
    fn crossfade_overlaps_audio_with_real_ffmpeg() {
        use crate::model::Clip;
        let d = tempfile::tempdir().unwrap();
        let tone = d.path().join("t.wav");
        assert!(std::process::Command::new("ffmpeg").args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=4"]).arg(&tone).output().unwrap().status.success());
        // 無音の素材（同じ音を 0 倍にしたもの）
        let silent = d.path().join("s.wav");
        assert!(std::process::Command::new("ffmpeg").args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=4", "-af", "volume=0"]).arg(&silent).output().unwrap().status.success());
        let rms = |cf: Frame, a_tone: bool| {
            let mut p = Project::sample();
            p.clips.clear();
            if !p.tracks.iter().any(|t| t.id == "A1") {
                let mut t = p.tracks[0].clone();
                t.id = "A1".into();
                p.tracks.push(t);
            }
            let mut fx = SourceFx::default();
            let clip = |id: &str, start: Frame, src: &Path, fx: SourceFx| Clip {
                id: id.into(),
                track_id: "A1".into(),
                start,
                duration: 30,
                link_id: None,
                body: ClipBody::Media(MediaClip { src: src.to_string_lossy().into_owned(), media_kind: MediaKind::Audio, has_audio: true, in_point: 0, volume: 1.0, transform: Transform::default(), look: Default::default(), audio_frames: None, src_fx: fx }),
            };
            // 片方だけ音を入れ、もう片方は無音の素材にする
            let (sa, sb) = if a_tone { (&tone, &silent) } else { (&silent, &tone) };
            p.clips.push(clip("a", 0, sa, SourceFx::default()));
            fx.crossfade = cf;
            p.clips.push(clip("b", 30, sb, fx));
            let out = d.path().join(format!("o{cf}{a_tone}.wav"));
            let opt = ExportOptions::new("ffmpeg", &out, d.path());
            let args = build_args(&p, &|_: &str| None, &[], &[], &opt).unwrap();
            let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let raw = std::process::Command::new("ffmpeg").args(["-nostdin", "-v", "error", "-i"]).arg(&out).args(["-ac", "1", "-ar", "48000", "-f", "f32le", "-"]).output().unwrap().stdout;
            let x: Vec<f32> = raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            // 30 フレーム目（1 秒）がつなぎ目。前後 0.1 秒ずつの窓で測る
            move |t: f64| {
                let i = (t * 48000.0) as usize;
                let w = &x[i.min(x.len())..(i + 4800).min(x.len())];
                (w.iter().map(|v| v * v).sum::<f32>() / w.len().max(1) as f32).sqrt()
            }
        };
        let full = 0.70710677 * 0.125; // sine の既定の大きさ（1/8）の実効値
        let hard = rms(0, true);
        assert!(hard(0.8) > full * 0.8 && hard(1.05) < full * 0.05, "つながないときはつなぎ目で切れる {} {}", hard(0.8), hard(1.05));
        // 前の音（12 フレーム＝0.4 秒延ばす）はつなぎ目の後もしばらく鳴り、だんだん小さくなる
        let out = rms(12, true);
        let (a, b, c) = (out(1.0), out(1.2), out(1.5));
        assert!(a > full * 0.6 && b > full * 0.2 && b < a && c < full * 0.05, "前の音が消えていく {a} {b} {c}");
        // 次の音はつなぎ目から大きくなっていく
        let inn = rms(12, false);
        let (a, b, c) = (inn(1.0), inn(1.2), inn(1.5));
        assert!(a < full * 0.4 && b > a && c > full * 0.8, "次の音が大きくなる {a} {b} {c}");
    }

    /// 立ち絵の呼吸：足もとは動かさず、頭のほうだけが伸び縮みする（プレビューの breathScale と同じ式）
    #[test]
    fn portrait_breath_stretches_up_from_the_feet_with_real_ffmpeg() {
        let d = tempfile::tempdir().unwrap();
        let png = d.path().join("t.png");
        assert!(std::process::Command::new("ffmpeg").args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=40x80,format=rgba", "-frames:v", "1"]).arg(&png).output().unwrap().status.success());
        let concat = d.path().join("p.ffconcat");
        std::fs::write(&concat, format!("ffconcat version 1.0\nfile {}\nduration 3\nfile {}\n", concat_quote(&png), concat_quote(&png))).unwrap();
        let mut p = Project::sample();
        (p.video.width, p.video.height, p.video.fps) = (160, 160, 30);
        p.clips.retain(|c| c.as_voice().is_none());
        p.clips.push(crate::model::Clip { id: "z".into(), track_id: "V1".into(), start: 0, duration: 75, link_id: None, body: ClipBody::Shape(crate::model::ShapeClip { shape: "rect".into(), width: 1.0, height: 1.0, fill: "#000".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform::default(), look: Look::default(), region: None, control: None, scene: None, viz: None, anim: None }) });
        let b = crate::model::Breath { amount: 20.0, period: 2.0 };
        assert!((b.scale_at(0.0) - 1.0).abs() < 1e-9 && (b.scale_at(1.0) - 1.2).abs() < 1e-9 && (b.scale_at(0.5) - 1.1).abs() < 1e-9);
        let pi = PortraitInput { concat, transform: Transform { y: 10.0, ..Default::default() }, track: "V2".into(), only: None, fx: vec![], breath: Some(b) };
        let out = d.path().join("o.mp4");
        let mut opt = ExportOptions::new("ffmpeg", &out, d.path());
        let dark = d.path().join("k.png");
        assert!(std::process::Command::new("ffmpeg").args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=2x2", "-frames:v", "1"]).arg(&dark).output().unwrap().status.success());
        opt.item_images.insert("z".into(), dark);
        let args = build_args(&p, &|_: &str| None, &[pi], &[], &opt).unwrap();
        let o = std::process::Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        // 真ん中の列の赤い範囲（上端・下端）
        let span = |t: &str| {
            let img = std::process::Command::new("ffmpeg").args(["-v", "error", "-ss", t, "-i"]).arg(&out).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout;
            let red: Vec<usize> = (0..160).filter(|&y| img[(y * 160 + 80) * 3] > 150 && img[(y * 160 + 80) * 3 + 1] < 90).collect();
            (red[0], *red.last().unwrap())
        };
        // 伸ばす前は 50〜129（真ん中から 10 下げる）。1 秒で 1.2 倍：上だけ 16 伸びる
        let (a, b0) = span("0");
        let (c, d1) = span("1");
        assert!(a.abs_diff(50) <= 1 && b0.abs_diff(129) <= 1, "はじめ {a} {b0}");
        assert!(d1.abs_diff(b0) <= 1 && c.abs_diff(34) <= 2, "1 秒 {c} {d1}");
    }

    /// 動く図形：粒はくり返し、進行バーは幅の数までの間隔、グラフは最後の絵のまま（画面側の animStep と同じ）
    #[test]
    fn shape_anim_sequences_loop_or_hold() {
        use crate::model::{Clip, ShapeAnim, ShapeClip};
        let d = tempfile::tempdir().unwrap();
        let mut p = Project::sample();
        p.video.fps = 30;
        let anim = |kind: &str| Some(ShapeAnim { kind: kind.into(), rest: serde_json::from_str(r#"{"type":"snow","amount":10}"#).unwrap() });
        let shape = |id: &str, w: f64, dur: Frame, a: Option<ShapeAnim>| Clip { id: id.into(), track_id: "V1".into(), start: 0, duration: dur, link_id: None, body: ClipBody::Shape(ShapeClip { shape: "rect".into(), width: w, height: 10.0, fill: "#fff".into(), stroke: String::new(), stroke_width: 0.0, transform: Transform::default(), look: Look::default(), region: None, control: None, scene: None, viz: None, anim: a }) };
        p.clips = vec![shape("pt", 100.0, 7, anim("particles")), shape("pg", 100.0, 1000, anim("progress")), shape("ch", 100.0, 9, anim("chart"))];
        let mut images = std::collections::HashMap::new();
        for (id, n) in [("pt", 3), ("pg", 100), ("ch", 4)] {
            for k in 1..=n {
                images.insert(format!("{id}#{k}"), d.path().join(format!("{id}{k}.png")));
            }
        }
        let seq = prepare_sequences(&p, &images, d.path()).unwrap();
        let read = |id: &str| std::fs::read_to_string(&seq[id]).unwrap();
        let files = |t: &str| t.lines().filter(|l| l.starts_with("file")).map(|l| l.rsplit('/').next().unwrap().trim_end_matches('\'').to_string()).collect::<Vec<_>>();
        // 粒：3 枚を 7 コマぶんくり返す（最後の 1 行は concat のための重ね書き）
        assert_eq!(files(&read("pt")), ["pt1.png", "pt2.png", "pt3.png", "pt1.png", "pt2.png", "pt3.png", "pt1.png", "pt1.png"]);
        // 進行バー：幅 100 で 1000 コマ → 10 コマごと
        assert_eq!(ShapeAnim { kind: "progress".into(), rest: Default::default() }.sequence(100.0, 1000), (10, false));
        assert!(read("pg").contains(&format!("duration {:.6}", 10.0 / 30.0)));
        // グラフ：4 枚目（伸びきった絵）が終わりまで
        let ch = read("ch");
        assert!(ch.contains(&format!("duration {:.6}", 6.0 / 30.0)), "{ch}");
        // 描き方の値はそのまま保つ
        let json = serde_json::to_value(&p.clips[0]).unwrap();
        assert_eq!((json["anim"]["kind"].as_str(), json["anim"]["type"].as_str(), json["anim"]["amount"].as_i64()), (Some("particles"), Some("snow"), Some(10)));
    }
}
