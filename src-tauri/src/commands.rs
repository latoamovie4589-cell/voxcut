//! UI から呼ばれる IPC コマンド。重い処理は spawn_blocking に回し、UI スレッドを止めない。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter, Manager, State};
use voxcut_core::cache::AudioCache;
use voxcut_core::jobs;
use voxcut_core::render::{self, ExportOptions};
use voxcut_core::tts::{build_engines, EngineConfig, EngineStatus, TtsEngine, VoiceInfo};
use voxcut_core::{lipsync, subtitle, waveform, EngineId, Project};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub engines: EngineConfig,
    /// 未指定なら、アプリと同じフォルダの ffmpeg → PATH の順に探す
    pub ffmpeg_path: Option<PathBuf>,
}

pub struct AppState {
    /// 書き出しの取り消し
    export_cancel: Arc<std::sync::atomic::AtomicBool>,
    proxy_root: PathBuf,
    /// プロキシ作成は CPU を使うので 1 本ずつ
    proxy_lock: Arc<std::sync::Mutex<()>>,
    config_path: PathBuf,
    config: RwLock<AppConfig>,
    engines: RwLock<Vec<Arc<dyn TtsEngine>>>,
    cache: AudioCache,
}

impl AppState {
    pub fn load(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let config_path = app.path().app_config_dir()?.join("config.json");
        let config: AppConfig = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let cache = AudioCache::new(app.path().app_cache_dir()?.join("audio"));
        std::fs::create_dir_all(cache.root())?;
        let proxy_root = app.path().app_cache_dir()?.join("proxy");
        Ok(Self { export_cancel: Default::default(), proxy_root, proxy_lock: Default::default(), config_path, engines: RwLock::new(build_engines(&config.engines)), config: RwLock::new(config), cache })
    }

    fn engines(&self) -> Vec<Arc<dyn TtsEngine>> {
        self.engines.read().unwrap().clone()
    }

    fn ffmpeg(&self) -> PathBuf {
        if let Some(p) = &self.config.read().unwrap().ffmpeg_path {
            return p.clone();
        }
        let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.join(name)))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from(name))
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

// ───────────── プロジェクト ─────────────

#[tauri::command]
pub fn new_project() -> Project {
    Project::sample()
}

#[tauri::command]
pub async fn open_project(app: AppHandle, path: PathBuf) -> CmdResult<Project> {
    let p = blocking({
        let path = path.clone();
        move || Project::from_json(&std::fs::read_to_string(&path).map_err(err)?).map_err(err)
    })
    .await?;
    // プレビューで素材を読めるよう、プロジェクトのフォルダを asset プロトコルに許可する
    if let Some(dir) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, true);
    }
    Ok(p)
}

#[tauri::command]
pub async fn save_project(path: PathBuf, project: Project) -> CmdResult<()> {
    blocking(move || {
        project.validate().map_err(err)?;
        let tmp = path.with_extension("voxcut.tmp");
        std::fs::write(&tmp, project.to_json().map_err(err)?).map_err(err)?;
        std::fs::rename(&tmp, &path).map_err(err)
    })
    .await
}

// ───────────── 設定 ─────────────

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.read().unwrap().clone()
}

#[tauri::command]
pub fn set_config(state: State<'_, AppState>, config: AppConfig) -> CmdResult<()> {
    if let Some(dir) = state.config_path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    std::fs::write(&state.config_path, serde_json::to_string_pretty(&config).map_err(err)?).map_err(err)?;
    *state.engines.write().unwrap() = build_engines(&config.engines);
    *state.config.write().unwrap() = config;
    Ok(())
}

// ───────────── 音声合成 ─────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatusItem {
    engine: EngineId,
    status: EngineStatus,
}

#[tauri::command]
pub async fn engine_status(state: State<'_, AppState>) -> CmdResult<Vec<EngineStatusItem>> {
    let engines = state.engines();
    blocking(move || {
        // 3エンジンを並列に確認（接続待ちで UI を待たせない）
        let handles: Vec<_> = engines
            .into_iter()
            .map(|e| std::thread::spawn(move || EngineStatusItem { engine: e.id(), status: e.status() }))
            .collect();
        Ok(handles.into_iter().filter_map(|h| h.join().ok()).collect())
    })
    .await
}

