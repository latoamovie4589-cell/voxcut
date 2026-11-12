//! プロジェクトファイル（*.voxcut）のデータモデル。
//! 時間はすべて整数フレームで持つ（浮動小数の誤差でクリップがずれないように）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROJECT_VERSION: u32 = 1;

pub type Frame = i64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    pub name: String,
    pub video: VideoSettings,
    pub characters: Vec<Character>,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub sample_rate: u32,
    pub background: String,
}

impl Default for VideoSettings {
    fn default() -> Self {
        Self { width: 1920, height: 1080, fps: 30, sample_rate: 48_000, background: "#000000".into() }
    }
}

impl VideoSettings {
    pub fn frames_to_secs(&self, f: Frame) -> f64 {
        f as f64 / self.fps as f64
    }
    /// 音声の長さ（ms）を、切り上げでフレーム数に変換する。
    pub fn ms_to_frames_ceil(&self, ms: u64) -> Frame {
        (ms as u128 * self.fps as u128).div_ceil(1000) as Frame
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum EngineId {
    Aivoice,
    Voicepeak,
    Voisona,
    Voicevox,
}

impl EngineId {
    pub const ALL: [EngineId; 4] = [EngineId::Aivoice, EngineId::Voicepeak, EngineId::Voisona, EngineId::Voicevox];
    pub fn as_str(&self) -> &'static str {
        match self {
            EngineId::Aivoice => "aivoice",
            EngineId::Voicepeak => "voicepeak",
            EngineId::Voisona => "voisona",
            EngineId::Voicevox => "voicevox",
        }
    }
}

/// 声のパラメータ。共通の4項目と、エンジン固有の感情値。
/// 値の意味：speed/volume/intonation は 1.0 が標準、pitch は 0.0 が標準（半音単位相当）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceParams {
    pub speed: f64,
    pub pitch: f64,
    pub volume: f64,
    pub intonation: f64,
    /// VOICEPEAK の感情（happy=0..100 など）、VoiSona のスタイル重みなど
    pub emotions: BTreeMap<String, f64>,
}

impl Default for VoiceParams {
    fn default() -> Self {
        Self { speed: 1.0, pitch: 0.0, volume: 1.0, intonation: 1.0, emotions: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub engine: EngineId,
    pub speaker: String,
    #[serde(default)]
    pub params: VoiceParams,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SubtitlePosition {
    Top,
    Middle,
    Bottom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleStyle {
    pub font_family: String,
    pub font_size: u32,
    pub color: String,
    pub outline_color: String,
    pub outline_width: u32,
    pub position: SubtitlePosition,
    pub margin_v: u32,
    #[serde(default)]
    pub animation: SubtitleAnimation,
}

/// 字幕の出し方。プレビュー（app/src/subtitleAnim.ts）と書き出し（subtitle.rs）で同じ時間配分にする
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SubtitleAnimation {
    #[default]
    None,
    /// 0.2 秒でフェードイン・アウト
    Fade,
    /// 0.2 秒で 85% → 100% に大きくなって出る
    Pop,
    /// 1 文字ずつ出る（長さの 6 割か、1 文字 2 フレームの短いほう）
    Typewriter,
}

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            // Windows 標準の和文 UI フォント（Mac で書き出す場合はヒラギノに変える）
            font_family: "Yu Gothic UI".into(),
            font_size: 56,
            color: "#FFFFFF".into(),
            outline_color: "#000000".into(),
            outline_width: 4,
            position: SubtitlePosition::Bottom,
            margin_v: 60,
            animation: SubtitleAnimation::None,
        }
    }
}

/// 立ち絵。すべて同じキャンバスサイズの透過 PNG を重ねる（YMM4 のパーツ分け立ち絵と同じ考え方）。
/// 重ね順：base → eyes → mouth。目・口は無くてもよい（無ければその層を描かない）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Portrait {
    pub base: String,
    /// [開, 半目, 閉]
    #[serde(default)]
    pub eyes: [Option<String>; 3],
    /// [閉, 半開き, 開]
    #[serde(default)]
    pub mouth: [Option<String>; 3],
    #[serde(default = "portrait_transform")]
    pub transform: Transform,
    #[serde(default = "yes")]
    pub visible: bool,
}

