// アプリの状態。外部ライブラリを使わず useSyncExternalStore で購読する（再描画は購読した値が変わった部品だけ）。
// 元に戻す／やり直しは Project のスナップショットで持つ（不変更新なので共有部分はコピーされない）。

import {useSyncExternalStore} from 'react';
import type {Character, Clip, EngineId, EngineStatus, MediaClip, Portrait, Project, Track, VoiceClip, VoiceInfo} from './model';
import type {DictEntry, MediaInfo} from './ipc';
import {defaultParams, newId, reflowVoiceTrack} from './model';

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
  sidebarTab: 'characters' | 'script';
  /** タイムラインに選択を見せる（スクロールする）よう頼む合図。値が変わるたびに追従する */
  revealSeq: number;
  /** 設定画面を開いているか（左パネルの「場所を選ぶ」からも開く） */
  settingsOpen: boolean;
  /** 最近使ったプロジェクト */
  recent: string[];
  /** 台本の貼り付け画面・辞書の画面を開いているか */
  pasteOpen: boolean;
  /** 台本の貼り付け画面に最初に入れておく文（セリフ入力欄に複数行を貼ったとき） */
  pasteText: string;
  dictionaryOpen: boolean;
  /** キーボードショートカットの一覧を開いているか */
  shortcutsOpen: boolean;
  /** ファイルをドラッグして画面の上にいるか */
  dropActive: boolean;
  /** 複数選択しているクリップ（selectedClipId も含む） */
  selectedClipIds: string[];
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
  sidebarTab: 'characters',
  revealSeq: 0,
  settingsOpen: false,
  recent: [],
  pasteOpen: false,
  pasteText: '',
  dictionaryOpen: false,
  shortcutsOpen: false,
  dropActive: false,
  selectedClipIds: [],
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
  // 1 つだけ選んだときは、複数選択もその 1 つにする
  if ('selectedClipId' in p && !('selectedClipIds' in p)) p.selectedClipIds = p.selectedClipId ? [p.selectedClipId] : [];
  state = {...state, ...p};
  listeners.forEach(l => l());
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

const HISTORY_LIMIT = 100;

let lastMerge: {key: string; at: number} | null = null;

/**
 * 履歴に残る変更。`mergeKey` が直前と同じで 1 秒以内なら、1 つの履歴にまとめる
 * （文字入力やスライダー操作で履歴が 1 文字ずつ積まれないように）。
 */
