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
