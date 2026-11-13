// パネルの配置（Premiere Pro と同じ考え方）。
// 画面は「分割（横並び・縦並び）」と「パネルグループ（タブで切り替える枠）」の木でできていて、
// タブをドラッグして別の枠の中央（タブとして足す）や上下左右（枠を分けて置く）へ動かせる。
// ワークスペース（配置のひな形）を選んだり、今の配置を名前を付けて残したりできる。配置はこの PC に保存する。

import {useSyncExternalStore} from 'react';

export const PANEL_IDS = ['characters', 'script', 'engines', 'preview', 'timeline', 'inspector'] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const PANEL_TITLE: Record<PanelId, string> = {
  characters: 'キャラクター',
  script: '台本',
  engines: '音声合成ソフト',
  preview: 'プレビュー',
  timeline: 'タイムライン',
  inspector: 'プロパティ',
};

export type Group = {
  kind: 'group';
  id: string;
  tabs: PanelId[];
  active: PanelId;
};
export type Split = {
  kind: 'split';
  id: string;
  dir: 'row' | 'column';
  children: DockNode[];
  sizes: number[];
};
export type DockNode = Group | Split;
export type Zone = 'center' | 'left' | 'right' | 'top' | 'bottom';

let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const g = (...tabs: PanelId[]): Group => ({
  kind: 'group',
  id: nid('g'),
  tabs,
  active: tabs[0],
});
const sp = (dir: Split['dir'], parts: [DockNode, number][]): Split => ({
  kind: 'split',
  id: nid('s'),
  dir,
  children: parts.map(p => p[0]),
  sizes: parts.map(p => p[1]),
});

// ---- ワークスペース（ひな形） ----

export const PRESETS: {id: string; name: string; make: () => DockNode}[] = [
  {
    // YMM4 の初期配置：左上にプレビュー、その下にタイムライン（一番下にセリフ入力欄）、右にアイテムのプロパティ
    id: 'edit',
    name: '標準（YMM4）',
    make: () =>
      sp('row', [
        [
          sp('column', [
            [g('preview'), 0.52],
            [g('timeline'), 0.48],
          ]),
          0.74,
        ],
        [g('inspector', 'script', 'characters', 'engines'), 0.26],
      ]),
  },
  {
    id: 'timeline',
    name: 'タイムライン優先',
    make: () =>
      sp('column', [
        [
          sp('row', [
            [g('preview'), 0.72],
            [g('inspector', 'script', 'characters', 'engines'), 0.28],
          ]),
          0.46,
        ],
        [g('timeline'), 0.54],
      ]),
  },
  {
    id: 'script',
    name: '台本',
    make: () =>
      sp('row', [
        [g('script', 'characters', 'engines'), 0.26],
        [
          sp('column', [
            [g('preview'), 0.5],
            [g('timeline'), 0.5],
          ]),
          0.5,
        ],
        [g('inspector'), 0.24],
      ]),
  },
  {
    id: 'preview',
    name: 'プレビュー大きめ',
    make: () =>
      sp('column', [
        [
          sp('row', [
            [g('preview'), 0.76],
            [g('inspector', 'script', 'characters', 'engines'), 0.24],
          ]),
          0.64,
        ],
        [g('timeline'), 0.36],
      ]),
  },
];

// ---- 木の操作（すべて新しい木を返す） ----

export function groups(n: DockNode): Group[] {
  return n.kind === 'group' ? [n] : n.children.flatMap(groups);
}
export function panelsIn(n: DockNode): PanelId[] {
  return groups(n).flatMap(x => x.tabs);
}
export function findGroupOf(n: DockNode, pid: PanelId): Group | undefined {
  return groups(n).find(x => x.tabs.includes(pid));
}