#[tauri::command]
pub async fn list_voices(state: State<'_, AppState>, engine: EngineId) -> CmdResult<Vec<VoiceInfo>> {
    let e = state.engines().into_iter().find(|e| e.id() == engine).ok_or("エンジンがありません")?;
    blocking(move || e.list_voices().map_err(err)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthOutcome {
    project: Project,
    failed: Vec<(String, String)>,
}

/// `clip_ids` が空なら全セリフ。1件終わるごとに "synth-progress" イベントを送る。
#[tauri::command]
pub async fn synthesize(
    app: AppHandle,
    state: State<'_, AppState>,
    mut project: Project,
    clip_ids: Option<Vec<String>>,
) -> CmdResult<SynthOutcome> {
    let engines = state.engines();
    let cache = state.cache.clone();
    blocking(move || {
        let (todo, mut ready) = jobs::plan(&project, &cache, clip_ids.as_deref());
        let results = jobs::run(todo, &engines, &cache, &|p| {
            let _ = app.emit("synth-progress", &p);
        });
        ready.extend(results);
        let failed = jobs::apply(&mut project, ready);
        Ok(SynthOutcome { project, failed })
    })
    .await
}

/// 波形ピーク。JSON にせず生バイトで返す（UI 側は ArrayBuffer → Int8Array）
#[tauri::command]
pub async fn waveform(state: State<'_, AppState>, cache_key: String) -> CmdResult<tauri::ipc::Response> {
    let cache = state.cache.clone();
    blocking(move || {
        let path = cache.get(&cache_key).ok_or("音声がキャッシュにありません")?;
        let peaks = waveform::peaks(&path, lipsync::PEAKS_PER_SEC).map_err(err)?;
        Ok(tauri::ipc::Response::new(peaks.into_iter().map(|b| b as u8).collect::<Vec<u8>>()))
    })
    .await
}

/// プレビュー再生用に WAV のパスを返す（UI 側で convertFileSrc して読む）
#[tauri::command]
pub fn audio_path(state: State<'_, AppState>, cache_key: String) -> CmdResult<PathBuf> {
    state.cache.get(&cache_key).ok_or_else(|| "音声がキャッシュにありません".into())
}

// ───────────── 書き出し ─────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    stage: &'static str,
    ratio: f64,
}

/// 未合成のセリフを合成 → 字幕を作る → FFmpeg。進捗は "export-progress" イベント。
#[tauri::command]
pub async fn export_video(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Project,
    project_path: Option<PathBuf>,
    out: PathBuf,
    options: Option<ExportRequest>,
) -> CmdResult<Project> {
    let options = options.unwrap_or_default();
    let cancel = state.export_cancel.clone();
    cancel.store(false, std::sync::atomic::Ordering::Relaxed);
    let engines = state.engines();
    let cache = state.cache.clone();
    let ffmpeg = state.ffmpeg();
    blocking(move || {
        let mut project = project;
        let emit = |stage, ratio| {
            let _ = app.emit("export-progress", ExportProgress { stage, ratio });
        };
        emit("synth", 0.0);
        let (todo, mut ready) = jobs::plan(&project, &cache, None);
        ready.extend(jobs::run(todo, &engines, &cache, &|p| emit("synth", p.done as f64 / p.total.max(1) as f64)));
        let failed = jobs::apply(&mut project, ready);
        if let Some((id, e)) = failed.first() {
            return Err(format!("セリフ {id} を合成できませんでした: {e}"));
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(voxcut_core::Error::Cancelled.to_string());
        }

        let work = tempdir_in(cache.root())?;
        let ass = work.join("subtitles.ass");
        std::fs::write(&ass, subtitle::build_ass(&project)).map_err(err)?;
        let project_dir = project_path.as_deref().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default();
        emit("portrait", 0.0);
        let peaks = |key: &str| cache.get(key).and_then(|p| waveform::peaks(&p, lipsync::PEAKS_PER_SEC).ok());
        let portraits = render::prepare_portraits(&project, &project_dir, &ffmpeg, &work, &peaks).map_err(err)?;
        let mut opt = ExportOptions::new(&ffmpeg, &out, project_dir);
        if let Some(crf) = options.crf {
            opt.crf = crf.clamp(10, 40);
        }
        opt.out_height = options.height;
        let lookup = |id: &str| {
            project.clips.iter().find(|c| c.id == id).and_then(|c| c.as_voice()).and_then(|v| v.audio.as_ref()).and_then(|a| cache.get(&a.cache_key))
        };
        let args = render::build_args(&project, &lookup, &portraits, Some(&ass), &opt).map_err(err)?;
        let total = project.video.frames_to_secs(project.duration());
        let r = render::run_cancellable(&args, &ffmpeg, total, &mut |x| emit("encode", x), Some(&cancel));
        let _ = std::fs::remove_dir_all(&work);
        r.map_err(err)?;
        Ok(project)
    })
    .await
}

/// 書き出しの設定（画質と出力の高さ）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    crf: Option<u8>,
    height: Option<u32>,
}

