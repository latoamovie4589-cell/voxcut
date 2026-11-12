// キーボードショートカットの一覧（メニューか「?」キーで開く）

import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Heading, Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {setState, useStore} from '../store';

const isMac = navigator.platform.toLowerCase().includes('mac');
const m = isMac ? '⌘' : 'Ctrl';

const GROUPS: [string, [string, string][]][] = [
  [
    'ファイル',
    [
      [`${m}+N`, '新規'],
      [`${m}+O`, '開く'],
      [`${m}+S`, '保存（Shift も押すと名前を付けて保存）'],
      [`${m}+Z`, '元に戻す'],
      [isMac ? '⇧⌘Z' : 'Ctrl+Y', 'やり直す'],
    ],
  ],
  [
    '再生',
    [
      ['Space / K', '再生・停止'],
      ['L / J', '再生・逆再生（押すたびに速く）'],
      ['← →', '1 コマ戻る・進む（Shift で 1 秒）'],
      ['↑ ↓', '前・次の編集点へ'],
      ['Home / End', '先頭・最後へ'],
    ],
  ],
  [
    'セリフとクリップ',
    [
      [`${m}+L`, 'セリフ入力欄へ'],
      [`${m}+クリック`, '選択に足す・外す'],
      ['Shift+クリック', '同じトラックの間をまとめて選ぶ'],
      [`${m}+A`, 'すべて選ぶ'],
      [`${m}+C / X / V`, '写す・切り取る・貼り付ける'],
      [`${m}+D`, '複製'],
      ['Delete', '選んだものを消す'],
      ['Alt+← → / , .', '選んだものを 1 コマ動かす（Shift で 1 秒）'],
      [`${m}+← →`, '同じトラックの前・次のクリップを選ぶ'],
      ['S', '素材を再生位置で分ける'],
      ['Esc', '選択を外す・全画面をやめる'],
    ],
  ],
];

export function ShortcutsDialog() {
  const isOpen = useStore(s => s.shortcutsOpen);
  const close = () => setState({shortcutsOpen: false});
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={560} maxHeight="88dvh" purpose="info">
      <DialogHeader title="キーボードショートカット" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(88dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={4} padding={4}>
          {GROUPS.map(([title, rows]) => (
            <VStack key={title} gap={2}>
              <Heading level={3}>{title}</Heading>
              {rows.map(([key, what]) => (
                <HStack key={key} gap={3} vAlign="center">
                  <div style={{width: 150, flexShrink: 0}}>
                    <kbd className="vx-kbd">{key}</kbd>
                  </div>
                  <Text>{what}</Text>
                </HStack>
              ))}
            </VStack>
          ))}
        </VStack>
      </div>
    </Dialog>
  );
}
