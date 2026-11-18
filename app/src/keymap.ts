// キー操作の割り当て（ショートカットを自分のキーに変えられる）。既定と、変えた分だけを覚える

import {useSyncExternalStore} from 'react';

export type ActionId =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'undo'
  | 'redo'
  | 'focusInput'
  | 'find'
  | 'replace'
  | 'shortcuts'
  | 'play'
  | 'stop'
  | 'shuttleForward'
  | 'shuttleBackward'
  | 'frameBack'
  | 'frameForward'
  | 'secondBack'
  | 'secondForward'
  | 'prevEdit'
  | 'nextEdit'
  | 'toStart'
  | 'toEnd'
  | 'marker'
  | 'split'
  | 'delete'
  | 'selectAll'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate';

export interface ActionDef {
  id: ActionId;
  label: string;
  group: string;
  keys: string[];
  /** 文字を打っている間も効かせる（保存・開くなど） */
  whileTyping?: boolean;
  /** 矢印キーなど、境目・タブ・一覧の中では部品の操作に譲るもの */
  nav?: boolean;
}

export const ACTIONS: ActionDef[] = [
  {id: 'new', label: '新規', group: 'ファイル', keys: ['Mod+N'], whileTyping: true},
  {id: 'open', label: '開く', group: 'ファイル', keys: ['Mod+O'], whileTyping: true},
  {id: 'save', label: '保存', group: 'ファイル', keys: ['Mod+S'], whileTyping: true},
  {id: 'saveAs', label: '名前を付けて保存', group: 'ファイル', keys: ['Mod+Shift+S'], whileTyping: true},
  {id: 'undo', label: '元に戻す', group: '編集', keys: ['Mod+Z']},
  {id: 'redo', label: 'やり直す', group: '編集', keys: ['Mod+Shift+Z', 'Mod+Y']},
  {id: 'selectAll', label: 'すべて選ぶ', group: '編集', keys: ['Mod+A']},
  {id: 'copy', label: '写す', group: '編集', keys: ['Mod+C']},
  {id: 'cut', label: '切り取る', group: '編集', keys: ['Mod+X']},
  {id: 'paste', label: '貼り付ける', group: '編集', keys: ['Mod+V']},
  {id: 'duplicate', label: '複製', group: '編集', keys: ['Mod+D']},
  {id: 'delete', label: '選んだものを消す', group: '編集', keys: ['Delete', 'Backspace']},
  {id: 'split', label: '素材を再生位置で分ける', group: '編集', keys: ['S']},
  {id: 'marker', label: '再生位置にマーカーを付ける', group: '編集', keys: ['M']},
  {id: 'play', label: '再生・停止', group: '再生', keys: ['Space']},
  {id: 'stop', label: '停止', group: '再生', keys: ['K']},
  {id: 'shuttleForward', label: '再生（押すたびに速く）', group: '再生', keys: ['L']},
  {id: 'shuttleBackward', label: '逆再生（押すたびに速く）', group: '再生', keys: ['J']},
  {id: 'frameBack', label: '1 コマ戻る', group: '再生', keys: ['ArrowLeft'], nav: true},
  {id: 'frameForward', label: '1 コマ進む', group: '再生', keys: ['ArrowRight'], nav: true},
  {id: 'secondBack', label: '1 秒戻る', group: '再生', keys: ['Shift+ArrowLeft'], nav: true},
  {id: 'secondForward', label: '1 秒進む', group: '再生', keys: ['Shift+ArrowRight'], nav: true},
  {id: 'prevEdit', label: '前の編集点へ', group: '再生', keys: ['ArrowUp'], nav: true},
  {id: 'nextEdit', label: '次の編集点へ', group: '再生', keys: ['ArrowDown'], nav: true},
  {id: 'toStart', label: '先頭へ', group: '再生', keys: ['Home'], nav: true},
  {id: 'toEnd', label: '最後へ', group: '再生', keys: ['End'], nav: true},
  {id: 'focusInput', label: 'セリフ入力欄へ', group: '台本', keys: ['Mod+L'], whileTyping: true},
  {id: 'find', label: '台本を探す', group: '台本', keys: ['Mod+F'], whileTyping: true},
  {id: 'replace', label: '台本の文を置き換える', group: '台本', keys: ['Mod+H'], whileTyping: true},
  {id: 'shortcuts', label: 'ショートカットの一覧', group: '台本', keys: ['?', 'Mod+/']},
];

