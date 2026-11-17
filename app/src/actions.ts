// UI から呼ぶ非同期の操作（IPC ＋ 状態更新）。

import {parseSubtitles} from './srt';
import {api, type AiProgress, type ExportProgress, type ExportRequest, type MediaInfo} from './ipc';
import type {EngineId, Portrait, Project, VoiceClip} from './model';
import {
  ENGINE_LABEL,
  effectiveVoice,
  framesToTimecode,
  withTransitions,
  isSpeakerMissing,
  projectDuration,
  proxyKey,
  matteKey,
  reframeClip,
  srcSpan,
  srcFrameAt,
  canvasToSource,
  followTrack,
  fitToCell,
  SPLIT_LAYOUTS,
  type MediaClip,
  type VisualClip,
  reflowAll,
  synthKey,
  timelineFrameOf,
} from './model';
import {addCaptionClips, cutRanges, addCharacterFrom, addMediaClips, commit, getState, relinkPaths, replaceProject, setState, splitClip} from './store';
import {forget, stop} from './preview/playback';

/** key を付けると同じ種類の通知を置き換え、clearNotice(key) で消せる */
export type Notify = (body: string, type?: 'info' | 'error', key?: string, action?: NoticeAction) => void;
/** 通知に付けるボタン（「元に戻す」など） */
export interface NoticeAction {
  label: string;
  onClick: () => void;
}

// 引数で受け取れない場所（ボタンの clickAction など）から使う通知先
let notifyRef: Notify = () => {};
export const setNotify = (n: Notify) => {
  notifyRef = n;
};
/** 通知先（引数で渡せない部品から使う） */
export const getNotify = (): Notify => (body, type, key, action) => notifyRef(body, type, key, action);
let clearRef: (key: string) => void = () => {};
export const setClearNotice = (c: (key: string) => void) => {
  clearRef = c;
};
export const clearNotice = (key: string) => clearRef(key);

/** 素材を選んで再生位置に追加 */
export async function addMedia() {
  await addMediaPaths(await (await api).pickMedia('media', true));
}

/** パスを指定して素材を追加（選んだ・ドロップしたファイル） */
export async function addMediaPaths(paths: string[]) {
  const a = await api;
  const items: {path: string; info: MediaInfo}[] = [];
  for (const path of paths) {
    try {
      items.push({path, info: await a.probeMedia(path)});
    } catch (e) {
      notifyRef(friendlyError(e), 'error');
    }
  }
  addMediaClips(items);
  for (const it of items) if (it.info.kind === 'video') void ensureProxy(it.path);
}

let proxyListening = false;
/** 動画のプロキシを用意する（作成中・作成済みなら何もしない）。stabilize なら手ぶれを補正したもの */
export async function ensureProxy(src: string, stabilize = false) {
  const key = proxyKey({src, stabilize});
  const s = getState();
  if (s.proxies[key]) return;
  const a = await api;
  if (!proxyListening) {
    proxyListening = true;
    await a.onProxyProgress(p => setState(st => (st.proxies[p.src] && !st.proxies[p.src].url ? {proxies: {...st.proxies, [p.src]: {...st.proxies[p.src], ratio: p.ratio}}} : {})));
  }
  setState(st => ({proxies: {...st.proxies, [key]: {ratio: 0, url: null}}}));
  try {
    const info = getState().media[src] ?? (await a.probeMedia(src, getState().projectPath));
    setState(st => ({media: {...st.media, [src]: info}}));
    const url = await a.makeProxy(src, getState().projectPath, info.durationMs ?? 0, stabilize);
    setState(st => ({proxies: {...st.proxies, [key]: {ratio: 1, url}}}));
  } catch (e) {
    setState(st => ({proxies: {...st.proxies, [key]: {ratio: 0, url: null, error: String(e)}}}));
    notifyRef(`プロキシを作れませんでした：${String(e)}`, 'error');
  }
}

let aiListening = false;
const aiWatchers = new Set<(p: AiProgress) => void>();
/** AI の進捗を見る（ダウンロード・文字起こし・型づくり）。やめる関数を返す */
export async function watchAi(cb: (p: AiProgress) => void): Promise<() => void> {
  const a = await api;
  if (!aiListening) {
    aiListening = true;
    await a.onAiProgress(p => aiWatchers.forEach(w => w(p)));
  }
  aiWatchers.add(cb);
  return () => void aiWatchers.delete(cb);
}

/**
 * 素材の音を文字起こしして、字幕（テキスト）を新しいレイヤーに並べる。速さ・逆再生を変えた素材でも、聞こえる時刻に合わせる。
 * 作った数を返す
 */
export async function autoCaptions(clipId: string, model: string): Promise<number> {
  const s0 = getState();
  const c = s0.project?.clips.find(x => x.id === clipId);
  if (!s0.project || !c || c.type !== 'media' || c.mediaKind === 'image' || c.freeze) return 0;
  const fps = s0.project.video.fps;
  const inS = c.inPoint / fps;
  const dur = srcSpan(c) / fps;
  const segs = await (await api).transcribe(c.src, s0.projectPath, model, inS, dur);
  const items = segs.flatMap(sg => {
    const a = timelineFrameOf(c, Math.max(inS, sg.start), fps);
    const b = timelineFrameOf(c, Math.min(inS + dur, sg.end), fps);
    if (a === null || b === null) return [];
    return [{start: Math.min(a, b), duration: Math.abs(b - a), text: sg.text}];
  });
  return addCaptionClips(items);
}

/** アイテムの下で流れている動画（アイテムの頭の時点で重なっていて、違うレイヤーのもの） */
export function videoUnder(itemId: string): MediaClip | null {
  const p = getState().project;
  const it = p?.clips.find(c => c.id === itemId);
  if (!p || !it) return null;
  const order = p.tracks.map(t => t.id);
  const mine = order.indexOf(it.trackId);
  const cands = p.clips.filter(
    (c): c is MediaClip => c.type === 'media' && c.mediaKind === 'video' && c.id !== it.id && c.trackId !== it.trackId && c.start <= it.start && c.start + c.duration > it.start,
  );
  // 奥（下に描かれる）レイヤーのうち、いちばん近いもの
  cands.sort((a, b) => Math.abs(order.indexOf(a.trackId) - mine) - Math.abs(order.indexOf(b.trackId) - mine));
  return cands[0] ?? null;
}

