// UI から呼ぶ非同期の操作（IPC ＋ 状態更新）。

import {api, type ExportProgress, type ExportRequest, type MediaInfo} from './ipc';
import type {EngineId, Portrait} from './model';
import {newPortrait} from './model';
import {addMediaClips, getState, replaceProject, setPortrait, setState} from './store';
import {forget, stop} from './preview/playback';

export type Notify = (body: string, type?: 'info' | 'error') => void;

// 引数で受け取れない場所（ボタンの clickAction など）から使う通知先
let notifyRef: Notify = () => {};
export const setNotify = (n: Notify) => {
  notifyRef = n;
};

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
  if (/HostNotFound/.test(msg)) return 'A.I.VOICE が見つかりません。インストールされているか確かめてください';
  if (/os error 2|No such file|見つかりません/.test(msg)) return `ファイルが見つかりません（${msg}）`;
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

export async function boot() {
  const a = await api;
  const project = await a.newProject();
  setState({project, dirty: false, past: [], future: [], selectedCharacterId: project.characters[0]?.id ?? null});
  void refreshEngines();
}

export async function refreshEngines() {
  const a = await api;
  const engines = await a.engineStatus();
  setState({engines});
  // 使えるエンジンの話者一覧を並列に取得
  await Promise.all(
    engines
      .filter(e => e.status.state === 'ready')
      .map(e =>
        a
          .listVoices(e.engine)
          .then(v => setState(s => ({voices: {...s.voices, [e.engine]: v}})))
          .catch(() => {}),
      ),
  );
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
    if (failed.length) notify(`${failed.length} 件のセリフを合成できませんでした：${friendlyError(failed[0][1])}`, 'error');
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

export async function openProject(notify: Notify) {
  const a = await api;
  const path = await a.pickOpenPath();
  if (!path) return;
  try {
    stop();
    const project = await a.openProject(path);
    // プロジェクトのフォルダ外にある素材・立ち絵もプレビューで読めるようにする
    const paths = [
      ...project.clips.flatMap(c => (c.type === 'media' ? [c.src] : [])),
      ...project.characters.flatMap(c => (c.portrait ? [c.portrait.base, ...c.portrait.eyes, ...c.portrait.mouth] : [])),
    ].filter((x): x is string => !!x && /^([a-zA-Z]:[\\/]|[\\/])/.test(x));
    if (paths.length) await a.allowPaths(paths);
    setState({project, projectPath: path, dirty: false, past: [], future: [], selectedClipId: null, playhead: 0, proxies: {}, media: {}});
    ensureAllProxies();
  } catch (e) {
    notify(friendlyError(e), 'error');
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
    setState({projectPath: path, dirty: false});
    notify('保存しました');
  } catch (e) {
    notify(friendlyError(e), 'error');
  }
}
