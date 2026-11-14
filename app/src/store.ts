// アプリの状態。外部ライブラリを使わず useSyncExternalStore で購読する（再描画は購読した値が変わった部品だけ）。
// 元に戻す／やり直しは Project のスナップショットで持つ（不変更新なので共有部分はコピーされない）。

import {useSyncExternalStore} from 'react';
import type {
  LineAudio,
  CaptionClip,
  Character,
  PortraitClip,
  Clip,
  EngineId,
  EngineStatus,
  MediaClip,
  Portrait,
  Project,
  ShapeKind,
  Track,
  VoiceClip,
  VoiceInfo,
  VoiceParams,
  VoicePreset,
} from './model';
import type {DictEntry, MediaInfo} from './ipc';
import {
  isPlainLineAudio,
  plainLineAudio,
  startOffsetOf,
  audioTracks,
  captionLayerFor,
  charactersOnTrack,
  isLineTrack,
  defaultParams,
  effectiveVoice,
  isSeparatedVoice,
  freeOver,
  keepLinks,
  newId,
  newLayer,
  plainLook,
  projectDuration,
  reflowAll,
  synthKey,
  trackCode,
  trackKindOf,
  videoTracks,
  voiceLayerFor,
} from './model';

export type InputMode = 'normal' | 'append' | 'join';
const INPUT_MODE_KEY = 'voxcut.inputMode';
function loadInputMode(): InputMode {
  try {
    const v = localStorage.getItem(INPUT_MODE_KEY);
    return v === 'normal' || v === 'join' ? v : 'append';
  } catch {
    return 'append';
  }
}
export function setInputMode(m: InputMode) {
  try {
    localStorage.setItem(INPUT_MODE_KEY, m);
  } catch {
    // 保存できなくても、この起動中は使える
  }
  setState({inputMode: m});
}

export interface State {
  project: Project | null;
  projectPath: string | null;
  dirty: boolean;
  selectedClipId: string | null;
  selectedCharacterId: string | null;
  playhead: number; // フレーム
  isPlaying: boolean;
  /** 再生の速さと向き（1・2・4、逆再生は負） */
  playRate: number;
  /** 終わりまで来たら先頭から繰り返す */
  loop: boolean;
  /** プレビューの表示倍率（'fit' は枠に合わせる） */
  previewZoom: 'fit' | number;
  /** プレビューの画質（描く解像度の割合。下げると軽くなる。書き出しには影響しない） */
  previewQuality: 1 | 0.5 | 0.25;
  /** セーフエリアの枠を出す */
  showSafeArea: boolean;
  /** プレビューを全画面で出しているか */
  previewFull: boolean;
  zoom: number; // 1 フレームあたりのピクセル
  engines: {engine: EngineId; status: EngineStatus}[];
  /** 接続を確認し直している最中 */
  checkingEngines: boolean;
  voices: Partial<Record<EngineId, VoiceInfo[]>>;
  busy: null | {label: string; ratio: number | null};
  /** 素材の情報（ffprobe の結果。プロジェクトには保存しない） */
  media: Record<string, MediaInfo>;
  /** 動画プロキシの状態（src ごと） */
  proxies: Record<string, {ratio: number; url: string | null; error?: string}>;
  /** 合成に失敗したセリフ（clipId → 理由）。次に成功したら消える */
  synthErrors: Record<string, string>;
  /** 右パネルのキャラクター設定で開いているタブ */
  inspectorTab: 'voice' | 'subtitle' | 'portrait';
  /** 左パネルの表示 */
  /** タイムラインに選択を見せる（スクロールする）よう頼む合図。値が変わるたびに追従する */
  revealSeq: number;
  /** セリフ入力欄の追加モード（YMM4 と同じ）：通常＝再生位置に入れるだけ／追記＝入れた後その末尾へ進む／連結＝同じトラックの直前のセリフを延ばしてつなぐ */
  inputMode: InputMode;
  /** セリフ入力欄で選んでいる声のプリセット（キャラクター ID → プリセット ID。null は通常）。キャラクターを切り替えても覚えておく */
  inputPresets: Record<string, string | null>;
  /** 設定画面を開いているか（左パネルの「場所を選ぶ」からも開く） */
  settingsOpen: boolean;
  /** 最近使ったプロジェクト */
  recent: string[];
  /** 台本の貼り付け画面・辞書の画面を開いているか */
  pasteOpen: boolean;
  workspaceDialogOpen: boolean;
  /** キャラクター設定ウィンドウ（YMM4 の「キャラクターの編集」） */
  characterDialogOpen: boolean;
  /** キャラクター設定ウィンドウで選んでいるキャラクター（セリフ入力欄の話し手とは別） */
  dialogCharacterId: string | null;
  /** 写したクリップの数（貼り付けを押せるか） */
  clipboardCount: number;
  /** 台本の貼り付け画面に最初に入れておく文（セリフ入力欄に複数行を貼ったとき） */
  pasteText: string;
  dictionaryOpen: boolean;
  /** キーボードショートカットの一覧を開いているか */
  shortcutsOpen: boolean;
  /** ファイルをドラッグして画面の上にいるか */
  dropActive: boolean;
  /** 複数選択しているクリップ（selectedClipId も含む） */
  selectedClipIds: string[];
  /** リンクしたクリップをまとめて選ぶ（Premiere Pro の「リンクされた選択」）。Alt+クリックで 1 つだけ選べる */
  linkedSelection: boolean;
  /** 読み方の辞書 */
  dictionary: DictEntry[];
  past: Project[];
  future: Project[];
}

let state: State = {
  project: null,
  projectPath: null,
  dirty: false,
  selectedClipId: null,
  selectedCharacterId: null,
  playhead: 0,
  isPlaying: false,
  playRate: 1,
  loop: false,
  previewZoom: 'fit',
  previewQuality: 1,
  showSafeArea: false,
  previewFull: false,
  zoom: 4,
  engines: [],
  checkingEngines: false,
  voices: {},
  busy: null,
  media: {},
  proxies: {},
  synthErrors: {},
  inspectorTab: 'voice',
  revealSeq: 0,
  inputMode: loadInputMode(),
  inputPresets: {},
  settingsOpen: false,
  recent: [],
  pasteOpen: false,
  workspaceDialogOpen: false,
  characterDialogOpen: false,
  dialogCharacterId: null,
  clipboardCount: 0,
  pasteText: '',
  dictionaryOpen: false,
  shortcutsOpen: false,
  dropActive: false,
  selectedClipIds: [],
  linkedSelection: true,
  dictionary: [],
  past: [],
  future: [],
};

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  // 1 つだけ選んだときは、複数選択もその 1 つ（リンクされた選択なら、リンクしたクリップも）にする
  if ('selectedClipId' in p && !('selectedClipIds' in p)) p.selectedClipIds = p.selectedClipId ? withLinked([p.selectedClipId], p.project ?? state.project) : [];
  state = {...state, ...p};
  if (remote && !applyingRemote) remote.set(p);
  listeners.forEach(l => l());
}

// ───────────── 別ウィンドウとの共有（sync.ts） ─────────────

/**
 * 切り離したパネルのウィンドウ（ゲスト）では、変更をメインウィンドウ（ホスト）へ送り、
 * 元に戻す履歴や再生はホストが持つ。ホストでは null
 */
