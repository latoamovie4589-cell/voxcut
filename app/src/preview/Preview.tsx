// プレビュー。Canvas 2D に 背景 → レイヤー（1 から順に：素材 → そのレイヤーの立ち絵 → 字幕）の順で描く。最終画質は書き出し時に FFmpeg が作る。
// 立ち絵の口パク・目パチは lipsync.ts（Rust と同じ計算）で決める。

import {getDock, showPanel} from '../dock/layout';
import {useEffect, useRef, useState} from 'react';
import type {Api} from '../ipc';
import {api} from '../ipc';
import type {Character, Effect, MediaClip, PortraitClip, Project, Transform} from '../model';
import {audibleTracks, lineOfSubtitle, expressionFor, expressionIndex, isVisual, lineExpression, lineVariants, plainLook, projectDuration, startOffsetOf, videoTracks} from '../model';
import {distort, drawVisual, itemImage, subtitleImage, visibleChars, visualAt} from './visual';
import {psdPreviewFrame} from '../psd/portrait';
import {duckGain, voiceIntervals} from '../ducking';
import {blinkStarts, eyesAt, mouthAt} from '../lipsync';
import {getPeaks, onPeaks} from '../peaks';
import {commit, getState, setState, useStore} from '../store';
import {pauseExcept, syncVideo, videoFor} from './video';
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
};
const HANDLE = 10;

const corners = (r: Rect): [number, number][] => [
  [r.x, r.y],
  [r.x + r.w, r.y],
  [r.x, r.y + r.h],
  [r.x + r.w, r.y + r.h],
];
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

function commitTransform(t: Target, transform: Transform, mergeKey?: string) {
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
        clips: p.clips.map(c => (c.id === t.id && (isVisual(c) || c.type === 'portrait') ? {...c, transform} : c)),
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
  const size = (st?.fontSize ?? 56) * scale;
  ctx.font = `600 ${size}px ${st?.fontFamily ? `"${st.fontFamily}",` : ''} -apple-system, "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif`;
  ctx.lineJoin = 'round';
  const lines = text.split('\n');
  const lh = size * 1.25;
  const w = p.video.width * scale;
  const h = p.video.height * scale;
  const margin = (st?.marginV ?? 60) * scale;
  const pos = st?.position ?? 'bottom';
  let y = pos === 'top' ? margin + size : pos === 'middle' ? h / 2 - ((lines.length - 1) * lh) / 2 : h - margin - (lines.length - 1) * lh;
  ctx.textBaseline = pos === 'middle' ? 'middle' : 'alphabetic';

  ctx.save();
  if (anim === 'fade') ctx.globalAlpha = fadeAlpha(f, duration, fps);
  if (anim === 'pop') {
    // 字幕のかたまりの中心を基準に拡大
    const cy = y + ((lines.length - 1) * lh) / 2 - (pos === 'middle' ? 0 : size * 0.35);
    const k = popScale(f, fps);
    ctx.translate(w / 2, cy);
    ctx.scale(k, k);
    ctx.translate(-w / 2, -cy);
  }
  let remaining = anim === 'typewriter' ? typewriterCount([...text.replace(/\n/g, '')].length, duration, f) : Infinity;
  for (const line of lines) {
    const chars = [...line];
    const shown = remaining === Infinity ? line : chars.slice(0, Math.max(0, remaining)).join('');
    if (remaining !== Infinity) remaining -= chars.length;
    // 全文の幅で左端を決め、左揃えで描く（中央揃えのまま文字だけ増やす）
    const x0 = w / 2 - ctx.measureText(line).width / 2;
    ctx.textAlign = 'left';
    if (shown) {
      if (st?.outlineWidth) {
        ctx.lineWidth = st.outlineWidth * 2 * scale;
        ctx.strokeStyle = st.outlineColor;
        ctx.strokeText(shown, x0, y);
      }
      ctx.fillStyle = st?.color ?? '#fff';
      ctx.fillText(shown, x0, y);
    }
    y += lh;
  }
  ctx.restore();
}

