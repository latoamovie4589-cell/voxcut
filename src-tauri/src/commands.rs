//! UI から呼ばれる IPC コマンド。重い処理は spawn_blocking に回し、UI スレッドを止めない。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter, Manager, State};
use voxcut_core::cache::AudioCache;
use voxcut_core::jobs;
use voxcut_core::render::{self, Encoder, ExportOptions};
use voxcut_core::text::{DictEntry, Dictionary};
use voxcut_core::tts::{build_engines, EngineConfig, EngineStatus, TtsEngine, VoiceInfo};
use voxcut_core::{lipsync, subtitle, waveform, Character, EngineId, Project};

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
    /// 読み方の辞書（すべてのソフトに共通）
    pub dictionary: Vec<DictEntry>,
    /// 最近使ったプロジェクト（新しい順）
    pub recent: Vec<PathBuf>,
}

const RECENT_MAX: usize = 10;

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
    /// 自動保存の置き場所
    autosave_path: PathBuf,
    /// 使えるハードウェアエンコーダー（初回だけ調べる）
    hw_encoders: std::sync::Mutex<Option<Vec<Encoder>>>,
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
        let autosave_path = app.path().app_data_dir()?.join("autosave.json");
        Ok(Self {
            export_cancel: Default::default(),
            proxy_root,
            proxy_lock: Default::default(),
            config_path,
            engines: RwLock::new(build_engines(&config.engines)),
            config: RwLock::new(config),
            cache,
            autosave_path,
            hw_encoders: Default::default(),
        })
    }

    fn dictionary(&self) -> Dictionary {
        Dictionary::new(&self.config.read().unwrap().dictionary)
    }

    fn write_config(&self, config: &AppConfig) -> CmdResult<()> {
        if let Some(dir) = self.config_path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        std::fs::write(&self.config_path, serde_json::to_string_pretty(config).map_err(err)?).map_err(err)
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
    state.write_config(&config)?;
    *state.engines.write().unwrap() = build_engines(&config.engines);
    *state.config.write().unwrap() = config;
    Ok(())
}

/// 最近使ったファイルの先頭に入れる（開いた・保存したとき）。新しい一覧を返す
#[tauri::command]
pub fn add_recent(state: State<'_, AppState>, path: PathBuf) -> CmdResult<Vec<PathBuf>> {
    let mut cfg = state.config.read().unwrap().clone();
    cfg.recent.retain(|p| p != &path);
    cfg.recent.insert(0, path);
    cfg.recent.truncate(RECENT_MAX);
    state.write_config(&cfg)?;
    let list = cfg.recent.clone();
    *state.config.write().unwrap() = cfg;
    Ok(list)
}

/// 最近使ったファイルから外す（見つからなかったときなど）
#[tauri::command]
pub fn remove_recent(state: State<'_, AppState>, path: PathBuf) -> CmdResult<Vec<PathBuf>> {
    let mut cfg = state.config.read().unwrap().clone();
    cfg.recent.retain(|p| p != &path);
    state.write_config(&cfg)?;
    let list = cfg.recent.clone();
    *state.config.write().unwrap() = cfg;
    Ok(list)
}

/// 読み方の辞書だけを保存する
#[tauri::command]
pub fn set_dictionary(state: State<'_, AppState>, entries: Vec<DictEntry>) -> CmdResult<()> {
    let mut cfg = state.config.read().unwrap().clone();
    cfg.dictionary = entries;
    state.write_config(&cfg)?;
    *state.config.write().unwrap() = cfg;
    Ok(())
}

// ───────────── 自動保存 ─────────────

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Autosave {
    project: Project,
    project_path: Option<PathBuf>,
    /// UNIX 時刻（ミリ秒）
    saved_at: u64,
}

/// 保存していない作業を書いておく（落ちても次の起動で戻せるように）
#[tauri::command]
pub async fn autosave_write(state: State<'_, AppState>, project: Project, project_path: Option<PathBuf>) -> CmdResult<()> {
    let path = state.autosave_path.clone();
    blocking(move || {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let saved_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string(&Autosave { project, project_path, saved_at }).map_err(err)?).map_err(err)?;
        std::fs::rename(&tmp, &path).map_err(err)
    })
    .await
}

#[tauri::command]
pub fn autosave_read(app: AppHandle, state: State<'_, AppState>) -> Option<Autosave> {
    let a: Autosave = serde_json::from_str(&std::fs::read_to_string(&state.autosave_path).ok()?).ok()?;
    a.project.validate().ok()?;
    if let Some(dir) = a.project_path.as_deref().and_then(Path::parent) {
        let _ = app.asset_protocol_scope().allow_directory(dir, true);
    }
    Some(a)
}

#[tauri::command]
pub fn autosave_clear(state: State<'_, AppState>) {
    let _ = std::fs::remove_file(&state.autosave_path);
}

// ───────────── キャラクターの書き出し・読み込み ─────────────