export interface Remote {
  set(patch: Partial<State>): void;
  commit(project: Project, mergeKey?: string): void;
  call(name: string, args: unknown[]): void;
}
let remote: Remote | null = null;
let applyingRemote = false;
export function setRemote(r: Remote | null) {
  remote = r;
}
export const isGuest = () => remote !== null;
/** 相手から届いた変更を当てる（ゲストでは送り返さない） */
export function applyRemote(patch: Partial<State>) {
  applyingRemote = true;
  try {
    setState(patch);
  } finally {
    applyingRemote = false;
  }
}
/** ゲストなら、ホストで name を呼んでもらって true を返す（再生・元に戻すなど） */
export function callRemote(name: string, args: unknown[] = []): boolean {
  if (!remote) return false;
  remote.call(name, args);
  return true;
}
export function subscribeStore(l: () => void) {
  return subscribe(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/** リンクしたクリップも足す（リンクされた選択が有効なとき） */
function withLinked(ids: string[], p: Project | null): string[] {
  if (!p || !state.linkedSelection) return ids;
  const links = new Set(p.clips.filter(c => ids.includes(c.id) && c.linkId).map(c => c.linkId));
  if (!links.size) return ids;
  return [...new Set([...ids, ...p.clips.filter(c => c.linkId && links.has(c.linkId)).map(c => c.id)])];
}

export function setLinkedSelection(on: boolean) {
  setState(s => ({linkedSelection: on, selectedClipIds: on ? withLinked(s.selectedClipIds, s.project) : s.selectedClipId ? [s.selectedClipId] : []}));
}

const HISTORY_LIMIT = 100;

let lastMerge: {key: string; at: number} | null = null;

/**
 * 履歴に残る変更。`mergeKey` が直前と同じで 1 秒以内なら、1 つの履歴にまとめる
 * （文字入力やスライダー操作で履歴が 1 文字ずつ積まれないように）。
 */
export function commit(update: (p: Project) => Project, mergeKey?: string) {
  if (remote) {
    // ゲスト：すぐ手元に当てて、履歴はホストで積む
    if (!state.project) return;
    const next = keepLinks(state.project, update(state.project));
    if (next === state.project) return;
    applyRemote({project: next, dirty: true});
    remote.commit(next, mergeKey);
    return;
  }
  setState(s => {
    if (!s.project) return {};
    const next = keepLinks(s.project, update(s.project));
    if (next === s.project) return {};
    const now = performance.now();
    const merge = mergeKey && lastMerge?.key === mergeKey && now - lastMerge.at < 1000 && s.past.length > 0;
    lastMerge = mergeKey ? {key: mergeKey, at: now} : null;
    if (merge) return {project: next, dirty: true, future: []};
    return {project: next, dirty: true, past: [...s.past.slice(-HISTORY_LIMIT + 1), s.project], future: []};
  });
}

/** 履歴に残さない置き換え（合成結果の反映など） */
export function replaceProject(p: Project, opts: {dirty?: boolean} = {}) {
  const next = state.project ? keepLinks(state.project, p) : p;
  // 追記モードで入れたセリフの長さが合成で変わったら、再生位置もその末尾へ付いていく（次のセリフは末尾に続く）
  const anchor = appendAnchor;
  const c = anchor && state.playhead === anchor.playhead ? next.clips.find(x => x.id === anchor.clipId) : undefined;
  if (anchor && c && c.start + c.duration !== anchor.playhead) {
    appendAnchor = {clipId: anchor.clipId, playhead: c.start + c.duration};
    setState({project: next, dirty: opts.dirty ?? true, playhead: c.start + c.duration});
    return;
  }
  setState({project: next, dirty: opts.dirty ?? true});
}

export function undo() {
  if (callRemote('undo')) return;
  setState(s => {
    const prev = s.past.at(-1);
    if (!prev || !s.project) return {};
    return {project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], dirty: true};
  });
}

export function redo() {
  if (callRemote('redo')) return;
  setState(s => {
    const [next, ...rest] = s.future;
    if (!next || !s.project) return {};
    return {project: next, future: rest, past: [...s.past, s.project], dirty: true};
  });
}

// ───────────── 編集操作 ─────────────

/**
 * 声が変わったセリフだけ「未合成」に戻す。音量だけの変更は合成し直さない（再生・書き出しで掛ける）。
 * before → after で、同じ id の行の実際の声（キャラクター・プリセット・行の調声を重ねたもの）を比べる
 */
function invalidateChangedVoices(before: Project, after: Project): Project {
  const key = (p: Project, c: VoiceClip) => {
    const ch = p.characters.find(x => x.id === c.characterId);
    return ch ? synthKey(effectiveVoice(ch, c)) : '';
  };
  const old = new Map(before.clips.filter((c): c is VoiceClip => c.type === 'voice').map(c => [c.id, c]));
  let changed = false;
  const clips = after.clips.map(c => {
    if (c.type !== 'voice' || !c.audio) return c;
    const o = old.get(c.id);
    if (!o || o.text !== c.text || key(before, o) !== key(after, c)) {
      if (o && o.text === c.text && o.audio !== c.audio) return c; // 合成結果そのものを入れた更新
      changed = true;
      return {...c, audio: null};
    }
    return c;
  });
  return changed ? {...after, clips} : after;
}

export function updateClip(id: string, patch: Partial<VoiceClip> | Partial<Clip>) {
  const key = `clip:${id}:${Object.keys(patch).sort().join(',')}`;
  commit(p => {
    let next = {...p, clips: p.clips.map(c => (c.id === id ? ({...c, ...patch} as Clip) : c))};
    // キャラクターを変えたら、前のキャラクターのプリセットは使えない
    if ('characterId' in patch) next = {...next, clips: next.clips.map(c => (c.id === id && c.type === 'voice' && 'presetId' in c && !('presetId' in patch) ? {...c, presetId: null} : c))};
    return 'audio' in patch ? next : invalidateChangedVoices(p, next);
  }, key);
}

export function updateCharacter(id: string, patch: Partial<Character>) {
  const key = `char:${id}:${Object.keys(patch).sort().join(',')}`;
  commit(p => invalidateChangedVoices(p, {...p, characters: p.characters.map(c => (c.id === id ? {...c, ...patch} : c))}), key);
}

// ---- 声のプリセット ----

/** プリセットを足して id を返す。clipId を渡すと、その行をこのプリセットに切り替える（行だけの調声は外す） */
export function addVoicePreset(characterId: string, preset: Omit<VoicePreset, 'id'>, clipId?: string): string {
  const id = newId('vp');
  commit(p => {
    const next: Project = {
      ...p,
      characters: p.characters.map(c => (c.id === characterId ? {...c, voicePresets: [...(c.voicePresets ?? []), {...preset, id}]} : c)),
      clips: clipId ? p.clips.map(c => (c.id === clipId && c.type === 'voice' ? {...c, presetId: id, paramsOverride: null, speakerOverride: null} : c)) : p.clips,
    };
    return invalidateChangedVoices(p, next);
  });
  return id;
}

export function updateVoicePreset(characterId: string, presetId: string, patch: Partial<Omit<VoicePreset, 'id'>>) {
  commit(
    p =>
      invalidateChangedVoices(p, {
        ...p,
        characters: p.characters.map(c => (c.id === characterId ? {...c, voicePresets: (c.voicePresets ?? []).map(x => (x.id === presetId ? {...x, ...patch} : x))} : c)),
      }),
    `preset:${presetId}:${Object.keys(patch).sort().join(',')}`,
  );
}

/** プリセットを消す。使っていた行はキャラクターの声に戻る */
export function removeVoicePreset(characterId: string, presetId: string) {
  commit(p =>
    invalidateChangedVoices(p, {
      ...p,
      characters: p.characters.map(c => (c.id === characterId ? {...c, voicePresets: (c.voicePresets ?? []).filter(x => x.id !== presetId)} : c)),
      clips: p.clips.map(c => (c.type === 'voice' && c.presetId === presetId ? {...c, presetId: null} : c)),
    }),
  );
}

/** 選んでいるセリフのプリセットをまとめて変える（null でキャラクターの声）。キャラクターが違う行は飛ばす */
export function setPresetForSelection(characterId: string, presetId: string | null) {
  const ids = new Set(
    editableSelection()
      .filter(c => c.type === 'voice' && c.characterId === characterId)
      .map(c => c.id),
  );
  if (!ids.size) return 0;
  commit(p => invalidateChangedVoices(p, {...p, clips: p.clips.map(c => (ids.has(c.id) && c.type === 'voice' ? {...c, presetId, paramsOverride: null} : c))}));
  return ids.size;
}

export function presetParams(params: VoiceParams): VoiceParams {
  return {...params, emotions: {...params.emotions}, extra: {...(params.extra ?? {})}};
}

export function addCharacter(): string {
  const id = newId('ch');
  const palette = ['#0A84FF', '#FF9F0A', '#30D158', '#BF5AF2', '#FF375F', '#40C8E0'];
  commit(p => {
    const base = p.characters[0];
    const ch: Character = {
      id,
      name: `キャラクター ${p.characters.length + 1}`,
      color: palette[p.characters.length % palette.length],
      voice: base ? {...base.voice, params: {...base.voice.params}} : {engine: 'voicepeak', speaker: '', params: defaultParams()},
      subtitle: base ? {...base.subtitle} : {fontFamily: 'Yu Gothic UI', fontSize: 56, color: '#FFFFFF', outlineColor: '#000000', outlineWidth: 4, position: 'bottom', marginV: 60, animation: 'none'},
      portrait: null,
      // 新しいキャラクターは、ほかのキャラクターのトラックの次のトラックへ（YMM4 と同じく 1 人 1 トラック）
      layer: Math.max(0, ...p.characters.map(c => (c.layer ? c.layer : captionLayerFor(p, c.id) + 1))) + 1,
      audioLayer: Math.max(0, ...p.characters.map(c => (c.audioLayer ? c.audioLayer : voiceLayerFor(p, c.id) + 1))) + 1,
    };
    return {...p, characters: [...p.characters, ch]};
  });
  setState({selectedCharacterId: id, selectedClipId: null});
  return id;
}

/** 読み込んだキャラクターを足す（ID は新しく、名前が重なれば番号を付ける） */
export function addCharacterFrom(ch: Character): string {
  const id = newId('ch');
  commit(p => {
    let name = ch.name;
    for (let n = 2; p.characters.some(c => c.name === name); n++) name = `${ch.name} ${n}`;
    return {...p, characters: [...p.characters, {...ch, id, name}]};
  });
  setState({selectedCharacterId: id, selectedClipId: null});
  return id;
}

/** キャラクターを消す（そのキャラクターのセリフも消える。元に戻すで戻せる）。最後の 1 人は消せない */
/**
 * 感情ごとに分けて作ったキャラクター（例「茜_怒り」）を、ほかのキャラクター（例「茜_通常」）の声のプリセットにまとめる。
 * - その声（声の種類・パラメータ）を、name のプリセットとして to に足す（from のプリセットも to へ移す）
 * - from のセリフ・立ち絵アイテムは to のものになり、まとめたプリセットを使う
 * - from は消える。元に戻すで戻せる。音声合成ソフトが違うとまとめられない（false を返す）
 */
export function mergeCharacterAsPreset(fromId: string, toId: string, name: string): boolean {
  const p0 = state.project;
  const from = p0?.characters.find(c => c.id === fromId);
  const to = p0?.characters.find(c => c.id === toId);
  if (!p0 || !from || !to || from.id === to.id || from.voice.engine !== to.voice.engine) return false;
  const presetId = newId('vp');
  const moved = (from.voicePresets ?? []).map(x => ({...x, name: `${name}・${x.name}`}));
  const own = new Set(moved.map(x => x.id));
  commit(p => {
    const preset: VoicePreset = {id: presetId, name: name.trim() || from.name, speaker: from.voice.speaker !== to.voice.speaker ? from.voice.speaker : null, params: {...from.voice.params}};
    const next: Project = {
      ...p,
      characters: p.characters.filter(c => c.id !== from.id).map(c => (c.id === to.id ? {...c, voicePresets: [...(c.voicePresets ?? []), preset, ...moved]} : c)),
      clips: p.clips.map(c =>
        c.type === 'voice' && c.characterId === from.id
          ? {...c, characterId: to.id, presetId: c.presetId && own.has(c.presetId) ? c.presetId : presetId}
          : c.type === 'portrait' && c.characterId === from.id
            ? {...c, characterId: to.id}
            : c,
      ),
    };
    return invalidateChangedVoices(p, next);
  });
  setState(s => ({
    selectedCharacterId: s.selectedCharacterId === fromId ? toId : s.selectedCharacterId,
    dialogCharacterId: s.dialogCharacterId === fromId ? toId : s.dialogCharacterId,
    inputPresets: {...s.inputPresets, [toId]: s.selectedCharacterId === fromId ? presetId : (s.inputPresets[toId] ?? null)},
  }));
  return true;
}

export function removeCharacter(id: string): boolean {
  const p = state.project;
  if (!p || p.characters.length <= 1) return false;
  commit(pr => {
    const gone = new Set(pr.clips.filter(c => c.type === 'voice' && c.characterId === id).map(c => c.id));
    const next = reflowAll(pr, gone);
    return {...next, characters: next.characters.filter(c => c.id !== id), clips: next.clips.filter(c => !gone.has(c.id))};
  });
  setState(s => ({selectedCharacterId: s.project?.characters[0]?.id ?? null, selectedClipId: null}));
  return true;
}

/**
 * 同じトラックのクリップが重ならないように後ろへ押し出す。
 * `pinnedId` のクリップは、同じ開始位置のクリップより前に置く（ドロップした場所に「挿入」する）。
 */
export function resolveOverlaps(p: Project, trackId: string, pinnedId?: string): Project {
  const onTrack = p.clips.filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start || (a.id === pinnedId ? -1 : b.id === pinnedId ? 1 : 0));
  const moved = new Map<string, number>();
  let prev: Clip | null = null;
  let prevStart = 0;
  for (const c of onTrack) {
    let start = c.start;
    if (prev) {
      const prevEnd = prevStart + prev.duration;
      if (start < prevEnd) start = prevEnd;
    }
    if (start !== c.start) moved.set(c.id, start);
    prev = c;
    prevStart = start;
  }
  if (!moved.size) return p;
  return {...p, clips: p.clips.map(c => (moved.has(c.id) ? {...c, start: moved.get(c.id)!} : c))};
}