export function commit(update: (p: Project) => Project, mergeKey?: string) {
  setState(s => {
    if (!s.project) return {};
    const next = update(s.project);
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
  setState({project: p, dirty: opts.dirty ?? true});
}

export function undo() {
  setState(s => {
    const prev = s.past.at(-1);
    if (!prev || !s.project) return {};
    return {project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], dirty: true};
  });
}

export function redo() {
  setState(s => {
    const [next, ...rest] = s.future;
    if (!next || !s.project) return {};
    return {project: next, future: rest, past: [...s.past, s.project], dirty: true};
  });
}

// ───────────── 編集操作 ─────────────

export function updateClip(id: string, patch: Partial<VoiceClip> | Partial<Clip>) {
  const key = `clip:${id}:${Object.keys(patch).sort().join(',')}`;
  commit(p => ({...p, clips: p.clips.map(c => (c.id === id ? ({...c, ...patch} as Clip) : c))}), key);
}

export function updateCharacter(id: string, patch: Partial<Character>) {
  const key = `char:${id}:${Object.keys(patch).sort().join(',')}`;
  commit(
    p => ({
      ...p,
      characters: p.characters.map(c => (c.id === id ? {...c, ...patch} : c)),
      // 声が変わったら、このキャラクターのセリフは合成し直しが必要
      clips: patch.voice ? p.clips.map(c => (c.type === 'voice' && c.characterId === id ? {...c, audio: null} : c)) : p.clips,
    }),
    key,
  );
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
export function removeCharacter(id: string): boolean {
  const p = state.project;
  if (!p || p.characters.length <= 1) return false;
  commit(pr => {
    const tracks = new Set(pr.clips.filter(c => c.type === 'voice' && c.characterId === id).map(c => c.trackId));
    let next = {...pr, characters: pr.characters.filter(c => c.id !== id), clips: pr.clips.filter(c => !(c.type === 'voice' && c.characterId === id))};
    for (const t of tracks) next = reflowVoiceTrack(next, t);
    return next;
  });
  setState(s => ({selectedCharacterId: s.project?.characters[0]?.id ?? null, selectedClipId: null}));
  return true;
}

/**
 * 同じトラックのクリップが重ならないように後ろへ押し出す。
 * `pinnedId` のクリップは、同じ開始位置のクリップより前に置く（ドロップした場所に「挿入」する）。
 * セリフは押し出すとき、直前のセリフの「間」を空ける。
 */
export function resolveOverlaps(p: Project, trackId: string, pinnedId?: string): Project {
  const onTrack = p.clips
    .filter(c => c.trackId === trackId)
    .sort((a, b) => a.start - b.start || (a.id === pinnedId ? -1 : b.id === pinnedId ? 1 : 0));
  const moved = new Map<string, number>();
  let prev: Clip | null = null;
  let prevStart = 0;
  for (const c of onTrack) {
    let start = c.start;
    if (prev) {
      const prevEnd = prevStart + prev.duration;
      if (start < prevEnd) start = prevEnd + (prev.type === 'voice' && c.type === 'voice' ? prev.gapAfter : 0);
    }
    if (start !== c.start) moved.set(c.id, start);
    prev = c;
    prevStart = start;
  }
  if (!moved.size) return p;
  return {...p, clips: p.clips.map(c => (moved.has(c.id) ? {...c, start: moved.get(c.id)!} : c))};
}

/** セリフを入れる先：選んでいるセリフのトラックの、その行のすぐ後ろ。選んでいなければ最初のセリフトラックの末尾 */
function insertionPoint(p: Project): {trackId: string; start: number} | null {
  const sel = p.clips.find(c => c.id === state.selectedClipId);
  if (sel?.type === 'voice') return {trackId: sel.trackId, start: sel.start + sel.duration + sel.gapAfter};
  const track = p.tracks.find(t => t.kind === 'voice' && !t.locked);
  if (!track) return null;
  const last = p.clips
    .filter((c): c is VoiceClip => c.type === 'voice' && c.trackId === track.id)
    .reduce<VoiceClip | null>((m, c) => (!m || c.start > m.start ? c : m), null);
  return {trackId: track.id, start: last ? last.start + last.duration + last.gapAfter : 0};
}

/** セリフを追加（YMM4 のセリフ入力欄と同じ動き）。選んでいる行があればその後ろに挿入し、後ろの行を押し出す */
export function addLine(characterId: string, text: string): string {
  const id = newId('c');
  let at = 0;
  commit(p => {
    const ins = insertionPoint(p);
    if (!ins) return p;
    at = ins.start;
    const clip: VoiceClip = {
      id,
      trackId: ins.trackId,
      start: ins.start,
      duration: Math.max(30, Math.round([...text].length * 0.12 * p.video.fps)), // 合成前の仮の長さ
      type: 'voice',
      characterId,
      text,
      subtitle: null,
      paramsOverride: null,
      audio: null,
      gapAfter: 6,
      lockDuration: false,
    };
    return resolveOverlaps({...p, clips: [...p.clips, clip]}, ins.trackId, id);
  });
  // 追加した行を選び、再生位置をその頭へ。タイムラインもそこまでスクロールする
  setState(s => ({selectedClipId: id, playhead: at, revealSeq: s.revealSeq + 1}));
  return id;
}

/** 何行もまとめて追加する（台本の貼り付け）。1 回の「元に戻す」で全部戻る。追加した行の ID を返す */
export function addLines(items: {characterId: string; text: string}[]): string[] {
  const ids: string[] = [];
  let at = 0;
  commit(p => {
    const ins = insertionPoint(p);
    if (!ins || !items.length) return p;
    at = ins.start;
    let start = ins.start;
    const clips: VoiceClip[] = items.map(({characterId, text}) => {
      const id = newId('c');
      ids.push(id);
      const duration = Math.max(30, Math.round([...text].length * 0.12 * p.video.fps)); // 合成前の仮の長さ
      const c: VoiceClip = {
        id,
        trackId: ins.trackId,
        start,
        duration,
        type: 'voice',
        characterId,
        text,
        subtitle: null,
        paramsOverride: null,
        audio: null,
        gapAfter: 6,
        lockDuration: false,
      };
      start += duration + c.gapAfter;
      return c;
    });
    // 後ろにあった行は、まとめて押し出す
    const shift = start - ins.start;
    const after = new Set(p.clips.filter(c => c.trackId === ins.trackId && c.start >= ins.start).map(c => c.id));
    const moved = p.clips.map(c => (after.has(c.id) ? {...c, start: c.start + shift} : c));
    return resolveOverlaps({...p, clips: [...moved, ...clips]}, ins.trackId, ids[0]);
  });
  if (ids.length) setState(s => ({selectedClipId: ids.at(-1)!, playhead: at, revealSeq: s.revealSeq + 1}));
  return ids;
}

export function deleteClip(id: string) {
  commit(p => {
    const clip = p.clips.find(c => c.id === id);
    const next = {...p, clips: p.clips.filter(c => c.id !== id)};
    return clip?.type === 'voice' ? reflowVoiceTrack(next, clip.trackId) : next;
  });
  setState(s => (s.selectedClipId === id ? {selectedClipId: null} : {}));
}

/** 移動。トラックを変える場合は同じ種類のトラックだけ。重なったら後ろを押し出す */
export function moveClip(id: string, start: number, trackId?: string, mergeKey?: string) {
  commit(p => {
    const c = p.clips.find(x => x.id === id);
    if (!c) return p;
    const target = trackId && p.tracks.find(t => t.id === trackId)?.kind === p.tracks.find(t => t.id === c.trackId)?.kind ? trackId : c.trackId;
    const next = {...p, clips: p.clips.map(x => (x.id === id ? {...x, start: Math.max(0, Math.round(start)), trackId: target} : x))};
    return resolveOverlaps(next, target, id);
  }, mergeKey);
}

/**
 * 端をドラッグして長さを変える。左端を動かした素材は、切り出し位置（inPoint）も同じだけずらす。
 * セリフの長さを手で変えたら、以後は音声長に合わせない（lockDuration）。後ろと重なったら押し出す。
 */
export function trimClip(id: string, start: number, duration: number) {
  commit(p => {
    const target = p.clips.find(c => c.id === id);
    if (!target) return p;
    const next = {
      ...p,
      clips: p.clips.map(c => {
        if (c.id !== id) return c;
        const s = Math.max(0, Math.round(start));
        const d = Math.max(1, Math.round(duration));
        if (c.type === 'media') return {...c, start: s, duration: d, inPoint: Math.max(0, c.inPoint + (s - c.start))};
        return {...c, start: s, duration: d, lockDuration: true};
      }),
    };
    return resolveOverlaps(next, target.trackId, id);
  });
}

// ───────────── トラック ─────────────

export function addTrack(kind: Track['kind']): string {
  const id = newId('t');
  commit(p => {
    const n = p.tracks.filter(t => t.kind === kind).length + 1;
    const track: Track = {id, kind, name: kind === 'voice' ? `セリフ ${n}` : `素材 ${n}`, muted: false, locked: false, duck: false, duckLevel: 0.3};
    // セリフトラックはセリフの並びの後ろ、素材トラックは一番下へ
    const lastVoice = p.tracks.map(t => t.kind).lastIndexOf('voice');
    const tracks = [...p.tracks];
    tracks.splice(kind === 'voice' ? lastVoice + 1 : tracks.length, 0, track);
    return {...p, tracks};
  });
  return id;
}

export function updateTrack(id: string, patch: Partial<Track>) {
  commit(p => ({...p, tracks: p.tracks.map(t => (t.id === id ? {...t, ...patch} : t))}));
}

/** トラックを消す（中のクリップも消える。元に戻すで戻せる）。最後の 1 本は消せない */
export function removeTrack(id: string): boolean {
  const p = state.project;
  const t = p?.tracks.find(x => x.id === id);
  if (!p || !t || p.tracks.filter(x => x.kind === t.kind).length <= 1) return false;
  commit(pr => ({...pr, tracks: pr.tracks.filter(x => x.id !== id), clips: pr.clips.filter(c => c.trackId !== id)}));
  setState(s => (s.project?.clips.some(c => c.id === s.selectedClipId) ? {} : {selectedClipId: null}));
  return true;
}

/** タイムラインの選択を見せる（スクロールで追従） */
export function revealSelection() {
  setState(s => ({revealSeq: s.revealSeq + 1}));
}

export function splitClip(id: string, at: number): boolean {
  const p = state.project;
  const c = p?.clips.find(x => x.id === id);
  if (!p || !c || c.type !== 'media' || at <= c.start || at >= c.start + c.duration) return false;
  const rightId = newId('m');
  commit(pr => ({
    ...pr,
    clips: pr.clips.flatMap(x => {
      if (x.id !== id || x.type !== 'media') return [x];
      const left: MediaClip = {...x, duration: at - x.start};
      const right: MediaClip = {...x, id: rightId, start: at, duration: x.start + x.duration - at, inPoint: x.inPoint + (at - x.start)};
      return [left, right];
    }),
  }));
  setState({selectedClipId: rightId});
  return true;
}

/** 素材を再生位置に追加する。画像は 5 秒、動画・音声は素材の長さ */
export function addMediaClips(items: {path: string; info: MediaInfo}[]) {
  const p = state.project;
  if (!p || !items.length) return;
  const fps = p.video.fps;
  const selTrack = p.tracks.find(t => t.id === p.clips.find(c => c.id === state.selectedClipId)?.trackId);
  let track = selTrack?.kind === 'media' && !selTrack.locked ? selTrack : p.tracks.find(t => t.kind === 'media' && !t.locked);
  const ids: string[] = [];
  commit(pr => {
    let tracks = pr.tracks;
    if (!track) {
      track = {id: newId('t'), kind: 'media', name: '素材', muted: false, locked: false, duck: false, duckLevel: 0.3};
      tracks = [...tracks, track];
    }
    let at = state.playhead;
    const clips: MediaClip[] = items.map(({path, info}) => {
      const duration = info.durationMs ? Math.max(1, Math.round((info.durationMs * fps) / 1000)) : fps * 5;
      const id = newId('m');
      ids.push(id);
      // 画面より大きい画像は収まるように縮める
      const fit = info.width && info.height ? Math.min(1, pr.video.width / info.width, pr.video.height / info.height) : 1;
      const c: MediaClip = {
        id,
        trackId: track!.id,
        start: at,
        duration,
        type: 'media',
        src: path,
        mediaKind: info.kind,
        hasAudio: info.hasAudio,
        inPoint: 0,
        volume: 1,
        transform: {x: 0, y: 0, scale: Number(fit.toFixed(3)), opacity: 1},
      };
      at += duration;
      return c;
    });
    return resolveOverlaps({...pr, tracks, clips: [...pr.clips, ...clips]}, track!.id, clips[0]?.id);
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
    const ids = has ? s.selectedClipIds.filter(x => x !== id) : [...s.selectedClipIds, id];
    return setState({selectedClipIds: ids, selectedClipId: has ? (ids.at(-1) ?? null) : id});
  }
  if (mode === 'range') {
    const anchor = p.clips.find(c => c.id === s.selectedClipId);
    const target = p.clips.find(c => c.id === id);
    if (anchor && target && anchor.trackId === target.trackId) {
      const [a, b] = [Math.min(anchor.start, target.start), Math.max(anchor.start, target.start)];
      const ids = p.clips.filter(c => c.trackId === target.trackId && c.start >= a && c.start <= b).map(c => c.id);
      return setState({selectedClipIds: [...new Set([...s.selectedClipIds, ...ids])], selectedClipId: s.selectedClipId});
    }
  }
  setState({selectedClipId: id});
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
  commit(p => {
    const tracks = new Set(p.clips.filter(c => del.has(c.id) && c.type === 'voice').map(c => c.trackId));
    let next = {...p, clips: p.clips.filter(c => !del.has(c.id))};
    for (const t of tracks) next = reflowVoiceTrack(next, t);
    return next;
  });
  setState({selectedClipId: null});
}

/** まとめて動かす（同じトラックの中で、同じだけずらす）。重なったら後ろを押し出す */
export function moveClips(ids: string[], delta: number) {
  if (!ids.length || !delta) return;
  const move = new Set(ids);
  commit(p => {
    // 先頭のクリップが 0 より前に出ないように、ずらす量を抑える
    const minStart = Math.min(...p.clips.filter(c => move.has(c.id)).map(c => c.start));
    const d = Math.max(-minStart, Math.round(delta));
    let next = {...p, clips: p.clips.map(c => (move.has(c.id) ? {...c, start: c.start + d} : c))};
    const first = next.clips.filter(c => move.has(c.id)).sort((a, b) => a.start - b.start)[0];
    for (const t of new Set(next.clips.filter(c => move.has(c.id)).map(c => c.trackId))) next = resolveOverlaps(next, t, first?.id);
    return next;
  });
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
 * 貼り付ける。セリフを選んでいればその後ろ、そうでなければ再生位置に、写したときの並びのまま置く。
 * 元のトラックが無い・ロックされているときは、同じ種類の最初のトラックへ
 */
export function pasteClipboard(): number {
  const p = state.project;
  if (!p || !clipboard?.clips.length) return 0;
  const sel = p.clips.find(c => c.id === state.selectedClipId);
  const anchor = sel?.type === 'voice' && clipboard.clips.some(c => c.type === 'voice') ? sel.start + sel.duration + sel.gapAfter : state.playhead;
  const usable = (kind: Track['kind'], id: string) => {
    const t = p.tracks.find(x => x.id === id);
    if (t && t.kind === kind && !t.locked) return t.id;
    return p.tracks.find(x => x.kind === kind && !x.locked)?.id ?? null;
  };
  const pasted: Clip[] = [];
  for (const c of clipboard.clips) {
    const trackId = sel?.type === 'voice' && c.type === 'voice' ? sel.trackId : usable(c.type === 'voice' ? 'voice' : 'media', c.trackId);
    if (!trackId) continue;
    pasted.push({...structuredClone(c), id: newId(c.type === 'voice' ? 'c' : 'm'), trackId, start: anchor + (c.start - clipboard.base)} as Clip);
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
  const ids = new Set(editableSelection().filter(c => c.type === 'voice').map(c => c.id));
  if (!ids.size) return;
  commit(p => ({...p, clips: p.clips.map(c => (ids.has(c.id) && c.type === 'voice' ? {...c, characterId, audio: null} : c))}));
}
