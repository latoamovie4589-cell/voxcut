//! AI の機能：自動字幕（音声認識。whisper.cpp）と、人物の背景を消す（切り抜きの型。U²-Net を tract で動かす）。
//! モデルは初めて使うときにダウンロードして、アプリのデータに置く。

use crate::Result;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// ダウンロードできるモデル
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    /// 用途（"whisper" か "matte"）
    pub kind: &'static str,
    pub label: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    /// だいたいの大きさ（バイト）
    pub size: u64,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo { id: "whisper-base", kind: "whisper", label: "速い（約 150MB）", file: "ggml-base.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin", size: 147_951_465 },
    ModelInfo { id: "whisper-small", kind: "whisper", label: "ふつう（約 490MB）", file: "ggml-small.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin", size: 487_601_967 },
    ModelInfo { id: "whisper-medium", kind: "whisper", label: "正確（約 1.5GB）", file: "ggml-medium.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin", size: 1_533_763_059 },
    ModelInfo { id: "matte-fast", kind: "matte", label: "速い（約 5MB）", file: "u2netp.onnx", url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx", size: 4_574_861 },
    ModelInfo { id: "matte-human", kind: "matte", label: "人物をきれいに（約 170MB・時間がかかる）", file: "u2net_human_seg.onnx", url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx", size: 175_997_641 },
];

pub fn model(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

/// ダウンロード済みのモデルのパス（なければ None）
pub fn model_path(root: &Path, id: &str) -> Option<PathBuf> {
    let m = model(id)?;
    let p = root.join(m.file);
    p.is_file().then_some(p)
}

/// モデルをダウンロードする（済んでいればそのまま）。on_progress には 0〜1
pub fn download_model(root: &Path, id: &str, on_progress: &mut dyn FnMut(f64)) -> Result<PathBuf> {
    let m = model(id).ok_or_else(|| crate::Error::Other(format!("モデル {id} はありません")))?;
    let dst = root.join(m.file);
    if dst.is_file() {
        on_progress(1.0);
        return Ok(dst);
    }
    std::fs::create_dir_all(root)?;
    let tmp = root.join(format!("{}.part", m.file));
    // 会社などのプロキシを通す設定（HTTPS_PROXY）があれば使う
    let agent = ureq::AgentBuilder::new().try_proxy_from_env(true).build();
    let resp = agent.get(m.url).call().map_err(|e| crate::Error::Other(format!("モデルをダウンロードできません（{}）: {e}", m.url)))?;
    let total = resp.header("content-length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(m.size).max(1);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&tmp)?;
    let mut buf = vec![0u8; 1 << 16];
    let mut got = 0u64;
    let mut last = 0.0;
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&tmp);
                return Err(crate::Error::Other(format!("ダウンロードが途中で止まりました: {e}")));
            }
        };
        file.write_all(&buf[..n])?;
        got += n as u64;
        let r = (got as f64 / total as f64).min(0.999);
        if r - last > 0.005 {
            last = r;
            on_progress(r);
        }
    }
    file.flush()?;
    drop(file);
    // 途中で切れたファイルを使わない（大きさが大きく違えば失敗）
    if (got as f64) < m.size as f64 * 0.9 {
        let _ = std::fs::remove_file(&tmp);
        return Err(crate::Error::Other(format!("ダウンロードしたモデルが小さすぎます（{got} バイト）")));
    }
    std::fs::rename(&tmp, &dst)?;
    on_progress(1.0);
    Ok(dst)
}

// ───────────── 自動字幕 ─────────────

