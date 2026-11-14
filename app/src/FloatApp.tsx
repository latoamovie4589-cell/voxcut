// 別ウィンドウに切り離したパネル（Premiere Pro のフローティングパネル）。
// 中身はメインウィンドウと同じパネル。状態はメインウィンドウと共有し（sync.ts）、再生と元に戻すはメインウィンドウで行う。
// 2 台目のモニターにプレビューだけを大きく出す、といった使い方ができる。

import {modalOpen, onControl, startSpaceGuard} from './keys';
import {useEffect} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {Text} from '@astryxdesign/core/Text';
import {PanelLeftClose} from 'lucide-react';
import {usePanels, useNotify} from './App';
import {PANEL_TITLE, type PanelId} from './dock/layout';
import {setNotify} from './actions';
import {copySelection, cutSelection, deleteClips, duplicateSelection, editableSelection, pasteClipboard, redo, undo, useStore} from './store';
import {toggle} from './preview/playback';
import {PasteScriptDialog} from './panels/PasteScriptDialog';
import {DictionaryDialog} from './panels/DictionaryDialog';
import {ShortcutsDialog} from './panels/ShortcutsDialog';
import {CharacterDialog} from './panels/CharacterDialog';
import './app.css';
import './dock/dock.css';

export function FloatApp({panel, onDock}: {panel: PanelId; onDock: () => void}) {
  const {notify} = useNotify();
  const panels = usePanels(notify);
  const ready = useStore(s => s.project !== null);
  useEffect(() => {
    setNotify(notify);
    document.title = `${PANEL_TITLE[panel]} — VoxCut`;
  }, [notify, panel]);

  // マウスで押したボタンの上での Space は再生（ボタンをもう一度押さない）
  useEffect(() => startSpaceGuard(toggle), []);

  // このウィンドウでもよく使うキーを効かせる（再生・元に戻すはメインウィンドウで行う）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (modalOpen() || (e.key === ' ' && onControl(t))) return;
      const m = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (m && k === 'z' && !e.shiftKey) undo();
      else if (m && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
      else if (m && k === 'c') copySelection();
      else if (m && k === 'x') cutSelection();
      else if (m && k === 'v') pasteClipboard();
      else if (m && k === 'd') duplicateSelection();
      else if (!m && e.key === ' ') toggle();
      else if (!m && (e.key === 'Delete' || e.key === 'Backspace')) deleteClips(editableSelection().map(c => c.id));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const def = panels[panel];
  return (
    <div className="vx-float">
      <div className="vx-dock-header vx-float-header">
        <Text type="label">{PANEL_TITLE[panel]}</Text>
        <Button label="メインウィンドウに戻す" size="sm" variant="ghost" icon={<Icon icon={PanelLeftClose} />} onClick={onDock} />
      </div>
      <div className="vx-dock-content" data-scroll={def.scroll || undefined}>
        {ready ? def.render() : <Text type="supporting">メインウィンドウとつないでいます…</Text>}
      </div>
      <PasteScriptDialog notify={notify} />
      <DictionaryDialog notify={notify} />
      <ShortcutsDialog />
      <CharacterDialog />
    </div>
  );
}
