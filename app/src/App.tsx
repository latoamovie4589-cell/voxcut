// 画面全体：上＝ヘッダー、左＝キャラクター・エンジン、中央＝プレビュー＋タイムライン、右＝インスペクタ、下＝セリフ入力。
// Astryx の canvas-editor テンプレートの構成を下敷きにしている。

import {useCallback, useEffect, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {DropdownMenu, DropdownMenuDivider, DropdownMenuItem, DropdownMenuSubMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, Layout, LayoutContent, LayoutFooter, LayoutHeader, LayoutPanel, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {ResizeHandle, useResizable} from '@astryxdesign/core/Resizable';
import {Section} from '@astryxdesign/core/Section';
import {Text} from '@astryxdesign/core/Text';
import {useToast} from '@astryxdesign/core/Toast';
import {AudioLines, Menu, Redo2, Save, TriangleAlert, Undo2, Upload} from 'lucide-react';
import {IconButton} from '@astryxdesign/core/IconButton';
import {framesToTimecode, projectDuration} from './model';
import {copySelection, cutSelection, deleteClips, duplicateSelection, editableSelection, getState, hasClipboard, pasteClipboard, redo, selectAllClips, setState, splitClip, undo, useStore} from './store';
import {boot, newProjectAction, openProject, saveProject, setClearNotice, setNotify, synthesize, type Notify} from './actions';
import {ExportDialog} from './panels/ExportDialog';
import {PasteScriptDialog} from './panels/PasteScriptDialog';
import {DictionaryDialog} from './panels/DictionaryDialog';
import {ShortcutsDialog} from './panels/ShortcutsDialog';
import {useFileDrop} from './drop';
import {api, setDirtyGetter} from './ipc';
import {Timeline} from './timeline/Timeline';
import {Preview} from './preview/Preview';
import {jumpTo, jumpToEdit, shuttleBackward, shuttleForward, step, stop, toggle} from './preview/playback';
import {Inspector} from './inspector/Inspector';
import {Sidebar} from './panels/Sidebar';
import {ScriptBar} from './panels/ScriptBar';
import {SettingsDialog} from './panels/SettingsDialog';
import {SplitHandle} from './panels/SplitHandle';
import {toggleFullscreen} from './preview/PreviewControls';
import './app.css';

const isMac = navigator.platform.toLowerCase().includes('mac');
const mod = isMac ? '⌘' : 'Ctrl+';

/** ヘッダー中央：全体の長さ（再生の操作はプレビューの下にある） */
function ProjectLength() {
  const project = useStore(s => s.project);
  if (!project) return null;
  return (
    <Text type="supporting" hasTabularNumbers>
      長さ {framesToTimecode(projectDuration(project), project.video.fps)}
    </Text>
  );
}

const SPLIT_KEY = 'voxcut.timelineHeight';

/** 中央：プレビューとタイムライン。境目を動かせる（初期はタイムラインに縦 40%） */
function CenterSplit() {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const [total, setTotal] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTotal(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const min = 180;
  const max = Math.max(min, total - 200);
  const height = Math.min(max, Math.max(min, h ?? Math.round(total * 0.4)));
  const set = (v: number) => {
    setH(v);
    try {
      localStorage.setItem(SPLIT_KEY, String(Math.round(v)));
    } catch {
      // 保存できなくても動作には困らない
    }
  };
  return (
    <div ref={ref} className="vx-center">
      <Preview />
      <SplitHandle value={height} min={min} max={max} onChange={set} />
      <div style={{height, flex: 'none', minHeight: 0}}>
        <Timeline />
      </div>
    </div>
  );
}

/** 未合成・失敗の件数。押すと全部合成 */
function SynthStatus({notify}: {notify: Notify}) {
  const pending = useStore(s => s.project?.clips.filter(c => c.type === 'voice' && !c.audio && c.text.trim()).length ?? 0);
  const failed = useStore(s => Object.keys(s.synthErrors).length);
  const busy = useStore(s => s.busy);
  if (busy || (!pending && !failed)) return null;
  const label = failed ? `合成できなかった行 ${failed} 件` : `未合成 ${pending} 件`;
  return (
    <Button
      label={label}
      size="sm"
      variant="ghost"
      icon={<Icon icon={failed ? TriangleAlert : AudioLines} color={failed ? 'error' : 'secondary'} />}
      tooltip="押すと、まだの行をまとめて合成します"
      onClick={() => void synthesize(notify)}
    />
  );
}

function Header({notify, openSettings, openExport}: {notify: Notify; openSettings: () => void; openExport: () => void}) {
  const project = useStore(s => s.project);
  const dirty = useStore(s => s.dirty);
  const busy = useStore(s => s.busy);
  const canUndo = useStore(s => s.past.length > 0);
  const canRedo = useStore(s => s.future.length > 0);
  const recent = useStore(s => s.recent);
  return (
    <LayoutHeader hasDivider padding={1}>
      <HStack gap={2} vAlign="center" hAlign="between" paddingInline={1}>
        <HStack gap={1} vAlign="center">
          <DropdownMenu
            button={{label: 'メニュー', tooltip: 'メニュー', variant: 'ghost', size: 'sm', isIconOnly: true, icon: <Icon icon={Menu} />}}
            hasChevron={false}
            menuWidth={240}>
            <DropdownMenuItem label="新規" endContent={<Text type="supporting">{mod}N</Text>} onClick={() => void newProjectAction(notify)} />
            <DropdownMenuItem label="開く…" endContent={<Text type="supporting">{mod}O</Text>} onClick={() => void openProject(notify)} />
            <DropdownMenuSubMenu label="最近使ったファイル" isDisabled={!recent.length}>
              {recent.map(path => (
                <DropdownMenuItem key={path} label={path.split(/[\\/]/).pop() ?? path} description={path} onClick={() => void openProject(notify, path)} />
              ))}
            </DropdownMenuSubMenu>
            <DropdownMenuItem label="保存" endContent={<Text type="supporting">{mod}S</Text>} onClick={() => void saveProject(notify)} />
            <DropdownMenuItem label="名前を付けて保存…" onClick={() => void saveProject(notify, true)} />
            <DropdownMenuDivider />
            <DropdownMenuItem label="元に戻す" isDisabled={!canUndo} endContent={<Text type="supporting">{mod}Z</Text>} onClick={undo} />
            <DropdownMenuItem label="やり直す" isDisabled={!canRedo} endContent={<Text type="supporting">{isMac ? '⇧⌘Z' : 'Ctrl+Y'}</Text>} onClick={redo} />
            <DropdownMenuDivider />
            <DropdownMenuItem label="台本を貼り付け…" onClick={() => setState({pasteOpen: true})} />
            <DropdownMenuItem label="読み方の辞書…" onClick={() => setState({dictionaryOpen: true})} />
            <DropdownMenuItem label="設定…" onClick={openSettings} />
            <DropdownMenuItem label="キーボードショートカット" endContent={<Text type="supporting">?</Text>} onClick={() => setState({shortcutsOpen: true})} />
          </DropdownMenu>
          {/* よく使う操作は、メニューを開かなくても押せるように */}
          <IconButton label="保存" tooltip={`保存（${mod}S）`} variant="ghost" size="sm" icon={<Icon icon={Save} />} clickAction={() => saveProject(notify)} />
          <IconButton label="元に戻す" tooltip={`元に戻す（${mod}Z）`} variant="ghost" size="sm" icon={<Icon icon={Undo2} />} isDisabled={!canUndo} onClick={undo} />
          <IconButton label="やり直す" tooltip={`やり直す（${isMac ? '⇧⌘Z' : 'Ctrl+Y'}）`} variant="ghost" size="sm" icon={<Icon icon={Redo2} />} isDisabled={!canRedo} onClick={redo} />
          <Text type="label" maxLines={1}>
            {project?.name ?? 'VoxCut'}
          </Text>
          {dirty && <Text type="supporting">未保存</Text>}
        </HStack>

        <ProjectLength />

        <HStack gap={2} vAlign="center">
          {busy && (
            <HStack gap={2} vAlign="center" width={220}>
              <Text type="supporting" maxLines={1}>
                {busy.label}
              </Text>
              <div style={{flex: 1}}>
                <ProgressBar label={busy.label} isLabelHidden value={(busy.ratio ?? 0) * 100} isIndeterminate={busy.ratio === null} />
              </div>
            </HStack>
          )}
          <SynthStatus notify={notify} />
          <Button
            label="すべて合成"
            size="sm"
            icon={<Icon icon={AudioLines} />}
            isDisabled={!!busy}
            onClick={() => void synthesize(notify)}
          />
          {/* 画面で唯一の主要ボタン（HIG：filled は 1 つ） */}
          <Button label="書き出し…" variant="primary" size="sm" icon={<Icon icon={Upload} />} isDisabled={!!busy} onClick={openExport} />
        </HStack>
      </HStack>
    </LayoutHeader>
  );
}

export function App() {
  const showToast = useToast();
  // エラーも時間がたてば消す（詳しい内容は右パネルとタイムラインに残る）。key 付きは同じ種類を置き換える
  const dismissers = useRef(new Map<string, () => void>());
  const notify = useCallback<Notify>(
    (body, type = 'info', key) => {
      if (key) dismissers.current.get(key)?.();
      const dismiss = showToast({body, type, isAutoHide: true, autoHideDuration: type === 'error' ? 10000 : 5000});
      if (key) dismissers.current.set(key, dismiss);
    },
    [showToast],
  );
  const settingsOpen = useStore(s => s.settingsOpen);
  const setSettingsOpen = (o: boolean) => setState({settingsOpen: o});
  const [exportOpen, setExportOpen] = useState(false);
  // 小さい画面では左右のパネルを細めに始める
  const narrow = window.innerWidth < 1280;
  const left = useResizable({defaultSize: narrow ? 216 : 248, minSize: 200, maxSize: 360});
  const right = useResizable({defaultSize: narrow ? 288 : 320, minSize: 272, maxSize: 440});
  const ready = useStore(s => s.project !== null);

  // 保存していない変更があるときは、閉じる前に確かめる
  useEffect(() => {
    setDirtyGetter(() => getState().dirty);
    let off: (() => void) | undefined;
    void api.then(a =>
      a
        .onCloseRequested(async () => {
          if (!getState().dirty) return true;
          const ok = await a.ask('保存していない変更があります。保存せずに閉じますか？', '保存せずに閉じる');
          // 閉じると決めたら、自動保存も消す（次の起動で戻すか聞かない）
          if (ok) await a.autosaveClear();
          return ok;
        })
        .then(u => (off = u)),
    );
    return () => off?.();
  }, []);

  useFileDrop(notify);
  const dropActive = useStore(s => s.dropActive);

  useEffect(() => {
    setNotify(notify);
    setClearNotice(key => {
      dismissers.current.get(key)?.();
      dismissers.current.delete(key);
    });
    void boot(notify).catch(e => notify(String(e), 'error'));
  }, [notify]);

  // キーボードショートカット（入力欄にいるときは奪わない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      // 矢印キーを自分で使う部品（境目・タブ・一覧・メニュー・スライダー）にフォーカスがあるときは奪わない
      // （タイムライン・プレビューは自分で使うキーだけ止めるので、ここでは除かない）
      const inPanel = !!t.closest('[role="separator"], [role="tablist"], [role="listbox"], [role="menu"], [role="slider"]');
      const m = e.metaKey || e.ctrlKey;
      if (m && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProject(notify, e.shiftKey);
      } else if (m && e.key.toLowerCase() === 'l') {
        // セリフ入力欄へ
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-script-input] input')?.focus();
      } else if (m && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openProject(notify);
      } else if (m && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void newProjectAction(notify);
      } else if (e.key === 'Escape' && getState().previewFull) {
        e.preventDefault();
        void toggleFullscreen();
      } else if (typing) {
        return;
      } else if (e.key === '?' || (m && e.key === '/')) {
        e.preventDefault();
        setState({shortcutsOpen: true});
      } else if (m && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (m && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (!m && !e.altKey && ['j', 'k', 'l'].includes(e.key.toLowerCase())) {
        // J/K/L：逆再生・停止・再生（押すたびに速く）
        e.preventDefault();
        const k = e.key.toLowerCase();
        if (k === 'k') stop();
        else if (k === 'l') shuttleForward();
        else shuttleBackward();
      } else if (!inPanel && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // ←→：1 コマ（Shift で 1 秒）
        e.preventDefault();
        const fps = getState().project?.video.fps ?? 30;
        step((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? fps : 1));
      } else if (!inPanel && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // ↑↓：前後の編集点へ
        e.preventDefault();
        jumpToEdit(e.key === 'ArrowDown' ? 1 : -1);
      } else if (!inPanel && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault();
        jumpTo(e.key === 'Home' ? 'start' : 'end');
      } else if (e.key.toLowerCase() === 's' && getState().selectedClipId) {
        if (!splitClip(getState().selectedClipId!, getState().playhead)) notify('素材を再生位置で分けられます（セリフは分けられません）');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && getState().selectedClipIds.length) {
        const ids = editableSelection().map(c => c.id);
        if (ids.length) deleteClips(ids);
        else notify('ロックしたトラックのクリップは消せません');
      } else if (m && !e.shiftKey && ['c', 'x', 'v', 'd', 'a'].includes(e.key.toLowerCase())) {
        const k = e.key.toLowerCase();
        e.preventDefault();
        if (k === 'a') selectAllClips();
        else if (k === 'c') {
          const n = copySelection();
          if (n) notify(`${n} 個を写しました`);
        } else if (k === 'x') {
          const n = cutSelection();
          if (n) notify(`${n} 個を切り取りました`);
        } else if (k === 'v') {
          if (!hasClipboard()) notify('貼り付けるものがありません。台本の文を貼るときは、メニューの「台本を貼り付け」を使ってください');
          else pasteClipboard();
        } else if (k === 'd') duplicateSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notify]);

  return (
    <Section variant="section" padding={0} height="100%">
      <Layout
        height="fill"
        padding={0}
        header={<Header notify={notify} openSettings={() => setSettingsOpen(true)} openExport={() => setExportOpen(true)} />}
        content={
          <LayoutContent padding={0} isScrollable={false}>
            <Layout
              height="fill"
              start={
                <>
                  <LayoutPanel resizable={left.props} hasDivider padding={0} label="キャラクターと音声合成ソフト">
                    <Sidebar />
                  </LayoutPanel>
                  <ResizeHandle resizable={left.props} isAlwaysVisible={false} pillPlacement="center" label="左パネルの幅を変える" />
                </>
              }
              content={
                <LayoutContent padding={0} isScrollable={false}>
                  {ready && <CenterSplit />}
                </LayoutContent>
              }
              footer={
                <LayoutFooter hasDivider padding={0}>
                  <ScriptBar notify={notify} />
                </LayoutFooter>
              }
              end={
                <>
                  <ResizeHandle resizable={right.props} isReversed isAlwaysVisible={false} pillPlacement="center" label="右パネルの幅を変える" />
                  <LayoutPanel resizable={right.props} hasDivider padding={0} isScrollable label="設定">
                    <VStack>
                      <Inspector notify={notify} />
                    </VStack>
                  </LayoutPanel>
                </>
              }
            />
          </LayoutContent>
        }
      />
      <SettingsDialog isOpen={settingsOpen} onOpenChange={setSettingsOpen} notify={notify} />
      <ExportDialog isOpen={exportOpen} onOpenChange={setExportOpen} />
      <PasteScriptDialog notify={notify} />
      <ShortcutsDialog />
      {dropActive && (
        <div className="vx-drop" aria-hidden>
          <div className="vx-drop-card">
            <Text type="label">ここに放すと追加します</Text>
            <Text type="supporting">画像・動画・音声は再生位置に。.voxcut は開き、.voxchar はキャラクターとして読み込みます</Text>
          </div>
        </div>
      )}
      <DictionaryDialog notify={notify} />
    </Section>
  );
}
