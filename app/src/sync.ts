// パネルを別ウィンドウに切り離す仕組み（Premiere Pro のフローティングパネル）。
// メインウィンドウ（ホスト）がプロジェクト・元に戻す履歴・再生を持ち、切り離したウィンドウ（ゲスト）は
// 同じ状態を映して、変更をホストへ送る。やりとりは同じアプリの中だけで届く BroadcastChannel で行う。
//   ホスト → ゲスト：{t:'patch', patch, origin}（変わった項目だけ。origin はその変更を起こしたゲスト）
//   ゲスト → ホスト：{t:'hello'} / {t:'set', patch} / {t:'commit', project, key} / {t:'call', name, args} / {t:'closed', panel}

import {applyRemote, commit, getState, redo, setRemote, setState, subscribeStore, undo, type State} from './store';
import type {Project} from './model';
import {jumpTo, jumpToEdit, play, shuttleBackward, shuttleForward, step, stop, toggle} from './preview/playback';
import {PANEL_TITLE, findGroupOf, getDock, groups, removePanel, setDock, showPanel, type PanelId} from './dock/layout';
import {isTauri} from './ipc';

const CHANNEL = 'voxcut-sync';

/** ウィンドウごとの状態（共有しない）：開いている画面・ドロップ中の表示・元に戻す履歴（ホストだけが持つ） */
const LOCAL = new Set<keyof State>([
  'past',
  'future',
  'pasteOpen',
  'pasteText',
  'dictionaryOpen',
  'shortcutsOpen',
  'characterDialogOpen',
  'dialogCharacterId',
  'workspaceDialogOpen',
  'dropActive',
  'previewFull',
]);

type Msg =
  | {t: 'patch'; patch: Partial<State>; origin: string | null; to?: string}
  | {t: 'hello'; from: string}
  | {t: 'set'; patch: Partial<State>; from: string}
  | {t: 'commit'; project: Project; key?: string; from: string}
  | {t: 'call'; name: string; args: unknown[]; from: string}
  | {t: 'closed'; panel: PanelId; from: string};

function shared(patch: Partial<State>): Partial<State> {
  const out: Partial<State> = {};
  for (const k of Object.keys(patch) as (keyof State)[]) if (!LOCAL.has(k)) (out as Record<string, unknown>)[k] = patch[k];
  return out;
}

// ───────────── ホスト（メインウィンドウ） ─────────────

const CALLS: Record<string, (...a: never[]) => unknown> = {undo, redo, play, stop, toggle, shuttleForward, shuttleBackward, step, jumpTo, jumpToEdit};

let host: BroadcastChannel | null = null;
/** 今当てている変更を起こしたゲスト（そのゲストには送り返さない） */
let origin: string | null = null;

export function startHost() {
  if (host || typeof BroadcastChannel === 'undefined') return;
  host = new BroadcastChannel(CHANNEL);
  let last = getState();
  subscribeStore(() => {
    const now = getState();
    if (!host || !getDock().floating.length) {
      last = now;
      return;
    }
    const patch: Partial<State> = {};
    let n = 0;
    for (const k of Object.keys(now) as (keyof State)[]) {
      if (LOCAL.has(k) || now[k] === last[k]) continue;
      (patch as Record<string, unknown>)[k] = now[k];
      n++;
    }
    last = now;
    if (n) host.postMessage({t: 'patch', patch, origin} satisfies Msg);
  });
  host.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    origin = 'from' in m ? m.from : null;
    try {
      if (m.t === 'hello') host!.postMessage({t: 'patch', patch: shared(getState()), origin: null, to: m.from} satisfies Msg);
      else if (m.t === 'set') setState(shared(m.patch));
      else if (m.t === 'commit') commit(() => m.project, m.key);
      else if (m.t === 'call') (CALLS[m.name] as ((...a: unknown[]) => unknown) | undefined)?.(...m.args);
      else if (m.t === 'closed') dockBack(m.panel);
    } finally {
      origin = null;
    }
  };
}

/** 切り離したウィンドウ（パネル → ウィンドウ） */
const windows = new Map<PanelId, {close: () => void; focus: () => void}>();

