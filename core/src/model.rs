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
    /// マーカー（時刻に付ける目印。YouTube のチャプターにも使う）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<Marker>,
    /// シーン（別のタイムライン。シーンアイテムで入れ子にして置ける）。メインのタイムラインは tracks・clips
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scenes: Vec<Scene>,
}

/// シーン（メインとは別のレイヤーとアイテム）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
}

/// タイムラインの目印
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub frame: Frame,
    #[serde(default)]
    pub name: String,
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
    /// COEIROINK v2
    Coeiroink,
    /// ゆっくりボイス（AquesTalkPlayer）
    Aquestalk,
    /// CeVIO AI
    Cevio,
}

impl EngineId {
    pub const ALL: [EngineId; 7] = [EngineId::Aivoice, EngineId::Voicepeak, EngineId::Voisona, EngineId::Voicevox, EngineId::Coeiroink, EngineId::Aquestalk, EngineId::Cevio];
    pub fn as_str(&self) -> &'static str {
        match self {
            EngineId::Aivoice => "aivoice",
            EngineId::Voicepeak => "voicepeak",
            EngineId::Voisona => "voisona",
            EngineId::Voicevox => "voicevox",
            EngineId::Coeiroink => "coeiroink",
            EngineId::Aquestalk => "aquestalk",
            EngineId::Cevio => "cevio",
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
    /// 影の色（空なら影なし）とずれ（px）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub shadow_color: String,
    #[serde(default = "four", skip_serializing_if = "is_four")]
    pub shadow_offset: u32,
    /// 文字の後ろの帯（空なら帯なし）。帯を付けると縁取りの代わりになる（ASS の BorderStyle 3）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub box_color: String,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub box_opacity: f64,
    #[serde(default = "twelve", skip_serializing_if = "is_twelve")]
    pub box_padding: u32,
    /// 1 行に入れる文字数の上限（全角を 1、半角を 0.55 と数える）。0 なら画面の幅で決める
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub max_chars: u32,
    /// カラオケで塗っていく色（空なら黄色）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub karaoke_color: String,
}

/// カラオケの塗りの色の決まり
pub const KARAOKE_COLOR: &str = "#FFD400";

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

fn four() -> u32 {
    4
}
fn is_four(v: &u32) -> bool {
    *v == 4
}
fn twelve() -> u32 {
    12
}
fn is_twelve(v: &u32) -> bool {
    *v == 12
}
fn is_one(v: &f64) -> bool {
    (*v - 1.0).abs() < 1e-9
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
    /// カラオケ：文字が左から順に塗られていく（長さの 9 割で塗り終わる）
    Karaoke,
    /// クリッピング解除：字幕が左から右へ現れる（0.5 秒か、長さの 6 割の短いほう）
    Wipe,
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
            shadow_color: String::new(),
            shadow_offset: 4,
            box_color: String::new(),
            box_opacity: 1.0,
            box_padding: 12,
            max_chars: 0,
            karaoke_color: String::new(),
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
    /// 呼吸（しゃべっていない間も、足もとを止めたまま縦にゆっくり伸び縮みする）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breath: Option<Breath>,
}

/// 立ち絵の呼吸。画面側の model.ts の breathScale と同じ式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Breath {
    /// 伸びる大きさ（高さの %）
    pub amount: f64,
    /// 1 回の呼吸の長さ（秒）
    pub period: f64,
}

impl Breath {
    /// 時刻 t 秒での縦の倍率（1 から 1 + amount% の間を、cos でなめらかに行き来する）
    pub fn scale_at(&self, t: f64) -> f64 {
        1.0 + self.amount.clamp(0.0, 20.0) / 100.0 * (1.0 - (2.0 * std::f64::consts::PI * t / self.period.max(0.2)).cos()) / 2.0
    }
    /// ffmpeg の式（t はその時刻の秒）
    pub fn ffmpeg_expr(&self) -> String {
        format!("(1+{:.5}*(1-cos(2*PI*t/{:.4}))/2)", self.amount.clamp(0.0, 20.0) / 100.0, self.period.max(0.2))
    }
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
    /// 下へ向かうグラデーションの色（上は color。空ならなし）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gradient_color: String,
    /// 外側の縁（内側の縁の外にもう 1 本。色が空ならなし）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub outline2_color: String,
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub outline2_width: f64,
}

fn is_zero_f64(v: &f64) -> bool {
    *v == 0.0
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
    /// 音を鳴らす長さ（切り替えで映像だけを延ばしたとき。保存しない）
    #[serde(skip)]
    pub audio_frames: Option<Frame>,
    /// 素材そのものへの加工（速さ・逆再生・静止など）
    #[serde(flatten)]
    pub src_fx: SourceFx,
}

/// 素材そのものへの加工（CapCut の「速度」「逆再生」「フリーズ」など）。画面側の model.ts の MediaClip と同じ
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFx {
    /// 速さ（1 が等速）。speed_to があれば、頭の速さ
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub speed: f64,
    /// 終わりの速さ（だんだん速く・遅く）。なければ speed のまま
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_to: Option<f64>,
    /// 逆再生
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reverse: bool,
    /// 静止（in_point のコマを出し続ける。音は出さない）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub freeze: bool,
    /// 切り抜き（上下左右から削る割合）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    /// 形で切り抜く（マスク）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<Mask>,
    /// 色を抜く（クロマキー。緑の背景など）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chroma: Option<Chroma>,
    /// 背景をぼかして埋める（画面いっぱいに広げてぼかした同じ素材を後ろに敷く。値はぼかしの強さ px）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_blur: Option<f64>,
    /// 音の加工（雑音を減らす・声を変える・音量をそろえる）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_fx: Option<crate::audiofx::MediaAudioFx>,
    /// 手ぶれ補正（動画）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stabilize: bool,
    /// 背景を消す（人物などを切り抜く）。使うモデルの id（ai::MODELS）。型は先に作っておく
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matte: Option<String>,
    /// なめらかスロー：遅くしたとき、間のコマを動きから作って補う（書き出しのみ。画面はコマをくり返す）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub smooth: bool,
    /// 音のフェードイン・フェードアウト（フレーム。音声素材と、音の入った動画）
    #[serde(default, skip_serializing_if = "is_zero_frame")]
    pub sound_fade_in: Frame,
    #[serde(default, skip_serializing_if = "is_zero_frame")]
    pub sound_fade_out: Frame,
    /// 同じレイヤーのすぐ前の音声素材と、この長さ（フレーム）だけ重ねてなめらかにつなぐ（クロスフェード。音声素材だけ）
    #[serde(default, skip_serializing_if = "is_zero_frame")]
    pub crossfade: Frame,
}