/**
 * モーショントラッキング：アイテムの頭の時点でアイテムが乗っている点を、下の動画の中で追い、アイテムを付いて動かす。
 * 追えた秒数を返す
 */
export async function trackItem(itemId: string, size = 0.06): Promise<number> {
  const s0 = getState();
  const p = s0.project;
  const it = p?.clips.find(c => c.id === itemId);
  const video = videoUnder(itemId);
  if (!p || !it || !('transform' in it) || it.type === 'portrait') throw new Error('付いていかせるアイテムを選んでください');
  if (!video) throw new Error('アイテムの頭の時点で、下に動画がありません');
  if (video.reverse || video.freeze) throw new Error('逆再生・静止にした動画は追えません');
  const a = await api;
  const info = s0.media[video.src] ?? (await a.probeMedia(video.src, s0.projectPath));
  if (!info.width || !info.height) throw new Error('動画の大きさが分かりません');
  const fps = p.video.fps;
  const t0 = Math.max(it.start, video.start);
  const t1 = Math.min(it.start + it.duration, video.start + video.duration);
  const from = srcFrameAt(video, t0 - video.start) / fps;
  const to = srcFrameAt(video, t1 - video.start) / fps;
  const [u, v] = canvasToSource(video, [info.width, info.height], it.transform.x, it.transform.y);
  if (u < 0 || u > 1 || v < 0 || v > 1) throw new Error('アイテムが動画の外にあります。追わせたい物の上に置いてください');
  const pts = await a.trackMotion(video.src, s0.projectPath, from, to, u, v, size);
  const cur = getState().project?.clips.find(c => c.id === itemId);
  if (!cur || !('transform' in cur) || cur.type === 'portrait') return 0;
  const next = followTrack(cur as VisualClip, video, pts, [info.width, info.height], fps);
  commit(pr => ({...pr, clips: pr.clips.map(x => (x.id === itemId ? next : x))}));
  return pts.length ? pts[pts.length - 1].t - pts[0].t : 0;
}

/**
 * 無音カット：素材の静かなところ（threshold_db より小さい音が minLen 秒以上）を切り取って詰める。
 * 話の前後を pad 秒だけ残す。切り取った秒数を返す
 */
export async function cutSilence(clipId: string, opt: {thresholdDb: number; minLen: number; pad: number}): Promise<number> {
  const s0 = getState();
  const p = s0.project;
  const c = p?.clips.find(x => x.id === clipId);
  if (!p || !c || c.type !== 'media' || c.mediaKind === 'image' || c.freeze) return 0;
  if (c.mediaKind === 'video' && !c.hasAudio) throw new Error('この動画には音がありません');
  const fps = p.video.fps;
  const sil = await (await api).detectSilence(c.src, s0.projectPath, opt.thresholdDb, opt.minLen);
  const cur = getState().project?.clips.find(x => x.id === clipId);
  if (!cur || cur.type !== 'media') return 0;
  const inS = cur.inPoint / fps;
  const outS = inS + srcSpan(cur) / fps;
  const ranges = sil.flatMap(([a, b]) => {
    // 話の頭と終わりは pad 秒残す（素材の頭・終わりにかかる静かなところは、そこまで切る）
    const x = Math.max(inS, a <= inS + 1e-3 ? a : a + opt.pad);
    const y = Math.min(outS, b >= outS - 1e-3 ? b : b - opt.pad);
    if (y - x < opt.minLen / 2) return [];
    const fa = timelineFrameOf(cur, x, fps);
    const fb = timelineFrameOf(cur, y, fps);
    if (fa === null || fb === null) return [];
    return [[Math.min(fa, fb), Math.max(fa, fb)] as [number, number]];
  });
  return cutRanges(clipId, ranges) / fps;
}

/** 分割画面：選んだ動画・画像を、並べ方のマスに順に置く（時間はそのまま。選んだ順＝レイヤーの上から）。置いた数を返す */
export async function applySplitLayout(ids: string[], layoutId: string, gap = 0): Promise<number> {
  const s0 = getState();
  const p = s0.project;
  const lay = SPLIT_LAYOUTS.find(l => l.id === layoutId);
  if (!p || !lay) return 0;
  const order = p.tracks.map(t => t.id);
  const items = p.clips
    .filter((c): c is MediaClip => ids.includes(c.id) && c.type === 'media' && c.mediaKind !== 'audio')
    .sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId) || a.start - b.start)
    .slice(0, lay.cells.length);
  const a = await api;
  const next = new Map<string, MediaClip>();
  for (const [i, m] of items.entries()) {
    const info = getState().media[m.src] ?? (await a.probeMedia(m.src, s0.projectPath));
    if (!info.width || !info.height) continue;
    next.set(m.id, fitToCell(m, [info.width, info.height], lay.cells[i], [p.video.width, p.video.height], gap));
  }
  if (!next.size) return 0;
  commit(pr => ({...pr, clips: pr.clips.map(c => next.get(c.id) ?? c)}));
  return next.size;
}

/** 自動で位置合わせ：素材を画面いっぱいにして、被写体が真ん中に来るように位置（動画は時刻ごとのキーフレーム）を決める */
export async function autoReframe(clipId: string, model: string): Promise<boolean> {
  const s0 = getState();
  const c = s0.project?.clips.find(x => x.id === clipId);
  if (!s0.project || !c || c.type !== 'media' || c.mediaKind === 'audio') return false;
  const a = await api;
  const info = s0.media[c.src] ?? (await a.probeMedia(c.src, s0.projectPath));
  if (!info.width || !info.height) return false;
  const pts = await a.subjectTrack(c.src, s0.projectPath, model, c.mediaKind === 'image', info.durationMs ?? 0);
  const p = getState().project;
  const cur = p?.clips.find(x => x.id === clipId);
  if (!p || !cur || cur.type !== 'media') return false;
  const next = reframeClip(cur, pts, [info.width, info.height], [p.video.width, p.video.height], p.video.fps);
  commit(pr => ({...pr, clips: pr.clips.map(x => (x.id === clipId ? next : x))}));
  return true;
}

