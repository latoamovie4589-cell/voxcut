//! セリフから ASS 字幕を作る（FFmpeg の ass フィルタで焼き込む）。

use crate::model::{Clip, Frame, Project, SubtitleAnimation, SubtitlePosition, SubtitleStyle, KARAOKE_COLOR};
use crate::text::{parse_markup, RubySeg, Span};
#[cfg(test)]
use crate::text::parse_ruby;
use std::fmt::Write;

/// "#RRGGBB" → ASS の "&H00BBGGRR"
pub fn ass_color(hex: &str) -> String {
    let h = hex.trim_start_matches('#');
    let (r, g, b) = if h.len() >= 6 {
        (&h[0..2], &h[2..4], &h[4..6])
    } else {
        ("FF", "FF", "FF")
    };
    format!("&H00{}{}{}", b.to_uppercase(), g.to_uppercase(), r.to_uppercase())
}

/// 秒 → "H:MM:SS.cc"
pub fn ass_time(secs: f64) -> String {
    let cs = (secs.max(0.0) * 100.0).round() as u64;
    format!("{}:{:02}:{:02}.{:02}", cs / 360_000, (cs / 6000) % 60, (cs / 100) % 60, cs % 100)
}

/// 行の頭に来てはいけない文字（句読点・閉じ括弧・小さい仮名・伸ばし棒）。画面側の subtitleWrap.ts と同じ
const NO_START: &str = "、。，．・：；？！ー）」』】〕｝〉》ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々…‥!?,.:;)]}%";
/// 行の終わりに来てはいけない文字（開き括弧）
const NO_END: &str = "（「『【〔｛〈《([{";

/// 文字の幅（全角 1、半角 0.55）
fn char_em(c: char) -> f64 {
    if c < '\u{2000}' || ('\u{FF61}'..='\u{FF9F}').contains(&c) {
        0.55
    } else {
        1.0
    }
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// 字幕を、1 行に収まる幅で改行する（書き出しとプレビューで同じ位置）。
/// 幅は全角 1・半角 0.55 で数え、上限は max_chars（0 なら画面の幅 ÷ 文字の大きさ）。
/// 句読点や閉じ括弧は行の頭に置かず前の行へ（2 文字まで）、開き括弧は行の終わりに置かず次の行へ、英単語は途中で切らない
pub fn wrap_subtitle(text: &str, font_size: u32, width: u32, max_chars: u32) -> String {
    let budget = if max_chars > 0 { max_chars as f64 } else { ((width as f64) / (font_size.max(1) as f64)).floor() }.max(1.0);
    let mut out: Vec<String> = vec![];
    for para in text.replace("\r\n", "\n").split('\n') {
        let c: Vec<char> = para.chars().collect();
        let n = c.len();
        if n == 0 {
            out.push(String::new());
            continue;
        }
        let mut i0 = 0;
        while i0 < n {
            let mut w = 0.0;
            let mut e = i0;
            while e < n && (e == i0 || w + char_em(c[e]) <= budget + 1e-9) {
                w += char_em(c[e]);
                e += 1;
            }
            if e < n {
                let mut b = e;
                while b < n && b < e + 2 && NO_START.contains(c[b]) {
                    b += 1;
                }
                if b == e {
                    if b - 1 > i0 && NO_END.contains(c[b - 1]) {
                        b -= 1;
                    } else if is_word(c[b - 1]) && is_word(c[b]) {
                        let mut s = b - 1;
                        while s > i0 && is_word(c[s - 1]) {
                            s -= 1;
                        }
                        if s > i0 {
                            b = s;
                        }
                    }
                }
                e = b;
            }
            out.push(c[i0..e].iter().collect());
            i0 = e;
        }
    }
    out.join("\n")
}

fn escape_text(s: &str) -> String {
    s.replace('\\', "＼").replace('{', "｛").replace('}', "｝").replace("\r\n", "\\N").replace('\n', "\\N")
}

fn alignment(p: SubtitlePosition) -> u8 {
    match p {
        SubtitlePosition::Bottom => 2,
        SubtitlePosition::Middle => 5,
        SubtitlePosition::Top => 8,
    }
}

fn style_line(name: &str, s: &SubtitleStyle) -> String {
    // 帯（BorderStyle 3）：縁の色の欄が帯の色、縁の太さの欄が帯の余白になる
    let boxed = !s.box_color.is_empty();
    let (border, out, ow) = if boxed {
        (3, ass_color_alpha(&s.box_color, s.box_opacity), s.box_padding)
    } else {
        (1, ass_color(&s.outline_color), s.outline_width)
    };
    let (back, shadow) = if s.shadow_color.is_empty() { ("&H80000000".to_string(), 0) } else { (ass_color(&s.shadow_color), s.shadow_offset) };
    format!(
        "Style: {name},{font},{size},{pri},&H000000FF,{out},{back},0,0,0,0,100,100,{sp},0,{border},{ow},{shadow},{al},40,40,{mv},1",
        sp = s.letter_spacing,
        font = s.font_family,
        size = s.font_size,
        pri = ass_color(&s.color),
        al = alignment(s.position),
        mv = s.margin_v,
    )
}

/// 外側の縁を描く下の層のスタイル名（外側の縁を付けたスタイルだけ）
/// 折り返しの計算に使う 1 文字の幅（文字の大きさ + 文字の間隔。間隔が負なら大きさのまま）。画面の subtitleWrap と同じ
pub fn wrap_em(s: &SubtitleStyle) -> u32 {
    (s.font_size as f64 + s.letter_spacing.max(0.0)).round() as u32
}

fn outer_name(name: &str) -> String {
    format!("{name}~o")
}

/// 外側の縁の層のスタイル（内側の縁の外に、外側の縁の分だけ太くした縁を、外側の縁の色で）。帯を敷いたとき・設定がないときは None
fn outer_style_line(name: &str, s: &SubtitleStyle) -> Option<String> {
    if s.outline2_width == 0 || s.outline2_color.is_empty() || !s.box_color.is_empty() {
        return None;
    }
    let mut o = s.clone();
    o.outline_color = s.outline2_color.clone();
    o.outline_width = s.outline_width + s.outline2_width;
    Some(style_line(&outer_name(name), &o))
}

/// 不透明度つきの色（ASS は透明度で書く。00 が不透明）
fn ass_color_alpha(hex: &str, opacity: f64) -> String {
    let a = ((1.0 - opacity.clamp(0.0, 1.0)) * 255.0).round() as u8;
    format!("&H{a:02X}{}", &ass_color(hex)[4..])
}

/// クリッピング解除で見せる横の範囲（画面の px。文字の幅は全角 1・半角 0.55 で見積もり、縁の分を足す）と、かける長さ（ミリ秒）。
/// 画面（subtitleAnim.ts の wipeBounds）と同じ式
pub fn wipe_bounds(text: &str, font_size: u32, width: u32, duration: Frame, fps: u32) -> (i64, i64, u32) {
    let em = text.split('\n').map(|l| l.chars().map(char_em).sum::<f64>()).fold(0.0, f64::max);
    let half = em * font_size as f64 / 2.0 + font_size as f64 * 0.15 + 8.0;
    let c = width as f64 / 2.0;
    let ms = (duration as f64 / fps.max(1) as f64 * 1000.0 * 0.6).min(500.0).round() as u32;
    ((c - half).floor() as i64, (c + half).ceil() as i64, ms.max(1))
}

/// カラオケで、ゆっくり塗らない文字（句読点・記号・空白）
fn karaoke_light(ch: char) -> bool {
    ch.is_whitespace() || "、。，．,.!?！？…‥・「」『』（）()〜~－-：:；;\"'”“’‘".contains(ch)
}

/// カラオケの区切り（センチ秒。文字ごとの塗り始め、最後は塗り終わり。改行は数えない）。
/// 句読点・記号は 0.3 文字ぶん。長さの 9 割で塗り終わる。画面（subtitleAnim.ts）と同じ式
pub fn karaoke_bounds(chars: &[char], duration: Frame, fps: u32) -> Vec<u32> {
    let w: Vec<f64> = chars.iter().map(|&c| if karaoke_light(c) { 0.3 } else { 1.0 }).collect();
    let total: f64 = w.iter().sum::<f64>().max(1e-9);
    let span = duration as f64 * 0.9 / fps.max(1) as f64 * 100.0;
    let mut out = vec![0u32];
    let mut acc = 0.0;
    for x in &w {
        acc += x;
        out.push((acc / total * span).round() as u32);
    }
    out
}

/// 一部の文字の飾り（色・大きさ・太字）を ASS にするための材料。styles は文字ごと（改行は数えない）
struct Deco<'a> {
    styles: &'a [Option<Span>],
    /// 飾りのない文字の色（"#RRGGBB"）と大きさ
    color: &'a str,
    font_size: u32,
    /// カラオケでは、塗る前の色（副の色）を飾りの色にする（塗ったあとは塗る色）
    karaoke: bool,
    /// ルビのある字幕では大きさ・太字を変えない（ルビの位置がずれるため）
    ignore_size: bool,
}