export function Preview() {
  const project = useStore(s => s.project);
  const projectPath = useStore(s => s.projectPath);
  const playhead = useStore(s => s.playhead);
  const isPlaying = useStore(s => s.isPlaying);
  const playRate = useStore(s => s.playRate);
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

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const bump = () => setTick(t => t + 1);
    const ro = new ResizeObserver(bump);
    ro.observe(wrap);
    const off = onPeaks(bump);
    return () => {
      ro.disconnect();
      off();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const p = getState().project;
    if (!canvas || !wrap || !p) return;
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
        const look = (key: string, tr: Transform) => visualAt(tf(key, tr), c.look, playhead - c.start, c.duration, fps, playhead / fps);
        // 波・渦巻き（元の大きさで掛ける。時刻はアイテムの頭から）
        const warp = (img: CanvasImageSource, size: [number, number]) => distort(img, size, c.look?.effects, (playhead - c.start) / fps, 1 / Math.max(0.01, c.transform.scale));
        if (c.type === 'text' || c.type === 'shape') {
          const img = itemImage(c)!;
          const key = `m:${c.id}`;
          const rect = drawVisual(ctx, warp(img, [img.width, img.height]), [img.width, img.height], look(key, c.transform), w, h, scale);
          if (!locked.has(c.trackId)) targets.push({key, kind: 'media', id: c.id, rect, transform: tf(key, c.transform)});
          continue;
        }
        const m = c as MediaClip;
        if (m.mediaKind === 'image') {
          const img = image(m.src, projectPath, bump);
          const key = `m:${m.id}`;
          if (img) {
            const rect = drawVisual(ctx, warp(img, [img.naturalWidth, img.naturalHeight]), [img.naturalWidth, img.naturalHeight], look(key, m.transform), w, h, scale);
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
          const px = proxies[m.src];
          const info = media[m.src];
          if (px?.url && info?.width && info.height) {
            const v = videoFor(px.url, bump);
            // 映像と音が 1 つの動画は、ここで音も鳴らす（分離した動画の音は音声トラックのクリップで鳴らす）。
            // 「セリフ中は下げる」トラックは書き出しと同じ動きで下げる
            const duck = t.duck ? duckGain(duckIv(), t.duckLevel, playhead / fps) : 1;
            const vol = m.hasAudio && audible.has(t.id) ? m.volume * duck : 0;
            if (syncVideo(v, (m.inPoint + playhead - m.start) / fps, isPlaying, vol, playRate)) {
              const key = `m:${m.id}`;
              const rect = drawVisual(ctx, warp(v, [info.width, info.height]), [info.width, info.height], look(key, m.transform), w, h, scale);
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
          const rect = drawVisual(ctx, warped, [img.width, img.height], visualAt(tr, sc.look, playhead - c.start, c.duration, fps, playhead / fps), w, h, scale);
          if (!locked.has(c.trackId)) targets.push({key, kind: 'subtitle', id: v.id, selectId: c.id, rect, transform: tr});
          continue;
        }
        // 分離した字幕で見た目を上書きしていれば、それを当てる（書き出しと同じ）
        const chr = p.characters.find(ch => ch.id === v.characterId);
        const ov = c.type === 'caption' ? c.style : null;
        drawSubtitle(ctx, v.subtitle ?? v.text, chr && ov ? {...chr, subtitle: {...chr.subtitle, ...ov}} : chr, p, scale, playhead - c.start, c.duration);
      }
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
        const r = sel.rect;
        o.strokeStyle = '#0A84FF';
        o.lineWidth = 1.5;
        o.strokeRect(r.x, r.y, r.w, r.h);
        o.fillStyle = '#fff';
        for (const [cx, cy] of corners(r)) {
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
    if (sel && corners(sel.rect).some(([cx, cy]) => Math.abs(pt.x - cx) <= HANDLE && Math.abs(pt.y - cy) <= HANDLE)) {
      gestureRef.current = {
        target: sel,
        mode: 'scale',
        x: pt.x,
        y: pt.y,
        dist: distToCenter(sel.rect, pt),
        moved: false,
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
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    const pt = hit(e);
    const canvas = wrapRef.current!;
    if (!g) {
      const sel = targetsRef.current.find(t => t.key === selectedKey);
      const onHandle = sel && corners(sel.rect).some(([cx, cy]) => Math.abs(pt.x - cx) <= HANDLE && Math.abs(pt.y - cy) <= HANDLE);
      canvas.style.cursor = onHandle ? 'nwse-resize' : targetsRef.current.some(t => inside(t.rect, pt)) ? 'move' : 'default';
      return;
    }
    g.moved = true;
    const sc = scaleRef.current || 1;
    const t0 = g.target.transform;
    const next =
      g.mode === 'move'
        ? {
            ...t0,
            x: Math.round(t0.x + (pt.x - g.x) / sc),
            y: Math.round(t0.y + (pt.y - g.y) / sc),
          }
        : {
            ...t0,
            scale: Math.max(0.05, Math.round(t0.scale * (distToCenter(g.target.rect, pt) / Math.max(1, g.dist)) * 1000) / 1000),
          };
    overrideRef.current = {key: g.target.key, transform: next};
    setTick(x => x + 1);
  };

  const onPointerUp = () => {
    const g = gestureRef.current;
    const ov = overrideRef.current;
    gestureRef.current = null;
    if (g?.moved && ov) commitTransform(g.target, ov.transform);
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
      </div>
      <canvas ref={overlayRef} className="vx-preview-overlay" aria-hidden />
      <PreviewControls fullscreenTarget={rootRef} />
    </div>
  );
}
