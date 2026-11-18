// Rust（src-tauri/src/commands.rs）との窓口。
// ブラウザで開いたとき（Tauri 外）は、デザイン確認用の模擬実装に切り替わる。

import type {AccentPhrase, Character, EngineId, EngineStatus, MediaAudioFx, Plugin, Project, VoiceClip, VoiceInfo} from './model';
import {defaultParams, newLayer, reflowAll} from './model';

export interface SynthProgress {
  done: number;
  total: number;
  clipIds: string[];
  error: string | null;
}
export interface ExportProgress {
  stage: 'synth' | 'portrait' | 'encode';
  ratio: number;
}
export interface ExportRequest {
  /** 画質（x264 の CRF。小さいほど高画質） */
  crf: number;
  /** 出力の高さ（null ならプロジェクトのまま） */
  height: number | null;
  /** 動画のエンコーダー（グラフィックボードを使うと速い） */
  encoder?: Encoder;
  /** PSD 立ち絵の、状態ごとの画像（キャラクター id → 状態の番号 → PNG のパス） */
  portraitFrames?: Record<string, Record<number, string>>;
  /** テキスト・図形アイテムの画像（クリップ id → PNG のパス） */
  itemImages?: Record<string, string>;
  /** 静止画を 1 枚だけ書き出すときのフレーム（出力は .png / .jpg） */
  stillFrame?: number;
  /** 一部だけ書き出すときの範囲（始まりと終わりのフレーム） */
  rangeFrames?: [number, number];
  /** 背景を透明のまま書き出す（.mov は ProRes 4444、.webm は VP9） */
  transparent?: boolean;
}

/** x264 は CPU、nvenc は NVIDIA、qsv は Intel、amf は AMD */
export type Encoder = 'x264' | 'nvenc' | 'qsv' | 'amf';

export interface DictEntry {
  word: string;
  reading: string;
}

export interface Autosave {
  project: Project;
  projectPath: string | null;
  savedAt: number;
}

export interface MediaInfo {
  kind: 'image' | 'video' | 'audio';
  hasAudio: boolean;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}
export interface AppConfig {
  engines: {
    voicepeakPath: string | null;
    aivoiceBridgePath: string | null;
    /** A.I.VOICE のインストール先（AIVoiceEditor.exe のあるフォルダ） */
    aivoiceDir: string | null;
    voisona: {host: string; port: number; user: string; password: string; timeoutSecs: number};
    voicevox: {host: string; port: number};
    coeiroink: {host: string; port: number};
    /** AquesTalkPlayer の場所と、足したプリセット名 */
    aquestalkPath: string | null;
    aquestalkPresets: string[];
  };
  ffmpegPath: string | null;
  dictionary: DictEntry[];
  recent: string[];
}

export interface AiModel {
  id: string;
  /** "whisper"（字幕）か "matte"（背景を消す） */
  kind: 'whisper' | 'matte';
  label: string;
  /** だいたいの大きさ（バイト） */
  size: number;
  ready: boolean;
}

export interface AiProgress {
  stage: 'download' | 'transcribe' | 'matte' | 'track';
  id: string;
  ratio: number;
}

/** LUT の画面用の近い形：3 行 × 4 の行列（重みと足す量）と、色ごとの曲線（0〜1 を 16 等分した 17 点） */
export interface LutFit {
  matrix: number[];
  tables: number[][];
}

/** 文字起こしの 1 まとまり（秒は素材の頭から） */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type Unlisten = () => void;