impl Deco<'_> {
    /// 飾りを持つ文字があるか
    fn any(&self) -> bool {
        self.styles.iter().any(Option::is_some)
    }

    /// 文字 i の飾り（大きさ・太字を使わないときは外す）
    fn at(&self, i: usize) -> Option<Span> {
        self.styles.get(i).cloned().flatten().map(|s| Span { size: if self.ignore_size { None } else { s.size }, bold: s.bold && !self.ignore_size, ..s }).filter(|s| s.color.is_some() || s.size.is_some() || s.bold)
    }

    /// 前の文字の飾り prev から cur に変わるときのタグ（変わらなければ空）。飾りなしに戻るときは元の色・大きさを明示する
    fn tags(&self, prev: &Option<Span>, cur: &Option<Span>) -> String {
        if prev == cur {
            return String::new();
        }
        let col = cur.as_ref().and_then(|s| s.color.as_deref()).unwrap_or(self.color);
        let size = cur.as_ref().and_then(|s| s.size).map_or(self.font_size as f64, |k| self.font_size as f64 * k);
        let which = if self.karaoke { "2c" } else { "1c" };
        let b = u8::from(cur.as_ref().is_some_and(|s| s.bold));
        format!("\\{which}{}&\\fs{:.0}\\b{b}", ass_color(col), size.max(1.0))
    }
}

/// 飾りを付けた ASS のテキスト（改行は \N）。first は text の頭が全文の何文字目か、hide_from 文字目からは透明にする
fn styled_text(text: &str, first: usize, hide_from: usize, d: &Deco) -> String {
    let mut out = String::new();
    let mut prev: Option<Span> = None;
    let mut i = first;
    let mut hidden = false;
    for ch in text.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            out.push_str("\\N");
            continue;
        }
        let cur = d.at(i);
        let mut tags = d.tags(&prev, &cur);
        if !hidden && i >= hide_from {
            hidden = true;
            tags.push_str("\\alpha&HFF&");
        }
        if !tags.is_empty() {
            let _ = write!(out, "{{{tags}}}");
        }
        out.push_str(&escape_text(&ch.to_string()));
        prev = cur;
        i += 1;
    }
    out
}

/// カラオケの ASS（1 文字ずつ \kf。塗る色を主の色、塗る前を副の色にする）。d があれば、文字ごとの飾りも付ける
fn karaoke_ass(text: &str, duration: Frame, fps: u32, color: &str, kara: &str, d: Option<&Deco>) -> String {
    let chars: Vec<char> = text.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    let b = karaoke_bounds(&chars, duration, fps);
    let mut out = format!("{{\\1c{}&\\2c{}&}}", ass_color(kara), ass_color(color));
    let mut i = 0;
    let mut prev: Option<Span> = None;
    for ch in text.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            out.push_str("\\N");
            continue;
        }
        let cur = d.and_then(|d| d.at(i));
        let tags = d.map(|d| d.tags(&prev, &cur)).unwrap_or_default();
        out.push_str(&format!("{{\\kf{}{tags}}}{}", b[i + 1] - b[i], escape_text(&ch.to_string())));
        prev = cur;
        i += 1;
    }
    out
}

/// アニメーションにかけるフレーム数（0.2 秒）
pub fn anim_frames(fps: u32) -> Frame {
    ((fps as f64 * 0.2).round() as Frame).max(1)
}

/// タイプライターで表示する文字数（改行は数えない）。f はクリップ先頭からのフレーム
pub fn typewriter_count(chars: usize, duration: Frame, f: Frame) -> usize {
    let reveal = ((duration as f64 * 0.6).floor() as Frame).min(chars as Frame * 2);
    if reveal <= 0 {
        return chars;
    }
    (((f + 1) as usize * chars) / reveal as usize).min(chars)
}