fn is_zero_frame(v: &Frame) -> bool {
    *v == 0
}

impl Default for SourceFx {
    fn default() -> Self {
        SourceFx {
            speed: 1.0,
            speed_to: None,
            reverse: false,
            freeze: false,
            crop: None,
            mask: None,
            chroma: None,
            fill_blur: None,
            audio_fx: None,
            stabilize: false,
            matte: None,
            smooth: false,
            sound_fade_in: 0,
            sound_fade_out: 0,
            crossfade: 0,
        }
    }
}

/// 切り抜き（それぞれの辺から削る、幅・高さに対する割合 0〜1）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    #[serde(default)]
    pub left: f64,
    #[serde(default)]
    pub top: f64,
    #[serde(default)]
    pub right: f64,
    #[serde(default)]
    pub bottom: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum MaskShape {
    #[default]
    Rect,
    Ellipse,
}

/// 形の切り抜き。位置・大きさは（切り抜いた後の）素材の幅・高さに対する割合
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    #[serde(default)]
    pub shape: MaskShape,
    /// 中心のずれ（-0.5〜0.5。0 が真ん中）
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// 幅・高さ（0〜1）
    #[serde(default = "one")]
    pub w: f64,
    #[serde(default = "one")]
    pub h: f64,
    /// 四角の角の丸み（0〜0.5。短い辺に対する割合）
    #[serde(default)]
    pub radius: f64,
    /// ぼかし（0〜0.5。短い辺に対する割合）
    #[serde(default)]
    pub feather: f64,
    /// 外側を残す
    #[serde(default)]
    pub invert: bool,
}

/// 色を抜く。similarity が大きいほど近い色まで抜き、blend が大きいほど境目がなだらか
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chroma {
    pub color: String,
    #[serde(default = "chroma_similarity")]
    pub similarity: f64,
    #[serde(default = "chroma_blend")]
    pub blend: f64,
}

fn chroma_similarity() -> f64 {
    0.4
}
fn chroma_blend() -> f64 {
    0.1
}

impl SourceFx {
    /// 頭と終わりの速さ
    pub fn speeds(&self) -> (f64, f64) {
        let a = self.speed.max(0.05);
        (a, self.speed_to.unwrap_or(a).max(0.05))
    }
    /// クリップの頭から t 進んだとき、元の素材で進む量（速さを積分。単位は t と同じ）。d はクリップの長さ
    pub fn advance(&self, t: f64, d: f64) -> f64 {
        if self.freeze {
            return 0.0;
        }
        let (a, b) = self.speeds();
        a * t + (b - a) * t * t / (2.0 * d.max(1e-9))
    }
    pub fn is_retimed(&self) -> bool {
        let (a, b) = self.speeds();
        self.freeze || self.reverse || (a - 1.0).abs() > 1e-9 || (b - 1.0).abs() > 1e-9
    }
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
    /// 登場のしかた（アイテムの頭で、画面の外から滑り込む・大きくなって出る）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enter: Option<Motion>,
    /// 退場のしかた（アイテムの終わりで、画面の外へ出ていく・小さくなって消える）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<Motion>,
    /// 同じレイヤーのすぐ前のアイテムとのつなぎ目に入れる切り替え（場面転換）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<Transition>,
    /// 合成モード（下の絵との重ね方）。なしはふつうに重ねる
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blend: Option<BlendMode>,
    /// 左右反転・上下反転（エフェクトより前に、素材そのものを裏返す）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flip_x: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flip_y: bool,
    /// 画面の横・縦の倍率（大きさに掛ける。回したあとに掛ける。なしは 1・1）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stretch: Option<[f64; 2]>,
    /// 回転・拡大の中心（アイテムの真ん中からのずれ。元の大きさの px。右・下がプラス）。位置はこの点の位置になる
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pivot: Option<[f64; 2]>,
    /// 3D 回転（X 軸・Y 軸の度。奥行きのある見え方で傾ける）。アニメーションの終わりの値は anim.rot3d
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rot3d: Option<[f64; 2]>,
}

/// 合成モード（画面は canvas の globalCompositeOperation、書き出しは ffmpeg の blend。どちらも同じ式）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    HardLight,
    Difference,
    Add,
}

impl BlendMode {
    /// ffmpeg の blend の all_mode（上＝下の絵、下＝このアイテム）
    pub fn ffmpeg(self) -> &'static str {
        match self {
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            BlendMode::HardLight => "hardlight",
            BlendMode::Difference => "difference",
            BlendMode::Add => "addition",
        }
    }
}

/// つなぎ目の切り替え
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub kind: TransitionKind,
    /// 全体の長さ（フレーム）
    pub frames: Frame,
}

/// 切り替えの種類。slide は「前の場面がその方向へ流れ、次の場面が反対側から入る」
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransitionKind {
    Dissolve,
    Black,
    White,
    SlideLeft,
    SlideRight,
    SlideUp,
    SlideDown,
    Zoom,
}

/// 登場・退場の動き
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Motion {
    pub kind: MotionKind,
    /// 掛ける長さ（フレーム）
    pub frames: Frame,
    /// なめらかに動く（ゆっくり出て、ゆっくり止まる）。切り替えの「流す」で、前と次の場面がくっついて動くように
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub smooth: bool,
}