export interface Api {
  /** 新しいプロジェクト。sample なら見本入り（「サンプルを開く」） */
  newProject(sample?: boolean): Promise<Project>;
  /** 字幕を SRT で書き出す */
  exportSrt(project: Project, out: string): Promise<void>;
  /** ファイルをいつものアプリで開く（書き出した動画を再生する） */
  openPath(path: string): Promise<void>;
  openProject(path: string): Promise<Project>;
  saveProject(path: string, project: Project): Promise<void>;
  /** 上書き保存する前に残した版（新しい順）。savedMs はその内容を残した時刻 */
  listBackups(path: string): Promise<{path: string; savedMs: number; size: number}[]>;
  /** 残した版を読む */
  readBackup(path: string): Promise<Project>;
  getConfig(): Promise<AppConfig>;
  setConfig(config: AppConfig): Promise<void>;
  engineStatus(): Promise<{engine: EngineId; status: EngineStatus}[]>;
  listVoices(engine: EngineId): Promise<VoiceInfo[]>;
  synthesize(project: Project, clipIds?: string[]): Promise<{project: Project; failed: [string, string][]}>;
  waveform(cacheKey: string): Promise<Int8Array>;
  audioUrl(cacheKey: string): Promise<string | null>;
  exportVideo(project: Project, projectPath: string | null, out: string, options?: ExportRequest): Promise<Project>;
  cancelExport(): Promise<void>;
  /** エクスプローラーでファイルの場所を開く */
  revealInFolder(path: string): Promise<void>;
  /** ウィンドウを閉じようとしたときに呼ぶ。false を返すと閉じない */
  onCloseRequested(cb: () => Promise<boolean>): Promise<Unlisten>;
  ask(message: string, okLabel: string): Promise<boolean>;
  onSynthProgress(cb: (p: SynthProgress) => void): Promise<Unlisten>;
  onExportProgress(cb: (p: ExportProgress) => void): Promise<Unlisten>;
  pickOpenPath(): Promise<string | null>;
  pickSavePath(kind: 'project' | 'video' | 'mov' | 'webm' | 'gif' | 'audio' | 'subtitle' | 'image', suggested: string): Promise<string | null>;
  /** 素材・立ち絵のファイルを選ぶ */
  pickMedia(kind: 'media' | 'image', multiple: boolean): Promise<string[]>;
  /** 実行ファイル（.exe）を選ぶ */
  pickExe(title: string, defaultPath?: string | null): Promise<string | null>;
  /** 素材を調べる（相対パスはプロジェクトのフォルダから） */
  probeMedia(path: string, projectPath?: string | null): Promise<MediaInfo>;
  /** 素材のパス（プロジェクトからの相対パスも可）→ 画面で読める URL */
  mediaUrl(path: string, projectPath: string | null): string;
  allowPaths(paths: string[]): Promise<void>;
  /** 動画のプロキシを作り、画面で読める URL を返す */
  makeProxy(src: string, projectPath: string | null, durationMs: number, stabilize?: boolean): Promise<string>;
  /** 効果音のファイル（なければ作る）のパス */
  makeSfx(name: string): Promise<string>;
  /** エフェクトのプラグイン（フォルダの場所と、読み込んだファイル） */
  listPlugins(): Promise<{dir: string; plugins: {file: string; plugin: Plugin | null; error: string | null}[]}>;
  /** 動画の場面の変わり目（秒、素材の頭から） */
  detectScenes(src: string, projectPath: string | null, threshold: number): Promise<number[]>;
  /** テンプレートのファイル（.voxtpl）を選ぶ */
  pickTemplatePath(mode: 'save' | 'open'): Promise<string | null>;
  /** 静かなところ（秒、素材の頭から） */
  detectSilence(src: string, projectPath: string | null, thresholdDb: number, minLen: number): Promise<[number, number][]>;
  /** LUT（.cube）のファイルを選ぶ */
  pickLutPath(): Promise<string | null>;
  /** LUT を画面用の近い形（行列＋色ごとの曲線）にする */
  lutFit(path: string): Promise<LutFit>;
  writeTextFile(path: string, text: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  /** 素材の音を加工した WAV（プレビュー用）の URL */
  processAudio(src: string, projectPath: string | null, fx: MediaAudioFx): Promise<string>;
  /** 素材の音の大きさと、そろえるための増減（dB） */
  measureAudio(src: string, projectPath: string | null): Promise<{meanDb: number; maxDb: number; gainDb: number}>;
  /** 素材の拍の時刻（秒、素材の頭から） */
  detectBeats(src: string, projectPath: string | null): Promise<number[]>;
  onProxyProgress(cb: (p: {src: string; ratio: number}) => void): Promise<Unlisten>;
  /** AI のモデルの一覧（ダウンロード済みか） */
  modelStatus(): Promise<AiModel[]>;
  /** AI のモデルをダウンロードする（進捗は onAiProgress） */
  downloadModel(id: string): Promise<void>;
  /** 素材の音を文字起こしする（秒は素材の頭から） */
  transcribe(src: string, projectPath: string | null, model: string, inS: number, dur: number): Promise<Segment[]>;
  /** 背景を消す型（白が残すところ）の URL。画像なら PNG、動画なら MP4 */
  makeMatte(src: string, projectPath: string | null, model: string, still: boolean, durationMs: number): Promise<string>;
  onAiProgress(cb: (p: AiProgress) => void): Promise<Unlisten>;
  /** 被写体の位置（素材の t 秒目に、重心が 0〜1 の x・y）。背景を消す型を作って調べる */
  /** 動画の中の 1 点を追う（素材の from〜to 秒。x・y・size は 0〜1） */
  trackMotion(src: string, projectPath: string | null, from: number, to: number, x: number, y: number, size: number): Promise<{t: number; x: number; y: number; score: number}[]>;
  subjectTrack(src: string, projectPath: string | null, model: string, still: boolean, durationMs: number): Promise<{t: number; x: number; y: number}[]>;
  /** この PC で使える書き出しの方法（先頭は CPU） */
  videoEncoders(): Promise<Encoder[]>;
  addRecent(path: string): Promise<string[]>;
  removeRecent(path: string): Promise<string[]>;
  setDictionary(entries: DictEntry[]): Promise<void>;
  autosaveWrite(project: Project, projectPath: string | null): Promise<void>;
  autosaveRead(): Promise<Autosave | null>;
  autosaveClear(): Promise<void>;
  /** キャラクター設定のファイル */
  pickCharacterPath(mode: 'save' | 'open', suggested?: string): Promise<string | null>;
  exportCharacter(path: string, character: Character, projectPath: string | null): Promise<void>;
  importCharacter(path: string): Promise<Character>;
  /** VOICEVOX：文のアクセント句（text は辞書を当てた文） */
  voicevoxAccent(text: string, speaker: string): Promise<{text: string; phrases: AccentPhrase[]}>;
  /** VOICEVOX：アクセントの位置・区切りを変えたあとの音の高さと長さ */
  voicevoxMoraData(phrases: AccentPhrase[], speaker: string): Promise<AccentPhrase[]>;
  /** PSD 立ち絵のファイルを選ぶ */
  pickPsd(): Promise<string | null>;
  /** PSD の中身（相対パスはプロジェクトのフォルダから） */
  readPsd(path: string, projectPath: string | null): Promise<ArrayBuffer>;
  /** ファイルが変わったかを見分ける印（無ければ null） */
  fileStamp(path: string, projectPath: string | null): Promise<string | null>;
  /** 合成した PSD 立ち絵の画像をキャッシュに保存して、パスを返す */
  writePortraitPng(name: string, png: Uint8Array): Promise<string>;
  /** マイクで録った WAV を保存してパスを返す */
  writeRecording(wav: Uint8Array): Promise<string>;
  /** 画面録画（WebM）を保存して、長さを書き込んだ動画のパスを返す */
  writeCapture(webm: Uint8Array): Promise<string>;
  /** 素材ライブラリ（プロジェクトをまたいで使う素材）の一覧。新しく入れた順 */
  libraryList(): Promise<LibraryItem[]>;
  /** ファイルをライブラリへ写す（同じ中身はもうあるものを返す）。相対パスはプロジェクトのフォルダから */
  libraryAdd(paths: string[], folder: string, projectPath: string | null): Promise<LibraryItem[]>;
  libraryUpdate(id: string, patch: {name?: string; folder?: string}): Promise<void>;
  /** ライブラリから外す（写したファイルも消す） */
  libraryRemove(id: string): Promise<void>;
  /** キャッシュにある PSD 立ち絵の画像のパス（無ければ null） */
  portraitPngPath(name: string): Promise<string | null>;
  /** 音声合成ソフトを起動する（起動を始めたら true。場所が分からない・起動の要らないソフトは false） */
  launchEngine(engine: EngineId): Promise<boolean>;
  /** 素材をプロジェクトの隣のフォルダへ集めて、パスを書き換えたプロジェクトを返す */
  collectMedia(project: Project, projectPath: string): Promise<{project: Project; copied: number; dir: string}>;
  /** 素材の場所を選び直す（今の名前を見せて、同じ種類のファイルを選ぶ） */
  pickRelink(current: string): Promise<string | null>;
}

/** 素材ライブラリの 1 つ（Rust の library::LibraryItem と同じ） */
export interface LibraryItem {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
  /** 分類（効果音・BGM・立ち絵など。空なら分類なし） */
  folder: string;
  /** 写したファイルの場所 */
  path: string;
  hash: string;
  addedMs: number;
}
/** ブラウザで確かめる用の保存した内容とバックアップ */
const mockSaved = new Map<string, string>();
const mockBackups = new Map<string, {path: string; savedMs: number; json: string}[]>();
/** ブラウザで確かめる用のライブラリ */
const mockLibrary: LibraryItem[] = [];

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'];
const MEDIA_EXT = [...IMAGE_EXT, 'mp4', 'mov', 'mkv', 'webm', 'avi', 'wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'];

function resolvePath(path: string, projectPath: string | null): string {
  const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  if (isAbs || !projectPath) return path;
  const dir = projectPath.replace(/[\\/][^\\/]*$/, '');
  return `${dir}/${path}`;
}

// ───────────── Tauri ─────────────

async function tauriApi(): Promise<Api> {
  const {invoke, convertFileSrc} = await import('@tauri-apps/api/core');
  const {listen} = await import('@tauri-apps/api/event');
  const dialog = await import('@tauri-apps/plugin-dialog');
  const lastSaveDir: Partial<Record<'project' | 'video', string>> = {};
  return {
    newProject: sample => invoke('new_project', {sample: sample ?? null}),
    exportSrt: (project, out) => invoke('export_srt', {project, out}),
    openPath: async path => {
      const {openPath} = await import('@tauri-apps/plugin-opener');
      await openPath(path);
    },
    openProject: path => invoke('open_project', {path}),
    saveProject: (path, project) => invoke('save_project', {path, project}),
    listBackups: path => invoke('list_backups', {path}),
    readBackup: path => invoke('read_backup', {path}),
    getConfig: () => invoke('get_config'),
    setConfig: config => invoke('set_config', {config}),
    engineStatus: () => invoke('engine_status'),
    listVoices: engine => invoke('list_voices', {engine}),
    synthesize: (project, clipIds) => invoke('synthesize', {project, clipIds: clipIds ?? null}),
    waveform: async cacheKey => new Int8Array(await invoke<ArrayBuffer>('waveform', {cacheKey})),
    audioUrl: async cacheKey => {
      try {
        return convertFileSrc(await invoke<string>('audio_path', {cacheKey}));
      } catch {
        return null;
      }
    },
    exportVideo: (project, projectPath, out, options) => invoke('export_video', {project, projectPath, out, options: options ?? null}),
    cancelExport: () => invoke('cancel_export'),
    revealInFolder: async path => {
      const {revealItemInDir} = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(path);
    },
    onCloseRequested: async cb => {
      const {getCurrentWindow} = await import('@tauri-apps/api/window');
      return getCurrentWindow().onCloseRequested(async e => {
        if (!(await cb())) e.preventDefault();
      });
    },
    ask: (message, okLabel) => dialog.ask(message, {title: 'VoxCut', kind: 'warning', okLabel, cancelLabel: 'キャンセル'}),
    onSynthProgress: cb => listen<SynthProgress>('synth-progress', e => cb(e.payload)),
    onExportProgress: cb => listen<ExportProgress>('export-progress', e => cb(e.payload)),
    pickOpenPath: async () => {
      const r = await dialog.open({filters: [{name: 'VoxCut', extensions: ['voxcut']}]});
      return typeof r === 'string' ? r : null;
    },
    pickSavePath: async (kind, suggested) => {
      // フォルダが付いていない名前だけのときは、動画は「ビデオ」（前回書き出した場所があればそこ）、
      // プロジェクトは「ドキュメント」から始める。直前に別の画面で開いたフォルダから始まらないように
      let defaultPath = suggested;
      if (!/[\\/]/.test(suggested)) {
        const path = await import('@tauri-apps/api/path');
        const base = kind === 'project' ? (lastSaveDir.project ?? (await path.documentDir())) : (lastSaveDir.video ?? (await path.videoDir()));
        defaultPath = await path.join(base, suggested);
      }
      const r = await dialog.save({
        defaultPath,
        filters: [
          kind === 'project'
            ? {name: 'VoxCut', extensions: ['voxcut']}
            : kind === 'audio'
              ? {name: 'WAV（音声）', extensions: ['wav']}
              : kind === 'subtitle'
                ? {name: 'SRT（字幕）', extensions: ['srt']}
                : kind === 'gif'
                  ? {name: 'GIF（動く画像）', extensions: ['gif']}
                  : kind === 'image'
                    ? {name: '画像（PNG・JPEG）', extensions: ['png', 'jpg']}
                    : kind === 'mov'
                      ? {name: 'MOV（ProRes 4444・背景が透明）', extensions: ['mov']}
                      : kind === 'webm'
                        ? {name: 'WebM（VP9・背景が透明）', extensions: ['webm']}
                        : {name: 'MP4', extensions: ['mp4']},
        ],
      });
      if (r) lastSaveDir[kind === 'project' ? 'project' : 'video'] = r.replace(/[\\/][^\\/]*$/, '');
      return r;
    },
    pickMedia: async (kind, multiple) => {
      const r = await dialog.open({
        multiple,
        filters: [{name: kind === 'image' ? '画像' : '素材', extensions: kind === 'image' ? IMAGE_EXT : MEDIA_EXT}],
      });
      const list = r === null ? [] : Array.isArray(r) ? r : [r];
      if (list.length) await invoke('allow_paths', {paths: list});
      return list;
    },
    pickExe: async (title, defaultPath) => {
      const r = await dialog.open({title, defaultPath: defaultPath ?? undefined, filters: [{name: '実行ファイル', extensions: ['exe']}]});
      return typeof r === 'string' ? r : null;
    },
    voicevoxAccent: (text, speaker) => invoke('voicevox_accent', {text, speaker}),
    voicevoxMoraData: (phrases, speaker) => invoke('voicevox_mora_data', {phrases, speaker}),
    pickPsd: async () => {
      const r = await dialog.open({title: 'PSD 立ち絵を選ぶ', filters: [{name: 'PSD', extensions: ['psd', 'psb']}]});
      return typeof r === 'string' ? r : null;
    },
    readPsd: (path, projectPath) => invoke<ArrayBuffer>('read_psd', {path: resolvePath(path, projectPath)}),
    fileStamp: (path, projectPath) => invoke<string | null>('file_stamp', {path: resolvePath(path, projectPath)}),
    writePortraitPng: (name, png) => invoke<string>('write_portrait_png', png, {headers: {'x-name': name}}),
    writeRecording: wav => invoke<string>('write_recording', wav),
    writeCapture: webm => invoke<string>('write_capture', webm),
    libraryList: () => invoke('library_list'),
    libraryAdd: (paths, folder, projectPath) => invoke('library_add', {paths, folder, projectPath}),
    libraryUpdate: (id, patch) => invoke('library_update', {id, name: patch.name ?? null, folder: patch.folder ?? null}),
    libraryRemove: id => invoke('library_remove', {id}),
    portraitPngPath: name => invoke<string | null>('portrait_png_path', {name}),
    launchEngine: engine => invoke<boolean>('launch_engine', {engine}),
    collectMedia: (project, projectPath) => invoke('collect_media', {project, projectPath}),
    pickRelink: async current => {
      const name = current.split(/[\\/]/).pop() ?? current;
      const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase();
      const r = await dialog.open({
        title: `「${name}」の今の場所を選ぶ`,
        filters: ext
          ? [
              {name: `${name} と同じ種類`, extensions: [ext]},
              {name: 'すべて', extensions: ['*']},
            ]
          : [],
      });
      if (typeof r !== 'string') return null;
      // 同じフォルダのほかの素材も読めるよう、フォルダごと許可する
      await invoke('allow_paths', {paths: [r]});
      return r;
    },
    probeMedia: (path, projectPath) => invoke('probe_media', {path: resolvePath(path, projectPath ?? null)}),
    mediaUrl: (path, projectPath) => convertFileSrc(resolvePath(path, projectPath)),
    allowPaths: paths => invoke('allow_paths', {paths}),
    makeProxy: async (src, projectPath, durationMs, stabilize) => convertFileSrc(await invoke<string>('make_proxy', {src: resolvePath(src, projectPath), durationMs, stabilize: !!stabilize})),
    makeSfx: name => invoke('make_sfx', {name}),
    listPlugins: async () => {
      const [dir, plugins] = await invoke<[string, {file: string; plugin: Plugin | null; error: string | null}[]]>('list_plugins');
      return {dir, plugins};
    },
    detectScenes: (src, projectPath, threshold) => invoke('detect_scenes', {src: resolvePath(src, projectPath), threshold}),
    pickLutPath: async () => {
      const r = await dialog.open({filters: [{name: 'LUT（.cube）', extensions: ['cube', 'CUBE']}]});
      return typeof r === 'string' ? r : null;
    },
    lutFit: path => invoke('lut_fit', {path}),
    detectSilence: (src, projectPath, thresholdDb, minLen) => invoke('detect_silence', {src: resolvePath(src, projectPath), thresholdDb, minLen}),
    pickTemplatePath: async mode => {
      const filters = [{name: 'VoxCut テンプレート', extensions: ['voxtpl']}];
      if (mode === 'save') {
        const path = await import('@tauri-apps/api/path');
        return dialog.save({defaultPath: await path.join(await path.documentDir(), 'テンプレート.voxtpl'), filters});
      }
      const r = await dialog.open({filters});
      return typeof r === 'string' ? r : null;
    },
    writeTextFile: (path, text) => invoke('write_text_file', {path, text}),
    readTextFile: path => invoke('read_text_file', {path}),
    processAudio: async (src, projectPath, fx) => convertFileSrc(await invoke<string>('process_audio', {src: resolvePath(src, projectPath), fx})),
    measureAudio: (src, projectPath) => invoke('measure_audio', {src: resolvePath(src, projectPath)}),
    detectBeats: (src, projectPath) => invoke('detect_beats', {src: resolvePath(src, projectPath)}),
    onProxyProgress: cb => listen<{src: string; ratio: number}>('proxy-progress', e => cb(e.payload)),
    modelStatus: () => invoke('model_status'),
    downloadModel: id => invoke('download_model', {id}),
    transcribe: (src, projectPath, model, inS, dur) => invoke('transcribe', {src: resolvePath(src, projectPath), model, inS, dur}),
    makeMatte: async (src, projectPath, model, still, durationMs) => convertFileSrc(await invoke<string>('make_matte', {src: resolvePath(src, projectPath), model, still, durationMs})),
    onAiProgress: cb => listen<AiProgress>('ai-progress', e => cb(e.payload)),
    trackMotion: (src, projectPath, from, to, x, y, size) => invoke('track_motion', {src: resolvePath(src, projectPath), from, to, x, y, size}),
    subjectTrack: (src, projectPath, model, still, durationMs) => invoke('subject_track', {src: resolvePath(src, projectPath), model, still, durationMs}),
    videoEncoders: () => invoke('video_encoders'),
    addRecent: path => invoke('add_recent', {path}),
    removeRecent: path => invoke('remove_recent', {path}),
    setDictionary: entries => invoke('set_dictionary', {entries}),
    autosaveWrite: (project, projectPath) => invoke('autosave_write', {project, projectPath}),
    autosaveRead: () => invoke('autosave_read'),
    autosaveClear: () => invoke('autosave_clear'),
    pickCharacterPath: async (mode, suggested) => {
      const filters = [{name: 'VoxCut キャラクター', extensions: ['voxchar']}];
      if (mode === 'save') {
        const path = await import('@tauri-apps/api/path');
        return dialog.save({defaultPath: await path.join(await path.documentDir(), `${suggested ?? 'キャラクター'}.voxchar`), filters});
      }
      const r = await dialog.open({filters});
      return typeof r === 'string' ? r : null;
    },
    exportCharacter: (path, character, projectPath) => invoke('export_character', {path, character, projectPath}),
    importCharacter: path => invoke('import_character', {path}),
  };
}

// ───────────── 模擬（ブラウザでのデザイン確認用） ─────────────

const MOCK_VOICES: Record<EngineId, VoiceInfo[]> = {
  voicepeak: ['Japanese Female 1', 'Japanese Male 1', 'Japanese Female Child'].map(s => ({
    engine: 'voicepeak',
    speaker: s,
    displayName: s,
    emotions: ['happy', 'fun', 'angry', 'sad'],
    credit: null,
  })),
  aivoice: ['琴葉 茜', '琴葉 葵', '紲星 あかり'].map(s => ({engine: 'aivoice', speaker: s, displayName: s, emotions: [], credit: null})),
  voisona: [{engine: 'voisona', speaker: 'tanaka-san_ja_JP', displayName: '田中傘', emotions: [], credit: null}],
  voicevox: [
    ['3', 'ずんだもん', 'ノーマル'],
    ['1', 'ずんだもん', 'あまあま'],
    ['2', '四国めたん', 'ノーマル'],
    ['8', '春日部つむぎ', 'ノーマル'],
  ].map(([id, n, st]) => ({engine: 'voicevox', speaker: id, displayName: `${n}（${st}）`, emotions: [], credit: `VOICEVOX:${n}`})),
  coeiroink: [{engine: 'coeiroink', speaker: '3c37646f-3881-5374-2a83-149267990abc:0', displayName: 'つくよみちゃん（れいせい）', emotions: [], credit: 'COEIROINK:つくよみちゃん'}],
  aquestalk: ['れいむ', 'まりさ'].map(s => ({engine: 'aquestalk', speaker: s, displayName: s, emotions: [], credit: null})),
  cevio: [{engine: 'cevio', speaker: 'さとうささら', displayName: 'さとうささら', emotions: ['普通', '元気', '怒り', '哀しみ'], credit: null}],
};

/** 空のプロジェクト（Rust の Project::new と同じ：レイヤー 1〜6、キャラクターなし） */
function emptyMockProject(): Project {
  return {...mockProject(), name: '新しいプロジェクト', characters: [], clips: []};
}

function mockProject(): Project {
  const sub = {
    fontFamily: 'Yu Gothic UI',
    fontSize: 56,
    color: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 4,
    position: 'bottom' as const,
    marginV: 60,
    animation: 'pop' as const,
  };
  const lines: [string, string][] = [
    ['ch_a', 'こんにちは。VoxCut のサンプルです。'],
    ['ch_b', 'セリフを入力すると、音声と字幕が自動で並びます。'],
    ['ch_a', '声は A.I.VOICE、VOICEPEAK、VoiSona Talk、VOICEVOX から選べます。'],
  ];
  return {
    version: 4,
    name: 'サンプル',
    video: {width: 1920, height: 1080, fps: 30, sampleRate: 48000, background: '#000000'},
    characters: [
      {
        id: 'ch_a',
        name: 'ナレーター',
        color: '#30B0C7',
        voice: {engine: 'voicepeak', speaker: 'Japanese Female 1', params: defaultParams()},
        subtitle: sub,
        // 同梱のサンプル立ち絵（public/sample/sample.psd。体・目・口のレイヤー）
        portrait: {
          base: '',
          eyes: [null, null, null],
          mouth: [null, null, null],
          transform: {x: 600, y: 240, scale: 1.1, opacity: 1},
          expressions: [],
          visible: true,
          psd: {src: '/sample/sample.psd', visibility: {}, eyes: ['1/0', '1/1', '1/2'], mouth: ['0/0', '0/1', '0/2']},
        },
        layer: 2,
        audioLayer: null,
      },
      {
        id: 'ch_b',
        name: 'アシスタント',
        color: '#FF9F0A',
        voice: {engine: 'aivoice', speaker: '琴葉 茜', params: defaultParams()},
        subtitle: {...sub, color: '#FFE08A', animation: 'typewriter' as const},
        portrait: null,
        layer: 3,
        audioLayer: null,
      },
    ],
    // Rust の Project::new と同じ V1〜V3・A1〜A3
    tracks: [newLayer('V1'), newLayer('V2'), newLayer('V3'), newLayer('V4'), newLayer('V5'), newLayer('V6')],
    clips: [
      // 立ち絵アイテム（ナレーター、全体）
      {id: 'pt1', type: 'portrait' as const, trackId: 'V1', start: 0, duration: 270, characterId: 'ch_a', transform: {x: 600, y: 240, scale: 1.1, opacity: 1}},
      ...lines.map(([ch, text], i) => ({
        id: `c${i + 1}`,
        trackId: ch === 'ch_a' ? 'V2' : 'V3',
        start: i * 90,
        duration: 90,
        type: 'voice' as const,
        characterId: ch,
        text,
        subtitle: null,
        paramsOverride: null,
        audio: null,
        gapAfter: 6,
        lockDuration: false,
      })),
    ],
  };
}

const mockPngs = new Map<string, Uint8Array>();

function mockApi(): Api {
  const synthListeners = new Set<(p: SynthProgress) => void>();
  const exportListeners = new Set<(p: ExportProgress) => void>();
  const proxyListeners = new Set<(p: {src: string; ratio: number}) => void>();
  const aiListeners = new Set<(p: AiProgress) => void>();
  const mockModels: AiModel[] = [
    {id: 'whisper-base', kind: 'whisper', label: '速い（約 150MB）', size: 147_951_465, ready: false},
    {id: 'whisper-small', kind: 'whisper', label: 'ふつう（約 490MB）', size: 487_601_967, ready: false},
    {id: 'matte-fast', kind: 'matte', label: '速い（約 5MB）', size: 4_574_861, ready: false},
  ];
  let cancelled = false;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const durations = new Map<string, number>();
  let config: AppConfig = {
    engines: {
      voicepeakPath: null,
      aivoiceBridgePath: null,
      aivoiceDir: null,
      voisona: {host: '127.0.0.1', port: 32766, user: '', password: '', timeoutSecs: 60},
      voicevox: {host: '127.0.0.1', port: 50021},
      coeiroink: {host: '127.0.0.1', port: 50032},
      aquestalkPath: null,
      aquestalkPresets: [],
    },
    ffmpegPath: null,
    dictionary: [],
    recent: [],
  };
  let autosave: Autosave | null = null;
  const savedChars = new Map<string, Character>();
  const synth = async (project: Project, clipIds?: string[]) => {
    const targets = project.clips.filter((c): c is VoiceClip => c.type === 'voice' && (!clipIds || clipIds.includes(c.id)) && c.text.trim() !== '');
    let done = 0;
    const audio = new Map<string, {cacheKey: string; durationMs: number}>();
    for (const c of targets) {
      // 試すときは window.__mockSynthMs で 1 行の合成時間を変えられる（本物の VOICEPEAK は 1〜3 秒）
      await sleep((globalThis as {__mockSynthMs?: number}).__mockSynthMs ?? 120);
      const durationMs = 600 + [...c.text].length * 110;
      const cacheKey = `mock-${c.id}-${durationMs}`;
      durations.set(cacheKey, durationMs);
      audio.set(c.id, {cacheKey, durationMs});
      done++;
      synthListeners.forEach(cb => cb({done, total: targets.length, clipIds: [c.id], error: null}));
    }
    let p: Project = {...project, clips: project.clips.map(c => (audio.has(c.id) ? {...c, audio: audio.get(c.id)!} : c))};
    p = reflowAll(p);
    return {project: p, failed: [] as [string, string][]};
  };
  return {
    newProject: async sample => (sample ? mockProject() : emptyMockProject()),
    exportSrt: async () => {},
    openPath: async () => {},
    openProject: async () => mockProject(),
    // ブラウザで確かめる用：上書きする前の内容を版として覚える（Rust の backup::before_save と同じく、同じ中身は増やさない）
    saveProject: async (path, project) => {
      const json = JSON.stringify(project);
      const prev = mockSaved.get(path);
      const list = mockBackups.get(path) ?? [];
      if (prev !== undefined && list[0]?.json !== prev) list.unshift({path: `/backup/${list.length + 1}.voxcut`, savedMs: Date.now() + list.length, json: prev});
      mockBackups.set(path, list.slice(0, 30));
      mockSaved.set(path, json);
    },
    listBackups: async path => (mockBackups.get(path) ?? []).map(b => ({path: b.path, savedMs: b.savedMs, size: b.json.length})),
    readBackup: async path => {
      for (const l of mockBackups.values()) for (const b of l) if (b.path === path) return JSON.parse(b.json);
      throw new Error('バックアップではありません');
    },
    getConfig: async () => config,
    setConfig: async c => {
      config = c;
    },
    engineStatus: async () =>
      (globalThis as {__mockEngines?: () => {engine: EngineId; status: EngineStatus}[]}).__mockEngines?.() ?? [
        {engine: 'aivoice', status: {state: 'ready', version: '1.4.0'}},
        {engine: 'voicepeak', status: {state: 'ready', version: null}},
        {engine: 'voisona', status: {state: 'notRunning', detail: 'VoiSona Talk を起動し、API を有効にしてください'}},
        {engine: 'voicevox', status: {state: 'ready', version: '0.99.0'}},
        {engine: 'coeiroink', status: {state: 'notRunning', detail: 'COEIROINK v2 を起動してください'}},
        {engine: 'aquestalk', status: {state: 'notFound', detail: '設定で AquesTalkPlayer の場所を選んでください'}},
        {engine: 'cevio', status: {state: 'notFound', detail: 'CeVIO AI が見つかりません'}},
      ],
    listVoices: async engine => MOCK_VOICES[engine],
    synthesize: synth,
    waveform: async key => {
      const ms = durations.get(key) ?? 2000;
      const n = Math.ceil(ms / 10);
      const a = new Int8Array(n * 2);
      for (let i = 0; i < n; i++) {
        const env = Math.sin((Math.PI * i) / n) * (0.55 + 0.45 * Math.sin(i / 7));
        const v = Math.round(env * 90 * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.7))));
        a[i * 2] = -v;
        a[i * 2 + 1] = v;
      }
      return a;
    },
    audioUrl: async () => null,
    exportVideo: async (project, _pp, _out, options) => {
      cancelled = false;
      (globalThis as {__lastExport?: unknown}).__lastExport = options;
      if (options?.stillFrame !== undefined) {
        await sleep(200);
        return project;
      }
      const {project: p} = await synth(project);
      for (let i = 0; i <= 40; i++) {
        await sleep(60);
        if (cancelled) throw new Error('取り消しました');
        exportListeners.forEach(cb => cb({stage: 'encode', ratio: i / 40}));
      }
      return p;
    },
    cancelExport: async () => {
      cancelled = true;
    },
    revealInFolder: async () => {},
    onCloseRequested: async cb => {
      const h = (e: BeforeUnloadEvent) => {
        void cb();
        if (getStateDirty()) e.preventDefault();
      };
      window.addEventListener('beforeunload', h);
      return () => window.removeEventListener('beforeunload', h);
    },
    ask: async message => window.confirm(message),
    onSynthProgress: async cb => {
      synthListeners.add(cb);
      return () => synthListeners.delete(cb);
    },
    onExportProgress: async cb => {
      exportListeners.add(cb);
      return () => exportListeners.delete(cb);
    },
    pickOpenPath: async () => 'sample.voxcut',
    pickSavePath: async (_k, s) => s,
    pickExe: async title => (title.includes('A.I.VOICE') ? 'D:\\develop\\A.I.VOICE\\AIVoiceEditor\\AIVoiceEditor.exe' : 'D:\\develop\\VOICEPEAK\\voicepeak.exe'),
    pickMedia: async kind => (kind === 'image' ? ['/sample/body.png'] : ['/sample/clip.mp4']),
    // ブラウザで確かめるとき：読点で句に分け、1 文字を 1 音にした仮のアクセント句
    voicevoxAccent: async text => ({
      text,
      phrases: text
        .split(/[、。！？]/)
        .filter(Boolean)
        .map(part => ({
          moras: [...part].map((ch, i) => ({text: ch, vowel: 'a', vowel_length: 0.1, pitch: i === 0 ? 5.4 : 5.8 - i * 0.05})),
          accent: 1,
          pause_mora: {text: '、', vowel: 'pau', vowel_length: 0.3, pitch: 0},
        })),
    }),
    voicevoxMoraData: async phrases => phrases.map(ph => ({...ph, moras: ph.moras.map((m, i) => ({...m, pitch: m.pitch === 0 ? 0 : i < ph.accent ? 5.8 : 5.2 - (i - ph.accent) * 0.05}))})),
    // ブラウザで確かめるとき：window.__mockPsd に置いた PSD を使う
    pickPsd: async () => (window as unknown as {__mockPsd?: string}).__mockPsd ?? null,
    readPsd: async path => (await fetch(path)).arrayBuffer(),
    fileStamp: async path => ((globalThis as {__mockMissing?: string[]}).__mockMissing?.includes(path) ? null : 'mock'),
    // ブラウザで確かめる用：録った WAV は覚えておくだけ（window.__lastRecording で読める）
    writeCapture: async webm => {
      (globalThis as {__lastCapture?: Uint8Array}).__lastCapture = webm;
      return '/rec/画面録画.webm';
    },
    writeRecording: async wav => {
      (globalThis as {__lastRecording?: Uint8Array}).__lastRecording = wav;
      return '/rec/録音.wav';
    },
    libraryList: async () => [...mockLibrary].sort((a, b) => b.addedMs - a.addedMs),
    libraryAdd: async (paths, folder) => {
      const out: LibraryItem[] = [];
      for (const path of paths) {
        const ext = path.split('.').pop()?.toLowerCase() ?? '';
        const kind = IMAGE_EXT.includes(ext) ? 'image' : ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'].includes(ext) ? 'audio' : MEDIA_EXT.includes(ext) ? 'video' : null;
        if (!kind) continue;
        const had = mockLibrary.find(i => i.hash === path);
        if (had) {
          out.push(had);
          continue;
        }
        const it: LibraryItem = {
          id: `lib${mockLibrary.length + 1}`,
          name: (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, ''),
          kind,
          folder,
          path,
          hash: path,
          addedMs: Date.now() + mockLibrary.length,
        };
        mockLibrary.push(it);
        out.push(it);
      }
      return out;
    },
    libraryUpdate: async (id, patch) => {
      const it = mockLibrary.find(i => i.id === id);
      if (it && patch.name?.trim()) it.name = patch.name.trim();
      if (it && patch.folder !== undefined) it.folder = patch.folder.trim();
    },
    libraryRemove: async id => {
      const i = mockLibrary.findIndex(x => x.id === id);
      if (i >= 0) mockLibrary.splice(i, 1);
    },
    writePortraitPng: async (name, png) => {
      mockPngs.set(name, png);
      return `/mock-cache/${name}.png`;
    },
    portraitPngPath: async name => (mockPngs.has(name) ? `/mock-cache/${name}.png` : null),
    launchEngine: async engine => {
      const m = (globalThis as {__mockLaunch?: (e: EngineId) => boolean}).__mockLaunch;
      return m ? m(engine) : false;
    },
    collectMedia: async project => ({project, copied: 0, dir: '素材'}),
    pickRelink: async () => (globalThis as {__mockRelink?: string}).__mockRelink ?? null,
    probeMedia: async path =>
      path.endsWith('.mp4')
        ? {kind: 'video', hasAudio: true, durationMs: 4000, width: 640, height: 360}
        : path.endsWith('.wav')
          ? {kind: 'audio', hasAudio: true, durationMs: 500, width: null, height: null}
          : {kind: 'image', hasAudio: false, durationMs: null, width: 400, height: 600},
    mediaUrl: path => path,
    allowPaths: async () => {},
    makeSfx: async name => `/sfx/${name}.wav`,
    // ブラウザで確かめる用：見本のプラグインだけ
    listPlugins: async () => ({
      dir: '/plugins',
      plugins: [
        {
          file: '見本.json',
          plugin: {
            name: '見本',
            effects: [
              {
                id: 'sample-hue',
                label: '色相をずらす（見本）',
                params: [{key: 'deg', label: '角度', min: -180, max: 180, step: 1, default: 90}],
                ffmpeg: 'hue=h={deg}',
                canvas: 'hue-rotate({deg}deg)',
              },
            ],
          },
          error: null,
        },
      ],
    }),
    detectScenes: async () => (globalThis as {__mockScenes?: number[]}).__mockScenes ?? [1, 2.5],
    detectSilence: async () => (globalThis as {__mockSilence?: [number, number][]}).__mockSilence ?? [[1, 2]],
    pickLutPath: async () => (globalThis as {__mockLut?: string}).__mockLut ?? null,
    // 試験用：R と G を入れ替える LUT
    lutFit: async path => {
      if (!path.endsWith('.cube')) throw new Error('LUT を読めません');
      const id = Array.from({length: 17}, (_, i) => i / 16);
      return {matrix: [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0], tables: [id, id, id]};
    },
    pickTemplatePath: async mode => (mode === 'save' ? '/tmp/t.voxtpl' : (globalThis as {__mockTemplateFile?: string}).__mockTemplateFile ? '/tmp/t.voxtpl' : null),
    writeTextFile: async (_path, text) => {
      (globalThis as {__mockTemplateFile?: string}).__mockTemplateFile = text;
    },
    readTextFile: async () => (globalThis as {__mockTemplateFile?: string}).__mockTemplateFile ?? '',
    processAudio: async src => {
      await sleep(50);
      (globalThis as {__lastProcessed?: string}).__lastProcessed = src;
      return src;
    },
    measureAudio: async () => ({meanDb: -30, maxDb: -6, gainDb: 5}),
    detectBeats: async () => (globalThis as {__mockBeats?: number[]}).__mockBeats ?? [0.5, 1, 1.5, 2],
    modelStatus: async () => mockModels.map(m => ({...m})),
    downloadModel: async id => {
      for (let i = 1; i <= 5; i++) {
        await sleep(60);
        aiListeners.forEach(cb => cb({stage: 'download', id, ratio: i / 5}));
      }
      const m = mockModels.find(x => x.id === id);
      if (m) m.ready = true;
    },
    transcribe: async (src, _p, model, inS, dur) => {
      if (!mockModels.find(x => x.id === model)?.ready) throw new Error('モデルがまだダウンロードされていません');
      for (let i = 1; i <= 4; i++) {
        await sleep(40);
        aiListeners.forEach(cb => cb({stage: 'transcribe', id: src, ratio: i / 4}));
      }
      const all = (globalThis as {__mockSegments?: Segment[]}).__mockSegments ?? [
        {start: 0.5, end: 1.5, text: 'こんにちは'},
        {start: 2, end: 3.2, text: '今日はいい天気ですね'},
      ];
      return all.filter(s => s.end > inS && s.start < inS + dur);
    },
    makeMatte: async (src, _p, model) => {
      if (!mockModels.find(x => x.id === model)?.ready) throw new Error('モデルがまだダウンロードされていません');
      aiListeners.forEach(cb => cb({stage: 'matte', id: src, ratio: 1}));
      // 左半分が白い型
      const c = document.createElement('canvas');
      ((c.width = 64), (c.height = 36));
      const g = c.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, 64, 36);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 32, 36);
      return c.toDataURL('image/png');
    },
    // 試験用：追う点は 1 秒に横へ 0.1 ずつ動く
    trackMotion: async (src, _p, from, to, x, y) => {
      aiListeners.forEach(cb => cb({stage: 'track', id: src, ratio: 1}));
      const n = Math.max(2, Math.round((to - from) * 15) + 1);
      return Array.from({length: n}, (_, i) => ({t: from + i / 15, x: x + (0.1 * i) / 15, y, score: 1}));
    },
    // 試験用：被写体が 0 秒で左（0.3）から 4 秒で右（0.7）へ動く
    subjectTrack: async (_src, _p, model) => {
      if (!mockModels.find(x => x.id === model)?.ready) throw new Error('モデルがまだダウンロードされていません');
      return Array.from({length: 17}, (_, i) => ({t: i / 4, x: 0.3 + (0.4 * i) / 16, y: 0.5}));
    },
    onAiProgress: async cb => {
      aiListeners.add(cb);
      return () => aiListeners.delete(cb);
    },
    makeProxy: async src => {
      for (let i = 1; i <= 10; i++) {
        await sleep(80);
        proxyListeners.forEach(cb => cb({src, ratio: i / 10}));
      }
      return src;
    },
    onProxyProgress: async cb => {
      proxyListeners.add(cb);
      return () => proxyListeners.delete(cb);
    },
    videoEncoders: async () => ['x264', 'nvenc'],
    addRecent: async path => (config.recent = [path, ...config.recent.filter(p => p !== path)].slice(0, 10)),
    removeRecent: async path => (config.recent = config.recent.filter(p => p !== path)),
    setDictionary: async entries => {
      config = {...config, dictionary: entries};
    },
    autosaveWrite: async (project, projectPath) => {
      autosave = {project, projectPath, savedAt: Date.now()};
    },
    autosaveRead: async () => autosave,
    autosaveClear: async () => {
      autosave = null;
    },
    pickCharacterPath: async (mode, suggested) => (mode === 'save' ? `${suggested ?? 'キャラクター'}.voxchar` : ([...savedChars.keys()].at(-1) ?? null)),
    exportCharacter: async (path, character) => {
      savedChars.set(path, structuredClone(character));
    },
    importCharacter: async path => {
      const c = savedChars.get(path);
      if (!c) throw new Error('VoxCut のキャラクターファイルではありません');
      return structuredClone(c);
    },
  };
}

// 模擬のときだけ使う（ブラウザの「ページを離れますか」用）
let getStateDirty = () => false;
export const setDirtyGetter = (f: () => boolean) => {
  getStateDirty = f;
};

export const api: Promise<Api> = isTauri ? tauriApi() : Promise.resolve(mockApi());