/** 字幕ファイル（.srt・.vtt）を読み込んで、新しいレイヤー「字幕」にテキストとして並べる。作った数を返す */
export async function importSubtitleFile(file: File): Promise<number> {
  const p = getState().project;
  if (!p) return 0;
  return addCaptionClips(parseSubtitles(await file.text(), p.video.fps));
}

/** 背景を消す型を用意する（作成中・作成済みなら何もしない）。型の URL は proxies[matteKey] に入る */
export async function ensureMatte(src: string, model: string, kind: 'video' | 'image', quiet = false, retry = false) {
  const key = matteKey(src, model);
  const cur = getState().proxies[key];
  if (cur && (cur.url || !cur.error || !retry)) return;
  const a = await api;
  setState(st => ({proxies: {...st.proxies, [key]: {ratio: 0, url: null}}}));
  const unwatch = await watchAi(p => {
    if (p.stage === 'matte') setState(st => (st.proxies[key] && !st.proxies[key].url ? {proxies: {...st.proxies, [key]: {...st.proxies[key], ratio: p.ratio}}} : {}));
  });
  try {
    const info = getState().media[src] ?? (await a.probeMedia(src, getState().projectPath));
    const url = await a.makeMatte(src, getState().projectPath, model, kind === 'image', info.durationMs ?? 0);
    setState(st => ({proxies: {...st.proxies, [key]: {ratio: 1, url}}}));
  } catch (e) {
    setState(st => ({proxies: {...st.proxies, [key]: {ratio: 0, url: null, error: String(e)}}}));
    if (!quiet) notifyRef(`背景を消せませんでした：${friendlyError(e)}`, 'error');
  } finally {
    unwatch();
  }
}

/** 効果音を再生位置に置く（初めての効果音はここで作る） */
export async function addSfx(name: string) {
  try {
    const path = await (await api).makeSfx(name);
    await addMediaPaths([path]);
  } catch (e) {
    notifyRef(friendlyError(e), 'error');
  }
}

/** 動画を場面の変わり目ごとに分ける（リンクした音も一緒に）。分けた数を返す */
export async function splitAtScenes(id: string): Promise<number> {
  const s0 = getState();
  const c = s0.project?.clips.find(x => x.id === id);
  if (!s0.project || !c || c.type !== 'media' || c.mediaKind !== 'video') return 0;
  const times = await (await api).detectScenes(c.src, s0.projectPath, 0.35);
  const fps = s0.project.video.fps;
  const frames = [...new Set(times.map(t => timelineFrameOf(c, t, fps)).filter((f): f is number => f !== null && f > c.start + 1 && f < c.start + c.duration - 1))].sort((a, b) => a - b);
  let cur = id;
  let n = 0;
  for (const f of frames) {
    if (splitClip(cur, f)) {
      n++;
      cur = getState().selectedClipId ?? cur;
    }
  }
  return n;
}

/** プロジェクト内のすべての動画のプロキシを用意する */
function ensureAllProxies() {
  const p = getState().project;
  if (!p) return;
  const srcs = new Set(p.clips.flatMap(c => (c.type === 'media' && c.mediaKind === 'video' ? [c.src] : [])));
  srcs.forEach(src => void ensureProxy(src));
  // 手ぶれ補正を付けた動画は、補正したプロキシも
  const stab = new Set(p.clips.flatMap(c => (c.type === 'media' && c.mediaKind === 'video' && c.stabilize ? [c.src] : [])));
  stab.forEach(src => void ensureProxy(src, true));
  // 背景を消す素材は、作ってある型を読む（モデルがなければ黙って待つ）
  for (const c of p.clips) if (c.type === 'media' && c.mediaKind !== 'audio' && c.matte) void ensureMatte(c.src, c.matte, c.mediaKind, true);
}

/** キャラクター設定（声・字幕・立ち絵）をファイルに保存する */
export async function exportCharacterFile(characterId: string, notify: Notify) {
  const s = getState();
  const ch = s.project?.characters.find(c => c.id === characterId);
  if (!ch) return;
  const a = await api;
  const path = await a.pickCharacterPath('save', ch.name);
  if (!path) return;
  try {
    await a.exportCharacter(path, ch, s.projectPath);
    notify(`「${ch.name}」を保存しました。ほかの動画でも「ファイルから読み込む」で使えます`);
  } catch (e) {
    notify(friendlyError(e), 'error');
  }
}

export async function importCharacterFile(notify: Notify, given?: string) {
  const a = await api;
  const path = given ?? (await a.pickCharacterPath('open'));
  if (!path) return;
  try {
    const ch = await a.importCharacter(path);
    addCharacterFrom(ch);
    void loadVoices(ch.voice.engine);
    notify(`「${ch.name}」を読み込みました`);
  } catch (e) {
    notify(friendlyError(e), 'error');
  }
}

/** 画像を 1 枚選ぶ（プレビューで読めるよう許可も出す） */
export async function pickImagePath(): Promise<string | null> {
  const [path] = await (await api).pickMedia('image', false);
  return path ?? null;
}