/// 登場・退場の種類。slide は「その方向から入る／その方向へ出る」
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MotionKind {
    SlideLeft,
    SlideRight,
    SlideUp,
    SlideDown,
    Zoom,
    /// クリッピング解除（ワイプ）。登場は「その向きへ広がって現れる」、退場は「その向きへ消えていく」
    WipeRight,
    WipeLeft,
    WipeDown,
    WipeUp,
}

impl Look {
    pub fn is_plain(&self) -> bool {
        *self == Look::default()
    }
}

/// 切り替えに使えるアイテム（見た目のあるもの）の Look
fn visual_look_mut(c: &mut Clip) -> Option<&mut Look> {
    match &mut c.body {
        ClipBody::Text(t) => Some(&mut t.look),
        ClipBody::Shape(s) => Some(&mut s.look),
        ClipBody::Media(m) if m.media_kind != MediaKind::Audio => Some(&mut m.look),
        _ => None,
    }
}
fn visual_look(c: &Clip) -> Option<&Look> {
    match &c.body {
        ClipBody::Text(t) => Some(&t.look),
        ClipBody::Shape(s) => Some(&s.look),
        ClipBody::Media(m) if m.media_kind != MediaKind::Audio => Some(&m.look),
        _ => None,
    }
}

impl Project {
    /// 同じレイヤーで、b のすぐ前に接しているアイテム（2 フレームまでのすき間は接しているとみなす）。
    /// 画面側の model.ts の prevAdjacent と同じ
    pub fn prev_adjacent(&self, b: &Clip) -> Option<usize> {
        visual_look(b)?;
        self.clips
            .iter()
            .enumerate()
            .filter(|(_, a)| a.id != b.id && a.track_id == b.track_id && visual_look(a).is_some() && a.start < b.start)
            .filter(|(_, a)| {
                let end = a.start + a.duration;
                end <= b.start && end >= b.start - 2
            })
            .max_by_key(|(_, a)| (a.start + a.duration, a.start))
            .map(|(i, _)| i)
    }

    /// シーンアイテムを、シーンのレイヤーとアイテム（アイテムの頭からの時刻にずらし、終わりで切る）と、
    /// それをまとめるグループ制御に置き換えた写し（入れ子は 4 段まで）。書き出しはこれを描く。画面側の model.ts の withScenes と同じ。
    /// シーンのレイヤー・アイテムの id は「元の id@シーンアイテムの id」
    pub fn with_scenes(&self) -> Project {
        let mut p = self.clone();
        for _ in 0..4 {
            let items: Vec<(usize, String)> = p
                .clips
                .iter()
                .enumerate()
                .filter_map(|(i, c)| match &c.body {
                    ClipBody::Shape(ShapeClip { scene: Some(s), .. }) => Some((i, s.clone())),
                    _ => None,
                })
                .collect();
            if items.is_empty() {
                break;
            }
            let mut tracks: Vec<Track> = vec![];
            let mut add: Vec<Clip> = vec![];
            let mut layers: std::collections::HashMap<String, u32> = Default::default();
            for t in &p.tracks {
                // このレイヤーのシーンアイテムのシーンを、すぐ下に入れる（頭の早いアイテムほど下）
                let mut here: Vec<&(usize, String)> = items.iter().filter(|(i, _)| p.clips[*i].track_id == t.id).collect();
                here.sort_by_key(|(i, _)| p.clips[*i].start);
                let mut n = 0u32;
                for (i, sid) in here {
                    let item = &p.clips[*i];
                    let Some(sc) = self.scenes.iter().find(|s| &s.id == sid) else { continue };
                    let tag = |id: &str| format!("{id}@{}", item.id);
                    for st in &sc.tracks {
                        tracks.push(Track { id: tag(&st.id), ..st.clone() });
                        n += 1;
                    }
                    for c in &sc.clips {
                        if c.start >= item.duration {
                            continue;
                        }
                        let mut c2 = c.clone();
                        c2.id = tag(&c.id);
                        c2.track_id = tag(&c.track_id);
                        c2.link_id = c.link_id.as_deref().map(tag);
                        c2.start = item.start + c.start;
                        c2.duration = c.duration.min(item.duration - c.start);
                        add.push(c2);
                    }
                }
                if n > 0 {
                    layers.insert(t.id.clone(), n);
                }
                tracks.push(t.clone());
            }
            for (i, _) in &items {
                let n = layers.get(&p.clips[*i].track_id).copied().unwrap_or(0);
                if let ClipBody::Shape(sh) = &mut p.clips[*i].body {
                    sh.scene = None;
                    // 入れたレイヤーがなければ、何も描かない調整レイヤー（エフェクトなし）にしておく
                    sh.control = Some(if n > 0 { Control { kind: ControlKind::Group, layers: n } } else { Control { kind: ControlKind::Adjust, layers: 1 } });
                    if n == 0 {
                        sh.look.effects.clear();
                    }
                }
            }
            p.tracks = tracks;
            p.clips.extend(add);
        }
        p
    }

