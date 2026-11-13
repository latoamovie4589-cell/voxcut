//! プロジェクトファイル（*.voxcut）のデータモデル。
//! 時間はすべて整数フレームで持つ（浮動小数の誤差でクリップがずれないように）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 2：トラックをレイヤー（YMM4 と同じく、下の段ほど手前に描く・どのアイテムも置ける）にし、
///    セリフの長さに「セリフ後の余韻」を含めるようにした。
/// 3：Premiere Pro と同じく、映像トラック（V1, V2…：番号の大きいほど手前）と音声トラック（A1, A2…）に分けた。
///    セリフ（字幕と声）・音の入った動画は、入れたときは映像トラックの 1 つのクリップ。
///    分離すると、音声（A トラック）と字幕・映像（V トラック）のリンクしたクリップになる。
///    古い版は読み込み時に変換する
pub const PROJECT_VERSION: u32 = 4;

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
    /// ソフトごとの細かい調声（VOICEVOX の間の長さ、A.I.VOICE のポーズ、VoiSona の声の若さ・かすれなど）。
    /// 名前は各エンジンのパラメータ名。空なら保存しない（キャッシュのキーも変わらない）
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, f64>,
}

impl Default for VoiceParams {
    fn default() -> Self {
        Self { speed: 1.0, pitch: 0.0, volume: 1.0, intonation: 1.0, emotions: BTreeMap::new(), extra: BTreeMap::new() }
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
    /// 喋っているとき（このキャラクターのセリフの間）だけ表示する
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub only_while_speaking: bool,
    /// 表情差分。セリフごとに名前で選ぶ（選ばなければ通常の画像）
    #[serde(default)]
    pub expressions: Vec<Expression>,
    /// PSD 立ち絵。あれば base・eyes・mouth の画像の代わりに、PSD のレイヤーの表示を切り替えて描く
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub psd: Option<PsdPortrait>,
}

/// PSD 立ち絵の設定（YMM4・PSDToolKit と同じく、レイヤーの表示・非表示で目パチ・口パク・表情を作る）。
/// レイヤーは上からの位置をつないだ id（例 "2/0/5"）で指す。合成はアプリ（画面側）が行い、
/// 書き出しのときは状態ごとの画像を渡す（ExportOptions::portrait_frames）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PsdPortrait {
    pub src: String,
    /// いつもの表示状態（id → 表示するか。書いていないものは PSD に保存されていたとおり）
    #[serde(default)]
    pub visibility: BTreeMap<String, bool>,
    /// 目 [開, 半目, 閉] に使うレイヤー
    #[serde(default)]
    pub eyes: [Option<String>; 3],
    /// 口 [閉, 半開き, 開] に使うレイヤー
    #[serde(default)]
    pub mouth: [Option<String>; 3],
}

/// 表情。指定したパーツだけ通常の画像と差し替える（空のパーツは通常のまま）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Expression {
    pub name: String,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub eyes: [Option<String>; 3],
    #[serde(default)]
    pub mouth: [Option<String>; 3],
    /// PSD 立ち絵のとき：この表情で表示を変えるレイヤー（id → 表示するか）
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub visibility: BTreeMap<String, bool>,
}

fn portrait_transform() -> Transform {
    // 既定は右下寄り
    Transform { x: 560.0, y: 140.0, scale: 1.0, opacity: 1.0 }
}

fn yes() -> bool {
    true
}

/// パーツの i 番目（無ければ 0 番目）
fn variant(parts: &[Option<String>; 3], i: usize) -> Option<&str> {
    parts.get(i).and_then(|x| x.as_deref()).or(parts[0].as_deref())
}

impl Portrait {
    /// 重ねる画像の一覧（存在するものだけ）。`expr` は 0 が通常、1 以降が expressions[expr-1]
    pub fn layers(&self, eyes: usize, mouth: usize, expr: usize) -> Vec<&str> {
        let ex = expr.checked_sub(1).and_then(|i| self.expressions.get(i));
        // 表情側にあればそれ、無ければ通常の画像
        let base = ex.and_then(|e| e.base.as_deref()).filter(|b| !b.is_empty()).unwrap_or(self.base.as_str());
        let mut v = vec![base];
        if let Some(e) = ex.and_then(|e| variant(&e.eyes, eyes)).or_else(|| variant(&self.eyes, eyes)) {
            v.push(e);
        }
        if let Some(m) = ex.and_then(|e| variant(&e.mouth, mouth)).or_else(|| variant(&self.mouth, mouth)) {
            v.push(m);
        }
        v
    }

    /// 表情の名前 → 番号（0 は通常）
    pub fn expression_index(&self, name: Option<&str>) -> u8 {
        name.and_then(|n| self.expressions.iter().position(|e| e.name == n)).map(|i| (i + 1).min(255) as u8).unwrap_or(0)
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
    /// 声のプリセット（「叫び」「ささやき」など）。セリフごとに選べる
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub voice_presets: Vec<VoicePreset>,
    /// 字幕を置く映像トラックの番号（V1 なら 1）。None なら最後にこのキャラクターの字幕を置いたトラック
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<u32>,
    /// セリフの音声を置く音声トラックの番号（A1 なら 1）。None なら最後にこのキャラクターのセリフを置いたトラック
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_layer: Option<u32>,
    /// 新しいセリフの「セリフ後の余韻」（フレーム）。None なら 6
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap_after: Option<Frame>,
}

/// キャラクターの声のプリセット。話者を変えないなら speaker は None
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoicePreset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub speaker: Option<String>,
    pub params: VoiceParams,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    /// レイヤー（YMM4 と同じ。どのアイテムも置ける）。tracks の中で前にあるほど奥に描く（レイヤー 1 が一番奥）
    Video,
    /// 版 3 の音声トラック（読み込み時にレイヤーへ変換する）
    Audio,
    /// 版 1・2 のトラック（読み込み時に Video / Audio へ変換する）
    Voice,
    Media,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    /// 音だけ止める（M）
    #[serde(default)]
    pub muted: bool,
    /// 表示しない（目）。映像も音も出さない
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(default)]
    pub locked: bool,
    /// セリフの間だけ、このトラックの音（BGM など）を下げる
    #[serde(default)]
    pub duck: bool,
    /// 下げたときの音量（0〜1）
    #[serde(default = "duck_level")]
    pub duck_level: f64,
    /// ソロ（どれかをソロにすると、ソロのレイヤーの音だけ鳴る）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub solo: bool,
}

