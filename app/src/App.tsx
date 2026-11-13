// 画面全体：上＝ヘッダー、中＝パネル（Premiere Pro と同じく、タブをドラッグして自由に組み替えられる）、下＝セリフ入力。

import {useCallback, useEffect, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {setHintsShown, useHintsShown} from './hints';
import {DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuDivider, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSubMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, Layout, LayoutContent, LayoutHeader} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Section} from '@astryxdesign/core/Section';
import {Text} from '@astryxdesign/core/Text';
import {useToast} from '@astryxdesign/core/Toast';
import {AudioLines, Redo2, Save, Settings, TriangleAlert, Undo2, Upload, UserPen} from 'lucide-react';
import {IconButton} from '@astryxdesign/core/IconButton';
import {
  copySelection,
  cutSelection,
  deleteClips,
  duplicateSelection,
  editableSelection,
  getState,
  hasClipboard,
  pasteClipboard,
  redo,
  selectAllClips,
  setOnDeleted,
  setState,
  splitClip,
  undo,
  useStore,
} from './store';
import {boot, newProjectAction, openProject, refreshEngines, saveProject, setClearNotice, setNotify, synthesize, type Notify} from './actions';
import {CharacterDialog} from './panels/CharacterDialog';
import {closeFloating, startHost} from './sync';
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
import {CharactersPanel, EnginesPanel, useEngineProblems} from './panels/Sidebar';
import {ScriptList} from './panels/ScriptList';
import {WorkspaceDialog} from './panels/WorkspaceDialog';
import {Dock, type Registry} from './dock/Dock';
import {PANEL_IDS, PANEL_TITLE, PRESETS, applyWorkspace, closePanel, deleteWorkspace, panelsIn, resetWorkspace, showPanel, useDock, workspaceName} from './dock/layout';
import type {PanelId} from './dock/layout';
import {ScriptBar} from './panels/ScriptBar';
import {SettingsDialog} from './panels/SettingsDialog';
import {toggleFullscreen} from './preview/PreviewControls';
import './app.css';

const isMac = navigator.platform.toLowerCase().includes('mac');
const mod = isMac ? '⌘' : 'Ctrl+';

/**
 * 未合成・失敗の件数。未合成は表示だけ（合成は隣の「すべて合成」）。
 * 失敗した行があるときは、押すとその行を選んで理由を右に出す
 */
function SynthStatus() {
  const pending = useStore(s => s.project?.clips.filter(c => c.type === 'voice' && !c.audio && c.text.trim()).length ?? 0);
  const errors = useStore(s => s.synthErrors);
  const failed = Object.keys(errors);
  const busy = useStore(s => s.busy);
  if (busy || (!pending && !failed.length)) return null;
  if (failed.length) {
    const first = () => {
      const p = getState().project;
      const c = p?.clips.filter(x => failed.includes(x.id)).sort((a, b) => a.start - b.start)[0];
      if (c)
        setState(st => ({
          selectedClipId: c.id,
          playhead: c.start,
          revealSeq: st.revealSeq + 1,
        }));
    };
    return (
      <Button
        label={`合成に失敗 ${failed.length} 行`}
        size="sm"
        variant="ghost"
        icon={<Icon icon={TriangleAlert} color="error" />}
        tooltip="押すと、その行を選んで理由を右に出します"
        onClick={first}
      />
    );
  }
  return (
    <HStack gap={1} vAlign="center">
      <Icon icon={AudioLines} color="secondary" />
      <Text type="supporting" hasTabularNumbers>
        未合成 {pending} 行
      </Text>
    </HStack>
  );
}

/** メニューの「ウィンドウ」：パネルを出す・閉じる（閉じたパネルはここから戻す） */
function WindowMenu() {
  const open = useDock(s => [...panelsIn(s.root), ...s.floating].join(','));
  const floating = useDock(s => s.floating.join(','));
  const list = open.split(',');
  return (
    <DropdownMenuSubMenu label="ウィンドウ">
      {PANEL_IDS.map(pid => (
        <DropdownMenuCheckboxItem
          key={pid}
          label={PANEL_TITLE[pid]}
          value={list.includes(pid)}
          isDisabled={list.length <= 1 && list.includes(pid)}
          description={floating.split(',').includes(pid) ? '別ウィンドウで開いています' : undefined}
          onChange={on => (on ? showPanel(pid) : floating.split(',').includes(pid) ? closeFloating(pid) : closePanel(pid))}
        />
      ))}
    </DropdownMenuSubMenu>
  );
}