/** time 以降に始まるアイテムを、全トラックで d だけ後ろへずらす（YMM4 の「後ろのアイテムを移動」） */
function rippleFrom(p: Project, time: number, d: number): Project {
  if (d <= 0) return p;
  // ロックしたトラックは動かさない（Premiere Pro と同じく挿入・リップルの対象外）
  const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
  let skipped = false;
  const clips = p.clips.map(c => {
    if (locked.has(c.trackId)) {
      if (c.start >= time) skipped = true;
      return c;
    }
    // 入れる所にまたがっている（か、ちょうどそこから始まる）立ち絵アイテムは、入れた分だけ伸ばす（キャラクターが消えないように）
    if (c.type === 'portrait' && c.start <= time && time < c.start + c.duration) return {...c, duration: c.duration + d};
    return c.start >= time ? {...c, start: c.start + d} : c;
  });
  if (skipped) void import('./actions').then(m => m.getNotify()('ロックしたレイヤーのアイテムは動かしていません', 'info'));
  return {...p, clips};
}

/**
 * 挿入（Ctrl を押しながら落とす）：pinned を start に固定し、そのトラックで start より後ろにかかるアイテムを、
 * 間を保ったまま、pinned の後ろへまとめてずらす（Premiere Pro の挿入と同じ。落とした位置からずれない）
 */
function insertAt(p: Project, trackId: string, pinnedId: string): Project {
  const pin = p.clips.find(c => c.id === pinnedId);
  if (!pin) return p;
  const end = pin.start + pin.duration;
  const after = p.clips.filter(c => c.trackId === trackId && c.id !== pinnedId && c.start + c.duration > pin.start).sort((a, b) => a.start - b.start);
  if (!after.length || after[0].start >= end) return p;
  const shift = end - after[0].start;
  const ids = new Set(after.map(c => c.id));
  return {...p, clips: p.clips.map(c => (ids.has(c.id) ? {...c, start: c.start + shift} : c))};
}

/** 追記モードで最後に入れたセリフと、そのとき進めた再生位置（再生位置を動かしていなければ、そのセリフの今の末尾に続ける） */
let appendAnchor: {clipId: string; playhead: number} | null = null;

/** セリフを入れる時刻。追記の続きなら直前に入れたセリフの今の末尾（合成で長さが変わっていても続く） */
function insertTime(p: Project): number {
  if (appendAnchor && state.playhead === appendAnchor.playhead) {
    const c = p.clips.find(x => x.id === appendAnchor!.clipId);
    if (c) return c.start + c.duration;
  }
  return state.playhead;
}

/** レイヤーを n 本まで増やす（一番手前に足す） */
function ensureTracks(p: Project, _kind: 'video' | 'audio', n: number): Project {
  if (p.tracks.length >= n) return p;
  const add = Array.from({length: n - p.tracks.length}, () => newLayer(newId('V')));
  return {...p, tracks: [...p.tracks, ...add]};
}

/** キャラクターのセリフを置く音声トラックと、字幕を置く映像トラックを用意して（足りなければ増やして）その id を返す */
function layerFor(p: Project, characterId: string): {p: Project; trackId: string} {
  // セリフ（字幕と声の 1 つのクリップ）を置く映像トラック
  const ch = p.characters.find(c => c.id === characterId);
  p = ensureTracks(p, 'video', Math.max(1, ch?.layer ?? 1));
  return {p, trackId: videoTracks(p)[captionLayerFor(p, characterId)].id};
}

/** セリフ入力欄で Enter したときに入る時刻（入力欄の案内に出す。addLine と同じ決め方） */
export function lineInsertPoint(characterId: string): number {
  const p0 = state.project;
  if (!p0) return 0;
  const {p, trackId} = layerFor(p0, characterId);
  let start = insertTime(p);
  if (state.inputMode === 'join') {
    const prev = p.clips.filter(c => c.type === 'voice' && c.trackId === trackId && c.start < start).sort((a, b) => b.start + b.duration - (a.start + a.duration))[0];
    if (prev && prev.start + prev.duration >= start) start = prev.start + prev.duration;
    return start;
  }
  const cover = p.clips.find(c => c.trackId === trackId && c.start < start && start < c.start + c.duration);
  return cover ? cover.start + cover.duration : start;
}

const provisional = (p: Project, text: string) => Math.max(30, Math.round([...text].length * 0.12 * p.video.fps)); // 合成前の仮の長さ