/** 1 つしか子がない分割をほどき、同じ向きの分割の入れ子を平らにし、比率を合計 1 にそろえる */
function normalize(n: DockNode): DockNode | null {
  if (n.kind === 'group') return n.tabs.length ? n : null;
  const kids: DockNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const m = normalize(c);
    if (!m) return;
    if (m.kind === 'split' && m.dir === n.dir) {
      m.children.forEach((cc, j) => {
        kids.push(cc);
        sizes.push(n.sizes[i] * m.sizes[j]);
      });
    } else {
      kids.push(m);
      sizes.push(n.sizes[i]);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return {...n, children: kids, sizes: sizes.map(s => s / sum)};
}

function mapGroups(n: DockNode, f: (x: Group) => Group): DockNode {
  return n.kind === 'group' ? f(n) : {...n, children: n.children.map(c => mapGroups(c, f))};
}

export function removePanel(root: DockNode, pid: PanelId): DockNode | null {
  return normalize(
    mapGroups(root, x => {
      if (!x.tabs.includes(pid)) return x;
      const i = x.tabs.indexOf(pid);
      const tabs = x.tabs.filter(t => t !== pid);
      return {
        ...x,
        tabs,
        active: x.active === pid ? tabs[Math.min(i, tabs.length - 1)] : x.active,
      };
    }),
  );
}

/** pid を targetGroup の zone へ。center はタブとして足し（index でタブの位置）、上下左右は枠を分ける */
export function dockPanel(root: DockNode, pid: PanelId, targetGroupId: string, zone: Zone, index?: number): DockNode {
  const from = findGroupOf(root, pid);
  // 自分だけの枠を自分の端に置いても何も変わらない
  if (from?.id === targetGroupId && from.tabs.length === 1) return root;
  if (from?.id === targetGroupId && zone === 'center') {
    // 同じ枠の中央なら何もしない。タブの並びの上なら並べ替え
    if (index === undefined) return root;
    return mapGroups(root, x => {
      if (x.id !== targetGroupId) return x;
      const was = x.tabs.indexOf(pid);
      const tabs = x.tabs.filter(t => t !== pid);
      const at = Math.max(0, Math.min(tabs.length, was < index ? index - 1 : index));
      tabs.splice(at, 0, pid);
      return {...x, tabs, active: pid};
    });
  }
  const without = from ? removePanel(root, pid) : root;
  if (!without) return root;
  if (zone === 'center') {
    return mapGroups(without, x => {
      if (x.id !== targetGroupId) return x;
      const tabs = [...x.tabs];
      tabs.splice(Math.max(0, Math.min(tabs.length, index ?? tabs.length)), 0, pid);
      return {...x, tabs, active: pid};
    });
  }
  const dir: Split['dir'] = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const before = zone === 'left' || zone === 'top';
  const fresh = g(pid);
  const place = (n: DockNode): DockNode => {
    if (n.kind === 'group') {
      if (n.id !== targetGroupId) return n;
      return sp(
        dir,
        before
          ? [
              [fresh, 0.5],
              [n, 0.5],
            ]
          : [
              [n, 0.5],
              [fresh, 0.5],
            ],
      );
    }
    // 同じ向きの分割の中なら、兄弟として隣に差し込む（target の幅を半分ずつ）
    const i = n.children.findIndex(c => c.kind === 'group' && c.id === targetGroupId);
    if (i >= 0 && n.dir === dir) {
      const children = [...n.children];
      const sizes = [...n.sizes];
      const half = sizes[i] / 2;
      sizes[i] = half;
      children.splice(before ? i : i + 1, 0, fresh);
      sizes.splice(before ? i : i + 1, 0, half);
      return {...n, children, sizes};
    }
    return {...n, children: n.children.map(place)};
  };
  return normalize(place(without)) ?? root;
}

/**
 * pid を画面全体の端に置く（上から下まで・左から右まで通し）。share はその枠の大きさ（全体に対する割合）
 */
export function dockToEdge(root: DockNode, pid: PanelId, edge: Exclude<Zone, 'center'>, share = 0.22): DockNode {
  const from = findGroupOf(root, pid);
  // 自分しかいない画面なら何もしない
  if (from && groups(root).length === 1 && from.tabs.length === 1) return root;
  const rest = from ? removePanel(root, pid) : root;
  if (!rest) return root;
  const dir: Split['dir'] = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const before = edge === 'left' || edge === 'top';
  const fresh = g(pid);
  if (rest.kind === 'split' && rest.dir === dir) {
    const sizes = rest.sizes.map(x => x * (1 - share));
    return normalize({...rest, children: before ? [fresh, ...rest.children] : [...rest.children, fresh], sizes: before ? [share, ...sizes] : [...sizes, share]}) ?? root;
  }
  return (
    normalize(
      sp(
        dir,
        before
          ? [
              [fresh, share],
              [rest, 1 - share],
            ]
          : [
              [rest, 1 - share],
              [fresh, share],
            ],
      ),
    ) ?? root
  );
}

export function setActive(root: DockNode, groupId: string, pid: PanelId): DockNode {
  return mapGroups(root, x => (x.id === groupId && x.tabs.includes(pid) ? {...x, active: pid} : x));
}

export function setSizes(root: DockNode, splitId: string, sizes: number[]): DockNode {
  const f = (n: DockNode): DockNode => (n.kind === 'group' ? n : n.id === splitId ? {...n, sizes} : {...n, children: n.children.map(f)});
  return f(root);
}

/** 読み込んだ配置が壊れていないか（パネルの重複・知らないパネル・空の枠がない） */
function valid(n: unknown, seen: Set<string>): n is DockNode {
  if (!n || typeof n !== 'object') return false;
  const o = n as Record<string, unknown>;
  if (o.kind === 'group') {
    if (!Array.isArray(o.tabs) || !o.tabs.length || typeof o.id !== 'string') return false;
    for (const t of o.tabs) {
      if (!(PANEL_IDS as readonly string[]).includes(t as string) || seen.has(t as string)) return false;
      seen.add(t as string);
    }
    return o.tabs.includes(o.active);
  }
  if (o.kind === 'split') {
    const c = o.children;
    const s = o.sizes;
    return (
      (o.dir === 'row' || o.dir === 'column') &&
      Array.isArray(c) &&
      Array.isArray(s) &&
      c.length === s.length &&
      c.length > 0 &&
      s.every(v => typeof v === 'number' && v > 0) &&
      c.every(x => valid(x, seen))
    );
  }
  return false;
}

// ---- 状態（元に戻す・やり直すの対象にはしない） ----

type Saved = {name: string; root: DockNode};
type DockState = {
  root: DockNode;
  /** 今のワークスペース（プリセットの id か、保存したものの名前） */
  workspace: string;
  saved: Saved[];
  /** 最大化している枠（` キー／タブのダブルクリック） */
  maximized: string | null;
  /** 最後に触った枠（青い枠で示す。` キーの対象） */
  focused: string | null;
  /** 別ウィンドウに切り離しているパネル（保存しない。次の起動ではメインウィンドウに戻る） */
  floating: PanelId[];
};

// YMM4 と同じ初期配置にしたので v2（前の配置は引き継がない）
const KEY = 'voxcut.dock.v2';

function load(): DockState {
  const fresh: DockState = {
    root: PRESETS[0].make(),
    workspace: 'edit',
    saved: [],
    maximized: null,
    focused: null,
    floating: [],
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw) return fresh;
    const saved: Saved[] = Array.isArray(raw.saved) ? raw.saved.filter((x: Saved) => typeof x?.name === 'string' && valid(x.root, new Set())) : [];
    const root = valid(raw.root, new Set()) ? (normalize(raw.root) ?? fresh.root) : fresh.root;
    return {
      ...fresh,
      root,
      saved,
      workspace: typeof raw.workspace === 'string' ? raw.workspace : 'edit',
    };
  } catch {
    return fresh;
  }
}

