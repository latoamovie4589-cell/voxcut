//! 合成前のテキスト処理。

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
