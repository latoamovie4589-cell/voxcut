// タイムライン。クリップを DOM にせず Canvas 1 枚に描き、表示範囲だけを描画する。
// - スクロールは縦横ともネイティブ（中身の大きさだけ持つ空 div）。Canvas は sticky で表示枠に固定
// - ルーラーは常に上に固定、トラック見出しは縦スクロールに合わせて動かす
// - キーボード：←→ コマ送り・↑↓ 編集点（全体のショートカット）、Ctrl+矢印でクリップ選択、Alt+←→ / , . で選んだクリップを動かす
// - 選んだクリップの内容は aria-live で読み上げる

import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {showPanel} from '../dock/layout';
import {Button} from '@astryxdesign/core/Button';
import {DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuDivider, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem} from '@astryxdesign/core/DropdownMenu';
import {ContextMenu, type ContextMenuOption} from '@astryxdesign/core/ContextMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack} from '@astryxdesign/core/Layout';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {
  Circle,
  Ellipsis,
  Eye,
  EyeOff,
  ImagePlus,
  Link2,
  Lock,
  LockOpen,
  Maximize2,
  Minus,
  PersonStanding,
  Plus,
  RectangleHorizontal,
  Rows3,
  Shapes,
  Sparkles,
  Square,
  Star,
  Triangle,
  Type,
  ZoomIn,
  ZoomOut,
  Heart,
  ArrowRight,
  MessageCircle,
  Cloud,
  Droplet,
  Angry,
  CircleAlert,
  CircleHelp,
  Zap,
  Sun,
  Sticker,
  Music2,
  Clapperboard,
} from 'lucide-react';
import type {Clip, MediaClip, Project, Track} from '../model';
import {
  BASIC_SHAPES,
  SFX_LIST,
  SHAPE_LABEL,
  CONTROL_LABEL,
  MAIN_SCENE,
  STICKERS,
  type ShapeKind,
  isVisual,
  prevAdjacent,
  overlappingLines,
  framesToTimecode,
  layerLabel,
  projectDuration,
  startOffsetOf,
  trackCode,
  speedsOf,
  keyframeTimes,
} from '../model';
import {TEXT_STYLES} from '../textStyles';
import {
  getState,
  addCharacter,
  moveClip,
  moveClips,
  moveDestination,
  setLayerSize,
  removeTrack,
  selectClip,
  setState,
  trimClip,
  updateTrack,
  addTrack,
  useStore,
  copySelection,
  cutSelection,
  pasteClipboard,
  duplicateSelection,
  deleteClips,
  setCharacterForSelection,
  addVisualItem,
  addSticker,
  addRegion,
  addAudioViz,
  addControl,
  addScene,
  addSceneItem,
  deleteScene,
  openScene,
  updateClip,
  selectOnly,
  setLinkedSelection,
  linkClips,
  unlinkClips,
  canSeparate,
  canMerge,
  separateClip,
  mergeClip,
  addPortraitItem,
} from '../store';
import {getPeaks, onPeaks} from '../peaks';
import {addMedia, addSfx, getNotify, synthesize} from '../actions';
import './timeline.css';

const RULER_H = 26;
/** レイヤーの高さ：小（YMM4 と同じくらい細い）・中（波形と名前が分かれて読める）・大。タイムラインの上の「レイヤーの高さ」で選ぶ */
export const LAYER_SIZES = {small: 26, medium: 40, large: 56} as const;
export type LayerSize = keyof typeof LAYER_SIZES;
/** 今のレイヤーの高さ（Timeline が描くたびに設定から入れる） */
let LAYER_H: number = LAYER_SIZES.small;
/** 位置・長さが変わったときに、なめらかに動かす時間（ms） */
const ANIM_MS = 160;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
type ClipAnim = {t0: number; kind: 'move' | 'add'; fromStart: number; fromDur: number; fromTrack: string};
const HEADER_W = 224;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 40;
/** 端をつかめる幅（px） */
const EDGE_PX = 7;
/** スナップが効く距離（px） */
const SNAP_PX = 8;
const FONT = '-apple-system, "Segoe UI", "Yu Gothic UI", system-ui, sans-serif';

// ───────────── 色（テーマのトークンを読む。ライト/ダーク切替に追従） ─────────────
interface Palette {
  bg: string;
  lane: string;
  laneAlt: string;
  border: string;
  text: string;
  text2: string;
  accent: string;
  error: string;
  warn: string;
}

// トークンは light-dark() などで書かれていて Canvas にはそのまま渡せないので、
// 隠し要素の color に当てて、ブラウザに rgb() へ解決させる
let probe: HTMLSpanElement | null = null;
function resolveColor(host: HTMLElement, token: string, fallback: string): string {
  probe ??= Object.assign(document.createElement('span'), {
    style: 'display:none',
  });
  host.appendChild(probe);
  probe.style.color = fallback;
  probe.style.color = `var(${token}, ${fallback})`;
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c || fallback;
}
function readPalette(el: HTMLElement): Palette {
  const v = (n: string, f: string) => resolveColor(el.parentElement ?? el, n, f);
  return {
    bg: v('--color-background-surface', '#fff'),
    lane: v('--color-background-surface', '#fff'),
    laneAlt: v('--color-background-muted', '#f2f2f7'),
    border: v('--color-border', 'rgba(60,60,67,.29)'),
    text: v('--color-text-primary', '#000'),
    text2: v('--color-text-secondary', '#5B5B63'),
    accent: v('--color-accent', '#6E56CF'),
    error: v('--color-error', '#FF3B30'),
    warn: v('--color-warning', '#E9AF08'),
  };
}

/**
 * 画面での並び（YMM4 と同じ）：レイヤー 1 が一番上、下へ 2, 3, …（番号の大きいレイヤーほど手前に描く）
 */
export function trackRows(p: Project): Track[] {
  return p.tracks;
}

function trackTops(p: Project) {
  const rows = trackRows(p);
  const tops = rows.map((_, i) => i * LAYER_H);
  return {rows, tops, height: rows.length * LAYER_H};
}

function clipColor(p: Project, c: Clip): string {
  if (c.type === 'voice') return p.characters.find(ch => ch.id === c.characterId)?.color ?? '#8E8E93';
  if (c.type === 'caption') {
    const v = p.clips.find(x => x.id === c.voiceId);
    return (v?.type === 'voice' && p.characters.find(ch => ch.id === v.characterId)?.color) || '#8E8E93';
  }
  if (c.type === 'portrait') return p.characters.find(ch => ch.id === c.characterId)?.color ?? '#8E8E93';
  // YMM4 と同じく、テキストは青系・図形は緑系
  if (c.type === 'text') return '#3478F6';
  if (c.type === 'shape') return '#34C759';
  return c.mediaKind === 'audio' ? '#30B0C7' : c.mediaKind === 'video' ? '#AF52DE' : '#8E8E93';
}

/** 読み上げ・台本で使うクリップの説明 */
/** タイムラインの何もないところに 3 秒乗せると出す案内 */
const TIMELINE_HELP =
  '下の入力欄にセリフを打って Enter で追加。画像・動画・BGM はドラッグ＆ドロップで追加。どのアイテムもどのレイヤーにも置けます（番号の大きいレイヤーほど手前）。セリフや音の入った動画は右クリックで分離。アイテムの端をドラッグで長さ調整（Alt でスナップ解除）・Ctrl+クリックで複数選択・? でショートカット一覧';

export function describeClip(p: Project, c: Clip, synthErrors: Record<string, string>): string {
  const fps = p.video.fps;
  const where = `${framesToTimecode(c.start, fps)} から 長さ ${framesToTimecode(c.duration, fps)}`;
  if (c.type === 'voice') {
    const ch = p.characters.find(x => x.id === c.characterId)?.name ?? '?';
    const st = synthErrors[c.id] ? '合成に失敗' : c.audio ? '合成済み' : '未合成';
    return `セリフ、${ch}「${c.text}」、${where}、${st}${overlappingLines(p).has(c.id) ? '\n⚠ ほかのセリフと時間が重なっています（声が同時に鳴ります）。わざとでなければ、どちらかを横にずらしてください' : ''}`;
  }
  if (c.type === 'caption') {
    const v = p.clips.find(x => x.id === c.voiceId);
    return `字幕「${v?.type === 'voice' ? (v.subtitle ?? v.text) : ''}」、${where}${c.linkId ? '、セリフとリンク' : ''}`;
  }
  if (c.type === 'portrait') return `立ち絵、${p.characters.find(x => x.id === c.characterId)?.name ?? '?'}、${where}`;
  if (c.type === 'text') return `テキスト「${c.text}」、${where}`;
  if (c.type === 'shape') return c.control ? `${CONTROL_LABEL[c.control.kind]}、${where}` : `図形（${SHAPE_LABEL[c.shape]}）、${where}`;
  const kind = c.mediaKind === 'image' ? '画像' : c.mediaKind === 'video' ? '動画' : '音声';
  return `${kind}、${c.src.split(/[\\/]/).pop()}、${where}`;
}

type DragMode = 'move' | 'trimStart' | 'trimEnd';

interface Drag {
  clipId: string;
  mode: DragMode;
  startX: number;
  origStart: number;
  origDuration: number;
  origTrack: string;
  /** ドラッグ中の仮の位置・長さ・トラック（ドロップ時に 1 回だけ履歴に残す） */
  start: number;
  duration: number;
  trackId: string;
  moved: boolean;
  targets: number[];
  snappedAt: number | null;
  /** 一緒に動かす、ほかの選択中のクリップ（同じだけずらす） */
  group: string[];
  /** リンクしていて付いてくるクリップ（ドラッグ中も一緒に動いて見せる） */
  linked: string[];
  /** リンクしているのに片方だけ選んでいる：落とすとリンクを外してそれだけ動かす */
  solo?: boolean;
  /** Ctrl（⌘）を押している：落とすと挿入して後ろを押し出す */
  insert?: boolean;
  /** 置けない種類のトラック（映像 ↔ 音声）の上にいる：そのトラックの id */
  forbidden?: string | null;
  /** つかんだときの横スクロール（端で自動スクロールしても位置がずれないように） */
  startScroll: number;
  /** Esc で取り消すときに、つかみを放す */
  pointerId: number;
  captureEl: Element;
}

function nearest(targets: number[], f: number): number | null {
  let best: number | null = null;
  for (const t of targets) if (best === null || Math.abs(t - f) < Math.abs(best - f)) best = t;
  return best;
}

// ───────────── トラック見出し ─────────────

/**
 * レイヤーの見出し（YMM4 と同じ並び）。番号・名前・目（表示）・M（音だけ止める）・S（ソロ）・ロック。ホイールクリックで表示の切り替え
 */
