// Rust（src-tauri/src/commands.rs）との窓口。
// ブラウザで開いたとき（Tauri 外）は、デザイン確認用の模擬実装に切り替わる。

import type {AccentPhrase, Character, EngineId, EngineStatus, Project, VoiceClip, VoiceInfo} from './model';
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
  };
  ffmpegPath: string | null;
  dictionary: DictEntry[];
  recent: string[];
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type Unlisten = () => void;

export interface Api {
  newProject(): Promise<Project>;
  openProject(path: string): Promise<Project>;
  saveProject(path: string, project: Project): Promise<void>;
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
  pickSavePath(kind: 'project' | 'video', suggested: string): Promise<string | null>;
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
  makeProxy(src: string, projectPath: string | null, durationMs: number): Promise<string>;
  onProxyProgress(cb: (p: {src: string; ratio: number}) => void): Promise<Unlisten>;
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
  /** キャッシュにある PSD 立ち絵の画像のパス（無ければ null） */
  portraitPngPath(name: string): Promise<string | null>;
}

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
    newProject: () => invoke('new_project'),
    openProject: path => invoke('open_project', {path}),
    saveProject: (path, project) => invoke('save_project', {path, project}),
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
        const base = kind === 'video' ? (lastSaveDir.video ?? (await path.videoDir())) : (lastSaveDir.project ?? (await path.documentDir()));
        defaultPath = await path.join(base, suggested);
      }
      const r = await dialog.save({
        defaultPath,
        filters: kind === 'project' ? [{name: 'VoxCut', extensions: ['voxcut']}] : [{name: 'MP4', extensions: ['mp4']}],
      });
      if (r) lastSaveDir[kind] = r.replace(/[\\/][^\\/]*$/, '');
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
    portraitPngPath: name => invoke<string | null>('portrait_png_path', {name}),
    probeMedia: (path, projectPath) => invoke('probe_media', {path: resolvePath(path, projectPath ?? null)}),
    mediaUrl: (path, projectPath) => convertFileSrc(resolvePath(path, projectPath)),
    allowPaths: paths => invoke('allow_paths', {paths}),
    makeProxy: async (src, projectPath, durationMs) => convertFileSrc(await invoke<string>('make_proxy', {src: resolvePath(src, projectPath), durationMs})),
    onProxyProgress: cb => listen<{src: string; ratio: number}>('proxy-progress', e => cb(e.payload)),
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
};

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
    ['ch_a', '声は A.I.VOICE、VOICEPEAK、VoiSona Talk から選べます。'],
  ];
  return {
    version: 4,
    name: 'サンプル',
    video: {width: 1920, height: 1080, fps: 30, sampleRate: 48000, background: '#000000'},
    characters: [
      {
        id: 'ch_a',
        name: 'ナレーター',
        color: '#0A84FF',
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
      await sleep(120);
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
    newProject: async () => mockProject(),
    openProject: async () => mockProject(),
    saveProject: async () => {},
    getConfig: async () => config,
    setConfig: async c => {
      config = c;
    },
    engineStatus: async () => [
      {engine: 'aivoice', status: {state: 'ready', version: '1.4.0'}},
      {engine: 'voicepeak', status: {state: 'ready', version: null}},
      {engine: 'voisona', status: {state: 'notRunning', detail: 'VoiSona Talk を起動し、API を有効にしてください'}},
      {engine: 'voicevox', status: {state: 'ready', version: '0.99.0'}},
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
    exportVideo: async project => {
      cancelled = false;
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
    fileStamp: async () => 'mock',
    writePortraitPng: async (name, png) => {
      mockPngs.set(name, png);
      return `/mock-cache/${name}.png`;
    },
    portraitPngPath: async name => (mockPngs.has(name) ? `/mock-cache/${name}.png` : null),
    probeMedia: async path =>
      path.endsWith('.mp4') ? {kind: 'video', hasAudio: true, durationMs: 4000, width: 640, height: 360} : {kind: 'image', hasAudio: false, durationMs: null, width: 400, height: 600},
    mediaUrl: path => path,
    allowPaths: async () => {},
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