/** パネルを別ウィンドウに切り離す。最後の 1 つは切り離さない */
export async function floatPanel(pid: PanelId) {
  const open = windows.get(pid);
  if (open) {
    open.focus();
    return;
  }
  const d = getDock();
  const at = findGroupOf(d.root, pid);
  const rest = removePanel(d.root, pid);
  if (!at || !rest) return;
  startHost();
  // ドックの枠の大きさをそのまま、新しいウィンドウの大きさにする
  const el = document.querySelector(`[data-dock-group="${at.id}"]`)?.getBoundingClientRect();
  const width = Math.round(Math.max(480, el?.width ?? 800));
  const height = Math.round(Math.max(360, el?.height ?? 600));
  setDock(s => ({root: rest, floating: [...s.floating, pid], maximized: null}));
  const url = `index.html?float=${pid}`;
  const title = `${PANEL_TITLE[pid]} — VoxCut`;
  if (isTauri) {
    const {WebviewWindow} = await import('@tauri-apps/api/webviewWindow');
    const w = new WebviewWindow(`float-${pid}`, {url, title, width, height, minWidth: 320, minHeight: 240});
    windows.set(pid, {close: () => void w.close(), focus: () => void w.setFocus()});
    void w.once('tauri://destroyed', () => dockBack(pid));
    void w.once('tauri://error', () => dockBack(pid));
  } else {
    const w = window.open(`?float=${pid}`, `float-${pid}`, `popup,width=${width},height=${height}`);
    if (!w) {
      dockBack(pid);
      return;
    }
    windows.set(pid, {close: () => w.close(), focus: () => w.focus()});
    const timer = setInterval(() => {
      if (w.closed) {
        clearInterval(timer);
        dockBack(pid);
      }
    }, 500);
  }
}

/** 切り離したパネルをメインウィンドウへ戻す（ウィンドウが閉じたときも） */
export function dockBack(pid: PanelId) {
  const w = windows.get(pid);
  windows.delete(pid);
  if (!getDock().floating.includes(pid)) return;
  setDock(s => ({floating: s.floating.filter(x => x !== pid)}));
  showPanel(pid);
  w?.close();
}

/** 切り離したウィンドウを閉じる（パネルは閉じたまま） */
export function closeFloating(pid: PanelId) {
  const w = windows.get(pid);
  windows.delete(pid);
  setDock(s => ({floating: s.floating.filter(x => x !== pid)}));
  w?.close();
}

export const floatingPanels = () => getDock().floating;
export const canFloat = (pid: PanelId) => {
  const d = getDock();
  return !!findGroupOf(d.root, pid) && groups(d.root).flatMap(x => x.tabs).length > 1;
};

// ───────────── ゲスト（切り離したウィンドウ） ─────────────

/** このウィンドウが切り離したパネルなら、そのパネル */
export function floatingPanelOfThisWindow(): PanelId | null {
  const v = new URLSearchParams(location.search).get('float');
  return v && v in PANEL_TITLE ? (v as PanelId) : null;
}

export function startGuest(panel: PanelId) {
  const me = `${panel}-${Math.random().toString(36).slice(2, 8)}`;
  const ch = new BroadcastChannel(CHANNEL);
  const send = (m: Msg) => ch.postMessage(m);
  setRemote({
    set: patch => {
      const p = shared(patch);
      if (Object.keys(p).length) send({t: 'set', patch: p, from: me});
    },
    commit: (project, key) => send({t: 'commit', project, key, from: me}),
    call: (name, args) => send({t: 'call', name, args, from: me}),
  });
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (m.t !== 'patch') return;
    if (m.to && m.to !== me) return;
    if (m.origin === me) return; // 自分が起こした変更は、もう当ててある
    applyRemote(m.patch);
  };
  send({t: 'hello', from: me});
  addEventListener('pagehide', () => send({t: 'closed', panel, from: me}));
  return {
    /** メインウィンドウへ戻す */
    dock: () => send({t: 'closed', panel, from: me}),
  };
}
