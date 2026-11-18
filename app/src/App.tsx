// 画面全体：上＝ヘッダー、中＝パネル（Premiere Pro と同じく、タブをドラッグして自由に組み替えられる）、下＝セリフ入力。

import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {setHintsShown, useHintsShown} from './hints';
import {setThemeMode, useThemeMode, type ThemeMode} from './theme';
import {ACTION, actionFor, keyLabel, useKeymap, type ActionId} from './keymap';
import {modalOpen, onControl, startSpaceGuard} from './keys';
import {DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuDivider, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSubMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, Layout, LayoutContent, LayoutHeader} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Section} from '@astryxdesign/core/Section';
import {Text} from '@astryxdesign/core/Text';
import {useToast} from '@astryxdesign/core/Toast';
import {AudioWaveform, AudioLines, Redo2, Save, TriangleAlert, Undo2, Upload, UserPen} from 'lucide-react';
import {IconButton} from '@astryxdesign/core/IconButton';
import {
  addMarker,
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
import {boot, cancelSynthesis, exportStill, importSubtitleFile, newProjectAction, openProject, refreshEngines, saveProject, setClearNotice, setNotify, synthesize, type Notify} from './actions';
import {CharacterDialog} from './panels/CharacterDialog';
import {closeFloating, startHost} from './sync';
import {ExportDialog} from './panels/ExportDialog';
import {DescriptionDialog} from './panels/DescriptionDialog';
import {TemplatesDialog} from './panels/TemplatesDialog';
import {MediaDialog} from './panels/MediaDialog';
import {PasteScriptDialog} from './panels/PasteScriptDialog';
import {DictionaryDialog} from './panels/DictionaryDialog';
import {KeymapDialog} from './panels/KeymapDialog';
import {BackupDialog} from './panels/BackupDialog';
import {SplitDialog} from './panels/SplitDialog';
import {LibraryPanel} from './panels/LibraryPanel';
import {ShortcutsDialog} from './panels/ShortcutsDialog';
import {useFileDrop} from './drop';
import {api, setDirtyGetter} from './ipc';
import {Timeline} from './timeline/Timeline';
import {Preview} from './preview/Preview';
import {jumpTo, jumpToEdit, shuttleBackward, shuttleForward, step, stop, toggle} from './preview/playback';
import {Inspector} from './inspector/Inspector';
import {CharactersPanel, EnginesPanel, useEngineProblems} from './panels/Sidebar';
import {ENGINE_LABEL, framesToTimecode} from './model';
import {ScriptList} from './panels/ScriptList';
import {WorkspaceDialog} from './panels/WorkspaceDialog';
import {Dock, type Registry} from './dock/Dock';
import {PANEL_IDS, PANEL_TITLE, PRESETS, applyWorkspace, closePanel, deleteWorkspace, panelsIn, resetWorkspace, showPanel, useDock, workspaceName} from './dock/layout';
import type {PanelId} from './dock/layout';
import {ScriptBar} from './panels/ScriptBar';
import {SettingsDialog} from './panels/SettingsDialog';
import {ProjectSettingsDialog} from './panels/ProjectSettingsDialog';
import {UnsavedDialog} from './panels/UnsavedDialog';
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
  const run = useStore(s => s.synthRun);
  // 終わったら、同じ表示のまま帯を最後まで伸ばして「完了」を少し見せてから消す（消えたり幅が跳んだりしないように）
  const lastRun = useRef<typeof run>(null);
  const [finished, setFinished] = useState<{total: number} | null>(null);
  useLayoutEffect(() => {
    if (run) {
      lastRun.current = run;
      setFinished(null);
      return;
    }
    const was = lastRun.current;
    lastRun.current = null;
    if (!was) return;
    setFinished({total: was.total});
    const t = window.setTimeout(() => setFinished(null), 1100);
    return () => window.clearTimeout(t);
  }, [run]);
  // 合成中：何行のうち何行・残りの目安・中止（合成中も編集はそのまま続けられる）
  if (run || finished) {
    const done = run ? run.done : finished!.total;
    const total = run ? run.total : finished!.total;
    const per = run?.done ? run.workMs / run.done : 0;
    const left = Math.max(0, total - done);
    const eta = per ? Math.max(1, Math.round((left * per) / 1000)) : null;
    return (
      <div className="vx-synth-wrap" data-finished={!run || undefined}>
        <span className="vx-synth-run" role="status" aria-live="polite">
          <span className="vx-synth-run-bar" style={{width: `${(done / Math.max(1, total)) * 100}%`}} aria-hidden />
          {/* 何行かまとめて確定するので、その間も止まって見えないよう、見積もりの時間で次の区切りの手前まで薄く伸ばす */}
          {run && left > 0 && (
            <span
              key={run.done}
              className="vx-synth-run-creep"
              style={
                {
                  '--from': `${(run.done / Math.max(1, run.total)) * 100}%`,
                  '--to': `${((run.done + Math.min(3, left) * 0.9) / Math.max(1, run.total)) * 100}%`,
                  animationDuration: `${Math.round((per || 1500) * Math.min(3, left))}ms`,
                } as React.CSSProperties
              }
              aria-hidden
            />
          )}
          <span className="vx-synth-run-text">
            合成 {done}/{total}
            {!run ? '・完了' : eta !== null ? `・残り約 ${eta < 60 ? `${eta} 秒` : `${Math.round(eta / 60)} 分`}` : '・残りを計算中'}
          </span>
        </span>
        {/* 終わった後も場所は残す（表示が横へ跳ばないように） */}
        <span className="vx-synth-stop" aria-hidden={!run || undefined}>
          <Button label="合成を中止" size="sm" variant="secondary" tooltip="まだ始めていない行の合成をやめます（合成済みの行はそのまま）" isDisabled={!run} onClick={cancelSynthesis} />
        </span>
      </div>
    );
  }
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
    <span className="vx-pending-badge" data-hint="まだ音声を作っていないセリフの数です。「すべて合成」で作れます">
      未合成 {pending} 行
    </span>
  );
}