function newVoiceClip(p: Project, id: string, trackId: string, start: number, characterId: string, text: string, presetId: string | null = null): VoiceClip {
  const ch = p.characters.find(c => c.id === characterId);
  const gap = ch?.gapAfter ?? 6;
  // 消えたプリセットは通常に
  const preset = presetId && ch?.voicePresets?.some(x => x.id === presetId) ? presetId : null;
  return {
    ...(preset ? {presetId: preset} : {}),
    id,
    trackId,
    start,
    duration: provisional(p, text) + gap,
    linkId: null,
    type: 'voice',
    characterId,
    text,
    subtitle: null,
    paramsOverride: null,
    audio: null,
    gapAfter: gap,
    lockDuration: false,
  };
}

/**
 * セリフを追加（YMM4 のセリフ入力欄と同じ）。キャラクターのトラックの再生位置に入れ、後ろのアイテムは押し出す。
 * 連結モードでは、同じトラックの直前のセリフの余韻を延ばして、すき間なくつなぐ
 */
export function addLine(characterId: string, text: string, presetId: string | null = null): string {
  const id = newId('c');
  const mode = state.inputMode;
  let placed: VoiceClip | null = null;
  commit(p0 => {
    const {p, trackId} = layerFor(p0, characterId);
    let start = insertTime(p);
    let clips = p.clips;
    if (mode === 'join') {
      const prev = p.clips.filter((c): c is VoiceClip => c.type === 'voice' && c.trackId === trackId && c.start < start).sort((a, b) => b.start + b.duration - (a.start + a.duration))[0];
      if (prev) {
        const end = prev.start + prev.duration;
        if (end < start) clips = clips.map(c => (c.id === prev.id && c.type === 'voice' ? {...c, gapAfter: c.gapAfter + (start - end), duration: c.duration + (start - end)} : c));
        else start = end;
      }
    }
    // 置くトラックで再生位置にアイテムがかかっていれば、その後ろへ（途中に割り込まない）
    if (mode !== 'join') {
      const cover = clips.find(c => c.trackId === trackId && c.start < start && start < c.start + c.duration);
      if (cover) start = cover.start + cover.duration;
    }
    const clip = newVoiceClip(p, id, trackId, start, characterId, text, presetId);
    // 入れた分だけ、後ろのアイテムを全トラックでずらす（YMM4 の「後ろのアイテムを移動」。掛け合いの順番を崩さない）
    const moved = rippleFrom({...p, clips}, start, clip.duration);
    const next = {...moved, clips: [...moved.clips, clip]};
    placed = clip;
    return next;
  });
  const c = placed as VoiceClip | null;
  if (c) {
    const end = c.start + c.duration;
    const seek = mode !== 'normal';
    appendAnchor = seek ? {clipId: id, playhead: end} : null;
    setState(s => ({selectedClipId: id, playhead: seek ? end : s.playhead, revealSeq: s.revealSeq + 1}));
  }
  return id;
}

/**
 * 何行もまとめて追加する（台本の読み込み・貼り付け。YMM4 の「タイムラインに追加」）。
 * 再生位置から時間順に、それぞれのキャラクターのトラックへ置く。入れた分だけ、そのトラックの後ろのアイテムを後ろへずらす。
 * 1 回の「元に戻す」で全部戻る。追加した行の ID を返す
 */
export function addLines(items: {characterId: string; text: string}[]): string[] {
  const ids: string[] = [];
  let end = 0;
  commit(p0 => {
    if (!items.length) return p0;
    let p = p0;
    let at = insertTime(p);
    // 最初の行のトラックで再生位置にアイテムがかかっていれば、その後ろから
    const firstTrack = layerFor(p, items[0].characterId).trackId;
    const cover = p.clips.find(c => c.trackId === firstTrack && c.start < at && at < c.start + c.duration);
    if (cover) at = cover.start + cover.duration;
    let t = at;
    const added: VoiceClip[] = [];
    for (const {characterId, text} of items) {
      const r = layerFor(p, characterId);
      p = r.p;
      const id = newId('c');
      ids.push(id);
      const c = newVoiceClip(p, id, r.trackId, t, characterId, text);
      added.push(c);
      t += c.duration;
    }
    end = t;
    // 入れた分だけ、後ろのアイテムを全トラックでずらす（掛け合いの順番を崩さない）
    const moved = rippleFrom(p, at, t - at);
    return {...moved, clips: [...moved.clips, ...added]};
  });
  if (ids.length) {
    appendAnchor = {clipId: ids.at(-1)!, playhead: end};
    setState(s => ({selectedClipId: ids.at(-1)!, playhead: end, revealSeq: s.revealSeq + 1}));
  }
  return ids;
}

/**
 * アイテムの長さを変え、同じトラックの後ろを動かす（直前のすぐ後ろにあったものは付いてくる、
 * 離して置いたものは重なるときだけ押し出す）
 */
function resizeKeepingChain(p: Project, id: string, duration: number, patch: Partial<VoiceClip> = {}): Project {
  const c = p.clips.find(x => x.id === id);
  if (!c) return p;
  const layer = p.clips.filter(x => x.trackId === c.trackId && x.start >= c.start && x.id !== id).sort((a, b) => a.start - b.start);
  let prev: [number, number] = [c.start + c.duration, c.start + duration];
  const moved = new Map<string, number>();
  for (const x of layer) {
    const oldEnd = x.start + x.duration;
    const start = x.start === prev[0] ? prev[1] : Math.max(x.start, prev[1]);
    if (start !== x.start) moved.set(x.id, start);
    prev = [oldEnd, start + x.duration];
  }
  return {...p, clips: p.clips.map(x => (x.id === id ? ({...x, ...patch, duration} as Clip) : moved.has(x.id) ? {...x, start: moved.get(x.id)!} : x))};
}

/** セリフ後の余韻（フレーム）を変える。セリフの長さも同じだけ変わり、後ろに続くアイテムも付いてくる */
export function setAftertime(id: string, frames: number) {
  commit(p => {
    const c = p.clips.find(x => x.id === id);
    if (!c || c.type !== 'voice') return p;
    const f = Math.max(0, Math.round(frames));
    const duration = c.lockDuration ? c.duration : Math.max(1, c.duration + (f - c.gapAfter));
    return resizeKeepingChain(p, id, duration, {gapAfter: f});
  }, `aftertime:${id}`);
}

/** セリフの声の聞こえ方を変える。再生開始位置を変えたら、長さもその分だけ変える（後ろに続く会話も付いてくる） */
export function setLineAudio(id: string, patch: Partial<LineAudio>) {
  commit(p => {
    const c = p.clips.find(x => x.id === id);
    if (!c || c.type !== 'voice') return p;
    const next: LineAudio = {...plainLineAudio(), ...(c.audioFx ?? {}), ...patch};
    if (next.startOffset !== undefined) next.startOffset = Math.max(0, Math.round(next.startOffset));
    const audioFx = isPlainLineAudio(next) ? null : next;
    const diff = startOffsetOf({...c, audioFx}) - startOffsetOf(c);
    if (!diff || c.lockDuration || !c.audio) return {...p, clips: p.clips.map(x => (x.id === id ? {...c, audioFx} : x))};
    return resizeKeepingChain(p, id, Math.max(1, c.duration - diff), {audioFx});
  }, `lineaudio:${id}`);
}

export function deleteClip(id: string) {
  deleteClips([id]);
}

/**
 * セリフを消したら、そのすぐ後ろに続く会話（どのトラックでも）をその分だけ前に詰める（ゆっくりムービーメーカーと同じ）。
 * 消したのが素材なら詰めない
 */
function rippleDelete(p: Project, del: Set<string>): Project {
  // 消すセリフを長さ 0 にして詰め直し（後ろに続く会話が、どのトラックでも前へ詰まる）、それから取り除く
  const voices = new Set(p.clips.filter(c => del.has(c.id) && c.type === 'voice').map(c => c.id));
  const packed = voices.size ? reflowAll(p, voices) : p;
  return {...packed, clips: packed.clips.filter(c => !del.has(c.id))};
}

/** 移動の結果：動かした／重なるので別のトラックへ置いた／置ける所が無く動かさなかった／挿入して後ろを押し出した */
export type MoveResult = {kind: 'moved' | 'relocated' | 'blocked'; trackId?: string} | {kind: 'inserted'; pushed: number};

/** 同じ種類で、ロックされていない、start〜end が空いているトラックを、want に近い順に探す */
function freeTrackNear(p: Project, kind: 'video' | 'audio', want: string, start: number, end: number, ignore: Set<string>): string | null {
  const list = kind === 'audio' ? audioTracks(p) : videoTracks(p);
  const at = Math.max(
    0,
    list.findIndex(t => t.id === want),
  );
  const order = list.map((t, i) => [t, Math.abs(i - at) * 2 + (i < at ? 1 : 0)] as const).sort((a, b) => a[1] - b[1]);
  return order.find(([t]) => !t.locked && freeOver(p, t.id, start, end, ignore))?.[0].id ?? null;
}