/// 文字起こしの 1 区切り（秒は素材の頭から）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// 素材の音（in_s 秒目から dur 秒）を 16kHz・モノラルで読む
pub fn read_pcm16k(ffmpeg: &Path, src: &Path, in_s: f64, dur: f64) -> Result<Vec<f32>> {
    let out = crate::tts::hidden_command(ffmpeg)
        .args(["-v", "error", "-ss", &format!("{in_s:.3}"), "-t", &format!("{dur:.3}"), "-i"])
        .arg(src)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"])
        .output()?;
    if !out.status.success() {
        return Err(crate::Error::Other(format!("音を読めません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

/// 文字起こしの区切りを、字幕に向く長さに整える（空を除き、前後の空白を取る）。秒は in_s を足して素材の時刻に
pub fn tidy_segments(raw: Vec<(f64, f64, String)>, in_s: f64) -> Vec<Segment> {
    raw.into_iter()
        .map(|(a, b, t)| (a, b, t.trim().to_string()))
        .filter(|(_, _, t)| !t.is_empty() && !t.starts_with('[') && !t.starts_with('('))
        .map(|(a, b, text)| Segment { start: in_s + a, end: in_s + b.max(a + 0.2), text })
        .collect()
}

/// 文字起こしする（日本語）。on_progress には 0〜1
pub fn transcribe(ffmpeg: &Path, model: &Path, src: &Path, in_s: f64, dur: f64, on_progress: Box<dyn FnMut(f64) + Send>) -> Result<Vec<Segment>> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    let pcm = read_pcm16k(ffmpeg, src, in_s, dur)?;
    if pcm.is_empty() {
        return Ok(vec![]);
    }
    let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default()).map_err(|e| crate::Error::Other(format!("音声認識のモデルを読めません: {e}")))?;
    let mut state = ctx.create_state().map_err(|e| crate::Error::Other(format!("音声認識を始められません: {e}")))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("ja"));
    params.set_n_threads(std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4).min(8));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_print_special(false);
    let mut cb = on_progress;
    params.set_progress_callback_safe(move |p: i32| cb(p as f64 / 100.0));
    state.full(params, &pcm).map_err(|e| crate::Error::Other(format!("音声認識に失敗しました: {e}")))?;
    let mut raw = vec![];
    for i in 0..state.full_n_segments() {
        if let Some(seg) = state.get_segment(i) {
            let text = seg.to_str_lossy().map(|s| s.into_owned()).unwrap_or_default();
            raw.push((seg.start_timestamp() as f64 / 100.0, seg.end_timestamp() as f64 / 100.0, text));
        }
    }
    Ok(tidy_segments(raw, in_s))
}

// ───────────── 背景を消す ─────────────

/// 型（切り抜きの白黒の動画・画像）の置き場所。素材とモデルで決まる
pub fn matte_path(root: &Path, src: &Path, model_id: &str, still: bool) -> Result<PathBuf> {
    Ok(root.join(format!("{}-{model_id}.{}", crate::proxy::proxy_key(src)?, if still { "png" } else { "mp4" })))
}

/// 型を作るときの 1 秒あたりのコマ数（動画）。間のコマは前の型を使う
pub const MATTE_FPS: u32 = 15;
const SIDE: usize = 320;

/// U²-Net の入力（320×320 の RGB）を作る。画面の色を 0〜1 にして、ImageNet の平均と幅でそろえる
pub fn matte_input(rgb: &[u8]) -> Vec<f32> {
    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    let max = rgb.iter().copied().max().unwrap_or(255).max(1) as f32;
    let mut out = vec![0f32; 3 * SIDE * SIDE];
    for i in 0..SIDE * SIDE {
        for c in 0..3 {
            out[c * SIDE * SIDE + i] = (rgb[i * 3 + c] as f32 / max - mean[c]) / std[c];
        }
    }
    out
}

/// U²-Net の出力を 0〜255 の型にする（いちばん小さい値を 0、大きい値を 255 に）
pub fn matte_output(pred: &[f32]) -> Vec<u8> {
    let (lo, hi) = pred.iter().fold((f32::MAX, f32::MIN), |(a, b), &v| (a.min(v), b.max(v)));
    let span = (hi - lo).max(1e-6);
    pred.iter().map(|&v| (((v - lo) / span) * 255.0).round().clamp(0.0, 255.0) as u8).collect()
}

/// 型を作る（動画は MATTE_FPS コマ/秒の白黒の動画、画像は白黒の PNG。白が残すところ）。
/// できていればそのまま返す。on_progress には 0〜1
#[allow(clippy::too_many_arguments)]
pub fn make_matte(ffmpeg: &Path, model: &Path, model_id: &str, src: &Path, root: &Path, still: bool, duration: f64, on_progress: &mut dyn FnMut(f64)) -> Result<PathBuf> {
    use std::sync::Arc;
    use tract_onnx::prelude::*;
    let dst = matte_path(root, src, model_id, still)?;
    if dst.is_file() {
        on_progress(1.0);
        return Ok(dst);
    }
    std::fs::create_dir_all(root)?;
    let err = |e: TractError| crate::Error::Other(format!("切り抜きのモデルを動かせません: {e}"));
    let plan = Arc::new(
        tract_onnx::onnx()
            .model_for_path(model)
            .map_err(err)?
            .with_input_fact(0, f32::fact([1, 3, SIDE, SIDE]).into())
            .map_err(err)?
            .into_optimized()
            .map_err(err)?
            .into_runnable()
            .map_err(err)?,
    );
    // 素材の大きさ（型は素材と同じ縦横の比で書く。長い辺は 640px まで）
    let (sw, sh) = probe_size(ffmpeg, src).unwrap_or((640, 360));
    let k = (640.0 / sw.max(sh) as f64).min(1.0);
    let (ow, oh) = (((sw as f64 * k / 2.0).round() as u32 * 2).max(2), ((sh as f64 * k / 2.0).round() as u32 * 2).max(2));
    // コマを 320×320 の RGB で読む
    let mut dec = crate::tts::hidden_command(ffmpeg);
    dec.args(["-v", "error", "-i"]).arg(src);
    if !still {
        dec.args(["-vf", &format!("fps={MATTE_FPS},scale={SIDE}:{SIDE}:flags=bilinear")]);
    } else {
        dec.args(["-frames:v", "1", "-vf", &format!("scale={SIDE}:{SIDE}:flags=bilinear")]);
    }
    dec.args(["-pix_fmt", "rgb24", "-f", "rawvideo", "-"]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let mut dec = dec.spawn()?;
    let mut input = dec.stdout.take().unwrap();
    // 型を書く
    let tmp = dst.with_extension(if still { "part.png" } else { "part.mp4" });
    let mut enc = crate::tts::hidden_command(ffmpeg);
    enc.args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", &format!("{SIDE}x{SIDE}"), "-r", &MATTE_FPS.to_string(), "-i", "-", "-vf", &format!("scale={ow}:{oh}:flags=bicubic")]);
    if still {
        enc.args(["-frames:v", "1"]);
    } else {
        enc.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-g", &MATTE_FPS.to_string()]);
    }
    enc.arg(&tmp).stdin(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut enc = enc.spawn()?;
    let mut sink = enc.stdin.take().unwrap();
    let total = if still { 1.0 } else { (duration * MATTE_FPS as f64).max(1.0) };
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 16);
    let frame_bytes = SIDE * SIDE * 3;
    let mut done = 0usize;
    let result: Result<()> = (|| {
        loop {
            // いくつかのコマをまとめて読み、同時に計算する
            let mut batch: Vec<Vec<u8>> = vec![];
            for _ in 0..threads {
                let mut f = vec![0u8; frame_bytes];
                match input.read_exact(&mut f) {
                    Ok(()) => batch.push(f),
                    Err(_) => break,
                }
            }
            if batch.is_empty() {
                break;
            }
            let handles: Vec<_> = batch
                .into_iter()
                .map(|f| {
                    let plan = plan.clone();
                    std::thread::spawn(move || -> std::result::Result<Vec<u8>, String> {
                        let t: Tensor = tract_ndarray::Array4::from_shape_vec((1, 3, SIDE, SIDE), matte_input(&f)).map_err(|e| e.to_string())?.into();
                        let out = plan.run(tvec!(t.into())).map_err(|e| e.to_string())?;
                        let pred = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
                        Ok(matte_output(pred.as_slice().unwrap_or(&[])))
                    })
                })
                .collect();
            for h in handles {
                let m = h.join().map_err(|_| crate::Error::Other("切り抜きの計算が止まりました".into()))?.map_err(crate::Error::Other)?;
                sink.write_all(&m)?;
                done += 1;
            }
            on_progress((done as f64 / total).min(0.99));
        }
        Ok(())
    })();
    drop(sink);
    let _ = dec.wait();
    let out = enc.wait_with_output()?;
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if !out.status.success() || done == 0 {
        let _ = std::fs::remove_file(&tmp);
        return Err(crate::Error::Other(format!("切り抜きの型を書けません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    std::fs::rename(&tmp, &dst)?;
    on_progress(1.0);
    Ok(dst)
}

/// 被写体の位置（素材の t 秒目に、被写体の重心が横 x・縦 y にある。0〜1）
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct SubjectPoint {
    pub t: f64,
    pub x: f64,
    pub y: f64,
}

/// 被写体を調べる 1 秒あたりの回数
pub const SUBJECT_FPS: u32 = 4;

/// 背景を消す型から、被写体（白いところ）の重心を時刻ごとに出す。白いところがほとんどない時刻は飛ばす
pub fn subject_points(ffmpeg: &Path, matte: &Path, still: bool) -> Result<Vec<SubjectPoint>> {
    const W: usize = 80;
    const H: usize = 80;
    let mut cmd = crate::tts::hidden_command(ffmpeg);
    cmd.args(["-v", "error", "-i"]).arg(matte);
    let vf = if still { format!("scale={W}:{H}") } else { format!("fps={SUBJECT_FPS},scale={W}:{H}") };
    cmd.args(["-vf", &vf, "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
    let out = cmd.output()?;
    if !out.status.success() {
        return Err(crate::Error::Other(format!("型を読めません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(centroids(&out.stdout, W, H, if still { 0.0 } else { 1.0 / SUBJECT_FPS as f64 }))
}

/// 白黒のコマを順に並べたものから、コマごとの重心（暗いところは数えない）
pub fn centroids(raw: &[u8], w: usize, h: usize, dt: f64) -> Vec<SubjectPoint> {
    raw.chunks_exact(w * h)
        .enumerate()
        .filter_map(|(i, f)| {
            let (mut sw, mut sx, mut sy) = (0.0, 0.0, 0.0);
            for (k, &v) in f.iter().enumerate() {
                if v > 64 {
                    let wv = v as f64;
                    sw += wv;
                    sx += wv * ((k % w) as f64 + 0.5);
                    sy += wv * ((k / w) as f64 + 0.5);
                }
            }
            // 画面の 1% もなければ、被写体は無いとみなす
            (sw > 255.0 * (w * h) as f64 * 0.01).then(|| SubjectPoint { t: i as f64 * dt, x: sx / sw / w as f64, y: sy / sw / h as f64 })
        })
        .collect()
}

/// 素材の幅と高さ（ffprobe を ffmpeg と同じ場所から使う）
pub fn probe_size_of(ffmpeg: &Path, src: &Path) -> Option<(u32, u32)> {
    probe_size(ffmpeg, src)
}

fn probe_size(ffmpeg: &Path, src: &Path) -> Option<(u32, u32)> {
    let name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    let probe = match ffmpeg.parent().filter(|d| !d.as_os_str().is_empty()) {
        Some(d) => d.join(name),
        None => PathBuf::from(name),
    };
    let out = crate::tts::hidden_command(&probe).args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x"]).arg(src).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let (w, h) = s.trim().split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_and_paths() {
        assert!(model("whisper-small").is_some_and(|m| m.kind == "whisper"));
        assert!(model("matte-fast").is_some_and(|m| m.url.starts_with("https://github.com/")));
        let d = tempfile::tempdir().unwrap();
        assert!(model_path(d.path(), "matte-fast").is_none());
        std::fs::write(d.path().join("u2netp.onnx"), b"x").unwrap();
        assert!(model_path(d.path(), "matte-fast").is_some());
        assert!(download_model(d.path(), "nope", &mut |_| {}).is_err());
    }

    #[test]
    fn segments_are_tidied() {
        let s = tidy_segments(vec![(0.0, 1.5, " こんにちは ".into()), (1.5, 1.5, "[音楽]".into()), (2.0, 2.0, "はい".into()), (3.0, 4.0, "  ".into())], 10.0);
        assert_eq!(s, vec![Segment { start: 10.0, end: 11.5, text: "こんにちは".into() }, Segment { start: 12.0, end: 12.2, text: "はい".into() }]);
    }

    #[test]
    fn centroid_of_white() {
        let mut f = vec![0u8; 10 * 10 * 2];
        // 1 コマ目：右下の 4×4、2 コマ目：なにもない
        for y in 6..10 {
            for x in 6..10 {
                f[y * 10 + x] = 255;
            }
        }
        let c = centroids(&f, 10, 10, 0.25);
        assert_eq!(c.len(), 1);
        assert!((c[0].x - 0.8).abs() < 1e-9 && (c[0].y - 0.8).abs() < 1e-9 && c[0].t == 0.0);
    }

    #[test]
    fn matte_io_scales() {
        let rgb = vec![255u8; SIDE * SIDE * 3];
        let x = matte_input(&rgb);
        assert!((x[0] - (1.0 - 0.485) / 0.229).abs() < 1e-5);
        assert_eq!(matte_output(&[0.2, 0.6, 1.0]), vec![0, 128, 255]);
    }

    /// 実際にダウンロードしてみる（VOXCUT_TEST_DOWNLOAD があるときだけ。5MB の小さいモデル）
    #[test]
    fn downloads_the_small_matte_model() {
        if std::env::var("VOXCUT_TEST_DOWNLOAD").is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let mut last = 0.0;
        let p = download_model(d.path(), "matte-fast", &mut |r| last = r).unwrap();
        assert_eq!(last, 1.0);
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 4_574_861);
        assert!(model_path(d.path(), "matte-fast").is_some());
    }

    /// 本物のモデルがあれば（VOXCUT_TEST_MATTE にパス）、型を実際に作ってみる
    #[test]
    fn makes_a_matte_with_a_real_model() {
        let Ok(model) = std::env::var("VOXCUT_TEST_MATTE") else { return };
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("s.mp4");
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x30a030:s=320x180:r=30:d=1,drawbox=x=120:y=30:w=80:h=150:c=0xd09070:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let mut last = 0.0;
        let p = make_matte(Path::new("ffmpeg"), Path::new(&model), "matte-fast", &src, d.path(), false, 1.0, &mut |r| last = r).unwrap();
        assert_eq!(last, 1.0);
        assert!(std::fs::metadata(&p).unwrap().len() > 100);
        let img = d.path().join("i.png");
        assert!(std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-i"]).arg(&src).args(["-frames:v", "1"]).arg(&img).status().unwrap().success());
        let q = make_matte(Path::new("ffmpeg"), Path::new(&model), "matte-fast", &img, d.path(), true, 0.0, &mut |_| {}).unwrap();
        assert!(q.extension().is_some_and(|e| e == "png") && q.is_file());
    }
}