/** パネルへ移るショートカット（Premiere Pro と同じく Shift+3 がタイムライン、Shift+4 がプレビュー） */
const PANEL_KEYS: Record<string, PanelId> = {Digit1: 'script', Digit2: 'characters', Digit3: 'timeline', Digit4: 'preview', Digit5: 'inspector'};
const PANEL_FOCUS: Partial<Record<PanelId, string>> = {timeline: '.vx-timeline-scroll', preview: '.vx-preview-canvas'};

/** パネルを出して、その中の最初に操作するところへフォーカスを移す */
function focusPanel(pid: PanelId) {
  showPanel(pid);
  requestAnimationFrame(() => {
    const own = PANEL_FOCUS[pid];
    const el = own
      ? document.querySelector<HTMLElement>(own)
      : (() => {
          // パネルの中身（タブやパネルのメニューではなく）の、一覧があればそれ、なければ最初の入力・ボタン
          const body = [...document.querySelectorAll<HTMLElement>('[data-dock-group]')].find(g => g.getAttribute('aria-label') === PANEL_TITLE[pid])?.querySelector<HTMLElement>('.vx-dock-content');
          return (
            body?.querySelector<HTMLElement>('[role="listbox"], [role="grid"], [role="list"] [tabindex="0"], [tabindex="0"]:not(button)') ??
            body?.querySelector<HTMLElement>('input, textarea, select, button, [tabindex="0"]')
          );
        })();
    el?.focus();
  });
}

/** ワークスペースのショートカット（Alt+Shift+1〜9） */
const wsKey = (i: number) => (i < 9 ? `${isMac ? '⌥⇧' : 'Alt+Shift+'}${i + 1}` : '');

