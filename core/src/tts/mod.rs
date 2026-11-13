//! 音声合成エンジンの共通窓口。

pub mod aivoice;
pub mod voicepeak;
pub mod voicevox;
pub mod voisona;

use crate::model::{EngineId, VoiceParams};
use crate::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub engine: EngineId,
    /// エンジンに渡す名前（VOICEPEAK のナレーター名、A.I.VOICE のプリセット名、VoiSona のボイス名）
    pub speaker: String,
    pub display_name: String,
    /// 使える感情・スタイル名（VOICEPEAK の happy など）
    #[serde(default)]
    pub emotions: Vec<String>,
    /// 動画に載せるクレジット表記（VOICEVOX の「VOICEVOX:ずんだもん」など）。要らないエンジンは None
    #[serde(default)]
    pub credit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum EngineStatus {
    /// 実行ファイルや API が見つからない
    NotFound { detail: String },
    /// 見つかったが、起動していない・接続できない
    NotRunning { detail: String },
    Ready { version: Option<String> },
}

#[derive(Debug, Clone)]
pub struct SynthRequest<'a> {
    pub speaker: &'a str,
    pub text: &'a str,
    pub params: &'a VoiceParams,
    /// VOICEVOX：手で直したアクセント句（ほかのソフトは使わない）
    pub accent: Option<&'a serde_json::Value>,
}

pub trait TtsEngine: Send + Sync {
    fn id(&self) -> EngineId;
    fn status(&self) -> EngineStatus;
    fn list_voices(&self) -> Result<Vec<VoiceInfo>>;
    /// `out_wav` に WAV を書く。音量はエンジンに渡さず、書き出し時のミックスで掛ける（全エンジンで同じ効き方にするため）。
    fn synthesize(&self, req: &SynthRequest<'_>, out_wav: &Path) -> Result<()>;
    /// 同時に何件まで合成できるか
    fn max_concurrency(&self) -> usize {
        1
    }
}

/// ユーザー設定（設定画面で変えられる）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineConfig {
    pub voicepeak_path: Option<PathBuf>,
    pub voisona: voisona::VoisonaConfig,
    pub voicevox: voicevox::VoicevoxConfig,
    pub aivoice_bridge_path: Option<PathBuf>,
    /// A.I.VOICE のインストール先（ユーザーが選んだ AIVoiceEditor.exe のあるフォルダ）
    pub aivoice_dir: Option<PathBuf>,
}

/// 設定から3エンジンを作る
pub fn build_engines(cfg: &EngineConfig) -> Vec<std::sync::Arc<dyn TtsEngine>> {
    vec![
        std::sync::Arc::new(aivoice::AivoiceEngine::new(cfg.aivoice_bridge_path.clone()).with_install_dir(cfg.aivoice_dir.clone())),
        std::sync::Arc::new(voicepeak::VoicepeakEngine::new(cfg.voicepeak_path.clone())),
        std::sync::Arc::new(voisona::VoisonaEngine::new(cfg.voisona.clone())),
        std::sync::Arc::new(voicevox::VoicevoxEngine::new(cfg.voicevox.clone())),
    ]
}

/// 半音 → 周波数比
pub(crate) fn semitones_to_ratio(st: f64) -> f64 {
    2f64.powf(st / 12.0)
}

/// Windows でコンソール窓を出さずに子プロセスを起動する
pub fn hidden_command(program: &Path) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}