/// キャラクター設定（声・字幕・立ち絵）をファイルにする。立ち絵の相対パスは絶対パスに直す
#[tauri::command]
pub async fn export_character(path: PathBuf, mut character: Character, project_path: Option<PathBuf>) -> CmdResult<()> {
    blocking(move || {
        let base = project_path.as_deref().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default();
        let abs = |s: &mut String| {
            if !s.is_empty() && Path::new(s.as_str()).is_relative() {
                *s = base.join(s.as_str()).to_string_lossy().into_owned();
            }
        };
        if let Some(pt) = character.portrait.as_mut() {
            abs(&mut pt.base);
            for x in pt.eyes.iter_mut().chain(pt.mouth.iter_mut()).flatten() {
                abs(x);
            }
            for e in pt.expressions.iter_mut() {
                if let Some(b) = e.base.as_mut() {
                    abs(b);
                }
                for x in e.eyes.iter_mut().chain(e.mouth.iter_mut()).flatten() {
                    abs(x);
                }
            }
        }
        let json = serde_json::json!({"voxcutCharacter": 1, "character": character});
        std::fs::write(&path, serde_json::to_string_pretty(&json).map_err(err)?).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn import_character(app: AppHandle, path: PathBuf) -> CmdResult<Character> {
    let ch = blocking(move || {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(err)?).map_err(err)?;
        if v.get("voxcutCharacter").is_none() {
            return Err("VoxCut のキャラクターファイルではありません".to_string());
        }
        serde_json::from_value::<Character>(v["character"].clone()).map_err(err)
    })
    .await?;
    // 立ち絵をプレビューで読めるようにする
    if let Some(pt) = &ch.portrait {
        let mut files: Vec<&str> = vec![pt.base.as_str()];
        files.extend(pt.eyes.iter().chain(pt.mouth.iter()).flatten().map(String::as_str));
        for e in &pt.expressions {
            files.extend(e.base.as_deref());
            files.extend(e.eyes.iter().chain(e.mouth.iter()).flatten().map(String::as_str));
        }
        for f in files {
            allow_dir(&app, Path::new(f));
        }
    }
    Ok(ch)
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
    let dict = state.dictionary();
    blocking(move || {
        let (todo, mut ready) = jobs::plan(&project, &cache, clip_ids.as_deref(), &dict);
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

// ───────────── VOICEVOX のアクセント調整 ─────────────

fn voicevox(state: &AppState) -> voxcut_core::tts::voicevox::VoicevoxEngine {
    voxcut_core::tts::voicevox::VoicevoxEngine::new(state.config.read().unwrap().engines.voicevox.clone())
}

/// 文のアクセント句（辞書を当てた文で）。返す text は実際に使った文
#[tauri::command]
pub async fn voicevox_accent(state: State<'_, AppState>, text: String, speaker: String) -> CmdResult<serde_json::Value> {
    let eng = voicevox(&state);
    let text = state.dictionary().apply(&text);
    blocking(move || {
        let phrases = eng.accent_phrases(&text, &speaker).map_err(err)?;
        Ok(serde_json::json!({"text": text, "phrases": phrases}))
    })
    .await
}

/// アクセントの位置・区切りを変えたあとの、音の高さと長さ
#[tauri::command]
pub async fn voicevox_mora_data(state: State<'_, AppState>, phrases: serde_json::Value, speaker: String) -> CmdResult<serde_json::Value> {
    let eng = voicevox(&state);
    blocking(move || eng.mora_data(&phrases, &speaker).map_err(err)).await
}

// ───────────── PSD 立ち絵 ─────────────

/// PSD を読む（画面側で合成するため、ファイルの中身をそのまま渡す）。PSD・PSB 以外は読まない
#[tauri::command]
pub async fn read_psd(path: PathBuf) -> CmdResult<tauri::ipc::Response> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "psd" && ext != "psb" {
        return Err("PSD ファイルではありません".into());
    }
    let bytes = blocking(move || std::fs::read(&path).map_err(|e| format!("PSD を読めません: {e}"))).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// ファイルが変わったかを見分けるための印（更新日時と大きさ）。無ければ None
#[tauri::command]
pub fn file_stamp(path: PathBuf) -> Option<String> {
    let m = std::fs::metadata(&path).ok()?;
    let t = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    Some(format!("{t}-{}", m.len()))
}

/// 画面側で合成した PSD 立ち絵の画像を、キャッシュに保存してパスを返す。
/// 本文は PNG のバイト列そのもの、名前は x-name ヘッダー（英数字と - _ だけ）
#[tauri::command]
pub fn write_portrait_png(app: AppHandle, request: tauri::ipc::Request<'_>) -> CmdResult<PathBuf> {
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or("");
    if name.is_empty() || name.len() > 100 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("名前が正しくありません".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("画像が届いていません".into());
    };
    let dir = app.path().app_cache_dir().map_err(err)?.join("psd");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(format!("{name}.png"));
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(path)
}

/// キャッシュにある PSD 立ち絵の画像のパス（無ければ None）
#[tauri::command]
pub fn portrait_png_path(app: AppHandle, name: String) -> Option<PathBuf> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    let p = app.path().app_cache_dir().ok()?.join("psd").join(format!("{name}.png"));
    p.is_file().then_some(p)
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
    let dict = state.dictionary();
    blocking(move || {
        let mut project = project;
        let emit = |stage, ratio| {
            let _ = app.emit("export-progress", ExportProgress { stage, ratio });
        };
        emit("synth", 0.0);
        let (todo, mut ready) = jobs::plan(&project, &cache, None, &dict);
        ready.extend(jobs::run(todo, &engines, &cache, &|p| emit("synth", p.done as f64 / p.total.max(1) as f64)));
        let failed = jobs::apply(&mut project, ready);
        if let Some((id, e)) = failed.first() {
            return Err(format!("セリフ {id} を合成できませんでした: {e}"));
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(voxcut_core::Error::Cancelled.to_string());
        }

        let work = tempdir_in(cache.root())?;
        // 字幕は映像トラックごとに分けて、そのトラックの順番で焼き込む
        let mut captions: Vec<(String, std::path::PathBuf)> = vec![];
        for (i, t) in subtitle::caption_tracks(&project).into_iter().enumerate() {
            let ass = work.join(format!("subtitles{i}.ass"));
            std::fs::write(&ass, subtitle::build_ass_for(&project, Some(&t))).map_err(err)?;
            captions.push((t, ass));
        }
        let project_dir = project_path.as_deref().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default();
        emit("portrait", 0.0);
        let peaks = |key: &str| cache.get(key).and_then(|p| waveform::peaks(&p, lipsync::PEAKS_PER_SEC).ok());
        let portraits = render::prepare_portraits(&project, &project_dir, &ffmpeg, &work, &peaks, &options.portrait_frames).map_err(err)?;
        let mut opt = ExportOptions::new(&ffmpeg, &out, project_dir);
        opt.item_images = options.item_images.clone();
        // 1 文字ずつ出す字幕は、文字数ごとの画像を順に出す
        opt.item_sequences = render::prepare_sequences(&project, &opt.item_images, &work).map_err(err)?;
        if let Some(crf) = options.crf {
            opt.crf = crf.clamp(10, 40);
        }
        opt.out_height = options.height;
        opt.encoder = options.encoder.unwrap_or_default();
        let lookup = |id: &str| {
            project.clips.iter().find(|c| c.id == id).and_then(|c| c.as_voice()).and_then(|v| v.audio.as_ref()).and_then(|a| cache.get(&a.cache_key))
        };
        let total = project.video.frames_to_secs(project.duration());
        let new_syntax = ffmpeg_major(&ffmpeg) >= 7;
        let run = |opt: &ExportOptions| -> CmdResult<()> {
            let mut args = render::build_args(&project, &lookup, &portraits, &captions, opt).map_err(err)?;
            render::externalize_filter(&mut args, &work.join("graph.txt"), new_syntax, 6000).map_err(err)?;
            render::run_cancellable(&args, &ffmpeg, total, &mut |x| emit("encode", x), Some(&cancel)).map_err(err)
        };
        let mut r = run(&opt);
        // グラフィックボードで失敗したら、CPU でやり直す
        if r.is_err() && opt.encoder != Encoder::X264 && !cancel.load(std::sync::atomic::Ordering::Relaxed) {
            opt.encoder = Encoder::X264;
            emit("encode", 0.0);
            r = run(&opt);
        }
        let _ = std::fs::remove_dir_all(&work);
        r?;
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
    encoder: Option<Encoder>,
    /// テキスト・図形アイテムの画像（クリップ id → PNG のパス）
    #[serde(default)]
    item_images: std::collections::HashMap<String, PathBuf>,
    /// PSD 立ち絵の、状態ごとの画像（キャラクター id → 状態の番号 → PNG のパス）
    #[serde(default)]
    portrait_frames: std::collections::HashMap<String, std::collections::HashMap<usize, PathBuf>>,
}

/// この PC で使える書き出しの方法（CPU は常に使える）
#[tauri::command]
pub async fn video_encoders(state: State<'_, AppState>) -> CmdResult<Vec<Encoder>> {
    if let Some(v) = state.hw_encoders.lock().unwrap().clone() {
        return Ok(v);
    }
    let ffmpeg = state.ffmpeg();
    let mut v = blocking(move || Ok(render::detect_hw_encoders(&ffmpeg))).await?;
    v.insert(0, Encoder::X264);
    *state.hw_encoders.lock().unwrap() = Some(v.clone());
    Ok(v)
}

/// FFmpeg の大きい版番号（分からなければ 0）。"ffmpeg version 7.1" / "N-118000-g..."（開発版は新しい扱い）
fn ffmpeg_major(ffmpeg: &Path) -> u32 {
    let out = voxcut_core::tts::hidden_command(ffmpeg).arg("-version").output();
    let Ok(out) = out else { return 0 };
    let s = String::from_utf8_lossy(&out.stdout);
    let ver = s.split_whitespace().nth(2).unwrap_or("");
    if ver.starts_with('N') {
        return 99;
    }
    ver.trim_start_matches('n').split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0)
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

