// アプリ全体のショートカットを効かせてよいかの判定（App・別ウィンドウ・ドックで共通）

/** ダイアログを開いている間は、後ろの編集画面のショートカットを効かせない */
export function modalOpen(): boolean {
  return !!document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]');
}

/**
 * 最後にフォーカスを動かしたのがキーボード（Tab・矢印）か、マウス・指か。
 * :focus-visible はキーを押した瞬間に付いてしまうので、Space を押す前の状態を自分で覚えておく
 */
let lastNav: 'keyboard' | 'pointer' = 'pointer';
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (lastNav = 'pointer'), true);
  window.addEventListener(
    'keydown',
    e => {
      if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'F6') lastNav = 'keyboard';
    },
    true,
  );
}

/**
 * キーボードでボタン・タブ・スイッチなどに移ってきたときの Space は、その部品の操作（押す・チェック）に使う。
 * マウスで押したあとのボタンなら、YMM4 と同じく Space は再生（押したボタンをもう一度押さない）。
 * 開いているメニュー・一覧の中では、いつも部品の操作
 */
export function onControl(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  const el = t.closest('button, a[href], summary, [role^="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"]');
  if (!el) return false;
  if (el.closest('[role="menu"], [role="listbox"]')) return true;
  return lastNav === 'keyboard';
}

/** 今出ている小さな説明（ツールチップ）があるか */
function tooltipShown(): boolean {
  return [...document.querySelectorAll<HTMLElement>('.astryx-tooltip')].some(el => {
    const root = el.closest<HTMLElement>('[popover]');
    if (root && !root.matches(':popover-open')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0';
  });
}

/**
 * ダイアログの中で Esc を押したとき、ボタンの小さな説明が出ていると、1 回目の Esc は説明を消すだけになる。
 * 1 回で閉じられるよう、説明が出ていたら続けてもう 1 回 Esc を送る（説明が消えたあとのダイアログが受け取る）
 */
export function startDialogEscape() {
  window.addEventListener(
    'keydown',
    e => {
      if (e.key !== 'Escape' || !e.isTrusted || !modalOpen() || !tooltipShown()) return;
      const target = document.activeElement ?? document.body;
      setTimeout(() => {
        if (!modalOpen()) return;
        target.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true, cancelable: true}));
      }, 0);
    },
    true,
  );
}

/**
 * マウスで押したあとのボタン（フォーカスの枠が出ていない）で Space を押したとき：ボタンをもう一度押さず、再生にする（YMM4 と同じ）。
 * ボタンの部品が先に Space を受け取ってしまうので、いちばん先（キャプチャ）で横取りする
 */
export function startSpaceGuard(play: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || modalOpen()) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if ((t as HTMLElement).isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    const el = t.closest('button, a[href], summary, [role="tab"], [role="switch"], [role="checkbox"], [role="radio"]');
    if (!el || el.closest('[role="menu"], [role="listbox"]') || onControl(t)) return;
    e.preventDefault();
    e.stopPropagation();
    taken = true;
    if (!e.repeat) play();
  };
  // ボタンは Space を離したときにも押される（部品によっては keyup で押す）ので、こちらも止める
  let taken = false;
  const onUp = (e: KeyboardEvent) => {
    if (e.key !== ' ' || !taken) return;
    taken = false;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onUp, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onUp, true);
  };
}
