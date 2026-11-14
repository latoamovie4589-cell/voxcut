// アプリ全体のショートカットを効かせてよいかの判定（App・別ウィンドウ・ドックで共通）

/** ダイアログを開いている間は、後ろの編集画面のショートカットを効かせない */
export function modalOpen(): boolean {
  return !!document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]');
}

/** ボタン・メニュー項目・タブ・スイッチなどにフォーカスがあるときの Space は、その部品の操作（押す・チェック）に使う */
export function onControl(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest('button, a[href], summary, [role^="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"]');
}