/** Rust から来たエラー文を、利用者向けに短く整える */
export function friendlyError(e: unknown): string {
  const msg = String(e).replace(/^Error:\s*/, '');
  if (/接続できません|NotRunning|起動/.test(msg)) return msg;
  if (/VOICEPEAK/.test(msg) && /Internal BUG|BUG REPORT/i.test(msg)) return 'VOICEPEAK の中でエラーが起きました。話者がこのPCの VOICEPEAK に入っているか、VOICEPEAK の画面を閉じてから試してください';
  if (/HostNotFound/.test(msg)) return 'A.I.VOICE が見つかりません。インストールされているか確かめてください';
  if (/os error 2|No such file|見つかりません/.test(msg)) return `ファイルが見つかりません（${msg}）`;
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

export async function boot(notify: Notify) {
  const a = await api;
  // 起動したら空のプロジェクト（タイムラインに「最初の 3 手順」が出る。見本は「サンプルを開く」で）
  const project = await a.newProject(false);
  setState({project, dirty: false, past: [], future: [], selectedCharacterId: project.characters[0]?.id ?? null});
  const cfg = await a.getConfig();
  setState({recent: cfg.recent ?? [], dictionary: cfg.dictionary ?? []});
  void refreshEngines();
  await offerRestore(notify);
  startAutosave();
}

export async function refreshEngines() {
  const a = await api;
  setState({checkingEngines: true});
  let engines;
  try {
    engines = await a.engineStatus();
  } finally {
    setState({checkingEngines: false});
  }
  setState({engines});
  // 使えるエンジンの話者一覧を並列に取得
  await Promise.all(
    engines
      .filter(e => e.status.state === 'ready')
      .map(e =>
        a
          .listVoices(e.engine)
          .then(v => {
            setState(s => ({voices: {...s.voices, [e.engine]: v}}));
            fixUntouchedSpeakers();
          })
          .catch(() => {}),
      ),
  );
}

/**
 * まだ何も編集していない（サンプルの）プロジェクトで、このPCのソフトに入っていない話者を
 * 入っている最初の話者に置き換える。利用者が作ったプロジェクトは勝手に変えない
 */
function fixUntouchedSpeakers() {
  const s = getState();
  if (!s.project || s.dirty || s.projectPath || s.past.length) return;
  let changed = false;
  const characters = s.project.characters.map(ch => {
    if (!isSpeakerMissing(ch.voice, s.voices)) return ch;
    const first = s.voices[ch.voice.engine]![0];
    changed = true;
    return {...ch, voice: {...ch.voice, speaker: first.speaker}};
  });
  if (changed) setState({project: {...s.project, characters}});
}

export async function loadVoices(engine: EngineId) {
  if (getState().voices[engine]) return;
  const a = await api;
  const v = await a.listVoices(engine).catch(() => []);
  setState(s => ({voices: {...s.voices, [engine]: v}}));
}

// ───────────── 音声合成（順番待ちの列） ─────────────
//
// 打っている間も止めずに、届いた行から順に合成して 1 行ずつ反映する（YMM4 と同じく、打つ → 合成 → 次の行が止まらない）。
// - 合成中に別の行を足しても、列の後ろに並ぶだけ（前のように「合成中なので何もしない」ことはない）
// - 合成中にその行を書き直したら、結果は捨てずに比べ、変わった行だけもう一度並べる（ほかの行の結果は生かす）
// - 取り消しは、まだ始めていない行を列から外す（始めた数行は終わりしだい反映）

/** 一度に送る行の数（1 行ずつより速く、反映も細かく見える数） */
const BATCH = 3;
/** 待っている行（順番どおり） */
let queue: string[] = [];
/** 合成し終わったら呼ぶ（synthesize(…) が返す Promise） */
let waiters: {ids: Set<string>; resolve: () => void}[] = [];
let pumping = false;

/** 行の合成結果を左右するもの（文・声・アクセント）。送ったときと今で違えば、その結果は使わない */
function synthSignature(p: Project, id: string): string | null {
  const c = p.clips.find(x => x.id === id);
  if (!c || c.type !== 'voice' || !c.text.trim()) return null;
  const ch = p.characters.find(x => x.id === c.characterId);
  if (!ch) return null;
  return `${synthKey(effectiveVoice(ch, c))}\u0001${c.text}\u0001${JSON.stringify(c.accent ?? null)}`;
}

function settle(ids: string[]) {
  const set = new Set(ids);
  waiters = waiters.filter(w => {
    for (const id of set) w.ids.delete(id);
    if (w.ids.size) return true;
    w.resolve();
    return false;
  });
}

function setStatus(ids: string[], st: 'queued' | 'running' | null) {
  setState(s => {
    const next = {...s.synthStatus};
    for (const id of ids) {
      if (st) next[id] = st;
      else delete next[id];
    }
    return {synthStatus: next};
  });
}

/**
 * 行を合成の列に並べる。clipIds を省くと、すべてのセリフ（合成済みはキャッシュから一瞬で戻る）。
 * 返す Promise は、並べた行がすべて終わった（反映・失敗・取り消し）ときに解決する
 */
export async function synthesize(notify: Notify, clipIds?: string[]): Promise<void> {
  const s = getState();
  if (!s.project) return;
  clearNotice('synth');
  const all = s.project.clips.filter(c => c.type === 'voice' && c.text.trim()).map(c => c.id);
  let ids = (clipIds ?? all).filter(id => all.includes(id));
  // このPCのソフトに入っていない話者の行は送らず、分かる言葉で知らせる
  const missing = new Map<string, string>();
  for (const id of ids) {
    const c = s.project.clips.find(x => x.id === id);
    if (c?.type !== 'voice') continue;
    const ch = s.project.characters.find(x => x.id === c.characterId);
    if (ch && isSpeakerMissing(ch.voice, s.voices)) {
      missing.set(
        c.id,
        ch.voice.speaker
          ? `話者「${ch.voice.speaker}」は ${ENGINE_LABEL[ch.voice.engine]} に入っていません。「${ch.name}」の声を選び直してください`
          : `「${ch.name}」の声がまだ選ばれていません。「キャラクター」で声を選んでください`,
      );
    }
  }
  if (missing.size) {
    setState(st => ({synthErrors: {...st.synthErrors, ...Object.fromEntries(missing)}}));
    notify(`${missing.size} 件のセリフを合成できませんでした：${[...missing.values()][0]}`, 'error', 'synth');
    ids = ids.filter(id => !missing.has(id));
  }
  // すでに並んでいる・合成中の行は二重に並べない
  const fresh = ids.filter(id => !queue.includes(id) && getState().synthStatus[id] !== 'running');
  if (!ids.length) return;
  const done = new Promise<void>(resolve => waiters.push({ids: new Set(ids), resolve}));
  if (fresh.length) {
    queue.push(...fresh);
    setStatus(fresh, 'queued');
    setState(st => ({
      synthRun: st.synthRun ? {...st.synthRun, total: st.synthRun.total + fresh.length} : {done: 0, total: fresh.length, startedAt: performance.now(), workMs: 0},
    }));
  }
  void pump(notify);
  return done;
}

/** まだ始めていない行を列から外す（始めた数行は、終わりしだい反映する） */
export function cancelSynthesis() {
  const dropped = queue;
  queue = [];
  setStatus(dropped, null);
  setState(st => (st.synthRun ? {synthRun: {...st.synthRun, total: Math.max(st.synthRun.done, st.synthRun.total - dropped.length)}} : {}));
  settle(dropped);
}

/** 合成の列が空になるまで待つ（書き出しの前など） */
export function whenSynthIdle(): Promise<void> {
  if (!pumping && !queue.length) return Promise.resolve();
  return new Promise(resolve => {
    const t = window.setInterval(() => {
      if (!pumping && !queue.length) {
        window.clearInterval(t);
        resolve();
      }
    }, 100);
  });
}

/** 起動を試して駄目だったソフト（しばらくは試し直さない）→ いつ諦めたか */
const gaveUp = new Map<EngineId, number>();
/** 合成の途中でつながらなくなった行（ソフトを起動し直して、1 回だけやり直す） */
const relaunched = new Set<string>();
let recheckEngines = false;

/**
 * 使うソフトが起動していなければ起動して、使えるようになるまで待つ（YMM4 と同じく、セリフを足すだけで合成まで進む）。
 * 起動できないソフト（場所が分からない・設定がまだ）は何もしない。その行は今までどおり、理由を付けて失敗になる
 */
async function ensureEngines(notify: Notify, need: EngineId[]): Promise<void> {
  const known = getState().engines;
  const now = Date.now();
  const targets = need.filter(e => (recheckEngines || known.find(x => x.engine === e)?.status.state !== 'ready') && now - (gaveUp.get(e) ?? -Infinity) > 30_000);
  recheckEngines = false;
  if (!targets.length) return;
  const a = await api;
  let st = await a.engineStatus().catch(() => null);
  if (!st) return;
  setState({engines: st});
  const started: EngineId[] = [];
  for (const e of targets) {
    if (st.find(x => x.engine === e)?.status.state !== 'notRunning') continue;
    if (await a.launchEngine(e).catch(() => false)) started.push(e);
    else gaveUp.set(e, Date.now());
  }
  if (!started.length) return;
  const names = started.map(e => ENGINE_LABEL[e]).join('・');
  notify(`${names} を起動しています。使えるようになりしだい、合成を始めます`, 'info', 'launch');
  const isReady = (e: EngineId) => st!.find(x => x.engine === e)?.status.state === 'ready';
  // 立ち上がりは遅いことがある（初回は 1 分近く）ので、長めに待つ
  for (let i = 0; i < 60 && !started.every(isReady); i++) {
    await new Promise(r => window.setTimeout(r, 1500));
    st = (await a.engineStatus().catch(() => null)) ?? st;
  }
  clearNotice('launch');
  for (const e of started) if (!isReady(e)) gaveUp.set(e, Date.now());
  // 話者の一覧も取り直す
  await refreshEngines();
}

let auditionAudio: HTMLAudioElement | null = null;
/**
 * キャラクターの声を試しに聞く（今の声と調声で、短い文を合成して鳴らす）。プロジェクトには何も足さない。
 * 合成した音は同じ文・同じ声ならキャッシュから鳴る
 */
export async function previewVoice(notify: Notify, characterId: string, text?: string): Promise<boolean> {
  const p = getState().project;
  const ch = p?.characters.find(c => c.id === characterId);
  if (!p || !ch) return false;
  auditionAudio?.pause();
  const line = (text ?? '').trim() || `こんにちは。${ch.name}です。よろしくお願いします。`;
  const id = `audition-${ch.id}`;
  const trackId = p.tracks.find(t => t.kind !== 'audio')?.id ?? p.tracks[0]?.id ?? 'V1';
  const clip: VoiceClip = {
    id,
    trackId,
    start: 0,
    duration: p.video.fps * 3,
    type: 'voice',
    characterId: ch.id,
    text: line,
    subtitle: null,
    paramsOverride: null,
    audio: null,
    gapAfter: 0,
    lockDuration: false,
  };
  // 使うソフトが止まっていれば起動する（セリフを足したときと同じ）
  await ensureEngines(notify, [ch.voice.engine]);
  const a = await api;
  try {
    const r = await a.synthesize({...p, clips: [clip]}, [id]);
    const fail = r.failed.find(f => f[0] === id);
    if (fail) {
      notify(friendlyError(fail[1]), 'error', 'audition');
      return false;
    }
    const got = r.project.clips.find(c => c.id === id);
    const url = got?.type === 'voice' && got.audio ? await a.audioUrl(got.audio.cacheKey) : null;
    (globalThis as {__lastAudition?: string}).__lastAudition = line;
    if (url) {
      auditionAudio = new Audio(url);
      await auditionAudio.play().catch(() => {});
    }
    return true;
  } catch (e) {
    notify(friendlyError(e), 'error', 'audition');
    return false;
  }
}

async function pump(notify: Notify) {
  if (pumping) return;
  pumping = true;
  const a = await api;
  let failedCount = 0;
  let firstError = '';
  try {
    while (queue.length) {
      // 使うソフトが止まっていたら、先に起動する
      {
        const p0 = getState().project;
        const need = new Set<EngineId>();
        for (const id of queue.slice(0, BATCH)) {
          const c = p0?.clips.find(x => x.id === id);
          const ch = c?.type === 'voice' ? p0?.characters.find(x => x.id === c.characterId) : undefined;
          if (ch) need.add(ch.voice.engine);
        }
        if (need.size) await ensureEngines(notify, [...need]);
      }
      const batch = queue.splice(0, BATCH);
      const sent = getState().project;
      if (!sent) break;
      const sigs = new Map(batch.map(id => [id, synthSignature(sent, id)]));
      const live = batch.filter(id => sigs.get(id));
      setStatus(live, 'running');
      settle(batch.filter(id => !sigs.get(id)));
      if (!live.length) continue;
      const t0 = performance.now();
      let result: {project: Project; failed: [string, string][]} | null = null;
      let batchError: string | null = null;
      try {
        result = await a.synthesize(sent, live);
      } catch (e) {
        batchError = friendlyError(e);
      }
      const workMs = performance.now() - t0;
      // 結果を今のプロジェクトへ 1 行ずつ入れる。合成中に書き直された行は使わず、もう一度並べる
      const cur = getState().project;
      const again: string[] = [];
      const errors: Record<string, string> = {};
      const ok = new Map<string, NonNullable<VoiceClip['audio']>>();
      if (cur) {
        for (const id of live) {
          const now = synthSignature(cur, id);
          if (!now) continue;
          if (now !== sigs.get(id)) {
            again.push(id);
            continue;
          }
          if (batchError) {
            errors[id] = batchError;
            continue;
          }
          const f = result!.failed.find(([fid]) => fid === id);
          if (f) {
            errors[id] = friendlyError(f[1]);
            continue;
          }
          const got = result!.project.clips.find(c => c.id === id);
          if (got?.type === 'voice' && got.audio) ok.set(id, got.audio);
        }
        if (ok.size) {
          const prev = new Set(cur.clips.flatMap(c => (c.type === 'voice' && ok.has(c.id) && c.audio ? [c.audio.cacheKey] : [])));
          const next = reflowAll({...cur, clips: cur.clips.map(c => (c.type === 'voice' && ok.has(c.id) ? {...c, audio: ok.get(c.id)!} : c))});
          replaceProject(next);
          for (const au of ok.values()) prev.delete(au.cacheKey);
          prev.forEach(forget);
        }
      }
      // 途中でソフトが閉じられてつながらなくなった行は、起動し直してから 1 回だけやり直す
      for (const id of Object.keys(errors)) {
        if (!/接続できません|起動してください/.test(errors[id]) || relaunched.has(id)) continue;
        relaunched.add(id);
        delete errors[id];
        again.push(id);
        recheckEngines = true;
      }
      for (const id of ok.keys()) relaunched.delete(id);
      failedCount += Object.keys(errors).length;
      if (!firstError) firstError = Object.values(errors)[0] ?? '';
      setState(st => {
        const e = {...st.synthErrors};
        for (const id of ok.keys()) delete e[id];
        Object.assign(e, errors);
        const run = st.synthRun;
        return {synthErrors: e, synthRun: run ? {...run, done: run.done + live.length - again.length, workMs: run.workMs + workMs} : run};
      });
      setStatus(live, null);
      if (again.length) {
        queue.unshift(...again.filter(id => !queue.includes(id)));
        setStatus(again, 'queued');
      }
      settle(live.filter(id => !again.includes(id)));
    }
  } finally {
    pumping = false;
    // 長さが変わって選んでいた行が画面の外へ出ないよう、選択を見せ直す（スクロールだけ。再生位置は動かさない）
    setState(st => ({synthRun: null, revealSeq: st.revealSeq + 1}));
    if (failedCount) notify(`${failedCount} 行のセリフを合成できませんでした：${firstError}`, 'error', 'synth');
    // 取り消しや反映の途中で残った待ちがあれば、もう一度回す
    if (queue.length) void pump(notify);
    else relaunched.clear();
  }
}

/** 書き出す。進捗はヘッダーにも出す。取り消されたら 'cancelled' を投げる */
export async function runExport(out: string, options: ExportRequest, onProgress: (p: ExportProgress) => void): Promise<void> {
  if (!getState().project || getState().busy) return;
  // 合成の列が残っていれば、終わるのを待ってから（書き出しの合成と重ならないように）
  if (getState().synthRun) {
    setState({busy: {label: '合成の終わりを待っています', ratio: null}});
    await whenSynthIdle();
    setState({busy: null});
  }
  const s = getState();
  if (!s.project) return;
  stop();
  const a = await api;
  const label = (p: ExportProgress) => (p.stage === 'synth' ? '音声を合成しています' : p.stage === 'portrait' ? '立ち絵を準備しています' : '書き出しています');
  setState({busy: {label: '書き出しています', ratio: 0}});
  const off = await a.onExportProgress(p => {
    onProgress(p);
    setState({busy: {label: label(p), ratio: p.stage === 'portrait' ? null : p.ratio}});
  });
  try {
    // PSD 立ち絵は画面側で合成して、状態ごとの画像を渡す
    let portraitFrames = options.portraitFrames;
    if (s.project.characters.some(c => c.portrait?.visible && c.portrait.psd)) {
      const {bakePsdFrames} = await import('./psd/portrait');
      onProgress({stage: 'portrait', ratio: 0});
      setState({busy: {label: 'PSD 立ち絵を合成しています', ratio: 0}});
      portraitFrames = await bakePsdFrames(s.project, s.projectPath, r => setState({busy: {label: 'PSD 立ち絵を合成しています', ratio: r}}));
    }
    // テキスト・図形も画面側で描いた画像を渡す（画面と同じ見た目にするため）
    const {bakeItemImages} = await import('./preview/visual');
    // 切り替えの覆う図形の画像も要るので、置き換えた写しから作る（書き出しも同じ写しを描く）
    const itemImages = await bakeItemImages(withTransitions(s.project));
    const project = await a.exportVideo(s.project, s.projectPath, out, {...options, portraitFrames, itemImages});
    if (getState().project === s.project) replaceProject(project);
  } catch (e) {
    if (/取り消しました|Cancelled/.test(String(e))) throw new Error('cancelled');
    throw new Error(friendlyError(e));
  } finally {
    off();
    setState({busy: null});
  }
}

export async function cancelExport() {
  await (await api).cancelExport();
}

export type ExportKind = 'video' | 'gif' | 'audio' | 'subtitle';
const EXT: Record<ExportKind, string> = {video: 'mp4', gif: 'gif', audio: 'wav', subtitle: 'srt'};

export async function pickExportPath(kind: ExportKind = 'video'): Promise<string | null> {
  const s = getState();
  const a = await api;
  const base = s.projectPath ? s.projectPath.replace(/\.voxcut$/i, '') : (s.project?.name ?? 'video');
  return a.pickSavePath(kind, `${base}.${EXT[kind]}`);
}

/** 字幕だけを SRT で書き出す（YouTube などに字幕として上げる用） */
export async function exportSubtitles(out: string) {
  const p = getState().project;
  if (p) await (await api).exportSrt(p, out);
}

/** 書き出したファイルを、いつものアプリで開く（動画なら再生） */
export async function openFile(path: string) {
  await (await api).openPath(path);
}

export async function revealInFolder(path: string) {
  await (await api).revealInFolder(path);
}

/** 保存していない変更があるときの問いの答えを待つ（UnsavedDialog が answerUnsaved で答える） */
let unsavedWait: ((v: 'save' | 'discard' | 'cancel') => void) | null = null;
export function answerUnsaved(v: 'save' | 'discard' | 'cancel') {
  setState({unsavedAsk: false});
  unsavedWait?.(v);
  unsavedWait = null;
}

/** 保存していない変更を捨ててよいか確かめる。「保存して続ける」なら保存してから（保存をやめたら続けない） */
async function confirmDiscard(): Promise<boolean> {
  if (!getState().dirty) return true;
  unsavedWait?.('cancel');
  const v = await new Promise<'save' | 'discard' | 'cancel'>(res => {
    unsavedWait = res;
    setState({unsavedAsk: true});
  });
  if (v === 'cancel') return false;
  if (v === 'discard') return true;
  await saveProject(getNotify());
  return !getState().dirty;
}

/** プロジェクトの中で使っている画像・素材のパス（絶対パスだけ） */
function absolutePaths(project: Project): string[] {
  return [...project.clips.flatMap(c => (c.type === 'media' ? [c.src] : [])), ...project.characters.flatMap(c => (c.portrait ? portraitFiles(c.portrait) : []))].filter(
    (x): x is string => !!x && /^([a-zA-Z]:[\\/]|[\\/])/.test(x),
  );
}

function portraitFiles(pt: Portrait): (string | null)[] {
  return [pt.base, ...pt.eyes, ...pt.mouth, ...(pt.expressions ?? []).flatMap(e => [e.base, ...e.eyes, ...e.mouth])];
}

/** 読み込んだプロジェクトを画面に出す */
async function loadProject(project: Project, path: string | null, dirty: boolean) {
  const a = await api;
  stop();
  // プロジェクトのフォルダ外にある素材・立ち絵もプレビューで読めるようにする
  const paths = absolutePaths(project);
  if (paths.length) await a.allowPaths(paths);
  setState(s => ({project, projectPath: path, dirty, past: [], future: [], selectedClipId: null, playhead: 0, proxies: {}, media: {}, synthErrors: {}, missingMedia: [], openSeq: s.openSeq + 1}));
  ensureAllProxies();
  // 動かした・消した素材があれば知らせる
  void checkMedia().then(missing => {
    if (missing.length)
      notifyRef?.(`素材が ${missing.length} 個見つかりません（${baseName(missing[0])}${missing.length > 1 ? ' など' : ''}）`, 'error', 'missing-media', {
        label: '場所を選び直す',
        onClick: () => setState({mediaOpen: true}),
      });
  });
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const dirName = (path: string) => path.replace(/[\\/][^\\/]*$/, '');

/** プロジェクトが使っている素材・立ち絵のファイル（書いてあるパスのまま。重複なし） */
export function mediaPaths(project: Project): string[] {
  const list = [
    ...project.clips.flatMap(c => (c.type === 'media' ? [c.src] : [])),
    ...project.characters.flatMap(c => (c.portrait ? [...portraitFiles(c.portrait), c.portrait.psd?.src ?? null] : [])),
  ].filter((x): x is string => !!x);
  return [...new Set(list)];
}

/** 見つからない素材を調べて、状態に入れる */
export async function checkMedia(): Promise<string[]> {
  const s = getState();
  if (!s.project) return [];
  const a = await api;
  const paths = mediaPaths(s.project);
  const stamps = await Promise.all(paths.map(path => a.fileStamp(path, s.projectPath).catch(() => null)));
  const missing = paths.filter((_, i) => stamps[i] === null);
  if (getState().project === s.project) setState({missingMedia: missing});
  return missing;
}

/**
 * 見つからない素材の今の場所を選ぶ。同じフォルダにほかの見つからない素材（同じ名前）があれば、それもまとめてつなぎ直す。
 * つなぎ直した数を返す（やめたら 0）
 */
export async function relinkMedia(old: string): Promise<number> {
  const a = await api;
  const picked = await a.pickRelink(old);
  if (!picked) return 0;
  const map: Record<string, string> = {[old]: picked};
  const dir = dirName(picked);
  const sep = picked.includes('\\') ? '\\' : '/';
  const others = getState().missingMedia.filter(m => m !== old);
  if (others.length) {
    const candidates = others.map(m => `${dir}${sep}${baseName(m)}`);
    await a.allowPaths(candidates);
    const stamps = await Promise.all(candidates.map(c => a.fileStamp(c, null).catch(() => null)));
    others.forEach((m, i) => {
      if (stamps[i] !== null) map[m] = candidates[i];
    });
  }
  relinkPaths(map);
  ensureAllProxies();
  await checkMedia();
  if (!getState().missingMedia.length) clearNotice('missing-media');
  return Object.keys(map).length;
}

/** 素材をプロジェクトの隣のフォルダへ集める（コピー）。PC を移すとき・人に渡すときに、プロジェクトとそのフォルダだけ持っていけばよくなる */
export async function collectMediaAction(notify: Notify): Promise<void> {
  const s = getState();
  if (!s.project || !s.projectPath) return;
  const a = await api;
  setState({busy: {label: '素材を集めています', ratio: null}});
  try {
    const r = await a.collectMedia(s.project, s.projectPath);
    const before = getState().project;
    // 集めている間に編集していたら、素材のパスだけを書き換える
    if (before === s.project) commit(() => r.project);
    else {
      const map: Record<string, string> = {};
      const from = mediaPaths(s.project);
      const to = mediaPaths(r.project);
      if (from.length === to.length) from.forEach((f, i) => (map[f] = to[i]));
      relinkPaths(map);
    }
    await checkMedia();
    notify(r.copied ? `${r.copied} 個の素材を「${baseName(r.dir)}」へコピーしました。プロジェクトを保存すると確定します` : `素材はもう「${baseName(r.dir)}」に集まっています`, 'info');
  } catch (e) {
    notify(friendlyError(e), 'error');
  } finally {
    setState({busy: null});
  }
}

/** 再生位置の画面を、画像 1 枚で書き出す（サムネイル用）。書き出しと同じ絵になる */
export async function exportStill(notify: Notify): Promise<void> {
  const s = getState();
  if (!s.project || s.busy) return;
  const a = await api;
  const base = s.projectPath ? s.projectPath.replace(/\.voxcut$/i, '') : s.project.name || 'image';
  const out = await a.pickSavePath('image', `${base}_${framesToTimecode(s.playhead, s.project.video.fps).replace(/:/g, '-')}.png`);
  if (!out) return;
  stop();
  setState({busy: {label: '画像を書き出しています', ratio: null}});
  try {
    let portraitFrames: ExportRequest['portraitFrames'];
    if (s.project.characters.some(c => c.portrait?.visible && c.portrait.psd)) {
      const {bakePsdFrames} = await import('./psd/portrait');
      portraitFrames = await bakePsdFrames(s.project, s.projectPath, () => {});
    }
    const {bakeItemImages} = await import('./preview/visual');
    const itemImages = await bakeItemImages(withTransitions(s.project));
    const last = Math.max(0, projectDuration(s.project) - 1);
    await a.exportVideo(s.project, s.projectPath, out, {crf: 18, height: null, portraitFrames, itemImages, stillFrame: Math.min(s.playhead, last)});
    notify(`画像を書き出しました：${baseName(out)}`, 'info', 'still', {label: '場所を開く', onClick: () => void a.revealInFolder(out)});
  } catch (e) {
    notify(friendlyError(e), 'error');
  } finally {
    setState({busy: null});
  }
}

export async function openProject(notify: Notify, given?: string) {
  if (!(await confirmDiscard())) return;
  const a = await api;
  const path = given ?? (await a.pickOpenPath());
  if (!path) return;
  try {
    await loadProject(await a.openProject(path), path, false);
    await a.autosaveClear();
    setState({recent: await a.addRecent(path)});
  } catch (e) {
    if (given) {
      // 最近使ったファイルが動かされた・消された
      setState({recent: await a.removeRecent(path)});
      notify(`開けませんでした（${friendlyError(e)}）。一覧から外しました`, 'error');
    } else notify(friendlyError(e), 'error');
  }
}

/** 新規（空のプロジェクト）。sample なら見本の入ったプロジェクトを開く（「ファイル → サンプルを開く」） */
export async function newProjectAction(notify: Notify, sample = false) {
  if (!(await confirmDiscard())) return;
  try {
    await loadProject(await (await api).newProject(sample), null, false);
    await (await api).autosaveClear();
  } catch (e) {
    notify(friendlyError(e), 'error');
  }
}

// ───────────── 自動保存 ─────────────

const AUTOSAVE_MS = 60_000;
let autosaveTimer: ReturnType<typeof setInterval> | undefined;
let lastAutosaved: Project | null = null;

/** 保存していない変更があれば、1 分ごとに書いておく（落ちても次の起動で戻せる） */
function startAutosave() {
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => void autosaveNow(), AUTOSAVE_MS);
}

export async function autosaveNow() {
  const s = getState();
  if (!s.project || !s.dirty || s.project === lastAutosaved) return;
  lastAutosaved = s.project;
  await (await api).autosaveWrite(s.project, s.projectPath).catch(() => {});
}

/** 前回保存せずに終わった作業があれば、戻すか聞く */
async function offerRestore(notify: Notify) {
  const a = await api;
  const saved = await a.autosaveRead().catch(() => null);
  if (!saved) return;
  const when = new Date(saved.savedAt).toLocaleString('ja-JP', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  const name = saved.projectPath?.split(/[\\/]/).pop() ?? saved.project.name;
  if (await a.ask(`前回、保存していない作業が残っています（${name}、${when}）。元に戻しますか？`, '元に戻す')) {
    await loadProject(saved.project, saved.projectPath, true);
    notify('前回の作業を戻しました。保存してください');
  } else {
    await a.autosaveClear();
  }
}

export async function saveProject(notify: Notify, saveAs = false) {
  const s = getState();
  if (!s.project) return;
  const a = await api;
  const path = !saveAs && s.projectPath ? s.projectPath : await a.pickSavePath('project', `${s.project.name}.voxcut`);
  if (!path) return;
  try {
    await a.saveProject(path, s.project);
    // 保存中に編集されていたら、まだ保存していない変更が残っている
    setState(st => ({projectPath: path, dirty: st.project !== s.project}));
    await a.autosaveClear();
    setState({recent: await a.addRecent(path)});
    notify('保存しました');
  } catch (e) {
    notify(friendlyError(e), 'error');
  }
}
