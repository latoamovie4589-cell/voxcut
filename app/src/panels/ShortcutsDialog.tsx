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
    'セリフとアイテム',
    [
      [`${m}+L`, 'セリフ入力欄へ'],
      [`${m}+クリック`, '選択に足す・外す'],
      ['Shift+クリック', '同じレイヤーの間をまとめて選ぶ'],
      ['Alt+クリック', 'リンクしたアイテム（セリフの音声と字幕など）の片方だけを選ぶ'],
      [`${m}+A`, 'すべて選ぶ'],
      [`${m}+C / X / V`, '写す・切り取る・貼り付ける'],
      [`${m}+D`, '複製'],
      ['Delete', '選んだものを消す'],
      ['Alt+← → / , .', '選んだものを 1 コマ動かす（Shift で 1 秒）'],
      [`${m}+← →`, '同じレイヤーの前・次のアイテムを選ぶ'],
      ['S', '素材を再生位置で分ける'],
      ['Esc', '選択を外す・全画面をやめる'],
      ['Esc（ドラッグ中）', 'タイムラインやプレビューで動かしている途中なら、やめて元の場所に戻す'],
      ['Alt（ドラッグ中）', 'スナップ・吸着をしない（プレビューの大きさは細かく変える）'],
    ],
  ],
  [
    'パネルと台本',
    [
      ['Shift+1 / 2 / 3 / 4 / 5', '台本・キャラクター・タイムライン・プレビュー・プロパティへ移る（Premiere Pro と同じく Shift+3 がタイムライン）'],
      ['`', '最後に触った枠を最大化・元に戻す（タブのダブルクリックでも）'],
      ['タブをドラッグ', '別の枠の中央でタブに、枠の上下左右の端で分けて置く、画面全体の端で上から下まで通しで置く'],
      ['境目をドラッグ / 矢印', '枠の大きさを変える（Shift で大きく）'],
      ['Esc（ドラッグ中）', 'パネルの移動をやめる'],
      ['Alt+Shift+1〜9', 'ワークスペースを切り替える'],
      ['≡ → 別ウィンドウに切り離す', 'パネルを別のウィンドウへ（2 台目のモニターなど）'],
      ['Enter / F2', '台本の行を書き直す（ダブルクリックでも）'],
      ['Alt+↑ ↓', '台本の行を上下へ入れ替える'],
      [`${m}+F`, '台本を探す'],
      [`${m}+H`, '台本の文を置き換える（置き換えた行は音声を作り直す）'],
    ],
  ],
  [
    'セリフ入力欄とレイヤー',
    [
      ['Enter', 'セリフを追加（キャラクターのレイヤーの再生位置へ）'],
      ['空のまま Enter', '選んでいるセリフを再生'],
      ['Alt+1〜9 / Alt+0', '入力欄で、足すセリフの声のプリセット（怒り・喜びなど）を切り替える／通常に戻す'],
      [`${m}+↑ ↓`, '入力欄で、話す人（キャラクター）を前・次に切り替える'],
      ['名前：セリフ', '入力欄で「茜：こんにちは」のように打つと、そのキャラクターで入る（以後もそのキャラクター）'],
      ['入れ方', '通常＝入れるだけ／追記＝末尾まで進む／連結＝直前のセリフを延ばしてつなぐ'],
      ['セリフで Enter', 'プロパティのセリフを発音にも反映して合成し直す'],
      ['レイヤー見出しをホイールクリック', 'レイヤーの表示の切り替え'],
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