/**
 * 使っている音声合成ソフトが動いていないとき、見出しにずっと出す（押すとその場で設定を開いて直せる）。
 * パネルのタブの小さな点だけでは気づけないため
 */
function EngineAlert() {
  const problems = useEngineProblems();
  const engines = useStore(s => s.engines);
  if (!problems.length) return null;
  const first = engines.find(e => e.engine === problems[0]);
  const why = first && first.status.state === 'notRunning' ? 'が起動していません' : 'が見つかりません';
  const label = `${ENGINE_LABEL[problems[0]]} ${why}${problems.length > 1 ? `（ほか ${problems.length - 1}）` : ''}`;
  const detail = first && first.status.state !== 'ready' ? first.status.detail : '';
  return (
    <Button
      label={label}
      size="sm"
      variant="ghost"
      icon={<Icon icon={TriangleAlert} color="warning" />}
      tooltip={`${detail ? `${detail}。` : ''}押すと音声合成ソフトの設定を開きます`}
      onClick={() => setState({settingsOpen: true})}
    />
  );
}

/** ウィンドウ幅が狭いか（上のバーのボタンを絵だけにする） */
function useNarrow(px = 1200) {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return narrow;
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
  const empty = useStore(s => !s.project?.clips.length);
  const hints = useHintsShown();
  const themeMode = useThemeMode();
  const canPaste = useStore(s => s.clipboardCount > 0);
  const maxH = Math.max(320, (typeof window === 'undefined' ? 800 : window.innerHeight) - 80);
  useKeymap();
  const key = (k: string) => <Text type="supporting">{k}</Text>;
  const menu = (label: string) => ({label, variant: 'ghost' as const, size: 'sm' as const});
  return (
    <HStack gap={0} vAlign="center" role="menubar" aria-label="メニュー">
      <DropdownMenu button={menu('ファイル')} hasChevron={false} menuWidth={260} menuMaxHeight={maxH}>
        <DropdownMenuItem label="新規" endContent={key(keyLabel('new'))} onClick={() => void newProjectAction(notify)} />
        <DropdownMenuItem label="サンプルを開く" description="キャラクターとセリフの入った見本" onClick={() => void newProjectAction(notify, true)} />
        <DropdownMenuItem label="開く…" endContent={key(keyLabel('open'))} onClick={() => void openProject(notify)} />
        <DropdownMenuSubMenu label="最近使ったファイル" isDisabled={!recent.length}>
          {recent.map(path => (
            <DropdownMenuItem key={path} label={path.split(/[\\/]/).pop() ?? path} description={path} onClick={() => void openProject(notify, path)} />
          ))}
        </DropdownMenuSubMenu>
        <DropdownMenuDivider />
        <DropdownMenuItem label="保存" endContent={key(keyLabel('save'))} onClick={() => void saveProject(notify)} />
        <DropdownMenuItem label="名前を付けて保存…" endContent={key(keyLabel('saveAs'))} onClick={() => void saveProject(notify, true)} />
        <DropdownMenuItem label="以前の版から戻す…" description="上書き保存するたびに、前の内容を残しています" onClick={() => setState({backupOpen: true})} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="動画を書き出す…" isDisabled={busy} onClick={openExport} />
        <DropdownMenuItem label="この場面を画像で書き出す…" description="再生位置の画面を 1 枚の画像に（サムネイル用）" isDisabled={busy || empty} onClick={() => void exportStill(notify)} />
        <DropdownMenuItem label="マーカーと概要欄…" description="チャプターと声のクレジットを、貼れる文章に" onClick={() => setState({descriptionOpen: true})} />
        <DropdownMenuItem label="素材の場所と整理…" description="見つからない素材をつなぎ直す・1 つのフォルダに集める" onClick={() => setState({mediaOpen: true})} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="プロジェクトの設定…" description="動画の大きさ（縦長のショートも）・fps・背景色" onClick={() => setState({projectSettingsOpen: true})} />
        <DropdownMenuItem label="合成ソフトの設定…" onClick={openSettings} />
      </DropdownMenu>
      <DropdownMenu button={menu('編集')} hasChevron={false} menuWidth={240} menuMaxHeight={maxH}>
        <DropdownMenuItem label="元に戻す" isDisabled={!canUndo} endContent={key(keyLabel('undo'))} onClick={undo} />
        <DropdownMenuItem label="やり直す" isDisabled={!canRedo} endContent={key(keyLabel('redo'))} onClick={redo} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="切り取り" isDisabled={!hasSel} endContent={key(keyLabel('cut'))} onClick={() => cutSelection()} />
        <DropdownMenuItem label="コピー" isDisabled={!hasSel} endContent={key(keyLabel('copy'))} onClick={() => copySelection()} />
        <DropdownMenuItem label="貼り付け" isDisabled={!canPaste} endContent={key(keyLabel('paste'))} onClick={() => pasteClipboard()} />
        <DropdownMenuItem label="複製" isDisabled={!hasSel} endContent={key(keyLabel('duplicate'))} onClick={() => duplicateSelection()} />
        <DropdownMenuItem label="画面分割…" description="選んだ 2〜4 個の素材を、左右・上下・4 分割などに並べる" onClick={() => setState({splitOpen: true})} />
        <DropdownMenuItem label="削除" isDisabled={!hasSel} endContent={key(keyLabel('delete'))} onClick={() => deleteClips(editableSelection().map(c => c.id))} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="すべて選択" endContent={key(keyLabel('selectAll'))} onClick={() => selectAllClips()} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="再生位置にマーカーを付ける" endContent={key(keyLabel('marker'))} onClick={() => markHere(notify)} />
      </DropdownMenu>
      <DropdownMenu button={menu('表示')} hasChevron={false} menuWidth={240} menuMaxHeight={maxH}>
        <WindowMenu />
        <WorkspaceMenu />
        <DropdownMenuDivider />
        <DropdownMenuRadioGroup label="画面の明るさ" value={themeMode} onChange={v => setThemeMode(v as ThemeMode)}>
          <DropdownMenuRadioItem value="dark" label="ダーク" />
          <DropdownMenuRadioItem value="light" label="ライト" />
          <DropdownMenuRadioItem value="system" label="OS の設定に合わせる" />
        </DropdownMenuRadioGroup>
        <DropdownMenuDivider />
        <DropdownMenuCheckboxItem label="項目の説明を表示" description="オンなら、項目にマウスを 3 秒乗せると説明が出ます" value={hints} onChange={v => setHintsShown(v)} />
      </DropdownMenu>
      <DropdownMenu button={menu('ツール')} hasChevron={false} menuWidth={260} menuMaxHeight={maxH}>
        <DropdownMenuItem label="キャラクターの編集…" onClick={() => setState(s => ({characterDialogOpen: true, dialogCharacterId: s.selectedCharacterId}))} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="台本読み込み…" description="txt・csv・tsv の台本からセリフを追加" onClick={() => setState({pasteOpen: true})} />
        <DropdownMenuItem
          label="字幕ファイルの読み込み…"
          description="srt・vtt の字幕を、テキストとして時間どおりに並べる"
          onClick={() => {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = '.srt,.vtt';
            inp.onchange = () => {
              const f = inp.files?.[0];
              if (f)
                void importSubtitleFile(f).then(
                  n => notify(n ? `字幕を ${n} 個読み込みました（新しいレイヤー「字幕」）` : '字幕が見つかりませんでした', n ? 'info' : 'error'),
                  e => notify(`読み込めませんでした：${String(e)}`, 'error'),
                );
            };
            inp.click();
          }}
        />
        <DropdownMenuItem label="単語の読み（辞書）…" onClick={() => setState({dictionaryOpen: true})} />
        <DropdownMenuItem label="テンプレート…" description="アイテム・字幕の見た目・立ち絵の配置を使い回す" onClick={() => setState({templatesOpen: true})} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="未合成のセリフをすべて合成" isDisabled={busy} onClick={() => void synthesize(notify)} />
        <DropdownMenuItem label="音声合成ソフトの接続を確認" onClick={() => void refreshEngines()} />
      </DropdownMenu>
      <DropdownMenu button={menu('ヘルプ')} hasChevron={false} menuWidth={240}>
        <DropdownMenuItem label="キーボードショートカット" endContent={key(keyLabel('shortcuts'))} onClick={() => setState({shortcutsOpen: true})} />
        <DropdownMenuItem label="キー操作の割り当て…" onClick={() => setState({keymapOpen: true})} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="VoxCut について" onClick={() => notify(`VoxCut ${__APP_VERSION__}　A.I.VOICE・VOICEPEAK・VoiSona Talk・VOICEVOX と連携する動画編集ソフト`, 'info')} />
      </DropdownMenu>
    </HStack>
  );
}