/** 動かしたときに位置が変わった（押し出された）ほかのクリップの数 */
const pushedCount = (before: Project, after: Project, except: Set<string>) => after.clips.filter(c => !except.has(c.id) && before.clips.find(x => x.id === c.id)?.start !== c.start).length;

/**
 * 移動（YMM4 と同じく、ほかのアイテムを押し出さない）。
 * - 同じ種類のトラックへだけ（映像 ↔ 映像、音声 ↔ 音声）
 * - 落とした所が空いていればそこへ。重なるなら、近くの空いているトラックへ。どこも空いていなければ動かさない
 * - insert（Ctrl を押しながら落とす）なら、そこに挿入して後ろを押し出す
 * リンクしているクリップは同じだけ動く（そちらが重なるなら動かさない）
 */
export function moveClip(id: string, start: number, trackId?: string, mergeKey?: string, opts: {insert?: boolean; solo?: boolean} = {}): MoveResult {
  let p = state.project;
  let c = p?.clips.find(x => x.id === id);
  if (!p || !c) return {kind: 'blocked'};
  // 片方だけを選んで動かした（Alt+クリック・リンクされた選択がオフ）：Premiere Pro と同じく、それだけを動かす。
  // 一緒に動かないよう、リンクは外す（知らせる）
  if (opts.solo && c.linkId) {
    const link = c.linkId;
    // リンクを外すのと動かすのを、1 回の「元に戻す」でまとめて戻せるように
    mergeKey ??= `solo:${id}:${Date.now()}`;
    commit(q => ({...q, clips: q.clips.map(x => (x.linkId === link ? {...x, linkId: null} : x))}), mergeKey);
    void import('./actions').then(m => m.getNotify()('リンクを外して、選んだものだけを動かしました（右クリックの「リンク」でつなぎ直せます）', 'info'));
    p = state.project!;
    c = p.clips.find(x => x.id === id)!;
  }
  const kind = trackKindOf(p, c);
  const want = trackId && p.tracks.some(t => t.id === trackId && !t.locked) ? trackId : c.trackId;
  const s = Math.max(0, Math.round(start));
  const delta = s - c.start;
  const partners = c.linkId ? p.clips.filter(x => x.linkId === c.linkId && x.id !== c.id) : [];
  const ignore = new Set([c.id, ...partners.map(x => x.id)]);
  const place = (tid: string) => (q: Project) => ({...q, clips: q.clips.map(x => (x.id === id ? {...x, start: s, trackId: tid} : x))});
  if (opts.insert) {
    let pushed = 0;
    commit(q => {
      let next = insertAt(place(want)(q), want, id);
      for (const x of partners) next = insertAt({...next, clips: next.clips.map(y => (y.id === x.id ? {...y, start: Math.max(0, x.start + delta)} : y))}, x.trackId, x.id);
      pushed = pushedCount(q, next, ignore);
      return next;
    }, mergeKey);
    return {kind: 'inserted', pushed};
  }
  const partnersFree = partners.every(x => freeOver(p, x.trackId, x.start + delta, x.start + delta + x.duration, ignore));
  if (!partnersFree) return {kind: 'blocked'};
  const tid = freeOver(p, want, s, s + c.duration, ignore) ? want : freeTrackNear(p, kind, want, s, s + c.duration, ignore);
  if (!tid) return {kind: 'blocked'};
  commit(place(tid), mergeKey);
  return {kind: tid === want ? 'moved' : 'relocated', trackId: tid};
}

/**
 * 端をドラッグして長さを変える。左端を動かした素材は、切り出し位置（inPoint）も同じだけずらす。
 * セリフの長さを手で変えたら、以後は音声長に合わせない（lockDuration）。前後のアイテムのところで止まる（押し出さない）。
 */
export function trimClip(id: string, start: number, duration: number) {
  commit(p => {
    // リンクした字幕の端を動かしたら、セリフの長さを変える（字幕はセリフに合わせて付いてくる）
    const cap = p.clips.find(c => c.id === id);
    if (cap?.type === 'caption') {
      const v = p.clips.find(c => c.id === cap.voiceId);
      if (v && v.linkId && v.linkId === cap.linkId) id = v.id;
    }
    const target = p.clips.find(c => c.id === id);
    if (!target) return p;
    // ほかのアイテムを押し出さないよう、前後のアイテムのところで止める（YMM4 と同じ）
    const others = p.clips.filter(c => c.trackId === target.trackId && c.id !== target.id && !(target.linkId && c.linkId === target.linkId));
    const prevEnd = Math.max(0, ...others.filter(c => c.start + c.duration <= target.start).map(c => c.start + c.duration));
    const nextStart = Math.min(Infinity, ...others.filter(c => c.start >= target.start + target.duration).map(c => c.start));
    let s0 = Math.max(prevEnd, Math.round(start));
    let e0 = Math.min(nextStart, Math.round(start) + Math.round(duration));
    if (e0 - s0 < 1) [s0, e0] = [target.start, target.start + target.duration];
    const next = {
      ...p,
      clips: p.clips.map(c => {
        if (c.id !== id) return c;
        const s = Math.max(0, s0);
        const d = Math.max(1, e0 - s0);
        if (c.type === 'media') return {...c, start: s, duration: d, inPoint: Math.max(0, c.inPoint + (s - c.start))};
        if (c.type !== 'voice') return {...c, start: s, duration: d};
        return {...c, start: s, duration: d, lockDuration: true};
      }),
    };
    return next;
  });
}

// ───────────── トラック ─────────────

/**
 * レイヤーを足す。at はレイヤーの位置（0 = レイヤー 1 の位置に入れる）。無ければ一番後ろ（一番手前のレイヤー）
 */
export function addTrack(_kind: 'video' | 'audio' = 'video', at?: number): string {
  const id = newId('V');
  commit(p => {
    const i = at === undefined ? p.tracks.length : Math.max(0, Math.min(p.tracks.length, at));
    const tracks = [...p.tracks];
    tracks.splice(i, 0, newLayer(id));
    // 番号で指しているキャラクターの設定を、ずれないように直す
    const bump = (n?: number | null) => (n && n - 1 >= i ? n + 1 : n);
    const characters = p.characters.map(c => ({...c, layer: bump(c.layer), audioLayer: bump(c.audioLayer)}));
    return {...p, tracks, characters};
  });
  return id;
}

export function updateTrack(id: string, patch: Partial<Track>) {
  commit(p => ({...p, tracks: p.tracks.map(t => (t.id === id ? {...t, ...patch} : t))}));
}

/** レイヤーを消す（中のアイテムも消える。元に戻すで戻せる）。最後の 1 つは消せない */
export function removeTrack(id: string): boolean {
  const p = state.project;
  const t = p?.tracks.find(x => x.id === id);
  if (!p || !t || p.tracks.length <= 1) return false;
  commit(pr => {
    const n = pr.tracks.indexOf(t) + 1;
    const fix = (v?: number | null) => (v && v > n ? v - 1 : v === n ? null : v);
    return {
      ...pr,
      tracks: pr.tracks.filter(x => x.id !== id),
      clips: pr.clips.filter(c => c.trackId !== id),
      characters: pr.characters.map(c => ({...c, layer: fix(c.layer), audioLayer: fix(c.audioLayer)})),
    };
  });
  setState(s => (s.project?.clips.some(c => c.id === s.selectedClipId) ? {} : {selectedClipId: null}));
  return true;
}

/** タイムラインの選択を見せる（スクロールで追従） */
export function revealSelection() {
  setState(s => ({revealSeq: s.revealSeq + 1}));
}

/** 素材を再生位置で 2 つに分ける。リンクした映像と音声は一緒に分け、右側どうしも新しいリンクでつなぐ */
export function splitClip(id: string, at: number): boolean {
  const p = state.project;
  const c = p?.clips.find(x => x.id === id);
  if (!p || !c || c.type !== 'media' || at <= c.start || at >= c.start + c.duration) return false;
  const targets = new Set(p.clips.filter(x => x.id === id || (c.linkId && x.linkId === c.linkId && x.type === 'media' && at > x.start && at < x.start + x.duration)).map(x => x.id));
  const newLink = c.linkId && targets.size > 1 ? newId('lk') : null;
  const rightIds = new Map([...targets].map(t => [t, newId('m')]));
  commit(pr => ({
    ...pr,
    clips: pr.clips.flatMap(x => {
      if (!targets.has(x.id) || x.type !== 'media') return [x];
      const left: MediaClip = {...x, duration: at - x.start};
      const right: MediaClip = {...x, id: rightIds.get(x.id)!, start: at, duration: x.start + x.duration - at, inPoint: x.inPoint + (at - x.start), linkId: newLink};
      return [left, right];
    }),
  }));
  setState({selectedClipId: rightIds.get(id)!});
  return true;
}

