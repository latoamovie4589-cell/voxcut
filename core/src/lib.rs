//! VoxCut コア。Tauri に依存しないので、UI なしでテストできる。

pub mod cache;
pub mod jobs;
pub mod lipsync;
pub mod model;
pub mod proxy;
pub mod render;
pub mod subtitle;
pub mod text;
pub mod tts;
pub mod wav;
pub mod waveform;

pub use model::*;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("入出力エラー: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON エラー: {0}")]
    Json(#[from] serde_json::Error),
    #[error("WAV エラー: {0}")]
    Wav(#[from] hound::Error),
    #[error("プロジェクトが不正です: {0}")]
    Validation(#[from] model::ValidationError),
    #[error("{engine} が見つかりません: {detail}")]
    EngineNotFound { engine: &'static str, detail: String },
    #[error("{engine} でエラーが起きました: {detail}")]
    Engine { engine: &'static str, detail: String },
    #[error("FFmpeg でエラーが起きました: {0}")]
    Ffmpeg(String),
    #[error("取り消しました")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
