//! LUT（.cube の 3D LUT）。書き出しは ffmpeg の lut3d でそのまま使う。
//! 画面（プレビュー）は動画の画素を読めないので、色の混ぜ方（3×4 の行列）＋色ごとの曲線（17 点の表）に近づけて SVG フィルターで掛ける。

#![allow(clippy::needless_range_loop)]

use crate::Result;
use serde::Serialize;
use std::path::Path;

/// 読んだ 3D LUT（R が一番速く変わる順。値は 0〜1 に直してある）
#[derive(Debug, Clone)]
pub struct Lut {
    pub size: usize,
    pub data: Vec<[f64; 3]>,
}

/// .cube の文字を読む（LUT_3D_SIZE・DOMAIN_MIN/MAX・TITLE とコメントに対応）
pub fn parse_cube(text: &str) -> Result<Lut> {
    let bad = |m: &str| crate::Error::Other(format!("LUT を読めません：{m}"));
    let mut size = 0usize;
    let (mut lo, mut hi) = ([0.0f64; 3], [1.0f64; 3]);
    let mut data = vec![];
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with("TITLE") {
            continue;
        }
        let mut it = l.split_whitespace();
        let head = it.next().unwrap_or("");
        let nums = |it: std::str::SplitWhitespace| -> Option<[f64; 3]> {
            let v: Vec<f64> = it.filter_map(|x| x.parse().ok()).collect();
            (v.len() == 3).then(|| [v[0], v[1], v[2]])
        };
        match head {
            "LUT_3D_SIZE" => size = it.next().and_then(|x| x.parse().ok()).ok_or_else(|| bad("大きさが分かりません"))?,
            "LUT_1D_SIZE" => return Err(bad("1D の LUT には対応していません（3D の .cube を使ってください）")),
            "DOMAIN_MIN" => lo = nums(it).ok_or_else(|| bad("DOMAIN_MIN"))?,
            "DOMAIN_MAX" => hi = nums(it).ok_or_else(|| bad("DOMAIN_MAX"))?,
            _ => {
                if let Ok(r) = head.parse::<f64>() {
                    let rest: Vec<f64> = it.filter_map(|x| x.parse().ok()).collect();
                    if rest.len() != 2 {
                        return Err(bad("数の並びがおかしい行があります"));
                    }
                    let v = [r, rest[0], rest[1]];
                    data.push([0, 1, 2].map(|c| ((v[c] - lo[c]) / (hi[c] - lo[c]).max(1e-9)).clamp(0.0, 1.0)));
                }
            }
        }
    }
    if !(2..=256).contains(&size) {
        return Err(bad("LUT_3D_SIZE がありません"));
    }
    if data.len() != size * size * size {
        return Err(bad(&format!("色の数が合いません（{} 個。{} 個のはず）", data.len(), size * size * size)));
    }
    Ok(Lut { size, data })
}

pub fn load(path: &Path) -> Result<Lut> {
    parse_cube(&std::fs::read_to_string(path)?)
}

impl Lut {
    fn at(&self, r: usize, g: usize, b: usize) -> [f64; 3] {
        self.data[r + g * self.size + b * self.size * self.size]
    }

    /// 色を変える（三線形補間。ffmpeg の lut3d の既定と同じ）
    pub fn apply(&self, c: [f64; 3]) -> [f64; 3] {
        let n = (self.size - 1) as f64;
        let p = c.map(|v| v.clamp(0.0, 1.0) * n);
        let i0 = p.map(|v| (v.floor() as usize).min(self.size - 2));
        let f = [p[0] - i0[0] as f64, p[1] - i0[1] as f64, p[2] - i0[2] as f64];
        let mut out = [0.0; 3];
        for (dr, wr) in [(0, 1.0 - f[0]), (1, f[0])] {
            for (dg, wg) in [(0, 1.0 - f[1]), (1, f[1])] {
                for (db, wb) in [(0, 1.0 - f[2]), (1, f[2])] {
                    let v = self.at(i0[0] + dr, i0[1] + dg, i0[2] + db);
                    let w = wr * wg * wb;
                    for k in 0..3 {
                        out[k] += v[k] * w;
                    }
                }
            }
        }
        out
    }
}

/// 画面用の近い形：まず行列（out = M·in + b）、その後に色ごとの曲線（0〜1 を 16 等分した 17 点）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LutFit {
    /// 3 行 × 4（R・G・B の重みと足す量）
    pub matrix: [f64; 12],
    pub tables: [Vec<f64>; 3],
}

pub const TABLE_POINTS: usize = 17;