    /// 切り替えを、前後のアイテムの登場・退場・フェード（と、暗転・白は画面を覆う図形）に置き換えた写し。
    /// 書き出しはこれを描く。画面側の model.ts の withTransitions と同じ結果になる
    pub fn with_transitions(&self) -> Project {
        let mut p = self.with_crossfades();
        let base = p.clone();
        let this = &base;
        let jobs: Vec<(usize, usize, Transition)> = self
            .clips
            .iter()
            .enumerate()
            .filter_map(|(bi, b)| {
                let t = visual_look(b)?.transition.clone()?;
                let ai = this.prev_adjacent(b)?;
                Some((ai, bi, t))
            })
            .collect();
        if jobs.is_empty() {
            return p;
        }
        let mut extra: Vec<Clip> = vec![];
        for (ai, bi, t) in jobs {
            let (a, b) = (&this.clips[ai], &this.clips[bi]);
            let cut = b.start;
            let d = t.frames.min(a.duration * 4 / 5).min(b.duration * 4 / 5).max(2);
            let h = d / 2;
            let (out_f, in_f) = (h.max(1), (d - h).max(1));
            // 前の場面を後ろへ延ばす。動画の音は元の長さで切る（延ばすのは映像だけ）
            let extend_a = |p: &mut Project| {
                let orig = a.duration;
                p.clips[ai].duration = cut - a.start + d;
                if let ClipBody::Media(m) = &mut p.clips[ai].body {
                    if m.media_kind == MediaKind::Video {
                        m.audio_frames = Some(orig);
                    }
                }
            };
            let set_a = |p: &mut Project, f: &dyn Fn(&mut Look)| {
                if let Some(l) = visual_look_mut(&mut p.clips[ai]) {
                    f(l)
                }
            };
            let set_b = |p: &mut Project, f: &dyn Fn(&mut Look)| {
                if let Some(l) = visual_look_mut(&mut p.clips[bi]) {
                    f(l)
                }
            };
            match t.kind {
                TransitionKind::Dissolve => {
                    // 前の場面を後ろへ延ばして、次の場面の下で消していく
                    extend_a(&mut p);
                    set_a(&mut p, &|l| {
                        l.exit = None;
                        l.fade_out = d;
                    });
                    set_b(&mut p, &|l| {
                        l.enter = None;
                        l.fade_in = d;
                    });
                }
                TransitionKind::Black | TransitionKind::White => {
                    // 画面を覆う図形を、つなぎ目の前で濃くし、後で薄くする（同じレイヤーの上に重ねる）
                    let fill = if t.kind == TransitionKind::Black { "#000000" } else { "#FFFFFF" };
                    let cover = |id: String, start: Frame, duration: Frame, look: Look| Clip {
                        id,
                        track_id: b.track_id.clone(),
                        start,
                        duration,
                        link_id: None,
                        body: ClipBody::Shape(ShapeClip {
                            shape: "rect".into(),
                            width: (this.video.width + 8) as f64,
                            height: (this.video.height + 8) as f64,
                            fill: fill.into(),
                            stroke: String::new(),
                            stroke_width: 0.0,
                            transform: Transform::default(),
                            look,
                            region: None,
                            control: None,
                            scene: None,
                            viz: None,
                            anim: None,
                        }),
                    };
                    extra.push(cover(format!("{}~cover1", b.id), cut - out_f, out_f, Look { fade_in: out_f, ..Default::default() }));
                    extra.push(cover(format!("{}~cover2", b.id), cut, in_f, Look { fade_out: in_f, ..Default::default() }));
                }
                TransitionKind::Zoom => {
                    set_a(&mut p, &|l| {
                        l.exit = Some(Motion { kind: MotionKind::Zoom, frames: out_f, smooth: false });
                        l.fade_out = out_f;
                    });
                    set_b(&mut p, &|l| {
                        l.enter = Some(Motion { kind: MotionKind::Zoom, frames: in_f, smooth: false });
                        l.fade_in = in_f;
                    });
                }
                k => {
                    // 前の場面がその方向へ流れて、次の場面が反対側から入る
                    let (go, come) = match k {
                        TransitionKind::SlideLeft => (MotionKind::SlideLeft, MotionKind::SlideRight),
                        TransitionKind::SlideRight => (MotionKind::SlideRight, MotionKind::SlideLeft),
                        TransitionKind::SlideUp => (MotionKind::SlideUp, MotionKind::SlideDown),
                        _ => (MotionKind::SlideDown, MotionKind::SlideUp),
                    };
                    // 前の場面を後ろへ延ばして、2 つがくっついたまま同時に動く（押し出し）
                    extend_a(&mut p);
                    set_a(&mut p, &|l| {
                        l.exit = Some(Motion { kind: go, frames: d, smooth: true });
                        l.fade_out = 0;
                    });
                    set_b(&mut p, &|l| {
                        l.enter = Some(Motion { kind: come, frames: d, smooth: true });
                        l.fade_in = 0;
                    });
                }
            }
        }
        // 重なりの順（同じレイヤーでは頭の早い順に描く）。覆う図形は同じ時刻のアイテムより手前に
        p.clips.sort_by_key(|c| c.start);
        p.clips.extend(extra);
        p
    }

    /// クロスフェード：音声素材 b に crossfade があり、同じレイヤーのすぐ前（2 フレームまでのすき間）に音声素材 a があれば、
    /// a を後ろへその長さだけ延ばして消していき、b はその長さで大きくする。画面側の model.ts の withCrossfades と同じ
    pub fn with_crossfades(&self) -> Project {
        let audio = |c: &Clip| matches!(&c.body, ClipBody::Media(m) if m.media_kind == MediaKind::Audio);
        let mut p = self.clone();
        for (bi, b) in self.clips.iter().enumerate() {
            let ClipBody::Media(bm) = &b.body else { continue };
            if !audio(b) || bm.src_fx.crossfade <= 0 {
                continue;
            }
            let Some((ai, a)) = self
                .clips
                .iter()
                .enumerate()
                .filter(|(_, a)| a.id != b.id && a.track_id == b.track_id && audio(a) && a.start < b.start)
                .filter(|(_, a)| {
                    let end = a.start + a.duration;
                    end <= b.start && end >= b.start - 2
                })
                .max_by_key(|(_, a)| (a.start + a.duration, a.start))
            else {
                continue;
            };
            let d = crossfade_frames(bm.src_fx.crossfade, a.duration, b.duration);
            p.clips[ai].duration = b.start - a.start + d;
            if let ClipBody::Media(m) = &mut p.clips[ai].body {
                m.src_fx.sound_fade_out = m.src_fx.sound_fade_out.max(d);
            }
            if let ClipBody::Media(m) = &mut p.clips[bi].body {
                m.src_fx.sound_fade_in = m.src_fx.sound_fade_in.max(d);
            }
        }
        p
    }
}

