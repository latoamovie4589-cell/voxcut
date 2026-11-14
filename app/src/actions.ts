// UI から呼ぶ非同期の操作（IPC ＋ 状態更新）。

import {api, type ExportProgress, type ExportRequest, type MediaInfo} from './ipc';
import type {EngineId, Portrait, Project, VoiceClip} from './model';
import {ENGINE_LABEL, effectiveVoice, isSpeakerMissing, reflowAll, synthKey} from './model';
import {addCharacterFrom, addMediaClips, getState, replaceProject, setState} from './store';
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
/** 動画のプロキシを用意する（作成中・作成済みなら何もしない） */
export async function ensureProxy(src: string) {
  const s = getState();
  if (s.proxies[src]) return;
  const a = await api;
  if (!proxyListening) {
    proxyListening = true;
    await a.onProxyProgress(p => setState(st => (st.proxies[p.src] && !st.proxies[p.src].url ? {proxies: {...st.proxies, [p.src]: {...st.proxies[p.src], ratio: p.ratio}}} : {})));
  }
  setState(st => ({proxies: {...st.proxies, [src]: {ratio: 0, url: null}}}));
  try {
    const info = getState().media[src] ?? (await a.probeMedia(src, getState().projectPath));
    setState(st => ({media: {...st.media, [src]: info}}));
    const url = await a.makeProxy(src, getState().projectPath, info.durationMs ?? 0);
    setState(st => ({proxies: {...st.proxies, [src]: {ratio: 1, url}}}));
  } catch (e) {
    setState(st => ({proxies: {...st.proxies, [src]: {ratio: 0, url: null, error: String(e)}}}));
    notifyRef(`プロキシを作れませんでした：${String(e)}`, 'error');
  }
}

/** プロジェクト内のすべての動画のプロキシを用意する */
function ensureAllProxies() {
  const p = getState().project;
  if (!p) return;
  const srcs = new Set(p.clips.flatMap(c => (c.type === 'media' && c.mediaKind === 'video' ? [c.src] : [])));
  srcs.forEach(src => void ensureProxy(src));
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
      missing.set(c.id, `話者「${ch.voice.speaker}」は ${ENGINE_LABEL[ch.voice.engine]} に入っていません。右のパネルで「${ch.name}」の話者を選び直してください`);
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

async function pump(notify: Notify) {
  if (pumping) return;
  pumping = true;
  const a = await api;
  let failedCount = 0;
  let firstError = '';
  try {
    while (queue.length) {
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
    const itemImages = await bakeItemImages(s.project);
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

export type ExportKind = 'video' | 'audio' | 'subtitle';
const EXT: Record<ExportKind, string> = {video: 'mp4', audio: 'wav', subtitle: 'srt'};

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

/** 保存していない変更を捨ててよいか確かめる */
async function confirmDiscard(): Promise<boolean> {
  if (!getState().dirty) return true;
  return (await api).ask('保存していない変更があります。保存せずに続けますか？', '保存せずに続ける');
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
  setState({project, projectPath: path, dirty, past: [], future: [], selectedClipId: null, playhead: 0, proxies: {}, media: {}, synthErrors: {}});
  ensureAllProxies();
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
