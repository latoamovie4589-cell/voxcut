//! 合成前のテキスト処理。

use serde::{Deserialize, Serialize};

/// 読み方の辞書の 1 項目（「書き方」を「読み」に置き換えて合成する。字幕は書き方のまま）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DictEntry {
    pub word: String,
    pub reading: String,
}

/// 読み方の辞書。長い語から先に当てる（「東京都」と「東京」があれば「東京都」が勝つ）
#[derive(Debug, Clone, Default)]
pub struct Dictionary {
    entries: Vec<(Vec<char>, String)>,
}

impl Dictionary {
    pub fn new(entries: &[DictEntry]) -> Self {
        let mut e: Vec<(Vec<char>, String)> = entries
            .iter()
            .filter(|d| !d.word.trim().is_empty())
            .map(|d| (d.word.chars().collect(), d.reading.clone()))
            .collect();
        e.sort_by_key(|x| std::cmp::Reverse(x.0.len()));
        Self { entries: e }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 左から順に、その位置で一番長く合う語を置き換える（置き換えた後の文字はもう見ない）
    pub fn apply(&self, text: &str) -> String {
        if self.entries.is_empty() {
            return text.to_string();
        }
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        'outer: while i < chars.len() {
            for (w, r) in &self.entries {
                if chars[i..].starts_with(w) {
                    out.push_str(r);
                    i += w.len();
                    continue 'outer;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }
}

/// ルビの付いた文の 1 区切り（ruby が None なら地の文）
#[derive(Debug, Clone, PartialEq)]
pub struct RubySeg {
    pub base: String,
    pub ruby: Option<String>,
}

/// ルビを付けられる漢字（「々」「〆」「ヶ」「〇」を含む）
pub fn is_kanji(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}' | '々' | '〆' | 'ヶ' | '〇')
}

/// 「漢字《かんじ》」「｜文字《もじ》」の形のルビを区切る（青空文庫と同じ書き方）。
/// ｜がなければ《の直前の漢字の並びに付く。閉じていない《や、付ける文字がない《はそのまま文字として残す。画面側の ruby.ts と同じ
pub fn parse_ruby(text: &str) -> Vec<RubySeg> {
    parse_markup(text).segs
}

/// 一部の文字だけの飾り（`<c=#FF0000>赤</c>` で色、`<s=1.5>大</s>` で大きさ（倍）、`<b>太</b>` で太字。どれも入れ子にできる）
#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    /// "#RRGGBB"（大文字）
    pub color: Option<String>,
    /// 大きさの倍率（0.3〜4）
    pub size: Option<f64>,
    /// 太字（`<b>太</b>`）
    pub bold: bool,
}

/// ルビと飾りを読み取った結果。segs は飾りの書き方を外した区切り、styles は文字ごとの飾り（改行は数えない。飾りなしは None）
#[derive(Debug, Clone, PartialEq)]
pub struct Markup {
    pub segs: Vec<RubySeg>,
    pub styles: Vec<Option<Span>>,
}

/// 飾りの書き方（開く・閉じる）。長さ（文字数）とセット。書き方に合わない `<` は普通の文字。画面側の ruby.ts と同じ
#[derive(Debug, Clone, PartialEq)]
enum Tag {
    Color(String),
    Size(f64),
    EndColor,
    EndSize,
    Bold,
    EndBold,
}

fn parse_tag(c: &[char], i: usize) -> Option<(Tag, usize)> {
    if c.get(i) != Some(&'<') {
        return None;
    }
    let close = (i + 1..c.len().min(i + 20)).find(|&k| c[k] == '>')?;
    let inner: String = c[i + 1..close].iter().collect();
    let n = close + 1 - i;
    match inner.as_str() {
        "/c" => return Some((Tag::EndColor, n)),
        "/s" => return Some((Tag::EndSize, n)),
        "/b" => return Some((Tag::EndBold, n)),
        "b" => return Some((Tag::Bold, n)),
        _ => {}
    }
    if let Some(v) = inner.strip_prefix("c=") {
        let h = v.strip_prefix('#').unwrap_or(v);
        if !h.chars().all(|x| x.is_ascii_hexdigit()) {
            return None;
        }
        let full: String = match h.len() {
            6 => h.to_uppercase(),
            3 => h.chars().flat_map(|x| [x, x]).collect::<String>().to_uppercase(),
            _ => return None,
        };
        return Some((Tag::Color(format!("#{full}")), n));
    }
    if let Some(v) = inner.strip_prefix("s=") {
        if v.is_empty() || !v.chars().all(|x| x.is_ascii_digit() || x == '.') {
            return None;
        }
        let k: f64 = v.parse().ok()?;
        return Some((Tag::Size(k.clamp(0.3, 4.0)), n));
    }
    None
}

/// ルビを読み取ってから、各区切りの飾りの書き方を外す（飾りは区切りをまたいでよい）
pub fn parse_markup(text: &str) -> Markup {
    let mut colors: Vec<String> = vec![];
    let mut sizes: Vec<f64> = vec![];
    let mut bold = 0usize;
    let mut segs = vec![];
    let mut styles = vec![];
    for seg in parse_ruby_raw(text) {
        let c: Vec<char> = seg.base.chars().collect();
        let mut base = String::new();
        let mut i = 0;
        while i < c.len() {
            if let Some((tag, n)) = parse_tag(&c, i) {
                match tag {
                    Tag::Color(v) => colors.push(v),
                    Tag::Size(v) => sizes.push(v),
                    Tag::EndColor => {
                        colors.pop();
                    }
                    Tag::EndSize => {
                        sizes.pop();
                    }
                    Tag::Bold => bold += 1,
                    Tag::EndBold => bold = bold.saturating_sub(1),
                }
                i += n;
                continue;
            }
            base.push(c[i]);
            if c[i] != '\n' {
                let (col, sz) = (colors.last().cloned(), sizes.last().copied());
                styles.push(if col.is_none() && sz.is_none() && bold == 0 { None } else { Some(Span { color: col, size: sz, bold: bold > 0 }) });
            }
            i += 1;
        }
        // 書き方だけで空になった地の文は捨てる
        if !base.is_empty() || seg.ruby.is_some() {
            segs.push(RubySeg { base, ruby: seg.ruby });
        }
    }
    Markup { segs, styles }
}

/// 飾りの書き方を外した、画面に出す文（ルビもそのまま）
pub fn strip_markup(text: &str) -> String {
    parse_markup(text).segs.iter().map(|s| s.base.as_str()).collect()
}

fn parse_ruby_raw(text: &str) -> Vec<RubySeg> {
    let c: Vec<char> = text.chars().collect();
    let mut out: Vec<RubySeg> = vec![];
    let mut cur: Vec<char> = vec![];
    let mut mark: Option<usize> = None;
    // i から先、改行の前に《…》があれば、その《と》の位置
    let find = |i: usize| -> Option<(usize, usize)> {
        let open = (i..c.len()).take_while(|&k| c[k] != '\n').find(|&k| c[k] == '《')?;
        let close = (open + 1..c.len()).take_while(|&k| c[k] != '\n').find(|&k| c[k] == '》')?;
        Some((open, close))
    };
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if (ch == '｜' || ch == '|') && find(i + 1).is_some_and(|(o, _)| !c[i + 1..o].iter().any(|&x| x == '｜' || x == '|')) {
            mark = Some(cur.len());
            i += 1;
            continue;
        }
        if ch == '《' {
            if let Some((_, close)) = find(i).filter(|&(o, cl)| o == i && cl > i + 1) {
                let split = mark.unwrap_or_else(|| {
                    let mut s = cur.len();
                    while s > 0 && is_kanji(cur[s - 1]) {
                        s -= 1;
                    }
                    s
                });
                if split < cur.len() {
                    if split > 0 {
                        out.push(RubySeg { base: cur[..split].iter().collect(), ruby: None });
                    }
                    out.push(RubySeg { base: cur[split..].iter().collect(), ruby: Some(c[i + 1..close].iter().collect()) });
                    cur.clear();
                    mark = None;
                    i = close + 1;
                    continue;
                }
            }
        }
        if ch == '\n' {
            mark = None;
        }
        cur.push(ch);
        i += 1;
    }
    if !cur.is_empty() {
        out.push(RubySeg { base: cur.into_iter().collect(), ruby: None });
    }
    out
}

/// ルビの書き方を外した、画面に出す文
pub fn ruby_base(text: &str) -> String {
    parse_ruby(text).into_iter().map(|s| s.base).collect()
}

/// ルビを読みにした、合成する文（「明日《あした》」→「あした」）
pub fn ruby_reading(text: &str) -> String {
    parse_ruby(text).into_iter().map(|s| s.ruby.unwrap_or(s.base)).collect()
}

/// `max_chars` 文字以下になるよう、句読点・改行の位置で分割する。
/// 句読点がなく長すぎる部分は文字数で強制的に切る。
pub fn split_for_engine(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);
    // まず文の区切りで割る（区切り文字は前の文に残す）
    let mut sentences: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch == '\n' || ch == '\r' {
            if !cur.trim().is_empty() {
                sentences.push(std::mem::take(&mut cur));
            }
            cur.clear();
            continue;
        }
        cur.push(ch);
        if matches!(ch, '。' | '！' | '？' | '!' | '?' | '、' | '，' | ',' | '．') {
            sentences.push(std::mem::take(&mut cur));
        }
    }
    if !cur.trim().is_empty() {
        sentences.push(cur);
    }

    // 上限まで文を詰める
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    for s in sentences {
        let s_len = s.chars().count();
        if s_len > max_chars {
            if !buf.is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            let chars: Vec<char> = s.chars().collect();
            for chunk in chars.chunks(max_chars) {
                out.push(chunk.iter().collect());
            }
            continue;
        }
        if buf.chars().count() + s_len > max_chars {
            out.push(std::mem::take(&mut buf));
        }
        buf.push_str(&s);
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn ruby_notation() {
        let segs = parse_ruby("今日は夕暮《ゆうぐれ》時｜VoxCut《ボックスカット》です");
        assert_eq!(segs.iter().map(|s| (s.base.as_str(), s.ruby.as_deref())).collect::<Vec<_>>(), vec![("今日は", None), ("夕暮", Some("ゆうぐれ")), ("時", None), ("VoxCut", Some("ボックスカット")), ("です", None)]);
        assert_eq!(ruby_base("明日《あした》、｜Ｃ《シー》"), "明日、Ｃ");
        assert_eq!(ruby_reading("明日《あした》は晴れ"), "あしたは晴れ");
        // 付ける文字がない・閉じていない・縦棒だけは文字のまま
        assert_eq!(ruby_base("《注》と|と《あ"), "《注》と|と《あ");
        assert_eq!(ruby_base("ひらがな《かな》"), "ひらがな《かな》");
        assert_eq!(ruby_base("ａ｜漢字\n《かんじ》"), "ａ｜漢字\n《かんじ》");
    }

    use super::*;

    #[test]
    fn dictionary_longest_match_first() {
        let d = Dictionary::new(&[
            DictEntry { word: "東京".into(), reading: "とうきょう".into() },
            DictEntry { word: "東京都".into(), reading: "とうきょうと".into() },
            DictEntry { word: "VoxCut".into(), reading: "ボックスカット".into() },
            DictEntry { word: " ".into(), reading: "x".into() },
        ]);
        assert_eq!(d.apply("東京都と東京でVoxCut"), "とうきょうと・と・とうきょう・で・ボックスカット".replace("・", ""));
        assert_eq!(d.apply("なし"), "なし");
        // 置き換えた読みの中は、もう一度置き換えない
        let d2 = Dictionary::new(&[DictEntry { word: "a".into(), reading: "ab".into() }, DictEntry { word: "b".into(), reading: "c".into() }]);
        assert_eq!(d2.apply("ab"), "abc");
        assert!(Dictionary::new(&[]).is_empty());
    }

    #[test]
    fn short_text_is_one_chunk() {
        assert_eq!(split_for_engine("こんにちは。", 140), vec!["こんにちは。"]);
    }

    #[test]
    fn splits_at_punctuation_within_limit() {
        let t = "あいうえお。かきくけこ。さしすせそ。";
        let r = split_for_engine(t, 12);
        assert_eq!(r, vec!["あいうえお。かきくけこ。", "さしすせそ。"]);
        assert!(r.iter().all(|s| s.chars().count() <= 12));
    }

    #[test]
    fn hard_splits_long_run() {
        let t = "あ".repeat(25);
        let r = split_for_engine(&t, 10);
        assert_eq!(r.iter().map(|s| s.chars().count()).collect::<Vec<_>>(), vec![10, 10, 5]);
    }

    #[test]
    fn newlines_split() {
        assert_eq!(split_for_engine("一行目\n二行目", 2), vec!["一行", "目", "二行", "目"]);
        assert_eq!(split_for_engine("一行目\n二行目", 140), vec!["一行目二行目"]);
    }
}