function TrackHeader({track}: {track: Track}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(track.name);
  const label = useStore(s => (s.project ? layerLabel(s.project, track.id) : ''));
  const code = useStore(s => (s.project ? trackCode(s.project, track.id) : ''));
  const index = useStore(s => (s.project ? s.project.tracks.findIndex(t => t.id === track.id) : 0));
  const finish = () => {
    setEditing(false);
    if (name !== track.name) updateTrack(track.id, {name: name.trim()});
  };
  const toggleOut = () => updateTrack(track.id, {hidden: !track.hidden});
  const headerRef = useRef<HTMLDivElement>(null);
  // 「…」と見出しの右クリックで同じメニュー。オン・オフはチェックボックス、下げ幅は丸の選択（読み上げでも状態が伝わる）
  const hint = (text: string, help: string) => (
    <span title={help} aria-description={help} className="vx-menu-label">
      {text}
    </span>
  );
  const menu = (
    <>
      <DropdownMenuItem label="素材を追加…" onClick={() => void addMedia()} />
      <DropdownMenuDivider />
      <DropdownMenuCheckboxItem label={hint('セリフ中は音を下げる', 'BGM がセリフの邪魔にならないよう、自動で下げます')} value={track.duck} onChange={duck => updateTrack(track.id, {duck})} />
      {track.duck && (
        <DropdownMenuRadioGroup label="下げる量" value={String([0.5, 0.3, 0.15].find(v => Math.abs(track.duckLevel - v) < 0.01) ?? '')} onChange={v => updateTrack(track.id, {duckLevel: Number(v)})}>
          {(
            [
              ['少し下げる', 0.5],
              ['下げる', 0.3],
              ['大きく下げる', 0.15],
            ] as const
          ).map(([l, v]) => (
            <DropdownMenuRadioItem key={v} value={String(v)} label={`${l}（${Math.round(v * 100)}%）`} />
          ))}
        </DropdownMenuRadioGroup>
      )}
      <DropdownMenuDivider />
      {/* 上ほど番号が小さい（上に足す = この番号に入れる） */}
      <DropdownMenuItem label="上にレイヤーを追加" onClick={() => addTrack('video', index)} />
      <DropdownMenuItem label="下にレイヤーを追加" onClick={() => addTrack('video', index + 1)} />
      <DropdownMenuItem label="名前を変更" onClick={() => setEditing(true)} />
      <DropdownMenuDivider />
      <DropdownMenuItem label="レイヤーを削除" variant="destructive" onClick={() => removeTrack(track.id)} />
    </>
  );
  const header = (
    <div
      ref={headerRef}
      // 右クリックで開くときも、先にこの行の「…」へフォーカスを置く（閉じたあと、そこへ戻れるように）
      onContextMenuCapture={() => headerRef.current?.querySelector<HTMLElement>('button[aria-haspopup]')?.focus({preventScroll: true})}
      className="vx-track-header"
      style={{height: LAYER_H}}
      data-tall={LAYER_H >= 30 || undefined}
      data-muted={track.hidden || undefined}
      onAuxClick={e => {
        if (e.button === 1) toggleOut();
      }}
      onMouseDown={e => {
        if (e.button === 1) e.preventDefault();
      }}>
      {/* YMM4 と同じく、名前を付けていなければ「レイヤー 1」。ダブルクリックで名前を変える */}
      <div className="vx-track-name" onDoubleClick={() => setEditing(true)} title={track.name ? `${code}（${track.name}）` : undefined}>
        {editing ? (
          <TextInput label="レイヤー名" isLabelHidden size="sm" value={name} placeholder={code} onChange={setName} onEnter={finish} onBlur={finish} hasAutoFocus width={110} />
        ) : (
          <Text type="label" maxLines={1}>
            {track.name || code}
          </Text>
        )}
      </div>
      <HStack gap={0} vAlign="center">
        <IconButton
          label={`${label} を表示`}
          tooltip={track.hidden ? 'レイヤーを表示する（見出しをホイールクリックでも）' : 'レイヤーを隠す（映像も音も出さない。見出しをホイールクリックでも）'}
          variant="ghost"
          size="sm"
          icon={<Icon icon={track.hidden ? EyeOff : Eye} />}
          aria-pressed={!track.hidden}
          onClick={toggleOut}
        />
        <button
          type="button"
          className="vx-track-toggle"
          aria-pressed={track.muted}
          aria-label={`${label} をミュート`}
          title={track.muted ? 'ミュートを解除' : 'ミュート（音だけ止める）'}
          onClick={() => updateTrack(track.id, {muted: !track.muted})}>
          M
        </button>
        <button
          type="button"
          className="vx-track-toggle"
          data-solo
          aria-pressed={!!track.solo}
          aria-label={`${label} をソロ`}
          title={track.solo ? 'ソロを解除' : 'ソロ（このレイヤーの音だけ鳴らす）'}
          onClick={() => updateTrack(track.id, {solo: !track.solo})}>
          S
        </button>
        <IconButton
          label={`${label} をロック`}
          tooltip={track.locked ? 'ロックを外す' : 'レイヤーをロック（動かせなくする）'}
          variant="ghost"
          size="sm"
          icon={<Icon icon={track.locked ? Lock : LockOpen} />}
          aria-pressed={track.locked}
          onClick={() => updateTrack(track.id, {locked: !track.locked})}
        />
        <DropdownMenu
          button={{label: `${label}のメニュー`, tooltip: 'レイヤーのメニュー（見出しの右クリックでも）', variant: 'ghost', size: 'sm', isIconOnly: true, icon: <Icon icon={Ellipsis} />}}
          hasChevron={false}
          menuWidth={240}>
          {menu}
        </DropdownMenu>
      </HStack>
    </div>
  );
  // 見出しの右クリックでも「…」と同じメニューを出す
  return (
    <ContextMenu
      menuContent={menu}
      menuWidth={240}
      label={`${label}のメニュー`}
      onOpenChange={open => {
        // Esc などで閉じたとき、フォーカスが行き場を失ったら、この見出しの「…」へ戻す（キーボードで続けて操作できるように）
        if (!open)
          setTimeout(() => {
            if (document.activeElement === document.body || !document.activeElement) headerRef.current?.querySelector<HTMLElement>('button[aria-haspopup]')?.focus();
          }, 0);
      }}>
      {header}
    </ContextMenu>
  );
}

/**
 * 空のプロジェクトでタイムラインに出す「最初の 3 手順」。終わった手順には印が付き、何か置けば消える。
 * 見本を見たい人には「サンプルを開く」
 */
function StartCard() {
  const chars = useStore(s => s.project?.characters.length ?? 0);
  // タイムラインが低い（720p など）ときは説明文を省いた短い形にする（文の途中で切れないように）
  const ref = useRef<HTMLElement>(null);
  const [short, setShort] = useState(false);
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const ro = new ResizeObserver(() => setShort(host.clientHeight < 200));
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  const step = (done: boolean, n: number, title: string, body: React.ReactNode) => (
    <li className="vx-start-step" data-done={done || undefined}>
      <span className="vx-start-num" aria-hidden>
        {done ? '✓' : n}
      </span>
      <div>
        <div className="vx-start-title">
          {title}
          {done && <VisuallyHidden>（済み）</VisuallyHidden>}
        </div>
        <div className="vx-start-body">{body}</div>
      </div>
    </li>
  );
  return (
    <section ref={ref} className="vx-start" data-short={short || undefined} aria-label="最初の 3 手順">
      <div className="vx-start-top">
        <h2 className="vx-start-head">最初の 3 手順</h2>
        <Button label="サンプルを開いて見る" size="sm" variant="ghost" onClick={() => void import('../actions').then(m => m.newProjectAction(m.getNotify(), true))} />
      </div>
      <ol className="vx-start-list">
        {step(
          chars > 0,
          1,
          '話すキャラクターを作る',
          chars > 0 ? (
            `${chars} 人います。声や立ち絵は「キャラクター」で変えられます`
          ) : (
            <Button
              label="キャラクターを作る…"
              size="sm"
              variant="primary"
              onClick={() => {
                const id = addCharacter();
                setState({characterDialogOpen: true, dialogCharacterId: id});
              }}
            />
          ),
        )}
        {step(false, 2, 'セリフを打って Enter', '下の入力欄に打つと、声と字幕がタイムラインに並びます（台本をまとめて貼っても入ります）')}
        {step(false, 3, '書き出す', '右上の「動画を書き出す…」から。音声だけ・字幕だけも書き出せます')}
      </ol>
    </section>
  );
}

/** ピークの一番大きい値（波形の高さを揃えるため。行ごとに一度だけ数える） */
const peakMaxCache = new WeakMap<ArrayLike<number>, number>();
function peakMax(pk: ArrayLike<number>): number {
  let m = peakMaxCache.get(pk);
  if (m === undefined) {
    m = 0;
    for (let i = 0; i < pk.length; i++) m = Math.max(m, Math.abs(pk[i]));
    // ほとんど無音なら揃えない（雑音を大きく見せない）
    m = Math.max(m, 16);
    peakMaxCache.set(pk, m);
  }
  return m;
}

/** 図形メニューの絵（ツールバーと同じく、項目にも形を出す） */
const SHAPE_ICON: Record<ShapeKind, typeof Square> = {
  rect: RectangleHorizontal,
  roundRect: Square,
  ellipse: Circle,
  triangle: Triangle,
  line: Minus,
  star: Star,
  heart: Heart,
  arrow: ArrowRight,
  bubble: MessageCircle,
  thought: Cloud,
  sparkle: Sparkles,
  sweat: Droplet,
  anger: Angry,
  exclaim: CircleAlert,
  question: CircleHelp,
  burst: Zap,
  speed: Sun,
};

/** メニューの右端に出すショートカット */
const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';
const menuKey = (k: string) => <span className="vx-menu-key">{k}</span>;

/** メニューの項目を整える：空の項目を除き、先頭・末尾・続きの区切り線を取る */
function tidyMenu(items: (ContextMenuOption | null)[]): ContextMenuOption[] {
  const isDiv = (x: ContextMenuOption | undefined) => !!x && 'type' in x && (x as {type?: string}).type === 'divider';
  const out: ContextMenuOption[] = [];
  for (let x of items) {
    if (!x) continue;
    x = hoverDescription(x);
    if (isDiv(x) && (!out.length || isDiv(out[out.length - 1]))) continue;
    out.push(x);
  }
  while (isDiv(out[out.length - 1])) out.pop();
  return out;
}

/**
 * メニューの説明は行の下に並べず、マウスを乗せたときに出す（メニューが横に広がらないように）。
 * 読み上げ用には aria-description に入れる
 */
function hoverDescription<T extends ContextMenuOption>(x: T): T {
  if (!('label' in x)) return x;
  const it = x as T & {description?: string; label: React.ReactNode; items?: ContextMenuOption[]};
  const items = it.items?.map(hoverDescription);
  if (!it.description) return items ? ({...it, items} as T) : x;
  const {description, ...rest} = it;
  return {
    ...rest,
    ...(items ? {items} : {}),
    label: (
      <span title={description} aria-description={description} className="vx-menu-label">
        {it.label}
      </span>
    ),
  } as unknown as T;
}

/** キャラクターの編集の「立ち絵」タブを開く（PSD をまだ設定していないとき） */
/** 端からこの距離（px）に入ったら自動で横にスクロールする */
const EDGE_SCROLL = 40;
/** スクロールする枠の左にある、時間の流れない部分（見出しは別の枠なので 0） */
const HEADER_W_IN_SCROLL = 0;

const openPortraitSettings = (characterId: string) => setState({dialogCharacterId: characterId, inspectorTab: 'portrait', characterDialogOpen: true});

// ───────────── 本体 ─────────────