/// クロスフェードに使う長さ（前後の音の長さの 8 割まで、2 フレーム以上）。画面側の crossfadeFrames と同じ
pub fn crossfade_frames(want: Frame, a: Frame, b: Frame) -> Frame {
    want.min(a * 4 / 5).min(b * 4 / 5).max(2)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Anim {
    pub to: Transform,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub ease: Ease,
    /// 途中の状態（始まり → 途中 → 終わりの順に動く。区間ごとに ease を掛ける）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mid: Option<AnimMid>,
    /// そのほかの途中の状態（キーフレーム。何点でも）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<AnimMid>,
    /// 終わりの 3D 回転（なしは始まりと同じ。途中の状態は通らず、始まりから終わりへ ease で動く）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rot3d: Option<[f64; 2]>,
}

impl Anim {
    /// 途中の状態をすべて、通る順に（mid と keys。近すぎるものは 1 つに。画面側の animKeys と同じ）
    pub fn waypoints(&self) -> Vec<AnimMid> {
        let mut v: Vec<AnimMid> = self.mid.iter().chain(self.keys.iter()).cloned().map(|mut k| {
            k.at = k.at.clamp(0.001, 0.999);
            k
        }).collect();
        v.sort_by(|a, b| a.at.total_cmp(&b.at));
        v.dedup_by(|b, a| (b.at - a.at).abs() < 1e-6);
        v
    }
}

/// アニメーションの途中の状態
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimMid {
    /// 通る時点（アイテムの長さに対する割合 0〜1）
    pub at: f64,
    pub transform: Transform,
    #[serde(default)]
    pub rotation: f64,
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
    /// フィルター（色の雰囲気。name は GRADES の名前、strength は 0〜1）
    Grade { name: String, strength: f64 },
    /// 色温度（warm：-1 で青く 〜 1 で黄色く）と色合い（tint：-1 で緑 〜 1 で赤紫）
    Temperature { warm: f64, tint: f64 },
    /// LUT（.cube のファイル。strength は 0〜1）。書き出しはそのまま、画面は近い色
    Lut {
        path: String,
        #[serde(default = "one")]
        strength: f64,
    },
    /// 縁取り（色・太さ px）。形のまわりに色を付ける
    Outline { color: String, width: f64 },
    /// ドロップシャドウ（色・ぼかし px・ずれ px・濃さ 0〜1）
    Shadow { color: String, blur: f64, x: f64, y: f64, opacity: f64 },
    /// 発光（色・広がり px・重ねる回数 1〜5）。ぼかした形を後ろに重ねる
    Glow { color: String, blur: f64, strength: f64 },
    /// 点滅（1 秒あたりの回数。半分の時間ずつ見える・見えない）
    Blink { speed: f64 },
    /// 残像（数・間隔フレーム）。前の時点の姿を薄く重ねる
    Trail { count: u32, interval: u32 },
    /// 色ずれ（赤を右・青を左へずらす px）
    RgbShift { amount: f64 },
    /// グリッチ（横のずれ px・帯の高さ px・1 秒あたりに変わる回数）
    Glitch { amount: f64, band: f64, speed: f64 },
    /// ノイズ（強さ 0〜1。コマごとに変わる）
    Noise { amount: f64 },
    /// 放射ブラー（強さ 0〜0.9。真ん中から外へ流れる）
    RadialBlur { amount: f64 },
    /// 方向ブラー（長さ px・角度、度）
    DirBlur { length: f64, angle: f64 },
    /// 二値化（しきい値 0〜1。明るいところは白、暗いところは黒）
    Threshold { level: f64 },
    /// ランダム移動（振れ幅 px・1 秒あたりに跳ぶ回数）
    Jitter { amount: f64, speed: f64 },
    /// 反復移動（横・縦の振れ幅 px・1 秒あたりの往復の回数）
    Oscillate { x: f64, y: f64, speed: f64 },
    /// プラグインのエフェクト（書き出しの FFmpeg のフィルターと画面の Canvas の filter の式。{名前} に values の数を入れる）
    Plugin {
        name: String,
        ffmpeg: String,
        #[serde(default)]
        canvas: String,
        #[serde(default)]
        values: std::collections::BTreeMap<String, f64>,
        /// 数のつまみ（プロパティに出すため。プラグインからそのまま写す）
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        params: Vec<crate::plugin::PluginParam>,
    },
}

/// 決まった乱数（0〜1）。画面の model.ts の hash01 と同じ式（sin の小数部分）
pub fn hash01(a: f64, b: f64) -> f64 {
    let v = (a * 12.9898 + b * 78.233).sin() * 43758.5453;
    v - v.floor()
}

/// hash01 の FFmpeg の式
pub fn hash01_expr(a: &str, b: &str) -> String {
    format!("(sin(({a})*12.9898+({b})*78.233)*43758.5453-floor(sin(({a})*12.9898+({b})*78.233)*43758.5453))")
}

/// ランダム移動のずれ（ローカルの秒 t で）
pub fn jitter_at(amount: f64, speed: f64, t: f64) -> (f64, f64) {
    let n = (t * speed).floor();
    (amount * (hash01(n, 1.0) * 2.0 - 1.0), amount * (hash01(n, 2.0) * 2.0 - 1.0))
}

/// フィルターの中身：色の混ぜ方（3×3、行ごとに R・G・B の出どころ）と、色ごとの明るさの曲線（倍率・指数・足す量）。
/// 画面側の model.ts の GRADES と同じ数
pub fn grade_table(name: &str) -> Option<([f64; 9], [[f64; 3]; 3])> {
    const ID: [f64; 3] = [1.0, 1.0, 0.0];
    let (m, g): ([f64; 9], [[f64; 3]; 3]) = match name {
        "vivid" => ([1.2755, -0.2503, -0.0252, -0.0746, 1.0998, -0.0252, -0.0746, -0.2503, 1.3248], [[1.06, 1.1, -0.03]; 3]),
        "warm" => ([1.1225, -0.0386, -0.0039, -0.0107, 1.0143, -0.0036, -0.0092, -0.0307, 0.8999], [ID; 3]),
        "cool" => ([0.8646, 0.0322, 0.0032, 0.0104, 0.966, 0.0035, 0.0119, 0.04, 1.068], [ID; 3]),
        "sepia" => ([0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131], [ID; 3]),
        "vintage" => ([0.6662, 0.423, 0.104, 0.192, 0.8273, 0.0924, 0.1496, 0.2937, 0.522], [[0.85, 0.95, 0.08], [0.85, 0.95, 0.08], [0.8, 1.0, 0.1]]),
        "film" => ([0.8927, 0.1338, 0.0135, 0.0376, 0.9297, 0.0127, 0.036, 0.121, 0.783], [[0.94, 1.05, 0.05], [0.94, 1.05, 0.04], [0.92, 1.0, 0.06]]),
        "noir" => ([0.213, 0.715, 0.072, 0.213, 0.715, 0.072, 0.213, 0.715, 0.072], [[1.15, 1.25, -0.05]; 3]),
        "dream" => ([0.882, 0.1072, 0.0108, 0.032, 0.9572, 0.0108, 0.032, 0.1072, 0.8608], [[0.82, 0.8, 0.15]; 3]),
        "night" => ([0.6572, 0.1115, 0.0112, 0.0375, 0.8298, 0.0127, 0.0477, 0.1602, 0.9121], [[0.9, 1.25, 0.0]; 3]),
        _ => return None,
    };
    Some((m, g))
}

/// フィルター（強さを掛けた後）・色温度の、色の混ぜ方と曲線。strength 0 で元のまま
pub fn color_grade(fx: &Effect) -> Option<([f64; 9], [[f64; 3]; 3])> {
    const I: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    match fx {
        Effect::Grade { name, strength } => {
            let (m, g) = grade_table(name)?;
            let s = strength.clamp(0.0, 1.0);
            let mut mm = [0.0; 9];
            for i in 0..9 {
                mm[i] = I[i] + (m[i] - I[i]) * s;
            }
            let gg = g.map(|[a, e, o]| [1.0 + (a - 1.0) * s, 1.0 + (e - 1.0) * s, o * s]);
            Some((mm, gg))
        }
        Effect::Temperature { warm, tint } => {
            let (w, t) = (warm.clamp(-1.0, 1.0), tint.clamp(-1.0, 1.0));
            Some(([1.0 + 0.18 * w, 0.0, 0.0, 0.0, 1.0 - 0.12 * t, 0.0, 0.0, 0.0, 1.0 - 0.18 * w], [[1.0, 1.0, 0.0]; 3]))
        }
        _ => None,
    }
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
    /// 文字の飾り（影・外側の縁・背景の帯・グラデーション）。画面側で描くので、ここでは保存するだけ
    #[serde(flatten)]
    pub deco: TextDeco,
}

/// 文字の飾り（画面側の textImage が描く。Rust では保存と読み込みだけ）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextDeco {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_blur: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline2_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline2_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_padding: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_color: Option<String>,
    /// 縦書き
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical: Option<bool>,
    /// 1 文字ずつ出す（画面側がコマごとの画像を用意し、書き出しは 1 コマずつ並べる）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char_anim: Option<CharAnim>,
    /// タイマー（カウントダウン・カウントアップ）。文の中の {t} が時間になる（なければ文全体）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timer: Option<Timer>,
}

