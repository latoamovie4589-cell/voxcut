//! 立ち絵の口パク・目パチ。フレームごとの状態を決める。
//!
//! 画面側（app/src/lipsync.ts）にも同じ計算があり、プレビューと書き出しで同じ動きになる。
//! どちらかを変えたら、もう一方とテスト（PARITY の期待値）も合わせて変えること。

use crate::model::{Character, ClipBody, Frame, Project};

/// 波形ピークの解像度（waveform::peaks に渡す値と揃える）
pub const PEAKS_PER_SEC: u32 = 100;
/// クリップ内の最大音量に対する割合で口の開きを決める
const MOUTH_HALF: f64 = 0.2;
const MOUTH_OPEN: f64 = 0.5;

pub const EYES_OPEN: u8 = 0;
pub const EYES_HALF: u8 = 1;
pub const EYES_CLOSED: u8 = 2;
pub const MOUTH_CLOSED: u8 = 0;
pub const MOUTH_HALFOPEN: u8 = 1;
pub const MOUTH_OPENED: u8 = 2;

/// 1 フレームの状態
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PortraitState {
    pub eyes: u8,
    pub mouth: u8,
    /// 表情（0 は通常、1 以降は Portrait.expressions の番号 + 1）
    pub expr: u8,
}

impl PortraitState {
    pub fn index(&self) -> usize {
        self.expr as usize * 9 + self.eyes as usize * 3 + self.mouth as usize
    }
}

