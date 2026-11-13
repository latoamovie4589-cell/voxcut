// 入力項目の説明文（ラベルの下の小さな文）・.vx-hint・data-hint の説明。画面には並べない。
// 「表示 → 項目の説明を表示」がオンなら、同じところにマウスを 3 秒乗せたときだけ近くに出す。オフなら出さない
// 読み上げは aria-describedby のまま（隠しても読み上げられる）

import {useSyncExternalStore} from 'react';

const KEY = 'voxcut.hints';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
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

/** マウスを乗せて、説明を出すまでの時間 */
const HOVER_MS = 3000;

/** 乗せている場所の説明（入力項目の説明・.vx-hint・data-hint）と、その目印になる要素 */
function hintAt(el: Element | null): {anchor: Element; text: string} | null {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (e instanceof HTMLElement && e.dataset.hint) return {anchor: e, text: e.dataset.hint};
    if (e.classList.contains('astryx-field')) {
      const desc = e.firstElementChild?.children[1];
      const t = desc?.textContent?.trim();
      if (t) return {anchor: e, text: t};
    }
    // 説明（.vx-hint）を中に持つ欄
    const own = [...e.children].find(c => c.classList.contains('vx-hint'));
    const t = own?.textContent?.trim();
    if (t) return {anchor: e, text: t};
  }
  return null;
}

/**
 * 説明は画面に並べず、同じところにマウスを 3 秒乗せたときだけ近くに出す（「表示 → 項目の説明を表示」がオンのとき）。
 * 読み上げは aria-describedby のまま
 */
function startHoverHints() {
  const pop = document.createElement('div');
  pop.className = 'vx-hint-pop';
  pop.setAttribute('role', 'tooltip');
  pop.hidden = true;
  document.body.appendChild(pop);
  let timer = 0;
  let cur: {anchor: Element; text: string} | null = null;
  let mouse = {x: 0, y: 0};
  const hide = () => {
    window.clearTimeout(timer);
    pop.hidden = true;
  };
  const show = () => {
    if (!cur || !shown) return;
    pop.textContent = cur.text;
    pop.hidden = false;
    const r = pop.getBoundingClientRect();
    const x = Math.min(mouse.x + 12, window.innerWidth - r.width - 8);
    const y = mouse.y + 20 + r.height > window.innerHeight ? mouse.y - r.height - 12 : mouse.y + 20;
    pop.style.left = `${Math.max(8, x)}px`;
    pop.style.top = `${Math.max(8, y)}px`;
  };
  document.addEventListener(
    'pointermove',
    e => {
      mouse = {x: e.clientX, y: e.clientY};
      const next = hintAt(e.target as Element);
      if (next?.anchor === cur?.anchor && next?.text === cur?.text) return;
      cur = next;
      hide();
      if (cur && shown) timer = window.setTimeout(show, HOVER_MS);
    },
    true,
  );
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'blur']) window.addEventListener(ev, hide, true);
  document.addEventListener('pointerleave', hide);
}

export function startHints() {
  apply();
  startHoverHints();
}
