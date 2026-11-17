//! モーショントラッキング：動画の中の 1 点（その周りの模様）を、コマごとに探して追う。
//! 文字やスタンプをその点に付いて動かすのに使う。

use crate::Result;
use serde::Serialize;
use std::path::Path;

/// 追った位置（素材の t 秒目に、横 x・縦 y。0〜1）。score は似ている度合い（1 に近いほど確か）
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct TrackPoint {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub score: f64,
}

/// 追うときの 1 秒あたりのコマ数と、調べる画像の幅
pub const TRACK_FPS: u32 = 15;
const WIDTH: usize = 320;

/// 白黒のコマ（幅 w・高さ h）の並びで、(x, y)（px）の周りの模様を追う。half は模様の大きさの半分（px）
pub fn track_frames(frames: &[&[u8]], w: usize, h: usize, x: f64, y: f64, half: usize, reach: usize) -> Vec<(f64, f64, f64)> {
    let half = half.max(3).min(w.min(h) / 3);
    let patch = |f: &[u8], cx: usize, cy: usize| -> Vec<f64> {
        let mut out = Vec::with_capacity((2 * half + 1).pow(2));
        for dy in 0..=2 * half {
            for dx in 0..=2 * half {
                out.push(f[(cy + dy - half) * w + (cx + dx - half)] as f64);
            }
        }
        out
    };
    let clampc = |v: f64, n: usize| (v.round() as isize).clamp(half as isize, (n - 1 - half) as isize) as usize;
    let (mut cx, mut cy) = (clampc(x, w), clampc(y, h));
    let Some(first) = frames.first() else { return vec![] };
    let mut tpl = patch(first, cx, cy);
    let mut out = vec![(cx as f64, cy as f64, 1.0)];
    // 正規化相互相関（明るさが変わっても追える）
    let ncc = |a: &[f64], b: &[f64]| -> f64 {
        let n = a.len() as f64;
        let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
        let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
        for (p, q) in a.iter().zip(b) {
            num += (p - ma) * (q - mb);
            da += (p - ma).powi(2);
            db += (q - mb).powi(2);
        }
        if da < 1e-6 || db < 1e-6 {
            return 0.0;
        }
        num / (da * db).sqrt()
    };
    // 前のコマからの動き（次のコマの予想に使う）
    let (mut vx, mut vy) = (0.0f64, 0.0f64);
    for f in &frames[1..] {
        let (px, py) = ((cx as f64 + vx).round(), (cy as f64 + vy).round());
        let (px, py) = (clampc(px, w), clampc(py, h));
        let r = reach as isize;
        let mut best = (f64::MIN, px, py);
        for dy in -r..=r {
            for dx in -r..=r {
                let (qx, qy) = (px as isize + dx, py as isize + dy);
                if qx < half as isize || qy < half as isize || qx > (w - 1 - half) as isize || qy > (h - 1 - half) as isize {
                    continue;
                }
                let s = ncc(&tpl, &patch(f, qx as usize, qy as usize));
                if s > best.0 {
                    best = (s, qx as usize, qy as usize);
                }
            }
        }
        let (s, nx, ny) = best;
        // 見失ったら（似ていない）、その場に留まる
        if s > 0.5 {
            vx = 0.6 * vx + 0.4 * (nx as f64 - cx as f64);
            vy = 0.6 * vy + 0.4 * (ny as f64 - cy as f64);
            cx = nx;
            cy = ny;
            // 見た目の変化に少しずつ合わせる
            let now = patch(f, cx, cy);
            for (t, n) in tpl.iter_mut().zip(now) {
                *t = *t * 0.85 + n * 0.15;
            }
        } else {
            vx = 0.0;
            vy = 0.0;
        }
        out.push((cx as f64, cy as f64, s.max(0.0)));
    }
    out
}

/// 素材の from 秒目から to 秒目まで、(x, y)（0〜1）の点を追う。size は模様の大きさ（幅に対する割合）
#[allow(clippy::too_many_arguments)]
pub fn track(ffmpeg: &Path, src: &Path, from: f64, to: f64, x: f64, y: f64, size: f64, on_progress: &mut dyn FnMut(f64)) -> Result<Vec<TrackPoint>> {
    let (sw, sh) = crate::ai::probe_size_of(ffmpeg, src).ok_or_else(|| crate::Error::Other("動画の大きさが分かりません".into()))?;
    let w = WIDTH;
    let h = (((WIDTH as f64 * sh as f64 / sw as f64) / 2.0).round() as usize * 2).max(16);
    let dur = (to - from).max(1.0 / TRACK_FPS as f64);
    let out = crate::tts::hidden_command(ffmpeg)
        .args(["-v", "error", "-ss", &format!("{from:.3}"), "-t", &format!("{dur:.3}"), "-i"])
        .arg(src)
        .args(["-vf", &format!("fps={TRACK_FPS},scale={w}:{h}:flags=area,format=gray"), "-f", "rawvideo", "-"])
        .output()?;
    if !out.status.success() {
        return Err(crate::Error::Other(format!("動画を読めません: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    on_progress(0.3);
    let frames: Vec<&[u8]> = out.stdout.chunks_exact(w * h).collect();
    let half = ((size * w as f64) / 2.0).round().max(4.0) as usize;
    let pts = track_frames(&frames, w, h, x * w as f64, y * h as f64, half, 12);
    on_progress(1.0);
    Ok(pts.into_iter().enumerate().map(|(i, (px, py, s))| TrackPoint { t: from + i as f64 / TRACK_FPS as f64, x: px / w as f64, y: py / h as f64, score: s }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 動く四角の模様を追える
    #[test]
    fn follows_a_moving_pattern() {
        let (w, h) = (80usize, 60usize);
        let frames: Vec<Vec<u8>> = (0..20)
            .map(|i| {
                let mut f = vec![40u8; w * h];
                let (ox, oy) = (10 + i * 2, 20 + i);
                for y in 0..8 {
                    for x in 0..8 {
                        f[(oy + y) * w + ox + x] = if (x / 2 + y / 2) % 2 == 0 { 250 } else { 120 };
                    }
                }
                f
            })
            .collect();
        let refs: Vec<&[u8]> = frames.iter().map(|f| f.as_slice()).collect();
        let pts = track_frames(&refs, w, h, 14.0, 24.0, 5, 8);
        assert_eq!(pts.len(), 20);
        let (x, y, s) = pts[19];
        assert!((x - (14.0 + 38.0)).abs() <= 1.0 && (y - (24.0 + 19.0)).abs() <= 1.0, "{x},{y}");
        assert!(s > 0.8);
    }

    /// 本物の動画（ffmpeg で作る）でも追える
    #[test]
    fn tracks_in_a_video() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("mv.mp4");
        assert!(std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x305030:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "testsrc=s=48x48:r=30:d=2", "-filter_complex", "[0][1]overlay=x='100+t*150':y='100+t*40'", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let pts = track(Path::new("ffmpeg"), &src, 0.0, 1.5, 124.0 / 640.0, 124.0 / 360.0, 0.06, &mut |_| {}).unwrap();
        let last = pts.last().unwrap();
        let (ex, ey) = ((124.0 + last.t * 150.0) / 640.0, (124.0 + last.t * 40.0) / 360.0);
        assert!((last.x - ex).abs() < 0.02 && (last.y - ey).abs() < 0.03, "{last:?} / {ex},{ey}");
    }
}