/// テキストのタイマー。from から to へ、実際の時間の速さで数える（to で止まる）。画面側の model.ts の timerText と同じ
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    /// 始まりの値（秒）
    pub from: f64,
    /// 終わりの値（秒）。from より小さければカウントダウン
    pub to: f64,
    /// 表し方：s（10）・m:ss（1:05）・h:mm:ss（0:01:05）・m:ss.cc（1:05.30）
    pub format: String,
}

impl Timer {
    /// 表示が変わる間隔（フレーム）。100 分の 1 秒まで出すときは毎コマ
    pub fn step(&self, fps: u32) -> Frame {
        if self.format.ends_with(".cc") { 1 } else { fps.max(1) as Frame }
    }
    /// アイテムの頭から local フレームでの文字
    pub fn text_at(&self, template: &str, local: Frame, fps: u32) -> String {
        let t = local.max(0) as f64 / fps.max(1) as f64;
        let down = self.to < self.from;
        let v = if down { (self.from - t).max(self.to) } else { (self.from + t).min(self.to) };
        let cc = self.format.ends_with(".cc");
        // カウントダウンは切り上げ（10 から始まり、ちょうど 0 で終わる）、カウントアップは切り捨て
        let unit = if cc { 100.0 } else { 1.0 };
        let q = v * unit;
        let n = (if down { (q - 1e-6).ceil() } else { (q + 1e-6).floor() }).max(0.0) as i64;
        let (whole, frac) = if cc { (n / 100, n % 100) } else { (n, 0) };
        let (h, m, sec) = (whole / 3600, whole / 60 % 60, whole % 60);
        let body = match self.format.as_str() {
            "s" => whole.to_string(),
            "h:mm:ss" => format!("{h}:{m:02}:{sec:02}"),
            "m:ss.cc" => format!("{}:{sec:02}.{frac:02}", whole / 60),
            _ => format!("{}:{sec:02}", whole / 60),
        };
        if template.contains("{t}") { template.replace("{t}", &body) } else { body }
    }
}

#[cfg(test)]
mod timer_tests {
    use super::Timer;
    /// e2e の「タイマー」と同じ数
    #[test]
    fn counts_down_and_up() {
        let d = Timer { from: 10.0, to: 0.0, format: "s".into() };
        assert_eq!([0, 1, 29, 30, 299, 300, 400].map(|f| d.text_at("", f, 30)), ["10", "10", "10", "9", "1", "0", "0"]);
        let u = Timer { from: 55.0, to: 3700.0, format: "m:ss".into() };
        assert_eq!([0, 150, 3600].map(|f| u.text_at("残り {t}", f, 30)), ["残り 0:55", "残り 1:00", "残り 2:55"]);
        let h = Timer { from: 3599.0, to: 4000.0, format: "h:mm:ss".into() };
        assert_eq!(h.text_at("", 30, 30), "1:00:00");
        let c = Timer { from: 5.0, to: 0.0, format: "m:ss.cc".into() };
        assert_eq!([0, 1, 15].map(|f| c.text_at("", f, 30)), ["0:05.00", "0:04.97", "0:04.50"]);
        assert_eq!((c.step(30), d.step(30)), (1, 30));
    }
}

