// プレビュー。Canvas 2D に 背景 → レイヤー（1 から順に：素材 → そのレイヤーの立ち絵 → 字幕）の順で描く。最終画質は書き出し時に FFmpeg が作る。
// 立ち絵の口パク・目パチは lipsync.ts（Rust と同じ計算）で決める。

import {getDock, showPanel} from '../dock/layout';
import {useEffect, useRef, useState} from 'react';
import type {Api} from '../ipc';
import {api} from '../ipc';
import {wrapSubtitle} from '../subtitleWrap';
import {hasRuby, keepRubyWords, parseRuby, rubyBase, rubyRows} from '../ruby';
import type {Character, Clip, Effect, MediaClip, PortraitClip, Project, Transform, VisualClip} from '../model';
import {
  audibleTracks,
  lineOfSubtitle,
  expressionFor,
  expressionIndex,
  isVisual,
  lineExpression,
  lineVariants,
  plainLook,
  projectDuration,
  startOffsetOf,
  videoTracks,
  withTransitions,
  isRetimed,
  speedAt,
  srcFrameAt,
  animStateAt,
  setKeyframe,
  hasAudioFx,
  proxyKey,
  matteKey,
} from '../model';
import {distort, drawVisual, onLutReady, itemImage, subtitleImage, visibleChars, visualAt, sourceView, drawFillBlur} from './visual';
import {psdPreviewFrame} from '../psd/portrait';
import {duckGain, voiceIntervals} from '../ducking';
import {blinkStarts, eyesAt, mouthAt} from '../lipsync';
import {getPeaks, onPeaks} from '../peaks';
import {commit, getState, revertMerge, setState, useStore} from '../store';
import {pauseExcept, syncVideo, videoFor} from './video';
import {processedAudio} from '../audioFx';
import {PreviewControls, toggleFullscreen} from './PreviewControls';
import {fadeAlpha, popScale, typewriterCount} from '../subtitleAnim';
import './preview.css';

let apiNow: Api | null = null;
void api.then(a => (apiNow = a));