impl Track {
    pub fn new(id: impl Into<String>, kind: TrackKind) -> Self {
        Self { id: id.into(), kind, name: String::new(), muted: false, hidden: false, locked: false, duck: false, duck_level: 0.3, solo: false }
    }
}

fn duck_level() -> f64 {
    0.3
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
    /// この行だけ話者（VOICEVOX のスタイルなど）を変える
    #[serde(default)]
    pub speaker_override: Option<String>,
    /// この行の間の立ち絵の表情（Portrait.expressions の名前）
    #[serde(default)]
    pub expression: Option<String>,
    /// この行で使う声のプリセット（Character.voice_presets の id）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    /// VOICEVOX のアクセント・音の高さを手で直したもの。作ったときの文と話者が今と同じときだけ使う
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<AccentEdit>,
    /// 字幕を「個別に設定」したときの見た目。None ならキャラクターの字幕設定どおり
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle_custom: Option<Box<SubtitleCustom>>,
    /// このセリフの間だけ立ち絵を変える（レイヤーの表示・目パチ・口パク・エフェクト）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portrait: Option<LinePortrait>,
    /// 声の聞こえ方（左右・フェード・エコー・音声エフェクト・再生開始位置）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_fx: Option<Box<LineAudio>>,
}

/// セリフの声の聞こえ方。画面（preview/playback.ts）と書き出し（render.rs）で同じ効き方にする
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LineAudio {
    /// 左右（-1 = 左だけ、0 = 真ん中、1 = 右だけ）。真ん中から寄せた側はそのまま、反対側だけ小さくする
    #[serde(default)]
    pub pan: f64,
    /// フェードイン・アウト（フレーム。セリフの頭・終わりから）
    #[serde(default)]
    pub fade_in: Frame,
    #[serde(default)]
    pub fade_out: Frame,
    /// 再生開始位置：声の頭をこのフレームだけ飛ばす（セリフの長さもその分短くなる）
    #[serde(default)]
    pub start_offset: Frame,
    /// エコー（1 回だけ遅れて重なる）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echo: Option<Echo>,
    /// 音声エフェクト（上から順に掛ける）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<AudioFilter>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Echo {
    /// 遅れ（ミリ秒）
    pub delay_ms: f64,
    /// 重なる音の大きさ（0〜1）
    pub decay: f64,
}

/// 音声エフェクト（2 次のバターワース。画面の BiquadFilter と同じ形）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AudioFilter {
    /// これより低い音を削る
    Highpass { hz: f64 },
    /// これより高い音を削る
    Lowpass { hz: f64 },
}

impl VoiceClip {
    /// 再生開始位置（フレーム）
    pub fn start_offset(&self) -> Frame {
        self.audio_fx.as_ref().map(|a| a.start_offset.max(0)).unwrap_or(0)
    }
}

/// セリフの字幕を「個別に設定」したときの見た目（テキストアイテムと同じ項目。画面側で画像にして、書き出しでも重ねる）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCustom {
    pub font_family: String,
    pub font_size: u32,
    pub color: String,
    #[serde(default)]
    pub outline_color: String,
    #[serde(default)]
    pub outline_width: u32,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default = "center")]
    pub align: String,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default, skip_serializing_if = "Look::is_plain")]
    pub look: Look,
    /// 行の高さ（文字の大きさに対する倍率）
    #[serde(default = "line_height")]
    pub line_height: f64,
    /// 文字の間隔（px）
    #[serde(default)]
    pub letter_spacing: f64,
    /// この幅（px）で折り返す。0 なら折り返さない
    #[serde(default)]
    pub wrap_width: u32,
    /// 縦書き
    #[serde(default)]
    pub vertical: bool,
    /// 1 文字ずつ出す間隔（フレーム）。0 なら一度に出す。書き出しでは文字数ごとの画像を順に出す
    #[serde(default)]
    pub interval: Frame,
    /// 影の色（空ならなし）と、ずらす量（px）
    #[serde(default)]
    pub shadow_color: String,
    #[serde(default = "shadow_offset")]
    pub shadow_offset: f64,
    /// 背景の帯の色（空ならなし。#RRGGBBAA も可）と、文字の周りの余白（px）
    #[serde(default)]
    pub box_color: String,
    #[serde(default = "box_padding")]
    pub box_padding: f64,
}

fn line_height() -> f64 {
    1.3
}
fn shadow_offset() -> f64 {
    4.0
}
fn box_padding() -> f64 {
    16.0
}

/// セリフの間だけの立ち絵の変え方
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinePortrait {
    /// PSD のレイヤーの表示（id → 表示するか）。表情の表示の上に当てる
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub visibility: BTreeMap<String, bool>,
    /// 目パチしない（目を開けたまま）
    #[serde(default)]
    pub no_blink: bool,
    /// 口パクしない（口を閉じたまま）
    #[serde(default)]
    pub no_mouth: bool,
    /// このセリフの間、立ち絵に掛けるエフェクト
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
}

/// VOICEVOX のアクセント句（/accent_phrases の形そのまま）と、それを作ったときの文（辞書を当てた後）と話者
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccentEdit {
    pub text: String,
    pub speaker: String,
    pub phrases: serde_json::Value,
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
    /// 回転・アニメーション・フェード・映像エフェクト
    #[serde(default, skip_serializing_if = "Look::is_plain")]
    pub look: Look,
}

/// 見た目の動きと効果（画像・動画・テキスト・図形で共通。YMM4 のアニメーション・映像エフェクトに当たる）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    /// 回転（度、時計回り）
    #[serde(default)]
    pub rotation: f64,
    /// アイテムの終わりでの値。始まりは transform・rotation。間は ease で動く
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anim: Option<Anim>,
    /// 出てくるとき・消えるときのフェード（フレーム）
    #[serde(default)]
    pub fade_in: Frame,
    #[serde(default)]
    pub fade_out: Frame,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
}