export const ACTION: Record<ActionId, ActionDef> = Object.fromEntries(ACTIONS.map(a => [a.id, a])) as Record<ActionId, ActionDef>;

const STORE = 'vx-keymap';
const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

function load(): Partial<Record<ActionId, string[]>> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

let overrides = load();
let version = 0;
const subs = new Set<() => void>();
function changed() {
  version++;
  try {
    localStorage.setItem(STORE, JSON.stringify(overrides));
  } catch {
    // 保存できない環境でも、開いている間は効かせる
  }
  subs.forEach(f => f());
}

/** その操作に今割り当てているキー */
export function keysFor(id: ActionId): string[] {
  return overrides[id] ?? ACTION[id].keys;
}

/** 変えたかどうか */
export function isCustom(id: ActionId): boolean {
  return overrides[id] !== undefined;
}

/** キーを割り当てる。ほかの操作が同じキーを使っていたら、そちらからは外す（外した操作を返す） */
export function assignKey(id: ActionId, combo: string, add = false): ActionId[] {
  const taken: ActionId[] = [];
  for (const a of ACTIONS) {
    if (a.id === id) continue;
    const ks = keysFor(a.id);
    if (ks.includes(combo)) {
      overrides[a.id] = ks.filter(k => k !== combo);
      taken.push(a.id);
    }
  }
  overrides[id] = add ? [...keysFor(id).filter(k => k !== combo), combo] : [combo];
  changed();
  return taken;
}

/** 割り当てを外す（キーなし） */
export function clearKeys(id: ActionId) {
  overrides[id] = [];
  changed();
}

/** 既定に戻す（id がなければすべて） */
export function resetKeys(id?: ActionId) {
  if (id) delete overrides[id];
  else overrides = {};
  changed();
}

/** 押したキーを「Mod+Shift+S」のような文字に。修飾キーだけのときは null */
export function comboOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift', 'OS', 'AltGraph', 'CapsLock', 'Process', 'Unidentified', 'Dead'].includes(e.key)) return null;
  let k: string;
  let shift = e.shiftKey;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (letter) k = letter[1];
  else if (digit) k = digit[1];
  else if (e.key === ' ') k = 'Space';
  else if (e.key.length === 1) {
    // 記号は Shift を押した結果の文字そのもの（? など）で見る
    k = e.key.toUpperCase();
    shift = false;
  } else k = e.key;
  const mods = [e.ctrlKey || e.metaKey ? 'Mod' : '', e.altKey ? 'Alt' : '', shift ? 'Shift' : ''].filter(Boolean);
  return [...mods, k].join('+');
}

/** 押したキーに割り当てている操作 */
export function actionFor(e: KeyboardEvent): ActionId | null {
  const c = comboOf(e);
  if (!c) return null;
  for (const a of ACTIONS) if (keysFor(a.id).includes(c)) return a.id;
  return null;
}

const NAMES: Record<string, string> = {ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Delete: 'Delete', Backspace: 'Backspace', Escape: 'Esc'};

/** 見せるための表記（Mac は ⌘ ⇧ ⌥） */
export function comboLabel(c: string): string {
  // 「Mod++」のように + そのものを割り当てたときも読めるように、最後の 1 文字の手前で分ける
  const cut = c === '+' ? -1 : c.length > 1 && c.endsWith('+') ? c.length - 2 : c.lastIndexOf('+');
  const key = cut < 0 ? c : c.slice(cut + 1);
  const parts = cut < 0 ? [] : c.slice(0, cut).split('+');
  const name = NAMES[key] ?? key;
  if (isMac) {
    const sym = {Mod: '⌘', Alt: '⌥', Shift: '⇧'} as Record<string, string>;
    return parts.map(p => sym[p] ?? p).join('') + name;
  }
  return [...parts.map(p => (p === 'Mod' ? 'Ctrl' : p)), name].join('+');
}

/** その操作のキーの表記（いくつもあれば / でつなぐ。なければ空） */
export function keyLabel(id: ActionId): string {
  return keysFor(id).map(comboLabel).join(' / ');
}

/** 割り当てが変わったら描き直す */
export function useKeymap(): number {
  return useSyncExternalStore(
    f => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
}