/** 再生位置にマーカーを付けて、名前を付ける画面へ行けるようにする */
function markHere(notify: Notify) {
  const s = getState();
  if (!s.project) return;
  const had = (s.project.markers ?? []).some(x => x.frame === s.playhead);
  addMarker();
  notify(had ? 'この位置にはもうマーカーがあります' : `${framesToTimecode(s.playhead, s.project.video.fps)} にマーカーを付けました`, 'info', 'marker', {
    label: '名前を付ける',
    onClick: () => setState({descriptionOpen: true}),
  });
}

/** 元に戻す・やり直すをしたとき、ボタンの下に何が変わったかを少しだけ出す */
function HistoryFlash() {
  const flash = useStore(s => s.historyFlash);
  // 続けて押したら、消さずに文だけ替えて出している時間を延ばす（点滅させない）
  const [phase, setPhase] = useState<'off' | 'on' | 'leaving'>('off');
  useEffect(() => {
    if (!flash) return;
    setPhase('on');
    const t1 = window.setTimeout(() => setPhase('leaving'), 1280);
    const t2 = window.setTimeout(() => setPhase('off'), 1420);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [flash]);
  if (!flash || phase === 'off') return null;
  return (
    <span className="vx-history-flash" data-leaving={phase === 'leaving' || undefined} role="status">
      {flash.text}
    </span>
  );
}

function Header({notify, openSettings, openExport}: {notify: Notify; openSettings: () => void; openExport: () => void}) {
  const project = useStore(s => s.project);
  const dirty = useStore(s => s.dirty);
  const busy = useStore(s => s.busy);
  const canUndo = useStore(s => s.past.length > 0);
  const canRedo = useStore(s => s.future.length > 0);
  const narrow = useNarrow();
  // 合成するもの・書き出すものが無いときは押せなくする（押しても何も起きないボタンを強く見せない）
  const pending = useStore(s => s.project?.clips.filter(c => c.type === 'voice' && !c.audio && c.text.trim() && !s.synthStatus[c.id]).length ?? 0);
  const empty = useStore(s => !s.project?.clips.length);
  const synthTip = pending ? `未合成のセリフ ${pending} 行をすべて合成` : 'すべて合成済みです';
  const exportTip = empty ? 'タイムラインが空です。セリフを入れると書き出せます' : '動画を書き出す';
  return (
    <LayoutHeader padding={0}>
      <HStack gap={2} vAlign="center" hAlign="between" paddingInline={1} paddingBlock={1}>
        <HStack gap={1} vAlign="center">
          {/* アプリの印（声の波形をかたどった VoxCut のマーク） */}
          <span className="vx-brand" title="VoxCut" aria-hidden>
            <svg viewBox="0 0 20 20" width="18" height="18">
              <rect width="20" height="20" rx="5" fill="var(--color-accent)" />
              <path d="M5 8v4M8 5.5v9M11 7v6M14 4.5v11" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <MenuBar notify={notify} openSettings={openSettings} openExport={openExport} />
          <div className="vx-toolbar-sep" aria-hidden />
          {/* よく使う操作は、メニューを開かなくても押せるように（ツールバー） */}
          <IconButton label="保存" tooltip={`保存（${mod}S）`} variant="ghost" size="sm" icon={<Icon icon={Save} />} clickAction={() => saveProject(notify)} />
          <IconButton label="元に戻す" tooltip={`元に戻す（${mod}Z）`} variant="ghost" size="sm" icon={<Icon icon={Undo2} />} isDisabled={!canUndo} onClick={undo} />
          <span className="vx-history">
            <IconButton label="やり直す" tooltip={`やり直す（${isMac ? '⇧⌘Z' : 'Ctrl+Y'}）`} variant="ghost" size="sm" icon={<Icon icon={Redo2} />} isDisabled={!canRedo} onClick={redo} />
            <HistoryFlash />
          </span>
          {narrow ? (
            <IconButton
              label="キャラクター"
              tooltip="キャラクターの編集（声・字幕・立ち絵）"
              variant="ghost"
              size="sm"
              icon={<Icon icon={UserPen} />}
              onClick={() => setState(s => ({characterDialogOpen: true, dialogCharacterId: s.selectedCharacterId}))}
            />
          ) : (
            <Button
              label="キャラクター"
              tooltip="キャラクターの編集（声・字幕・立ち絵）"
              variant="ghost"
              size="sm"
              icon={<Icon icon={UserPen} />}
              onClick={() => setState(s => ({characterDialogOpen: true, dialogCharacterId: s.selectedCharacterId}))}
            />
          )}
          {/* 歯車だけだと「プロジェクトの設定」に見えるので、声の印と名前を付ける（狭いときは印だけ） */}
          {narrow ? (
            <IconButton
              label="合成ソフトの設定"
              tooltip="音声合成ソフト（VOICEVOX など）の設定：つなぎ先・話者の一覧"
              variant="ghost"
              size="sm"
              icon={<Icon icon={AudioWaveform} />}
              onClick={openSettings}
            />
          ) : (
            <Button
              label="合成ソフトの設定"
              tooltip="音声合成ソフト（VOICEVOX など）の設定：つなぎ先・話者の一覧"
              variant="ghost"
              size="sm"
              icon={<Icon icon={AudioWaveform} />}
              onClick={openSettings}
            />
          )}
          <div className="vx-toolbar-sep" aria-hidden />
          <span className="vx-project-name">
            <Text type="label" maxLines={1}>
              {project?.name ?? 'VoxCut'}
            </Text>
          </span>
          {dirty && <span className="vx-unsaved">未保存</span>}
        </HStack>

        <HStack gap={2} vAlign="center">
          {busy && (
            <HStack gap={2} vAlign="center" width={narrow ? 140 : 220}>
              <Text type="supporting" maxLines={1}>
                {busy.label}
              </Text>
              <div style={{flex: 1}}>
                <ProgressBar label={busy.label} isLabelHidden value={(busy.ratio ?? 0) * 100} isIndeterminate={busy.ratio === null} />
              </div>
            </HStack>
          )}
          <EngineAlert />
          <SynthStatus />
          {narrow ? (
            <IconButton label="すべて合成" tooltip={synthTip} size="sm" icon={<Icon icon={AudioLines} />} isDisabled={!!busy || !pending} onClick={() => void synthesize(notify)} />
          ) : (
            <Button
              label="すべて合成"
              tooltip={synthTip}
              size="sm"
              variant={pending ? 'secondary' : 'ghost'}
              icon={<Icon icon={AudioLines} />}
              isDisabled={!!busy || !pending}
              onClick={() => void synthesize(notify)}
            />
          )}
          {/* 画面で唯一の主要ボタン（HIG：filled は 1 つ） */}
          <span className="vx-primary-cta">
            <Button label={narrow ? '書き出す…' : '動画を書き出す…'} tooltip={exportTip} variant="primary" size="sm" icon={<Icon icon={Upload} />} isDisabled={!!busy || empty} onClick={openExport} />
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
    library: {render: () => <LibraryPanel />, scroll: true},
  };
}

/** 通知（トースト）。エラーも時間がたてば消す。key 付きは同じ種類を置き換える */
export function useNotify(): {notify: Notify; dismissers: React.MutableRefObject<Map<string, () => void>>} {
  const showToast = useToast();
  const dismissers = useRef(new Map<string, () => void>());
  /** 直前に出した知らせ（同じ文を続けて 2 枚出さない） */
  const last = useRef<{body: unknown; at: number}>({body: null, at: 0});
  /** いま出ている「お知らせ」（押すボタンの無いもの）。元に戻す・やり直すで状況が変わったら片付ける */
  const liveInfo = useRef(new Set<() => void>());
  const historySeq = useStore(s => s.historyFlash?.seq ?? 0);
  useEffect(() => {
    for (const d of liveInfo.current) d();
    liveInfo.current.clear();
  }, [historySeq]);
  const notify = useCallback<Notify>(
    (body, type = 'info', key, action) => {
      const now = performance.now();
      if (typeof body === 'string' && last.current.body === body && now - last.current.at < 1500) return;
      last.current = {body, at: now};
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
      if (type === 'info' && !action) {
        liveInfo.current.add(dismiss);
        // 山のようにためない
        if (liveInfo.current.size > 12) liveInfo.current.delete(liveInfo.current.values().next().value!);
      }
    },
    [showToast],
  );
  return {notify, dismissers};
}

/** 割り当てたキーで動かす操作 */
function runAction(act: ActionId, notify: (m: string) => void) {
  const fps = getState().project?.video.fps ?? 30;
  switch (act) {
    case 'new':
      return void newProjectAction(notify);
    case 'open':
      return void openProject(notify);
    case 'save':
      return void saveProject(notify);
    case 'saveAs':
      return void saveProject(notify, true);
    case 'undo':
      return undo();
    case 'redo':
      return redo();
    case 'focusInput':
      return document.querySelector<HTMLInputElement>('[data-script-input] input')?.focus();
    case 'find':
    case 'replace':
      // 台本を探す・置き換える：台本パネルを出して、探す欄へ（今は隠れていて、まだ作られていないこともある）
      showPanel('script');
      setTimeout(() => {
        // 台本パネルが「文書で書く」なら一覧へ戻す（探す欄は一覧にある）
        window.dispatchEvent(new Event('vx-open-search'));
        if (act === 'replace') window.dispatchEvent(new Event('vx-open-replace'));
      }, 80);
      setTimeout(() => document.querySelector<HTMLInputElement>('[data-script-search] input')?.focus(), 160);
      return;
    case 'shortcuts':
      return setState({shortcutsOpen: true});
    case 'play':
      return toggle();
    case 'stop':
      return stop();
    case 'shuttleForward':
      return shuttleForward();
    case 'shuttleBackward':
      return shuttleBackward();
    case 'frameBack':
      return step(-1);
    case 'frameForward':
      return step(1);
    case 'secondBack':
      return step(-fps);
    case 'secondForward':
      return step(fps);
    case 'prevEdit':
      return jumpToEdit(-1);
    case 'nextEdit':
      return jumpToEdit(1);
    case 'toStart':
      return jumpTo('start');
    case 'toEnd':
      return jumpTo('end');
    case 'marker':
      return markHere(notify);
    case 'split':
      if (!splitClip(getState().selectedClipId!, getState().playhead)) notify('素材を再生位置で分けられます（セリフは分けられません）');
      return;
    case 'delete': {
      const ids = editableSelection().map(c => c.id);
      if (ids.length) deleteClips(ids);
      else notify('ロックしたレイヤーのアイテムは消せません');
      return;
    }
    case 'selectAll':
      return selectAllClips();
    case 'copy': {
      const n = copySelection();
      if (n) notify(`${n} 個を写しました`);
      return;
    }
    case 'cut': {
      const n = cutSelection();
      if (n) notify(`${n} 個を切り取りました`);
      return;
    }
    case 'paste':
      if (!hasClipboard()) notify('貼り付けるものがありません。台本の文を貼るときは、メニューの「台本を貼り付け」を使ってください');
      else pasteClipboard();
      return;
    case 'duplicate':
      return duplicateSelection();
  }
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

  // マウスで押したボタンの上での Space は再生（ボタンをもう一度押さない）
  useEffect(() => startSpaceGuard(toggle), []);

  // キーボードショートカット（入力欄にいるときは奪わない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      // 矢印キーを自分で使う部品（境目・タブ・一覧・メニュー・スライダー）にフォーカスがあるときは奪わない
      // （タイムライン・プレビューは自分で使うキーだけ止めるので、ここでは除かない）
      const inPanel = !!t.closest('[role="separator"], [role="tablist"], [role="listbox"], [role="menu"], [role="slider"]');
      const m = e.metaKey || e.ctrlKey;
      // ダイアログを開いている間は、後ろの編集画面のショートカットを効かせない（Delete で後ろのセリフが消える、Space で再生が始まる等を防ぐ）。
      // 保存（Ctrl+S）だけは通す
      if (modalOpen() && !['save', 'saveAs'].includes(actionFor(e) ?? '')) return;
      // ボタン・メニュー項目・タブ・スイッチなどにフォーカスがあるときの Space は、その部品の操作（押す・チェック）に使う
      if (e.key === ' ' && onControl(t)) return;
      // 割り当てたキーの操作（設定の「キー操作の割り当て」で変えられる）
      const act = actionFor(e);
      if (act && (!typing || ACTION[act].whileTyping) && !(ACTION[act].nav && inPanel)) {
        // S（分ける）は、選んだものがなければ何もしない（ほかで使うかもしれないので止めない）
        if (act === 'split' && !getState().selectedClipId) return;
        if (act === 'delete' && !getState().selectedClipIds.length) return;
        e.preventDefault();
        runAction(act, notify);
        return;
      }
      if (e.key === 'Escape' && getState().previewFull) {
        e.preventDefault();
        void toggleFullscreen();
      } else if (typing) {
        return;
      } else if (e.shiftKey && !m && !e.altKey && PANEL_KEYS[e.code]) {
        // Shift+1〜5：パネルへ移る（Premiere Pro と同じく Shift+3 がタイムライン）
        e.preventDefault();
        focusPanel(PANEL_KEYS[e.code]);
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
      <ProjectSettingsDialog />
      <UnsavedDialog />
      <ExportDialog isOpen={exportOpen} onOpenChange={setExportOpen} />
      <PasteScriptDialog notify={notify} />
      <ShortcutsDialog />
      <KeymapDialog />
      <BackupDialog notify={notify} />
      <SplitDialog />
      {dropActive && (
        <div className="vx-drop" aria-hidden>
          <div className="vx-drop-card">
            <Text type="label">ここに放すと追加します</Text>
            <Text type="supporting">画像・動画・音声は再生位置に。.voxcut は開き、.voxchar はキャラクターとして読み込みます</Text>
          </div>
        </div>
      )}
      <DictionaryDialog notify={notify} />
      <DescriptionDialog />
      <TemplatesDialog notify={notify} />
      <MediaDialog notify={notify} />
      <WorkspaceDialog />
      <CharacterDialog />
    </Section>
  );
}
