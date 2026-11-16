//! 動画素材のプロキシ（プレビュー用の軽い代わり）。
//! 高さ 360px・キーフレーム間隔 0.5 秒の H.264 にしておくと、WebView でのシークと再生が軽くなる。
//! 書き出しには使わない（書き出しは元の素材から作る）。

use crate::Result;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// キャッシュの名前。元ファイルのパス・大きさ・更新日時から作るので、素材を差し替えると作り直しになる
pub fn proxy_key(src: &Path) -> Result<String> {
    let meta = std::fs::metadata(src)?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let mut h = Sha256::new();
    h.update(b"proxy-v1|");
    h.update(src.to_string_lossy().as_bytes());
    h.update(format!("|{}|{}", meta.len(), mtime).as_bytes());
    Ok(h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect())
}

pub fn proxy_path(root: &Path, src: &Path) -> Result<PathBuf> {
    Ok(root.join(format!("{}.mp4", proxy_key(src)?)))
}

/// 手ぶれを補正したプロキシ（手ぶれ補正を付けた素材のプレビュー用。書き出しと同じ deshake を掛ける）
pub fn stabilized_path(root: &Path, src: &Path) -> Result<PathBuf> {
    Ok(root.join(format!("{}-stab.mp4", proxy_key(src)?)))
}

pub fn proxy_args(src: &Path, dst: &Path) -> Vec<String> {
    proxy_args_with(src, dst, false)
}

fn proxy_args_with(src: &Path, dst: &Path, stabilize: bool) -> Vec<String> {
    let vf = format!("{}scale=-2:'min(360,ih)',format=yuv420p", if stabilize { "deshake," } else { "" });
    [
        "-hide_banner", "-y", "-i",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([src.to_string_lossy().into_owned()])
    .chain(
        [
            "-vf", "@VF",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
            // キーフレームを細かく入れてシークを速くする
            "-force_key_frames", "expr:gte(t,n_forced*0.5)",
            "-c:a", "aac", "-b:a", "96k", "-ac", "2",
            "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats",
        ]
        .iter()
        .map(|s| s.to_string()),
    )
    .chain([dst.to_string_lossy().into_owned()])
    .map(|a| if a == "@VF" { vf.clone() } else { a })
    .collect()
}

/// プロキシを作る。できていれば何もしない。`on_progress` には 0.0〜1.0
pub fn make_proxy(ffmpeg: &Path, src: &Path, root: &Path, duration_secs: f64, on_progress: &mut dyn FnMut(f64)) -> Result<PathBuf> {
    make_proxy_with(ffmpeg, src, root, duration_secs, false, on_progress)
}

/// プロキシを作る（stabilize なら手ぶれを補正したもの）
pub fn make_proxy_with(ffmpeg: &Path, src: &Path, root: &Path, duration_secs: f64, stabilize: bool, on_progress: &mut dyn FnMut(f64)) -> Result<PathBuf> {
    let dst = if stabilize { stabilized_path(root, src)? } else { proxy_path(root, src)? };
    if dst.is_file() {
        on_progress(1.0);
        return Ok(dst);
    }
    std::fs::create_dir_all(root)?;
    let tmp = dst.with_extension("part.mp4");
    let r = crate::render::run(&proxy_args_with(src, &tmp, stabilize), ffmpeg, duration_secs, on_progress);
    if let Err(e) = r {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, &dst)?;
    Ok(dst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_changes_when_file_changes() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("a.mp4");
        std::fs::write(&f, b"1").unwrap();
        let k1 = proxy_key(&f).unwrap();
        assert_eq!(k1, proxy_key(&f).unwrap());
        std::fs::write(&f, b"12").unwrap();
        assert_ne!(k1, proxy_key(&f).unwrap());
    }

    #[test]
    fn makes_small_proxy_when_ffmpeg_available() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("src.mp4");
        let st = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest"])
            .arg(&src)
            .status()
            .unwrap();
        assert!(st.success());
        let mut last = 0.0;
        let root = d.path().join("proxy");
        let out = make_proxy(Path::new("ffmpeg"), &src, &root, 2.0, &mut |x| last = x).unwrap();
        assert_eq!(last, 1.0);
        let probe = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0"])
            .arg(&out)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "360");
        // 2 回目は作らずに同じパス
        assert_eq!(make_proxy(Path::new("ffmpeg"), &src, &root, 2.0, &mut |_| {}).unwrap(), out);
        // 手ぶれ補正したプロキシは別のファイル
        let stab = make_proxy_with(Path::new("ffmpeg"), &src, &root, 2.0, true, &mut |_| {}).unwrap();
        assert!(stab.is_file() && stab != out);
    }
}
