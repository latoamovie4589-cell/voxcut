// 「ルビを付ける」ボタン。近くの入力欄で選んだ文字を「｜文字《》」にして、《》の中に読みを打てるようにする
import {Button} from '@astryxdesign/core/Button';
import {Languages} from 'lucide-react';
import {Icon} from '@astryxdesign/core/Icon';
import {isKanji} from '../ruby';

/** 選んだ範囲（なければカーソルの前の漢字の並び）にルビの書き方を入れた文と、読みを打つ位置 */
export function insertRuby(value: string, start: number, end: number): {text: string; caret: number} {
  let s = start;
  if (s === end) while (s > 0 && isKanji(value[s - 1])) s--;
  const sel = value.slice(s, end);
  // 漢字だけで、前が漢字でなければ「｜」は要らない（《の前の漢字の並びに付くので）
  const plain = !!sel && [...sel].every(isKanji) && !(s > 0 && isKanji(value[s - 1]));
  const head = `${value.slice(0, s)}${plain ? '' : '｜'}${sel}《`;
  return {text: `${head}》${value.slice(end)}`, caret: head.length};
}

export function RubyButton({host, value, onChange}: {host: () => HTMLElement | null; value: string; onChange: (v: string) => void}) {
  return (
    <Button
      label="ルビを付ける"
      size="sm"
      variant="secondary"
      icon={<Icon icon={Languages} />}
      tooltip="選んだ文字にふりがなを付ける。《》の中に読みを打つ（書き方は 漢字《かんじ》。声もこの読みで合成）"
      onClick={() => {
        const ta = host()?.querySelector('textarea');
        const at = ta ? [ta.selectionStart, ta.selectionEnd] : [value.length, value.length];
        const r = insertRuby(value, at[0], at[1]);
        onChange(r.text);
        requestAnimationFrame(() => {
          ta?.focus();
          ta?.setSelectionRange(r.caret, r.caret);
        });
      }}
    />
  );
}