fn portrait_transform() -> Transform {
    // 既定は右下寄り
    Transform { x: 560.0, y: 140.0, scale: 1.0, opacity: 1.0 }
}

fn yes() -> bool {
    true
}

impl Portrait {
    /// 重ねる画像の一覧（存在するものだけ）
    pub fn layers(&self, eyes: usize, mouth: usize) -> Vec<&str> {
        let mut v = vec![self.base.as_str()];
        if let Some(e) = self.eyes.get(eyes).and_then(|e| e.as_deref()).or(self.eyes[0].as_deref()) {
            v.push(e);
        }
        if let Some(m) = self.mouth.get(mouth).and_then(|m| m.as_deref()).or(self.mouth[0].as_deref()) {
            v.push(m);
        }
        v
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    pub name: String,
    pub color: String,
    pub voice: Voice,
    #[serde(default)]
    pub subtitle: SubtitleStyle,
    #[serde(default)]
    pub portrait: Option<Portrait>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Voice,
    Media,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioRef {
    pub cache_key: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub opacity: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, scale: 1.0, opacity: 1.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceClip {
    pub character_id: String,
    pub text: String,
    /// None なら text をそのまま字幕に使う
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub params_override: Option<VoiceParams>,
    #[serde(default)]
    pub audio: Option<AudioRef>,
    #[serde(default = "default_gap")]
    pub gap_after: Frame,
    /// true なら合成後も duration を自動で変えない
    #[serde(default)]
    pub lock_duration: bool,
}

fn default_gap() -> Frame {
    6
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaClip {
    pub src: String,
    pub media_kind: MediaKind,
    /// 動画に音声が入っているか（追加時に ffprobe で調べる）
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub in_point: Frame,
    #[serde(default = "one")]
    pub volume: f64,
    #[serde(default)]
    pub transform: Transform,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClipBody {
    Voice(VoiceClip),
    Media(MediaClip),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub track_id: String,
    pub start: Frame,
    pub duration: Frame,
    #[serde(flatten)]
    pub body: ClipBody,
}

impl Clip {
    pub fn end(&self) -> Frame {
        self.start + self.duration
    }
    pub fn as_voice(&self) -> Option<&VoiceClip> {
        match &self.body {
            ClipBody::Voice(v) => Some(v),
            _ => None,
        }
    }
    pub fn as_voice_mut(&mut self) -> Option<&mut VoiceClip> {
        match &mut self.body {
            ClipBody::Voice(v) => Some(v),
            _ => None,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ValidationError {
    #[error("未対応のプロジェクトバージョン: {0}")]
    Version(u32),
    #[error("ID が重複しています: {0}")]
    DuplicateId(String),
    #[error("クリップ {clip} のトラック {track} が見つかりません")]
    MissingTrack { clip: String, track: String },
    #[error("クリップ {clip} のキャラクター {character} が見つかりません")]
    MissingCharacter { clip: String, character: String },
    #[error("クリップ {0} の位置か長さが不正です")]
    BadRange(String),
    #[error("fps は 1 以上にしてください")]
    BadFps,
}

impl Project {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            version: PROJECT_VERSION,
            name: name.into(),
            video: VideoSettings::default(),
            characters: vec![],
            tracks: vec![
                Track { id: "t_voice".into(), kind: TrackKind::Voice, name: "セリフ".into(), muted: false, locked: false },
                Track { id: "t_media".into(), kind: TrackKind::Media, name: "素材".into(), muted: false, locked: false },
            ],
            clips: vec![],
        }
    }

    pub fn from_json(s: &str) -> Result<Self, crate::Error> {
        let p: Project = serde_json::from_str(s)?;
        p.validate()?;
        Ok(p)
    }

    pub fn to_json(&self) -> Result<String, crate::Error> {
        Ok(serde_json::to_string_pretty(self)?)
    }

    pub fn character(&self, id: &str) -> Option<&Character> {
        self.characters.iter().find(|c| c.id == id)
    }

    pub fn track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    /// 動画全体の長さ（最後のクリップの終わり）
    pub fn duration(&self) -> Frame {
        self.clips.iter().map(Clip::end).max().unwrap_or(0)
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.version != PROJECT_VERSION {
            return Err(ValidationError::Version(self.version));
        }
        if self.video.fps == 0 {
            return Err(ValidationError::BadFps);
        }
        let mut seen = std::collections::HashSet::new();
        let ids = self
            .characters
            .iter()
            .map(|c| &c.id)
            .chain(self.tracks.iter().map(|t| &t.id))
            .chain(self.clips.iter().map(|c| &c.id));
        for id in ids {
            if !seen.insert(id.as_str()) {
                return Err(ValidationError::DuplicateId(id.clone()));
            }
        }
        for c in &self.clips {
            if self.track(&c.track_id).is_none() {
                return Err(ValidationError::MissingTrack { clip: c.id.clone(), track: c.track_id.clone() });
            }
            if c.start < 0 || c.duration <= 0 {
                return Err(ValidationError::BadRange(c.id.clone()));
            }
            if let ClipBody::Voice(v) = &c.body {
                if self.character(&v.character_id).is_none() {
                    return Err(ValidationError::MissingCharacter {
                        clip: c.id.clone(),
                        character: v.character_id.clone(),
                    });
                }
            }
        }
        Ok(())
    }

    /// セリフの長さを音声に合わせ、後ろのセリフをずらす（YMM4 と同じ挙動）。
    /// - 直前のセリフに詰めて置かれていた行（開始 = 直前の終わり + 間）は、新しい長さに合わせて詰め直す
    /// - 手で離して置いた行は位置を保つ。ただし直前と重なるなら後ろへ押し出す
    pub fn reflow_voice_track(&mut self, track_id: &str) {
        let video = self.video.clone();
        let mut idx: Vec<usize> = self
            .clips
            .iter()
            .enumerate()
            .filter(|(_, c)| c.track_id == track_id && c.as_voice().is_some())
            .map(|(i, _)| i)
            .collect();
        idx.sort_by_key(|&i| self.clips[i].start);
        // (直前の旧い終わり + 間, 直前の新しい終わり + 間)
        let mut prev: Option<(Frame, Frame)> = None;
        for i in idx {
            let clip = &mut self.clips[i];
            let v = clip.as_voice().unwrap().clone();
            let old_end = clip.end();
            if !v.lock_duration {
                if let Some(a) = &v.audio {
                    clip.duration = video.ms_to_frames_ceil(a.duration_ms).max(1);
                }
            }
            if let Some((old_next, new_next)) = prev {
                clip.start = if clip.start == old_next { new_next } else { clip.start.max(new_next) };
            }
            prev = Some((old_end + v.gap_after, clip.end() + v.gap_after));
        }
    }

    /// クリップが実際に使う声（キャラクターの声＋行ごとの上書き）
    pub fn effective_voice(&self, clip: &VoiceClip) -> Option<Voice> {
        let ch = self.character(&clip.character_id)?;
        let mut voice = ch.voice.clone();
        if let Some(p) = &clip.params_override {
            voice.params = p.clone();
        }
        Some(voice)
    }

    /// 動作確認用のサンプル
    pub fn sample() -> Self {
        let mut p = Project::new("サンプル");
        p.characters = vec![
            Character {
                id: "ch_a".into(),
                name: "ナレーター".into(),
                color: "#0A84FF".into(),
                voice: Voice { engine: EngineId::Voicepeak, speaker: "Japanese Female 1".into(), params: VoiceParams::default() },
                subtitle: SubtitleStyle::default(),
                portrait: None,
            },
            Character {
                id: "ch_b".into(),
                name: "アシスタント".into(),
                color: "#FF9F0A".into(),
                voice: Voice { engine: EngineId::Aivoice, speaker: "琴葉 茜".into(), params: VoiceParams::default() },
                subtitle: SubtitleStyle { color: "#FFE08A".into(), ..SubtitleStyle::default() },
                portrait: None,
            },
        ];
        let lines = [
            ("ch_a", "こんにちは。VoxCut のサンプルです。"),
            ("ch_b", "セリフを入力すると、音声と字幕が自動で並びます。"),
            ("ch_a", "声は A.I.VOICE、VOICEPEAK、VoiSona Talk から選べます。"),
        ];
        for (i, (ch, text)) in lines.iter().enumerate() {
            p.clips.push(Clip {
                id: format!("c{}", i + 1),
                track_id: "t_voice".into(),
                start: i as Frame * 90,
                duration: 84,
                body: ClipBody::Voice(VoiceClip {
                    character_id: (*ch).into(),
                    text: (*text).into(),
                    subtitle: None,
                    params_override: None,
                    audio: None,
                    gap_after: 6,
                    lock_duration: false,
                }),
            });
        }
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_roundtrip_and_shape() {
        let p = Project::sample();
        let s = p.to_json().unwrap();
        // 設計書どおり camelCase と type タグで出ること
        assert!(s.contains("\"characterId\""));
        assert!(s.contains("\"type\": \"voice\""));
        assert!(s.contains("\"engine\": \"voicepeak\""));
        let back = Project::from_json(&s).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn validation_catches_errors() {
        let mut p = Project::sample();
        p.clips[0].track_id = "nope".into();
        assert!(matches!(p.validate(), Err(ValidationError::MissingTrack { .. })));

        let mut p = Project::sample();
        p.clips[1].id = "c1".into();
        assert_eq!(p.validate(), Err(ValidationError::DuplicateId("c1".into())));

        let mut p = Project::sample();
        p.clips[0].duration = 0;
        assert_eq!(p.validate(), Err(ValidationError::BadRange("c1".into())));
    }

    #[test]
    fn ms_to_frames_rounds_up() {
        let v = VideoSettings::default(); // 30fps
        assert_eq!(v.ms_to_frames_ceil(1000), 30);
        assert_eq!(v.ms_to_frames_ceil(1001), 31);
        assert_eq!(v.ms_to_frames_ceil(2410), 73);
    }

    #[test]
    fn reflow_fits_audio_and_packs() {
        let mut p = Project::sample();
        for (i, c) in p.clips.iter_mut().enumerate() {
            c.as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: format!("k{i}"), duration_ms: 1000 * (i as u64 + 1) });
        }
        p.reflow_voice_track("t_voice");
        let r: Vec<(Frame, Frame)> = p.clips.iter().map(|c| (c.start, c.duration)).collect();
        assert_eq!(r, vec![(0, 30), (36, 60), (102, 90)]);
        assert_eq!(p.duration(), 192);
    }

    #[test]
    fn reflow_keeps_manual_gap_but_pushes_overlap() {
        let mut p = Project::sample();
        p.clips[2].start = 400; // 手で離した
        for c in p.clips.iter_mut() {
            c.as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: "k".into(), duration_ms: 1000 });
        }
        p.reflow_voice_track("t_voice");
        assert_eq!(p.clips[1].start, 36); // 詰めていた行は詰め直す
        assert_eq!(p.clips[2].start, 400); // 離した行はそのまま
        p.clips[0].as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: "k".into(), duration_ms: 20_000 });
        p.reflow_voice_track("t_voice");
        assert_eq!(p.clips[1].start, 606);
        assert_eq!(p.clips[2].start, 642); // 重なるので押し出し
    }

    #[test]
    fn portrait_layers_fall_back_to_first_variant() {
        let pt = Portrait {
            base: "b.png".into(),
            eyes: [Some("e0.png".into()), None, Some("e2.png".into())],
            mouth: [Some("m0.png".into()), None, None],
            transform: Transform::default(),
            visible: true,
        };
        assert_eq!(pt.layers(2, 2), vec!["b.png", "e2.png", "m0.png"]);
        assert_eq!(pt.layers(1, 0), vec!["b.png", "e0.png", "m0.png"]);
        let json = r#"{"base":"b.png"}"#;
        let p2: Portrait = serde_json::from_str(json).unwrap();
        assert!(p2.visible && p2.eyes == [None, None, None]);
    }
}
