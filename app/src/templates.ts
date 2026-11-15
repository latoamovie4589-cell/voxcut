// テンプレート：アイテム（テキスト・図形・画像・動画）、字幕の見た目、立ち絵の配置を名前を付けて取っておき、
// ほかのプロジェクトでも使い回す。この PC に覚える（プロジェクトのファイルには入れない）。

import {useSyncExternalStore} from 'react';
import type {SubtitleStyle, Transform, VisualClip} from './model';
import {newId} from './model';

export type Template =
  {id: string; name: string; kind: 'item'; data: VisualClip} | {id: string; name: string; kind: 'subtitle'; data: SubtitleStyle} | {id: string; name: string; kind: 'placement'; data: Transform};
export type TemplateKind = Template['kind'];

const KEY = 'voxcut.templates';

function read(): Template[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && ['item', 'subtitle', 'placement'].includes(t.kind) && t.data) : [];
  } catch {
    return [];
  }
}

let list: Template[] = read();
const listeners = new Set<() => void>();

function write(next: Template[]) {
  list = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 保存できなくても、開いている間は使える
  }
  listeners.forEach(l => l());
}

export const getTemplates = () => list;

export function useTemplates(): Template[] {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => list,
  );
}

/** 同じ名前があれば「名前 2」のように番号を付ける */
function uniqueName(name: string, kind: TemplateKind): string {
  const base = name.trim() || 'テンプレート';
  const used = new Set(list.filter(t => t.kind === kind).map(t => t.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function saveTemplate<K extends TemplateKind>(kind: K, name: string, data: Extract<Template, {kind: K}>['data']): Template {
  const t = {id: newId('tp'), name: uniqueName(name, kind), kind, data: structuredClone(data)} as Template;
  write([...list, t]);
  return t;
}

export function renameTemplate(id: string, name: string) {
  write(list.map(t => (t.id === id ? {...t, name} : t)));
}

export function removeTemplate(id: string) {
  write(list.filter(t => t.id !== id));
}

/** アイテムのテンプレートの名前の初期値（文字・形・ファイル名から） */
export function itemTemplateName(c: VisualClip): string {
  if (c.type === 'text') return c.text.replace(/\s+/g, ' ').trim().slice(0, 16) || 'テキスト';
  if (c.type === 'shape') return '図形';
  return (c.src.split(/[\\/]/).pop() ?? '素材').replace(/\.[^.]+$/, '');
}