/// 先頭 `count` 文字（改行を除いて数える）を見せ、残りを透明にした ASS テキスト
fn reveal_text(text: &str, count: usize) -> String {
    let mut shown = String::new();
    let mut n = 0;
    let mut split = text.len();
    for (i, ch) in text.char_indices() {
        if n == count {
            split = i;
            break;
        }
        if ch != '\n' && ch != '\r' {
            n += 1;
        }
        shown.push(ch);
    }
    let rest = &text[split.min(text.len())..];
    if split >= text.len() || rest.is_empty() {
        return escape_text(text);
    }
    format!("{}{{\\alpha&HFF&}}{}", escape_text(&shown), escape_text(rest))
}

/// 改行した行ごとの区切り（地の文・ルビ付きの語と、その語の頭が全文の何文字目か。改行は数えない）
type RubyRow = Vec<(String, Option<String>, usize)>;

/// ルビの付いた語の途中で改行しない（語の頭で改行する。語が行の頭からなら語の終わりまで延ばす）。画面側の ruby.ts と同じ
pub fn keep_ruby_words(segs: &[RubySeg], wrapped: &str) -> String {
    let owner: Vec<usize> = segs.iter().enumerate().flat_map(|(k, s)| s.base.chars().filter(|c| *c != '\n').map(move |_| k)).collect();
    let chars: Vec<char> = wrapped.chars().filter(|c| *c != '\n').collect();
    // 行の切れ目（改行を除いた文字の位置）
    let mut cuts: Vec<usize> = vec![];
    let mut n = 0;
    for ch in wrapped.chars() {
        if ch == '\n' {
            cuts.push(n);
        } else {
            n += 1;
        }
    }
    for i in 0..cuts.len() {
        let b = cuts[i];
        if b == 0 || b >= owner.len() || owner[b - 1] != owner[b] || segs[owner[b]].ruby.is_none() {
            continue;
        }
        let k = owner[b];
        let s0 = owner.iter().position(|&o| o == k).unwrap_or(b);
        let e0 = owner.iter().rposition(|&o| o == k).map(|e| e + 1).unwrap_or(b);
        let prev = if i == 0 { 0 } else { cuts[i - 1] };
        let next = cuts.get(i + 1).copied().unwrap_or(usize::MAX);
        cuts[i] = if s0 > prev { s0 } else { e0.min(next) };
    }
    let mut out = String::new();
    let mut at = 0;
    for &c in &cuts {
        out.extend(&chars[at.min(c)..c]);
        out.push('\n');
        at = c;
    }
    out.extend(&chars[at.min(chars.len())..]);
    out
}

/// ルビを外した文を改行した結果（wrapped）に、ルビを割り当て直す。行をまたいだ語のルビは、頭の行に付ける
pub fn ruby_rows(segs: &[RubySeg], wrapped: &str) -> Vec<RubyRow> {
    // 文字ごとの区切り番号
    let owner: Vec<usize> = segs.iter().enumerate().flat_map(|(k, s)| s.base.chars().filter(|c| *c != '\n').map(move |_| k)).collect();
    let mut rows = vec![];
    let mut n = 0;
    for line in wrapped.split('\n') {
        let mut row: RubyRow = vec![];
        for ch in line.chars() {
            let k = owner.get(n).copied().unwrap_or(usize::MAX);
            let ruby = segs.get(k).and_then(|s| s.ruby.clone());
            match row.last_mut() {
                // 同じ区切りの続き（ルビ付きの語が行をまたいだら、次の行の分はルビなし）
                Some((t, _, _)) if n > 0 && owner.get(n - 1) == Some(&k) && !t.is_empty() => t.push(ch),
                _ => {
                    let first = n == 0 || owner.get(n - 1) != Some(&k);
                    row.push((ch.to_string(), if first { ruby } else { None }, n));
                }
            }
            n += 1;
        }
        rows.push(row);
    }
    rows
}

/// ルビ付きの字幕の ASS テキスト。ルビは行の上に小さい行として置き、横の位置は透明な文字で合わせる
/// （地の文は同じ文字を透明・高さ 1% で、語の左右のすき間は全角の空白の幅を変えて。どちらもフォントの字幅に従う）。
/// pop はポップの長さ（ミリ秒）、count は見せる文字数（1 文字ずつ出すとき。ルビは語の頭が出たら出す）
fn ruby_ass(rows: &[RubyRow], font_size: u32, pop: Option<u32>, count: usize, deco: Option<&Deco>) -> String {
    let fs = font_size.max(1) as f64;
    let rs = (fs * 0.5).round().max(1.0);
    let tags = |sx: f64, sy: f64| match pop {
        Some(ms) => format!("\\fscx{:.0}\\fscy{:.0}\\t(0,{ms},0.5,\\fscx{:.0}\\fscy{:.0})", sx * 0.85, (sy * 0.85).max(1.0), sx, sy),
        None => {
            let x = if (sx - 100.0).abs() < 0.5 { String::new() } else { format!("\\fscx{sx:.0}") };
            let y = if (sy - 100.0).abs() < 0.5 { String::new() } else { format!("\\fscy{sy:.0}") };
            x + &y
        }
    };
    let hide = "\\alpha&HFF&";
    let em = |t: &str| t.chars().map(char_em).sum::<f64>();
    let mut out: Vec<String> = vec![];
    for row in rows {
        if row.iter().any(|(_, r, _)| r.is_some()) {
            let mut line = String::new();
            for (base, ruby, at) in row {
                let Some(ruby) = ruby else {
                    let _ = write!(line, "{{\\r{}{hide}}}{}", tags(100.0, 1.0), escape_text(base));
                    continue;
                };
                let (wb, wr) = (em(base) * fs, em(ruby) * rs);
                let shown = if *at < count { "" } else { hide };
                if wr <= wb {
                    let gap = (wb - wr) / 2.0 / fs * 100.0;
                    let pad = if gap >= 0.5 { format!("{{\\r{}{hide}}}\u{3000}", tags(gap, 1.0)) } else { String::new() };
                    let _ = write!(line, "{pad}{{\\r\\fs{rs:.0}{}{shown}}}{}{pad}", tags(100.0, 100.0), escape_text(ruby));
                } else {
                    let _ = write!(line, "{{\\r\\fs{rs:.0}{}{shown}}}{}", tags(wb / wr * 100.0, 100.0), escape_text(ruby));
                }
            }
            out.push(line);
        }
        // 地の文の行（まだ出ていない文字は透明）
        let text: String = row.iter().map(|(t, _, _)| t.as_str()).collect();
        let start = row.first().map(|(_, _, at)| *at).unwrap_or(0);
        let k = count.saturating_sub(start).min(text.chars().count());
        if let Some(d) = deco {
            out.push(format!("{{\\r{}}}{}", tags(100.0, 100.0), styled_text(&text, start, start + k, d)));
            continue;
        }
        let (a, b): (String, String) = (text.chars().take(k).collect(), text.chars().skip(k).collect());
        let rest = if b.is_empty() { String::new() } else { format!("{{{hide}}}{}", escape_text(&b)) };
        out.push(format!("{{\\r{}}}{}{rest}", tags(100.0, 100.0), escape_text(&a)));
    }
    out.join("\\N")
}