/// 書き出しを取り消す（FFmpeg を止め、書きかけのファイルを消す）
#[tauri::command]
pub fn cancel_export(state: State<'_, AppState>) {
    state.export_cancel.store(true, std::sync::atomic::Ordering::Relaxed);
}

fn tempdir_in(base: &Path) -> CmdResult<PathBuf> {
    let d = base.join(format!(".export-{}", std::process::id()));
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

// ───────────── 素材 ─────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    kind: &'static str,
    has_audio: bool,
    duration_ms: Option<u64>,
    width: Option<u32>,
    height: Option<u32>,
}

/// 素材の種類・長さ・大きさを ffprobe で調べる
#[tauri::command]
pub async fn probe_media(app: AppHandle, state: State<'_, AppState>, path: PathBuf) -> CmdResult<MediaInfo> {
    let ffprobe = {
        let f = state.ffmpeg();
        let name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
        match f.parent().filter(|d| !d.as_os_str().is_empty()) {
            Some(d) => d.join(name),
            None => PathBuf::from(name),
        }
    };
    allow_dir(&app, &path);
    blocking(move || {
        // Windows でコンソール窓を出さない
        let out = voxcut_core::tts::hidden_command(&ffprobe)
            .args(["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,nb_frames", "-of", "json"])
            .arg(&path)
            .output()
            .map_err(|e| format!("ffprobe を起動できません（{}）: {e}", ffprobe.display()))?;
        if !out.status.success() {
            return Err(format!("素材を読めません: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(err)?;
        let streams = v["streams"].as_array().cloned().unwrap_or_default();
        let video = streams.iter().find(|s| s["codec_type"] == "video");
        let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
        let duration_ms = v["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).map(|d| (d * 1000.0) as u64);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let is_still = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "avif");
        let kind = match (video, is_still, has_audio) {
            (Some(_), true, _) => "image",
            (Some(_), false, _) => "video",
            (None, _, true) => "audio",
            _ => return Err("対応していない素材です".into()),
        };
        Ok(MediaInfo {
            kind,
            has_audio,
            duration_ms: if kind == "image" { None } else { duration_ms },
            width: video.and_then(|s| s["width"].as_u64()).map(|w| w as u32),
            height: video.and_then(|s| s["height"].as_u64()).map(|h| h as u32),
        })
    })
    .await
}

/// プレビューで読めるよう、ファイルのあるフォルダを asset プロトコルに許可する（ユーザーが選んだファイルだけ）
#[tauri::command]
pub fn allow_paths(app: AppHandle, paths: Vec<PathBuf>) {
    for p in paths {
        allow_dir(&app, &p);
    }
}

fn allow_dir(app: &AppHandle, file: &Path) {
    if let Some(dir) = file.parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, false);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyProgress {
    src: String,
    ratio: f64,
}

/// 動画のプロキシを作り、そのパスを返す（できていればすぐ返る）。進捗は "proxy-progress"
#[tauri::command]
pub async fn make_proxy(app: AppHandle, state: State<'_, AppState>, src: PathBuf, duration_ms: u64) -> CmdResult<PathBuf> {
    let ffmpeg = state.ffmpeg();
    let root = state.proxy_root.clone();
    let lock = state.proxy_lock.clone();
    blocking(move || {
        let _g = lock.lock().unwrap();
        let name = src.to_string_lossy().into_owned();
        voxcut_core::proxy::make_proxy(&ffmpeg, &src, &root, duration_ms as f64 / 1000.0, &mut |ratio| {
            let _ = app.emit("proxy-progress", ProxyProgress { src: name.clone(), ratio });
        })
        .map_err(err)
    })
    .await
}