/// テキストの 1 文字ずつの登場（kind：type ＝そのまま出る／fade ＝ふわっと／pop ＝はねる／slideUp ＝下から）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharAnim {
    pub kind: String,
    /// 次の文字が出るまでのフレーム
    pub interval: Frame,
    /// 1 文字が出きるまでのフレーム
    #[serde(default = "char_len")]
    pub length: Frame,
}

fn char_len() -> Frame {
    6
}

impl CharAnim {
    /// 全部の文字が出きるまでのフレーム（n 文字）。この後は画像が変わらない
    pub fn frames(&self, n: usize) -> Frame {
        (n.max(1) as Frame - 1) * self.interval.max(0) + self.length.max(1)
    }
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
    /// モザイク・ぼかし範囲：図形の形の中だけ、下の絵をモザイク・ぼかしにする（図形の色は使わない）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<Region>,
    /// グループ制御・カメラ・調整レイヤー（図形そのものは描かず、下のレイヤーに効く）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<Control>,
    /// シーンアイテム：このシーン（id）を、アイテムの頭から再生して置く（図形そのものは描かない）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<String>,
    /// 音声の波形・スペクトラム：動画の音を、図形の大きさ・塗りの色で描く（図形そのものは描かない）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viz: Option<AudioViz>,
    /// 動く図形（紙吹雪などの粒・進行バー・グラフ）。画面側がコマごとの画像を描き、書き出しはそれを並べる
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anim: Option<ShapeAnim>,
}

/// 動く図形。描き方の設定は画面側（preview/anim.ts）が持ち、ここでは画像の並べ方だけを決める（ほかの値はそのまま保つ）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShapeAnim {
    /// particles（粒）・progress（進行バー）・chart（グラフ）
    pub kind: String,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

impl ShapeAnim {
    /// 粒をくり返す長さ（フレーム）。画面側の particleLoop と同じ
    pub fn particle_loop(fps: u32) -> Frame {
        fps.max(1) as Frame * 4
    }
    /// 画像の並べ方：（何フレームごとの画像か、くり返すか）。画面側の animStep と同じ
    pub fn sequence(&self, width: f64, duration: Frame) -> (Frame, bool) {
        match self.kind.as_str() {
            "particles" => (1, true),
            // 進行バー：1 画素ずつ伸びればよいので、長い動画でも画像は幅の数まで
            "progress" => ((duration / (width.round() as Frame).max(1)).max(1), false),
            _ => (1, false),
        }
    }
}

/// 音声の見える化（wave ＝波形、bars ＝周波数の棒）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AudioViz {
    Wave,
    Bars,
}

/// グループ制御・カメラ・調整レイヤー
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub kind: ControlKind,
    /// グループ制御で、すぐ下の何レイヤーをまとめるか（カメラ・調整レイヤーは下の全部）
    #[serde(default = "one_u32")]
    pub layers: u32,
}

fn one_u32() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ControlKind {
    /// すぐ下のレイヤーをまとめて、このアイテムの位置・大きさ・回転・エフェクトで動かす
    Group,
    /// 下の全部を、カメラを動かしたように見せる（右へ動かすと絵は左へ。拡大すると寄る）
    Camera,
    /// 下の全部に、このアイテムのエフェクトを掛ける
    Adjust,
}

impl Control {
    /// まとめるレイヤーの数（下のレイヤーの数 below まで）。調整レイヤーはまとめない
    pub fn covers(&self, below: usize) -> usize {
        match self.kind {
            ControlKind::Group => (self.layers as usize).min(below),
            ControlKind::Camera => below,
            ControlKind::Adjust => 0,
        }
    }
}

/// カメラの動きを、まとめた絵の動きにする（右へ動かすと絵は左へ、回すと逆に回る。大きさ・不透明度・エフェクトはそのまま）
pub fn camera_view(t: &Transform, look: &Look) -> (Transform, Look) {
    let flip = |t: &Transform| Transform { x: -t.x, y: -t.y, ..*t };
    let mut l = look.clone();
    l.rotation = -look.rotation;
    l.rot3d = look.rot3d.map(|[a, b]| [-a, -b]);
    if let Some(a) = l.anim.as_mut() {
        a.to = flip(&a.to);
        a.rotation = -a.rotation;
        a.rot3d = a.rot3d.map(|[x, y]| [-x, -y]);
        for k in a.mid.iter_mut().chain(a.keys.iter_mut()) {
            k.transform = flip(&k.transform);
            k.rotation = -k.rotation;
        }
    }
    (flip(t), l)
}

