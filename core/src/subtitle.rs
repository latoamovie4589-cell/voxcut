//! セリフから ASS 字幕を作る（FFmpeg の ass フィルタで焼き込む）。

use crate::model::{Clip, Frame, Project, SubtitleAnimation, SubtitlePosition, SubtitleStyle};
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
        "Style: {name},{font},{size},{pri},&H000000FF,{out},{back},0,0,0,0,100,100,0,0,{border},{ow},{shadow},{al},40,40,{mv},1",
        font = s.font_family,
        size = s.font_size,
        pri = ass_color(&s.color),
        al = alignment(s.position),
        mv = s.margin_v,
    )
}

/// 不透明度つきの色（ASS は透明度で書く。00 が不透明）
fn ass_color_alpha(hex: &str, opacity: f64) -> String {
    let a = ((1.0 - opacity.clamp(0.0, 1.0)) * 255.0).round() as u8;
    format!("&H{a:02X}{}", &ass_color(hex)[4..])
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
    for c in &p.characters {
        let _ = writeln!(out, "{}", style_line(&c.id, &c.subtitle));
    }
    // 見た目を上書きした字幕は、その字幕だけのスタイルを作る
    for c in &p.clips {
        let Some(cap) = c.as_caption() else { continue };
        let Some(ov) = &cap.style else { continue };
        let Some(ch) = p.clips.iter().find(|x| x.id == cap.voice_id).and_then(|x| x.as_voice()).and_then(|v| p.character(&v.character_id)) else { continue };
        let _ = writeln!(out, "{}", style_line(&caption_style_name(&c.id), &ov.apply(&ch.subtitle)));
    }
    let _ = writeln!(out, "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
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
        let wrapped = eff.map(|st| wrap_subtitle(text, st.font_size, p.video.width.saturating_sub(80), st.max_chars)).unwrap_or_else(|| text.to_string());
        let text = wrapped.as_str();
        // 出し方：分離した字幕で上書きしていればそれ
        let anim = c
            .as_caption()
            .and_then(|cap| cap.style.as_ref())
            .and_then(|o| o.animation)
            .or_else(|| p.character(&v.character_id).map(|ch| ch.subtitle.animation))
            .unwrap_or_default();
        let ms = (p.video.frames_to_secs(anim_frames(p.video.fps)) * 1000.0).round() as u32;
        match anim {
            SubtitleAnimation::None => dialogue(&mut out, p, c.start, c.end(), &style, &escape_text(text)),
            SubtitleAnimation::Fade => {
                dialogue(&mut out, p, c.start, c.end(), &style, &format!("{{\\fad({ms},{ms})}}{}", escape_text(text)))
            }
            SubtitleAnimation::Pop => dialogue(
                &mut out,
                p,
                c.start,
                c.end(),
                &style,
                &format!("{{\\fscx85\\fscy85\\t(0,{ms},0.5,\\fscx100\\fscy100)}}{}", escape_text(text)),
            ),
            SubtitleAnimation::Typewriter => {
                // 表示文字数が変わるフレームごとに 1 行。文字の位置は全文で決まるので、出ていない文字は透明にしておく
                let chars = text.chars().filter(|ch| *ch != '\n' && *ch != '\r').count();
                let mut seg_start = 0;
                let mut cur = typewriter_count(chars, c.duration, 0);
                for f in 1..=c.duration {
                    let next = if f == c.duration { usize::MAX } else { typewriter_count(chars, c.duration, f) };
                    if next != cur {
                        dialogue(&mut out, p, c.start + seg_start, c.start + f, &style, &reveal_text(text, cur));
                        seg_start = f;
                        cur = next;
                    }
                }
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
        .map(|(c, v)| (c.start, c.end(), v.subtitle.as_deref().unwrap_or(&v.text).trim().to_string()))
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