/** メニューの「ワークスペース」：配置のひな形を選ぶ・今の配置を保存する・元に戻す */
function WorkspaceMenu() {
  const current = useDock(s => s.workspace);
  const saved = useDock(s => s.saved);
  const isSaved = saved.some(x => x.name === current);
  return (
    <DropdownMenuSubMenu label="ワークスペース">
      <DropdownMenuRadioGroup label="ワークスペース" value={current} onChange={applyWorkspace}>
        {PRESETS.map((p, i) => (
          <DropdownMenuRadioItem key={p.id} value={p.id} label={p.name} endContent={<Text type="supporting">{wsKey(i)}</Text>} />
        ))}
        {saved.map((x, i) => (
          <DropdownMenuRadioItem key={x.name} value={x.name} label={x.name} endContent={<Text type="supporting">{wsKey(PRESETS.length + i)}</Text>} />
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuDivider />
      <DropdownMenuItem label={`「${workspaceName(current)}」をリセット`} description="保存したときの配置に戻す" onClick={resetWorkspace} />
      <DropdownMenuItem label="今の配置を保存…" onClick={() => setState({workspaceDialogOpen: true})} />
      {isSaved && <DropdownMenuItem label={`「${current}」を削除`} variant="destructive" onClick={() => deleteWorkspace(current)} />}
    </DropdownMenuSubMenu>
  );
}

/** メニューバー（YMM4 と同じ並び：ファイル・編集・表示・ツール・ヘルプ） */
function MenuBar({notify, openSettings, openExport}: {notify: Notify; openSettings: () => void; openExport: () => void}) {
  const canUndo = useStore(s => s.past.length > 0);
  const canRedo = useStore(s => s.future.length > 0);
  const recent = useStore(s => s.recent);
  const hasSel = useStore(s => s.selectedClipIds.length > 0 || !!s.selectedClipId);
  const busy = useStore(s => !!s.busy);
  const hints = useHintsShown();
  const canPaste = useStore(s => s.clipboardCount > 0);
  const maxH = Math.max(320, (typeof window === 'undefined' ? 800 : window.innerHeight) - 80);
  const key = (k: string) => <Text type="supporting">{k}</Text>;
  const menu = (label: string) => ({label, variant: 'ghost' as const, size: 'sm' as const});
  return (
    <HStack gap={0} vAlign="center" role="menubar" aria-label="メニュー">
      <DropdownMenu button={menu('ファイル')} hasChevron={false} menuWidth={260} menuMaxHeight={maxH}>
        <DropdownMenuItem label="新規" endContent={key(`${mod}N`)} onClick={() => void newProjectAction(notify)} />
        <DropdownMenuItem label="開く…" endContent={key(`${mod}O`)} onClick={() => void openProject(notify)} />
        <DropdownMenuSubMenu label="最近使ったファイル" isDisabled={!recent.length}>
          {recent.map(path => (
            <DropdownMenuItem key={path} label={path.split(/[\\/]/).pop() ?? path} description={path} onClick={() => void openProject(notify, path)} />
          ))}
        </DropdownMenuSubMenu>
        <DropdownMenuDivider />
        <DropdownMenuItem label="保存" endContent={key(`${mod}S`)} onClick={() => void saveProject(notify)} />
        <DropdownMenuItem label="名前を付けて保存…" endContent={key(isMac ? '⇧⌘S' : 'Ctrl+Shift+S')} onClick={() => void saveProject(notify, true)} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="動画を書き出す…" isDisabled={busy} onClick={openExport} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="設定…" onClick={openSettings} />
      </DropdownMenu>
      <DropdownMenu button={menu('編集')} hasChevron={false} menuWidth={240} menuMaxHeight={maxH}>
        <DropdownMenuItem label="元に戻す" isDisabled={!canUndo} endContent={key(`${mod}Z`)} onClick={undo} />
        <DropdownMenuItem label="やり直す" isDisabled={!canRedo} endContent={key(isMac ? '⇧⌘Z' : 'Ctrl+Y')} onClick={redo} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="切り取り" isDisabled={!hasSel} endContent={key(`${mod}X`)} onClick={() => cutSelection()} />
        <DropdownMenuItem label="コピー" isDisabled={!hasSel} endContent={key(`${mod}C`)} onClick={() => copySelection()} />
        <DropdownMenuItem label="貼り付け" isDisabled={!canPaste} endContent={key(`${mod}V`)} onClick={() => pasteClipboard()} />
        <DropdownMenuItem label="複製" isDisabled={!hasSel} endContent={key(`${mod}D`)} onClick={() => duplicateSelection()} />
        <DropdownMenuItem label="削除" isDisabled={!hasSel} endContent={key('Delete')} onClick={() => deleteClips(editableSelection().map(c => c.id))} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="すべて選択" endContent={key(`${mod}A`)} onClick={() => selectAllClips()} />
      </DropdownMenu>
      <DropdownMenu button={menu('表示')} hasChevron={false} menuWidth={240} menuMaxHeight={maxH}>
        <WindowMenu />
        <WorkspaceMenu />
        <DropdownMenuDivider />
        <DropdownMenuCheckboxItem label="項目の説明を表示" description="オンなら、項目にマウスを 3 秒乗せると説明が出ます" value={hints} onChange={v => setHintsShown(v)} />
      </DropdownMenu>
      <DropdownMenu button={menu('ツール')} hasChevron={false} menuWidth={260} menuMaxHeight={maxH}>
        <DropdownMenuItem label="キャラクターの編集…" onClick={() => setState(s => ({characterDialogOpen: true, dialogCharacterId: s.selectedCharacterId}))} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="台本読み込み…" description="txt・csv・tsv の台本からセリフを追加" onClick={() => setState({pasteOpen: true})} />
        <DropdownMenuItem label="単語の読み（辞書）…" onClick={() => setState({dictionaryOpen: true})} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="未合成のセリフをすべて合成" isDisabled={busy} onClick={() => void synthesize(notify)} />
        <DropdownMenuItem label="音声合成ソフトの接続を確認" onClick={() => void refreshEngines()} />
      </DropdownMenu>
      <DropdownMenu button={menu('ヘルプ')} hasChevron={false} menuWidth={240}>
        <DropdownMenuItem label="キーボードショートカット" endContent={key('?')} onClick={() => setState({shortcutsOpen: true})} />
      </DropdownMenu>
    </HStack>
  );
}

function Header({notify, openSettings, openExport}: {notify: Notify; openSettings: () => void; openExport: () => void}) {
  const project = useStore(s => s.project);
  const dirty = useStore(s => s.dirty);
  const busy = useStore(s => s.busy);
  const canUndo = useStore(s => s.past.length > 0);
  const canRedo = useStore(s => s.future.length > 0);
  return (
    <LayoutHeader hasDivider padding={0}>
      <HStack gap={2} vAlign="center" hAlign="between" paddingInline={1} paddingBlock={1}>
        <HStack gap={1} vAlign="center">
          <MenuBar notify={notify} openSettings={openSettings} openExport={openExport} />
          <div className="vx-toolbar-sep" aria-hidden />
          {/* よく使う操作は、メニューを開かなくても押せるように（ツールバー） */}
          <IconButton label="保存" tooltip={`保存（${mod}S）`} variant="ghost" size="sm" icon={<Icon icon={Save} />} clickAction={() => saveProject(notify)} />
          <IconButton label="元に戻す" tooltip={`元に戻す（${mod}Z）`} variant="ghost" size="sm" icon={<Icon icon={Undo2} />} isDisabled={!canUndo} onClick={undo} />
          <IconButton label="やり直す" tooltip={`やり直す（${isMac ? '⇧⌘Z' : 'Ctrl+Y'}）`} variant="ghost" size="sm" icon={<Icon icon={Redo2} />} isDisabled={!canRedo} onClick={redo} />
          <Button
            label="キャラクター"
            tooltip="キャラクターの編集（声・字幕・立ち絵）"
            variant="ghost"
            size="sm"
            icon={<Icon icon={UserPen} />}
            onClick={() => setState(s => ({characterDialogOpen: true, dialogCharacterId: s.selectedCharacterId}))}
          />
          <IconButton label="設定" tooltip="設定（音声合成ソフトの場所など）" variant="ghost" size="sm" icon={<Icon icon={Settings} />} onClick={openSettings} />
          <div className="vx-toolbar-sep" aria-hidden />
          <Text type="label" maxLines={1}>
            {project?.name ?? 'VoxCut'}
          </Text>
          {dirty && <Text type="supporting">未保存</Text>}
        </HStack>

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
          <SynthStatus />
          <Button label="すべて合成" size="sm" icon={<Icon icon={AudioLines} />} isDisabled={!!busy} onClick={() => void synthesize(notify)} />
          {/* 画面で唯一の主要ボタン（HIG：filled は 1 つ） */}
          <span className="vx-primary-cta">
            <Button label="動画を書き出す…" variant="primary" size="sm" icon={<Icon icon={Upload} />} isDisabled={!!busy} onClick={openExport} />
          </span>
        </HStack>
      </HStack>
    </LayoutHeader>
  );
}

/** 配置を変えられるパネルの中身 */
export function usePanels(notify: Notify): Registry {
  return {
    characters: {render: () => <CharactersPanel />, scroll: true},
    script: {render: () => <ScriptList />, scroll: true},
    engines: {
      render: () => <EnginesPanel />,
      scroll: true,
      useAlert: () => useEngineProblems().length > 0,
    },
    preview: {render: () => <Preview />},
    // セリフ入力欄はタイムラインの一番下（YMM4 と同じ）
    timeline: {
      render: () => (
        <div className="vx-timeline-panel">
          <Timeline />
          <ScriptBar notify={notify} />
        </div>
      ),
    },
    inspector: {render: () => <Inspector notify={notify} />, scroll: true},
  };
}

/** 通知（トースト）。エラーも時間がたてば消す。key 付きは同じ種類を置き換える */
export function useNotify(): {notify: Notify; dismissers: React.MutableRefObject<Map<string, () => void>>} {
  const showToast = useToast();
  const dismissers = useRef(new Map<string, () => void>());
  const notify = useCallback<Notify>(
    (body, type = 'info', key, action) => {
      if (key) dismissers.current.get(key)?.();
      let dismiss: () => void = () => {};
      const endContent = action ? (
        <Button
          label={action.label}
          size="sm"
          variant="ghost"
          onClick={() => {
            action.onClick();
            dismiss();
          }}
        />
      ) : undefined;
      dismiss = showToast({
        body,
        type,
        endContent,
        isAutoHide: true,
        autoHideDuration: type === 'error' ? 10000 : action ? 7000 : 4000,
      });
      if (key) dismissers.current.set(key, dismiss);
    },
    [showToast],
  );
  return {notify, dismissers};
}

export function App() {
  const {notify, dismissers} = useNotify();
  useEffect(() => startHost(), []);
  const settingsOpen = useStore(s => s.settingsOpen);
  const setSettingsOpen = (o: boolean) => setState({settingsOpen: o});
  const [exportOpen, setExportOpen] = useState(false);
  const ready = useStore(s => s.project !== null);
  const panels = usePanels(notify);

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
    setOnDeleted(n =>
      notify(`${n} 個を削除しました`, 'info', 'deleted', {
        label: '元に戻す',
        onClick: undo,
      }),
    );
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
      } else if (e.shiftKey && !m && !e.altKey && PANEL_KEYS[e.code]) {
        // Shift+1〜5：パネルへ移る（Premiere Pro と同じく Shift+3 がタイムライン）
        e.preventDefault();
        focusPanel(PANEL_KEYS[e.code]);
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
              content={
                <LayoutContent padding={0} isScrollable={false}>
                  {ready && <Dock panels={panels} />}
                </LayoutContent>
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
      <WorkspaceDialog />
      <CharacterDialog />
    </Section>
  );
}
