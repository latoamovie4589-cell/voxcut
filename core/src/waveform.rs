//! タイムライン表示用の波形ピーク。UI には WAV 本体ではなく、これだけを渡す。

use crate::Result;
use std::path::Path;

/// `buckets_per_sec` 個/秒の (min, max) を -127..=127 に量子化して返す。
/// 戻り値は [min0, max0, min1, max1, ...] の並び。
pub fn peaks(path: &Path, buckets_per_sec: u32) -> Result<Vec<i8>> {
    let mut r = hound::WavReader::open(path)?;
    let spec = r.spec();
    let ch = spec.channels as usize;
    let per_bucket = ((spec.sample_rate / buckets_per_sec.max(1)).max(1) as usize) * ch;
    let scale = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, _) => 1.0f32,
        (_, b) => (1i64 << (b - 1)) as f32,
    };
    let mut out = Vec::new();
    let (mut lo, mut hi, mut n) = (0f32, 0f32, 0usize);
    let push = |v: f32, out: &mut Vec<i8>, lo: &mut f32, hi: &mut f32, n: &mut usize| {
        *lo = lo.min(v);
        *hi = hi.max(v);
        *n += 1;
        if *n == per_bucket {
            out.push((*lo * 127.0).round().clamp(-127.0, 127.0) as i8);
            out.push((*hi * 127.0).round().clamp(-127.0, 127.0) as i8);
            *lo = 0.0;
            *hi = 0.0;
            *n = 0;
        }
    };
    match spec.sample_format {
        hound::SampleFormat::Float => {
            for s in r.samples::<f32>() {
                push(s?, &mut out, &mut lo, &mut hi, &mut n);
            }
        }
        hound::SampleFormat::Int => {
            for s in r.samples::<i32>() {
                push(s? as f32 / scale, &mut out, &mut lo, &mut hi, &mut n);
            }
        }
    }
    if n > 0 {
        out.push((lo * 127.0).round() as i8);
        out.push((hi * 127.0).round() as i8);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_count_and_range() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.wav");
        crate::wav::write_tone(&p, 24000, 1000, 220.0);
        let pk = peaks(&p, 100).unwrap();
        assert_eq!(pk.len(), 200);
        let max = pk.iter().copied().max().unwrap();
        // 振幅 12000/32768 ≒ 0.366 → 約 46
        assert!((44..=48).contains(&max), "max={max}");
    }
}