/** プロパティの「かんたんエフェクト」を見える位置に出して、最初の見本に移る */
function openQuickEffects() {
  showPanel('inspector');
  window.setTimeout(() => {
    const grid = document.querySelector('.vx-fx-grid');
    grid?.scrollIntoView({block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    grid?.querySelector<HTMLButtonElement>('.vx-fx-tile')?.focus({preventScroll: true});
  }, 60);
}

/** 素材の名前の前に付ける印（速さ・逆再生・静止） */
function mediaBadge(m: MediaClip): string {
  if (m.freeze) return '❄ 静止  ';
  const [a, b] = speedsOf(m);
  const r = (v: number) => Math.round(v * 100) / 100;
  const sp = Math.abs(a - b) > 1e-9 ? `${r(a)}→${r(b)}×  ` : Math.abs(a - 1) > 1e-9 ? `${r(a)}×  ` : '';
  return `${m.reverse ? '⟲ ' : ''}${sp}`;
}

export function Timeline() {
  const layerSize = useStore(s => s.layerSize);
  LAYER_H = LAYER_SIZES[layerSize] ?? LAYER_SIZES.small;
  const project = useStore(s => s.project);
  const selected = useStore(s => s.selectedClipId);
  const playhead = useStore(s => s.playhead);
  const zoom = useStore(s => s.zoom);
  const proxies = useStore(s => s.proxies);
  const synthErrors = useStore(s => s.synthErrors);
  const synthStatus = useStore(s => s.synthStatus);
  const revealSeq = useStore(s => s.revealSeq);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 幅が狭いときはツールバーを詰める（ボタンをアイコンだけに、説明を隠す）
  const [compact, setCompact] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // 文字付きのボタンが入りきらなくなったらアイコンだけにする（入りきる幅を覚えておき、広がったら戻す）
  const fullWidth = useRef(0);
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const check = () => {
      if (!compactRef.current) {
        if (el.scrollWidth > el.clientWidth + 1) {
          fullWidth.current = el.scrollWidth;
          compactRef.current = true;
          setCompact(true);
        }
      } else if (el.clientWidth >= fullWidth.current + 8) {
        compactRef.current = false;
        setCompact(false);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compactRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const hoverRef = useRef<{clipId: string; edge: DragMode} | null>(null);
  const frameReq = useRef(0);
  const paletteRef = useRef<Palette | null>(null);
  // 動きの手がかり：位置・長さが変わったアイテムはなめらかに動かし、足したアイテムは下からふわっと入れる。
  // 合成できた行は波形を左から描き、失敗した行は一度だけ揺らす（動きを減らす設定なら何もしない）
  const animRef = useRef(new Map<string, ClipAnim>());
  const revealRef = useRef(new Map<string, number>());
  const shakeRef = useRef(new Map<string, number>());
  const prevClipsRef = useRef<Map<string, {start: number; duration: number; trackId: string; audio: string | null}> | null>(null);
  /** ドラッグで置いたアイテムは、置いた所にもう見えているので動かさない */
  const skipAnimRef = useRef(new Set<string>());
  const drawRef = useRef<() => void>(() => {});

  const draw = useCallback(() => {
    // すでに次のコマで描く予定なら、それを使う（取り消して予約し直すと、毎コマ呼ばれる間ずっと描かれない）
    if (frameReq.current) return;
    frameReq.current = requestAnimationFrame(() => {
      frameReq.current = 0;
      const canvas = canvasRef.current;
      const scroller = scrollRef.current;
      const s = getState();
      const p = s.project;
      if (!canvas || !scroller || !p) return;
      const dpr = window.devicePixelRatio || 1;
      const w = scroller.clientWidth;
      const h = scroller.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      // トラック見出しを縦スクロールに合わせる
      if (headersRef.current) headersRef.current.style.transform = `translateY(${-scroller.scrollTop}px)`;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pal = (paletteRef.current ??= readPalette(canvas));
      const z = s.zoom;
      const sx = scroller.scrollLeft;
      const sy = scroller.scrollTop;
      const f0 = sx / z;
      const f1 = (sx + w) / z;
      const X = (f: number) => f * z - sx;
      const {tops, rows} = trackTops(p);
      const Y = (i: number) => RULER_H + tops[i] - sy;
      const rowOf = (id: string) => rows.findIndex(t => t.id === id);

      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, h);

      // レーン
      rows.forEach((t, i) => {
        ctx.fillStyle = i % 2 ? pal.laneAlt : pal.lane;
        ctx.fillRect(0, Y(i), w, LAYER_H);
        ctx.fillStyle = pal.border;
        ctx.fillRect(0, Y(i) + LAYER_H - 0.5, w, 0.5);
        // 隠したレイヤーは薄く
        if (t.hidden) {
          ctx.fillStyle = pal.laneAlt;
          ctx.fillRect(0, Y(i), w, LAYER_H - 0.5);
        }
      });

      // 動きの途中のものがあれば、次のコマも描く（終わったものは消す）
      const now = performance.now();
      for (const [id, a] of animRef.current) if (now - a.t0 >= ANIM_MS) animRef.current.delete(id);
      for (const [id, t] of revealRef.current) if (now - t >= 320) revealRef.current.delete(id);
      for (const [id, t] of shakeRef.current) if (now - t >= 360) shakeRef.current.delete(id);
      if (animRef.current.size || revealRef.current.size || shakeRef.current.size) requestAnimationFrame(() => drawRef.current());

      // クリップ（表示範囲だけ）
      const drag = dragRef.current;
      const hover = hoverRef.current;
      const fps = p.video.fps;
      const selSet = new Set(s.selectedClipIds);
      // ほかのキャラクターのセリフと重なっているセリフ（と、その字幕）は赤い縁で示す
      const overlap = overlappingLines(p);
      const selLinks = new Set(p.clips.filter(c => selSet.has(c.id) && c.linkId).map(c => c.linkId));
      const groupSet = new Set(drag?.mode === 'move' && drag.moved ? drag.group : []);
      // 1 つだけ動かしているとき：離したら実際に置かれるレイヤー（重なるなら空いているレイヤー、置けなければ元のまま）。影はそこに描く
      const single = drag?.mode === 'move' && drag.moved && !drag.insert && !drag.group.length;
      const destRaw = single ? moveDestination(drag.clipId, drag.start, drag.trackId) : null;
      const dest = single ? (destRaw ?? drag.origTrack) : null;
      const delta = drag ? drag.start - drag.origStart : 0;
      // リンクしたクリップは、動かした量（端を動かしたなら長さの変わり方）に合わせて見せる
      const linkedSet = new Set(drag?.moved ? drag.linked : []);
      const dDur = drag ? drag.duration - drag.origDuration : 0;

      // ドラッグ中：元の場所を薄い破線で残し、落とす先で既存のクリップに重なるなら「ここに挿入」の印を出す
      if (drag?.mode === 'move' && drag.moved) {
        const oi = rowOf(drag.origTrack);
        if (oi >= 0) {
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = pal.text2;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(X(drag.origStart), Y(oi) + 4, Math.max(2, drag.origDuration * z - 2), LAYER_H - 8, 3);
          ctx.stroke();
          ctx.restore();
        }
      }

      for (const c of p.clips) {
        const isDragged = drag?.clipId === c.id;
        const inGroup = groupSet.has(c.id);
        const inLinked = linkedSet.has(c.id);
        const start = isDragged ? drag.start : inGroup || inLinked ? Math.max(0, c.start + delta) : c.start;
        const dur = isDragged ? drag.duration : inLinked ? Math.max(1, c.duration + dDur) : c.duration;
        if (start + dur < f0 || start > f1) continue;
        // 置けない種類のトラックの上にいるときは、そのトラックの上に「置けない」形（赤い破線）で描く
        const forbiddenHere = isDragged && !!drag.forbidden;
        const ti = rowOf(isDragged ? (drag.forbidden ?? dest ?? drag.trackId) : c.trackId);
        if (ti < 0) continue;
        const track = rows[ti];
        const th = LAYER_H;
        // なめらかに動かしている途中なら、前の位置から今の位置へ寄せて描く
        const an = isDragged ? undefined : animRef.current.get(c.id);
        let aStart = start;
        let aDur = dur;
        let rowY = Y(ti);
        let fade = 1;
        if (an) {
          const e = easeOut(Math.min(1, (now - an.t0) / ANIM_MS));
          if (an.kind === 'move') {
            aStart = an.fromStart + (start - an.fromStart) * e;
            aDur = an.fromDur + (dur - an.fromDur) * e;
            const fi = rowOf(an.fromTrack);
            if (fi >= 0) rowY = Y(fi) + (Y(ti) - Y(fi)) * e;
          } else {
            fade = e;
            rowY += (1 - e) * 10;
          }
        }
        const shakeAt = shakeRef.current.get(c.id);
        const shake = shakeAt !== undefined && now - shakeAt < 360 ? Math.sin(((now - shakeAt) / 360) * Math.PI * 6) * 4 * (1 - (now - shakeAt) / 360) : 0;
        const x = X(aStart) + shake;
        const cw = Math.max(2, aDur * z - 2);
        const y = rowY + 3;
        const ch = th - 6;
        if (y + ch < RULER_H || y > h) continue;
        const color = clipColor(p, c);
        const isSel = selSet.has(c.id);
        const unsynth = c.type === 'voice' && !c.audio;
        const failed = !!s.synthErrors[c.id];
        const overlapped = overlap.has(c.id) || (c.type === 'caption' && overlap.has(c.voiceId));

        ctx.globalAlpha = (track.hidden ? 0.4 : 1) * fade;
        // 選択は外側のリング（クリップ色と無関係に見分けられるよう、文字色で描く）
        if (isSel) {
          ctx.beginPath();
          ctx.roundRect(x - 2.5, y - 2.5, cw + 5, ch + 5, 4);
          // 選んだアイテムはアクセントの紫の 2px 枠（未合成の破線・重なりの黄色と見分けられるように）
          ctx.lineWidth = 2;
          ctx.strokeStyle = pal.accent;
          ctx.stroke();
        } else if (c.linkId && selLinks.has(c.linkId)) {
          // 選んだクリップとリンクしている相手（片方だけ選んだとき）は破線で示す
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.roundRect(x - 2.5, y - 2.5, cw + 5, ch + 5, 4);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = pal.text2;
          ctx.stroke();
          ctx.restore();
        }
        ctx.beginPath();
        ctx.roundRect(x, y, cw, ch, 3);
        ctx.save();
        const hovered = hoverRef.current?.clipId === c.id && !dragRef.current;
        // 立ち絵の帯はセリフより薄く塗り、左端に同じ色の太い線（同じキャラクター色でもセリフと見分けられるように）
        const band = c.type === 'portrait';
        ctx.globalAlpha *= isSel ? 0.46 : (unsynth ? 0.1 : band ? 0.1 : 0.22) + (hovered ? 0.12 : 0);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
        if (band) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(x, y, cw, ch, 3);
          ctx.clip();
          ctx.globalAlpha *= 0.85;
          ctx.fillStyle = color;
          ctx.fillRect(x, y, 3, ch);
          ctx.restore();
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = failed || forbiddenHere ? pal.error : overlapped ? pal.warn : color;
        if (overlapped || forbiddenHere || (hovered && !isSel)) ctx.lineWidth = 2;
        if (forbiddenHere) ctx.setLineDash([5, 4]);
        if (unsynth) ctx.setLineDash([4, 3]); // 未合成は破線（文字でも示す）
        ctx.stroke();
        ctx.setLineDash([]);
        // 合成中の行には、斜めのしまを右へ流して「いま作っている」ことを見せる
        if (s.synthStatus[c.id] === 'running') {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(x, y, cw, ch, 3);
          ctx.clip();
          ctx.globalAlpha *= 0.18;
          ctx.fillStyle = pal.accent;
          const off = (performance.now() / 40) % 16;
          for (let sx = x - ch - 16 + off; sx < x + cw; sx += 16) {
            ctx.beginPath();
            ctx.moveTo(sx, y + ch);
            ctx.lineTo(sx + ch, y);
            ctx.lineTo(sx + ch + 7, y);
            ctx.lineTo(sx + 7, y + ch);
            ctx.fill();
          }
          ctx.restore();
        }
        // 重なりは色だけでなく形でも示す：上の辺に黄色と黒の斜めのしま（キャラクターの色と見分けられるように）
        if (overlapped) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, cw, 3);
          ctx.clip();
          ctx.fillStyle = pal.warn;
          ctx.fillRect(x, y, cw, 3);
          ctx.fillStyle = pal.text;
          for (let sx = x - 4; sx < x + cw; sx += 8) {
            ctx.beginPath();
            ctx.moveTo(sx, y + 3);
            ctx.lineTo(sx + 4, y);
            ctx.lineTo(sx + 7, y);
            ctx.lineTo(sx + 3, y + 3);
            ctx.fill();
          }
          ctx.restore();
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y + 1, cw - 2, ch - 2);
        ctx.clip();
        // 波形
        if (c.type === 'voice' && c.audio) {
          const pk = getPeaks(c.audio.cacheKey)?.data;
          if (pk?.length) {
            // 高い行では名前を上、波形を下に分けて描く（重ならず、波形も大きく見える）
            const tall = ch >= 30;
            const mid = tall ? y + ch * 0.68 : y + ch * 0.64;
            const amp = tall ? ch * 0.26 : ch * 0.28;
            // 合成できたばかりの行は、波形を左から描いていく
            const rv = revealRef.current.get(c.id);
            const upTo = rv === undefined ? cw : cw * easeOut(Math.min(1, (now - rv) / 320));
            const perFrame = 100 / fps; // ピークは 100 個/秒
            // 小さい声でも形が見えるよう、その行で一番大きい山が波形の高さいっぱいになるように揃える
            const norm = peakMax(pk);
            ctx.fillStyle = color;
            // 名前の文字と重なっても読めるよう、波形は薄く（文字には縁取りも付ける）
            ctx.globalAlpha *= tall ? 0.75 : 0.5;
            // 波形は「声の棒」で描く（2px の棒を 1px 空けて並べる。アプリの印と同じ形で、声のアイテムだとひと目で分かる）
            const STEP = 3;
            ctx.beginPath();
            for (let px = Math.max(0, Math.ceil(-x / STEP) * STEP); px < Math.min(upTo, w - x); px += STEP) {
              // 再生開始位置で飛ばした頭は描かない。棒 1 本ぶん（3px）の中でいちばん大きい山を取る
              let v = 0;
              let end = false;
              for (let k = 0; k < STEP; k++) {
                const i = Math.floor(((px + k) / z + startOffsetOf(c)) * perFrame) * 2;
                if (i + 1 >= pk.length) {
                  end = true;
                  break;
                }
                v = Math.max(v, Math.abs(pk[i]), Math.abs(pk[i + 1]));
              }
              const bh = Math.max(1.5, (v / norm) * amp * 2);
              ctx.roundRect(x + px, mid - bh / 2, 2, bh, 1);
              if (end) break;
            }
            ctx.fill();
            ctx.globalAlpha = (track.hidden ? 0.4 : 1) * fade;
          }
        }
        // 状態の札（未合成・失敗・プレビュー準備中）
        // 札は重ねて出す（重なっていて未合成なら、両方とも見えるように）
        const badges: {text: string; color: string; ink?: string}[] = [];
        if (failed) badges.push({text: '⚠ 失敗', color: pal.error});
        if (overlapped) badges.push({text: '⚠ 重なり', color: pal.warn, ink: pal.text});
        const st = s.synthStatus[c.id];
        if (st === 'running') badges.push({text: '合成中', color: pal.accent});
        else if (st === 'queued') badges.push({text: '合成待ち', color: pal.text2});
        else if (unsynth && !failed) badges.push({text: '未合成', color: pal.text2});
        // 字幕だけ書き換えて、発音（声）が古い文のまま
        if (c.type === 'voice' && c.subtitle !== null && c.subtitle !== c.text) badges.push({text: '字幕≠発音', color: pal.warn, ink: pal.text});
        if (c.type === 'media' && c.mediaKind === 'video') {
          const px = s.proxies[c.src];
          if (px && !px.url && !px.error)
            badges.push({
              text: `準備中 ${Math.round(px.ratio * 100)}%`,
              color: pal.text2,
            });
        }
        ctx.font = `12px ${FONT}`;
        ctx.textBaseline = 'middle';
        const cy = ch >= 30 ? y + 11 : y + ch / 2;
        let labelX = x + 8;
        // リンクしているクリップには鎖の印（Premiere Pro では名前の下線）
        if (c.linkId && cw > 40) {
          ctx.save();
          ctx.strokeStyle = pal.text2;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.roundRect(labelX, cy - 3, 8, 6, 3);
          ctx.roundRect(labelX + 5, cy - 3, 8, 6, 3);
          ctx.stroke();
          ctx.restore();
          labelX += 18;
        }
        for (const badge of cw > 80 ? badges : []) {
          const bw = ctx.measureText(badge.text).width + 10;
          ctx.fillStyle = pal.bg;
          ctx.beginPath();
          ctx.roundRect(labelX - 2, cy - 7.5, bw, 15, 3);
          ctx.fill();
          ctx.strokeStyle = badge.color;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = badge.ink ?? badge.color;
          ctx.fillText(badge.text, labelX + 3, cy + 0.5);
          labelX += bw + 4;
        }
        const voiceOf = c.type === 'caption' ? p.clips.find(x2 => x2.id === c.voiceId) : undefined;
        const label =
          c.type === 'voice'
            ? (() => {
                // 声のプリセット（感情など）を使っていれば、名前の後ろに出す
                const ch = p.characters.find(x2 => x2.id === c.characterId);
                const pr = c.presetId ? ch?.voicePresets?.find(x2 => x2.id === c.presetId)?.name : null;
                return `${ch?.name ?? '?'}${pr ? `（${pr}）` : ''}  ${c.text}`;
              })()
            : c.type === 'caption'
              ? voiceOf?.type === 'voice'
                ? (voiceOf.subtitle ?? voiceOf.text).replace(/\n/g, ' ')
                : ''
              : c.type === 'text'
                ? `T  ${c.text.replace(/\n/g, ' ')}`
                : c.type === 'shape'
                  ? c.viz
                    ? `♪  ${c.viz === 'bars' ? '音声のスペクトラム' : '音声の波形'}`
                    : c.scene
                      ? `◎  ${p.scenes?.find(x => x.id === c.scene)?.name ?? 'シーン'}`
                      : c.control
                        ? `▣  ${CONTROL_LABEL[c.control.kind]}`
                        : `◆  ${SHAPE_LABEL[c.shape]}`
                  : c.type === 'portrait'
                    ? `立ち絵  ${p.characters.find(x2 => x2.id === c.characterId)?.name ?? '?'}`
                    : `${mediaBadge(c)}${c.src.split(/[\\/]/).pop() ?? c.src}`;
        // 波形の上でも読めるよう、地の色で縁取りしてから書く
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3;
        ctx.strokeStyle = pal.bg;
        ctx.globalAlpha *= 0.85;
        ctx.strokeText(label, labelX, cy + 0.5);
        ctx.restore();
        ctx.fillStyle = pal.text;
        ctx.fillText(label, labelX, cy + 0.5);
        ctx.restore();

        // キーフレームの点（◆。CapCut と同じく、選んでいるアイテムの下側に）
        if (isSel && isVisual(c))
          for (const t of keyframeTimes(c.look)) {
            const kx = x + 1 + t * (cw - 2);
            const ky = y + ch - 5;
            ctx.save();
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = pal.accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(kx, ky - 4);
            ctx.lineTo(kx + 4, ky);
            ctx.lineTo(kx, ky + 4);
            ctx.lineTo(kx - 4, ky);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
        // 端のつまみ（ホバー中か選択中のクリップだけ）
        if ((isSel || hover?.clipId === c.id) && cw > EDGE_PX * 3 && !track.locked) {
          for (const [ex, edge] of [
            [x + 3, 'trimStart'],
            [x + cw - 6, 'trimEnd'],
          ] as const) {
            ctx.fillStyle = hover?.clipId === c.id && hover.edge === edge ? pal.accent : pal.text2;
            ctx.beginPath();
            ctx.roundRect(ex, y + ch * 0.3, 3, ch * 0.4, 1.5);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }

      // つなぎ目の切り替え（CapCut と同じく、つなぎ目の上に小さな印）
      for (const c of p.clips) {
        if (!isVisual(c) || !c.look?.transition) continue;
        const ti = rowOf(c.trackId);
        if (ti < 0 || !prevAdjacent(p, c)) continue;
        const cx = Math.round(X(c.start));
        if (cx < -10 || cx > w + 10) continue;
        const cy = Y(ti) + LAYER_H / 2;
        const sel = c.id === selected;
        ctx.save();
        ctx.fillStyle = sel ? pal.accent : pal.bg;
        ctx.strokeStyle = sel ? '#fff' : pal.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(cx - 8, cy - 8, 16, 16, 4);
        ctx.fill();
        ctx.stroke();
        // 2 つの矢印（前の場面から次の場面へ）
        ctx.strokeStyle = sel ? '#fff' : pal.accent;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy - 2.5);
        ctx.lineTo(cx + 4, cy - 2.5);
        ctx.moveTo(cx + 1.5, cy - 5);
        ctx.lineTo(cx + 4, cy - 2.5);
        ctx.moveTo(cx + 4, cy + 2.5);
        ctx.lineTo(cx - 4, cy + 2.5);
        ctx.moveTo(cx - 1.5, cy + 5);
        ctx.lineTo(cx - 4, cy + 2.5);
        ctx.stroke();
        ctx.restore();
      }

      // ドラッグ中の案内（クリップより手前に描く）：重なるなら「空いているトラックへ」か「挿入」、置けないトラックなら「置けません」
      if (drag?.mode === 'move' && drag.moved) {
        const tag = (ti: number, x0: number, label: string, color: string) => {
          if (ti < 0) return;
          // アイテムの名前に重ねないよう、1 つ上の行に出す（一番上なら 1 つ下）
          const ty = Y(ti > 0 ? ti - 1 : ti + 1);
          ctx.font = `600 11px ${FONT}`;
          ctx.textBaseline = 'middle';
          const lw = ctx.measureText(label).width + 10;
          // 右端・左端で切れないよう、見えている範囲に収める
          const x = Math.max(2, Math.min(w - lw - 2, x0));
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(x, ty + LAYER_H / 2 - 9, lw, 18, 3);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.fillText(label, x + 5, ty + LAYER_H / 2);
        };
        {
          const ti = rowOf(drag.trackId);
          const moving = new Set([drag.clipId, ...drag.group, ...drag.linked]);
          const hit = p.clips.some(c => c.trackId === drag.trackId && !moving.has(c.id) && drag.start < c.start + c.duration && drag.start + drag.duration > c.start);
          if (ti >= 0 && hit) {
            const ix = Math.round(X(drag.start));
            if (drag.insert) {
              ctx.fillStyle = pal.accent;
              ctx.fillRect(ix - 1.5, Y(ti) + 1, 3, LAYER_H - 2);
              tag(ti, ix + 6, '挿入（後ろを押し出す）', pal.accent);
            } else {
              // 指しているレイヤーには薄い破線の枠だけ。影は実際に置かれるレイヤーに描いてある
              ctx.save();
              ctx.setLineDash([3, 3]);
              ctx.strokeStyle = pal.text2;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.roundRect(ix + 0.5, Y(ti) + 3.5, Math.max(2, drag.duration * z - 3), LAYER_H - 7, 3);
              ctx.stroke();
              ctx.restore();
              const di = dest ? rowOf(dest) : -1;
              const msg0 =
                single && !destRaw
                  ? '置ける所がないので元の場所のまま（Ctrl で挿入）'
                  : dest && dest !== drag.trackId
                    ? `重なるので「${trackCode(p, dest)}」へ（Ctrl で挿入）`
                    : '重なるので空いているレイヤーへ（Ctrl で挿入）';
              // レイヤーは逃がせても、ほかのキャラクターのセリフと時間が重なるなら、それも先に伝える
              const me = p.clips.find(c => c.id === drag.clipId);
              const clash = me?.type === 'voice' && p.clips.some(c => c.type === 'voice' && c.id !== me.id && c.start < drag.start + drag.duration && drag.start < c.start + c.duration);
              const msg = clash ? `${msg0}・ほかのセリフと時間が重なります` : msg0;
              tag(di >= 0 ? di : ti, ix + 6, msg, pal.text2);
            }
          }
        }
      }

      // ルーラー（上に固定）
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, RULER_H);
      // 目盛りの間隔（フレーム）。拡大したときはフレーム単位まで細かくする
      const steps = [1, 2, 5, 10, ...[1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map(x => x * fps)].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
      const step = steps.find(st => st * z >= 110) ?? 3600 * fps;
      ctx.font = `12px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = pal.border;
      ctx.fillRect(0, RULER_H - 0.5, w, 0.5);
      // 小さな目盛り（ラベルの間を 5 つか 2 つに分ける）
      const minor = step % 5 === 0 && (step / 5) * z >= 8 ? step / 5 : step % 2 === 0 && (step / 2) * z >= 8 ? step / 2 : 0;
      if (minor)
        for (let f = Math.floor(f0 / minor) * minor; f <= f1; f += minor) {
          ctx.fillStyle = pal.border;
          ctx.fillRect(Math.round(X(f)) + 0.5, RULER_H - 4, 1, 4);
        }
      for (let f = Math.floor(f0 / step) * step; f <= f1; f += step) {
        const x = Math.round(X(f)) + 0.5;
        ctx.fillStyle = pal.border;
        ctx.fillRect(x, RULER_H - 8, 1, 8);
        ctx.fillStyle = pal.text2;
        // ほかの表示と同じ 時:分:秒:フレーム
        ctx.fillText(framesToTimecode(f, fps), x + 4, RULER_H / 2);
      }
      // マーカー（目盛りの下の辺に旗。名前は、次のマーカーまでの幅に収まる分だけ）
      const marks = (p.markers ?? []).filter(mk => mk.frame >= f0 - 400 / z && mk.frame <= f1);
      marks.forEach((mk, i) => {
        const x = Math.round(X(mk.frame));
        ctx.fillStyle = pal.accent;
        ctx.beginPath();
        ctx.moveTo(x - 5, RULER_H - 11);
        ctx.lineTo(x + 5, RULER_H - 11);
        ctx.lineTo(x + 5, RULER_H - 5);
        ctx.lineTo(x, RULER_H);
        ctx.lineTo(x - 5, RULER_H - 5);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x - 0.5, RULER_H, 1, h - RULER_H);
        ctx.globalAlpha = 1;
        const room = (marks[i + 1] ? X(marks[i + 1].frame) : w) - x - 16;
        if (mk.name && room > 28) {
          ctx.font = `600 11px ${FONT}`;
          let label = mk.name;
          while (label.length > 1 && ctx.measureText(label).width > Math.min(room, 160)) label = label.slice(0, -1);
          if (label !== mk.name) label = `${label.slice(0, -1)}…`;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = pal.bg;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(x + 7, RULER_H - 14, tw + 6, 13);
          ctx.globalAlpha = 1;
          ctx.fillStyle = pal.accent;
          ctx.fillText(label, x + 10, RULER_H - 7);
          ctx.font = `12px ${FONT}`;
        }
      });

      // スナップ線
      if (drag?.snappedAt != null) {
        const sx2 = Math.round(X(drag.snappedAt)) + 0.5;
        ctx.fillStyle = pal.accent;
        ctx.fillRect(sx2, RULER_H, 1, h - RULER_H);
      }

      // 再生位置
      const phx = Math.round(X(s.playhead)) + 0.5;
      if (phx >= 0 && phx <= w) {
        // 再生位置は文字と同じ色（白／黒）。紫は「選んでいるもの」と主な操作だけに使い、時間の線とは分ける
        ctx.fillStyle = pal.text;
        ctx.fillRect(phx - 0.5, 0, 1.5, h);
        ctx.beginPath();
        ctx.roundRect(phx - 5.5, 0, 11, 9, [0, 0, 3, 3]);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(phx - 5.5, 8);
        ctx.lineTo(phx + 5.5, 8);
        ctx.lineTo(phx, 13);
        ctx.fill();
      }
    });
  }, []);

  const selectedIds = useStore(s => s.selectedClipIds);

  // トラック見出しのボタンは Tab で 1 か所だけ止まり、中は矢印キーで動く（ロービング）。Tab で何十回も押さずに通り抜けられる
  const rovingRef = useRef<{row: number; col: number}>({row: 0, col: 0});
  const headerButtons = () => {
    const root = headersRef.current;
    if (!root) return [] as HTMLElement[][];
    return [...root.querySelectorAll<HTMLElement>('.vx-track-header')].map(h => [...h.querySelectorAll<HTMLElement>('button')]);
  };
  const applyRoving = useCallback(() => {
    const rows = headerButtons();
    const r = Math.min(rovingRef.current.row, rows.length - 1);
    rows.forEach((btns, i) =>
      btns.forEach((b, j) => {
        b.tabIndex = i === r && j === Math.min(rovingRef.current.col, btns.length - 1) ? 0 : -1;
      }),
    );
  }, []);
  useEffect(applyRoving);
  const onHeadersFocus = (e: React.FocusEvent) => {
    const rows = headerButtons();
    rows.forEach((btns, i) => {
      const j = btns.indexOf(e.target as HTMLElement);
      if (j >= 0) rovingRef.current = {row: i, col: j};
    });
    applyRoving();
  };
  const onHeadersKey = (e: React.KeyboardEvent) => {
    const d = {ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Home: [0, -99], End: [0, 99]}[e.key];
    if (!d || (e.target as HTMLElement).tagName === 'INPUT') return;
    // 開いたメニュー（別の場所に描かれる）の中のキーは、メニューに任せる
    if (!(e.currentTarget as HTMLElement).contains(e.target as Node) || (e.target as HTMLElement).closest('[role="menu"], [role="dialog"]')) return;
    const rows = headerButtons();
    if (!rows.length) return;
    e.preventDefault();
    e.stopPropagation();
    const {row, col} = rovingRef.current;
    const r = Math.max(0, Math.min(rows.length - 1, row + d[0]));
    const c = Math.max(0, Math.min(rows[r].length - 1, col + d[1]));
    rovingRef.current = {row: r, col: c};
    applyRoving();
    rows[r][c]?.focus();
  };
  const linkedSel = useStore(s => s.linkedSelection);
  const canPaste = useStore(s => s.clipboardCount > 0);
  drawRef.current = draw;
  // プロジェクトが変わったら、位置・長さが変わったアイテムと、足したアイテム・合成できた行を覚えて動かす
  useEffect(() => {
    if (!project) return;
    const prev = prevClipsRef.current;
    const next = new Map(project.clips.map(c => [c.id, {start: c.start, duration: c.duration, trackId: c.trackId, audio: c.type === 'voice' ? (c.audio?.cacheKey ?? null) : null}] as const));
    prevClipsRef.current = next;
    const skip = skipAnimRef.current;
    skipAnimRef.current = new Set();
    if (!prev || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const now = performance.now();
    const moved: [string, ClipAnim][] = [];
    const added: string[] = [];
    for (const [id, n] of next) {
      const o = prev.get(id);
      if (!o) added.push(id);
      else {
        if (!skip.has(id) && (o.start !== n.start || o.duration !== n.duration || o.trackId !== n.trackId)) {
          // まだ動いている途中なら、いま描かれている位置から続ける（前の行き先へ跳ばない）
          const cur = animRef.current.get(id);
          const k = cur?.kind === 'move' ? easeOut(Math.min(1, (now - cur.t0) / ANIM_MS)) : 1;
          const from =
            cur?.kind === 'move' && k < 1
              ? {fromStart: cur.fromStart + (o.start - cur.fromStart) * k, fromDur: cur.fromDur + (o.duration - cur.fromDur) * k, fromTrack: k < 0.5 ? cur.fromTrack : o.trackId}
              : {fromStart: o.start, fromDur: o.duration, fromTrack: o.trackId};
          moved.push([id, {t0: now, kind: 'move', ...from}]);
        }
        if (n.audio && n.audio !== o.audio) revealRef.current.set(id, now);
      }
    }
    // プロジェクトを開いた・まるごと貼ったなど、たくさん変わったときは動かさない（ちらつくだけなので）
    if (moved.length <= 80) for (const [id, a] of moved) animRef.current.set(id, a);
    if (added.length <= 12 && prev.size) for (const id of added) animRef.current.set(id, {t0: now, kind: 'add', fromStart: 0, fromDur: 0, fromTrack: ''});
    if (moved.length || added.length) draw();
  }, [project, draw]);
  // 合成に失敗した行は、一度だけ横に揺らして知らせる
  const prevErrRef = useRef(synthErrors);
  useEffect(() => {
    const before = prevErrRef.current;
    prevErrRef.current = synthErrors;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const now = performance.now();
    let any = false;
    for (const id of Object.keys(synthErrors))
      if (!before[id]) {
        shakeRef.current.set(id, now);
        any = true;
      }
    if (any) draw();
  }, [synthErrors, draw]);
  useEffect(draw, [draw, project, selected, selectedIds, playhead, zoom, proxies, synthErrors, synthStatus, layerSize]);
  // 合成中の行があるあいだは、斜めのしまを流すために描き続ける（動きを減らす設定なら止まった絵のまま）
  const anyRunning = Object.values(synthStatus).includes('running');
  useEffect(() => {
    if (!anyRunning || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const tick = () => {
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anyRunning, draw]);
  useEffect(() => onPeaks(draw), [draw]);

  // 横スクロールを短く滑らせる（自前の rAF。送り中に再生位置が進んでも出し直さず、行き先だけ差し替える）。
  // smooth の scrollTo を毎コマ出し直すと打ち消し合って止まって見えるため
  const glideRef = useRef<{raf: number; from: number; to: number; t0: number} | null>(null);
  const glideTo = useCallback((left: number, ms = 220) => {
    const el = scrollRef.current;
    if (!el) return;
    const to = Math.max(0, Math.min(left, el.scrollWidth - el.clientWidth));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.scrollLeft = to;
      return;
    }
    const g = glideRef.current;
    if (g) {
      // 送り中なら行き先だけ更新（今の位置から続ける）
      g.to = to;
      return;
    }
    const st = {raf: 0, from: el.scrollLeft, to, t0: performance.now()};
    glideRef.current = st;
    const step = (now: number) => {
      const k = Math.min(1, (now - st.t0) / ms);
      el.scrollLeft = st.from + (st.to - st.from) * (1 - Math.pow(1 - k, 3));
      if (k < 1) st.raf = requestAnimationFrame(step);
      else glideRef.current = null;
    };
    st.raf = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(glideRef.current?.raf ?? 0), []);

  /** 自分でスクロール・ドラッグしている間と、その後 2 秒は追従しない */
  const followHoldUntil = useRef(0);
  const holdFollow = () => {
    followHoldUntil.current = performance.now() + 2000;
    const g = glideRef.current;
    if (g) {
      cancelAnimationFrame(g.raf);
      glideRef.current = null;
    }
  };

  // 再生中は再生位置が見えるようにスクロールを追従：端まで来たらページごと送るが、跳ばずに短く滑らせる
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !getState().isPlaying || performance.now() < followHoldUntil.current) return;
    const x = playhead * zoom;
    const g = glideRef.current;
    const left = g ? g.to : el.scrollLeft;
    if (x < left || x > left + el.clientWidth - 40) glideTo(x - 80);
  }, [playhead, zoom, glideTo]);

  // 選択を見せる：追加した行・キーボードで選んだクリップ・台本から選んだ行が画面外ならスクロール
  useEffect(() => {
    const el = scrollRef.current;
    const p = getState().project;
    const c = p?.clips.find(x => x.id === getState().selectedClipId);
    if (!el || !p || !c) return;
    const z = getState().zoom;
    const x0 = c.start * z;
    const x1 = (c.start + c.duration) * z;
    // 近ければ滑らせ、遠ければすぐ（長く流れると目が追えないため）
    if (x0 < el.scrollLeft || x1 > el.scrollLeft + el.clientWidth) {
      const to = Math.max(0, x0 - el.clientWidth * 0.25);
      if (Math.abs(to - el.scrollLeft) < el.clientWidth * 1.5) glideTo(to, 200);
      else el.scrollLeft = to;
    }
    const {tops, rows} = trackTops(p);
    const ti = rows.findIndex(t => t.id === c.trackId);
    const ty = tops[ti];
    const visibleH = el.clientHeight - RULER_H;
    // 縦も、横と同じく跳ばずに送る
    if (ty < el.scrollTop || ty + LAYER_H > el.scrollTop + visibleH) el.scrollTo({top: Math.max(0, ty - 8), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    draw();
  }, [revealSeq, draw]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      paletteRef.current = null;
      draw();
    };
    mq.addEventListener('change', onScheme);
    // 「画面の明るさ」を切り替えると <html data-theme> が変わる
    const mo = new MutationObserver(onScheme);
    mo.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener('change', onScheme);
    };
  }, [draw]);

  // Ctrl(⌘)+ホイールでズーム（ポインタ位置を基準に）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 自分でスクロールし始めたら、送り途中の動きを止め、再生中の追従もしばらく休む（引き戻さない）
      holdFollow();
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomAround(Math.exp(-e.deltaY * 0.002), e.clientX - el.getBoundingClientRect().left);
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** 倍率を掛けてズーム。px は基準にする表示枠内の位置（省略時は再生位置） */
  const zoomAround = (factor: number, px?: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const s = getState();
    const anchorPx = px ?? Math.min(el.clientWidth, Math.max(0, s.playhead * s.zoom - el.scrollLeft));
    const frameAt = (el.scrollLeft + anchorPx) / s.zoom;
    const next = Math.min(MAX_ZOOM, Math.max(minZoom(), s.zoom * factor));
    setState({zoom: next});
    requestAnimationFrame(() => {
      el.scrollLeft = frameAt * next - anchorPx;
    });
  };

  /** 縮小の下限：プロジェクト全体（短くても 10 秒）が画面の半分くらいになるところまで。それ以上縮めても空白が広がるだけ */
  const minZoom = () => {
    const el = scrollRef.current;
    const p = getState().project;
    if (!el || !p) return MIN_ZOOM;
    const total = Math.max(projectDuration(p), p.video.fps * 10);
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (el.clientWidth * 0.5) / total));
  };

  const zoomToFit = () => {
    const el = scrollRef.current;
    const p = getState().project;
    if (!el || !p) return;
    const total = Math.max(projectDuration(p), p.video.fps * 5);
    setState({
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (el.clientWidth - 24) / total)),
    });
    requestAnimationFrame(() => (el.scrollLeft = 0));
  };

  // プロジェクトを開いたら、全体が入りきらないときだけ全体が見える拡大率にする（短い動画を無理に拡大はしない）
  const openSeq = useStore(s => s.openSeq);
  useEffect(() => {
    if (!openSeq) return;
    const el = scrollRef.current;
    const p = getState().project;
    if (!el || !p) return;
    if (projectDuration(p) * getState().zoom > el.clientWidth - 24) zoomToFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSeq]);

  const hitTest = (clientX: number, clientY: number) => {
    const el = scrollRef.current!;
    const p = getState().project!;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    const yIn = clientY - rect.top;
    const frame = x / getState().zoom;
    if (yIn < RULER_H)
      return {
        frame,
        clip: null,
        ruler: true,
        mode: 'move' as DragMode,
        track: null as Track | null,
      };
    const y = yIn - RULER_H + el.scrollTop;
    const {tops, rows} = trackTops(p);
    const ti = tops.findIndex(t => y >= t && y < t + LAYER_H);
    const track = rows[ti] ?? null;
    const z = getState().zoom;
    const edge = EDGE_PX / z;
    const clip = track ? p.clips.find(c => c.trackId === track.id && frame >= c.start - edge && frame < c.start + c.duration + edge) : undefined;
    let mode: DragMode = 'move';
    if (clip && clip.duration * z > EDGE_PX * 3) {
      if (Math.abs(frame - clip.start) <= edge) mode = 'trimStart';
      else if (Math.abs(frame - (clip.start + clip.duration)) <= edge) mode = 'trimEnd';
    }
    return {frame, clip: clip ?? null, ruler: false, mode, track};
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!getState().project) return;
    scrollRef.current?.focus({preventScroll: true});
    const h = hitTest(e.clientX, e.clientY);
    if (h.ruler || !h.clip) {
      // 目盛りのマーカーの近くを押したら、ちょうどその位置へ
      const near = h.ruler ? (getState().project!.markers ?? []).find(mk => Math.abs(mk.frame - h.frame) * getState().zoom <= 7) : undefined;
      setState({
        playhead: near ? near.frame : Math.max(0, Math.round(h.frame)),
        selectedClipId: h.ruler ? getState().selectedClipId : null,
      });
      if (h.ruler) (e.target as Element).setPointerCapture(e.pointerId);
      dragRef.current = null;
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+クリック：選択に足す／外す。Shift+クリック：同じトラックの間をまとめて選ぶ
    if (mod || e.shiftKey) {
      selectClip(h.clip.id, mod ? 'toggle' : 'range');
      dragRef.current = null;
      return;
    }
    // Alt+クリック：リンクしたクリップを含めず、それだけを選ぶ（Premiere Pro と同じ）
    if (e.altKey) selectOnly(h.clip.id);
    const before = getState();
    // 選んでいる中のクリップをつかんだら、選択はそのまま（まとめて動かす）
    // 選んだ行がプレビューに映るよう、再生位置がその行の外なら行の先頭へ
    const hc = h.clip;
    const inside = before.playhead >= hc.start && before.playhead < hc.start + hc.duration;
    const ph = inside || before.isPlaying ? {} : {playhead: hc.start};
    // Alt を押している、またはすでに選んでいる中のクリップをつかんだら、選択はそのまま（片方だけ選んでいたら、それだけを動かす）
    if (e.altKey || (before.selectedClipIds.length === 1 && before.selectedClipIds[0] === hc.id)) setState(ph);
    else if (before.selectedClipIds.length > 1 && before.selectedClipIds.includes(hc.id))
      setState({
        selectedClipId: hc.id,
        selectedClipIds: before.selectedClipIds,
        ...ph,
      });
    else setState({selectedClipId: hc.id, ...ph});
    const s = getState();
    const p = s.project!;
    if (h.track?.locked) return;
    const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
    // リンクしたクリップは自動で付いてくるので、一緒に動かすものに入れない（入れると別のトラックへ移せない）
    const linkId = h.clip.linkId;
    const group =
      h.mode === 'move'
        ? s.selectedClipIds.filter(id => {
            const c = p.clips.find(x => x.id === id);
            return id !== h.clip!.id && !!c && !locked.has(c.trackId) && !(linkId && c.linkId === linkId);
          })
        : [];
    const moving = new Set([h.clip.id, ...group]);
    const targets = [0, s.playhead];
    for (const c of p.clips) if (!moving.has(c.id)) targets.push(c.start, c.start + c.duration);
    dragRef.current = {
      group,
      // リンクした相手も選んでいるときだけ一緒に動かす（片方だけ選んでいるなら、それだけを動かす）
      linked: linkId ? p.clips.filter(c => c.linkId === linkId && c.id !== h.clip!.id && s.selectedClipIds.includes(c.id)).map(c => c.id) : [],
      solo: !!linkId && p.clips.some(c => c.linkId === linkId && c.id !== h.clip!.id && !s.selectedClipIds.includes(c.id)),
      clipId: h.clip.id,
      mode: h.mode,
      startX: e.clientX,
      origStart: h.clip.start,
      origDuration: h.clip.duration,
      origTrack: h.clip.trackId,
      start: h.clip.start,
      duration: h.clip.duration,
      trackId: h.clip.trackId,
      moved: false,
      targets,
      snappedAt: null,
      startScroll: scrollRef.current?.scrollLeft ?? 0,
      pointerId: e.pointerId,
      captureEl: e.target as Element,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  // ドラッグ中に端（40px 以内）へ寄せたら、近いほど速く横にスクロールする
  const lastMoveRef = useRef<React.PointerEvent | null>(null);
  const scrollRaf = useRef(0);
  const scrollTickAt = useRef(0);
  const autoScroll = () => {
    if (scrollRaf.current) return;
    const tick = (now: number) => {
      scrollRaf.current = 0;
      // 進む量は経過時間で決める（マウスを細かく動かしても速くならない）。1 コマ 60fps 換算
      const dt = scrollTickAt.current ? Math.min(50, now - scrollTickAt.current) : 16.7;
      scrollTickAt.current = now;
      const el = scrollRef.current;
      const m = lastMoveRef.current;
      if (!el || !m || !dragRef.current) return;
      const r = el.getBoundingClientRect();
      const left = r.left + HEADER_W_IN_SCROLL;
      const v = m.clientX < left + EDGE_SCROLL ? -(left + EDGE_SCROLL - m.clientX) : m.clientX > r.right - EDGE_SCROLL ? m.clientX - (r.right - EDGE_SCROLL) : 0;
      if (!v) {
        scrollTickAt.current = 0;
        return;
      }
      const before = el.scrollLeft;
      el.scrollLeft = Math.max(0, before + Math.sign(v) * Math.min(16, Math.abs(v) / 3 + 2) * (dt / 16.7));
      if (el.scrollLeft === before) {
        scrollTickAt.current = 0;
        return;
      }
      onPointerMove(m);
    };
    scrollRaf.current = requestAnimationFrame(tick);
  };

  // Esc：ドラッグをやめて、元の場所に戻す（離しても置かない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = dragRef.current;
      if (e.key !== 'Escape' || !d) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = null;
      // 端で自動スクロールしていたら、つかんだときの位置に戻す
      if (scrollRef.current) scrollRef.current.scrollLeft = d.startScroll;
      try {
        d.captureEl.releasePointerCapture(d.pointerId);
      } catch {
        // もう放れていれば何もしない
      }
      draw();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const target = e.target as HTMLElement;
    if (d) d.insert = e.ctrlKey || e.metaKey;
    if (!d) {
      const h = hitTest(e.clientX, e.clientY);
      if (e.buttons === 1 && h.ruler) setState({playhead: Math.max(0, Math.round(h.frame))});
      const locked = h.track?.locked;
      target.style.cursor = h.clip && !locked ? (h.mode !== 'move' ? 'ew-resize' : 'grab') : 'default';
      // 名前が切れていても全文を見られるよう、乗せたクリップの説明をツールチップに
      const tip = h.clip ? describeClip(getState().project!, h.clip, getState().synthErrors) : '';
      if (target.title !== tip) target.title = tip;
      // 何もないところに 3 秒乗せると、知られにくい操作の案内を出す（hints.ts）
      const help = !h.clip && !h.ruler ? TIMELINE_HELP : '';
      if ((target.dataset.hint ?? '') !== help) {
        if (help) target.dataset.hint = help;
        else delete target.dataset.hint;
      }
      const nextHover = h.clip ? {clipId: h.clip.id, edge: h.mode} : null;
      if (nextHover?.clipId !== hoverRef.current?.clipId || nextHover?.edge !== hoverRef.current?.edge) {
        hoverRef.current = nextHover;
        draw();
      }
      return;
    }
    const z = getState().zoom;
    lastMoveRef.current = e;
    autoScroll();
    const scrolled = (scrollRef.current?.scrollLeft ?? 0) - d.startScroll;
    if (Math.abs(e.clientX - d.startX + scrolled) > 3) d.moved = true;
    const df = Math.round((e.clientX - d.startX + scrolled) / z);
    const tol = SNAP_PX / z;
    // Alt を押している間はスナップしない
    const snap = (f: number) => {
      const n = e.altKey ? null : nearest(d.targets, f);
      return n !== null && Math.abs(n - f) <= tol ? n : null;
    };
    d.snappedAt = null;
    if (d.mode === 'move') {
      target.style.cursor = 'grabbing';
      let start = Math.max(0, d.origStart + df);
      const sStart = snap(start);
      const sEnd = snap(start + d.origDuration);
      if (sStart !== null && (sEnd === null || Math.abs(sStart - start) <= Math.abs(sEnd - start - d.origDuration))) {
        start = sStart;
        d.snappedAt = sStart;
      } else if (sEnd !== null) {
        start = Math.max(0, sEnd - d.origDuration);
        d.snappedAt = sEnd;
      }
      d.start = start;
      d.duration = d.origDuration;
      // まとめて動かすときは、先頭が 0 より前に出ないようにする
      if (d.group.length) {
        const p0 = getState().project!;
        const minOther = Math.min(...d.group.map(id => p0.clips.find(c => c.id === id)?.start ?? Infinity));
        d.start = Math.max(d.start, d.origStart - minOther);
      }
      // 上下に動かすと、別のレイヤーへ移る（1 つだけ動かすとき。どのアイテムもどのレイヤーにも置ける）
      const h = hitTest(e.clientX, e.clientY);
      d.forbidden = null;
      if (!d.group.length && h.track && !h.track.locked) {
        if (h.track.id !== d.trackId) d.moved = true;
        d.trackId = h.track.id;
      }
    } else if (d.mode === 'trimEnd') {
      let end = Math.max(d.origStart + 1, d.origStart + d.origDuration + df);
      const sn = snap(end);
      if (sn !== null && sn > d.origStart) {
        end = sn;
        d.snappedAt = sn;
      }
      d.start = d.origStart;
      d.duration = end - d.origStart;
    } else {
      const end = d.origStart + d.origDuration;
      let start = Math.min(end - 1, Math.max(0, d.origStart + df));
      const sn = snap(start);
      if (sn !== null && sn < end) {
        start = sn;
        d.snappedAt = sn;
      }
      d.start = start;
      d.duration = end - start;
    }
    draw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    // 動かしたアイテムは、離した所にもう見えているので、なめらかに動かさない（押し出されたほかのアイテムは動かす）
    if (d) skipAnimRef.current = new Set([d.clipId, ...d.group, ...d.linked]);
    if (d?.moved && (d.start !== d.origStart || d.duration !== d.origDuration || d.trackId !== d.origTrack)) {
      const insert = e.ctrlKey || e.metaKey;
      if (d.mode === 'move') {
        const before = overlappingLines(getState().project!);
        const r = d.group.length ? moveClips([d.clipId, ...d.group], d.start - d.origStart, {insert}) : moveClip(d.clipId, d.start, d.trackId, undefined, {insert, solo: d.solo});
        // 置いた結果を知らせる（黙って動かさない）。レイヤーを移しても、ほかのキャラクターのセリフと「時間」が重なるなら、それも伝える
        const p2 = getState().project!;
        const after = overlappingLines(p2);
        const timeClash = [d.clipId, ...d.group].some(id => after.has(id) && !before.has(id));
        const clash = '。ほかのセリフと時間が重なっています（声が同時に鳴ります。「⚠ 重なり」の札）';
        if (r.kind === 'blocked') getNotify()('重なるので動かせませんでした。Ctrl を押しながら落とすと、挿入して後ろを押し出します', 'info');
        else if (r.kind === 'relocated' && r.trackId) getNotify()(`重なるので「${trackCode(p2, r.trackId)}」へ置きました${timeClash ? clash : ''}`, 'info');
        else if (timeClash) getNotify()(`置きました${clash}`, 'info');
        else if (r.kind === 'inserted' && r.pushed) getNotify()(`挿入して、${r.pushed} 個を後ろへずらしました（${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Z で元に戻せます）`, 'info');
        draw();
      } else trimClip(d.clipId, d.start, d.duration);
    } else if (d && !d.moved && d.group.length) {
      // 動かさずに離したら、そのクリップだけを選ぶ
      setState({selectedClipId: d.clipId});
    } else draw();
  };

  // ───────────── キーボード ─────────────
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = getState();
    const p = s.project;
    if (!p) return;
    const fps = p.video.fps;
    const sel = p.clips.find(c => c.id === s.selectedClipId);
    const select = (c: Clip | undefined) => {
      if (!c) return;
      setState(st => ({
        selectedClipId: c.id,
        playhead: c.start,
        revealSeq: st.revealSeq + 1,
      }));
    };
    const onTrack = (trackId: string) => p.clips.filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start);
    const mod = e.ctrlKey || e.metaKey;
    const nudge = (dir: number, big: boolean) => {
      if (!sel) return;
      const n = dir * (big ? fps : 1);
      if (s.selectedClipIds.length > 1) {
        const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
        moveClips(
          p.clips.filter(c => s.selectedClipIds.includes(c.id) && !locked.has(c.trackId)).map(c => c.id),
          n,
        );
        return;
      }
      const track = p.tracks.find(t => t.id === sel.trackId);
      if (!track?.locked) moveClip(sel.id, sel.start + n, undefined, `nudge:${sel.id}`);
      setState(st => ({revealSeq: st.revealSeq + 1}));
    };
    // 一般的な編集ソフトと同じく、←→（コマ送り）・↑↓（編集点）・Home/End・J/K/L は全体のショートカットに任せる。
    // ここではクリップの選択と微調整だけを扱う
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (mod || e.altKey)) {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      // Alt+←→：選んだクリップを 1 コマ（Shift も押すと 1 秒）動かす
      if (e.altKey) return nudge(dir, e.shiftKey);
      // Ctrl+←→：同じトラックの前後のクリップを選ぶ
      if (!sel) {
        const first = trackRows(p)
          .flatMap(t => onTrack(t.id))
          .find(c => c.start + c.duration > s.playhead);
        return select(first ?? p.clips[0]);
      }
      const list = onTrack(sel.trackId);
      return select(list[list.findIndex(c => c.id === sel.id) + dir]);
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && mod) {
      // Ctrl+↑↓：画面で上下のトラックのクリップを選ぶ
      e.preventDefault();
      e.stopPropagation();
      const rows = trackRows(p);
      const ti = sel ? rows.findIndex(t => t.id === sel.trackId) : -1;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      for (let i = ti + dir; i >= 0 && i < rows.length; i += dir) {
        const list = onTrack(rows[i].id);
        if (!list.length) continue;
        const at = sel?.start ?? s.playhead;
        return select(list.reduce((b, c) => (Math.abs(c.start - at) < Math.abs(b.start - at) ? c : b)));
      }
      return;
    }
    if (e.key === ',' || e.key === '.') {
      // , .：選んだクリップを 1 コマ（Shift で 1 秒）動かす（DaVinci Resolve と同じ）
      e.preventDefault();
      e.stopPropagation();
      return nudge(e.key === '.' ? 1 : -1, e.shiftKey);
    }
    if (e.key === 'Escape') setState({selectedClipId: null});
  };

  // 右クリック：その下のクリップを選んでから（選択の中なら選択のまま）メニューを出す
  const onContextMenuCapture = (e: React.MouseEvent) => {
    if (!getState().project) return;
    const h = hitTest(e.clientX, e.clientY);
    if (h.ruler) return;
    if (!h.clip) {
      // 右クリックはメニューを開くだけ（再生位置は動かさない。貼り付けはいつもどおり再生位置へ）
      setState({selectedClipId: null});
      return;
    }
    const s = getState();
    if (!(s.selectedClipIds.length > 1 && s.selectedClipIds.includes(h.clip.id))) setState({selectedClipId: h.clip.id});
  };

  if (!project) return null;
  const selIds = selectedIds;
  const selClips = project.clips.filter(c => selIds.includes(c.id));
  const voiceSel = selClips.filter(c => c.type === 'voice');
  const n = selClips.length;
  const anyLinked = selClips.some(c => c.linkId);
  const primary = project.clips.find(c => c.id === selected);
  const menuItems: (ContextMenuOption | null)[] = n
    ? [
        ...(voiceSel.length
          ? [
              {
                label: `${voiceSel.length > 1 ? `${voiceSel.length} 行` : 'この行'}を${voiceSel.some(c => c.type === 'voice' && c.audio) ? '合成し直す' : '合成'}`,
                onClick: () =>
                  void synthesize(
                    getNotify(),
                    voiceSel.map(c => c.id),
                  ),
              },
              {
                label: 'キャラクターを変える',
                isDisabled: project.characters.length < 2,
                items: project.characters.map(ch => ({
                  label: ch.name,
                  onClick: () => setCharacterForSelection(ch.id),
                })),
              },
              {type: 'divider' as const},
            ]
          : []),
        ...(primary && canSeparate(project, primary)
          ? [
              primary.type === 'voice'
                ? {label: '字幕と音声を分離', description: '字幕はその場に残り、声を近くの空いているレイヤーへ移します（リンクして一緒に動きます）', onClick: () => separateClip(primary.id)}
                : {label: '音声を分離', description: '映像はその場に残り、音を近くの空いているレイヤーへ移します（リンクして一緒に動きます）', onClick: () => separateClip(primary.id)},
            ]
          : []),
        ...(primary && canMerge(project, primary)
          ? [
              {
                label: primary.type === 'media' ? '映像と音声をまとめる' : '字幕と音声をまとめる',
                description: '分離したものを 1 つのアイテムに戻します',
                onClick: () => mergeClip(primary.id),
              },
            ]
          : []),
        anyLinked
          ? {label: 'リンク解除', description: '一緒に動かないようにします（別々に動かせます）', onClick: () => unlinkClips(selClips.map(c => c.id))}
          : n >= 2
            ? {label: 'リンク', description: '選んだアイテムを一緒に動くようにします', onClick: () => linkClips(selClips.map(c => c.id))}
            : null,
        ...(primary && n === 1 && prevAdjacent(project, primary)
          ? [
              {
                label: primary.type !== 'voice' && isVisual(primary) && primary.look?.transition ? '前とのつなぎ目の切り替えを変える…' : '前とのつなぎ目に切り替えを入れる…',
                description: 'ディゾルブ・暗転・流す・ズームなど',
                onClick: () => {
                  setState({fxTab: 'trans'});
                  openQuickEffects();
                },
              },
            ]
          : []),
        {type: 'divider' as const},
        {label: '複製', endContent: menuKey(`${MOD}D`), onClick: () => duplicateSelection()},
        {label: 'コピー', endContent: menuKey(`${MOD}C`), onClick: () => copySelection()},
        {label: '切り取り', endContent: menuKey(`${MOD}X`), onClick: () => cutSelection()},
        {type: 'divider' as const},
        {
          label: n > 1 ? `${n} 個を削除` : '削除',
          endContent: menuKey('Delete'),
          variant: 'destructive' as const,
          onClick: () => deleteClips(selClips.map(c => c.id)),
        },
      ]
    : [
        {label: '貼り付け', endContent: menuKey(`${MOD}V`), isDisabled: !canPaste, onClick: () => pasteClipboard()},
        {type: 'divider' as const},
        {
          label: '立ち絵アイテムを追加',
          items: project.characters.map(ch => ({
            label: ch.portrait?.psd ? ch.name : `${ch.name}：PSD を設定…`,
            onClick: () => (ch.portrait?.psd ? addPortraitItem(ch.id) : openPortraitSettings(ch.id)),
          })),
        },
        {label: 'テキストを追加', onClick: () => addVisualItem('text')},
        {
          label: '図形を追加',
          items: [
            ...BASIC_SHAPES.map(k => ({label: SHAPE_LABEL[k], onClick: () => addVisualItem('shape', k)})),
            {label: 'モザイク範囲', onClick: () => addRegion('mosaic')},
            {label: 'ぼかし範囲', onClick: () => addRegion('blur')},
            {label: '音声の波形', onClick: () => addAudioViz('wave')},
            {label: '音声のスペクトラム', onClick: () => addAudioViz('bars')},
          ],
        },
        {
          label: '制御を追加',
          items: [
            {label: 'グループ制御', onClick: () => addControl('group')},
            {label: 'カメラ', onClick: () => addControl('camera')},
            {label: '調整レイヤー', onClick: () => addControl('adjust')},
          ],
        },
        {label: 'スタンプを追加', items: STICKERS.map(st => ({label: SHAPE_LABEL[st.kind], onClick: () => addSticker(st.kind)}))},
        {label: '素材を追加…', onClick: () => void addMedia()},
      ];
  const {height} = trackTops(project);
  const contentW = (projectDuration(project) + project.video.fps * 30) * zoom;
  const selClip = project.clips.find(c => c.id === selected);
  const zoomLog = Math.log(zoom);
  // かんたんエフェクトは、見た目のあるアイテム（テキスト・図形・画像・動画）に付けられる
  const fxOk = !!selClip && (selClip.type === 'text' || selClip.type === 'shape' || (selClip.type === 'media' && selClip.mediaKind !== 'audio'));
  const fxTip = fxOk ? '登場・退場・動き・画面効果を、一覧から選んで付ける' : 'テキスト・図形・画像・動画を選ぶと、エフェクトを付けられます';

  return (
    <div className="vx-timeline" ref={rootRef}>
      <div className="vx-timeline-toolbar" ref={toolbarRef}>
        <Button
          label="レイヤーを追加"
          size="sm"
          variant="ghost"
          icon={<Icon icon={Plus} />}
          isIconOnly={compact}
          tooltip={compact ? 'レイヤーを追加（一番下 = 一番手前）' : '一番下（一番手前）に足します'}
          onClick={() => addTrack('video')}
        />
        <IconButton
          label="リンクされた選択"
          tooltip={linkedSel ? 'リンクされた選択：オン（音声と字幕をまとめて選ぶ。Alt+クリックで片方だけ）' : 'リンクされた選択：オフ（クリックしたものだけ選ぶ）'}
          size="sm"
          variant={linkedSel ? 'secondary' : 'ghost'}
          aria-pressed={linkedSel}
          icon={<Icon icon={Link2} />}
          onClick={() => setLinkedSelection(!linkedSel)}
        />
        <DropdownMenu
          button={{label: '立ち絵', size: 'sm', variant: 'ghost', icon: <Icon icon={PersonStanding} />, isIconOnly: compact, tooltip: '立ち絵アイテムを再生位置に追加（PSD 立ち絵のキャラクター）'}}
          menuWidth={200}>
          {project.characters.map(ch => (
            <DropdownMenuItem
              key={ch.id}
              label={ch.portrait?.psd ? ch.name : `${ch.name}：PSD を設定…`}
              description={ch.portrait?.psd ? undefined : 'キャラクターの編集の「立ち絵」を開きます'}
              onClick={() => (ch.portrait?.psd ? addPortraitItem(ch.id) : openPortraitSettings(ch.id))}
            />
          ))}
        </DropdownMenu>
        <DropdownMenu
          button={{label: 'テキスト', size: 'sm', variant: 'ghost', icon: <Icon icon={Type} />, isIconOnly: compact, tooltip: 'テキストを再生位置に追加（飾りを選べます）'}}
          menuWidth={200}>
          {TEXT_STYLES.map(ts => (
            <DropdownMenuItem
              key={ts.id}
              label={ts.label}
              onClick={() => {
                const id = addVisualItem('text');
                if (id) updateClip(id, ts.look as Partial<Clip>);
              }}
            />
          ))}
        </DropdownMenu>
        <DropdownMenu
          button={{
            label: project?.sceneId ? (project.scenes?.find(x => x.id === project.sceneId)?.name ?? 'シーン') : 'メイン',
            size: 'sm',
            variant: 'ghost',
            icon: <Icon icon={Clapperboard} />,
            isIconOnly: compact,
            tooltip: 'シーン（別のタイムライン）を開く・置く',
          }}
          menuWidth={220}>
          <DropdownMenuItem label="メイン" description={!project?.sceneId ? '開いています' : undefined} onClick={() => openScene(null)} />
          {(project?.scenes ?? [])
            .filter(x => x.id !== MAIN_SCENE)
            .map(x => (
              <DropdownMenuItem key={x.id} label={x.name} description={x.id === project?.sceneId ? '開いています' : undefined} onClick={() => openScene(x.id)} />
            ))}
          <DropdownMenuItem label="新しいシーン" description="別のタイムラインを作って開く" onClick={() => addScene()} />
          {(project?.scenes ?? [])
            .filter(x => x.id !== MAIN_SCENE && x.id !== project?.sceneId)
            .map(x => (
              <DropdownMenuItem key={`put-${x.id}`} label={`「${x.name}」を置く`} description="再生位置に、このシーンを 1 つのアイテムとして置く" onClick={() => addSceneItem(x.id)} />
            ))}
          {project?.sceneId && <DropdownMenuItem label="このシーンを消す" description="置いたシーンアイテムも消えます" onClick={() => deleteScene(project.sceneId!)} />}
        </DropdownMenu>
        <DropdownMenu button={{label: '図形', size: 'sm', variant: 'ghost', icon: <Icon icon={Shapes} />, isIconOnly: compact, tooltip: '図形を再生位置に追加'}} menuWidth={160}>
          {BASIC_SHAPES.map(k => (
            <DropdownMenuItem key={k} label={SHAPE_LABEL[k]} icon={<Icon icon={SHAPE_ICON[k]} />} onClick={() => addVisualItem('shape', k)} />
          ))}
          <DropdownMenuItem label="モザイク範囲" description="形の中の下の絵をモザイクに（顔を隠すなど）" onClick={() => addRegion('mosaic')} />
          <DropdownMenuItem label="ぼかし範囲" description="形の中の下の絵をぼかす" onClick={() => addRegion('blur')} />
          <DropdownMenuItem label="音声の波形" description="動画の音を波の形で出す" onClick={() => addAudioViz('wave')} />
          <DropdownMenuItem label="音声のスペクトラム" description="動画の音を高さごとの棒で出す" onClick={() => addAudioViz('bars')} />
          <DropdownMenuItem label="グループ制御" description="すぐ下のレイヤーをまとめて動かす" onClick={() => addControl('group')} />
          <DropdownMenuItem label="カメラ" description="下の全部をカメラで撮ったように動かす" onClick={() => addControl('camera')} />
          <DropdownMenuItem label="調整レイヤー" description="下の全部にエフェクトを掛ける" onClick={() => addControl('adjust')} />
        </DropdownMenu>
        <DropdownMenu button={{label: '効果音', size: 'sm', variant: 'ghost', icon: <Icon icon={Music2} />, isIconOnly: compact, tooltip: '効果音を再生位置に追加'}} menuWidth={160}>
          {SFX_LIST.map(sx => (
            <DropdownMenuItem key={sx.id} label={sx.label} onClick={() => void addSfx(sx.id)} />
          ))}
        </DropdownMenu>
        <DropdownMenu button={{label: 'スタンプ', size: 'sm', variant: 'ghost', icon: <Icon icon={Sticker} />, isIconOnly: compact, tooltip: 'スタンプを再生位置に追加'}} menuWidth={180}>
          {STICKERS.map(st => (
            <DropdownMenuItem key={st.kind} label={SHAPE_LABEL[st.kind]} icon={<Icon icon={SHAPE_ICON[st.kind]} />} onClick={() => addSticker(st.kind)} />
          ))}
        </DropdownMenu>
        {compact ? (
          <IconButton label="素材を追加" tooltip="素材を再生位置に追加" size="sm" variant="ghost" icon={<Icon icon={ImagePlus} />} clickAction={addMedia} />
        ) : (
          <Button label="素材を追加" size="sm" variant="ghost" icon={<Icon icon={ImagePlus} />} tooltip="素材を再生位置に追加" clickAction={addMedia} />
        )}
        {compact ? (
          <IconButton label="エフェクト" tooltip={fxTip} size="sm" variant="ghost" icon={<Icon icon={Sparkles} />} isDisabled={!fxOk} onClick={openQuickEffects} />
        ) : (
          <Button label="エフェクト" size="sm" variant="ghost" icon={<Icon icon={Sparkles} />} tooltip={fxTip} isDisabled={!fxOk} onClick={openQuickEffects} />
        )}
        <div style={{flex: 1}} />
        <DropdownMenu
          button={{label: 'レイヤーの高さ', tooltip: 'レイヤーの高さ（高くすると名前と波形が分かれて読みやすい）', variant: 'ghost', size: 'sm', isIconOnly: true, icon: <Icon icon={Rows3} />}}
          hasChevron={false}
          menuWidth={220}>
          <DropdownMenuRadioGroup label="レイヤーの高さ" value={layerSize} onChange={v => setLayerSize(v as LayerSize)}>
            <DropdownMenuRadioItem value="small" label="小（たくさん見える）" />
            <DropdownMenuRadioItem value="medium" label="中（名前と波形を分ける）" />
            <DropdownMenuRadioItem value="large" label="大（波形が大きい）" />
          </DropdownMenuRadioGroup>
        </DropdownMenu>
        <IconButton label="縮小" tooltip="縮小（Ctrl+ホイール）" variant="ghost" size="sm" icon={<Icon icon={ZoomOut} />} onClick={() => zoomAround(1 / 1.5)} />
        <div style={{width: 100}}>
          <Slider
            label="拡大率"
            isLabelHidden
            value={zoomLog}
            min={Math.log(minZoom())}
            max={Math.log(MAX_ZOOM)}
            step={0.01}
            formatValue={v => `${Math.round(Math.exp(v) * 100) / 100} px/フレーム`}
            onChange={(v: number) => zoomAround(Math.exp(v) / getState().zoom)}
          />
        </div>
        <IconButton label="拡大" tooltip="拡大（Ctrl+ホイール）" variant="ghost" size="sm" icon={<Icon icon={ZoomIn} />} onClick={() => zoomAround(1.5)} />
        <IconButton label="全体を表示" tooltip="全体を表示" variant="ghost" size="sm" icon={<Icon icon={Maximize2} />} onClick={zoomToFit} />
      </div>
      <div className="vx-timeline-body">
        <div className="vx-timeline-headers" style={{width: HEADER_W}}>
          <div className="vx-ruler-corner" style={{height: RULER_H}} />
          <div className="vx-track-headers-clip">
            <div
              ref={headersRef}
              role="toolbar"
              aria-orientation="vertical"
              aria-label="レイヤー見出し（↑↓で上下のレイヤー、←→で同じレイヤーのボタンへ）"
              onKeyDown={onHeadersKey}
              onFocus={onHeadersFocus}>
              {trackRows(project).map(t => (
                <div key={t.id}>
                  <TrackHeader track={t} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <ContextMenu items={tidyMenu(menuItems)} menuWidth={240} label="アイテムの操作">
          <div
            ref={scrollRef}
            onContextMenuCapture={onContextMenuCapture}
            className="vx-timeline-scroll"
            onScroll={draw}
            tabIndex={0}
            role="application"
            aria-roledescription="タイムライン"
            aria-label="タイムライン。←→で1コマ送り、↑↓で前後の編集点、Ctrl+←→で前後のアイテム、Ctrl+↑↓で上下のレイヤーのアイテムを選ぶ。Alt+←→か , . で選んだアイテムを1コマ動かす"
            onKeyDown={onKeyDown}>
            <canvas
              ref={canvasRef}
              className="vx-timeline-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => {
                if (hoverRef.current && !dragRef.current) {
                  hoverRef.current = null;
                  draw();
                }
              }}
            />
            <div style={{width: contentW, height: RULER_H + height + 24}} className="vx-timeline-spacer" />
          </div>
        </ContextMenu>
        {project.clips.length === 0 && <StartCard />}
      </div>
      <VisuallyHidden>
        <div aria-live="polite" className="vx-timeline-live">
          {selClip ? describeClip(project, selClip, synthErrors) : ''}
        </div>
      </VisuallyHidden>
    </div>
  );
}
