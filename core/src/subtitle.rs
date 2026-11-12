//! セリフから ASS 字幕を作る（FFmpeg の ass フィルタで焼き込む）。

use crate::model::{Clip, ClipBody, Frame, Project, SubtitleAnimation, SubtitlePosition, SubtitleStyle};
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
    format!(
        "Style: {name},{font},{size},{pri},&H000000FF,{out},&H80000000,0,0,0,0,100,100,0,0,1,{ow},0,{al},40,40,{mv},1",
        font = s.font_family,
        size = s.font_size,
        pri = ass_color(&s.color),
        out = ass_color(&s.outline_color),
        ow = s.outline_width,
        al = alignment(s.position),
        mv = s.margin_v,
    )
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

/// プロジェクト全体の ASS を作る。ミュートしたトラックのセリフは出さない。
pub fn build_ass(p: &Project) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n", p.video.width, p.video.height);
    let _ = writeln!(out, "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding");
    for c in &p.characters {
        let _ = writeln!(out, "{}", style_line(&c.id, &c.subtitle));
    }
    let _ = writeln!(out, "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
    let mut clips: Vec<&Clip> = p
        .clips
        .iter()
        .filter(|c| matches!(c.body, ClipBody::Voice(_)) && p.track(&c.track_id).is_some_and(|t| !t.muted))
        .collect();
    clips.sort_by_key(|c| c.start);
    for c in clips {
        let ClipBody::Voice(v) = &c.body else { continue };
        let text = v.subtitle.as_deref().unwrap_or(&v.text);
        if text.trim().is_empty() {
            continue;
        }
        let anim = p.character(&v.character_id).map(|ch| ch.subtitle.animation).unwrap_or_default();
        let ms = (p.video.frames_to_secs(anim_frames(p.video.fps)) * 1000.0).round() as u32;
        match anim {
            SubtitleAnimation::None => dialogue(&mut out, p, c.start, c.end(), &v.character_id, &escape_text(text)),
            SubtitleAnimation::Fade => {
                dialogue(&mut out, p, c.start, c.end(), &v.character_id, &format!("{{\\fad({ms},{ms})}}{}", escape_text(text)))
            }
            SubtitleAnimation::Pop => dialogue(
                &mut out,
                p,
                c.start,
                c.end(),
                &v.character_id,
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
                        dialogue(&mut out, p, c.start + seg_start, c.start + f, &v.character_id, &reveal_text(text, cur));
                        seg_start = f;
                        cur = next;
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(s.contains("Style: ch_b,"));
        assert_eq!(s.matches("Dialogue:").count(), 3);
        assert!(s.contains("Dialogue: 0,0:00:00.00,0:00:02.80,ch_a,,0,0,0,,こんにちは。"));
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
        assert!(lines[3].ends_with(",あいう") && lines[3].contains(",0:00:02.80,"));
        assert_eq!(reveal_text("あ\nいう", 2), "あ\\Nい{\\alpha&HFF&}う");
    }

    #[test]
    fn muted_track_is_skipped() {
        let mut p = Project::sample();
        p.tracks[0].muted = true;
        assert_eq!(build_ass(&p).matches("Dialogue:").count(), 0);
    }
}