/// モザイク・ぼかし範囲
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub kind: RegionKind,
    /// モザイクのマスの大きさ・ぼかしの強さ（書き出しの画面の px）
    pub strength: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RegionKind {
    Mosaic,
    Blur,
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
            markers: vec![],
            scenes: vec![],
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
                color: "#30B0C7".into(),
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
            ("ch_a", "声は A.I.VOICE、VOICEPEAK、VoiSona Talk、VOICEVOX から選べます。"),
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
            deco: Default::default(),
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
            breath: None,
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

#[cfg(test)]
mod transition_tests {
    use super::*;

    fn image(id: &str, start: Frame, duration: Frame, kind: MediaKind) -> Clip {
        Clip {
            id: id.into(),
            track_id: "V1".into(),
            start,
            duration,
            link_id: None,
            body: ClipBody::Media(MediaClip {
                src: format!("{id}.png"),
                media_kind: kind,
                has_audio: false,
                in_point: 0,
                volume: 1.0,
                transform: Transform::default(),
                look: Look::default(),
                audio_frames: None,
                src_fx: Default::default(),
            }),
        }
    }
    fn look(c: &Clip) -> &Look {
        visual_look(c).unwrap()
    }

    /// クロスフェード：前の音を延ばしてフェードアウト、次の音はフェードイン（画面側の withCrossfades と同じ数。e2e でも確かめる）
    #[test]
    fn crossfades_extend_previous_sound() {
        let mut p = Project::sample();
        p.clips = vec![image("a", 0, 30, MediaKind::Audio), image("b", 31, 60, MediaKind::Audio), image("c", 200, 30, MediaKind::Audio)];
        assert_eq!(p.with_crossfades(), p);
        let set = |c: &mut Clip, f: Frame| {
            if let ClipBody::Media(m) = &mut c.body {
                m.src_fx.crossfade = f;
            }
        };
        set(&mut p.clips[1], 40);
        set(&mut p.clips[2], 10);
        let q = p.with_transitions();
        let fx = |i: usize| match &q.clips.iter().find(|c| c.id == ["a", "b", "c"][i]).unwrap().body {
            ClipBody::Media(m) => (m.src_fx.sound_fade_in, m.src_fx.sound_fade_out),
            _ => unreachable!(),
        };
        // 長さは前後の 8 割まで（30 の 8 割 = 24）。すき間 1 フレームの分も延ばす。離れている c はつながない
        assert_eq!(q.clips.iter().find(|c| c.id == "a").unwrap().duration, 31 + 24);
        assert_eq!((fx(0), fx(1), fx(2)), ((0, 24), (24, 0), (0, 0)));
        let json = serde_json::to_value(&p.clips[1]).unwrap();
        assert_eq!(json["crossfade"], 40);
    }

    #[test]
    fn transitions_become_motions_fades_and_covers() {
        let mut p = Project::sample();
        p.clips.clear();
        p.clips.push(image("b", 60, 60, MediaKind::Image));
        p.clips.push(image("a", 0, 60, MediaKind::Image));
        p.clips.push(image("far", 200, 60, MediaKind::Image));
        // 切り替えがなければそのまま
        assert_eq!(p.with_transitions(), p);
        let set = |p: &mut Project, id: &str, kind: TransitionKind, frames: Frame| {
            let c = p.clips.iter_mut().find(|c| c.id == id).unwrap();
            visual_look_mut(c).unwrap().transition = Some(Transition { kind, frames });
        };
        // 押し出し：前を延ばして、前は左へ・次は右から、同じ長さでなめらかに同時に動く
        set(&mut p, "b", TransitionKind::SlideLeft, 20);
        let q = p.with_transitions();
        let get = |q: &Project, id: &str| q.clips.iter().find(|c| c.id == id).cloned().unwrap();
        assert_eq!(get(&q, "a").duration, 80);
        assert_eq!(look(&get(&q, "a")).exit, Some(Motion { kind: MotionKind::SlideLeft, frames: 20, smooth: true }));
        assert_eq!(look(&get(&q, "b")).enter, Some(Motion { kind: MotionKind::SlideRight, frames: 20, smooth: true }));
        // 離れたアイテムには掛からない
        set(&mut p, "far", TransitionKind::Zoom, 20);
        assert!(look(&get(&p.with_transitions(), "far")).enter.is_none());
        // クロスフェード：前を延ばして、次の下で消していく
        set(&mut p, "b", TransitionKind::Dissolve, 20);
        let q = p.with_transitions();
        assert_eq!(get(&q, "a").duration, 80);
        assert_eq!((look(&get(&q, "a")).fade_out, look(&get(&q, "b")).fade_in), (20, 20));
        // 頭の早い順に並べ直す（後のアイテムが手前）
        assert_eq!(q.clips.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["a", "b", "far"]);
        // 動画も映像は延ばす。音は元の長さで切る
        p.clips[1] = image("a", 0, 60, MediaKind::Video);
        let q = p.with_transitions();
        assert_eq!((get(&q, "a").duration, look(&get(&q, "a")).fade_out, look(&get(&q, "b")).fade_in), (80, 20, 20));
        assert!(matches!(&get(&q, "a").body, ClipBody::Media(m) if m.audio_frames == Some(60)));
        // 暗転：覆う図形がつなぎ目の前後に 1 つずつ、最後に（手前に）付く
        set(&mut p, "b", TransitionKind::Black, 21);
        let q = p.with_transitions();
        let ids: Vec<_> = q.clips.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(&ids[3..], ["b~cover1", "b~cover2"]);
        assert_eq!((get(&q, "b~cover1").start, get(&q, "b~cover1").duration, get(&q, "b~cover2").start, get(&q, "b~cover2").duration), (50, 10, 60, 11));
        // 短いアイテムでは長さの 8 割まで
        set(&mut p, "b", TransitionKind::Zoom, 200);
        let q = p.with_transitions();
        assert_eq!(look(&get(&q, "b")).enter.as_ref().unwrap().frames + look(&get(&q, "a")).exit.as_ref().unwrap().frames, 48);
    }

    #[test]
    fn text_decoration_is_kept_when_saving() {
        let json = r##"{"id":"t","trackId":"V1","start":0,"duration":30,"type":"text","text":"x","fontFamily":"a","fontSize":40,"color":"#fff","shadowColor":"#000000","shadowBlur":8,"outline2Color":"#FFFFFF","outline2Width":6,"boxColor":"#000","boxOpacity":0.6,"gradientColor":"#FF0000"}"##;
        let c: Clip = serde_json::from_str(json).unwrap();
        let back = serde_json::to_value(&c).unwrap();
        for k in ["shadowColor", "shadowBlur", "outline2Color", "outline2Width", "boxColor", "boxOpacity", "gradientColor"] {
            assert!(back.get(k).is_some(), "{k} が消えた: {back}");
        }
        assert!(back.get("shadowX").is_none());
    }
}