/** 素材を再生位置に追加する。画像は 5 秒、動画・音声は素材の長さ */
/**
 * テキスト・図形を再生位置に追加する（3 秒）。置く先は素材と同じく、選んでいるアイテムのトラックか、
 * 再生位置が空いているロックされていないトラック。どれも埋まっていれば一番下にトラックを足す
 */
export function addVisualItem(kind: 'text' | 'shape', shape: ShapeKind = 'rect'): string | null {
  const p = state.project;
  if (!p) return null;
  const id = newId(kind === 'text' ? 'tx' : 'sh');
  const at = state.playhead;
  const duration = p.video.fps * 3;
  const sel = p.clips.find(c => c.id === state.selectedClipId);
  const busy = (t: Track) => p.clips.some(c => c.trackId === t.id && c.start < at + duration && at < c.start + c.duration);
  // 選んでいるアイテムの映像トラックが空いていればそこ、無ければ空いている映像トラック（V1 から。重ねて既存のアイテムを押し出さないように）
  const vt = videoTracks(p);
  // キャラクターのセリフ用のトラックには置かない（テキスト・図形は別のトラックへ。どれも同じ決まり）
  const forLines = (t: Track) => isLineTrack(p, t.id) || charactersOnTrack(p, t.id).length > 0;
  const ok = (t: Track) => !t.locked && !busy(t) && !forLines(t);
  const selTrack = sel ? vt.find(t => t.id === sel.trackId && ok(t)) : undefined;
  let track = selTrack ?? vt.find(ok);
  commit(pr => {
    let tracks = pr.tracks;
    if (!track) {
      track = newLayer(newId('V'), 'video');
      const a = tracks.findIndex(t => t.kind === 'audio');
      tracks = a < 0 ? [...tracks, track] : [...tracks.slice(0, a), track, ...tracks.slice(a)];
    }
    const base = {id, trackId: track.id, start: at, duration, transform: {x: 0, y: 0, scale: 1, opacity: 1}, look: plainLook()};
    const clip: Clip =
      kind === 'text'
        ? {...base, type: 'text', text: 'テキスト', fontFamily: 'Yu Gothic UI', fontSize: 96, color: '#FFFFFF', outlineColor: '#000000', outlineWidth: 6, bold: true, italic: false, align: 'center'}
        : {
            ...base,
            type: 'shape',
            shape,
            width: shape === 'line' ? 400 : 300,
            height: shape === 'line' ? 8 : shape === 'rect' || shape === 'roundRect' ? 180 : 300,
            fill: '#FFCC00',
            stroke: '',
            strokeWidth: 0,
          };
    return resolveOverlaps({...pr, tracks, clips: [...pr.clips, clip]}, track.id, id);
  });
  setState(s => ({selectedClipId: id, revealSeq: s.revealSeq + 1}));
  return id;
}

/**
 * 素材を再生位置から順に追加する。画像は 5 秒、動画・音声は素材の長さ。
 * 音の入った動画は、映像と音の 1 つのクリップ（右クリックの「音声を分離」で分けられる）。
 * 置くトラック：選んでいるアイテムのトラック（同じ種類で、置く間ずっと空いているとき）→ 置く間ずっと空いている最初のトラック
 * （音声はセリフの無いトラックを先に）→ 無ければ新しく足す。既存のクリップを押し出さない
 */
export function addMediaClips(items: {path: string; info: MediaInfo}[]) {
  const p = state.project;
  if (!p || !items.length) return;
  const fps = p.video.fps;
  const sel = p.clips.find(c => c.id === state.selectedClipId);
  let at = state.playhead;
  const placed = items.map(({path, info}) => {
    const duration = info.durationMs ? Math.max(1, Math.round((info.durationMs * fps) / 1000)) : fps * 5;
    const r = {path, info, start: at, duration, kind: (info.kind === 'audio' ? 'audio' : 'video') as 'video' | 'audio'};
    at += duration;
    return r;
  });
  const span = (kind: 'video' | 'audio') => {
    const xs = placed.filter(x => x.kind === kind);
    return xs.length ? [Math.min(...xs.map(x => x.start)), Math.max(...xs.map(x => x.start + x.duration))] : null;
  };
  const hasVoice = (t: Track) => p.clips.some(c => c.trackId === t.id && c.type === 'voice');
  const pick = (kind: 'video' | 'audio'): Track | null => {
    const sp = span(kind);
    if (!sp) return null;
    const ok = (t: Track) => !t.locked && freeOver(p, t.id, sp[0], sp[1]);
    const list = kind === 'audio' ? audioTracks(p) : videoTracks(p);
    const st = list.find(t => t.id === sel?.trackId && ok(t));
    if (st) return st;
    return [...list.filter(t => !hasVoice(t)), ...list.filter(hasVoice)].find(ok) ?? null;
  };
  let vTrack = pick('video');
  let aTrack = pick('audio');
  const ids: string[] = [];
  commit(pr => {
    let next = pr;
    if (span('video') && !vTrack) {
      next = ensureTracks(next, 'video', videoTracks(next).length + 1);
      vTrack = videoTracks(next).at(-1)!;
    }
    if (span('audio') && !aTrack) {
      next = ensureTracks(next, 'audio', audioTracks(next).length + 1);
      aTrack = audioTracks(next).at(-1)!;
    }
    const clips: MediaClip[] = placed.map(({path, info, start, duration, kind}) => {
      const id = newId('m');
      ids.push(id);
      // 画面より大きい画像は収まるように縮める
      const fit = info.width && info.height ? Math.min(1, pr.video.width / info.width, pr.video.height / info.height) : 1;
      return {
        id,
        trackId: kind === 'audio' ? aTrack!.id : vTrack!.id,
        start,
        duration,
        type: 'media',
        src: path,
        mediaKind: info.kind,
        hasAudio: info.hasAudio,
        inPoint: 0,
        volume: 1,
        transform: {x: 0, y: 0, scale: Number(fit.toFixed(3)), opacity: 1},
      };
    });
    return {...next, clips: [...next.clips, ...clips]};
  });
  setState(s => ({selectedClipId: ids[0] ?? null, revealSeq: s.revealSeq + 1, media: {...s.media, ...Object.fromEntries(items.map(i => [i.path, i.info]))}}));
}

export function setPortrait(characterId: string, portrait: Portrait | null) {
  updateCharacter(characterId, {portrait});
}

// ───────────── 複数選択・コピー・貼り付け ─────────────

/**
 * クリップを選ぶ。
 * - replace：それだけを選ぶ
 * - toggle：選択に足す／外す（Ctrl+クリック）
 * - range：いま選んでいるクリップから、同じトラックのそのクリップまでをまとめて選ぶ（Shift+クリック）
 */
export function selectClip(id: string | null, mode: 'replace' | 'toggle' | 'range' = 'replace') {
  const s = state;
  const p = s.project;
  if (!p || !id) return setState({selectedClipId: null});
  if (mode === 'toggle') {
    const has = s.selectedClipIds.includes(id);
    const group = withLinked([id], p);
    const ids = has ? s.selectedClipIds.filter(x => !group.includes(x)) : [...new Set([...s.selectedClipIds, ...group])];
    return setState({selectedClipIds: ids, selectedClipId: has ? (ids.at(-1) ?? null) : id});
  }
  if (mode === 'range') {
    const anchor = p.clips.find(c => c.id === s.selectedClipId);
    const target = p.clips.find(c => c.id === id);
    if (anchor && target && anchor.trackId === target.trackId) {
      const [a, b] = [Math.min(anchor.start, target.start), Math.max(anchor.start, target.start)];
      const ids = withLinked(
        p.clips.filter(c => c.trackId === target.trackId && c.start >= a && c.start <= b).map(c => c.id),
        p,
      );
      return setState({selectedClipIds: [...new Set([...s.selectedClipIds, ...ids])], selectedClipId: s.selectedClipId});
    }
  }
  setState({selectedClipId: id});
}

/** そのクリップだけを選ぶ（リンクしたクリップを含めない。Alt+クリック） */
export function selectOnly(id: string) {
  setState({selectedClipId: id, selectedClipIds: [id]});
}

export function selectAllClips() {
  const p = state.project;
  if (!p) return;
  const ids = p.clips.map(c => c.id);
  setState({selectedClipIds: ids, selectedClipId: state.selectedClipId ?? ids[0] ?? null});
}

/** 選んでいるクリップ（ロックしたトラックのものは除く） */
export function editableSelection(): Clip[] {
  const p = state.project;
  if (!p) return [];
  const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
  const ids = new Set(state.selectedClipIds);
  return p.clips.filter(c => ids.has(c.id) && !locked.has(c.trackId));
}

export function deleteClips(ids: string[]) {
  if (!ids.length) return;
  const del = new Set(ids);
  commit(p => rippleDelete(p, del));
  setState({selectedClipId: null});
  onDeleted?.(ids.length);
}

