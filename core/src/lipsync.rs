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
    let audible = p.audible_tracks();
    for c in &p.clips {
        let ClipBody::Voice(v) = &c.body else { continue };
        // 「口パクしない」セリフは口を閉じたまま
        if v.character_id != character.id || !audible.contains(c.track_id.as_str()) || v.portrait.as_ref().is_some_and(|lp| lp.no_mouth) {
            continue;
        }
        let Some(audio) = &v.audio else { continue };
        let Some(pk) = peaks_for(&audio.cache_key) else { continue };
        // 再生開始位置で飛ばした頭の分は使わない
        let off = v.start_offset().max(0) as usize;
        let states = mouth_states_for_clip(&pk, c.duration + off as Frame, fps);
        for (i, s) in states.into_iter().skip(off).enumerate() {
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

/// セリフで「通常」をはっきり選んだときの値（立ち絵アイテムの既定の表情より優先して、通常の姿にする）
pub const BASE_EXPRESSION: &str = "@base";

/// 表情：既定は default（立ち絵アイテムの「既定の表情」）。そのキャラクターのセリフの間は、セリフで選んだ表情にする
/// （セリフで選んでいなければ既定のまま、「通常」を選んでいれば通常）
pub fn expression_track_with(p: &Project, character: &Character, total: Frame, default: u8) -> Vec<u8> {
    let total = total.max(0) as usize;
    let mut out = vec![default; total];
    let Some(pt) = &character.portrait else { return out };
    let audible = p.audible_tracks();
    let variants = line_variants(p, character);
    for c in &p.clips {
        let ClipBody::Voice(v) = &c.body else { continue };
        if v.character_id != character.id || !audible.contains(c.track_id.as_str()) {
            continue;
        }
        // セリフで立ち絵のレイヤーを変えていれば、その組み合わせ（表情の後ろに足した番号）
        let e = match variants.iter().find(|(id, _, _)| *id == c.id) {
            Some((_, idx, _)) => *idx,
            None => match v.expression.as_deref() {
                None => continue,
                Some(BASE_EXPRESSION) => 0,
                Some(name) => match pt.expression_index(Some(name)) {
                    0 => continue, // 消えた表情は既定のまま
                    e => e,
                },
            },
        };
        let (a, b) = (c.start.max(0) as usize, (c.end().max(0) as usize).min(total));
        if a < b {
            out[a..b].fill(e);
        }
    }
    out
}

/// その時点にかかる、そのキャラクターの立ち絵アイテムの既定の表情（なければ通常）。clips の順で最初のもの
pub fn item_default_at(p: &Project, character: &Character, frame: Frame) -> u8 {
    let Some(pt) = &character.portrait else { return 0 };
    p.clips
        .iter()
        .find_map(|c| match &c.body {
            ClipBody::Portrait(pc) if pc.character_id == character.id && c.start <= frame && frame < c.end() => Some(pt.expression_index(pc.expression.as_deref())),
            _ => None,
        })
        .unwrap_or(0)
}

/// そのセリフの間の、もとになる表情の番号（セリフで選んだ表情。選んでいなければ立ち絵アイテムの既定の表情）
pub fn line_base_expression(p: &Project, character: &Character, clip: &crate::model::Clip) -> u8 {
    let Some(pt) = &character.portrait else { return 0 };
    let ClipBody::Voice(v) = &clip.body else { return 0 };
    let item = || item_default_at(p, character, clip.start);
    match v.expression.as_deref() {
        None => item(),
        Some(BASE_EXPRESSION) => 0,
        Some(name) => match pt.expression_index(Some(name)) {
            0 => item(),
            e => e,
        },
    }
}

/// セリフで立ち絵のレイヤーの表示を変えたもの（clips の順）。表情の後ろに足した「表情」として番号を付ける：
/// (クリップ id, 番号 = 表情の数 + 1 + 順番, もとになる表情の番号)。画面側（app/src/model.ts の lineVariants）と同じ決め方
pub fn line_variants(p: &Project, character: &Character) -> Vec<(String, u8, u8)> {
    let Some(pt) = &character.portrait else { return vec![] };
    let first = pt.expressions.len() + 1;
    p.clips
        .iter()
        .filter(|c| matches!(&c.body, ClipBody::Voice(v) if v.character_id == character.id && v.portrait.as_ref().is_some_and(|lp| !lp.visibility.is_empty())))
        .enumerate()
        .filter(|(k, _)| first + k <= 255)
        .map(|(k, c)| (c.id.clone(), (first + k) as u8, line_base_expression(p, character, c)))
        .collect()
}

/// 表情（既定は通常）
pub fn expression_track(p: &Project, character: &Character, total: Frame) -> Vec<u8> {
    expression_track_with(p, character, total, 0)
}

/// 立ち絵のあるキャラクターについて、フレームごとの状態を作る
pub fn portrait_track(p: &Project, character: &Character, total: Frame, peaks_for: &dyn Fn(&str) -> Option<Vec<i8>>) -> Vec<PortraitState> {
    portrait_track_with(p, character, total, peaks_for, 0)
}

/// 既定の表情を指定して、フレームごとの状態を作る（立ち絵アイテムごと）
pub fn portrait_track_with(p: &Project, character: &Character, total: Frame, peaks_for: &dyn Fn(&str) -> Option<Vec<i8>>, default_expr: u8) -> Vec<PortraitState> {
    let mut eyes = blink_track(&character.id, p.video.fps, total);
    // 「目パチしない」セリフの間は目を開けたまま
    let audible = p.audible_tracks();
    for c in &p.clips {
        let ClipBody::Voice(v) = &c.body else { continue };
        if v.character_id == character.id && audible.contains(c.track_id.as_str()) && v.portrait.as_ref().is_some_and(|lp| lp.no_blink) {
            let (a, b) = (c.start.max(0) as usize, (c.end().max(0) as usize).min(eyes.len()));
            if a < b {
                eyes[a..b].fill(EYES_OPEN);
            }
        }
    }
    let mouth = mouth_track(p, character, total, peaks_for);
    let expr = expression_track_with(p, character, total, default_expr);
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
            only_while_speaking: false,
            expressions: vec![Expression { name: "怒り".into(), ..Default::default() }],
            psd: None,
        });
        // c1（0〜90）だけ怒り、c3 は表情なし
        p.clips[0].as_voice_mut().unwrap().expression = Some("怒り".into());
        let t = expression_track(&p, &p.characters[0], 300);
        assert_eq!((t[0], t[89], t[90], t[200]), (1, 1, 0, 0));
        let st = portrait_track(&p, &p.characters[0], 300, &|_| None);
        assert_eq!(st[10].expr, 1);
        assert_eq!(st[10].index(), 9);
    }

    #[test]
    fn item_default_expression_and_explicit_base() {
        let mut p = Project::sample();
        p.characters[0].portrait = Some(crate::model::Portrait {
            base: String::new(),
            eyes: Default::default(),
            mouth: Default::default(),
            transform: Default::default(),
            visible: true,
            only_while_speaking: false,
            expressions: vec![
                crate::model::Expression { name: "笑顔".into(), base: None, eyes: Default::default(), mouth: Default::default(), visibility: Default::default() },
                crate::model::Expression { name: "怒り".into(), base: None, eyes: Default::default(), mouth: Default::default(), visibility: Default::default() },
            ],
            psd: None,
        });
        // 既定は笑顔（1）。c1 は指定なし → 笑顔、c3 は「通常」をはっきり選ぶ → 0、c2 は別のキャラクター
        p.clips[2].as_voice_mut().unwrap().expression = Some(BASE_EXPRESSION.into());
        let t = expression_track_with(&p, &p.characters[0], 300, 1);
        assert_eq!((t[10], t[100], t[200], t[290]), (1, 1, 0, 1));
        p.clips[0].as_voice_mut().unwrap().expression = Some("怒り".into());
        assert_eq!(expression_track_with(&p, &p.characters[0], 300, 1)[10], 2);
    }

    #[test]
    fn runs_compress() {
        let a = PortraitState { eyes: 0, mouth: 0, expr: 0 };
        let b = PortraitState { eyes: 0, mouth: 2, expr: 0 };
        assert_eq!(runs(&[a, a, b, b, b, a]), vec![(a, 2), (b, 3), (a, 1)]);
    }

    #[test]
    fn line_portrait_variants_blink_and_mouth() {
        use crate::model::{Clip, Expression, LinePortrait, Portrait, PortraitClip, PsdPortrait, Transform};
        let mut p = Project::sample();
        p.characters[0].portrait = Some(Portrait {
            base: String::new(),
            eyes: Default::default(),
            mouth: Default::default(),
            transform: Transform::default(),
            visible: true,
            only_while_speaking: false,
            expressions: vec![Expression { name: "怒り".into(), ..Default::default() }, Expression { name: "笑顔".into(), ..Default::default() }],
            psd: Some(PsdPortrait { src: "a.psd".into(), ..Default::default() }),
        });
        // 立ち絵アイテム（既定の表情は笑顔）
        p.clips.push(Clip {
            id: "pt".into(),
            track_id: "V1".into(),
            start: 0,
            duration: 600,
            link_id: None,
            body: ClipBody::Portrait(PortraitClip { character_id: "ch_a".into(), transform: Transform::default(), only_while_speaking: None, expression: Some("笑顔".into()) }),
        });
        let mut vis = std::collections::BTreeMap::new();
        vis.insert("1/0".to_string(), true);
        // c1（0〜90）：レイヤーを変える・目パチしない・口パクしない
        p.clips[0].as_voice_mut().unwrap().portrait = Some(LinePortrait { visibility: vis, no_blink: true, no_mouth: true, effects: vec![] });
        let ch = p.characters[0].clone();
        let v = line_variants(&p, &ch);
        // 表情 2 つの後ろ（3）。もとは立ち絵アイテムの既定の表情（笑顔 = 2）
        assert_eq!(v, vec![("c1".to_string(), 3, 2)]);
        let ex = expression_track_with(&p, &ch, 300, 2);
        assert_eq!((ex[0], ex[89], ex[90]), (3, 3, 2));
        // セリフで怒りを選ぶと、もとは怒り
        p.clips[0].as_voice_mut().unwrap().expression = Some("怒り".into());
        assert_eq!(line_variants(&p, &ch)[0].2, 1);
        // 目パチしない・口パクしない（瞬きの最初は 164 フレームなので、セリフを伸ばしてかぶせる）
        p.clips[0].duration = 175;
        for c in p.clips.iter_mut() {
            if let Some(v) = c.as_voice_mut() {
                v.audio = Some(crate::model::AudioRef { cache_key: "k".into(), duration_ms: 6000 });
            }
        }
        let loud: Vec<i8> = (0..1200).map(|i| if i % 2 == 0 { -100 } else { 100 }).collect();
        let st = portrait_track_with(&p, &ch, 600, &|_| Some(loud.clone()), 2);
        assert!(st[..175].iter().all(|s| s.eyes == EYES_OPEN && s.mouth == MOUTH_CLOSED));
        // 外すと、瞬きも口パクもする
        p.clips[0].as_voice_mut().unwrap().portrait = None;
        let st = portrait_track_with(&p, &ch, 600, &|_| Some(loud.clone()), 2);
        assert!(st[164..170].iter().any(|s| s.eyes != EYES_OPEN) && st[..90].iter().any(|s| s.mouth != MOUTH_CLOSED));
    }
}