/// 32bit FNV-1a（UTF-8 バイト列）
pub fn fnv1a(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

struct XorShift(u32);
impl XorShift {
    fn new(seed: u32) -> Self {
        Self(if seed == 0 { 0x9E37_79B9 } else { seed })
    }
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
}

/// 目パチ：キャラクター ID から決まる疑似乱数で、2.5〜5.5 秒ごとに瞬きする
pub fn blink_track(character_id: &str, fps: u32, total: Frame) -> Vec<u8> {
    let total = total.max(0) as usize;
    let mut out = vec![EYES_OPEN; total];
    let mut rng = XorShift::new(fnv1a(character_id));
    let step = ((fps as f64 / 15.0).round() as usize).max(1); // 30fps なら 2 フレームずつ
    let mut t: usize = 0;
    loop {
        let interval_ms = 2500 + (rng.next() % 3000) as usize;
        t += (interval_ms * fps as usize).div_ceil(1000);
        if t >= total {
            break;
        }
        for (k, state) in [EYES_HALF, EYES_CLOSED, EYES_HALF].into_iter().enumerate() {
            for j in 0..step {
                if let Some(slot) = out.get_mut(t + k * step + j) {
                    *slot = state;
                }
            }
        }
    }
    out
}

/// 口パク：そのキャラクターのセリフの音量から、フレームごとの口の開きを決める
/// `peaks_for` はキャッシュキー → 波形ピーク（[min, max] の並び、PEAKS_PER_SEC 個/秒）
pub fn mouth_track(p: &Project, character: &Character, total: Frame, peaks_for: &dyn Fn(&str) -> Option<Vec<i8>>) -> Vec<u8> {
    let total = total.max(0) as usize;
    let mut out = vec![MOUTH_CLOSED; total];
    let fps = p.video.fps as f64;
    let muted: std::collections::HashSet<&str> = p.tracks.iter().filter(|t| t.muted).map(|t| t.id.as_str()).collect();
    for c in &p.clips {
        let ClipBody::Voice(v) = &c.body else { continue };
        if v.character_id != character.id || muted.contains(c.track_id.as_str()) {
            continue;
        }
        let Some(audio) = &v.audio else { continue };
        let Some(pk) = peaks_for(&audio.cache_key) else { continue };
        let states = mouth_states_for_clip(&pk, c.duration, fps);
        for (i, s) in states.into_iter().enumerate() {
            if let Some(slot) = out.get_mut(c.start as usize + i) {
                *slot = (*slot).max(s);
            }
        }
    }
    out
}

/// 1 クリップ分の口の状態（クリップ先頭からのフレーム順）
pub fn mouth_states_for_clip(peaks: &[i8], duration: Frame, fps: f64) -> Vec<u8> {
    let n = peaks.len() / 2;
    let level = |i: usize| (peaks[i * 2] as i32).abs().max((peaks[i * 2 + 1] as i32).abs());
    let max = (0..n).map(level).max().unwrap_or(0);
    let mut out = Vec::with_capacity(duration.max(0) as usize);
    for f in 0..duration.max(0) {
        if max == 0 {
            out.push(MOUTH_CLOSED);
            continue;
        }
        let a = ((f as f64 / fps) * PEAKS_PER_SEC as f64).floor() as usize;
        let b = (((f + 1) as f64 / fps) * PEAKS_PER_SEC as f64).floor() as usize;
        let lv = (a..b.max(a + 1)).filter(|&i| i < n).map(level).max().unwrap_or(0) as f64 / max as f64;
        out.push(if lv >= MOUTH_OPEN {
            MOUTH_OPENED
        } else if lv >= MOUTH_HALF {
            MOUTH_HALFOPEN
        } else {
            MOUTH_CLOSED
        });
    }
    out
}

/// 表情：そのキャラクターのセリフの間だけ、セリフで選んだ表情にする
pub fn expression_track(p: &Project, character: &Character, total: Frame) -> Vec<u8> {
    let total = total.max(0) as usize;
    let mut out = vec![0u8; total];
    let Some(pt) = &character.portrait else { return out };
    let muted: std::collections::HashSet<&str> = p.tracks.iter().filter(|t| t.muted).map(|t| t.id.as_str()).collect();
    for c in &p.clips {
        let ClipBody::Voice(v) = &c.body else { continue };
        if v.character_id != character.id || muted.contains(c.track_id.as_str()) {
            continue;
        }
        let e = pt.expression_index(v.expression.as_deref());
        if e == 0 {
            continue;
        }
        let (a, b) = (c.start.max(0) as usize, (c.end().max(0) as usize).min(total));
        if a < b {
            out[a..b].fill(e);
        }
    }
    out
}

/// 立ち絵のあるキャラクターについて、フレームごとの状態を作る
pub fn portrait_track(p: &Project, character: &Character, total: Frame, peaks_for: &dyn Fn(&str) -> Option<Vec<i8>>) -> Vec<PortraitState> {
    let eyes = blink_track(&character.id, p.video.fps, total);
    let mouth = mouth_track(p, character, total, peaks_for);
    let expr = expression_track(p, character, total);
    eyes.into_iter().zip(mouth).zip(expr).map(|((eyes, mouth), expr)| PortraitState { eyes, mouth, expr }).collect()
}

/// 同じ状態が続く区間にまとめる（ffconcat の行数を減らす）
pub fn runs(states: &[PortraitState]) -> Vec<(PortraitState, usize)> {
    let mut out: Vec<(PortraitState, usize)> = vec![];
    for s in states {
        match out.last_mut() {
            Some((last, n)) if last == s => *n += 1,
            _ => out.push((*s, 1)),
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// TS 側（app/scripts/check-lipsync.ts）と同じ期待値
    pub const PARITY_BLINK_FRAMES: [usize; 4] = [164, 281, 390, 500];

    #[test]
    fn fnv_known_values() {
        assert_eq!(fnv1a(""), 0x811c9dc5);
        assert_eq!(fnv1a("a"), 0xe40c292c);
        assert_eq!(fnv1a("ch_a"), fnv1a("ch_a"));
    }

    #[test]
    fn blink_is_deterministic_and_shaped() {
        let a = blink_track("ch_a", 30, 600);
        assert_eq!(a, blink_track("ch_a", 30, 600));
        assert_ne!(a, blink_track("ch_b", 30, 600));
        // 瞬きの始まり（開→半目）の位置
        let starts: Vec<usize> = (1..a.len()).filter(|&i| a[i - 1] == EYES_OPEN && a[i] == EYES_HALF).collect();
        assert_eq!(starts, PARITY_BLINK_FRAMES, "TS 側の期待値も合わせて更新すること");
        // 半目2 → 閉2 → 半目2
        let s = starts[0];
        assert_eq!(&a[s..s + 6], &[1, 1, 2, 2, 1, 1]);
    }

    #[test]
    fn mouth_follows_volume() {
        // 100ms 無音 → 100ms 小 → 100ms 大（ピークは 10ms ごと）
        let mut pk = vec![];
        for lv in [0i8, 20, 100] {
            for _ in 0..10 {
                pk.push(-lv);
                pk.push(lv);
            }
        }
        let s = mouth_states_for_clip(&pk, 9, 30.0);
        assert_eq!(s, vec![0, 0, 0, 1, 1, 1, 2, 2, 2]);
        assert_eq!(mouth_states_for_clip(&[], 3, 30.0), vec![0, 0, 0]);
    }

    #[test]
    fn expression_only_during_its_line() {
        use crate::model::{Expression, Portrait, Transform};
        let mut p = Project::sample();
        p.characters[0].portrait = Some(Portrait {
            base: "b.png".into(),
            eyes: Default::default(),
            mouth: Default::default(),
            transform: Transform::default(),
            visible: true,
            expressions: vec![Expression { name: "怒り".into(), ..Default::default() }],
        });
        // c1（0〜84）だけ怒り、c3 は表情なし
        p.clips[0].as_voice_mut().unwrap().expression = Some("怒り".into());
        let t = expression_track(&p, &p.characters[0], 300);
        assert_eq!((t[0], t[83], t[84], t[200]), (1, 1, 0, 0));
        let st = portrait_track(&p, &p.characters[0], 300, &|_| None);
        assert_eq!(st[10].expr, 1);
        assert_eq!(st[10].index(), 9);
    }

    #[test]
    fn runs_compress() {
        let a = PortraitState { eyes: 0, mouth: 0, expr: 0 };
        let b = PortraitState { eyes: 0, mouth: 2, expr: 0 };
        assert_eq!(runs(&[a, a, b, b, b, a]), vec![(a, 2), (b, 3), (a, 1)]);
    }
}