/** 消したあとの知らせ（App が「元に戻す」付きの通知を出す） */
let onDeleted: ((n: number) => void) | undefined;
export const setOnDeleted = (f: (n: number) => void) => {
  onDeleted = f;
};

/** まとめて動かす（同じトラックの中で、同じだけずらす）。重なったら後ろを押し出す */
export function moveClips(ids: string[], delta: number, opts: {insert?: boolean} = {}): MoveResult {
  const p = state.project;
  if (!p || !ids.length || !delta) return {kind: 'blocked'};
  // リンクしている相手も一緒に動かす
  const links = new Set(p.clips.filter(c => ids.includes(c.id) && c.linkId).map(c => c.linkId));
  const move = new Set([...ids, ...p.clips.filter(c => c.linkId && links.has(c.linkId)).map(c => c.id)]);
  const moving = p.clips.filter(c => move.has(c.id));
  // 先頭のクリップが 0 より前に出ないように、ずらす量を抑える
  const d = Math.max(-Math.min(...moving.map(c => c.start)), Math.round(delta));
  if (!opts.insert && !moving.every(c => freeOver(p, c.trackId, c.start + d, c.start + d + c.duration, move))) return {kind: 'blocked'};
  let pushed = 0;
  commit(q => {
    let next = {...q, clips: q.clips.map(c => (move.has(c.id) ? {...c, start: c.start + d} : c))};
    if (opts.insert) {
      // トラックごとに、動かした中で一番前のものを固定して挿入
      for (const t of new Set(moving.map(c => c.trackId))) {
        const first = next.clips.filter(c => move.has(c.id) && c.trackId === t).sort((a, b) => a.start - b.start)[0];
        if (!first) continue;
        const others = next.clips.filter(c => move.has(c.id) && c.trackId === t && c.id !== first.id);
        // 一緒に動かしたものは押し出さない（同じだけずれているので）
        const tmp = {...next, clips: next.clips.filter(c => !others.includes(c))};
        const ins = insertAt(tmp, t, first.id);
        next = {...ins, clips: [...ins.clips, ...others]};
      }
      pushed = pushedCount(q, next, move);
    }
    return next;
  });
  return opts.insert ? {kind: 'inserted', pushed} : {kind: 'moved'};
}

let clipboard: {clips: Clip[]; base: number} | null = null;

export const hasClipboard = () => !!clipboard?.clips.length;

/** 選んだクリップを写す。セリフは「名前：セリフ」の文としてもクリップボードに入れる（台本の貼り付けで使える） */
export function copySelection(): number {
  const p = state.project;
  const ids = new Set(state.selectedClipIds);
  const clips = p?.clips.filter(c => ids.has(c.id)).sort((a, b) => a.start - b.start) ?? [];
  if (!p || !clips.length) return 0;
  clipboard = {clips: structuredClone(clips), base: clips[0].start};
  setState({clipboardCount: clips.length});
  const text = clips
    .filter((c): c is VoiceClip => c.type === 'voice')
    .map(c => `${p.characters.find(ch => ch.id === c.characterId)?.name ?? ''}：${c.text}`)
    .join('\n');
  if (text) void navigator.clipboard?.writeText(text).catch(() => {});
  return clips.length;
}

export function cutSelection(): number {
  const n = copySelection();
  if (n) deleteClips(editableSelection().map(c => c.id));
  return n;
}

/**
 * 貼り付ける。セリフを選んでいればその後ろ、そうでなければ再生位置に、写したときの並び・トラックのまま置く。
 * 元のトラックが無い・ロックされているときは、ロックされていない最初のトラックへ
 */
export function pasteClipboard(): number {
  const p = state.project;
  if (!p || !clipboard?.clips.length) return 0;
  const sel = p.clips.find(c => c.id === state.selectedClipId);
  const anchor = sel?.type === 'voice' && clipboard.clips.some(c => c.type === 'voice') ? sel.start + sel.duration : state.playhead;
  // 写したときのトラックへ。無い・ロックされているなら、同じ種類のロックされていない最初のトラック
  const usable = (c: Clip) => {
    const t = p.tracks.find(x => x.id === c.trackId);
    if (t && !t.locked) return t.id;
    return p.tracks.find(x => !x.locked)?.id ?? null;
  };
  // id とリンクを付け直す（写したセリフと字幕は、貼ったものどうしでリンクする）
  const ids = new Map(clipboard.clips.map(c => [c.id, newId(c.type === 'voice' ? 'c' : c.type === 'caption' ? 'cap' : 'm')]));
  const links = new Map<string, string>();
  const relink = (l?: string | null) => (l ? (links.get(l) ?? (links.set(l, newId('lk')), links.get(l)!)) : null);
  const pasted: Clip[] = [];
  for (const c of clipboard.clips) {
    const trackId = usable(c);
    if (!trackId) continue;
    const n = {...structuredClone(c), id: ids.get(c.id)!, trackId, start: anchor + (c.start - clipboard.base), linkId: relink(c.linkId)} as Clip;
    if (n.type === 'caption') {
      // セリフも一緒に写したなら、その写しの字幕にする。字幕だけなら元のセリフの文を出す（リンクはしない）
      if (ids.has(n.voiceId)) n.voiceId = ids.get(n.voiceId)!;
      else n.linkId = null;
    }
    pasted.push(n);
  }
  if (!pasted.length) return 0;
  commit(pr => {
    let next = {...pr, clips: [...pr.clips, ...pasted]};
    for (const t of new Set(pasted.map(c => c.trackId))) next = resolveOverlaps(next, t, pasted.find(c => c.trackId === t)?.id);
    return next;
  });
  setState(s => ({selectedClipIds: pasted.map(c => c.id), selectedClipId: pasted[0].id, playhead: anchor, revealSeq: s.revealSeq + 1}));
  return pasted.length;
}

/** 選んだクリップを複製して、すぐ後ろに置く */
export function duplicateSelection(): number {
  if (!copySelection()) return 0;
  const p = state.project!;
  const ids = new Set(state.selectedClipIds);
  const last = p.clips.filter(c => ids.has(c.id)).reduce((m, c) => (c.start + c.duration > m.start + m.duration ? c : m));
  // 最後のクリップを選んだ状態で貼ると、その後ろに入る
  setState({selectedClipId: last.id, playhead: last.start + last.duration});
  return pasteClipboard();
}

/** 選んだセリフのキャラクターをまとめて変える */
export function setCharacterForSelection(characterId: string) {
  const ids = new Set(
    editableSelection()
      .map(c => (c.type === 'caption' ? c.voiceId : c.id))
      .filter(id => state.project?.clips.some(c => c.id === id && c.type === 'voice')),
  );
  if (!ids.size) return;
  commit(p => ({...p, clips: p.clips.map(c => (ids.has(c.id) && c.type === 'voice' ? {...c, characterId, presetId: null, audio: null} : c))}));
}

/**
 * 台本の並べ替え。セリフ id を（時間順の）index 番目へ動かし、動いた範囲の行を時間順に詰め直す。
 * 行はそれぞれのトラックのまま。1 回の「元に戻す」で戻る
 */
export function reorderLine(id: string, toIndex: number) {
  commit(p => {
    const lines = p.clips.filter((x): x is VoiceClip => x.type === 'voice').sort((a, b) => a.start - b.start);
    const from = lines.findIndex(x => x.id === id);
    const to = Math.max(0, Math.min(lines.length - 1, toIndex));
    if (from < 0 || from === to) return p;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const order = [...lines];
    const [c] = order.splice(from, 1);
    order.splice(to, 0, c);
    let t = lines[lo].start;
    const starts = new Map<string, number>();
    for (const l of order.slice(lo, hi + 1)) {
      starts.set(l.id, t);
      t += l.duration;
    }
    let next = {...p, clips: p.clips.map(x => (starts.has(x.id) ? {...x, start: starts.get(x.id)!} : x))};
    for (const l of new Set(order.slice(lo, hi + 1).map(x => x.trackId))) next = resolveOverlaps(next, l, id);
    return next;
  });
  const c = state.project?.clips.find(x => x.id === id);
  if (c) setState(s => ({selectedClipId: id, playhead: c.start, revealSeq: s.revealSeq + 1}));
}

// ───────────── リンク ─────────────

/** 選んだクリップをリンクする（一緒に動くようにする）。字幕はセリフに合わせ直す */
export function linkClips(ids: string[]) {
  if (ids.length < 2) return;
  const linkId = newId('lk');
  const set = new Set(ids);
  commit(p => ({...p, clips: p.clips.map(c => (set.has(c.id) ? {...c, linkId} : c))}));
}

/** リンクを外す（選んだクリップとリンクしていたもの全部） */
export function unlinkClips(ids: string[]) {
  const p = state.project;
  if (!p) return;
  const links = new Set(p.clips.filter(c => ids.includes(c.id) && c.linkId).map(c => c.linkId));
  if (!links.size) return;
  commit(pr => ({...pr, clips: pr.clips.map(c => (c.linkId && links.has(c.linkId) ? {...c, linkId: null} : c))}));
  setState(s => ({selectedClipIds: s.selectedClipId ? [s.selectedClipId] : []}));
}

