// UI から呼ぶ非同期の操作（IPC ＋ 状態更新）。

import {api, type ExportProgress, type ExportRequest, type MediaInfo} from './ipc';
import type {EngineId, Portrait, Project} from './model';
import {ENGINE_LABEL, isSpeakerMissing, newPortrait} from './model';
import {addCharacterFrom, addMediaClips, getState, replaceProject, setPortrait, setState} from './store';
import {forget, stop} from './preview/playback';

/** key を付けると同じ種類の通知を置き換え、clearNotice(key) で消せる */
export type Notify = (body: string, type?: 'info' | 'error', key?: string) => void;

// 引数で受け取れない場所（ボタンの clickAction など）から使う通知先
let notifyRef: Notify = () => {};
export const setNotify = (n: Notify) => {
  notifyRef = n;
};
/** 通知先（引数で渡せない部品から使う） */
export const getNotify = (): Notify => (body, type, key) => notifyRef(body, type, key);
let clearRef: (key: string) => void = () => {};
export const setClearNotice = (c: (key: string) => void) => {
  clearRef = c;
};
export const clearNotice = (key: string) => clearRef(key);

/** 素材を選んで再生位置に追加 */
export async function addMedia() {
  const a = await api;
  const paths = await a.pickMedia('media', true);
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
    await a.onProxyProgress(p =>
      setState(st => (st.proxies[p.src] && !st.proxies[p.src].url ? {proxies: {...st.proxies, [p.src]: {...st.proxies[p.src], ratio: p.ratio}}} : {})),
    );
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

export async function importCharacterFile(notify: Notify) {
  const a = await api;
  const path = await a.pickCharacterPath('open');
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

/** 立ち絵のパーツを選ぶ。part='base' のときは新しく立ち絵を作る */
export async function pickPortraitPart(characterId: string, part: 'base' | 'eyes' | 'mouth', index = 0) {
  const a = await api;
  const [path] = await a.pickMedia('image', false);
  if (!path) return;
  const ch = getState().project?.characters.find(c => c.id === characterId);
  if (!ch) return;
  if (part === 'base') {
    setPortrait(characterId, ch.portrait ? {...ch.portrait, base: path} : newPortrait(path));
    return;
  }
  if (!ch.portrait) return;
  const list = [...ch.portrait[part]] as Portrait['eyes'];
  list[index] = path;
  setPortrait(characterId, {...ch.portrait, [part]: list});
}

/** Rust から来たエラー文を、利用者向けに短く整える */
export function friendlyError(e: unknown): string {
  const msg = String(e).replace(/^Error:\s*/, '');
  if (/接続できません|NotRunning|起動/.test(msg)) return msg;
  if (/VOICEPEAK/.test(msg) && /Internal BUG|BUG REPORT/i.test(msg))
    return 'VOICEPEAK の中でエラーが起きました。話者がこのPCの VOICEPEAK に入っているか、VOICEPEAK の画面を閉じてから試してください';
  if (/HostNotFound/.test(msg)) return 'A.I.VOICE が見つかりません。インストールされているか確かめてください';
  if (/os error 2|No such file|見つかりません/.test(msg)) return `ファイルが見つかりません（${msg}）`;
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

export async function boot(notify: Notify) {
  const a = await api;
  const project = await a.newProject();
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

export async function synthesize(notify: Notify, clipIds?: string[]) {
  const s = getState();
  if (!s.project || s.busy) return;
  const a = await api;
  clearNotice('synth');
  // このPCのソフトに入っていない話者の行は送らず、分かる言葉で知らせる
  const missing = new Map<string, string>();
  for (const c of s.project.clips) {
    if (c.type !== 'voice' || (clipIds && !clipIds.includes(c.id))) continue;
    const ch = s.project.characters.find(x => x.id === c.characterId);
    if (ch && isSpeakerMissing(ch.voice, s.voices)) {
      missing.set(c.id, `話者「${ch.voice.speaker}」は ${ENGINE_LABEL[ch.voice.engine]} に入っていません。右のパネルで「${ch.name}」の話者を選び直してください`);
    }
  }
  if (missing.size) {
    const ids = (clipIds ?? s.project.clips.filter(c => c.type === 'voice').map(c => c.id)).filter(id => !missing.has(id));
    setState(st => ({synthErrors: {...st.synthErrors, ...Object.fromEntries(missing)}}));
    notify(`${missing.size} 件のセリフを合成できませんでした：${[...missing.values()][0]}`, 'error', 'synth');
    if (!ids.length) return;
    clipIds = ids;
  }
  setState({busy: {label: '音声を合成しています', ratio: 0}});
  const off = await a.onSynthProgress(p => setState({busy: {label: '音声を合成しています', ratio: p.done / Math.max(1, p.total)}}));
  try {
    // 合成中に編集されても上書きしないよう、送った時点の版と比べる
    const sent = s.project;
    const old = new Set(sent.clips.flatMap(c => (c.type === 'voice' && c.audio ? [c.audio.cacheKey] : [])));
    const {project, failed} = await a.synthesize(sent, clipIds);
    project.clips.forEach(c => c.type === 'voice' && c.audio && old.delete(c.audio.cacheKey));
    old.forEach(forget);
    if (getState().project === sent) replaceProject(project);
    else notify('合成中に編集されたため、もう一度合成してください');
    // 失敗した行を覚えておき、タイムライン・台本・右パネルに出す（成功した行は消す）
    setState(st => {
      const errors = {...st.synthErrors};
      for (const c of project.clips) if (c.type === 'voice' && c.audio) delete errors[c.id];
      for (const [id, msg] of failed) errors[id] = friendlyError(msg);
      return {synthErrors: errors};
    });
    if (failed.length) notify(`${failed.length} 件のセリフを合成できませんでした：${friendlyError(failed[0][1])}`, 'error', 'synth');
  } catch (e) {
    notify(friendlyError(e), 'error');
  } finally {
    off();
    setState({busy: null});
  }
}

/** 書き出す。進捗はヘッダーにも出す。取り消されたら 'cancelled' を投げる */
export async function runExport(out: string, options: ExportRequest, onProgress: (p: ExportProgress) => void): Promise<void> {
  const s = getState();
  if (!s.project || s.busy) return;
  stop();
  const a = await api;
  const label = (p: ExportProgress) =>
    p.stage === 'synth' ? '音声を合成しています' : p.stage === 'portrait' ? '立ち絵を準備しています' : '書き出しています';
  setState({busy: {label: '書き出しています', ratio: 0}});
  const off = await a.onExportProgress(p => {
    onProgress(p);
    setState({busy: {label: label(p), ratio: p.stage === 'portrait' ? null : p.ratio}});
  });
  try {
    const project = await a.exportVideo(s.project, s.projectPath, out, options);
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

export async function pickExportPath(): Promise<string | null> {
  const s = getState();
  const a = await api;
  const base = s.projectPath ? s.projectPath.replace(/\.voxcut$/i, '') : s.project?.name ?? 'video';
  return a.pickSavePath('video', `${base}.mp4`);
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
  return [
    ...project.clips.flatMap(c => (c.type === 'media' ? [c.src] : [])),
    ...project.characters.flatMap(c => (c.portrait ? portraitFiles(c.portrait) : [])),
  ].filter((x): x is string => !!x && /^([a-zA-Z]:[\\/]|[\\/])/.test(x));
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

export async function newProjectAction(notify: Notify) {
  if (!(await confirmDiscard())) return;
  try {
    await loadProject(await (await api).newProject(), null, false);
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