let state: DockState = load();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function getDock() {
  return state;
}
export function setDock(patch: Partial<DockState> | ((s: DockState) => Partial<DockState>)) {
  state = {...state, ...(typeof patch === 'function' ? patch(state) : patch)};
  if (state.maximized && !groups(state.root).some(x => x.id === state.maximized)) state = {...state, maximized: null};
  listeners.forEach(l => l());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          root: state.root,
          workspace: state.workspace,
          saved: state.saved,
        }),
      );
    } catch {
      // 保存できなくても、この起動中は今の配置で使える
    }
  }, 300);
}
export function useDock<T>(sel: (s: DockState) => T): T {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
  );
}

export function updateRoot(f: (r: DockNode) => DockNode | null) {
  setDock(s => ({root: f(s.root) ?? s.root}));
}

/** ワークスペースを切り替える（プリセットの id か保存した名前） */
export function applyWorkspace(name: string) {
  const preset = PRESETS.find(p => p.id === name);
  const saved = state.saved.find(x => x.name === name);
  let root: DockNode | null = preset ? preset.make() : saved ? structuredClone(saved.root) : null;
  // 別ウィンドウにあるパネルは、そのまま別ウィンドウに置いておく
  for (const f of state.floating) if (root) root = removePanel(root, f);
  if (root) setDock({root, workspace: name, maximized: null});
}
/** 今のワークスペースを、ひな形（保存した時点）の配置に戻す */
export function resetWorkspace() {
  applyWorkspace(PRESETS.some(p => p.id === state.workspace) || state.saved.some(x => x.name === state.workspace) ? state.workspace : 'edit');
}
export function saveWorkspace(name: string) {
  const n = name.trim();
  if (!n) return;
  setDock(s => ({
    saved: [...s.saved.filter(x => x.name !== n), {name: n, root: structuredClone(s.root)}],
    workspace: n,
  }));
}
export function deleteWorkspace(name: string) {
  setDock(s => ({
    saved: s.saved.filter(x => x.name !== name),
    workspace: s.workspace === name ? 'edit' : s.workspace,
  }));
}
export function workspaceName(id: string) {
  return PRESETS.find(p => p.id === id)?.name ?? id;
}

