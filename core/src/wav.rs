//! WAV の長さ取得・連結。エンジンごとに出力形式（サンプルレート等）が違うので、
//! 連結は同じ形式同士に限る。最終的な形式の統一は書き出し時に FFmpeg が行う。

use crate::{Error, Result};
use std::path::Path;

/// WAV の長さ（ミリ秒、切り上げ）
pub fn duration_ms(path: &Path) -> Result<u64> {
    let r = hound::WavReader::open(path)?;
    let spec = r.spec();
    let frames = r.duration() as u64; // チャンネルあたりのサンプル数
    Ok((frames * 1000).div_ceil(spec.sample_rate as u64))
}

/// 複数の WAV を順に連結する。`gap_ms` だけ無音を挟む（分割合成のつなぎ目用）。
pub fn concat(inputs: &[impl AsRef<Path>], gap_ms: u32, out: &Path) -> Result<()> {
    let first = inputs.first().ok_or_else(|| Error::Other("連結する WAV がありません".into()))?;
    let spec = hound::WavReader::open(first.as_ref())?.spec();
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(Error::Other(format!("16bit PCM 以外の WAV は連結できません: {spec:?}")));
    }
    let tmp = out.with_extension("wav.part");
    {
        let mut w = hound::WavWriter::create(&tmp, spec)?;
        let gap_samples = (spec.sample_rate as u64 * gap_ms as u64 / 1000) * spec.channels as u64;
        for (i, p) in inputs.iter().enumerate() {
            let mut r = hound::WavReader::open(p.as_ref())?;
            if r.spec() != spec {
                return Err(Error::Other(format!("WAV の形式が揃っていません: {:?}", p.as_ref())));
            }
            if i > 0 {
                for _ in 0..gap_samples {
                    w.write_sample(0i16)?;
                }
            }
            for s in r.samples::<i16>() {
                w.write_sample(s?)?;
            }
        }
        w.finalize()?;
    }
    std::fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn write_tone(path: &Path, sample_rate: u32, ms: u32, freq: f32) {
    let spec = hound::WavSpec { channels: 1, sample_rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    let n = sample_rate as u64 * ms as u64 / 1000;
    for i in 0..n {
        let t = i as f32 / sample_rate as f32;
        w.write_sample(((t * freq * std::f32::consts::TAU).sin() * 12000.0) as i16).unwrap();
    }
    w.finalize().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concat_with_gap() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a.wav");
        let b = d.path().join("b.wav");
        write_tone(&a, 24000, 500, 440.0);
        write_tone(&b, 24000, 250, 660.0);
        let out = d.path().join("out.wav");
        concat(&[&a, &b], 100, &out).unwrap();
        assert_eq!(duration_ms(&out).unwrap(), 850);
    }

    #[test]
    fn concat_rejects_mismatch() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a.wav");
        let b = d.path().join("b.wav");
        write_tone(&a, 24000, 100, 440.0);
        write_tone(&b, 48000, 100, 440.0);
        assert!(concat(&[&a, &b], 0, &d.path().join("o.wav")).is_err());
    }
}
