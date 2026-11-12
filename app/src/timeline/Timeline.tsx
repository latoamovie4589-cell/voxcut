// タイムライン。クリップを DOM にせず Canvas 1 枚に描き、表示範囲だけを描画する。
// - スクロールは縦横ともネイティブ（中身の大きさだけ持つ空 div）。Canvas は sticky で表示枠に固定
// - ルーラーは常に上に固定、トラック見出しは縦スクロールに合わせて動かす
// - キーボード：←→ コマ送り・↑↓ 編集点（全体のショートカット）、Ctrl+矢印でクリップ選択、Alt+←→ / , . で選んだクリップを動かす
// - 選んだクリップの内容は aria-live で読み上げる

import {useCallback, useEffect, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {DropdownMenu, DropdownMenuItem} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {MoreMenu} from '@astryxdesign/core/MoreMenu';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {Eye, EyeOff, ImagePlus, Lock, LockOpen, Maximize2, Plus, ZoomIn, ZoomOut} from 'lucide-react';
import type {Clip, Project, Track} from '../model';
import {framesToSpoken, framesToTimecode, projectDuration} from '../model';
import {getState, moveClip, moveClips, removeTrack, selectClip, setState, trimClip, updateTrack, addTrack, useStore} from '../store';
import {getPeaks, onPeaks} from '../peaks';
import {addMedia} from '../actions';
import './timeline.css';

const RULER_H = 26;
const TRACK_H: Record<Track['kind'], number> = {voice: 64, media: 52};
const HEADER_W = 208;
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
}

// トークンは light-dark() などで書かれていて Canvas にはそのまま渡せないので、
// 隠し要素の color に当てて、ブラウザに rgb() へ解決させる
let probe: HTMLSpanElement | null = null;
function resolveColor(host: HTMLElement, token: string, fallback: string): string {
  probe ??= Object.assign(document.createElement('span'), {style: 'display:none'});
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
    accent: v('--color-accent', '#007AFF'),
    error: v('--color-error', '#FF3B30'),
  };
}

function trackTops(p: Project) {
  const tops: number[] = [];
  let y = 0;
  for (const t of p.tracks) {
    tops.push(y);
    y += TRACK_H[t.kind];
  }
  return {tops, height: y};
}

function clipColor(p: Project, c: Clip): string {
  if (c.type === 'voice') return p.characters.find(ch => ch.id === c.characterId)?.color ?? '#8E8E93';
  return c.mediaKind === 'audio' ? '#30B0C7' : c.mediaKind === 'video' ? '#AF52DE' : '#8E8E93';
}

/** 読み上げ・台本で使うクリップの説明 */
export function describeClip(p: Project, c: Clip, synthErrors: Record<string, string>): string {
  const fps = p.video.fps;
  const where = `${framesToTimecode(c.start, fps)} から ${framesToSpoken(c.duration, fps)}`;
  if (c.type === 'voice') {
    const ch = p.characters.find(x => x.id === c.characterId)?.name ?? '?';
    const st = synthErrors[c.id] ? '合成に失敗' : c.audio ? '合成済み' : '未合成';
    return `セリフ、${ch}「${c.text}」、${where}、${st}`;
  }
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
}

function nearest(targets: number[], f: number): number | null {
  let best: number | null = null;
  for (const t of targets) if (best === null || Math.abs(t - f) < Math.abs(best - f)) best = t;
  return best;
}

// ───────────── トラック見出し ─────────────