const images = new Map<string, HTMLImageElement>();
/** 画像を読む（読み終わったら onLoad）。まだなら null */
function image(src: string, projectPath: string | null, onLoad: () => void): HTMLImageElement | null {
  const key = `${projectPath ?? ''}|${src}`;
  let img = images.get(key);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = onLoad;
    img.src = apiNow ? apiNow.mediaUrl(src, projectPath) : src;
    images.set(key, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

/** URL の画像を読む（背景を消す型など）。まだなら null */
function urlImage(url: string, onLoad: () => void): HTMLImageElement | null {
  const key = `url|${url}`;
  let img = images.get(key);
  if (!img) {
    img = new Image();
    img.onload = onLoad;
    img.src = url;
    images.set(key, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

const blinkCache = new Map<string, ReturnType<typeof blinkStarts>>();
function blinkFor(id: string, fps: number, total: number) {
  const key = `${id}|${fps}|${total}`;
  let b = blinkCache.get(key);
  if (!b) {
    if (blinkCache.size > 64) blinkCache.clear();
    b = blinkStarts(id, fps, total);
    blinkCache.set(key, b);
  }
  return b;
}

/** 書き出しと同じ置き方：中心基準でずらす */
function place(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  t: Transform,
  w: number,
  h: number,
  scale: number,
  size: [number, number] = [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight],
) {
  const r = placeRect(t, size, w, h, scale);
  ctx.globalAlpha = t.opacity;
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  ctx.globalAlpha = 1;
  return r;
}

/** 書き出しと同じ置き方での、画面上の四角 */
function placeRect(t: Transform, size: [number, number], w: number, h: number, scale: number) {
  const iw = size[0] * t.scale * scale;
  const ih = size[1] * t.scale * scale;
  return {
    x: (w - iw) / 2 + t.x * scale,
    y: (h - ih) / 2 + t.y * scale,
    w: iw,
    h: ih,
  };
}

type Rect = {x: number; y: number; w: number; h: number};
/** プレビュー上で掴めるもの（素材か立ち絵） */
interface Target {
  key: string;
  kind: 'media' | 'portrait' | 'subtitle';
  id: string; // クリップ ID かキャラクター ID（字幕はセリフの ID）
  /** 選ぶクリップ（分離した字幕なら字幕のクリップ） */
  selectId?: string;
  rect: Rect;
  transform: Transform;
}
type Gesture = {
  target: Target;
  mode: 'move' | 'scale';
  x: number;
  y: number;
  dist: number;
  moved: boolean;
  /** 1 回のドラッグを 1 つの「元に戻す」にまとめる目印 */
  id: number;
  /** Esc で取り消すときに、つかみを放す */
  pointerId?: number;
  captureEl?: Element;
};
const HANDLE = 10;
/** 中央・端に吸着する距離（画面の px） */
const SNAP = 6;

const corners = (r: Rect): [number, number][] => [
  [r.x, r.y],
  [r.x + r.w, r.y],
  [r.x, r.y + r.h],
  [r.x + r.w, r.y + r.h],
];
/** つまみの位置。画面（プレビューの枠）の外に出るときは、枠の中に寄せて出す（大きくしてもつかめるように） */
type Bounds = {x0: number; y0: number; x1: number; y1: number};
const handles = (r: Rect, b: Bounds | null): [number, number][] => {
  const m = HANDLE / 2 + 1;
  return corners(r).map(([x, y]) => (b ? [Math.min(b.x1 - m, Math.max(b.x0 + m, x)), Math.min(b.y1 - m, Math.max(b.y0 + m, y))] : [x, y]));
};
const inside = (r: Rect, p: {x: number; y: number}) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const distToCenter = (r: Rect, p: {x: number; y: number}) => Math.hypot(p.x - (r.x + r.w / 2), p.y - (r.y + r.h / 2));

function selectTarget(t: Target) {
  if (t.kind === 'media' || t.kind === 'subtitle') setState(s => ({selectedClipId: t.selectId ?? t.id, revealSeq: s.revealSeq + 1}));
  else {
    setState({
      selectedClipId: null,
      selectedCharacterId: t.id,
      inspectorTab: 'portrait',
    });
    if (!getDock().maximized) showPanel('inspector');
  }
}

/** ドラッグを始めたときのアイテム（キーフレームの点を動かすときの基準） */
let dragBase: {key: string; clip: Clip} | null = null;

export function commitTransform(t: Target, transform: Transform, mergeKey?: string) {
  if (t.kind === 'subtitle') {
    commit(
      p => ({
        ...p,
        clips: p.clips.map(c => (c.id === t.id && c.type === 'voice' && c.subtitleCustom ? {...c, subtitleCustom: {...c.subtitleCustom, transform}} : c)),
      }),
      mergeKey,
    );
  } else if (t.kind === 'media') {
    commit(
      p => ({
        ...p,
        clips: p.clips.map(c => {
          if (c.id !== t.id || !(isVisual(c) || c.type === 'portrait')) return c;
          // キーフレームのあるアイテムは、再生位置の点を動かす（なければ足す）。ずれは動かし始めたときの状態から測る
          if (isVisual(c) && c.look?.anim) {
            if (mergeKey && dragBase?.key !== mergeKey) dragBase = {key: mergeKey, clip: c};
            const o = (mergeKey && dragBase?.clip.id === c.id ? dragBase.clip : c) as VisualClip;
            const frac = Math.min(1, Math.max(0, (getState().playhead - o.start) / Math.max(1, o.duration)));
            const cur = animStateAt(o.transform, o.look, frac);
            const nt: Transform = {
              ...cur.transform,
              x: cur.transform.x + transform.x - o.transform.x,
              y: cur.transform.y + transform.y - o.transform.y,
              scale: Math.max(0.01, (cur.transform.scale * transform.scale) / Math.max(0.01, o.transform.scale)),
            };
            return setKeyframe(o, frac, nt, cur.rotation) as Clip;
          }
          return {...c, transform};
        }),
      }),
      mergeKey,
    );
  } else {
    commit(
      p => ({
        ...p,
        characters: p.characters.map(c => (c.id === t.id && c.portrait ? {...c, portrait: {...c.portrait, transform}} : c)),
      }),
      mergeKey,
    );
  }
}

/**
 * 字幕を描く。f はクリップ先頭からのフレーム。
 * アニメーションは subtitleAnim.ts（書き出しの ASS と同じ式）。
 * 1 文字ずつのときは全文で位置を決め、まだ出ていない文字を描かない（書き出しと同じく文字が動かない）。
 */
function drawSubtitle(ctx: CanvasRenderingContext2D, text: string, ch: Character | undefined, p: Project, scale: number, f: number, duration: number) {
  const st = ch?.subtitle;
  const fps = p.video.fps;
  const anim = st?.animation ?? 'none';
  const fs = st?.fontSize ?? 56;
  const size = fs * scale;
  // ルビの書き方を外した文で改行する。改行の位置は書き出しと同じ（画面の幅から左右の余白 40px ずつを引いた幅で切る）
  const segs = parseRuby(text);
  const ruby = hasRuby(segs);
  text = wrapSubtitle(rubyBase(text), fs, Math.max(0, p.video.width - 80), st?.maxChars ?? 0);
  if (ruby) text = keepRubyWords(segs, text);
  const rows = ruby ? rubyRows(segs, text) : null;
  const family = `${st?.fontFamily ? `"${st.fontFamily}",` : ''} -apple-system, "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif`;
  const fontAt = (px: number) => `600 ${px}px ${family}`;
  ctx.font = fontAt(size);
  ctx.lineJoin = 'round';
  const lines = text.split('\n');
  const lh = size * 1.25;
  // ルビは文字の半分の大きさで、行の上に小さい行として置く（書き出しの ASS と同じ）
  const rs = Math.max(1, Math.round(fs * 0.5)) * scale;
  const extra = lines.map((_, i) => (rows?.[i]?.some(r => r.ruby !== undefined) ? rs * 1.25 : 0));
  const w = p.video.width * scale;
  const h = p.video.height * scale;
  const margin = (st?.marginV ?? 60) * scale;
  const pos = st?.position ?? 'bottom';
  // 各行の文字の基準の高さ
  const ys: number[] = new Array(lines.length);
  if (pos === 'bottom') {
    ys[lines.length - 1] = h - margin;
    for (let i = lines.length - 2; i >= 0; i--) ys[i] = ys[i + 1] - lh - extra[i + 1];
  } else if (pos === 'top') {
    ys[0] = margin + size + extra[0];
    for (let i = 1; i < lines.length; i++) ys[i] = ys[i - 1] + lh + extra[i];
  } else {
    let top = h / 2 - lines.reduce((a, _, i) => a + lh + extra[i], 0) / 2;
    lines.forEach((_, i) => {
      ys[i] = top + extra[i] + lh / 2;
      top += lh + extra[i];
    });
  }
  ctx.textBaseline = pos === 'middle' ? 'middle' : 'alphabetic';

  ctx.save();
  if (anim === 'fade') ctx.globalAlpha = fadeAlpha(f, duration, fps);
  if (anim === 'pop') {
    // 字幕のかたまりの中心を基準に拡大
    const cy = (ys[0] + ys[lines.length - 1]) / 2 - (pos === 'middle' ? 0 : size * 0.35);
    const k = popScale(f, fps);
    ctx.translate(w / 2, cy);
    ctx.scale(k, k);
    ctx.translate(-w / 2, -cy);
  }
  const total = [...text.replace(/\n/g, '')].length;
  const count = anim === 'typewriter' ? typewriterCount(total, duration, f) : Infinity;
  // 文字を 1 かたまり描く（帯・縁・影も）。px は文字の大きさ、sx は横の縮め
  const run = (s: string, x: number, y: number, px: number, sx = 1) => {
    if (!s) return;
    ctx.save();
    ctx.font = fontAt(px);
    ctx.translate(x, y);
    ctx.scale(sx, 1);
    const k = px / size;
    // 帯（書き出しの ASS の BorderStyle 3 と同じく、出ている文字の幅＋余白。縁取りの代わり）
    const boxed = !!st?.boxColor;
    const pad = (st?.boxPadding ?? 12) * scale * k;
    const top = pos === 'middle' ? -px * 0.5 : -px * 0.88;
    const body = (dx: number, dy: number, color?: string) => {
      if (boxed) {
        ctx.save();
        ctx.fillStyle = color ?? st!.boxColor!;
        if (!color) ctx.globalAlpha *= Math.max(0, Math.min(1, st?.boxOpacity ?? 1));
        ctx.fillRect(-pad + dx, top - pad + dy, ctx.measureText(s).width + pad * 2, px * (pos === 'middle' ? 1 : 1.12) + pad * 2);
        ctx.restore();
      } else if (st?.outlineWidth) {
        ctx.lineWidth = st.outlineWidth * 2 * scale * k;
        ctx.strokeStyle = color ?? st.outlineColor;
        ctx.strokeText(s, dx, dy);
      }
      ctx.fillStyle = color ?? st?.color ?? '#fff';
      ctx.fillText(s, dx, dy);
    };
    // 影は、縁（帯）まで含めた形をずらして落とす
    if (st?.shadowColor) {
      const o = (st.shadowOffset ?? 4) * scale * k;
      body(o, o, st.shadowColor);
    }
    body(0, 0);
    ctx.restore();
  };
  ctx.textAlign = 'left';
  let seen = 0;
  lines.forEach((line, i) => {
    const chars = [...line];
    const shown = chars.slice(0, Math.max(0, Math.min(chars.length, count - seen))).join('');
    seen += chars.length;
    const y = ys[i];
    // 全文の幅で左端を決め、左揃えで描く（中央揃えのまま文字だけ増やす）
    ctx.font = fontAt(size);
    const x0 = w / 2 - ctx.measureText(line).width / 2;
    run(shown, x0, y, size);
    // ルビ（語の頭の文字が出たら出す。語より長ければ語の幅に縮める）
    let x = x0;
    for (const piece of rows?.[i] ?? []) {
      ctx.font = fontAt(size);
      const wb = ctx.measureText(piece.text).width;
      if (piece.ruby && piece.at < count) {
        ctx.font = fontAt(rs);
        const wr = ctx.measureText(piece.ruby).width;
        const ry = pos === 'middle' ? y - lh / 2 - (rs * 1.25) / 2 : y - size * 0.95 - rs * 0.12;
        if (wr <= wb) run(piece.ruby, x + (wb - wr) / 2, ry, rs);
        else run(piece.ruby, x, ry, rs, wb / wr);
      }
      x += wb;
    }
  });
  ctx.restore();
}

/** 切り替えを置き換えた写し（同じプロジェクトなら作り直さない） */
let lastTrans: [Project, Project] | null = null;
function transitionsOf(p: Project): Project {
  if (lastTrans?.[0] !== p) lastTrans = [p, withTransitions(p)];
  return lastTrans[1];
}

export function Preview() {
  const project = useStore(s => s.project);
  const projectPath = useStore(s => s.projectPath);
  const playhead = useStore(s => s.playhead);
  const isPlaying = useStore(s => s.isPlaying);
  const playRate = useStore(s => s.playRate);
  const isEmpty = useStore(s => !s.project?.clips.length);
  const previewZoom = useStore(s => s.previewZoom);
  const previewQuality = useStore(s => s.previewQuality);
  const showSafeArea = useStore(s => s.showSafeArea);
  const rootRef = useRef<HTMLDivElement>(null);
  const previewFull = useStore(s => s.previewFull);
  // 倍率を変えたら、はみ出した映像の真ん中を見せる（一般的な編集ソフトと同じ）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    });
  }, [previewZoom]);
  const proxies = useStore(s => s.proxies);
  const media = useStore(s => s.media);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 画像やピークの読み込み完了、枠のサイズ変更で描き直すためのカウンタ
  const [tick, setTick] = useState(0);
  const selectedClipId = useStore(s => s.selectedClipId);
  const selectedCharacterId = useStore(s => s.selectedCharacterId);
  // 立ち絵の枠は「立ち絵」タブを開いているときだけ出す（いつも出ていると邪魔なので）
  const inspectorTab = useStore(s => s.inspectorTab);
  // プレビューで選んでいるもの：素材クリップ、なければ（クリップ未選択時の）キャラクターの立ち絵
  const selectedKey = selectedClipId
    ? (() => {
        const c = project?.clips.find(x => x.id === selectedClipId);
        return !!c && (isVisual(c) || c.type === 'portrait');
      })()
      ? `m:${selectedClipId}`
      : null
    : selectedCharacterId && inspectorTab === 'portrait'
      ? `p:${selectedCharacterId}`
      : null;
  const targetsRef = useRef<Target[]>([]);
  const scaleRef = useRef(1);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const overrideRef = useRef<{key: string; transform: Transform} | null>(null);
  // 動かしている間に出す、吸着した線（画面の中央・端）。画面上の位置
  const guidesRef = useRef<{v: number[]; h: number[]}>({v: [], h: []});
  // 動かしている間もプロパティの X・Y を追従させる（1 コマに 1 回だけ書き込む）
  const liveRef = useRef(0);
  // つまみを寄せる枠（プレビューの見えている範囲。プレビューの左上からの位置）
  const boundsRef = useRef<Bounds | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const bump = () => setTick(t => t + 1);
    const ro = new ResizeObserver(bump);
    ro.observe(wrap);
    const off = onPeaks(bump);
    const offLut = onLutReady(bump);
    return () => {
      ro.disconnect();
      off();
      offLut();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const p0 = getState().project;
    if (!canvas || !wrap || !p0) return;
    // つなぎ目の切り替えは、前後のアイテムの動きと覆う図形に置き換えて描く（書き出しと同じ）
    const p = transitionsOf(p0);
    const bump = () => setTick(t => t + 1);
    const ar = p.video.width / p.video.height;
    // 表示の大きさ：「全体」は枠に収める、ほかは動画の大きさの倍率（はみ出したらスクロール）
    const PAD = 32; // .vx-preview の padding（左右・上下の合計）
    const fitW = Math.max(1, Math.min(wrap.clientWidth - PAD, (wrap.clientHeight - PAD) * ar));
    const w = previewZoom === 'fit' ? fitW : (p.video.width * previewZoom) / (window.devicePixelRatio || 1);
    const h = w / ar;
    // 画質を下げると、描く画素を減らして軽くする（表示の大きさは変えない）
    const dpr = (window.devicePixelRatio || 1) * previewQuality;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    const scale = w / p.video.width;
    const fps = p.video.fps;
    ctx.fillStyle = p.video.background;
    ctx.fillRect(0, 0, w, h);

    const at = (c: {start: number; duration: number}) => playhead >= c.start && playhead < c.start + c.duration;
    const targets: Target[] = [];
    let ivCache: [number, number][] | null = null;
    const duckIv = () => (ivCache ??= voiceIntervals(p));
    const ov = overrideRef.current;
    const tf = (key: string, t: Transform) => (ov?.key === key ? ov.transform : t);
    const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
    const audible = audibleTracks(p);
    const activeVideos = new Set<HTMLVideoElement>();
    const total = projectDuration(p);
    const vt = videoTracks(p);

    // 立ち絵（口パク・目パチ）
    // 立ち絵アイテム（PSD 立ち絵だけ。口パク・目パチ・表情）
    const drawPortrait = (item: PortraitClip) => {
      const ch = p.characters.find(x => x.id === item.characterId);
      const pt = ch?.portrait;
      if (!ch || !pt?.visible || !pt.psd) return;
      let eyes = eyesAt(playhead, blinkFor(ch.id, fps, total));
      let mouth = 0;
      // 表情：既定は立ち絵アイテムの「既定の表情」。セリフで選んでいればその表情（core/src/lipsync.rs と同じく、後ろのクリップが勝つ）
      const itemDefault = expressionIndex(pt, item.expression);
      let expr = itemDefault;
      let speaking = false;
      const effects: Effect[] = [];
      const variants = lineVariants(p, ch);
      for (const c of p.clips) {
        if (c.type !== 'voice' || c.characterId !== ch.id || !audible.has(c.trackId) || !at(c)) continue;
        speaking = true;
        // セリフで立ち絵のレイヤーを変えていれば、その組み合わせ
        expr = variants.find(v => v.id === c.id)?.index ?? lineExpression(pt, c.expression, itemDefault);
        // セリフの立ち絵設定：目パチしない・口パクしない・エフェクト
        if (c.portrait?.noBlink) eyes = 0;
        effects.push(...(c.portrait?.effects ?? []));
        if (!c.audio || c.portrait?.noMouth) continue;
        const pk = getPeaks(c.audio.cacheKey);
        if (pk) mouth = Math.max(mouth, mouthAt(pk.data, pk.max, playhead - c.start + startOffsetOf(c), fps));
      }
      // 喋っているときだけ表示する立ち絵（書き出しと同じく、そのキャラクターのセリフの間だけ）
      if ((item.onlyWhileSpeaking ?? pt.onlyWhileSpeaking) && !speaking) return;
      const key = `m:${item.id}`;
      // PSD のレイヤーの表示を切り替えて合成した画像（psd/portrait.ts）
      const psdFrame = psdPreviewFrame(pt, expressionFor(p, ch, expr), eyes, mouth, projectPath, bump);
      if (!psdFrame) return;
      const tr = tf(key, item.transform);
      // エフェクトがあれば書き出しと同じ計算で（preview/visual.ts）
      const rect = effects.length
        ? drawVisual(
            ctx,
            // 波・渦巻き（書き出しと同じく画面の px。時刻は動画の頭から）
            distort(psdFrame.image, [psdFrame.image.width, psdFrame.image.height], effects, playhead / fps, psdFrame.image.width / psdFrame.size[0] / Math.max(0.01, tr.scale)),
            psdFrame.size,
            visualAt(tr, {...plainLook(), effects}, 0, 1, fps, playhead / fps),
            w,
            h,
            scale,
          )
        : place(ctx, psdFrame.image, tr, w, h, scale, psdFrame.size);
      if (!locked.has(item.trackId)) targets.push({key, kind: 'media', id: item.id, rect, transform: tf(key, item.transform)});
    };

    // レイヤー（YMM4 と同じくレイヤー 1 から描く＝番号の大きいレイヤーが手前）
    for (const t of vt) {
      if (t.hidden) continue;
      for (const c of p.clips) {
        if (c.trackId !== t.id || !isVisual(c) || !at(c)) continue;
        // 動き・フェード・エフェクト（書き出しと同じ計算。preview/visual.ts）
        // キーフレームのあるアイテムは、ドラッグ中も確定した値（点を動かした結果）で描く
        const look = (key: string, tr: Transform) => visualAt(c.look?.anim ? tr : tf(key, tr), c.look, playhead - c.start, c.duration, fps, playhead / fps, [p.video.width, p.video.height]);
        // 波・渦巻き（元の大きさで掛ける。時刻はアイテムの頭から）
        const warp = (img: CanvasImageSource, size: [number, number]) => distort(img, size, c.look?.effects, (playhead - c.start) / fps, 1 / Math.max(0.01, c.transform.scale));
        if (c.type === 'text' || c.type === 'shape') {
          const img = itemImage(c)!;
          const key = `m:${c.id}`;
          const rect = drawVisual(ctx, warp(img, [img.width, img.height]), [img.width, img.height], look(key, c.transform), w, h, scale);
          if (!locked.has(c.trackId) && !c.id.includes('~')) targets.push({key, kind: 'media', id: c.id, rect, transform: tf(key, c.transform)});
          continue;
        }
        const m = c as MediaClip;
        // 背景を消す型（作ってあれば）。画像は PNG、動画は同じ素材の時刻に合わせた白黒の動画
        const matteUrl = m.matte ? proxies[matteKey(m.src, m.matte)]?.url : null;
        if (m.mediaKind === 'image') {
          const img = image(m.src, projectPath, bump);
          const matte = matteUrl ? urlImage(matteUrl, bump) : null;
          const key = `m:${m.id}`;
          if (img) {
            // 切り抜き・色抜き・形の切り抜き（書き出しと同じく、大きさを変える前に）
            const sv = sourceView(img, [img.naturalWidth, img.naturalHeight], m, true, m.src, matte);
            if (m.fillBlur) drawFillBlur(ctx, sv.img, sv.size, w, h, scale, m.fillBlur);
            const rect = drawVisual(ctx, warp(sv.img, sv.size), sv.size, look(key, m.transform), w, h, scale);
            if (!locked.has(m.trackId))
              targets.push({
                key,
                kind: 'media',
                id: m.id,
                rect,
                transform: tf(key, m.transform),
              });
          }
        } else if (m.mediaKind === 'video') {
          // 手ぶれ補正を付けた動画は、補正したプロキシ（できるまでは元のプロキシ）
          const px = (m.stabilize && proxies[proxyKey(m)]?.url ? proxies[proxyKey(m)] : null) ?? proxies[m.src];
          const info = media[m.src];
          if (px?.url && info?.width && info.height) {
            const v = videoFor(px.url, bump);
            // 映像と音が 1 つの動画は、ここで音も鳴らす（分離した動画の音は音声トラックのクリップで鳴らす）。
            // 「セリフ中は下げる」トラックは書き出しと同じ動きで下げる
            const duck = t.duck ? duckGain(duckIv(), t.duckLevel, playhead / fps) : 1;
            // 切り替えで映像だけを延ばした部分は音を出さない
            const voiced = m.audioUntil === undefined || playhead - m.start < m.audioUntil;
            // 音を加工した動画は、加工した音を別に鳴らす（下の <audio>）ので、動画の音は出さない
            const vol = m.hasAudio && audible.has(t.id) && voiced && !hasAudioFx(m) ? m.volume * duck : 0;
            // 速さ・逆再生・静止（書き出しと同じ対応。逆再生と静止は止めたままコマを合わせ、音は出さない）
            const sp = speedAt(m, playhead - m.start);
            if (syncVideo(v, srcFrameAt(m, playhead - m.start) / fps, isPlaying, sp > 0 ? vol : 0, playRate * sp)) {
              const key = `m:${m.id}`;
              let matte: CanvasImageSource | null = null;
              if (matteUrl) {
                if (/\.png($|\?)|^data:image/.test(matteUrl)) matte = urlImage(matteUrl, bump);
                else {
                  const mv = videoFor(matteUrl, bump);
                  if (syncVideo(mv, srcFrameAt(m, playhead - m.start) / fps, isPlaying, 0, playRate * sp)) matte = mv;
                  activeVideos.add(mv);
                }
              }
              const sv = sourceView(v, [info.width, info.height], m, false, '', matte);
              if (m.fillBlur) drawFillBlur(ctx, sv.img, sv.size, w, h, scale, m.fillBlur);
              const rect = drawVisual(ctx, warp(sv.img, sv.size), sv.size, look(key, m.transform), w, h, scale);
              if (!locked.has(m.trackId))
                targets.push({
                  key,
                  kind: 'media',
                  id: m.id,
                  rect,
                  transform: tf(key, m.transform),
                });
            }
            activeVideos.add(v);
          } else {
            // プロキシを作っている間は進み具合を出す
            ctx.fillStyle = 'rgba(142,142,147,0.35)';
            ctx.fillRect(w * 0.1, h * 0.1, w * 0.8, h * 0.8);
            ctx.fillStyle = '#fff';
            ctx.font = `${Math.max(12, 20 * scale)}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const msg = px?.error ? 'プレビューを用意できませんでした' : `プレビューを用意しています ${Math.round((px?.ratio ?? 0) * 100)}%`;
            ctx.fillText(msg, w / 2, h / 2);
          }
        }
      }
      // このトラックの立ち絵と字幕（字幕は立ち絵より手前）
      for (const c of p.clips) if (c.type === 'portrait' && c.trackId === t.id && at(c)) drawPortrait(c);
      for (const c of p.clips) {
        if (c.trackId !== t.id || !at(c) || (c.type !== 'caption' && c.type !== 'voice')) continue;
        // 分離した字幕はそのセリフの文、字幕と声が 1 つのセリフはそれ自身の文（分離した声は字幕を出さない）
        const v = lineOfSubtitle(p, c);
        if (!v) continue;
        // 「個別に設定」した字幕は、テキストアイテムと同じように画像にして置く（書き出しも同じ画像）
        const sc = v.subtitleCustom;
        if (sc) {
          const text = v.subtitle ?? v.text;
          if (!text.trim()) continue;
          // 1 文字ずつ出す字幕は、その時点の文字数の画像（書き出しも同じ画像を順に出す）
          const img = subtitleImage(v, sc, visibleChars(sc, text, playhead - c.start));
          const key = `s:${v.id}`;
          const tr = tf(key, sc.transform);
          const warped = distort(img, [img.width, img.height], sc.look?.effects, (playhead - c.start) / fps, 1 / Math.max(0.01, sc.transform.scale));
          const rect = drawVisual(ctx, warped, [img.width, img.height], visualAt(tr, sc.look, playhead - c.start, c.duration, fps, playhead / fps, [p.video.width, p.video.height]), w, h, scale);
          if (!locked.has(c.trackId)) targets.push({key, kind: 'subtitle', id: v.id, selectId: c.id, rect, transform: tr});
          continue;
        }
        // 分離した字幕で見た目を上書きしていれば、それを当てる（書き出しと同じ）
        const chr = p.characters.find(ch => ch.id === v.characterId);
        const ov = c.type === 'caption' ? c.style : null;
        drawSubtitle(ctx, v.subtitle ?? v.text, chr && ov ? {...chr, subtitle: {...chr.subtitle, ...ov}} : chr, p, scale, playhead - c.start, c.duration);
      }
    }
    // 速さを変えた音声素材・音を加工した素材は <audio> で鳴らす（速さを変えても音の高さが変わらない。加工した音は書き出しと同じ WAV）。
    // そのほかの音声素材は playback.ts の Web Audio
    if (isPlaying)
      for (const c of p.clips) {
        if (c.type !== 'media' || !audible.has(c.trackId) || !at(c)) continue;
        const fxd = hasAudioFx(c) && (c.mediaKind === 'audio' || (c.mediaKind === 'video' && c.hasAudio));
        if (!fxd && !(c.mediaKind === 'audio' && isRetimed(c))) continue;
        if (c.freeze || (c.audioUntil !== undefined && playhead - c.start >= c.audioUntil)) continue;
        const url = fxd ? processedAudio(c, projectPath, bump) : apiNow ? apiNow.mediaUrl(c.src, projectPath) : c.src;
        if (!url) continue;
        const el = videoFor(url, () => {});
        const t = p.tracks.find(x => x.id === c.trackId);
        const duck = t?.duck ? duckGain(duckIv(), t.duckLevel, playhead / fps) : 1;
        const sp = speedAt(c, playhead - c.start);
        syncVideo(el, srcFrameAt(c, playhead - c.start) / fps, true, sp > 0 ? c.volume * duck : 0, playRate * sp);
        activeVideos.add(el);
      }
    pauseExcept(activeVideos);

    // セーフエリア（外側＝アクション 93%、内側＝タイトル 90%）。書き出しには入らない
    if (showSafeArea) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      for (const k of [0.93, 0.9]) {
        const sw = w * k;
        const sh = h * k;
        ctx.strokeRect((w - sw) / 2, (h - sh) / 2, sw, sh);
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(w / 2 - 8, h / 2);
      ctx.lineTo(w / 2 + 8, h / 2);
      ctx.moveTo(w / 2, h / 2 - 8);
      ctx.lineTo(w / 2, h / 2 + 8);
      ctx.stroke();
      ctx.restore();
    }

    // 選んでいるもの（素材か立ち絵）に枠と四隅のつまみを出す。
    // 画面の外にはみ出していても大きさを変えられるよう、プレビューの外側まで描ける重ねた canvas に描く
    targetsRef.current = targets;
    scaleRef.current = scale;
    const sel = targets.find(t => t.key === selectedKey);
    const ovc = overlayRef.current;
    const root = rootRef.current;
    if (ovc && root) {
      const wr = wrap.getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      const odpr = window.devicePixelRatio || 1;
      ovc.style.left = `${wr.left - rr.left}px`;
      ovc.style.top = `${wr.top - rr.top}px`;
      ovc.style.width = `${wr.width}px`;
      ovc.style.height = `${wr.height}px`;
      if (ovc.width !== Math.round(wr.width * odpr) || ovc.height !== Math.round(wr.height * odpr)) {
        ovc.width = Math.round(wr.width * odpr);
        ovc.height = Math.round(wr.height * odpr);
      }
      const o = ovc.getContext('2d')!;
      o.setTransform(odpr, 0, 0, odpr, 0, 0);
      o.clearRect(0, 0, wr.width, wr.height);
      if (sel && !isPlaying) {
        o.translate(cr.left - wr.left, cr.top - wr.top);
        boundsRef.current = {x0: wr.left - cr.left, y0: wr.top - cr.top, x1: wr.right - cr.left, y1: wr.bottom - cr.top};
        const r = sel.rect;
        // 吸着した線（中央・端）
        const gd = guidesRef.current;
        if (gestureRef.current && (gd.v.length || gd.h.length)) {
          o.save();
          o.strokeStyle = '#FF2D95';
          o.lineWidth = 1;
          o.setLineDash([4, 3]);
          const vw = cr.width;
          const vh = cr.height;
          for (const gx of gd.v) {
            o.beginPath();
            o.moveTo(gx + 0.5, 0);
            o.lineTo(gx + 0.5, vh);
            o.stroke();
          }
          for (const gy of gd.h) {
            o.beginPath();
            o.moveTo(0, gy + 0.5);
            o.lineTo(vw, gy + 0.5);
            o.stroke();
          }
          o.restore();
        }
        o.strokeStyle = '#8B74F0'; // ブランドの紫。動画の明暗どちらの上でも見える中間の明るさ
        o.lineWidth = 1.5;
        // 映像の中ははっきり、映像の外にはみ出た分は薄い破線（字幕などの上に太い枠が重ならないように）
        o.save();
        o.beginPath();
        o.rect(0, 0, cr.width, cr.height);
        o.clip();
        o.strokeRect(r.x, r.y, r.w, r.h);
        o.restore();
        o.save();
        o.beginPath();
        o.rect(-1e5, -1e5, 2e5, 2e5);
        o.rect(0, 0, cr.width, cr.height);
        o.clip('evenodd');
        o.globalAlpha = 0.45;
        o.setLineDash([4, 4]);
        o.strokeRect(r.x, r.y, r.w, r.h);
        o.restore();
        o.fillStyle = '#fff';
        for (const [cx, cy] of handles(r, boundsRef.current)) {
          o.fillRect(cx - HANDLE / 2, cy - HANDLE / 2, HANDLE, HANDLE);
          o.strokeRect(cx - HANDLE / 2, cy - HANDLE / 2, HANDLE, HANDLE);
        }
      }
    }
  }, [project, projectPath, playhead, isPlaying, playRate, proxies, media, tick, selectedKey, previewZoom, previewQuality, showSafeArea]);

  const hit = (e: React.PointerEvent) => {
    // プレビューの外（まわりの余白）でも、プレビューの左上からの位置で数える
    const c = canvasRef.current!.getBoundingClientRect();
    return {x: e.clientX - c.left, y: e.clientY - c.top};
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const pt = hit(e);
    const targets = targetsRef.current;
    const sel = targets.find(t => t.key === selectedKey);
    // 選んでいるもののつまみ → 大きさを変える
    if (sel && handles(sel.rect, boundsRef.current).some(([cx, cy]) => Math.abs(pt.x - cx) <= HANDLE && Math.abs(pt.y - cy) <= HANDLE)) {
      gestureRef.current = {
        target: sel,
        mode: 'scale',
        x: pt.x,
        y: pt.y,
        dist: distToCenter(sel.rect, pt),
        moved: false,
        id: Date.now(),
        pointerId: e.pointerId,
        captureEl: e.target as Element,
      };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    // 手前から順に当たり判定
    const t = [...targets].reverse().find(t => inside(t.rect, pt));
    if (!t) return;
    selectTarget(t);
    gestureRef.current = {
      target: t,
      mode: 'move',
      x: pt.x,
      y: pt.y,
      dist: 0,
      moved: false,
      id: Date.now(),
      pointerId: e.pointerId,
      captureEl: e.target as Element,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    const pt = hit(e);
    const canvas = wrapRef.current!;
    if (!g) {
      const sel = targetsRef.current.find(t => t.key === selectedKey);
      const onHandle = sel && handles(sel.rect, boundsRef.current).some(([cx, cy]) => Math.abs(pt.x - cx) <= HANDLE && Math.abs(pt.y - cy) <= HANDLE);
      canvas.style.cursor = onHandle ? 'nwse-resize' : targetsRef.current.some(t => inside(t.rect, pt)) ? 'move' : 'default';
      return;
    }
    g.moved = true;
    const sc = scaleRef.current || 1;
    const t0 = g.target.transform;
    let dx = pt.x - g.x;
    let dy = pt.y - g.y;
    guidesRef.current = {v: [], h: []};
    if (g.mode === 'move' && !e.altKey) {
      // 画面の中央・端に吸着する（Alt を押している間はしない）
      const cv = canvasRef.current!.getBoundingClientRect();
      const r = g.target.rect;
      const snap = (lo: number, size: number, d: number, span: number) => {
        let best: {d: number; at: number} | null = null;
        for (const [edge, at] of [
          [lo + size / 2, span / 2],
          [lo, 0],
          [lo + size, span],
        ] as const) {
          const diff = at - (edge + d);
          if (Math.abs(diff) <= SNAP && (!best || Math.abs(diff) < Math.abs(best.d))) best = {d: diff, at};
        }
        return best;
      };
      const sx = snap(r.x, r.w, dx, cv.width);
      const sy = snap(r.y, r.h, dy, cv.height);
      if (sx) {
        dx += sx.d;
        guidesRef.current.v.push(sx.at);
      }
      if (sy) {
        dy += sy.d;
        guidesRef.current.h.push(sy.at);
      }
    }
    const next =
      g.mode === 'move'
        ? {
            ...t0,
            x: Math.round(t0.x + dx / sc),
            y: Math.round(t0.y + dy / sc),
          }
        : {
            ...t0,
            // 5% 刻みで止める（Alt を押している間は細かく）
            scale: Math.max(0.05, ((raw: number) => (e.altKey ? Math.round(raw * 1000) / 1000 : Math.round(raw * 20) / 20))(t0.scale * (distToCenter(g.target.rect, pt) / Math.max(1, g.dist)))),
          };
    overrideRef.current = {key: g.target.key, transform: next};
    setTick(x => x + 1);
    if (!liveRef.current)
      liveRef.current = requestAnimationFrame(() => {
        liveRef.current = 0;
        const ov = overrideRef.current;
        const g2 = gestureRef.current;
        if (ov && g2) commitTransform(g2.target, ov.transform, `drag:${g2.target.key}:${g2.id}`);
      });
  };

  // Esc：動かしている途中ならやめて、元の位置に戻す
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const g = gestureRef.current;
      if (e.key !== 'Escape' || !g) return;
      e.preventDefault();
      e.stopPropagation();
      gestureRef.current = null;
      cancelAnimationFrame(liveRef.current);
      liveRef.current = 0;
      guidesRef.current = {v: [], h: []};
      overrideRef.current = null;
      try {
        g.captureEl?.releasePointerCapture(g.pointerId ?? 0);
      } catch {
        // もう放れていれば何もしない
      }
      // 途中でプロパティに書いた分も、履歴ごと取り消して、つかむ前に戻す
      const key = `drag:${g.target.key}:${g.id}`;
      if (g.moved && !revertMerge(key) && getState().project) commitTransform(g.target, g.target.transform, key);
      setTick(x => x + 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const onPointerUp = () => {
    const g = gestureRef.current;
    const ov = overrideRef.current;
    gestureRef.current = null;
    cancelAnimationFrame(liveRef.current);
    liveRef.current = 0;
    guidesRef.current = {v: [], h: []};
    if (g?.moved && ov) commitTransform(g.target, ov.transform, `drag:${g.target.key}:${g.id}`);
    overrideRef.current = null;
    setTick(x => x + 1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const sel = targetsRef.current.find(t => t.key === selectedKey);
    if (!sel) return;
    const step = e.shiftKey ? 10 : 1;
    const d = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    commitTransform(
      sel,
      {
        ...sel.transform,
        x: sel.transform.x + d[0],
        y: sel.transform.y + d[1],
      },
      `nudge:${sel.key}`,
    );
  };

  return (
    <div ref={rootRef} className="vx-preview-root" data-full={previewFull || undefined}>
      <div
        ref={wrapRef}
        className="vx-preview"
        data-zoomed={previewZoom !== 'fit' || undefined}
        onScroll={() => setTick(x => x + 1)}
        // つまみが画面の外にあってもつかめるよう、まわりの余白でも受ける
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={e => {
          // 何もないところをダブルクリックで全画面（一般的な編集ソフトと同じ）
          const c = canvasRef.current!.getBoundingClientRect();
          if (!targetsRef.current.some(t => inside(t.rect, {x: e.clientX - c.left, y: e.clientY - c.top}))) void toggleFullscreen(rootRef.current);
        }}>
        <canvas
          ref={canvasRef}
          className="vx-preview-canvas"
          tabIndex={0}
          role="application"
          aria-roledescription="プレビュー"
          aria-label={
            selectedKey ? 'プレビュー。選んでいる素材や立ち絵を、ドラッグか矢印キーで動かせます（Shift で 10 ずつ）。四隅のつまみで大きさを変えられます' : 'プレビュー。素材や立ち絵を押すと選べます'
          }
          onKeyDown={onKeyDown}
        />
        {/* 空のプロジェクト：真っ黒な画面だけにせず、何をすると何が出るかを映像の真ん中に薄く出す */}
        {isEmpty && (
          <div className="vx-preview-empty" aria-hidden>
            <svg viewBox="0 0 20 20" width="40" height="40">
              <rect width="20" height="20" rx="5" fill="#7A5FEA" />
              <path d="M5 8v4M8 5.5v9M11 7v6M14 4.5v11" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>セリフを入れると、ここに字幕と立ち絵が出ます</span>
          </div>
        )}
      </div>
      <canvas ref={overlayRef} className="vx-preview-overlay" aria-hidden />
      <PreviewControls fullscreenTarget={rootRef} />
    </div>
  );
}
