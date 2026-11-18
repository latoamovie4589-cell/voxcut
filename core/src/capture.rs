//! 画面録画：ブラウザの MediaRecorder が作った WebM は長さが書かれておらず、編集ソフトで扱いにくい。
//! FFmpeg で詰め直して（中身はそのまま）長さを書き込み、タイムラインに置ける動画にする。

use crate::tts::hidden_command;
use crate::Result;
use std::path::{Path, PathBuf};

/// WebM（EBML の頭）か MP4（ftyp）か
pub fn looks_like_video(b: &[u8]) -> bool {
    b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) || (b.len() > 8 && &b[4..8] == b"ftyp")
}

/// 録った動画 raw を out へ詰め直す。うまくいかなければ raw をそのまま使う（返すのは使うファイル）
pub fn finish(ffmpeg: &Path, raw: &Path, out: &Path) -> Result<PathBuf> {
    let st = hidden_command(ffmpeg).args(["-nostdin", "-v", "error", "-y", "-fflags", "+genpts", "-i"]).arg(raw).args(["-c", "copy"]).arg(out).output();
    if matches!(st, Ok(ref o) if o.status.success()) && out.is_file() {
        let _ = std::fs::remove_file(raw);
        return Ok(out.to_path_buf());
    }
    let _ = std::fs::remove_file(out);
    Ok(raw.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remuxes_webm_with_real_ffmpeg() {
        let d = tempfile::tempdir().unwrap();
        let raw = d.path().join("raw.webm");
        let ok = std::process::Command::new("ffmpeg")
            .args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=64x36:r=10:d=1", "-f", "lavfi", "-i", "sine=d=1", "-c:v", "libvpx", "-c:a", "libopus", "-shortest"])
            .arg(&raw)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok);
        assert!(looks_like_video(&std::fs::read(&raw).unwrap()));
        assert!(!looks_like_video(b"RIFF....WAVE"));
        let out = finish(Path::new("ffmpeg"), &raw, &d.path().join("画面録画.webm")).unwrap();
        assert!(out.ends_with("画面録画.webm") && out.is_file() && !raw.exists());
        // 壊れたものは、そのまま返す
        let bad = d.path().join("bad.webm");
        std::fs::write(&bad, [0x1A, 0x45, 0xDF, 0xA3, 0, 0]).unwrap();
        assert_eq!(finish(Path::new("ffmpeg"), &bad, &d.path().join("x.webm")).unwrap(), bad);
    }
}