impl Look {
    pub fn is_plain(&self) -> bool {
        *self == Look::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Anim {
    pub to: Transform,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub ease: Ease,
}

/// 動き方（直線・だんだん速く・だんだん遅く・加速して減速）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Ease {
    #[default]
    Linear,
    In,
    Out,
    InOut,
}

/// 映像エフェクト。画面（Canvas の filter）と書き出し（FFmpeg）で同じ効き方になるようにそろえる
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Effect {
    /// ぼかし（ガウス。半径 = 標準偏差 px）
    Blur { radius: f64 },
    /// 揺れ（振れ幅 px・1 秒あたりの回数）
    Shake { amount: f64, speed: f64 },
    /// 明るさ（倍率）・コントラスト・彩度（1 が元のまま）
    Color { brightness: f64, contrast: f64, saturation: f64 },
    /// 白黒
    Mono,
    /// 色の反転
    Invert,
    /// 波：横に揺らぐ（振れ幅 px・波の長さ px・1 秒あたりの回数）
    Wave { amount: f64, length: f64, speed: f64 },
    /// 渦巻き：真ん中ほど強くねじる（角度、度）
    Swirl { angle: f64 },
}

/// テキストアイテム（字幕とは別に、好きな位置・装飾で文字を出す）。画像は画面側で描いて書き出しに渡す
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextClip {
    pub text: String,
    pub font_family: String,
    pub font_size: u32,
    pub color: String,
    #[serde(default)]
    pub outline_color: String,
    #[serde(default)]
    pub outline_width: u32,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    /// left / center / right
    #[serde(default = "center")]
    pub align: String,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default, skip_serializing_if = "Look::is_plain")]
    pub look: Look,
}

fn center() -> String {
    "center".into()
}

