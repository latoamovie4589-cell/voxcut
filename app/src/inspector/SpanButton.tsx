// 「文字を飾る」ボタン。入力欄で選んだ文字だけ、色や大きさを変える（書き方は <c=#FF0000>赤</c>・<s=1.5>大</s>。字幕・テキストで使える）
import {DropdownMenu, DropdownMenuDivider, DropdownMenuItem} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {Palette} from 'lucide-react';

const COLORS: [string, string][] = [
  ['赤', '#FF3B30'],
  ['オレンジ', '#FF9500'],
  ['黄', '#FFD400'],
  ['緑', '#34C759'],
  ['水色', '#32ADE6'],
  ['青', '#2F6BFF'],
  ['ピンク', '#FF5FA2'],
  ['白', '#FFFFFF'],
];

const SIZES: [string, number][] = [
  ['少し大きく（1.3 倍）', 1.3],
  ['大きく（1.6 倍）', 1.6],
  ['とても大きく（2 倍）', 2],
  ['小さく（0.7 倍）', 0.7],
];

const TAG = /<c=[^>]*>|<\/c>|<s=[^>]*>|<\/s>/g;

/** 選んだ範囲を open と close で囲む。範囲がなければ、囲みの中にカーソルを置く */
export function wrapSpan(value: string, start: number, end: number, open: string, close: string): {text: string; caret: [number, number]} {
  const head = value.slice(0, start) + open;
  const sel = value.slice(start, end);
  return {text: head + sel + close + value.slice(end), caret: [head.length, head.length + sel.length]};
}

/** 選んだ範囲（なければ全体）の飾りの書き方を外す */
export function clearSpans(value: string, start: number, end: number): {text: string; caret: [number, number]} {
  const [a, b] = start === end ? [0, value.length] : [start, end];
  const mid = value.slice(a, b).replace(TAG, '');
  return {text: value.slice(0, a) + mid + value.slice(b), caret: [a, a + mid.length]};
}

export function SpanButton({host, value, onChange}: {host: () => HTMLElement | null; value: string; onChange: (v: string) => void}) {
  const apply = (f: (start: number, end: number) => {text: string; caret: [number, number]}) => {
    const ta = host()?.querySelector('textarea');
    const at: [number, number] = ta ? [ta.selectionStart, ta.selectionEnd] : [value.length, value.length];
    const r = f(at[0], at[1]);
    onChange(r.text);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(r.caret[0], r.caret[1]);
    });
  };
  return (
    <DropdownMenu
      button={{label: '文字を飾る', size: 'sm', variant: 'secondary', icon: <Icon icon={Palette} />, tooltip: '選んだ文字だけ、色や大きさを変えます（<c=#FF0000>赤</c>・<s=1.5>大</s> の書き方で入ります）'}}
      menuWidth={220}>
      {COLORS.map(([label, hex]) => (
        <DropdownMenuItem key={hex} label={`色：${label}`} onClick={() => apply((a, b) => wrapSpan(value, a, b, `<c=${hex}>`, '</c>'))} />
      ))}
      <DropdownMenuDivider />
      {SIZES.map(([label, k]) => (
        <DropdownMenuItem key={k} label={label} onClick={() => apply((a, b) => wrapSpan(value, a, b, `<s=${k}>`, '</s>'))} />
      ))}
      <DropdownMenuDivider />
      <DropdownMenuItem label="飾りを外す（選んだ範囲、なければ全体）" onClick={() => apply((a, b) => clearSpans(value, a, b))} />
    </DropdownMenu>
  );
}
