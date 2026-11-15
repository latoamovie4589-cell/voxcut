// 画面の明るさ（ダーク／ライト／OS に合わせる）。既定はダーク。
// 動画を見ながら作業する道具なので、プレビューの周りが暗い方が色を見誤りにくい

import {useSyncExternalStore} from 'react';
import {flushSync} from 'react-dom';

export type ThemeMode = 'dark' | 'light' | 'system';

const KEY = 'voxcut.theme';
const listeners = new Set<() => void>();

function read(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'system' || v === 'dark') return v;
  } catch {
    // 読めなければ既定
  }
  return 'dark';
}

let mode = read();

// 切り離したパネルの別ウィンドウにも、メインウィンドウでの切り替えを伝える
window.addEventListener('storage', e => {
  if (e.key !== KEY) return;
  mode = read();
  listeners.forEach(l => l());
});

export function setThemeMode(m: ThemeMode) {
  mode = m;
  try {
    localStorage.setItem(KEY, m);
  } catch {
    // 保存できなくても、この起動中は使える
  }
  // 全面が一瞬で反転するとまぶしいので、短く重ねて切り替える（動きを減らす設定ならすぐ）
  const swap = () => flushSync(() => listeners.forEach(l => l()));
  const doc = document as Document & {startViewTransition?: (cb: () => void) => unknown};
  if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(swap);
  else swap();
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => mode,
  );
}