function TrackHeader({track}: {track: Track}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(track.name);
  const finish = () => {
    setEditing(false);
    if (name.trim() && name !== track.name) updateTrack(track.id, {name: name.trim()});
  };
  return (
    <div className="vx-track-header" style={{height: TRACK_H[track.kind]}} data-muted={track.muted || undefined}>
      <VStack gap={0}>
        {editing ? (
          <TextInput label="トラック名" isLabelHidden size="sm" value={name} onChange={setName} onEnter={finish} onBlur={finish} hasAutoFocus width={96} />
        ) : (
          <Text type="label" maxLines={1}>
            {track.name}
          </Text>
        )}
        <Text type="supporting" maxLines={1}>
          {track.kind === 'voice' ? '音声と字幕' : track.duck ? '音量を自動調整' : '画像・動画・音声'}
        </Text>
      </VStack>
      <HStack gap={0} vAlign="center">
        <IconButton
          label={track.muted ? `${track.name}を表示する` : `${track.name}を隠す`}
          tooltip={track.muted ? '表示する（音も出す）' : '隠す（音も消す）'}
          variant="ghost"
          size="sm"
          icon={<Icon icon={track.muted ? EyeOff : Eye} />}
          onClick={() => updateTrack(track.id, {muted: !track.muted})}
        />
        <IconButton
          label={track.locked ? `${track.name}のロックを外す` : `${track.name}をロックする`}
          tooltip={track.locked ? 'ロックを外す' : 'ロック（動かせなくする）'}
          variant="ghost"
          size="sm"
          icon={<Icon icon={track.locked ? Lock : LockOpen} />}
          onClick={() => updateTrack(track.id, {locked: !track.locked})}
        />
        <MoreMenu
          label={`${track.name}のメニュー`}
          size="sm"
          items={[
            ...(track.kind === 'media'
              ? [
                  {label: '素材を追加…', onClick: () => void addMedia()},
                  {type: 'divider' as const},
                  {
                    label: track.duck ? '✓ セリフ中は音を下げる' : 'セリフ中は音を下げる',
                    description: 'BGM がセリフの邪魔にならないよう、自動で下げます',
                    onClick: () => updateTrack(track.id, {duck: !track.duck}),
                  },
                  ...(track.duck
                    ? ([
                        ['少し下げる', 0.5],
                        ['下げる', 0.3],
                        ['大きく下げる', 0.15],
                      ] as const).map(([l, v]) => ({
                        label: `${Math.abs(track.duckLevel - v) < 0.01 ? '✓ ' : '　 '}${l}（${Math.round(v * 100)}%）`,
                        onClick: () => updateTrack(track.id, {duckLevel: v}),
                      }))
                    : []),
                  {type: 'divider' as const},
                ]
              : []),
            {label: '名前を変える', onClick: () => setEditing(true)},
            {type: 'divider'},
            {label: 'このトラックを消す', variant: 'destructive', onClick: () => removeTrack(track.id)},
          ]}
        />
      </HStack>
    </div>
  );
}

// ───────────── 本体 ─────────────