/// 行列は最小二乗で、曲線は「行列の結果 → 本当の色」の平均で決める
pub fn fit(lut: &Lut) -> LutFit {
    // 調べる色（9×9×9）
    let n = 9;
    let mut samples = vec![];
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let c = [r as f64 / (n - 1) as f64, g as f64 / (n - 1) as f64, b as f64 / (n - 1) as f64];
                samples.push((c, lut.apply(c)));
            }
        }
    }
    // 正規方程式（4×4）を、出力の色ごとに解く
    let mut ata = [[0.0f64; 4]; 4];
    let mut atb = [[0.0f64; 4]; 3];
    for (c, o) in &samples {
        let x = [c[0], c[1], c[2], 1.0];
        for i in 0..4 {
            for j in 0..4 {
                ata[i][j] += x[i] * x[j];
            }
            for k in 0..3 {
                atb[k][i] += x[i] * o[k];
            }
        }
    }
    let mut matrix = [0.0; 12];
    for k in 0..3 {
        let w = solve4(ata, atb[k]);
        matrix[k * 4..k * 4 + 4].copy_from_slice(&w);
    }
    // 曲線：行列の結果の値ごとに、本当の値を平均する（空いたところは前後からつなぐ。端は動かさない）
    let m = TABLE_POINTS - 1;
    let tables = [0, 1, 2].map(|k| {
        let mut sum = [0.0; TABLE_POINTS];
        let mut cnt = [0.0; TABLE_POINTS];
        for (c, o) in &samples {
            let v = (matrix[k * 4] * c[0] + matrix[k * 4 + 1] * c[1] + matrix[k * 4 + 2] * c[2] + matrix[k * 4 + 3]).clamp(0.0, 1.0);
            let p = v * m as f64;
            let i = (p.floor() as usize).min(m - 1);
            let f = p - i as f64;
            sum[i] += o[k] * (1.0 - f);
            cnt[i] += 1.0 - f;
            sum[i + 1] += o[k] * f;
            cnt[i + 1] += f;
        }
        let mut t: Vec<Option<f64>> = (0..TABLE_POINTS).map(|i| (cnt[i] > 0.05).then(|| sum[i] / cnt[i])).collect();
        if t[0].is_none() {
            t[0] = Some(0.0);
        }
        if t[m].is_none() {
            t[m] = Some(1.0);
        }
        let mut out = [0.0; TABLE_POINTS];
        for i in 0..TABLE_POINTS {
            out[i] = match t[i] {
                Some(v) => v,
                None => {
                    let a = (0..i).rev().find(|&j| t[j].is_some()).unwrap();
                    let b = (i + 1..TABLE_POINTS).find(|&j| t[j].is_some()).unwrap();
                    let (va, vb) = (t[a].unwrap(), t[b].unwrap());
                    va + (vb - va) * (i - a) as f64 / (b - a) as f64
                }
            };
        }
        out.iter().map(|v| v.clamp(0.0, 1.0)).collect()
    });
    LutFit { matrix, tables }
}

/// 近い形で色を変える（画面と同じ計算。試験用）
pub fn apply_fit(f: &LutFit, c: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|k| {
        let v = (f.matrix[k * 4] * c[0] + f.matrix[k * 4 + 1] * c[1] + f.matrix[k * 4 + 2] * c[2] + f.matrix[k * 4 + 3]).clamp(0.0, 1.0);
        let t = &f.tables[k];
        let p = v * (TABLE_POINTS - 1) as f64;
        let i = (p.floor() as usize).min(TABLE_POINTS - 2);
        t[i] + (t[i + 1] - t[i]) * (p - i as f64)
    })
}

fn solve4(mut a: [[f64; 4]; 4], mut b: [f64; 4]) -> [f64; 4] {
    for i in 0..4 {
        a[i][i] += 1e-9;
    }
    for col in 0..4 {
        let piv = (col..4).max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs())).unwrap();
        a.swap(col, piv);
        b.swap(col, piv);
        let d = a[col][col];
        if d.abs() < 1e-12 {
            continue;
        }
        for r in 0..4 {
            if r != col {
                let k = a[r][col] / d;
                for c in 0..4 {
                    a[r][c] -= k * a[col][c];
                }
                b[r] -= k * b[col];
            }
        }
    }
    [0, 1, 2, 3].map(|i| if a[i][i].abs() < 1e-12 { 0.0 } else { b[i] / a[i][i] })
}

#[cfg(test)]
pub(crate) fn sample_cube(size: usize, f: impl Fn([f64; 3]) -> [f64; 3]) -> String {
    let mut s = format!("TITLE \"test\"\n# comment\nLUT_3D_SIZE {size}\n");
    let n = (size - 1) as f64;
    for b in 0..size {
        for g in 0..size {
            for r in 0..size {
                let o = f([r as f64 / n, g as f64 / n, b as f64 / n]);
                s.push_str(&format!("{:.6} {:.6} {:.6}\n", o[0], o[1], o[2]));
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_applies() {
        let l = parse_cube(&sample_cube(5, |c| [c[1], c[0], c[2]])).unwrap();
        let o = l.apply([0.2, 0.7, 0.4]);
        assert!((o[0] - 0.7).abs() < 1e-6 && (o[1] - 0.2).abs() < 1e-6 && (o[2] - 0.4).abs() < 1e-6);
        assert!(parse_cube("LUT_3D_SIZE 2\n0 0 0\n").is_err());
        assert!(parse_cube("LUT_1D_SIZE 4\n").is_err());
        let d = parse_cube("LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n2 0 0\n0 2 0\n2 2 0\n0 0 2\n2 0 2\n0 2 2\n2 2 2\n").unwrap();
        assert_eq!(d.apply([1.0, 1.0, 1.0]), [1.0, 1.0, 1.0]);
    }

    /// よくある LUT（色を混ぜる＋曲線）なら、近い形でもほぼ同じ色になる
    #[test]
    fn fit_is_close() {
        let warm = |c: [f64; 3]| {
            let m = [0.9 * c[0] + 0.15 * c[1], 0.05 * c[0] + 0.9 * c[1] + 0.05 * c[2], 0.1 * c[1] + 0.8 * c[2]];
            m.map(|v: f64| v.clamp(0.0, 1.0).powf(0.8))
        };
        let l = parse_cube(&sample_cube(17, warm)).unwrap();
        let f = fit(&l);
        let mut worst = 0.0f64;
        for c in [[0.1, 0.2, 0.3], [0.8, 0.5, 0.2], [0.5, 0.5, 0.5], [0.9, 0.9, 0.95], [0.3, 0.7, 0.6]] {
            let (a, b) = (l.apply(c), apply_fit(&f, c));
            for k in 0..3 {
                worst = worst.max((a[k] - b[k]).abs());
            }
        }
        assert!(worst < 0.04, "ずれ {worst}");
    }
}
