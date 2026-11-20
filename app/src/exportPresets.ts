// 自分で保存した書き出しの設定。この PC に覚えておき、どのプロジェクトからでも使える。

import {useSyncExternalStore} from 'react';

export interface SavedExport {
  id: string;
  name: string;
  what: 'video' | 'gif' | 'audio' | 'subtitle';
  /** 出力の高さの上限（プロジェクトのままなら 99999） */
  maxHeight: number;
  quality: 'high' | 'normal' | 'light';
  loudness: string;
  backdrop: 'fill' | 'mov' | 'webm';
}

const KEY = 'voxcut.export.presets.v1';
const MAX = 30;
const WHAT = ['video', 'gif', 'audio', 'subtitle'];
const QUALITY = ['high', 'normal', 'light'];
const BACKDROP = ['fill', 'mov', 'webm'];

const valid = (s: unknown): s is SavedExport => {
  const x = s as SavedExport | null;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && WHAT.includes(x.what) && QUALITY.includes(x.quality) && BACKDROP.includes(x.backdrop) && typeof x.loudness === 'string' && x.maxHeight > 0;
};

function load(): SavedExport[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(valid) : [];
  } catch {
    return [];
  }
}

let saved: SavedExport[] = load();
const listeners = new Set<() => void>();
function put(next: SavedExport[]) {
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

export const getSavedExports = () => saved;
export const useSavedExports = () => useSyncExternalStore(subscribe, () => saved);

/** 同じ名前は新しいもので置き換える。名前が空なら「マイ設定」。保存した id を返す */
export function saveExportPreset(name: string, s: Omit<SavedExport, 'id' | 'name'>): string {
  const n = name.trim().slice(0, 30) || 'マイ設定';
  const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  put([...saved.filter(x => x.name !== n), {...s, id, name: n}].slice(-MAX));
  return id;
}

export function removeExportPreset(id: string) {
  put(saved.filter(x => x.id !== id));
}