/// 見た目を上書きした字幕のスタイル名（ASS のスタイル名に使えない「,」を避ける）
fn caption_style_name(clip_id: &str) -> String {
    format!("cap_{}", clip_id.replace(',', "_"))
}

fn dialogue(out: &mut String, p: &Project, start: Frame, end: Frame, style: &str, text: &str) {
    let _ = writeln!(
        out,
        "Dialogue: 0,{},{},{},,0,0,0,,{}",
        ass_time(p.video.frames_to_secs(start)),
        ass_time(p.video.frames_to_secs(end)),
        style,
        text
    );
}

/// プロジェクト全体の ASS を作る。隠した映像トラックの字幕は出さない。
pub fn build_ass(p: &Project) -> String {
    build_ass_for(p, None)
}

/// 字幕のある映像トラック（V1 から順）
pub fn caption_tracks(p: &Project) -> Vec<String> {
    p.video_tracks()
        .filter(|t| p.clips.iter().any(|c| c.track_id == t.id && p.line_of_subtitle(c).is_some_and(|v| v.subtitle_custom.is_none())))
        .map(|t| t.id.clone())
        .collect()
}

/// track を渡すと、その映像トラックの字幕だけの ASS を作る（トラックの重なり順どおりに焼き込むため）
pub fn build_ass_for(p: &Project, track: Option<&str>) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n", p.video.width, p.video.height);
    let _ = writeln!(out, "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding");
    // 外側の縁のあるスタイル（その字幕は、外側の縁の層を下に重ねて 2 行にする）
    let mut outer: std::collections::HashSet<String> = Default::default();
    for c in &p.characters {
        let _ = writeln!(out, "{}", style_line(&c.id, &c.subtitle));
        if let Some(l) = outer_style_line(&c.id, &c.subtitle) {
            let _ = writeln!(out, "{l}");
            outer.insert(c.id.clone());
        }
    }
    // 見た目を上書きした字幕は、その字幕だけのスタイルを作る
    for c in &p.clips {
        let Some(cap) = c.as_caption() else { continue };
        let Some(ov) = &cap.style else { continue };
        let Some(ch) = p.clips.iter().find(|x| x.id == cap.voice_id).and_then(|x| x.as_voice()).and_then(|v| p.character(&v.character_id)) else { continue };
        let name = caption_style_name(&c.id);
        let eff = ov.apply(&ch.subtitle);
        let _ = writeln!(out, "{}", style_line(&name, &eff));
        if let Some(l) = outer_style_line(&name, &eff) {
            let _ = writeln!(out, "{l}");
            outer.insert(name);
        }
    }
    let _ = writeln!(out, "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
    let ev_start = out.len();
    let mut clips: Vec<(&Clip, &crate::model::VoiceClip)> = p
        .clips
        .iter()
        .filter(|c| track.is_none_or(|t| c.track_id == t) && p.track(&c.track_id).is_some_and(|t| !t.hidden))
        // 分離した字幕はそのセリフの文、字幕と声が 1 つのセリフはそれ自身の文
        .filter_map(|c| p.line_of_subtitle(c).map(|v| (c, v)))
        .collect();
    clips.sort_by_key(|(c, _)| c.start);
    for (c, v) in clips {
        let text = v.subtitle.as_deref().unwrap_or(&v.text);
        // 「個別に設定」した字幕は画像にして重ねる（render.rs）ので、ここでは書かない
        if text.trim().is_empty() || v.subtitle_custom.is_some() {
            continue;
        }
        let style = if c.as_caption().is_some_and(|cap| cap.style.is_some()) { caption_style_name(&c.id) } else { v.character_id.clone() };
        // 改行の位置はここで決める（ASS の自動の折り返しは使わない。プレビューと同じ位置にするため）
        let eff = p.character(&v.character_id).map(|ch| match c.as_caption().and_then(|cap| cap.style.as_ref()) {
            Some(ov) => ov.apply(&ch.subtitle),
            None => ch.subtitle.clone(),
        });
        // 飾りのない文字の色
        let eff_color = eff.as_ref().map_or("#FFFFFF".to_string(), |st| st.color.clone());
        // カラオケの色（塗る前は文字の色）
        let (kara_from, kara_to) = eff.as_ref().map_or(("#FFFFFF".to_string(), KARAOKE_COLOR.to_string()), |st| {
            (st.color.clone(), if st.karaoke_color.is_empty() { KARAOKE_COLOR.to_string() } else { st.karaoke_color.clone() })
        });
        // ルビと飾りの書き方を外した文で改行する
        let mk = parse_markup(text);
        let segs = mk.segs;
        let base: String = segs.iter().map(|s| s.base.as_str()).collect();
        let font_size = eff.as_ref().map(|st| st.font_size).unwrap_or(56);
        let wrapped = eff.map(|st| wrap_subtitle(&base, wrap_em(&st), p.video.width.saturating_sub(80), st.max_chars)).unwrap_or_else(|| base.clone());
        let has_ruby = segs.iter().any(|s| s.ruby.is_some());
        let wrapped = if has_ruby { keep_ruby_words(&segs, &wrapped) } else { wrapped };
        let text = wrapped.as_str();
        let rows = has_ruby.then(|| ruby_rows(&segs, text));
        // 一部の文字の飾り（色・大きさ）。ルビのある字幕では大きさを使わない
        let base_color = eff_color.clone();
        let deco = Deco { styles: &mk.styles, color: &base_color, font_size, karaoke: false, ignore_size: has_ruby };
        let deco_kara = Deco { karaoke: true, ..Deco { styles: &mk.styles, color: &base_color, font_size, karaoke: false, ignore_size: has_ruby } };
        let decorated = deco.any();
        // 出し方：分離した字幕で上書きしていればそれ
        let anim = c
            .as_caption()
            .and_then(|cap| cap.style.as_ref())
            .and_then(|o| o.animation)
            .or_else(|| p.character(&v.character_id).map(|ch| ch.subtitle.animation))
            .unwrap_or_default();
        let ms = (p.video.frames_to_secs(anim_frames(p.video.fps)) * 1000.0).round() as u32;
        // ルビがあれば、ルビの行を足した文にする（ないときは今までどおり）
        let body = |pop: Option<u32>, count: usize| match &rows {
            Some(r) => ruby_ass(r, font_size, pop, count, decorated.then_some(&deco)),
            None if pop.is_some() => format!("{{\\fscx85\\fscy85\\t(0,{ms},0.5,\\fscx100\\fscy100)}}{}", if decorated { styled_text(text, 0, usize::MAX, &deco) } else { escape_text(text) }),
            None if decorated => styled_text(text, 0, count, &deco),
            None if count == usize::MAX => escape_text(text),
            None => reveal_text(text, count),
        };
        match anim {
            SubtitleAnimation::None => dialogue(&mut out, p, c.start, c.end(), &style, &body(None, usize::MAX)),
            SubtitleAnimation::Fade => dialogue(&mut out, p, c.start, c.end(), &style, &format!("{{\\fad({ms},{ms})}}{}", body(None, usize::MAX))),
            SubtitleAnimation::Pop => dialogue(&mut out, p, c.start, c.end(), &style, &body(Some(ms), usize::MAX)),
            SubtitleAnimation::Wipe => {
                let (x1, x2, wms) = wipe_bounds(text, font_size, p.video.width, c.duration, p.video.fps);
                let h = p.video.height;
                dialogue(&mut out, p, c.start, c.end(), &style, &format!("{{\\clip({x1},0,{x1},{h})\\t(0,{wms},\\clip({x1},0,{x2},{h}))}}{}", body(None, usize::MAX)))
            }
            // ルビのある字幕は塗らない（ふつうに出す）
            SubtitleAnimation::Karaoke if rows.is_some() => dialogue(&mut out, p, c.start, c.end(), &style, &body(None, usize::MAX)),
            SubtitleAnimation::Karaoke => dialogue(&mut out, p, c.start, c.end(), &style, &karaoke_ass(text, c.duration, p.video.fps, &kara_from, &kara_to, decorated.then_some(&deco_kara))),
            SubtitleAnimation::Typewriter => {
                // 表示文字数が変わるフレームごとに 1 行。文字の位置は全文で決まるので、出ていない文字は透明にしておく
                let chars = text.chars().filter(|ch| *ch != '\n' && *ch != '\r').count();
                let mut seg_start = 0;
                let mut cur = typewriter_count(chars, c.duration, 0);
                for f in 1..=c.duration {
                    let next = if f == c.duration { usize::MAX } else { typewriter_count(chars, c.duration, f) };
                    if next != cur {
                        dialogue(&mut out, p, c.start + seg_start, c.start + f, &style, &body(None, cur));
                        seg_start = f;
                        cur = next;
                    }
                }
            }
        }
    }
    if outer.is_empty() {
        return out;
    }
    // 外側の縁：同じ字幕を、太い縁の層（下）と ふつうの層（上）の 2 行にする
    let events = out.split_off(ev_start);
    for line in events.lines() {
        let f: Vec<&str> = line.splitn(10, ',').collect();
        match f.as_slice() {
            [layer, a, b, style, rest @ ..] if layer.starts_with("Dialogue: ") && outer.contains(*style) => {
                let tail = rest.join(",");
                let _ = writeln!(out, "Dialogue: 0,{a},{b},{},{tail}", outer_name(style));
                let _ = writeln!(out, "Dialogue: 1,{a},{b},{style},{tail}");
            }
            _ => {
                let _ = writeln!(out, "{line}");
            }
        }
    }
    out
}

