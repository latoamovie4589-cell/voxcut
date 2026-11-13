// 入力項目の説明文（ラベルの下の小さな文）。慣れた人には読む量が多いので、ふだんは隠す。
// - 隠しているときも、その項目にフォーカスすると出る（キーボードで操作する人・初めての人のため）
// - ラベルにマウスを乗せると、説明がツールチップで出る
// - 読み上げは aria-describedby のまま（隠しても読み上げられる）
// 「表示 → 項目の説明を表示」でいつも出すようにできる

import {useSyncExternalStore} from 'react';

const KEY = 'voxcut.hints';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

let shown = read();

function apply() {
  document.documentElement.dataset.hints = shown ? 'on' : 'off';
}

export function setHintsShown(on: boolean) {
  shown = on;
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // 保存できなくても、この起動中は使える
  }
  apply();
  listeners.forEach(l => l());
}

export function useHintsShown(): boolean {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown,
  );
}

/** 説明の文をラベルのツールチップ（title）にも入れる */
function titleLabels(root: ParentNode) {
  for (const head of root.querySelectorAll<HTMLElement>('.astryx-field > div:first-child')) {
    const label = head.firstElementChild as HTMLElement | null;
    const desc = head.children[1] as HTMLElement | undefined;
    if (!label || !desc) continue;
    const t = desc.textContent?.trim() ?? '';
    if (t && label.title !== t) label.title = t;
  }
}

export function startHints() {
  apply();
  let queued = false;
  const run = () => {
    queued = false;
    titleLabels(document);
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(document.body, {childList: true, subtree: true});
  run();
}