/** 閉じたパネルを戻すときの置き場所：いつも一緒にいるパネルの枠へタブとして。いなければ右端に新しい枠 */
const HOME: Record<PanelId, PanelId[]> = {
  characters: ['script', 'engines', 'inspector'],
  script: ['characters', 'engines', 'inspector'],
  engines: ['characters', 'script', 'inspector'],
  preview: ['timeline', 'inspector'],
  timeline: ['preview', 'inspector'],
  inspector: ['characters', 'script'],
};

/** パネルを見せる：開いていればそのタブを前に、閉じていれば戻す */
export function showPanel(pid: PanelId) {
  const s = state;
  if (s.floating.includes(pid)) return; // 別ウィンドウで開いている
  const at = findGroupOf(s.root, pid);
  if (at) {
    setDock({
      root: setActive(s.root, at.id, pid),
      maximized: s.maximized && s.maximized !== at.id ? null : s.maximized,
      focused: at.id,
    });
    return;
  }
  const near = HOME[pid].map(h => findGroupOf(s.root, h)).find(Boolean);
  if (near && pid !== 'preview' && pid !== 'timeline') {
    setDock({
      root: dockPanel(s.root, pid, near.id, 'center'),
      maximized: null,
    });
    return;
  }
  // プレビューとタイムラインは上下に分けて、ほかは右端に足す
  if (near) {
    setDock({
      root: dockPanel(s.root, pid, near.id, pid === 'preview' ? 'top' : 'bottom'),
      maximized: null,
    });
    return;
  }
  const fresh = g(pid);
  const root: DockNode =
    s.root.kind === 'split' && s.root.dir === 'row'
      ? {
          ...s.root,
          children: [...s.root.children, fresh],
          sizes: [...s.root.sizes.map(x => x * 0.78), 0.22],
        }
      : sp('row', [
          [s.root, 0.78],
          [fresh, 0.22],
        ]);
  setDock({root: normalize(root) ?? s.root, maximized: null});
}
export function closePanel(pid: PanelId) {
  updateRoot(r => {
    const next = removePanel(r, pid);
    return next; // 最後の 1 つは閉じない（null → そのまま）
  });
}
export function isOpen(pid: PanelId) {
  return panelsIn(state.root).includes(pid) || state.floating.includes(pid);
}
export function toggleMaximize(groupId: string | null) {
  setDock(s => ({maximized: s.maximized ? null : groupId}));
}