/// 秒 → SRT の "HH:MM:SS,mmm"
fn srt_time(secs: f64) -> String {
    let ms = (secs.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

/// 字幕を SRT にする（YouTube などに字幕として上げる用）。見た目は付けず、文と時刻だけ。隠したレイヤーは入れない
pub fn build_srt(p: &Project) -> String {
    let mut lines: Vec<(Frame, Frame, String)> = p
        .clips
        .iter()
        .filter(|c| p.track(&c.track_id).is_some_and(|t| !t.hidden))
        .filter_map(|c| p.line_of_subtitle(c).map(|v| (c, v)))
        .map(|(c, v)| (c.start, c.end(), crate::text::ruby_base(v.subtitle.as_deref().unwrap_or(&v.text)).trim().to_string()))
        .filter(|(_, _, t)| !t.is_empty())
        .collect();
    lines.sort_by_key(|(s, _, _)| *s);
    let mut out = String::new();
    for (i, (s, e, t)) in lines.iter().enumerate() {
        let _ = write!(out, "{}\r\n{} --> {}\r\n{}\r\n\r\n", i + 1, srt_time(p.video.frames_to_secs(*s)), srt_time(p.video.frames_to_secs(*e)), t.replace("\r\n", "\n").replace('\n', "\r\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ClipBody;

    #[test]
    fn srt_has_numbered_cues_in_time_order() {
        let p = Project::sample();
        let srt = build_srt(&p);
        assert!(srt.starts_with("1\r\n00:00:00,000 --> "), "{srt}");
        assert!(srt.contains("\r\n2\r\n"), "{srt}");
        assert_eq!(srt_time(3725.5), "01:02:05,500");
    }

    #[test]
    fn color_and_time() {
        assert_eq!(ass_color("#0A84FF"), "&H00FF840A");
        assert_eq!(ass_time(0.0), "0:00:00.00");
        assert_eq!(ass_time(3723.456), "1:02:03.46");
    }

    #[test]
    fn ruby_goes_on_a_small_line_above() {
        let mut p = Project::sample();
        if let ClipBody::Voice(v) = &mut p.clips[1].body {
            v.subtitle = Some("今日は夕暮《ゆうぐれ》時".into());
        }
        let font = p.character(&p.clips[1].as_voice().unwrap().character_id).unwrap().subtitle.font_size;
        let s = build_ass(&p);
        let line = s.lines().find(|l| l.contains("ゆうぐれ")).unwrap();
        // 地の文は透明・高さ 1% の同じ文字、ルビは半分の大きさ、その下に地の文の行
        assert!(line.contains(&format!("{{\\r\\fscy1\\alpha&HFF&}}今日は{{\\r\\fs{}}}ゆうぐれ", (font as f64 * 0.5).round())), "{line}");
        assert!(line.ends_with("\\N{\\r}今日は夕暮時"), "{line}");
        // 改行をまたいでもルビは頭の行に付き、1 文字ずつ出すときは語の頭が出たら出す
        let segs = parse_ruby("ああ漢字《かんじ》いい");
        let rows = ruby_rows(&segs, "ああ漢\n字いい");
        assert_eq!(rows[0][1], ("漢".to_string(), Some("かんじ".to_string()), 2));
        assert_eq!(rows[1][0], ("字".to_string(), None, 3));
        // 改行はルビの語の頭へ動かす（行の頭からの語なら語の終わりへ）
        assert_eq!(keep_ruby_words(&segs, "ああ漢\n字いい"), "ああ\n漢字いい");
        let segs2 = parse_ruby("漢字《かんじ》いい\n\nう");
        assert_eq!(keep_ruby_words(&segs2, "漢\n字いい\n\nう"), "漢字\nいい\n\nう");
        let t = ruby_ass(&rows, 40, None, 2, None);
        assert!(t.contains("{\\r\\fs20\\fscx67\\alpha&HFF&}かんじ"), "{t}");
        assert!(ruby_ass(&rows, 40, None, 3, None).contains("{\\r\\fs20\\fscx67}かんじ"));
        // 字幕ファイル（SRT）はルビを外した文
        assert!(build_srt(&p).contains("今日は夕暮時"));
    }

    #[test]
    fn builds_events_per_voice_clip() {
        let mut p = Project::sample();
        if let ClipBody::Voice(v) = &mut p.clips[1].body {
            v.subtitle = Some("1行目\n{2}行目".into());
        }
        let s = build_ass(&p);
        assert!(s.contains("Style: ch_a,"));
        // 改行：幅で切る・句読点は前の行・開き括弧は次の行・英単語は切らない（画面側の subtitleWrap.ts と同じ）
        assert_eq!(wrap_subtitle("あいうえおかきくけこ", 10, 50, 0), "あいうえお\nかきくけこ");
        assert_eq!(wrap_subtitle("あいうえお。かきくけこ", 10, 50, 0), "あいうえお。\nかきくけこ");
        assert_eq!(wrap_subtitle("あいう「えおか」き", 10, 40, 0), "あいう\n「えおか」\nき");
        assert_eq!(wrap_subtitle("これはVOICEVOXです", 10, 60, 0), "これは\nVOICEVOXで\nす");
        assert_eq!(wrap_subtitle("あいうえおかきく", 56, 1840, 3), "あいう\nえおか\nきく");
        assert_eq!(wrap_subtitle("短い\n改行", 56, 1840, 0), "短い\n改行");
        // 影と帯：帯の色は縁の欄（不透明度は ASS の透明度）、余白は縁の太さの欄、BorderStyle 3
        let mut st = SubtitleStyle { shadow_color: "#112233".into(), shadow_offset: 5, ..SubtitleStyle::default() };
        assert!(style_line("x", &st).ends_with("&H00332211,0,0,0,0,100,100,0,0,1,4,5,2,40,40,60,1"), "{}", style_line("x", &st));
        st.box_color = "#000000".into();
        st.box_opacity = 0.6;
        assert!(style_line("x", &st).contains(",&H66000000,&H00332211,0,0,0,0,100,100,0,0,3,12,5,"), "{}", style_line("x", &st));
        assert!(s.contains("Style: ch_b,"));
        assert_eq!(s.matches("Dialogue:").count(), 3);
        assert!(s.contains("Dialogue: 0,0:00:00.00,0:00:03.00,ch_a,,0,0,0,,こんにちは。"));
        assert!(s.contains(",ch_b,,0,0,0,,1行目\\N｛2｝行目"));
    }

    #[test]
    fn animations() {
        let mut p = Project::sample();
        p.characters[0].subtitle.animation = SubtitleAnimation::Fade;
        p.characters[1].subtitle.animation = SubtitleAnimation::Pop;
        let s = build_ass(&p);
        assert!(s.contains(",ch_a,,0,0,0,,{\\fad(200,200)}こんにちは。"), "{s}");
        assert!(s.contains(",ch_b,,0,0,0,,{\\fscx85\\fscy85\\t(0,200,0.5,\\fscx100\\fscy100)}セリフ"));
    }

    #[test]
    fn wipe_tags() {
        // 「あいう」56px：幅 168 の半分 84 + 縁 8.4 + 8 → 画面 1920 の真ん中 960 から ±100.4
        assert_eq!(wipe_bounds("あいう", 56, 1920, 90, 30), (859, 1061, 500));
        assert_eq!(wipe_bounds("ab\nあいう", 56, 1920, 15, 30).2, 300);
        let mut p = Project::sample();
        p.characters[0].subtitle.animation = SubtitleAnimation::Wipe;
        let s = build_ass(&p);
        assert!(s.contains(",ch_a,,0,0,0,,{\\clip("), "{s}");
        assert!(s.contains("\\t(0,500,\\clip("), "{s}");
    }

    /// libass で描くと、途中では左だけ見えている
    #[test]
    fn wipe_reveals_left_first() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let (x1, x2, ms) = wipe_bounds("WWWW", 60, 320, 60, 30);
        let body = format!("{{\\clip({x1},0,{x1},120)\\t(0,{ms},\\clip({x1},0,{x2},120))}}WWWW");
        std::fs::write(d.path().join("w.ass"), format!("[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 120\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: a,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,a,,0,0,0,,{body}\n")).unwrap();
        let shot = |at: &str| {
            let o = std::process::Command::new("ffmpeg").current_dir(d.path()).args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x120:d=2", "-vf", "subtitles=w.ass", "-ss", at, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let img = o.stdout;
            (0..320).filter(|&x| (20..100).any(|y| img[y * 320 + x] > 128)).collect::<Vec<_>>()
        };
        let done = shot("1.5");
        let mid = shot("0.25");
        assert!(done.len() > 40, "全部出ている");
        let cut = x1 as f64 + (x2 - x1) as f64 * 0.25 / (ms as f64 / 1000.0);
        assert!(!mid.is_empty() && mid.iter().all(|&x| (x as f64) < cut + 2.0), "途中は左だけ {mid:?} / {cut}");
        assert!(mid.len() < done.len() * 3 / 4);
    }

    #[test]
    fn karaoke_timing_and_tags() {
        let b = karaoke_bounds(&"あい、う".chars().collect::<Vec<_>>(), 100, 30);
        // 全部で 3.3 文字ぶん、長さの 9 割（3 秒）で塗り終わる
        assert_eq!(b, vec![0, 91, 182, 209, 300]);
        let s = karaoke_ass("あい\nう", 30, 30, "#FFFFFF", "#FFD400", None);
        assert!(s.starts_with("{\\1c&H0000D4FF&\\2c&H00FFFFFF&}{\\kf30}あ{\\kf30}い\\N{\\kf30}う"), "{s}");
    }

    /// 本当に ffmpeg（libass）で描くと、時間の分だけ左から塗られている
    #[test]
    fn karaoke_fills_left_to_right() {
        if std::process::Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let ass = d.path().join("k.ass");
        // 60 フレーム（2 秒）、9 割（1.8 秒）で 4 文字を塗る → 0.9 秒で半分
        let body = karaoke_ass("WWWW", 60, 30, "#FFFFFF", "#FFD400", None);
        std::fs::write(&ass, format!("[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 120\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: a,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,a,,0,0,0,,{body}\n")).unwrap();
        let o = std::process::Command::new("ffmpeg")
            .current_dir(d.path())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x120:d=2", "-vf", "subtitles=k.ass", "-ss", "0.9", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let img = o.stdout;
        // 横の位置ごとに、明るい画素が黄色（青が少ない）か白か
        let cols: Vec<bool> = (0..320)
            .filter_map(|x| (20..100).map(|y| &img[(y * 320 + x) * 3..(y * 320 + x) * 3 + 3]).find(|p| p.iter().map(|&v| v as u32).sum::<u32>() > 400).map(|p| p[2] < 120))
            .collect();
        assert!(cols.len() > 40, "文字が描かれていない");
        let yellow = cols.iter().filter(|&&y| y).count() as f64 / cols.len() as f64;
        assert!((yellow - 0.5).abs() < 0.12, "半分ほど塗られている {yellow}");
        assert!(cols[..cols.len() / 4].iter().all(|&y| y) && cols[cols.len() * 3 / 4..].iter().all(|&y| !y), "左から塗る");
    }

    #[test]
    fn typewriter_timing_and_events() {
        // 10 文字・60 フレーム → 20 フレームで全部出る（1 文字 2 フレーム）
        assert_eq!(typewriter_count(10, 60, 0), 0);
        assert_eq!(typewriter_count(10, 60, 1), 1);
        assert_eq!(typewriter_count(10, 60, 19), 10);
        // 長さが短いと 6 割で出し切る：10 文字・10 フレーム → 6 フレーム
        assert_eq!(typewriter_count(10, 10, 5), 10);

        let mut p = Project::sample();
        p.characters[0].subtitle.animation = SubtitleAnimation::Typewriter;
        p.clips.truncate(1);
        if let ClipBody::Voice(v) = &mut p.clips[0].body {
            v.text = "あいう".into();
        }
        let s = build_ass(&p);
        let lines: Vec<&str> = s.lines().filter(|l| l.starts_with("Dialogue:")).collect();
        // 0 文字 → 1 → 2 → 3（最後はクリップの終わりまで）
        assert_eq!(lines.len(), 4, "{lines:?}");
        assert!(lines[1].ends_with(",あ{\\alpha&HFF&}いう"));
        assert!(lines[3].ends_with(",あいう") && lines[3].contains(",0:00:03.00,"));
        assert_eq!(reveal_text("あ\nいう", 2), "あ\\Nい{\\alpha&HFF&}う");
    }

    fn line_with(text: &str, anim: SubtitleAnimation) -> Project {
        let mut p = Project::sample();
        p.characters[0].subtitle.animation = anim;
        p.characters[0].subtitle.font_size = 50;
        p.clips.truncate(1);
        if let ClipBody::Voice(v) = &mut p.clips[0].body {
            v.text = text.into();
        }
        p
    }

    fn dialogues(p: &Project) -> Vec<String> {
        build_ass(p).lines().filter(|l| l.starts_with("Dialogue:")).map(|l| l.splitn(10, ',').nth(9).unwrap().to_string()).collect()
    }

    /// 一部の文字だけ色・大きさを変える（書き方は `<c=#FF0000>…</c>`・`<s=1.5>…</s>`）
    #[test]
    fn partial_styles_become_override_tags() {
        use crate::text::{parse_markup, Span};
        let m = parse_markup("あ<c=#f00>い<s=1.5>う</s></c>え\nお<c=#12ab34>か</c>");
        let base: String = m.segs.iter().map(|s| s.base.as_str()).collect();
        assert_eq!(base, "あいうえ\nおか");
        // 文字ごと（改行は数えない）
        let col = |c: &str| Some(Span { color: Some(c.into()), size: None, bold: false });
        assert_eq!(m.styles.len(), 6);
        assert_eq!(m.styles[0], None);
        assert_eq!(m.styles[1], col("#FF0000"));
        assert_eq!(m.styles[2], Some(Span { color: Some("#FF0000".into()), size: Some(1.5), bold: false }));
        assert_eq!((m.styles[3].clone(), m.styles[4].clone()), (None, None));
        assert_eq!(m.styles[5], col("#12AB34"));
        // 書き方に合わない < はそのまま文字。大きさは 0.3〜4 に収める
        assert_eq!(crate::text::strip_markup("a<i>c <c=#xyz>d <s=9>e</s>"), "a<i>c <c=#xyz>d e");
        assert_eq!(parse_markup("<s=9>e").styles[0].as_ref().unwrap().size, Some(4.0));
        // 声・SRT にも書き方は入らない
        assert_eq!(crate::text::ruby_reading("<c=#f00>明日《あした》</c>は"), "あしたは");
        assert_eq!(crate::text::ruby_base("<c=#f00>明日《あした》</c>は"), "明日は");

        // ふつうに出す：色は 1c、大きさは fs（50 × 1.5 = 75）。もとに戻るときは文字の色と大きさを明示する
        let p = line_with("あ<c=#ff0000>い<s=1.5>う</s></c>え", SubtitleAnimation::None);
        assert_eq!(dialogues(&p), vec!["あ{\\1c&H000000FF&\\fs50\\b0}い{\\1c&H000000FF&\\fs75\\b0}う{\\1c&H00FFFFFF&\\fs50\\b0}え"]);
        // 飾りがなければ今までどおり
        assert_eq!(dialogues(&line_with("あいう", SubtitleAnimation::None)), vec!["あいう"]);
        // 1 文字ずつ：まだ出ない文字は透明にする（飾りは保つ）
        let t = dialogues(&line_with("あ<c=#ff0000>いう</c>", SubtitleAnimation::Typewriter));
        assert!(t[1].ends_with("あ{\\1c&H000000FF&\\fs50\\b0\\alpha&HFF&}いう"), "{t:?}");
        assert_eq!(t.last().unwrap(), "あ{\\1c&H000000FF&\\fs50\\b0}いう");
        // カラオケ：塗る前の色（2c）を飾りの色にする
        let k = dialogues(&line_with("あ<c=#00ff00>い</c>", SubtitleAnimation::Karaoke));
        assert!(k[0].contains("{\\kf") && k[0].contains("\\2c&H0000FF00&\\fs50\\b0}い"), "{k:?}");
        // ルビのある字幕では大きさを使わない（色は使う）
        let r = dialogues(&line_with("<c=#ff0000><s=2>明日《あした》</s></c>", SubtitleAnimation::None));
        assert!(r[0].contains("\\1c&H000000FF&") && !r[0].contains("\\fs100"), "{r:?}");
        // 太字：<b>…</b>（入れ子・色との組み合わせ）。ふつうの文字に戻るときは \b0 を明示する
        let m = parse_markup("あ<b>い<c=#f00>う</c></b>え");
        assert_eq!(m.styles.iter().map(|x| x.as_ref().map(|s| s.bold)).collect::<Vec<_>>(), vec![None, Some(true), Some(true), None]);
        assert_eq!(crate::text::strip_markup("<b><b>あ</b>い</b>う</b>"), "あいう");
        let b = dialogues(&line_with("あ<b>い</b>う", SubtitleAnimation::None));
        assert_eq!(b, vec!["あ{\\1c&H00FFFFFF&\\fs50\\b1}い{\\1c&H00FFFFFF&\\fs50\\b0}う"]);
        // ルビのある字幕では太字も使わない
        let rb = dialogues(&line_with("<b>明日《あした》</b>", SubtitleAnimation::None));
        assert!(rb.iter().all(|l| !l.contains("\\b1")), "{rb:?}");
    }

    #[test]
    fn caption_style_override_gets_its_own_style() {
        let mut p = Project::sample();
        p.clips[0].track_id = "V4".into();
        p.clips.push(crate::model::Clip {
            id: "cap1".into(),
            track_id: "V2".into(),
            start: 0,
            duration: 90,
            link_id: None,
            body: ClipBody::Caption(crate::model::CaptionClip {
                voice_id: "c1".into(),
                style: Some(crate::model::SubtitleOverride { font_size: Some(80), position: Some(SubtitlePosition::Top), ..Default::default() }),
            }),
        });
        let s = build_ass(&p);
        let line = s.lines().find(|l| l.starts_with("Style: cap_cap1,")).expect(&s);
        assert!(line.contains(",80,") && line.ends_with(",8,40,40,60,1"), "{line}");
        assert!(s.contains(",cap_cap1,,0,0,0,,こんにちは"), "{s}");
    }

    #[test]
    fn letter_spacing_and_outer_outline_reach_the_ass() {
        let mut p = Project::sample();
        let st = &mut p.characters[0].subtitle;
        st.letter_spacing = 6.0;
        st.outline_width = 4;
        st.outline2_color = "#112233".into();
        st.outline2_width = 5;
        let id = p.characters[0].id.clone();
        let s = build_ass(&p);
        let main = s.lines().find(|l| l.starts_with(&format!("Style: {id},"))).expect(&s);
        let outer = s.lines().find(|l| l.starts_with(&format!("Style: {id}~o,"))).expect(&s);
        // 字間は Spacing（ScaleX,ScaleY の次）に入る
        assert!(main.contains(",100,100,6,0,"), "{main}");
        // 外側の縁の層は、縁が内側＋外側の太さで、色が外側の縁の色（#112233 → &H00332211）
        assert!(outer.contains("&H00332211") && outer.contains(",9,"), "{outer}");
        // 同じ字幕が 2 行になる：下の層（0）が外側の縁、上の層（1）がふつう
        let d: Vec<&str> = s.lines().filter(|l| l.starts_with("Dialogue:")).collect();
        assert!(d.iter().any(|l| l.starts_with("Dialogue: 0,") && l.contains(&format!(",{id}~o,"))), "{d:?}");
        assert!(d.iter().any(|l| l.starts_with("Dialogue: 1,") && l.contains(&format!(",{id},"))), "{d:?}");
        // 帯を敷いたときは外側の縁を使わない
        p.characters[0].subtitle.box_color = "#000000".into();
        let s2 = build_ass(&p);
        assert!(!s2.contains("~o"), "{s2}");
        // 字間が広いと折り返しの幅も広がる
        let mut a = p.characters[0].subtitle.clone();
        a.letter_spacing = 0.0;
        let mut b = a.clone();
        b.letter_spacing = 20.0;
        assert_eq!(wrap_em(&a), a.font_size);
        assert_eq!(wrap_em(&b), a.font_size + 20);
        b.letter_spacing = -10.0;
        assert_eq!(wrap_em(&b), a.font_size);
    }

    #[test]
    fn muted_track_is_skipped() {
        let mut p = Project::sample();
        p.tracks[1].hidden = true;
        assert_eq!(build_ass(&p).matches("Dialogue:").count(), 1, "V2 の 2 行が消え、V3 の 1 行が残る");
        // 音だけ止める（M）では字幕は消えない
        p.tracks[2].muted = true;
        assert_eq!(build_ass(&p).matches("Dialogue:").count(), 1);
        p.tracks[2].hidden = true;
        assert_eq!(build_ass(&p).matches("Dialogue:").count(), 0);
    }
}