// ───────────── 分離・まとめる ─────────────

/** 分離できるか：字幕と声が 1 つのセリフ（映像トラック）、映像と音が 1 つの動画 */
export function canSeparate(p: Project, c: Clip | undefined): boolean {
  if (!c) return false;
  return (c.type === 'voice' && !isSeparatedVoice(p, c)) || (c.type === 'media' && c.mediaKind === 'video' && c.hasAudio);
}

/** まとめられるか：分離したセリフの声と字幕、分離した動画の映像と音声（リンクしている 2 つ） */
export function canMerge(p: Project, c: Clip | undefined): boolean {
  return !!c && !!mergePair(p, c);
}

function mergePair(p: Project, c: Clip): [Clip, Clip] | null {
  if (!c.linkId) return null;
  const group = p.clips.filter(x => x.linkId === c.linkId);
  if (group.length !== 2) return null;
  const voice = group.find(x => x.type === 'voice');
  const cap = group.find(x => x.type === 'caption');
  if (voice && cap?.type === 'caption' && cap.voiceId === voice.id) return [cap, voice];
  const vid = group.find(x => x.type === 'media' && x.mediaKind === 'video');
  const aud = group.find(x => x.type === 'media' && x.mediaKind === 'audio');
  if (vid?.type === 'media' && aud?.type === 'media' && vid.src === aud.src) return [vid, aud];
  return null;
}

/**
 * 分離した音を置くレイヤー（置く間ずっと空いているもの）。キャラクターの声なら設定・前回のレイヤーを先に、
 * それ以外は元のレイヤーの 1 つ上（手前）から近い順。無ければ一番手前に足す
 */
function soundTrackFor(p: Project, from: string, start: number, end: number, characterId?: string): {p: Project; trackId: string} {
  const list = p.tracks;
  const at = Math.max(
    0,
    list.findIndex(t => t.id === from),
  );
  const near = list
    .map((t, i) => [t, i > at ? i - at : at - i + 0.5] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([t]) => t);
  const ch = characterId ? p.characters.find(c => c.id === characterId) : undefined;
  const pi = ch ? voiceLayerFor(p, ch.id) : -1;
  const preferred = pi >= 0 ? list[pi] : undefined;
  const order = preferred ? [preferred, ...near.filter(t => t !== preferred)] : near;
  const t = order.find(x => x.id !== from && !x.locked && freeOver(p, x.id, start, end));
  if (t) return {p, trackId: t.id};
  const next = ensureTracks(p, 'video', p.tracks.length + 1);
  return {p: next, trackId: next.tracks.at(-1)!.id};
}

/**
 * 分離する（リンクした 2 つのクリップにする）。
 * - セリフ：字幕はその場に残り、声は空いている近くのレイヤーへ
 * - 動画：映像はその場に残り、音は空いている近くのレイヤーへ
 */
export function separateClip(id: string): boolean {
  const p0 = state.project;
  const c = p0?.clips.find(x => x.id === id);
  if (!p0 || !canSeparate(p0, c)) return false;
  const linkId = newId('lk');
  commit(p => {
    const clip = p.clips.find(x => x.id === id)!;
    const r = soundTrackFor(p, clip.trackId, clip.start, clip.start + clip.duration, clip.type === 'voice' ? clip.characterId : undefined);
    if (clip.type === 'voice') {
      const cap: CaptionClip = {id: newId('cap'), type: 'caption', trackId: clip.trackId, start: clip.start, duration: clip.duration, linkId, voiceId: clip.id};
      return {...r.p, clips: [...r.p.clips.map(x => (x.id === id ? {...x, trackId: r.trackId, linkId} : x)), cap]};
    }
    const m = clip as MediaClip;
    const sound: MediaClip = {...m, id: newId('m'), trackId: r.trackId, mediaKind: 'audio', linkId, transform: {x: 0, y: 0, scale: 1, opacity: 1}, look: undefined};
    return {...r.p, clips: [...r.p.clips.map(x => (x.id === id ? ({...m, hasAudio: false, linkId} as Clip) : x)), sound]};
  });
  return true;
}

/** まとめる（分離したものを、また 1 つのクリップに戻す。置き場所は字幕・映像の側） */
export function mergeClip(id: string): boolean {
  const p0 = state.project;
  const c = p0?.clips.find(x => x.id === id);
  const pair = p0 && c ? mergePair(p0, c) : null;
  if (!pair) return false;
  const [visual, sound] = pair;
  commit(p => {
    if (visual.type === 'caption') {
      // 声を字幕の場所へ戻し、字幕は消す
      const clips = p.clips.filter(x => x.id !== visual.id).map(x => (x.id === sound.id ? {...x, trackId: visual.trackId, linkId: null} : x));
      return {...p, clips};
    }
    const vol = sound.type === 'media' ? sound.volume : 1;
    const clips = p.clips.filter(x => x.id !== sound.id).map(x => (x.id === visual.id ? ({...x, hasAudio: true, volume: vol, linkId: null} as Clip) : x));
    return {...p, clips};
  });
  setState({selectedClipId: visual.type === 'caption' ? sound.id : visual.id});
  return true;
}

// ───────────── 立ち絵アイテム ─────────────

/**
 * 立ち絵アイテムを置く（YMM4 と同じ）。PSD 立ち絵を設定したキャラクターだけ。
 * 置く先：そのキャラクターのセリフのトラックより下（奥）の、置く間ずっと空いている映像トラック。無ければセリフのトラックのすぐ下に足す
 * （字幕より奥に描くため）。whole なら先頭から最後まで、そうでなければ再生位置からセリフの最後まで（5 秒以上）
 */
export function addPortraitItem(characterId: string, opts: {whole?: boolean} = {}): string | null {
  const p0 = state.project;
  const ch = p0?.characters.find(c => c.id === characterId);
  if (!p0 || !ch?.portrait?.psd) return null;
  const fps = p0.video.fps;
  const end = projectDuration(p0);
  const start = opts.whole ? 0 : state.playhead;
  // 同じキャラクターの立ち絵アイテムがもう出ているなら、新しく重ねずにそれを選ぶ
  const showing = p0.clips.find(c => c.type === 'portrait' && c.characterId === characterId && c.start <= start && start < c.start + c.duration);
  if (showing) {
    setState(s => ({selectedClipId: showing.id, revealSeq: s.revealSeq + 1}));
    void import('./actions').then(m => m.getNotify()(`${ch.name}の立ち絵アイテムはこの位置にもうあるので、それを選びました`, 'info'));
    return showing.id;
  }
  let addedTrack = false;
  const duration = Math.max(fps * 5, end - start);
  const id = newId('pt');
  commit(p => {
    let next = p;
    const vt = videoTracks(next);
    const line = captionLayerFor(next, characterId);
    // セリフのトラックより下（番号の小さい方）で、近いものから
    let track = vt
      .slice(0, line)
      .reverse()
      .find(t => !t.locked && freeOver(next, t.id, start, start + duration) && !next.clips.some(c => c.trackId === t.id && c.type === 'voice'));
    if (!track) {
      // セリフのトラックのすぐ下に足す（それより上を指していたキャラクターの番号はずらす）
      const tid = newId('V');
      const tracks = [...next.tracks];
      tracks.splice(tracks.indexOf(vt[line]), 0, newLayer(tid, 'video'));
      addedTrack = true;
      const characters = next.characters.map(c => ({
        ...c,
        layer: c.layer && c.layer - 1 >= line ? c.layer + 1 : c.layer,
        audioLayer: c.audioLayer && c.audioLayer - 1 >= line ? c.audioLayer + 1 : c.audioLayer,
      }));
      next = {...next, tracks, characters};
      track = next.tracks.find(t => t.id === tid)!;
    }
    const item: PortraitClip = {id, type: 'portrait', trackId: track.id, start, duration, characterId, transform: {...ch.portrait!.transform}, onlyWhileSpeaking: !!ch.portrait!.onlyWhileSpeaking};
    return {...next, clips: [...next.clips, item]};
  });
  if (addedTrack) {
    const p1 = state.project!;
    const t = p1.clips.find(c => c.id === id)!.trackId;
    const code = trackCode(p1, t);
    // 番号が変わったことを知らせる（黙って変えない）
    void import('./actions').then(m =>
      m.getNotify()(`立ち絵アイテム用に ${code} を足しました（字幕より奥に描くため、セリフのレイヤーのすぐ下）。それより上のレイヤーの番号は 1 つずつ増えています`, 'info'),
    );
  }
  setState(s => ({selectedClipId: id, revealSeq: s.revealSeq + 1}));
  return id;
}
