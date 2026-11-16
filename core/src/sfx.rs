//! 効果音集：アプリの中で ffmpeg の式から作る短い効果音（外から素材を取ってこない）。
//! 一度作ったらフォルダに残しておき、素材として置く（書き出しは普通の音声素材と同じ）。

use crate::Result;
use std::path::{Path, PathBuf};

/// 効果音（名前、表示名、ffmpeg の作り方 = lavfi の入力とフィルター）
pub const SFX: &[(&str, &str, &str, &str)] = &[
    ("pop", "ポン", "aevalsrc='0.8*sin(2*PI*(900*t-1800*t*t))*exp(-22*t)':d=0.2", "anull"),
    ("ding", "ピコン", "aevalsrc='0.5*sin(2*PI*1320*t)*exp(-9*t)*lt(t,0.11)+0.5*sin(2*PI*1760*(t-0.1))*exp(-6*(t-0.1))*gte(t,0.1)':d=0.6", "anull"),
    ("whoosh", "シュッ", "aevalsrc='(random(0)*2-1)*pow(sin(PI*t/0.45),2)':d=0.45", "highpass=f=700,lowpass=f=5000,volume=0.8"),
    ("boom", "ドン", "aevalsrc='0.9*sin(2*PI*(85*t-25*t*t))*exp(-5*t)+0.35*(random(0)*2-1)*exp(-35*t)':d=0.9", "lowpass=f=500"),
    ("sparkle", "キラーン", "aevalsrc='0.3*(sin(2*PI*2093*t)*exp(-6*t)+sin(2*PI*2637*(t-0.07))*exp(-6*(t-0.07))*gte(t,0.07)+sin(2*PI*3136*(t-0.14))*exp(-5*(t-0.14))*gte(t,0.14)+sin(2*PI*4186*(t-0.21))*exp(-4*(t-0.21))*gte(t,0.21))':d=1.0", "anull"),
    ("buzzer", "ブブー", "aevalsrc='0.35*sgn(sin(2*PI*150*t))*(lt(t,0.22)+gte(t,0.3))':d=0.8", "lowpass=f=2500"),
    ("click", "カチッ", "aevalsrc='(random(0)*2-1)*exp(-300*t)':d=0.05", "highpass=f=1500"),
    ("chime", "ピンポーン", "aevalsrc='0.5*sin(2*PI*659*t)*exp(-3*t)*lt(t,0.5)+0.5*sin(2*PI*523*(t-0.45))*exp(-2.5*(t-0.45))*gte(t,0.45)':d=1.6", "anull"),
    ("stinger", "ジャーン", "aevalsrc='0.2*(sin(2*PI*262*t)+sin(2*PI*330*t)+sin(2*PI*392*t)+sin(2*PI*523*t)+0.4*sin(2*PI*784*t))*exp(-1.3*t)':d=2.5", "anull"),
    ("shock", "ガーン", "aevalsrc='0.4*(sin(2*PI*196*t)*lt(t,0.3)+sin(2*PI*185*(t-0.3))*gte(t,0.3)*lt(t,0.6)+sin(2*PI*147*(t-0.6))*gte(t,0.6)*exp(-1.5*(t-0.6)))':d=1.8", "anull"),
];

/// 効果音のファイル（なければ作る）
pub fn make_sfx(ffmpeg: &Path, root: &Path, name: &str) -> Result<PathBuf> {
    let Some((id, label, src, af)) = SFX.iter().find(|s| s.0 == name) else {
        return Err(crate::Error::Other(format!("効果音 {name} はありません")));
    };
    let dst = root.join(format!("{label}（{id}）.wav"));
    if dst.is_file() {
        return Ok(dst);
    }
    std::fs::create_dir_all(root)?;
    let tmp = root.join(format!("{id}.part.wav"));
    let out = crate::tts::hidden_command(ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("{src}:s=48000"), "-af", &format!("{af},aformat=channel_layouts=stereo"), "-c:a", "pcm_s16le"])
        .arg(&tmp)
        .output()?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(crate::Error::Other(format!("効果音を作れません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    std::fs::rename(&tmp, &dst)?;
    Ok(dst)
}

/// 動画の場面の変わり目（秒、素材の頭から）。threshold は 0〜1（大きいほど大きな変化だけ）
pub fn detect_scenes(ffmpeg: &Path, src: &Path, threshold: f64) -> Result<Vec<f64>> {
    let out = crate::tts::hidden_command(ffmpeg)
        .args(["-v", "info", "-nostats", "-i"])
        .arg(src)
        .args(["-an", "-vf", &format!("scale=320:-2,select='gt(scene,{:.3})',showinfo", threshold.clamp(0.05, 0.95)), "-f", "null", "-"])
        .output()?;
    if !out.status.success() {
        return Err(crate::Error::Other(format!("動画を読めません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    let text = String::from_utf8_lossy(&out.stderr);
    Ok(text
        .lines()
        .filter(|l| l.contains("showinfo") && l.contains("pts_time:"))
        .filter_map(|l| l.split("pts_time:").nth(1)?.split_whitespace().next()?.parse::<f64>().ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sfx_renders() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        for (id, _, _, _) in SFX {
            let p = make_sfx(Path::new("ffmpeg"), d.path(), id).unwrap();
            assert!(std::fs::metadata(&p).unwrap().len() > 1000, "{id}");
            // 2 回目は作らずに同じファイル
            assert_eq!(make_sfx(Path::new("ffmpeg"), d.path(), id).unwrap(), p);
        }
        assert!(make_sfx(Path::new("ffmpeg"), d.path(), "nope").is_err());
    }

    #[test]
    fn scene_cuts_of_a_two_color_video() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("s.mp4");
        // 1 秒ごとに赤 → 青 → 緑
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=1", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=1", "-f", "lavfi", "-i", "color=c=green:s=160x90:r=30:d=1", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let s = detect_scenes(Path::new("ffmpeg"), &src, 0.3).unwrap();
        assert_eq!(s.len(), 2, "{s:?}");
        assert!((s[0] - 1.0).abs() < 0.05 && (s[1] - 2.0).abs() < 0.05, "{s:?}");
    }
}
