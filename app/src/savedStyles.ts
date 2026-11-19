// 自分で保存した見た目（字幕・文字）。この PC に覚えておき、どのプロジェクト・キャラクターからでも使える。

import {useSyncExternalStore} from 'react';
import type {SubtitleStyle} from './model';
import type {TextLook} from './textStyles';

export interface SavedTextStyle {
  id: string;
  name: string;
  look: TextLook;
}
export interface SavedSubtitleStyle {
  id: string;
  name: string;
  style: SubtitleStyle;
}
interface Saved {
  text: SavedTextStyle[];
  subtitle: SavedSubtitleStyle[];
}

const KEY = 'voxcut.styles.v1';
const MAX = 60;

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    return {text: Array.isArray(v?.text) ? v!.text! : [], subtitle: Array.isArray(v?.subtitle) ? v!.subtitle! : []};
  } catch {
    return {text: [], subtitle: []};
  }
}

let saved: Saved = load();
const listeners = new Set<() => void>();
function put(next: Saved) {
  saved = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 覚えられなくても、このまま使うことはできる
  }
  listeners.forEach(f => f());
}
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** 同じ名前は新しいもので置き換える。名前が空なら「スタイル」 */
const nameOf = (n: string) => n.trim().slice(0, 30) || 'スタイル';

export const useSavedTextStyles = () => useSyncExternalStore(subscribe, () => saved.text);
export const useSavedSubtitleStyles = () => useSyncExternalStore(subscribe, () => saved.subtitle);

export function saveTextStyle(name: string, look: TextLook) {
  const n = nameOf(name);
  put({...saved, text: [...saved.text.filter(s => s.name !== n), {id: newId(), name: n, look: {...look}}].slice(-MAX)});
}
export function removeTextStyle(id: string) {
  put({...saved, text: saved.text.filter(s => s.id !== id)});
}
export function saveSubtitleStyle(name: string, style: SubtitleStyle) {
  const n = nameOf(name);
  put({...saved, subtitle: [...saved.subtitle.filter(s => s.name !== n), {id: newId(), name: n, style: {...style}}].slice(-MAX)});
}
export function removeSubtitleStyle(id: string) {
  put({...saved, subtitle: saved.subtitle.filter(s => s.id !== id)});
}

/** 字幕のスタイルを当てる：見た目をまるごと入れ替え、位置・下の余白・1 行の文字数（配置）は今のままにする */
export function applySubtitleStyle(current: SubtitleStyle, s: SubtitleStyle): SubtitleStyle {
  return {...s, position: current.position, marginV: current.marginV, maxChars: current.maxChars};
}