export function Timeline() {
  const project = useStore(s => s.project);
  const selected = useStore(s => s.selectedClipId);
  const playhead = useStore(s => s.playhead);
  const zoom = useStore(s => s.zoom);
  const proxies = useStore(s => s.proxies);
  const synthErrors = useStore(s => s.synthErrors);
  const revealSeq = useStore(s => s.revealSeq);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 幅が狭いときはツールバーを詰める（ボタンをアイコンだけに、説明を隠す）
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < 760));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const hoverRef = useRef<{clipId: string; edge: DragMode} | null>(null);
  const frameReq = useRef(0);
  const paletteRef = useRef<Palette | null>(null);

  const draw = useCallback(() => {
    cancelAnimationFrame(frameReq.current);
    frameReq.current = requestAnimationFrame(() => {
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
      const {tops} = trackTops(p);
      const Y = (i: number) => RULER_H + tops[i] - sy;

      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, h);

      // レーン
      p.tracks.forEach((t, i) => {
        ctx.fillStyle = i % 2 ? pal.laneAlt : pal.lane;
        ctx.fillRect(0, Y(i), w, TRACK_H[t.kind]);
        ctx.fillStyle = pal.border;
        ctx.fillRect(0, Y(i) + TRACK_H[t.kind] - 0.5, w, 0.5);
      });

      // クリップ（表示範囲だけ）
      const drag = dragRef.current;
      const hover = hoverRef.current;
      const fps = p.video.fps;
      const selSet = new Set(s.selectedClipIds);
      const groupSet = new Set(drag?.mode === 'move' && drag.moved ? drag.group : []);
      const delta = drag ? drag.start - drag.origStart : 0;

      // ドラッグ中：元の場所を薄い破線で残し、落とす先で既存のクリップに重なるなら「ここに挿入」の印を出す
      if (drag?.mode === 'move' && drag.moved) {
        const oi = p.tracks.findIndex(t => t.id === drag.origTrack);
        if (oi >= 0) {
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = pal.text2;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(X(drag.origStart), Y(oi) + 4, Math.max(2, drag.origDuration * z - 2), TRACK_H[p.tracks[oi].kind] - 8, 6);
          ctx.stroke();
          ctx.restore();
        }
        const ti = p.tracks.findIndex(t => t.id === drag.trackId);
        const moving = new Set([drag.clipId, ...drag.group]);
        const hit = p.clips.some(
          c => c.trackId === drag.trackId && !moving.has(c.id) && drag.start < c.start + c.duration && drag.start + drag.duration > c.start,
        );
        if (ti >= 0 && hit) {
          const ix = Math.round(X(drag.start));
          const ty = Y(ti);
          ctx.fillStyle = pal.accent;
          ctx.fillRect(ix - 1.5, ty + 1, 3, TRACK_H[p.tracks[ti].kind] - 2);
          ctx.beginPath();
          ctx.moveTo(ix - 6, ty + 1);
          ctx.lineTo(ix + 6, ty + 1);
          ctx.lineTo(ix, ty + 8);
          ctx.fill();
          ctx.font = `600 11px ${FONT}`;
          ctx.textBaseline = 'top';
          const label = '挿入（後ろを押し出す）';
          const lw = ctx.measureText(label).width + 10;
          ctx.beginPath();
          ctx.roundRect(ix + 6, ty + TRACK_H[p.tracks[ti].kind] - 22, lw, 17, 8.5);
          ctx.fill();
          ctx.fillStyle = pal.bg;
          ctx.fillText(label, ix + 11, ty + TRACK_H[p.tracks[ti].kind] - 19.5);
        }
      }

      for (const c of p.clips) {
        const isDragged = drag?.clipId === c.id;
        const inGroup = groupSet.has(c.id);
        const start = isDragged ? drag.start : inGroup ? Math.max(0, c.start + delta) : c.start;
        const dur = isDragged ? drag.duration : c.duration;
        if (start + dur < f0 || start > f1) continue;
        const ti = p.tracks.findIndex(t => t.id === (isDragged ? drag.trackId : c.trackId));
        if (ti < 0) continue;
        const track = p.tracks[ti];
        const th = TRACK_H[track.kind];
        const x = X(start);
        const cw = Math.max(2, dur * z - 2);
        const y = Y(ti) + 4;
        const ch = th - 8;
        if (y + ch < RULER_H || y > h) continue;
        const color = clipColor(p, c);
        const isSel = selSet.has(c.id);
        const unsynth = c.type === 'voice' && !c.audio;
        const failed = !!s.synthErrors[c.id];

        ctx.globalAlpha = track.muted ? 0.4 : 1;
        // 選択は外側のリング（クリップ色と無関係に見分けられるよう、文字色で描く）
        if (isSel) {
          ctx.beginPath();
          ctx.roundRect(x - 2.5, y - 2.5, cw + 5, ch + 5, 8);
          ctx.lineWidth = 2;
          ctx.strokeStyle = pal.text;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.roundRect(x, y, cw, ch, 6);
        ctx.save();
        ctx.globalAlpha *= isSel ? 0.34 : unsynth ? 0.1 : 0.2;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
        ctx.lineWidth = 1;
        ctx.strokeStyle = failed ? pal.error : color;
        if (unsynth) ctx.setLineDash([4, 3]); // 未合成は破線（文字でも示す）
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y + 1, cw - 2, ch - 2);
        ctx.clip();
        // 波形
        if (c.type === 'voice' && c.audio) {
          const pk = getPeaks(c.audio.cacheKey)?.data;
          if (pk?.length) {
            const mid = y + ch * 0.64;
            const amp = ch * 0.28;
            const perFrame = 100 / fps; // ピークは 100 個/秒
            ctx.fillStyle = color;
            ctx.globalAlpha *= 0.55;
            for (let px = Math.max(0, -x); px < Math.min(cw, w - x); px++) {
              const i = Math.floor((px / z) * perFrame) * 2;
              if (i + 1 >= pk.length) break;
              const lo = (pk[i] / 127) * amp;
              const hi = (pk[i + 1] / 127) * amp;
              ctx.fillRect(x + px, mid - hi, 1, Math.max(1, hi - lo));
            }
            ctx.globalAlpha = track.muted ? 0.4 : 1;
          }
        }
        // 状態の札（未合成・失敗・プレビュー準備中）
        let badge: {text: string; color: string} | null = null;
        if (failed) badge = {text: '⚠ 失敗', color: pal.error};
        else if (unsynth) badge = {text: '未合成', color: pal.text2};
        else if (c.type === 'media' && c.mediaKind === 'video') {
          const px = s.proxies[c.src];
          if (px && !px.url && !px.error) badge = {text: `準備中 ${Math.round(px.ratio * 100)}%`, color: pal.text2};
        }
        ctx.font = `12px ${FONT}`;
        ctx.textBaseline = 'top';
        let labelX = x + 8;
        if (badge && cw > 80) {
          const bw = ctx.measureText(badge.text).width + 10;
          ctx.fillStyle = pal.bg;
          ctx.beginPath();
          ctx.roundRect(x + 6, y + 5, bw, 17, 8.5);
          ctx.fill();
          ctx.strokeStyle = badge.color;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = badge.color;
          ctx.fillText(badge.text, x + 11, y + 7.5);
          labelX += bw + 4;
        }
        const label =
          c.type === 'voice'
            ? `${p.characters.find(x2 => x2.id === c.characterId)?.name ?? '?'}  ${c.text}`
            : c.src.split(/[\\/]/).pop() ?? c.src;
        ctx.fillStyle = pal.text;
        ctx.fillText(label, labelX, y + 7.5);
        ctx.restore();

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

      // ルーラー（上に固定）
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, RULER_H);
      const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
      const stepSec = steps.find(st => st * fps * z >= 90) ?? 300;
      ctx.font = `12px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = pal.border;
      ctx.fillRect(0, RULER_H - 0.5, w, 0.5);
      for (let sec = Math.floor(f0 / fps / stepSec) * stepSec; sec * fps <= f1; sec += stepSec) {
        const x = Math.round(X(sec * fps)) + 0.5;
        ctx.fillStyle = pal.border;
        ctx.fillRect(x, RULER_H - 8, 1, 8);
        ctx.fillStyle = pal.text2;
        const m = Math.floor(sec / 60);
        ctx.fillText(`${m}:${String(sec % 60).padStart(2, '0')}`, x + 4, RULER_H / 2);
      }

      // スナップ線
      if (drag?.snappedAt != null) {
        const sx2 = Math.round(X(drag.snappedAt)) + 0.5;
        ctx.fillStyle = pal.accent;
        ctx.fillRect(sx2, RULER_H, 1, h - RULER_H);
      }

      // 再生位置
      const phx = Math.round(X(s.playhead)) + 0.5;
      if (phx >= 0 && phx <= w) {
        ctx.fillStyle = pal.accent;
        ctx.fillRect(phx - 0.5, 0, 1.5, h);
        ctx.beginPath();
        ctx.moveTo(phx - 6, 0);
        ctx.lineTo(phx + 6, 0);
        ctx.lineTo(phx, 8);
        ctx.fill();
      }
    });
  }, []);

  const selectedIds = useStore(s => s.selectedClipIds);
  useEffect(draw, [draw, project, selected, selectedIds, playhead, zoom, proxies, synthErrors]);
  useEffect(() => onPeaks(draw), [draw]);

  // 再生中は再生位置が見えるようにスクロールを追従
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !getState().isPlaying) return;
    const x = playhead * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 80);
  }, [playhead, zoom]);

  // 選択を見せる：追加した行・キーボードで選んだクリップ・台本から選んだ行が画面外ならスクロール
  useEffect(() => {
    const el = scrollRef.current;
    const p = getState().project;
    const c = p?.clips.find(x => x.id === getState().selectedClipId);
    if (!el || !p || !c) return;
    const z = getState().zoom;
    const x0 = c.start * z;
    const x1 = (c.start + c.duration) * z;
    if (x0 < el.scrollLeft || x1 > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, x0 - el.clientWidth * 0.25);
    const ti = p.tracks.findIndex(t => t.id === c.trackId);
    const {tops} = trackTops(p);
    const ty = tops[ti];
    const visibleH = el.clientHeight - RULER_H;
    if (ty < el.scrollTop || ty + TRACK_H[p.tracks[ti].kind] > el.scrollTop + visibleH) el.scrollTop = Math.max(0, ty - 8);
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
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', onScheme);
    };
  }, [draw]);

  // Ctrl(⌘)+ホイールでズーム（ポインタ位置を基準に）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
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
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.zoom * factor));
    setState({zoom: next});
    requestAnimationFrame(() => {
      el.scrollLeft = frameAt * next - anchorPx;
    });
  };

  const zoomToFit = () => {
    const el = scrollRef.current;
    const p = getState().project;
    if (!el || !p) return;
    const total = Math.max(projectDuration(p), p.video.fps * 5);
    setState({zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (el.clientWidth - 24) / total))});
    requestAnimationFrame(() => (el.scrollLeft = 0));
  };

  const hitTest = (clientX: number, clientY: number) => {
    const el = scrollRef.current!;
    const p = getState().project!;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    const yIn = clientY - rect.top;
    const frame = x / getState().zoom;
    if (yIn < RULER_H) return {frame, clip: null, ruler: true, mode: 'move' as DragMode, track: null as Track | null};
    const y = yIn - RULER_H + el.scrollTop;
    const {tops} = trackTops(p);
    const ti = tops.findIndex((t, i) => y >= t && y < t + TRACK_H[p.tracks[i].kind]);
    const track = p.tracks[ti] ?? null;
    const z = getState().zoom;
    const edge = EDGE_PX / z;
    const clip = track
      ? p.clips.find(c => c.trackId === track.id && frame >= c.start - edge && frame < c.start + c.duration + edge)
      : undefined;
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
      setState({playhead: Math.max(0, Math.round(h.frame)), selectedClipId: h.ruler ? getState().selectedClipId : null});
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
    const before = getState();
    // 選んでいる中のクリップをつかんだら、選択はそのまま（まとめて動かす）
    if (before.selectedClipIds.length > 1 && before.selectedClipIds.includes(h.clip.id)) setState({selectedClipId: h.clip.id, selectedClipIds: before.selectedClipIds});
    else setState({selectedClipId: h.clip.id});
    const s = getState();
    const p = s.project!;
    if (h.track?.locked) return;
    const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
    const group = h.mode === 'move' ? s.selectedClipIds.filter(id => id !== h.clip!.id && !locked.has(p.clips.find(c => c.id === id)?.trackId ?? '')) : [];
    const moving = new Set([h.clip.id, ...group]);
    const targets = [0, s.playhead];
    for (const c of p.clips) if (!moving.has(c.id)) targets.push(c.start, c.start + c.duration);
    dragRef.current = {
      group,
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
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const target = e.target as HTMLElement;
    if (!d) {
      const h = hitTest(e.clientX, e.clientY);
      if (e.buttons === 1 && h.ruler) setState({playhead: Math.max(0, Math.round(h.frame))});
      const locked = h.track?.locked;
      target.style.cursor = h.clip && !locked ? (h.mode !== 'move' ? 'ew-resize' : 'grab') : 'default';
      const nextHover = h.clip ? {clipId: h.clip.id, edge: h.mode} : null;
      if (nextHover?.clipId !== hoverRef.current?.clipId || nextHover?.edge !== hoverRef.current?.edge) {
        hoverRef.current = nextHover;
        draw();
      }
      return;
    }
    const z = getState().zoom;
    if (Math.abs(e.clientX - d.startX) > 3) d.moved = true;
    const df = Math.round((e.clientX - d.startX) / z);
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
      // 上下に動かすと、同じ種類のトラックへ移る（1 つだけ動かすとき）
      const h = hitTest(e.clientX, e.clientY);
      const p = getState().project!;
      const origKind = p.tracks.find(t => t.id === d.origTrack)?.kind;
      if (!d.group.length && h.track && h.track.kind === origKind && !h.track.locked) {
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

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved && (d.start !== d.origStart || d.duration !== d.origDuration || d.trackId !== d.origTrack)) {
      if (d.mode === 'move' && d.group.length) moveClips([d.clipId, ...d.group], d.start - d.origStart);
      else if (d.mode === 'move') moveClip(d.clipId, d.start, d.trackId);
      else trimClip(d.clipId, d.start, d.duration);
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
      setState(st => ({selectedClipId: c.id, playhead: c.start, revealSeq: st.revealSeq + 1}));
    };
    const onTrack = (trackId: string) => p.clips.filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start);
    const mod = e.ctrlKey || e.metaKey;
    const nudge = (dir: number, big: boolean) => {
      if (!sel) return;
      const n = dir * (big ? fps : 1);
      if (s.selectedClipIds.length > 1) {
        const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
        moveClips(p.clips.filter(c => s.selectedClipIds.includes(c.id) && !locked.has(c.trackId)).map(c => c.id), n);
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
        const first = p.tracks.flatMap(t => onTrack(t.id)).find(c => c.start + c.duration > s.playhead);
        return select(first ?? p.clips[0]);
      }
      const list = onTrack(sel.trackId);
      return select(list[list.findIndex(c => c.id === sel.id) + dir]);
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && mod) {
      // Ctrl+↑↓：上下のトラックのクリップを選ぶ
      e.preventDefault();
      e.stopPropagation();
      const ti = sel ? p.tracks.findIndex(t => t.id === sel.trackId) : -1;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      for (let i = ti + dir; i >= 0 && i < p.tracks.length; i += dir) {
        const list = onTrack(p.tracks[i].id);
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

  if (!project) return null;
  const {height} = trackTops(project);
  const contentW = (projectDuration(project) + project.video.fps * 30) * zoom;
  const selClip = project.clips.find(c => c.id === selected);
  const zoomLog = Math.log(zoom);

  return (
    <div className="vx-timeline" ref={rootRef}>
      <div className="vx-timeline-toolbar">
        <DropdownMenu
          button={{label: 'トラックを追加', size: 'sm', variant: 'ghost', icon: <Icon icon={Plus} />, isIconOnly: compact, tooltip: compact ? 'トラックを追加' : undefined}}
          menuWidth={200}>
          <DropdownMenuItem label="セリフのトラック" onClick={() => addTrack('voice')} />
          <DropdownMenuItem label="素材のトラック" onClick={() => addTrack('media')} />
        </DropdownMenu>
        {compact ? (
          <IconButton label="素材を追加" tooltip="素材を再生位置に追加" size="sm" variant="ghost" icon={<Icon icon={ImagePlus} />} clickAction={addMedia} />
        ) : (
          <>
            <Button label="素材を追加" size="sm" variant="ghost" icon={<Icon icon={ImagePlus} />} clickAction={addMedia} />
            <Text type="supporting" maxLines={1}>
              端をドラッグで長さ調整・Alt でスナップ解除
            </Text>
          </>
        )}
        <div style={{flex: 1}} />
        <IconButton label="縮小" tooltip="縮小（Ctrl+ホイール）" variant="ghost" size="sm" icon={<Icon icon={ZoomOut} />} onClick={() => zoomAround(1 / 1.5)} />
        <div style={{width: 140}}>
          <Slider
            label="拡大率"
            isLabelHidden
            value={zoomLog}
            min={Math.log(MIN_ZOOM)}
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
            <div ref={headersRef}>
              {project.tracks.map(t => (
                <TrackHeader key={t.id} track={t} />
              ))}
            </div>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="vx-timeline-scroll"
          onScroll={draw}
          tabIndex={0}
          role="application"
          aria-roledescription="タイムライン"
          aria-label="タイムライン。←→で1コマ送り、↑↓で前後の編集点、Ctrl+←→で前後のクリップ、Ctrl+↑↓で上下のトラックのクリップを選ぶ。Alt+←→か , . で選んだクリップを1コマ動かす"
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
      </div>
      <VisuallyHidden>
        <div aria-live="polite" className="vx-timeline-live">{selClip ? describeClip(project, selClip, synthErrors) : ''}</div>
      </VisuallyHidden>
    </div>
  );
}
