// キーボードショートカットの一覧（メニューか「?」キーで開く）

import {Fragment} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';
import {keyLabel, useKeymap, type ActionId} from '../keymap';
import {setState, useStore} from '../store';

const isMac = navigator.platform.toLowerCase().includes('mac');
const m = isMac ? '⌘' : 'Ctrl';

/** 割り当てたキーの表記（いくつかの操作を / でつなぐ。割り当てていなければ「なし」） */
const k = (...ids: ActionId[]) => ids.map(id => keyLabel(id) || 'なし').join(' / ');

const groups = (): [string, [string, string][]][] => [
  [
    'ファイル',
    [
      [k('new'), '新規'],
      [k('open'), '開く'],
      [k('save'), '保存'],
      [k('saveAs'), '名前を付けて保存'],
    ],
  ],
  [
    '編集',
    [
      [k('undo'), '元に戻す'],
      [k('redo'), 'やり直す'],
    ],
  ],
  [
    '再生',
    [
      [k('play'), '再生・停止'],
      [k('stop'), '停止'],
      [k('shuttleForward', 'shuttleBackward'), '再生・逆再生（押すたびに速く）'],
      [k('frameBack', 'frameForward'), '1 コマ戻る・進む'],
      [k('secondBack', 'secondForward'), '1 秒戻る・進む'],
      [k('prevEdit', 'nextEdit'), '前・次の編集点へ'],
      [k('toStart', 'toEnd'), '先頭・最後へ'],
    ],
  ],
  [
    'セリフとアイテム',
    [
      [k('focusInput'), 'セリフ入力欄へ'],
      [`${m}+クリック`, '選択に足す・外す'],
      ['Shift+クリック', '同じレイヤーの間をまとめて選ぶ'],
      ['Alt+クリック', 'リンクしたアイテム（セリフの音声と字幕など）の片方だけを選ぶ'],
      [k('selectAll'), 'すべて選ぶ'],
      [k('copy', 'cut', 'paste'), '写す・切り取る・貼り付ける'],
      [k('duplicate'), '複製'],
      [k('delete'), '選んだものを消す'],
      ['Alt+← → / , .', '選んだものを 1 コマ動かす（Shift で 1 秒）'],
      [`${m}+← →`, '同じレイヤーの前・次のアイテムを選ぶ'],
      [k('split'), '素材を再生位置で分ける'],
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
      [k('marker'), '再生位置にマーカーを付ける（目盛りに旗が出る。名前とチャプターは「ファイル → マーカーと概要欄」）'],
      ['Alt+↑ ↓', '台本の行を上下へ入れ替える'],
      [k('find'), '台本を探す'],
      [k('replace'), '台本の文を置き換える（置き換えた行は音声を作り直す）'],
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
      ['入れ方', 'その場に＝再生位置に入れるだけ／続けて＝入れたセリフの後ろへ進む／連結＝直前のセリフを延ばしてつなぐ'],
      ['セリフで Enter', 'プロパティのセリフを発音にも反映して合成し直す'],
      ['レイヤー見出しをホイールクリック', 'レイヤーの表示の切り替え'],
    ],
  ],
];

export function ShortcutsDialog() {
  const isOpen = useStore(s => s.shortcutsOpen);
  const close = () => setState({shortcutsOpen: false});
  useKeymap();
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={880} maxHeight="88dvh" purpose="info">
      <DialogHeader title="キーボードショートカット" onOpenChange={o => !o && close()} />
      <HStack gap={2} padding={3} vAlign="center" hAlign="between">
        <Text type="supporting">よく使う操作は、自分の押しやすいキーに変えられます</Text>
        <Button label="キーを変える…" size="sm" onClick={() => setState({shortcutsOpen: false, keymapOpen: true})} />
      </HStack>
      <div className="vx-shortcuts-scroll">
        {/* 2 段に組む（1 画面に収まり、キーと説明が離れすぎない）。狭ければ 1 段 */}
        <div className="vx-shortcuts">
          {groups().map(([title, rows]) => (
            <section key={title} className="vx-shortcuts-group">
              <Heading level={3}>{title}</Heading>
              <dl>
                {rows.map(([key, what]) => (
                  <Fragment key={key + what}>
                    <dt>
                      <kbd className="vx-kbd">{key}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