/// 図形アイテム（四角・角丸・円・三角・線・星）。画像は画面側で描いて書き出しに渡す
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShapeClip {
    /// rect / roundRect / ellipse / triangle / line / star
    pub shape: String,
    pub width: f64,
    pub height: f64,
    pub fill: String,
    #[serde(default)]
    pub stroke: String,
    #[serde(default)]
    pub stroke_width: f64,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default, skip_serializing_if = "Look::is_plain")]
    pub look: Look,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClipBody {
    Voice(VoiceClip),
    Media(MediaClip),
    Text(TextClip),
    Shape(ShapeClip),
    /// セリフの字幕（映像トラックに置く。文と見た目はセリフとキャラクターの設定を使う）
    Caption(CaptionClip),
    /// 立ち絵アイテム（YMM4 と同じ。置いた間だけ、そのキャラクターの PSD 立ち絵を口パク・目パチ付きで出す）
    Portrait(PortraitClip),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortraitClip {
    pub character_id: String,
    /// 位置・大きさ・不透明度（置いたときはキャラクターの立ち絵の設定の値）
    #[serde(default)]
    pub transform: Transform,
    /// このアイテムの間のうち、キャラクターが喋っているときだけ出す。None ならキャラクターの立ち絵の設定のとおり
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only_while_speaking: Option<bool>,
    /// 既定の表情（セリフで表情を選んでいない間はこれ）。None なら通常
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionClip {
    pub voice_id: String,
    /// この字幕だけの見た目（書いた項目だけキャラクターの字幕の設定を上書きする）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<SubtitleOverride>,
}

/// 字幕の見た目の上書き（分離した字幕ごと）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<SubtitleAnimation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<SubtitlePosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_v: Option<u32>,
}

impl SubtitleOverride {
    /// キャラクターの字幕の設定に、この上書きを当てたもの
    pub fn apply(&self, base: &SubtitleStyle) -> SubtitleStyle {
        let mut s = base.clone();
        if let Some(v) = &self.font_family {
            s.font_family = v.clone();
        }
        if let Some(v) = self.font_size {
            s.font_size = v;
        }
        if let Some(v) = self.outline_width {
            s.outline_width = v;
        }
        if let Some(v) = self.animation {
            s.animation = v;
        }
        if let Some(v) = &self.color {
            s.color = v.clone();
        }
        if let Some(v) = &self.outline_color {
            s.outline_color = v.clone();
        }
        if let Some(v) = self.position {
            s.position = v;
        }
        if let Some(v) = self.margin_v {
            s.margin_v = v;
        }
        s
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub track_id: String,
    pub start: Frame,
    pub duration: Frame,
    /// リンク（Premiere Pro と同じ。同じ値のクリップは一緒に動く。セリフの音声と字幕、動画の映像と音声）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_id: Option<String>,
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
    pub fn as_caption(&self) -> Option<&CaptionClip> {
        match &self.body {
            ClipBody::Caption(v) => Some(v),
            _ => None,
        }
    }
    /// このトラックに置けるか。音声トラックはセリフ（分離した声）と音声素材だけ、映像トラックは音声素材以外
    /// レイヤーにはどのアイテムも置ける（YMM4 と同じ）
    pub fn fits(&self, _kind: TrackKind) -> bool {
        true
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
    #[error("クリップ {0} は置けない種類のトラックにあります")]
    WrongTrackKind(String),
}

impl Project {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            version: PROJECT_VERSION,
            name: name.into(),
            video: VideoSettings::default(),
            characters: vec![],
            // YMM4 と同じくレイヤー 1〜6。番号の大きいほど手前に描く
            tracks: (1..=6).map(|n| Track::new(format!("V{n}"), TrackKind::Video)).collect(),
            clips: vec![],
        }
    }

    pub fn from_json(s: &str) -> Result<Self, crate::Error> {
        let mut p: Project = serde_json::from_str(s)?;
        if p.version == 1 {
            p.migrate_v1();
        }
        if p.version == 2 {
            p.migrate_v2();
        }
        if p.version == 3 {
            p.migrate_v3();
        }
        p.validate()?;
        Ok(p)
    }

    /// 版 1 → 2。
    /// - 版 1 は上の段ほど手前に描いていた。レイヤーは下の段ほど手前なので、並びを逆にして見た目を保つ
    /// - セリフの長さに「余韻」（gap_after）を含める。詰めて並んでいた行は詰めたままになる
    fn migrate_v1(&mut self) {
        self.tracks.reverse();
        for c in &mut self.clips {
            let dur = c.duration;
            if let ClipBody::Voice(v) = &mut c.body {
                if !v.lock_duration {
                    c.duration = dur + v.gap_after;
                }
            }
        }
        self.version = 2;
    }

    /// 版 3 → 4：映像トラック・音声トラックを、YMM4 と同じレイヤーの一本の並びにする。
    /// - 並びは V1, V2, …, A1, A2, … のまま（描く順は変わらない。音声トラックは映像を持たない）
    /// - 映像トラックの目（muted）は hidden に、音声トラックのミュートは muted のまま
    /// - キャラクターの「分離した声を置く音声トラック」は、レイヤーの番号に直す
    fn migrate_v3(&mut self) {
        let audio_ids: Vec<String> = self.tracks.iter().filter(|t| t.kind == TrackKind::Audio).map(|t| t.id.clone()).collect();
        let mut tracks: Vec<Track> = self.tracks.iter().filter(|t| t.kind != TrackKind::Audio).cloned().collect();
        for t in &mut tracks {
            t.hidden = t.muted;
            t.muted = false;
        }
        tracks.extend(self.tracks.iter().filter(|t| t.kind == TrackKind::Audio).map(|t| Track { kind: TrackKind::Video, ..t.clone() }));
        for ch in &mut self.characters {
            if let Some(id) = ch.audio_layer.and_then(|n| audio_ids.get((n as usize).wrapping_sub(1))) {
                ch.audio_layer = tracks.iter().position(|t| t.id == *id).map(|i| i as u32 + 1);
            }
        }
        self.tracks = tracks;
        self.version = 4;
    }

    /// 版 2 → 3。
    /// - レイヤーは映像トラックにする（並びはそのまま：前のレイヤーほど奥 = V1）。セリフ・動画はそのまま（字幕と声、映像と音の 1 つのクリップ）
    /// - 音声素材（BGM など）があるレイヤーには、対になる音声トラックを作ってそこへ移す
    fn migrate_v2(&mut self) {
        let mut used: std::collections::HashSet<String> = self.tracks.iter().map(|t| t.id.clone()).collect();
        let old = std::mem::take(&mut self.tracks);
        let is_sound = |c: &Clip| matches!(&c.body, ClipBody::Media(m) if m.media_kind == MediaKind::Audio);
        let mut video = vec![];
        let mut audio = vec![];
        let mut a_of: std::collections::HashMap<String, String> = Default::default();
        for t in &old {
            video.push(Track { kind: TrackKind::Video, ..t.clone() });
            if self.clips.iter().any(|c| c.track_id == t.id && is_sound(c)) {
                let mut id = format!("{}_a", t.id);
                while used.contains(&id) {
                    id.push('_');
                }
                used.insert(id.clone());
                a_of.insert(t.id.clone(), id.clone());
                audio.push(Track { id, kind: TrackKind::Audio, solo: false, ..t.clone() });
            }
        }
        if audio.is_empty() {
            let mut id = "A1".to_string();
            while used.contains(&id) {
                id.push('_');
            }
            audio.push(Track::new(id, TrackKind::Audio));
        }
        for c in &mut self.clips {
            if is_sound(c) {
                c.track_id = a_of.get(&c.track_id).cloned().unwrap_or_else(|| audio[0].id.clone());
            }
        }
        // 版 2 の立ち絵（いつも表示）は、全体にわたる立ち絵アイテムにする（PSD 立ち絵だけ）。
        // キャラクターごとに 1 本ずつ、セリフのある一番下のトラックのすぐ下に映像トラックを足して置く（字幕より奥に描くため）
        let total = self.duration();
        let with_items: Vec<(String, Transform)> = self
            .characters
            .iter()
            .filter_map(|ch| ch.portrait.as_ref().filter(|pt| pt.visible && pt.psd.is_some()).map(|pt| (ch.id.clone(), pt.transform.clone())))
            .collect();
        if total > 0 && !with_items.is_empty() {
            let lowest = video.iter().position(|t| self.clips.iter().any(|c| c.track_id == t.id && c.as_voice().is_some())).unwrap_or(video.len());
            for (i, (cid, tf)) in with_items.into_iter().enumerate() {
                let mut tid = format!("P_{cid}");
                while used.contains(&tid) {
                    tid.push('_');
                }
                used.insert(tid.clone());
                video.insert(lowest + i, Track { name: "立ち絵".into(), ..Track::new(tid.clone(), TrackKind::Video) });
                self.clips.push(Clip {
                    id: format!("pt_{cid}"),
                    track_id: tid,
                    start: 0,
                    duration: total,
                    link_id: None,
                    body: ClipBody::Portrait(PortraitClip { character_id: cid, transform: tf, only_while_speaking: None, expression: None }),
                });
            }
            // 番号で指しているキャラクターのトラックが、足した分ずれないように
            let added = self.clips.iter().filter(|c| matches!(c.body, ClipBody::Portrait(_))).count() as u32;
            for ch in &mut self.characters {
                if let Some(n) = ch.layer.as_mut() {
                    if *n as usize > lowest {
                        *n += added;
                    }
                }
            }
        }
        self.tracks = video.into_iter().chain(audio).collect();
        self.version = 3;
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
            let Some(t) = self.track(&c.track_id) else {
                return Err(ValidationError::MissingTrack { clip: c.id.clone(), track: c.track_id.clone() });
            };
            if !c.fits(t.kind) {
                return Err(ValidationError::WrongTrackKind(c.id.clone()));
            }
            if c.start < 0 || c.duration <= 0 {
                return Err(ValidationError::BadRange(c.id.clone()));
            }
            let character = match &c.body {
                ClipBody::Voice(v) => Some(&v.character_id),
                ClipBody::Portrait(pc) => Some(&pc.character_id),
                _ => None,
            };
            if let Some(ch) = character {
                if self.character(ch).is_none() {
                    return Err(ValidationError::MissingCharacter { clip: c.id.clone(), character: ch.clone() });
                }
            }
        }
        Ok(())
    }

    /// セリフの長さを「音声＋セリフ後の余韻」に合わせ、後ろのアイテムをずらす（全レイヤーをまとめて）。
    /// - どのレイヤーでも、セリフのすぐ後ろ（開始 = そのセリフの終わり）から始まるセリフは、新しい終わりに付いていく
    ///   （掛け合いのセリフがキャラクターごとにレイヤーを分けていても、会話の並びが崩れない）
    /// - 手で離して置いたものは位置を保つ。ただし同じレイヤーで直前と重なるなら後ろへ押し出す
    pub fn reflow_all(&mut self) {
        let video = self.video.clone();
        let mut idx: Vec<usize> = (0..self.clips.len()).collect();
        idx.sort_by_key(|&i| (self.clips[i].start, i));
        let orig: Vec<(Frame, Frame)> = self.clips.iter().map(|c| (c.start, c.end())).collect();
        // セリフの旧い終わり → 新しい終わり
        let mut ends: std::collections::HashMap<Frame, Frame> = std::collections::HashMap::new();
        // レイヤーごとの、直前のアイテムの新しい終わり
        let mut layer_end: std::collections::HashMap<String, Frame> = std::collections::HashMap::new();
        let linked = self.linked_captions();
        // セリフの（元の）開始と、伸びた長さ
        let mut growth: Vec<(Frame, Frame)> = vec![];
        for i in idx.clone() {
            if linked.contains(&i) {
                continue; // リンクした字幕はセリフに合わせる（下の sync_captions）
            }
            let clip = &mut self.clips[i];
            let old_end = clip.end();
            let is_voice = clip.as_voice().is_some();
            if let Some(v) = clip.as_voice() {
                let before = clip.duration;
                if !v.lock_duration {
                    if let Some(a) = &v.audio {
                        // 再生開始位置で頭を飛ばした分だけ短くなる
                        clip.duration = (video.ms_to_frames_ceil(a.duration_ms) - v.start_offset()).max(1) + v.gap_after;
                    }
                }
                growth.push((clip.start, clip.duration - before));
            }
            // セリフのすぐ後ろ（開始 = そのセリフの旧い終わり）から始まるものは、セリフでもそれ以外（立ち絵・素材など）でも付いていく
            if let Some(&to) = ends.get(&clip.start) {
                clip.start = to;
            }
            if let Some(&e) = layer_end.get(&clip.track_id) {
                clip.start = clip.start.max(e);
            }
            let new_end = clip.end();
            if is_voice {
                let e = ends.entry(old_end).or_insert(new_end);
                *e = (*e).max(new_end);
            }
            layer_end.insert(clip.track_id.clone(), new_end);
        }
        // 立ち絵アイテムは、中のセリフが伸び縮みした分だけ長さを変える（キャラクターが消えないように）。
        // 立ち絵の範囲は、動かす前の位置で見る
        for i in idx {
            let c = &self.clips[i];
            if !matches!(c.body, ClipBody::Portrait(_)) {
                continue;
            }
            let (s0, e0) = orig[i];
            let d: Frame = growth.iter().filter(|(st, _)| *st >= s0 && *st < e0).map(|(_, g)| *g).sum();
            if d != 0 {
                let c = &mut self.clips[i];
                c.duration = (c.duration + d).max(1);
            }
        }
        self.sync_captions();
    }

    /// セリフとリンクしている字幕（clips の位置）
    fn linked_captions(&self) -> std::collections::HashSet<usize> {
        let links: std::collections::HashMap<&str, Option<&str>> = self.clips.iter().filter(|c| c.as_voice().is_some()).map(|c| (c.id.as_str(), c.link_id.as_deref())).collect();
        self.clips
            .iter()
            .enumerate()
            .filter(|(_, c)| c.as_caption().is_some_and(|cap| c.link_id.is_some() && links.get(cap.voice_id.as_str()).is_some_and(|l| *l == c.link_id.as_deref())))
            .map(|(i, _)| i)
            .collect()
    }

    /// リンクしている字幕の位置と長さをセリフに合わせる
    pub fn sync_captions(&mut self) {
        let voices: std::collections::HashMap<String, (Frame, Frame, Option<String>)> =
            self.clips.iter().filter(|c| c.as_voice().is_some()).map(|c| (c.id.clone(), (c.start, c.duration, c.link_id.clone()))).collect();
        for c in &mut self.clips {
            let Some(cap) = c.as_caption() else { continue };
            if let Some((s, d, l)) = voices.get(&cap.voice_id) {
                if l.is_some() && *l == c.link_id {
                    c.start = *s;
                    c.duration = *d;
                }
            }
        }
    }

    /// 映像トラック（V1 から順。後ろほど手前に描く）
    /// 字幕として出るクリップなら、そのセリフ（映像トラックのセリフはそれ自身、分離した字幕はそのセリフ）
    pub fn line_of_subtitle<'a>(&'a self, c: &'a Clip) -> Option<&'a VoiceClip> {
        if let Some(v) = c.as_voice() {
            // 字幕を分離したセリフは、声だけ（字幕は字幕のクリップが出す）
            return (!self.clips.iter().any(|x| x.as_caption().is_some_and(|cap| cap.voice_id == c.id))).then_some(v);
        }
        let cap = c.as_caption()?;
        self.clips.iter().find(|x| x.id == cap.voice_id)?.as_voice()
    }

    pub fn video_tracks(&self) -> impl Iterator<Item = &Track> {
        self.tracks.iter()
    }

    /// 音が出るトラック（ミュートしていない。どれかをソロにしているなら、ソロのトラックだけ）
    pub fn audible_tracks(&self) -> std::collections::HashSet<&str> {
        let solo = self.tracks.iter().any(|t| t.solo && !t.hidden);
        self.tracks.iter().filter(|t| !t.hidden && !t.muted && (!solo || t.solo)).map(|t| t.id.as_str()).collect()
    }

    /// キャラクターの立ち絵を描く映像トラック：最後に置いた字幕のトラック → 字幕を置く設定のトラック → 一番上の映像トラック
    pub fn portrait_track_for(&self, character_id: &str) -> Option<&str> {
        let voices: std::collections::HashSet<&str> =
            self.clips.iter().filter(|c| c.as_voice().is_some_and(|v| v.character_id == character_id)).map(|c| c.id.as_str()).collect();
        let on_video = |c: &Clip| self.line_of_subtitle(c).is_some();
        // 字幕（分離した字幕、または字幕と声が 1 つのセリフ）を最後に置いたトラック
        let last = self
            .clips
            .iter()
            .filter(|c| c.as_caption().is_some_and(|cap| voices.contains(cap.voice_id.as_str())) || (voices.contains(c.id.as_str()) && on_video(c)))
            .max_by_key(|c| c.start);
        if let Some(c) = last {
            return Some(c.track_id.as_str());
        }
        let vt: Vec<&Track> = self.video_tracks().collect();
        let ch = self.character(character_id)?;
        ch.layer.and_then(|n| vt.get((n as usize).wrapping_sub(1))).or(vt.last()).map(|t| t.id.as_str())
    }

    /// 互換用（レイヤーを指定しても全体を詰め直す）
    pub fn reflow_voice_track(&mut self, _track_id: &str) {
        self.reflow_all();
    }

    /// クリップが実際に使う声（キャラクターの声＋行ごとの上書き）
    pub fn effective_voice(&self, clip: &VoiceClip) -> Option<Voice> {
        let ch = self.character(&clip.character_id)?;
        let mut voice = ch.voice.clone();
        // キャラクターの声 → プリセット → この行の話者 → この行の調声 の順に上書き
        if let Some(pr) = clip.preset_id.as_ref().and_then(|id| ch.voice_presets.iter().find(|x| &x.id == id)) {
            voice.params = pr.params.clone();
            if let Some(sp) = pr.speaker.as_ref().filter(|s| !s.is_empty()) {
                voice.speaker = sp.clone();
            }
        }
        if let Some(p) = &clip.params_override {
            voice.params = p.clone();
        }
        if let Some(sp) = clip.speaker_override.as_ref().filter(|s| !s.is_empty()) {
            voice.speaker = sp.clone();
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
                voice_presets: vec![],
                layer: Some(2),
                audio_layer: Some(1),
                gap_after: None,
            },
            Character {
                id: "ch_b".into(),
                name: "アシスタント".into(),
                color: "#FF9F0A".into(),
                voice: Voice { engine: EngineId::Aivoice, speaker: "琴葉 茜".into(), params: VoiceParams::default() },
                subtitle: SubtitleStyle { color: "#FFE08A".into(), ..SubtitleStyle::default() },
                portrait: None,
                voice_presets: vec![],
                layer: Some(3),
                audio_layer: Some(2),
                gap_after: None,
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
                track_id: if *ch == "ch_a" { "V2".into() } else { "V3".into() },
                start: i as Frame * 90,
                duration: 90,
                link_id: None,
                body: ClipBody::Voice(VoiceClip {
                    character_id: (*ch).into(),
                    text: (*text).into(),
                    subtitle: None,
                    params_override: None,
                    audio: None,
                    gap_after: 6,
                    lock_duration: false,
                    speaker_override: None,
                    expression: None,
                    preset_id: None,
                    accent: None,
                    subtitle_custom: None,
                    portrait: None,
                    audio_fx: None,
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
        p.clips[0].track_id = "V4".into();
        p.validate().unwrap(); // どのアイテムもどのレイヤーにも置ける
        p.clips[0].body = ClipBody::Text(TextClip {
            text: "x".into(),
            font_family: "a".into(),
            font_size: 1,
            color: "#fff".into(),
            outline_color: String::new(),
            outline_width: 0,
            bold: false,
            italic: false,
            align: "center".into(),
            transform: Transform::default(),
            look: Look::default(),
        });
        p.validate().unwrap(); // テキストもどのレイヤーにも置ける
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

    /// 1 つの音声トラックに 3 行を詰めて並べたプロジェクト
    fn one_layer() -> Project {
        let mut p = Project::sample();
        for c in p.clips.iter_mut() {
            c.track_id = if c.as_voice().is_some() { "V4".into() } else { "V2".into() };
        }
        p
    }

    fn voices(p: &Project) -> Vec<(Frame, Frame)> {
        p.clips.iter().filter(|c| c.as_voice().is_some()).map(|c| (c.start, c.duration)).collect()
    }

    #[test]
    fn reflow_fits_audio_plus_aftertime_and_packs() {
        let mut p = one_layer();
        for (i, c) in p.clips.iter_mut().filter_map(|c| c.as_voice_mut()).enumerate() {
            c.audio = Some(AudioRef { cache_key: format!("k{i}"), duration_ms: 1000 * (i as u64 + 1) });
        }
        p.reflow_voice_track("V4");
        let r = voices(&p);
        // 長さ = 音声 + 余韻 6
        assert_eq!(r, vec![(0, 36), (36, 66), (102, 96)]);
        assert_eq!(p.duration(), 198);
    }

    #[test]
    fn reflow_keeps_manual_gap_but_pushes_overlap() {
        let mut p = one_layer();
        p.clips[2].start = 400; // 手で離した
        for c in p.clips.iter_mut().filter_map(|c| c.as_voice_mut()) {
            c.audio = Some(AudioRef { cache_key: "k".into(), duration_ms: 1000 });
        }
        p.reflow_voice_track("V4");
        assert_eq!(p.clips[1].start, 36); // 詰めていた行は詰め直す
        assert_eq!(p.clips[2].start, 400); // 離した行はそのまま
        p.clips[0].as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: "k".into(), duration_ms: 20_000 });
        p.reflow_voice_track("V4");
        assert_eq!(p.clips[1].start, 606);
        assert_eq!(p.clips[2].start, 642); // 重なるので押し出し
    }

    #[test]
    fn reflow_follows_conversation_across_layers() {
        // サンプル：c1(A1 0-90) → c2(A2 90-180) → c3(A1 180-270) と会話が続く
        let mut p = Project::sample();
        p.clips[0].as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: "a".into(), duration_ms: 4000 }); // 120+6
        p.reflow_all();
        let r = voices(&p);
        assert_eq!(r, vec![(0, 126), (126, 90), (216, 90)], "別のトラックの次のセリフも付いていく");
    }

    #[test]
    fn portrait_items_grow_and_followers_move_with_lines() {
        // サンプル：c1(0-90) c2(90-180) c3(180-270)。全体の立ち絵（V1 0-270）と、c3 の後ろに続く画像（V1 270-300）
        let mut p = Project::sample();
        p.clips.push(Clip { id: "pt".into(), track_id: "V1".into(), start: 0, duration: 270, link_id: None, body: ClipBody::Portrait(PortraitClip { character_id: "ch_a".into(), transform: Transform::default(), only_while_speaking: None, expression: None }) });
        p.clips[0].as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: "a".into(), duration_ms: 4000 }); // 90 → 126
        p.reflow_all();
        let pt = p.clips.iter().find(|c| c.id == "pt").unwrap();
        assert_eq!((pt.start, pt.duration), (0, 306), "中のセリフが 36 伸びた分だけ立ち絵も伸びる");
        assert_eq!(p.clips[2].start, 216);
    }

    #[test]
    fn separated_caption_follows_its_voice() {
        // c1 を分離：声はレイヤー 4、字幕は V2（リンク）
        let mut p = Project::sample();
        p.clips[0].track_id = "V4".into();
        p.clips[0].link_id = Some("lk".into());
        p.clips.push(Clip { id: "cap1".into(), track_id: "V2".into(), start: 0, duration: 90, link_id: Some("lk".into()), body: ClipBody::Caption(CaptionClip { voice_id: "c1".into(), style: None }) });
        p.validate().unwrap();
        p.clips[0].as_voice_mut().unwrap().audio = Some(AudioRef { cache_key: "a".into(), duration_ms: 4000 });
        p.reflow_all();
        let cap = p.clips.iter().find(|c| c.id == "cap1").unwrap();
        assert_eq!((cap.start, cap.duration), (0, 126));
        assert_eq!(p.portrait_track_for("ch_a"), Some("V2"));
        let a = crate::subtitle::build_ass(&p);
        assert_eq!(a.matches("Dialogue:").count(), 3, "分離した字幕・1 つのセリフの字幕のどちらも出る");
    }

    /// 版 2 の形（レイヤー L1〜L4、セリフは L2・L3）
    fn v2_json(version: u32) -> String {
        let mut v: serde_json::Value = serde_json::to_value(Project::sample()).unwrap();
        v["version"] = version.into();
        v["tracks"] = serde_json::json!((1..=4).map(|n| serde_json::json!({"id": format!("L{n}"), "kind": "media", "name": ""})).collect::<Vec<_>>());
        let clips: Vec<serde_json::Value> = v["clips"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["type"] == "voice")
            .map(|c| {
                let mut c = c.clone();
                c["trackId"] = if c["characterId"] == "ch_a" { "L2" } else { "L3" }.into();
                c.as_object_mut().unwrap().remove("linkId");
                c
            })
            .collect();
        v["clips"] = clips.into();
        for ch in v["characters"].as_array_mut().unwrap() {
            ch.as_object_mut().unwrap().remove("audioLayer");
        }
        v.to_string()
    }

    #[test]
    fn migrates_v1_projects() {
        let mut v: serde_json::Value = serde_json::from_str(&v2_json(1)).unwrap();
        v["tracks"] = serde_json::json!([{"id": "S", "kind": "voice", "name": "セリフ"}, {"id": "M", "kind": "media", "name": "素材"}]);
        for c in v["clips"].as_array_mut().unwrap() {
            c["trackId"] = "S".into();
            c["duration"] = 84.into(); // 版 1：長さは音声だけ、間は別
        }
        for ch in v["characters"].as_array_mut().unwrap() {
            ch.as_object_mut().unwrap().remove("layer");
        }
        let q = Project::from_json(&v.to_string()).unwrap();
        assert_eq!(q.version, PROJECT_VERSION);
        // 版 1 の並びを逆にしてレイヤーに → 映像トラック（素材が V1、セリフが V2）
        // 版 3 で足した音声トラックは、版 4 でいちばん手前の（空の）レイヤーになる
        assert_eq!(q.video_tracks().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["素材", "セリフ", ""]);
        assert!(q.clips.iter().all(|c| c.duration == 90));
    }

    #[test]
    fn migrates_v2_layers_to_video_and_audio_tracks() {
        let q = Project::from_json(&v2_json(2)).unwrap();
        assert_eq!(q.version, 4);
        let kinds: Vec<&str> = q.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(kinds, ["L1", "L2", "L3", "L4", "A1"]);
        // セリフは字幕と声の 1 つのクリップのまま、元のレイヤー（映像トラック）に残る
        let c1 = q.clips.iter().find(|c| c.id == "c1").unwrap();
        assert_eq!(c1.track_id, "L2");
        assert!(!q.clips.iter().any(|c| c.as_caption().is_some()));
        assert_eq!(q.characters[1].layer, Some(3));
        assert_eq!(q.portrait_track_for("ch_b"), Some("L3"));
        q.validate().unwrap();
        // BGM は対になる音声トラックへ
        let mut v: serde_json::Value = serde_json::from_str(&v2_json(2)).unwrap();
        v["clips"].as_array_mut().unwrap().push(serde_json::json!({"id": "bgm", "trackId": "L1", "start": 0, "duration": 30, "type": "media", "src": "a.mp3", "mediaKind": "audio"}));
        let q = Project::from_json(&v.to_string()).unwrap();
        assert_eq!(q.clips.iter().find(|c| c.id == "bgm").unwrap().track_id, "L1_a");
        // 版 2 の PSD 立ち絵（いつも表示）は、全体にわたる立ち絵アイテムに。セリフのある一番下のトラック（L2）のすぐ下へ
        let mut v: serde_json::Value = serde_json::from_str(&v2_json(2)).unwrap();
        v["characters"][1]["portrait"] = serde_json::json!({"base": "", "psd": {"src": "b.psd"}, "transform": {"x": 5, "y": 6, "scale": 0.5, "opacity": 1}});
        let q = Project::from_json(&v.to_string()).unwrap();
        q.validate().unwrap();
        let ids: Vec<&str> = q.video_tracks().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["L1", "P_ch_b", "L2", "L3", "L4", "A1"]);
        let item = q.clips.iter().find(|c| matches!(c.body, ClipBody::Portrait(_))).unwrap();
        assert_eq!((item.track_id.as_str(), item.start, item.duration), ("P_ch_b", 0, 270));
        assert_eq!(q.characters[1].layer, Some(4), "V3 → V4（1 本足した分）");
    }

    #[test]
    fn solo_limits_audible_tracks() {
        let mut p = Project::sample();
        assert!(p.audible_tracks().contains("V4") && p.audible_tracks().contains("V5"));
        p.tracks.iter_mut().find(|t| t.id == "V5").unwrap().solo = true;
        let a = p.audible_tracks();
        assert!(a.contains("V5") && !a.contains("V4"));
        // 目を消したレイヤーは音も出さない（ソロでも）
        p.tracks.iter_mut().find(|t| t.id == "V5").unwrap().hidden = true;
        assert!(!p.audible_tracks().contains("V5"));
    }

    #[test]
    fn v3_tracks_become_layers() {
        let mut p = Project::sample();
        p.version = 3;
        p.tracks = vec![Track::new("V1", TrackKind::Video), Track::new("V2", TrackKind::Video), Track::new("V3", TrackKind::Video), Track::new("A1", TrackKind::Audio), Track::new("A2", TrackKind::Audio)];
        p.tracks[0].muted = true; // 映像トラックの目
        p.tracks[4].muted = true; // 音声トラックのミュート
        p.characters[1].audio_layer = Some(2);
        // 分離した声（音声トラック）と字幕
        p.clips[1].track_id = "A2".into();
        let cap = Clip { id: "cap".into(), track_id: "V3".into(), start: p.clips[1].start, duration: p.clips[1].duration, link_id: None, body: ClipBody::Caption(CaptionClip { voice_id: "c2".into(), style: None }) };
        p.clips.push(cap);
        let q = Project::from_json(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(q.version, 4);
        let ids: Vec<(&str, bool, bool)> = q.tracks.iter().map(|t| (t.id.as_str(), t.hidden, t.muted)).collect();
        assert_eq!(ids, [("V1", true, false), ("V2", false, false), ("V3", false, false), ("A1", false, false), ("A2", false, true)]);
        assert!(q.tracks.iter().all(|t| t.kind == TrackKind::Video));
        assert_eq!(q.characters[1].audio_layer, Some(5), "A2 → レイヤー 5");
        // 分離した声は字幕を出さない（字幕は字幕のクリップが出す）
        assert!(q.line_of_subtitle(&q.clips[1]).is_none());
        assert!(q.line_of_subtitle(q.clips.iter().find(|c| c.id == "cap").unwrap()).is_some());
        assert!(q.line_of_subtitle(&q.clips[0]).is_some());
    }

    #[test]
    fn portrait_layers_fall_back_to_first_variant() {
        let pt = Portrait {
            base: "b.png".into(),
            eyes: [Some("e0.png".into()), None, Some("e2.png".into())],
            mouth: [Some("m0.png".into()), None, None],
            transform: Transform::default(),
            visible: true,
            only_while_speaking: false,
            expressions: vec![Expression {
                name: "笑顔".into(),
                base: None,
                eyes: [Some("smile.png".into()), None, None],
                mouth: [None, None, None],
                visibility: Default::default(),
            }],
            psd: None,
        };
        assert_eq!(pt.layers(2, 2, 0), vec!["b.png", "e2.png", "m0.png"]);
        assert_eq!(pt.layers(1, 0, 0), vec!["b.png", "e0.png", "m0.png"]);
        // 表情：目だけ差し替え、口は通常のまま
        assert_eq!(pt.layers(0, 0, 1), vec!["b.png", "smile.png", "m0.png"]);
        assert_eq!(pt.expression_index(Some("笑顔")), 1);
        assert_eq!(pt.expression_index(Some("無い")), 0);
        assert_eq!(pt.expression_index(None), 0);
        let json = r#"{"base":"b.png"}"#;
        let p2: Portrait = serde_json::from_str(json).unwrap();
        assert!(p2.visible && p2.eyes == [None, None, None]);
    }

    #[test]
    fn effective_voice_layers_preset_speaker_and_override() {
        let mut p = Project::sample();
        p.characters[0].voice_presets.push(VoicePreset {
            id: "pr1".into(),
            name: "叫び".into(),
            speaker: Some("Japanese Male 1".into()),
            params: VoiceParams { speed: 1.4, ..VoiceParams::default() },
        });
        let ClipBody::Voice(mut vc) = p.clips[0].body.clone() else { panic!() };
        assert_eq!(p.effective_voice(&vc).unwrap().params.speed, 1.0);
        vc.preset_id = Some("pr1".into());
        let v = p.effective_voice(&vc).unwrap();
        assert_eq!((v.params.speed, v.speaker.as_str()), (1.4, "Japanese Male 1"));
        vc.speaker_override = Some("Japanese Female 2".into());
        vc.params_override = Some(VoiceParams { speed: 0.8, ..VoiceParams::default() });
        let v = p.effective_voice(&vc).unwrap();
        assert_eq!((v.params.speed, v.speaker.as_str()), (0.8, "Japanese Female 2"));
        // 消えたプリセットはキャラクターの声に戻る
        vc.preset_id = Some("gone".into());
        vc.speaker_override = None;
        vc.params_override = None;
        assert_eq!(p.effective_voice(&vc).unwrap().speaker, "Japanese Female 1");
        // 古いファイル（presetId なし）も読める
        let json = p.to_json().unwrap();
        assert!(!json.contains("presetId"));
        assert!(Project::from_json(&json).is_ok());
    }
}
