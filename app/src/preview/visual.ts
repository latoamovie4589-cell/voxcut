// 画像・動画・テキスト・図形の見た目：アニメーション・フェード・揺れ・映像エフェクトの計算と、テキスト・図形の描画。
// 書き出し（core/src/render.rs の visual_filters）と同じ計算になるようにそろえる。
// テキスト・図形は、ここで描いた画像をそのまま書き出しにも渡す（画面と動画で同じ見た目にするため）。

import type {BlendMode, Effect, Look, Region, Project, ShapeClip, SubtitleCustom, TextClip, Transform, VisualClip, VoiceClip} from '../model';
import {timerStep, timerText, type Marker} from '../model';
import {animFrameAt, animFrames, animImage, animKey} from './anim';
import {bubbleImage} from './bubble';
import {RETRO_FX, retroActive, retroPad, retroPixels, type RetroEffect} from './retro';
import {
  BLEND_CANVAS,
  animStateAt,
  charAnimFrames,
  fillTemplate,
  charProgress,
  easeValue,
  hash01,
  jitterAt,
  chromaWeights,
  colorGrade,
  cropKeep,
  lineOfSubtitle,
  maskAlpha,
  type MediaClip,
} from '../model';
import {api, type LutFit} from '../ipc';
import {hasRuby, keepRubyWords, parseRuby, rubyBase, rubyRows} from '../ruby';

export interface VisualState {
  transform: Transform;
  rotation: number;
  /** 不透明度（フェードを含む） */
  alpha: number;
  /** Canvas の filter（明るさ・コントラスト・彩度・反転。ぼかしは scale を掛けた px で別に足す） */
  filter: string;
  /** ぼかしの半径（書き出しの画面 px） */
  blur: number;
  /** 合成モード */
  blend?: BlendMode | null;
  /** クリッピング解除で隠すところ（アイテムの幅・高さに対する割合。左・上・右・下） */
  wipe?: [number, number, number, number];
  /** 画面の横・縦の倍率（回したあとに掛ける） */
  stretch?: [number, number];
  /** 3D 回転（X 軸・Y 軸の度） */
  rot3d?: [number, number];
  /** 残像（数・間隔フレーム） */
  trail?: [number, number];
  /** 円形に見せる範囲（アイテムの対角線の半分に対する割合。1 で全部見える） */
  iris?: number;
}

/** 拍動の形 exp(−10φ)(1 − exp(−60φ)) のいちばん大きい値が 1 になる倍率（書き出しの PULSE_NORM と同じ） */
const PULSE_NORM = 1.658;
/** ぼかしからの登場・退場：いちばん強いぼかし（画面の px）と段の数（書き出しと同じ） */
const MOTION_BLUR = 24;
const MOTION_BLUR_STEPS = 8;
/** 跳ねる登場・退場（行きすぎてから戻る。書き出しと同じ式） */
const backOut = (p: number) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;
const backIn = (p: number) => 2.70158 * p ** 3 - 1.70158 * p ** 2;

/**
 * その時点の見た目。local は アイテムの頭からのフレーム、dur はアイテムの長さ（フレーム）、abs はプロジェクトの頭からの秒
 */
export function visualAt(t: Transform, look: Look | undefined, local: number, dur: number, fps: number, abs: number, frame?: [number, number]): VisualState {
  const l = look;
  const d = dur / fps;
  const p = Math.min(1, Math.max(0, local / fps / Math.max(1e-3, d)));
  // 始まり →（キーフレーム…）→ 終わり。区間ごとに動き方を掛ける（書き出しの tween3 と同じ）
  const st = animStateAt(t, l, p);
  const tr: Transform = st.transform;
  let rotation = st.rotation;
  const c01 = (v: number) => Math.min(1, Math.max(0, v));
  let alpha = tr.opacity;
  const sec = local / fps;
  if (l?.fadeIn) alpha *= Math.min(1, sec / (l.fadeIn / fps));
  if (l?.fadeOut) alpha *= Math.min(1, Math.max(0, (d - sec) / (l.fadeOut / fps)));
  // 登場（残り 1 → 0。だんだん遅く）と退場（進み 0 → 1。だんだん速く）
  const [fw, fh] = frame ?? [1920, 1080];
  const wipe: [number, number, number, number] = [0, 0, 0, 0];
  let iris = 1;
  let motionBlur = 0;
  const apply = (m: Look['enter'], k: (len: number) => number, isEnter = false) => {
    if (!m || m.frames <= 0) return;
    const len = Math.min(m.frames / fps, Math.max(1e-3, d));
    const v = k(len);
    if (m.kind === 'iris') {
      iris = Math.min(iris, 1 - v);
      return;
    }
    if (m.kind === 'blur') {
      motionBlur += (MOTION_BLUR * Math.round(v * MOTION_BLUR_STEPS)) / MOTION_BLUR_STEPS;
      alpha *= 1 - v;
      return;
    }
    if (m.kind === 'bounce') {
      tr.scale *= isEnter ? backOut(c01(sec / len)) : 1 - backIn(c01((sec - Math.max(0, d - len)) / len));
      return;
    }
    if (m.kind === 'spin') {
      rotation += (isEnter ? -360 : 360) * v;
      tr.scale *= 1 - v;
      return;
    }
    // クリッピング解除：登場は残り v を、向きの先の側から隠す。退場は進み v を、向きの元の側から隠す（書き出しと同じ）
    if (m.kind.startsWith('wipe')) {
      const side = {wipeRight: [2, 0], wipeLeft: [0, 2], wipeDown: [3, 1], wipeUp: [1, 3]}[m.kind as 'wipeRight'][isEnter ? 0 : 1];
      wipe[side] = Math.max(wipe[side], v);
      return;
    }
    if (m.kind === 'slideLeft') tr.x -= fw * v;
    else if (m.kind === 'slideRight') tr.x += fw * v;
    else if (m.kind === 'slideUp') tr.y -= fh * v;
    else if (m.kind === 'slideDown') tr.y += fh * v;
    else tr.scale *= 1 - v;
  };
  // なめらか（押し出し）は 3p²−2p³（出ていく側と入る側の和がいつも 1）。書き出しと同じ式
  const smooth = (p: number) => p * p * (3 - 2 * p);
  apply(l?.enter, len => (l?.enter?.smooth ? 1 - smooth(c01(sec / len)) : (1 - c01(sec / len)) ** 2), true);
  apply(l?.exit, len => (l?.exit?.smooth ? smooth(c01((sec - Math.max(0, d - len)) / len)) : c01((sec - Math.max(0, d - len)) / len) ** 2));
  const filters: string[] = [];
  let blur = 0;
  let trail: [number, number] | undefined;
  for (const fx of l?.effects ?? []) {
    if (fx.kind === 'color') {
      if (fx.brightness !== 1) filters.push(`brightness(${fx.brightness})`);
      if (fx.contrast !== 1) filters.push(`contrast(${fx.contrast})`);
      if (fx.saturation !== 1) filters.push(`saturate(${fx.saturation})`);
    } else if (fx.kind === 'mono') filters.push('saturate(0)');
    else if (fx.kind === 'invert') filters.push('invert(1)');
    else if (fx.kind === 'grade' || fx.kind === 'temperature') {
      const f = gradeFilter(fx);
      if (f) filters.push(f);
    } else if (fx.kind === 'lut') {
      const f = lutFilter(fx.path, fx.strength);
      if (f) filters.push(f);
    } else if (fx.kind === 'blur') blur += Math.max(0, fx.radius);
    else if (fx.kind === 'wave' || fx.kind === 'swirl')
      continue; // distort で
    else if (fx.kind === 'shake') {
      tr.x += fx.amount * Math.sin(2 * Math.PI * fx.speed * abs);
      tr.y += fx.amount * Math.cos(2 * Math.PI * fx.speed * abs * 1.37);
    } else if (fx.kind === 'blink' && fx.speed > 0) {
      if (Math.floor(sec * fx.speed * 2) % 2) alpha = 0;
    } else if (fx.kind === 'jitter' && fx.speed > 0) {
      const [jx, jy] = jitterAt(fx.amount, fx.speed, sec);
      tr.x += jx;
      tr.y += jy;
    } else if (fx.kind === 'oscillate') {
      tr.x += fx.x * Math.sin(2 * Math.PI * fx.speed * sec);
      tr.y += fx.y * Math.sin(2 * Math.PI * fx.speed * sec);
    } else if (fx.kind === 'pulse' && fx.bpm > 0 && fx.amount > 0) {
      // 拍動：1 拍の頭でぐっと大きくなり、すぐ戻る
      const ph = ((((sec * fx.bpm) / 60) % 1) + 1) % 1;
      tr.scale *= 1 + fx.amount * PULSE_NORM * Math.exp(-10 * ph) * (1 - Math.exp(-60 * ph));
    } else if (fx.kind === 'spin') rotation += fx.rpm * 6 * sec;
    else if (fx.kind === 'bounce' && fx.bpm > 0) tr.y -= fx.height * Math.abs(Math.sin((Math.PI * sec * fx.bpm) / 60));
    else if (fx.kind === 'threshold') filters.push(thresholdFilter(fx.level));
    else if (fx.kind === 'plugin') {
      const f = fx.canvas ? fillTemplate(fx.canvas, fx.values) : null;
      if (f) filters.push(f);
    } else if (fx.kind === 'trail' && fx.count > 0 && fx.interval > 0) trail = [Math.min(8, fx.count), fx.interval];
  }
  const [kx, ky] = (l?.stretch ?? [1, 1]).map(v => Math.max(0.01, v));
  // 回転・拡大の中心：その点が位置に来るよう、中心から点までを回して大きさを掛けた分だけ戻す（書き出しと同じ）
  const pv = l?.pivot;
  if (pv && (pv[0] || pv[1])) {
    const a = (rotation * Math.PI) / 180;
    tr.x -= (pv[0] * Math.cos(a) - pv[1] * Math.sin(a)) * kx * tr.scale;
    tr.y -= (pv[0] * Math.sin(a) + pv[1] * Math.cos(a)) * ky * tr.scale;
  }
  // 3D 回転：始まり → 終わりへ ease で（途中の状態は通らない）
  const r0 = l?.rot3d ?? [0, 0];
  const r1 = l?.anim?.rot3d ?? r0;
  const ek = l?.anim ? easeValue(l.anim.ease, p) : 0;
  const rot3d: [number, number] = [r0[0] + (r1[0] - r0[0]) * ek, r0[1] + (r1[1] - r0[1]) * ek];
  return {
    transform: tr,
    rotation,
    alpha,
    filter: filters.join(' '),
    blur: blur + motionBlur,
    blend: l?.blend ?? null,
    wipe: wipe.some(v => v > 0) ? wipe : undefined,
    stretch: kx !== 1 || ky !== 1 ? [kx, ky] : undefined,
    rot3d: rot3d[0] || rot3d[1] ? rot3d : undefined,
    trail,
    iris: iris < 1 ? Math.max(0, iris) : undefined,
  };
}

/** 二値化の SVG フィルター（明るさ 0.299R+0.587G+0.114B がしきい値より上なら白。書き出しの geq と同じ） */
function thresholdFilter(level: number): string {
  const n = 256;
  const L = Math.min(1, Math.max(0, level)) * 255;
  // 明るさ v（0〜255）の i 番目の区間 [i, i+1) の値
  const tb = Array.from({length: n}, (_, i) => (i > L ? 1 : 0)).join(' ');
  return svgFilter(
    `vx-th-${Math.round(L)}`,
    `<feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0"/><feComponentTransfer><feFuncR type="discrete" tableValues="${tb}"/><feFuncG type="discrete" tableValues="${tb}"/><feFuncB type="discrete" tableValues="${tb}"/></feComponentTransfer>`,
  );
}

const dimsOf = (img: CanvasImageSource): [number, number] => [
  (img as HTMLVideoElement).videoWidth || (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width || 0,
  (img as HTMLVideoElement).videoHeight || (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height || 0,
];

/** 画素を読むエフェクト（書き出しの pixel_effect と同じもの） */
const PIXEL_FX = new Set(['wave', 'swirl', 'outline', 'shadow', 'glow', 'rgbShift', 'glitch', 'noise', 'radialBlur', 'dirBlur', ...RETRO_FX]);
/** 縁取りで形を読む向き（書き出しの RING と同じ） */
const RING = 16;

/**
 * 波・渦巻き・縁取り・影・発光・色ずれ・グリッチ・ノイズ・放射ブラー・方向ブラーを、エフェクトの順に掛ける（書き出しの pixel_effect と同じ式）。
 * size は元の大きさ、t はアイテムの頭からの秒、k は画面の 1px が元の何 px か。広がるもの（縁取り・影など）は、元の大きさで数えた余白を足した大きさを返す
 */
export function effectsSource(img: CanvasImageSource, size: [number, number], effects: Effect[] | undefined, t: number, k: number, fps = 30): {img: CanvasImageSource; size: [number, number]} {
  const list = (effects ?? []).filter(e => PIXEL_FX.has(e.kind));
  if (!list.length) return {img, size};
  let src = img;
  let sz: [number, number] = [...size];
  for (const fx of list) {
    const [iw, ih] = dimsOf(src);
    if (!iw || !ih || !sz[0]) break;
    const r = iw / sz[0]; // 元の 1px が今の画像の何 px か
    if (fx.kind === 'wave' || fx.kind === 'swirl') {
      src = distort(src, sz, [fx], t, k * r);
      continue;
    }
    // 元の px で数えた余白 p を、四方に足す（書き出しの pad と同じく整数に切り上げ）
    const grow = (p: number) => {
      const pp = Math.ceil(p);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(iw + pp * 2 * r));
      cv.height = Math.max(1, Math.round(ih + pp * 2 * r));
      cv.getContext('2d')!.drawImage(src, pp * r, pp * r, iw, ih);
      sz = [sz[0] + pp * 2, sz[1] + pp * 2];
      return cv;
    };
    // 形を色で塗ったもの
    const silhouette = (base: HTMLCanvasElement, color: string) => {
      const cv = document.createElement('canvas');
      cv.width = base.width;
      cv.height = base.height;
      const x = cv.getContext('2d')!;
      x.drawImage(base, 0, 0);
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = color;
      x.fillRect(0, 0, cv.width, cv.height);
      return cv;
    };
    const blank = (base: HTMLCanvasElement) => {
      const cv = document.createElement('canvas');
      cv.width = base.width;
      cv.height = base.height;
      return [cv, cv.getContext('2d')!] as const;
    };
    if (fx.kind === 'outline' && fx.width > 0) {
      const w = fx.width * k;
      const base = grow(w + 1);
      const sil = silhouette(base, fx.color);
      const [cv, x] = blank(base);
      x.drawImage(sil, 0, 0);
      for (const rr of [w, w / 2])
        for (let i = 0; i < RING; i++) {
          const a = (i * Math.PI * 2) / RING;
          x.drawImage(sil, rr * Math.cos(a) * r, rr * Math.sin(a) * r);
        }
      x.drawImage(base, 0, 0);
      src = cv;
    } else if (fx.kind === 'shadow' || fx.kind === 'glow') {
      const b = Math.max(0, fx.blur) * k;
      const [dx, dy] = fx.kind === 'shadow' ? [fx.x * k, fx.y * k] : [0, 0];
      const base = grow(b * 3 + Math.max(Math.abs(dx), Math.abs(dy)) + 1);
      const sil = silhouette(base, fx.color);
      const [cv, x] = blank(base);
      if (b > 0) x.filter = `blur(${b * r}px)`;
      if (fx.kind === 'shadow') {
        x.globalAlpha = Math.min(1, Math.max(0, fx.opacity));
        x.drawImage(sil, dx * r, dy * r);
      } else for (let i = 0; i < Math.min(5, Math.max(1, Math.round(fx.strength))); i++) x.drawImage(sil, 0, 0);
      x.filter = 'none';
      x.globalAlpha = 1;
      x.drawImage(base, 0, 0);
      src = cv;
    } else if (fx.kind === 'radialBlur' && fx.amount > 0) {
      // 真ん中へ向かって 8 点読む＝真ん中を中心に 1/s 倍した 8 枚の平均
      const a = Math.min(0.9, fx.amount);
      const [cv, x] = blank(grow(0));
      x.globalCompositeOperation = 'lighter';
      x.globalAlpha = 1 / 8;
      for (let i = 0; i < 8; i++) {
        const sc = 1 / (1 - (a * i) / 7);
        x.drawImage(src, (iw - iw * sc) / 2, (ih - ih * sc) / 2, iw * sc, ih * sc);
      }
      src = cv;
    } else if (fx.kind === 'dirBlur' && fx.length > 0) {
      const l = fx.length * k;
      const base = grow(l / 2 + 1);
      const [cv, x] = blank(base);
      x.globalCompositeOperation = 'lighter';
      x.globalAlpha = 1 / 8;
      const [c, sn] = [Math.cos((fx.angle * Math.PI) / 180), Math.sin((fx.angle * Math.PI) / 180)];
      for (let i = 0; i < 8; i++) {
        const d = l * (i / 7 - 0.5) * r;
        x.drawImage(base, d * c, d * sn);
      }
      src = cv;
    } else if (fx.kind === 'glitch' && fx.band > 0) {
      // 帯ごと・時刻ごとに、4 割の帯だけ横にずらす（書き出しと同じ乱数）
      const a = fx.amount * k;
      const base = grow(Math.abs(a) + 1);
      const [cv, x] = blank(base);
      const n = Math.floor(t * fx.speed);
      for (let y = 0; y < base.height; y++) {
        const row = Math.floor((y + 0.5) / r / (fx.band * k));
        const off = hash01(row + 0.5, n + 7) > 0.6 ? a * (hash01(row, n) * 2 - 1) : 0;
        x.drawImage(base, 0, y, base.width, 1, off * r, y, base.width, 1);
      }
      src = cv;
    } else if (RETRO_FX.has(fx.kind)) {
      const rf = fx as RetroEffect;
      if (!retroActive(rf)) continue;
      const base = grow(retroPad(rf, k));
      const x = base.getContext('2d', {willReadFrequently: true})!;
      try {
        x.putImageData(retroPixels(rf, x.getImageData(0, 0, base.width, base.height), r, k, t, fps), 0, 0);
      } catch {
        continue; // 読めない画像（別のオリジンの動画など）はそのまま
      }
      src = base;
    } else if ((fx.kind === 'rgbShift' && fx.amount) || (fx.kind === 'noise' && fx.amount > 0)) {
      const base = fx.kind === 'rgbShift' ? grow(Math.abs(fx.amount * k) + 1) : grow(0);
      const W = base.width;
      const H = base.height;
      const x = base.getContext('2d', {willReadFrequently: true})!;
      let d: ImageData;
      try {
        d = x.getImageData(0, 0, W, H);
      } catch {
        continue; // 読めない画像（別のオリジンの動画など）はそのまま
      }
      const o = x.createImageData(W, H);
      const at = (X: number, Y: number, c: number) => {
        const x0 = Math.floor(X);
        const f = X - x0;
        const g = (xx: number) => (xx < 0 || xx >= W ? 0 : d.data[(Y * W + xx) * 4 + c]);
        return g(x0) * (1 - f) + g(x0 + 1) * f;
      };
      if (fx.kind === 'rgbShift') {
        const a = fx.amount * k * r;
        for (let Y = 0; Y < H; Y++)
          for (let X = 0; X < W; X++) {
            const i = (Y * W + X) * 4;
            o.data[i] = at(X - a, Y, 0);
            o.data[i + 1] = d.data[i + 1];
            o.data[i + 2] = at(X + a, Y, 2);
            o.data[i + 3] = Math.max(at(X - a, Y, 3), d.data[i + 3], at(X + a, Y, 3));
          }
      } else {
        const N = Math.round(t * fps);
        const amp = Math.min(1, fx.amount) * 255 * 2;
        for (let Y = 0; Y < H; Y++)
          for (let X = 0; X < W; X++) {
            const i = (Y * W + X) * 4;
            const v = (hash01(X / r + (Y / r) * 0.618, N + 0.37) - 0.5) * amp;
            o.data[i] = d.data[i] + v;
            o.data[i + 1] = d.data[i + 1] + v;
            o.data[i + 2] = d.data[i + 2] + v;
            o.data[i + 3] = d.data[i + 3];
          }
      }
      x.putImageData(o, 0, 0);
      src = base;
    }
  }
  return {img: src, size: sz};
}

/** 3D 回転の枠の広さ（書き出しの TILT_PAD と同じ） */
export const TILT_PAD = 1.4;
/** 3D 回転の枠の大きさ（書き出しの pad と同じく偶数に切り上げ） */
const tiltSize = (n: number) => Math.ceil((n * TILT_PAD) / 2) * 2;

/**
 * 3D 回転：画像を TILT_PAD 倍の透明な枠の真ん中に置き、X 軸・Y 軸で傾ける（書き出しの tilt_filters と同じ式）。
 * size は元の大きさ。返す大きさも元の大きさで数えた枠の大きさ
 */
export function tilt3d(img: CanvasImageSource, size: [number, number], rot: [number, number]): {img: CanvasImageSource; size: [number, number]} {
  const out: [number, number] = [tiltSize(size[0]), tiltSize(size[1])];
  const iw = (img as HTMLVideoElement).videoWidth || (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width;
  const ih = (img as HTMLVideoElement).videoHeight || (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height;
  if (!iw || !ih) return {img, size};
  // プレビューでは小さめにして計算する（長い辺 480px まで）
  const r = Math.min(1, 480 / Math.max(iw, ih));
  const sw = Math.max(1, Math.round(iw * r));
  const sh = Math.max(1, Math.round(ih * r));
  const W = tiltSize(sw);
  const H = tiltSize(sh);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const x = cv.getContext('2d', {willReadFrequently: true})!;
  x.drawImage(img, Math.floor((W - sw) / 2), Math.floor((H - sh) / 2), sw, sh);
  let src: ImageData;
  try {
    src = x.getImageData(0, 0, W, H);
  } catch {
    return {img, size}; // 読めない画像（別のオリジンの動画など）はそのまま
  }
  const dst = x.createImageData(W, H);
  const rx = (rot[0] * Math.PI) / 180;
  const ry = (rot[1] * Math.PI) / 180;
  const f = (Math.max(W, H) * 2) / TILT_PAD;
  const [sx, cx, sy, cy] = [Math.sin(rx), Math.cos(rx), Math.sin(ry), Math.cos(ry)];
  const d = src.data;
  const o = dst.data;
  // 端の外は透明として、4 点の間を混ぜて読む
  const px = (X: number, Y: number, c: number) => (X < 0 || Y < 0 || X >= W || Y >= H ? 0 : d[(Y * W + X) * 4 + c]);
  for (let Y = 0; Y < H; Y++)
    for (let X = 0; X < W; X++) {
      const xc = X - W / 2;
      const yc = Y - H / 2;
      const A = f * cy + xc * sy;
      const B = f * sx * sy - xc * sx * cy;
      const C = yc * sy;
      const D = f * cx - yc * sx * cy;
      const det = A * D - B * C;
      if (Math.abs(det) <= 1e-6) continue;
      const u = (f * (xc * D - yc * B)) / det;
      const v = (f * (A * yc - C * xc)) / det;
      if (f - u * sy + v * sx * cy <= 1) continue;
      const qx = u + W / 2;
      const qy = v + H / 2;
      const x0 = Math.floor(qx);
      const y0 = Math.floor(qy);
      const fx = qx - x0;
      const fy = qy - y0;
      const i = (Y * W + X) * 4;
      for (let c = 0; c < 4; c++) o[i + c] = (px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx) * (1 - fy) + (px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx) * fy;
    }
  x.putImageData(dst, 0, 0);
  return {img: cv, size: out};
}

/**
 * アイテムの絵を、置く前に加工する（書き出しの visual_filters の前半と同じ順）：反転 → 波・渦巻き →（3D 回転があれば）クリッピング解除 → 3D 回転。
 * t はアイテムの頭からの秒、k は画面の 1px が画像の何 px か。3D 回転でクリッピング解除を済ませたときは、返す見た目から外す
 */
export function itemSource(
  img: CanvasImageSource,
  size: [number, number],
  look: Look | undefined | null,
  st: VisualState,
  t: number,
  k: number,
  fps = 30,
): {img: CanvasImageSource; size: [number, number]; st: VisualState} {
  let src = img;
  if (look?.flipX || look?.flipY) {
    const iw = (img as HTMLVideoElement).videoWidth || (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width;
    const ih = (img as HTMLVideoElement).videoHeight || (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height;
    if (iw && ih) {
      const cv = document.createElement('canvas');
      cv.width = iw;
      cv.height = ih;
      const x = cv.getContext('2d')!;
      x.translate(look.flipX ? iw : 0, look.flipY ? ih : 0);
      x.scale(look.flipX ? -1 : 1, look.flipY ? -1 : 1);
      x.drawImage(img, 0, 0);
      src = cv;
    }
  }
  const ef = effectsSource(src, size, look?.effects, t, k, fps);
  src = ef.img;
  size = ef.size;
  if (!st.rot3d) return {img: src, size, st};
  if (st.wipe) {
    // 傾ける前に隠す（書き出しと同じ）
    const iw = (src as HTMLVideoElement).videoWidth || (src as HTMLImageElement).naturalWidth || (src as HTMLCanvasElement).width;
    const ih = (src as HTMLVideoElement).videoHeight || (src as HTMLImageElement).naturalHeight || (src as HTMLCanvasElement).height;
    const cv = document.createElement('canvas');
    cv.width = iw;
    cv.height = ih;
    const x = cv.getContext('2d')!;
    const [l, tp, r, b] = st.wipe;
    x.rect(iw * l, ih * tp, Math.max(0, iw * (1 - l - r)), Math.max(0, ih * (1 - tp - b)));
    x.clip();
    x.drawImage(src, 0, 0);
    src = cv;
  }
  if (st.iris !== undefined) {
    const iw = (src as HTMLCanvasElement).width || (src as HTMLImageElement).naturalWidth || (src as HTMLVideoElement).videoWidth;
    const ih = (src as HTMLCanvasElement).height || (src as HTMLImageElement).naturalHeight || (src as HTMLVideoElement).videoHeight;
    const cv = document.createElement('canvas');
    cv.width = iw;
    cv.height = ih;
    const x = cv.getContext('2d')!;
    x.arc(iw / 2, ih / 2, (Math.hypot(iw, ih) / 2) * st.iris, 0, Math.PI * 2);
    x.clip();
    x.drawImage(src, 0, 0);
    src = cv;
  }
  const tl = tilt3d(src, size, st.rot3d);
  return {img: tl.img, size: tl.size, st: {...st, wipe: undefined, iris: undefined}};
}

/**
 * 波・渦巻き（書き出しの distort_geq と同じ式）。画像を描き直したものを返す（無ければそのまま）。
 * k は画面の 1px が画像の何 px か、t は秒（アイテムは頭から、立ち絵は動画の頭から）
 */
export function distort(img: CanvasImageSource, size: [number, number], effects: Effect[] | undefined, t: number, k: number): CanvasImageSource {
  const list = (effects ?? []).filter(e => (e.kind === 'wave' && e.amount && e.length > 0) || (e.kind === 'swirl' && e.angle));
  if (!list.length) return img;
  let src = img;
  let [w, h] = size;
  for (const fx of list) {
    const cv = document.createElement('canvas');
    if (fx.kind === 'wave') {
      cv.width = w;
      cv.height = h;
      const x = cv.getContext('2d')!;
      const step = Math.max(1, Math.round(h / 720));
      for (let y = 0; y < h; y += step) {
        const d = fx.amount * k * Math.sin(2 * Math.PI * ((y + step / 2) / (fx.length * k) + fx.speed * t));
        x.drawImage(src, 0, y, w, step, d, y, w, step);
      }
    } else if (fx.kind === 'swirl') {
      // 画素ごとに読む場所を回す（プレビューでは小さめにして計算する）
      const r = Math.min(1, 480 / Math.max(w, h));
      const sw = Math.max(1, Math.round(w * r));
      const shh = Math.max(1, Math.round(h * r));
      const tmp = document.createElement('canvas');
      tmp.width = sw;
      tmp.height = shh;
      const tx = tmp.getContext('2d', {willReadFrequently: true})!;
      tx.drawImage(src, 0, 0, sw, shh);
      let data: ImageData;
      try {
        data = tx.getImageData(0, 0, sw, shh);
      } catch {
        return img; // 読めない画像（別のオリジンの動画など）はそのまま
      }
      const outD = tx.createImageData(sw, shh);
      const a0 = (fx.angle * Math.PI) / 180;
      const cx = sw / 2;
      const cy = shh / 2;
      const R = Math.min(sw, shh) / 2;
      for (let Y = 0; Y < shh; Y++)
        for (let X = 0; X < sw; X++) {
          const dx = X - cx;
          const dy = Y - cy;
          const a = a0 * Math.max(0, 1 - Math.hypot(dx, dy) / R) ** 2;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const sx = Math.min(sw - 1, Math.max(0, Math.round(cx + dx * ca + dy * sa)));
          const sy = Math.min(shh - 1, Math.max(0, Math.round(cy - dx * sa + dy * ca)));
          const o = (Y * sw + X) * 4;
          const i = (sy * sw + sx) * 4;
          outD.data[o] = data.data[i];
          outD.data[o + 1] = data.data[i + 1];
          outD.data[o + 2] = data.data[i + 2];
          outD.data[o + 3] = data.data[i + 3];
        }
      cv.width = sw;
      cv.height = shh;
      cv.getContext('2d')!.putImageData(outD, 0, 0);
      w = sw;
      h = shh;
      k *= r;
    }
    src = cv;
  }
  return src;
}

// ───────────── 切り抜き・色を抜く・形で切り抜く（書き出しの render.rs の spatial_filters と同じ） ─────────────

const maskCache = new Map<string, HTMLCanvasElement>();
/** 形の切り抜きの不透明度を描いた画像（長い辺 512px まで。引き伸ばして使う） */
function maskImage(m: NonNullable<MediaClip['mask']>, W: number, H: number): HTMLCanvasElement {
  const k = Math.min(1, 512 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const key = JSON.stringify([m, w, h]);
  let cv = maskCache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const x = cv.getContext('2d')!;
  const d = x.createImageData(w, h);
  for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) d.data[(Y * w + X) * 4 + 3] = Math.round(255 * maskAlpha(m, X + 0.5, Y + 0.5, w, h));
  x.putImageData(d, 0, 0);
  if (maskCache.size > 40) maskCache.delete(maskCache.keys().next().value!);
  maskCache.set(key, cv);
  return cv;
}

/** SVG フィルターを 1 つ用意して、Canvas の filter に渡す url() を返す（同じ id なら作り直さない） */
function svgFilter(id: string, body: string): string {
  if (!document.getElementById(id)) {
    let svg = document.getElementById('vx-filters') as SVGSVGElement | null;
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'vx-filters';
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      document.body.appendChild(svg);
    }
    svg.insertAdjacentHTML('beforeend', `<filter id="${id}" color-interpolation-filters="sRGB">${body}</filter>`);
  }
  return `url(#${id})`;
}

/** フィルター・色温度の SVG フィルター（書き出しの colorchannelmixer → lutrgb と同じ数） */
export function gradeFilter(fx: Effect): string | null {
  const cg = colorGrade(fx);
  if (!cg) return null;
  const {m, g} = cg;
  const id = `vx-grade-${[...m, ...g.flat()]
    .map(v => v.toFixed(4))
    .join('_')
    .replace(/\./g, 'p')
    .replace(/-/g, 'm')}`;
  const fn = (t: string, [a, e, o]: number[]) => `<feFunc${t} type="gamma" amplitude="${a}" exponent="${e}" offset="${o}"/>`;
  return svgFilter(
    id,
    `<feColorMatrix type="matrix" values="${m[0]} ${m[1]} ${m[2]} 0 0  ${m[3]} ${m[4]} ${m[5]} 0 0  ${m[6]} ${m[7]} ${m[8]} 0 0  0 0 0 1 0"/><feComponentTransfer>${fn('R', g[0])}${fn('G', g[1])}${fn('B', g[2])}</feComponentTransfer>`,
  );
}

const lutFits = new Map<string, LutFit | 'loading' | 'error'>();
const lutWaiters = new Set<() => void>();
/** LUT を読み終えたら呼ぶ（プレビューを描き直す） */
export function onLutReady(f: () => void): () => void {
  lutWaiters.add(f);
  return () => void lutWaiters.delete(f);
}

/**
 * LUT の SVG フィルター（近い形：行列 → 色ごとの曲線 → 強さの分だけ元と混ぜる）。読み終わるまでは null
 * 書き出しは ffmpeg の lut3d で .cube のとおりに変える
 */
export function lutFilter(path: string, strength: number): string | null {
  const k = Math.max(0, Math.min(1, strength));
  if (!path || k <= 0) return null;
  const fit = lutFits.get(path);
  if (!fit) {
    lutFits.set(path, 'loading');
    void api
      .then(a => a.lutFit(path))
      .then(
        f => lutFits.set(path, f),
        () => lutFits.set(path, 'error'),
      )
      .then(() => lutWaiters.forEach(w => w()));
    return null;
  }
  if (fit === 'loading' || fit === 'error') return null;
  const m = fit.matrix;
  const id = `vx-lut-${[...m, ...fit.tables.flat(), k]
    .map(v => v.toFixed(4))
    .join('_')
    .replace(/\./g, 'p')
    .replace(/-/g, 'm')}`;
  const fn = (t: string, tb: number[]) => `<feFunc${t} type="table" tableValues="${tb.map(v => v.toFixed(4)).join(' ')}"/>`;
  return svgFilter(
    id,
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${m[0]} ${m[1]} ${m[2]} 0 ${m[3]}  ${m[4]} ${m[5]} ${m[6]} 0 ${m[7]}  ${m[8]} ${m[9]} ${m[10]} 0 ${m[11]}  0 0 0 1 0" result="m"/>` +
      `<feComponentTransfer in="m" result="c">${fn('R', fit.tables[0])}${fn('G', fit.tables[1])}${fn('B', fit.tables[2])}</feComponentTransfer>` +
      (k < 0.999 ? `<feComposite in="c" in2="SourceGraphic" operator="arithmetic" k1="0" k2="${k}" k3="${1 - k}" k4="0"/>` : ''),
  );
}

/** 色を抜く SVG フィルター（Canvas の filter に url() で渡す。画素を読み出さないので、別のオリジンの動画にも使える） */
function chromaFilter(c: NonNullable<MediaClip['chroma']>): string | null {
  const wts = chromaWeights(c.color);
  if (!wts) return null;
  const hi = 1 - Math.min(1, Math.max(0, c.similarity));
  const b = Math.min(1, Math.max(0.01, c.blend));
  const id = `vx-chroma-${[...wts, hi, b]
    .map(v => v.toFixed(4))
    .join('_')
    .replace(/\./g, 'p')
    .replace(/-/g, 'm')}`;
  const [wr, wg, wb] = wts.map(v => -v / b);
  return svgFilter(
    id,
    `<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${wr} ${wg} ${wb} 0 ${hi / b}" result="k"/><feComposite in="SourceGraphic" in2="k" operator="in"/>`,
  );
}

const viewCache = new Map<string, HTMLCanvasElement>();
/**
 * 素材を切り抜き・色抜き・形の切り抜きをした画像にする。size は元の素材の大きさ（プロキシの動画でも元の大きさ）。
 * 返す大きさは切り抜いた後の元の大きさ。still（画像）なら結果を使い回す
 */
export function sourceView(img: CanvasImageSource, size: [number, number], m: MediaClip, still: boolean, key = '', matte?: CanvasImageSource | null): {img: CanvasImageSource; size: [number, number]} {
  if (!m.crop && !m.mask && !m.chroma && !matte) return {img, size};
  const [l, t, kw, kh] = cropKeep(m.crop);
  const out: [number, number] = [size[0] * kw, size[1] * kh];
  const iw = (img as HTMLVideoElement).videoWidth || (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width;
  const ih = (img as HTMLVideoElement).videoHeight || (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height;
  if (!iw || !ih) return {img, size};
  const mk = matte ? ((matte as HTMLImageElement).src ?? 'v') : '';
  const ck = still ? JSON.stringify([key, iw, ih, m.crop, m.mask, m.chroma, mk]) : '';
  const hit = ck && viewCache.get(ck);
  if (hit) return {img: hit, size: out};
  const cw = Math.max(1, Math.round(iw * kw));
  const ch = Math.max(1, Math.round(ih * kh));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const x = cv.getContext('2d')!;
  const f = m.chroma ? chromaFilter(m.chroma) : null;
  if (f) x.filter = f;
  x.drawImage(img, iw * l, ih * t, cw, ch, 0, 0, cw, ch);
  x.filter = 'none';
  if (matte) {
    // 背景を消す型（白が残すところ。書き出しと同じく切り抜く前の素材に合わせて伸ばし、明るさを不透明度にする）
    const mw = (matte as HTMLVideoElement).videoWidth || (matte as HTMLImageElement).naturalWidth || (matte as HTMLCanvasElement).width;
    const mh = (matte as HTMLVideoElement).videoHeight || (matte as HTMLImageElement).naturalHeight || (matte as HTMLCanvasElement).height;
    if (mw && mh) {
      x.globalCompositeOperation = 'destination-in';
      x.filter = svgFilter('vx-luma', '<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1 0 0 0 0"/>');
      x.drawImage(matte, mw * l, mh * t, mw * kw, mh * kh, 0, 0, cw, ch);
      x.filter = 'none';
      x.globalCompositeOperation = 'source-over';
    }
  }
  if (m.mask) {
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(maskImage(m.mask, cw, ch), 0, 0, cw, ch);
    x.globalCompositeOperation = 'source-over';
  }
  if (ck) {
    if (viewCache.size > 30) viewCache.delete(viewCache.keys().next().value!);
    viewCache.set(ck, cv);
  }
  return {img: cv, size: out};
}

/**
 * 背景をぼかして埋める（書き出しと同じく、画面いっぱいに広げて切り取り、ぼかす）。
 * 端が薄くならないよう、少し大きめに描いてからぼかす
 */
export function drawFillBlur(ctx: CanvasRenderingContext2D, img: CanvasImageSource, size: [number, number], w: number, h: number, viewScale: number, blur: number) {
  // ぼかしの外側が透明にならないよう、ぼかしの幅の分だけはみ出して描く（書き出しの gblur は端の色を延ばす）
  const pad = Math.max(0, blur) * viewScale * 3;
  const k = Math.max((w + pad * 2) / size[0], (h + pad * 2) / size[1]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.filter = `blur(${Math.max(0, blur) * viewScale}px)`;
  ctx.drawImage(img, (w - size[0] * k) / 2, (h - size[1] * k) / 2, size[0] * k, size[1] * k);
  ctx.restore();
}

/** 回転した画像が収まる四角（書き出しの rotate の ow=oh=hypot(iw,ih) と同じ大きさ） */
export function rotatedBox(w: number, h: number, rotation: number): [number, number] {
  if (!rotation) return [w, h];
  const d = Math.hypot(w, h);
  return [d, d];
}

/**
 * 1 つのアイテムを描く。size は元の画像の大きさ、viewScale はプレビューの縮尺。
 * 置き方は書き出しと同じ（中心から transform.x・y ずらす。回転で広がった四角の中心が基準）
 */
export function drawVisual(ctx: CanvasRenderingContext2D, img: CanvasImageSource, size: [number, number], st: VisualState, w: number, h: number, viewScale: number) {
  const [bw, bh] = rotatedBox(size[0], size[1], st.rotation);
  const s = st.transform.scale * viewScale;
  const cx = w / 2 + st.transform.x * viewScale;
  const cy = h / 2 + st.transform.y * viewScale;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, st.alpha));
  if (st.blend) ctx.globalCompositeOperation = BLEND_CANVAS[st.blend];
  const f = [st.filter, st.blur > 0 ? `blur(${st.blur * viewScale}px)` : ''].filter(Boolean).join(' ');
  if (f) ctx.filter = f;
  ctx.translate(cx, cy);
  // 縦横の倍率は回したあと（書き出しと同じ順）
  if (st.stretch) ctx.scale(st.stretch[0], st.stretch[1]);
  if (st.rotation) ctx.rotate((st.rotation * Math.PI) / 180);
  if (st.wipe) {
    // クリッピング解除：見えるところだけ（回す前の向きで）
    const [l, t, r, b] = st.wipe;
    const W = size[0] * s;
    const H = size[1] * s;
    ctx.beginPath();
    ctx.rect(-W / 2 + W * l, -H / 2 + H * t, Math.max(0, W * (1 - l - r)), Math.max(0, H * (1 - t - b)));
    ctx.clip();
  }
  if (st.iris !== undefined) {
    // 円形：真ん中から、対角線の半分 × iris の丸の中だけ（書き出しと同じ）
    const W = size[0] * s;
    const H = size[1] * s;
    ctx.beginPath();
    ctx.arc(0, 0, (Math.hypot(W, H) / 2) * st.iris, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.drawImage(img, (-size[0] * s) / 2, (-size[1] * s) / 2, size[0] * s, size[1] * s);
  ctx.restore();
  const [kx, ky] = st.stretch ?? [1, 1];
  return {x: cx - (bw * s * kx) / 2, y: cy - (bh * s * ky) / 2, w: bw * s * kx, h: bh * s * ky};
}

/**
 * モザイク・ぼかし範囲：図形の形（img の不透明なところ）の中だけ、それまでに描いた絵をモザイク・ぼかしにする。
 * 書き出しと同じく、モザイクのマスは画面の左上からそろえる。図形の色は使わない
 */
export function drawRegion(ctx: CanvasRenderingContext2D, img: CanvasImageSource, size: [number, number], st: VisualState, w: number, h: number, viewScale: number, region: Region) {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const tr = ctx.getTransform();
  const dev = tr.a || 1;
  const mk = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    return [c, c.getContext('2d')!];
  };
  // 形
  const [m, mx] = mk();
  mx.setTransform(tr);
  const rect = drawVisual(mx, img, size, {...st, blend: null}, w, h, viewScale);
  // 加工した絵
  const [f, fx] = mk();
  const k = Math.max(0.5, region.strength * viewScale * dev);
  if (region.kind === 'mosaic') {
    const sw = Math.max(1, Math.ceil(cw / k));
    const sh = Math.max(1, Math.ceil(ch / k));
    const sm = document.createElement('canvas');
    sm.width = sw;
    sm.height = sh;
    const sx = sm.getContext('2d')!;
    sx.imageSmoothingQuality = 'high';
    sx.drawImage(ctx.canvas, 0, 0, sw * k, sh * k, 0, 0, sw, sh);
    fx.imageSmoothingEnabled = false;
    fx.drawImage(sm, 0, 0, sw * k, sh * k);
  } else {
    fx.filter = `blur(${k}px)`;
    fx.drawImage(ctx.canvas, 0, 0);
    fx.filter = 'none';
  }
  fx.globalCompositeOperation = 'destination-in';
  fx.drawImage(m, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(f, 0, 0);
  ctx.restore();
  return rect;
}

// ───────────── テキストと図形の画像 ─────────────

const cache = new Map<string, HTMLCanvasElement>();
const CACHE_LIMIT = 200;

/** 描いた結果を、中身が同じなら使い回す */
function cached(key: string, draw: () => HTMLCanvasElement): HTMLCanvasElement {
  let c = cache.get(key);
  if (!c) {
    c = draw();
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, c);
  }
  return c;
}

/** 字幕の「個別に設定」だけにある文字の組み方と飾り（テキストアイテムでは使わない） */
export interface TextExtra {
  lineHeight?: number;
  letterSpacing?: number;
  wrapWidth?: number;
  vertical?: boolean;
  shadowColor?: string;
  shadowOffset?: number;
  boxColor?: string;
  boxPadding?: number;
  /** 出す文字の数（1 文字ずつ出すとき）。undefined なら全部 */
  visible?: number;
  /** テキストの 1 文字ずつの登場で、アイテムの頭からのフレーム（charAnim があるとき） */
  charFrame?: number;
}

/** 縦書きで右上に寄せる句読点 */
const PUNCT_V = new Set([...'、。，．']);
/** 縦書きで横に倒して描く文字（伸ばし棒・括弧など） */
const ROTATE_V = new Set([...'ー－―〜～…‥（）「」『』【】〔〕()[]{}<>＜＞-=＝']);

/** 1 文字ずつ出すときに数える文字の数（改行は数えない） */
export const textCharCount = (text: string) => Array.from(rubyBase(text).replace(/\n/g, '')).length;

/** 文字の画像が同じになるかを決める値（書き出しの画像の名前にも使う） */
export const textKey = (c: TextClip) => [
  't',
  c.text,
  c.fontFamily,
  c.fontSize,
  c.color,
  c.outlineColor,
  c.outlineWidth,
  c.bold,
  c.italic,
  c.align,
  c.shadowColor ?? '',
  c.shadowBlur ?? 0,
  c.shadowX ?? 0,
  c.shadowY ?? 0,
  c.outline2Color ?? '',
  c.outline2Width ?? 0,
  c.boxColor ?? '',
  c.boxOpacity ?? 1,
  c.boxPadding ?? 0,
  c.boxRadius ?? 0,
  c.gradientColor ?? '',
  c.vertical ?? false,
  c.charAnim ?? null,
  c.bubble ?? null,
];

/** テキストアイテムの画像（大きさは文字に合わせる。縁取りの分だけ余白を足す）。字幕の「個別に設定」では組み方と飾りも */
export function textImage(c: TextClip, ex: TextExtra = {}): HTMLCanvasElement {
  // 吹き出し：文字の絵を作ってから、まわりに枠としっぽを描く
  if (c.bubble) {
    const b = c.bubble;
    return cached(JSON.stringify(['bubble', ...textKey(c), ex]), () => bubbleImage(textImage({...c, bubble: null}, ex), b));
  }
  // テキストアイテムの縦書き・1 文字ずつの登場（出きったあとは同じ画像）
  if (c.vertical) ex = {...ex, vertical: true};
  const ca = c.charAnim ?? null;
  if (ca) ex = {...ex, charFrame: Math.min(Math.max(0, Math.floor(ex.charFrame ?? 1e9)), charAnimFrames(ca, textCharCount(c.text)))};
  else if (ex.charFrame !== undefined) ex = {...ex, charFrame: undefined};
  const key = JSON.stringify([...textKey(c), ex]);
  return cached(key, () => {
    const font = `${c.italic ? 'italic ' : ''}${c.bold ? 'bold ' : ''}${c.fontSize}px "${c.fontFamily}", "Yu Gothic UI", sans-serif`;
    const ls = ex.letterSpacing ?? 0;
    const m = document.createElement('canvas').getContext('2d')!;
    m.font = font;
    m.letterSpacing = `${ls}px`;
    const lineH = Math.max(1, Math.round(c.fontSize * (ex.lineHeight ?? 1.3)));
    const charStep = c.fontSize + ls; // 縦書きの 1 文字の高さ
    // 折り返し（文字単位。縦書きでは列の高さ）
    const wrap = ex.wrapWidth ?? 0;
    const lines: string[] = [];
    // ルビは書き方を外した文の上（縦書きは右）に小さく出す
    const segs = parseRuby(c.text || ' ');
    const ruby = hasRuby(segs);
    for (const para of (ruby ? rubyBase(c.text) : c.text || ' ').split('\n')) {
      if (wrap <= 0) {
        lines.push(para);
        continue;
      }
      let cur = '';
      for (const ch of Array.from(para)) {
        const next = cur + ch;
        const len = ex.vertical ? Array.from(next).length * charStep : m.measureText(next).width;
        if (cur && len > wrap) {
          lines.push(cur);
          cur = ch;
        } else cur = next;
      }
      lines.push(cur);
    }
    if (ruby && wrap > 0) lines.splice(0, lines.length, ...keepRubyWords(segs, lines.join('\n')).split('\n'));
    const rows = ruby ? rubyRows(segs, lines.join('\n')) : null;
    const rs = Math.max(1, Math.round(c.fontSize * 0.5));
    const rk = rs / c.fontSize;
    // ルビのある行だけ、ルビの分だけ広げる（off は行の頭までの距離）
    const rhOf = lines.map((_, i) => (rows?.[i]?.some(pc => pc.ruby !== undefined) ? Math.round(rs * 1.25) : 0));
    const off = rhOf.map((_, i) => rhOf.slice(0, i).reduce((a, r) => a + lineH + r, 0));
    const extraAll = rhOf.reduce((a, r) => a + r, 0);
    // テキストアイテムの飾り（字幕の「個別に設定」の飾りとは別）
    const o2 = c.outline2Color && (c.outline2Width ?? 0) > 0 ? c.outline2Width! : 0;
    const shadowOn = !!c.shadowColor && ((c.shadowBlur ?? 0) > 0 || (c.shadowX ?? 0) !== 0 || (c.shadowY ?? 0) !== 0);
    // 影と光は四方に同じだけ余白を取る（文字の中心がずれないように）
    const glow = shadowOn ? Math.ceil((c.shadowBlur ?? 0) * 2 + Math.max(Math.abs(c.shadowX ?? 0), Math.abs(c.shadowY ?? 0))) : 0;
    // はねる・下からは文字が枠の外へ出るので、四方に余白を足す（真ん中の位置は変えない）
    const caPad = ca && (ca.kind === 'pop' || ca.kind === 'slideUp') ? Math.ceil(c.fontSize * 0.6) : 0;
    const pad = Math.ceil(c.outlineWidth + o2 + c.fontSize * 0.1) + caPad;
    const boxColor = ex.boxColor ?? (c.boxColor || undefined);
    const box = boxColor ? Math.max(0, ex.boxColor ? (ex.boxPadding ?? 16) : (c.boxPadding ?? 16)) : 0;
    const sh = ex.shadowColor ? Math.abs(ex.shadowOffset ?? 4) : 0;
    const widths = lines.map(l => m.measureText(l).width);
    const longest = Math.max(1, ...lines.map(l => Array.from(l).length));
    // 文字が占める大きさ
    const tw = ex.vertical ? lineH * lines.length + extraAll : Math.ceil(Math.max(...widths));
    const th = ex.vertical ? Math.ceil(longest * charStep) : lineH * lines.length + extraAll;
    const edge = pad + box;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, tw + edge * 2 + sh + glow * 2);
    cv.height = Math.max(1, th + edge * 2 + sh + glow * 2);
    const x = cv.getContext('2d')!;
    x.translate(glow, glow);
    if (box) {
      x.save();
      x.fillStyle = boxColor!;
      if (!ex.boxColor) x.globalAlpha = Math.max(0, Math.min(1, c.boxOpacity ?? 1));
      x.beginPath();
      x.roundRect(pad, pad, tw + box * 2 + sh, th + box * 2 + sh, ex.boxColor ? Math.min(box, c.fontSize * 0.3) : Math.max(0, c.boxRadius ?? Math.min(box, c.fontSize * 0.3)));
      x.fill();
      x.restore();
    }
    x.font = font;
    x.letterSpacing = `${ls}px`;
    x.textBaseline = 'middle';
    x.lineJoin = 'round';
    x.miterLimit = 2;
    // 出す文字の位置（1 文字ずつ出すときも位置は全部出したときと同じ）
    let left = ex.visible ?? Infinity;
    // k はルビの縮め（文字の大きさの比）、sx は横の縮め
    // ci は何文字目か（1 文字ずつの登場に使う）
    const glyphs: {s: string; px: number; py: number; rot: boolean; punct?: boolean; k?: number; sx?: number; ci?: number}[] = [];
    let ci0 = 0;
    const shownAll = ex.visible ?? Infinity;
    lines.forEach((l, i) => {
      const chars = Array.from(l);
      const base = ci0;
      ci0 += chars.length;
      const n = Math.max(0, Math.min(chars.length, left));
      left -= chars.length;
      if (!n) return;
      const pieces = rows?.[i] ?? [];
      const at0 = pieces[0]?.at ?? 0;
      if (ex.vertical) {
        // 右の列から左へ。揃えは列の中の上・中央・下。ルビは列の右
        const rh = rhOf[i];
        const colX = edge + tw - off[i] - rh - lineH / 2;
        const colH = chars.length * charStep;
        const y0 = edge + (c.align === 'left' ? 0 : c.align === 'right' ? th - colH : (th - colH) / 2);
        for (let k = 0; k < n; k++) glyphs.push({s: chars[k], px: colX, py: y0 + charStep * k + charStep / 2, rot: ROTATE_V.has(chars[k]), punct: PUNCT_V.has(chars[k]), ci: base + k});
        for (const pc of pieces) {
          if (!pc.ruby || pc.at >= shownAll) continue;
          const rc = Array.from(pc.ruby);
          const span = Array.from(pc.text).length * charStep;
          const step = Math.min(rs + ls * rk, span / rc.length);
          const top = y0 + (pc.at - at0) * charStep + (span - step * rc.length) / 2;
          rc.forEach((r, k) => glyphs.push({s: r, px: colX + lineH / 2 + rh / 2, py: top + step * k + step / 2, rot: ROTATE_V.has(r), k: rk, ci: base + pc.at - at0}));
        }
      } else {
        const lx = edge + (c.align === 'left' ? 0 : c.align === 'right' ? tw - widths[i] : (tw - widths[i]) / 2);
        const rh = rhOf[i];
        const py = edge + off[i] + rh + lineH / 2;
        // 1 文字ずつ出すときは文字ごとに置く（位置は行をまとめて描いたときと同じ）
        if (ca) for (let k = 0; k < n; k++) glyphs.push({s: chars[k], px: lx + m.measureText(chars.slice(0, k).join('')).width, py, rot: false, ci: base + k});
        else glyphs.push({s: chars.slice(0, n).join(''), px: lx, py, rot: false});
        let x0 = lx;
        for (const pc of pieces) {
          const wb = m.measureText(pc.text).width;
          if (pc.ruby && pc.at < shownAll) {
            const wr = m.measureText(pc.ruby).width * rk;
            glyphs.push({s: pc.ruby, px: wr <= wb ? x0 + (wb - wr) / 2 : x0, py: py - lineH / 2 - rh / 2, rot: false, k: rk, sx: wr <= wb ? 1 : wb / wr, ci: base + pc.at - at0});
          }
          x0 += wb;
        }
      }
    });
    const outline = c.outlineWidth > 0 && c.outlineColor ? c.outlineWidth : 0;
    const paint = (dx: number, dy: number, fill: string, stroke: boolean, all = false) => {
      for (const g of glyphs) {
        // 1 文字ずつの登場（まだ出ていない文字は描かない）
        const pr = ca && g.ci !== undefined ? charProgress(ca, g.ci, ex.charFrame ?? 0) : 1;
        if (pr <= 0) continue;
        x.save();
        // 縦書きの句読点は、横書きの字形（左下）を升目の右上へ
        x.translate(g.px + dx + (g.punct ? c.fontSize * 0.6 : 0), g.py + dy - (g.punct ? c.fontSize * 0.6 : 0));
        if (ca && pr < 1) {
          x.globalAlpha *= pr;
          if (ca.kind === 'slideUp') x.translate(0, (1 - pr) * c.fontSize * 0.6);
          if (ca.kind === 'pop') {
            // はねる：少し大きくなってから戻る（文字の真ん中を中心に）
            const q = pr - 1;
            const k = 0.4 + 0.6 * (1 + 2.70158 * q * q * q + 1.70158 * q * q);
            const cw = ex.vertical ? 0 : x.measureText(g.s).width / 2;
            x.translate(cw, 0);
            x.scale(k, k);
            x.translate(-cw, 0);
          }
        }
        if (g.k) x.scale(g.k * (g.sx ?? 1), g.k);
        if (g.rot) x.rotate(Math.PI / 2);
        x.textAlign = ex.vertical ? 'center' : 'left';
        // 影・光は、縁まで含めた形で落とす
        if (all && outline + o2 > 0) {
          x.strokeStyle = fill;
          x.lineWidth = (outline + o2) * 2;
          x.strokeText(g.s, 0, 0);
        }
        if (stroke && o2) {
          x.strokeStyle = c.outline2Color!;
          x.lineWidth = (outline + o2) * 2;
          x.strokeText(g.s, 0, 0);
        }
        if (stroke && outline) {
          x.strokeStyle = c.outlineColor;
          x.lineWidth = outline * 2;
          x.strokeText(g.s, 0, 0);
        }
        if (stroke && c.gradientColor) {
          // 1 行ごとに、上は文字の色・下はグラデーションの色
          const gr = x.createLinearGradient(0, -c.fontSize / 2, 0, c.fontSize / 2);
          gr.addColorStop(0, c.color);
          gr.addColorStop(1, c.gradientColor);
          x.fillStyle = gr;
        } else x.fillStyle = fill;
        x.fillText(g.s, 0, 0);
        x.restore();
      }
    };
    if (sh) paint(ex.shadowOffset ?? 4, ex.shadowOffset ?? 4, ex.shadowColor!, false);
    if (shadowOn) {
      x.save();
      if ((c.shadowBlur ?? 0) > 0) x.filter = `blur(${c.shadowBlur}px)`;
      paint(c.shadowX ?? 0, c.shadowY ?? 0, c.shadowColor!, false, true);
      // 光（ずらさない影）は 2 回重ねて濃くする
      if ((c.shadowBlur ?? 0) > 0 && !(c.shadowX ?? 0) && !(c.shadowY ?? 0)) paint(0, 0, c.shadowColor!, false, true);
      x.restore();
    }
    paint(0, 0, c.color, true);
    return cv;
  });
}

/** スタンプの形（この中の数はどれも、このアプリで決めたもの） */
function stickerPath(x: CanvasRenderingContext2D, kind: string, W: number, H: number) {
  const m = Math.min(W, H);
  if (kind === 'heart') {
    x.moveTo(W / 2, H * 0.95);
    x.bezierCurveTo(-W * 0.12, H * 0.48, W * 0.1, -H * 0.08, W / 2, H * 0.26);
    x.bezierCurveTo(W * 0.9, -H * 0.08, W * 1.12, H * 0.48, W / 2, H * 0.95);
    x.closePath();
  } else if (kind === 'arrow') {
    x.moveTo(0, H * 0.34);
    x.lineTo(W * 0.58, H * 0.34);
    x.lineTo(W * 0.58, 0);
    x.lineTo(W, H / 2);
    x.lineTo(W * 0.58, H);
    x.lineTo(W * 0.58, H * 0.66);
    x.lineTo(0, H * 0.66);
    x.closePath();
  } else if (kind === 'bubble') {
    x.roundRect(0, 0, W, H * 0.78, m * 0.2);
    // しっぽは本体と同じ向き（時計回り）に描く（逆だと重なりが抜ける）
    x.moveTo(W * 0.44, H * 0.7);
    x.lineTo(W * 0.14, H);
    x.lineTo(W * 0.24, H * 0.7);
    x.closePath();
  } else if (kind === 'thought') {
    x.ellipse(W / 2, H * 0.38, W / 2, H * 0.38, 0, 0, Math.PI * 2);
    x.moveTo(W * 0.27 + m * 0.08, H * 0.84);
    x.ellipse(W * 0.27, H * 0.84, m * 0.08, m * 0.08, 0, 0, Math.PI * 2);
    x.moveTo(W * 0.13 + m * 0.045, H * 0.96);
    x.ellipse(W * 0.13, H * 0.96, m * 0.045, m * 0.045, 0, 0, Math.PI * 2);
  } else if (kind === 'sparkle') {
    x.moveTo(W / 2, 0);
    x.quadraticCurveTo(W * 0.56, H * 0.44, W, H / 2);
    x.quadraticCurveTo(W * 0.56, H * 0.56, W / 2, H);
    x.quadraticCurveTo(W * 0.44, H * 0.56, 0, H / 2);
    x.quadraticCurveTo(W * 0.44, H * 0.44, W / 2, 0);
    x.closePath();
  } else if (kind === 'sweat') {
    x.moveTo(W / 2, 0);
    x.bezierCurveTo(W * 0.62, H * 0.3, W * 1.05, H * 0.55, W * 0.95, H * 0.75);
    x.bezierCurveTo(W * 0.85, H * 1.02, W * 0.15, H * 1.02, W * 0.05, H * 0.75);
    x.bezierCurveTo(-W * 0.05, H * 0.55, W * 0.38, H * 0.3, W / 2, 0);
    x.closePath();
  } else if (kind === 'anger') {
    // 四つの角に、内側へ曲がる線
    const cx = W / 2;
    const cy = H / 2;
    const g = m * 0.1;
    const r = m * 0.42;
    for (const [sx, sy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      x.moveTo(cx + sx * g, cy + sy * r);
      x.quadraticCurveTo(cx + sx * g * 1.2, cy + sy * g * 1.2, cx + sx * r, cy + sy * g);
    }
  } else if (kind === 'exclaim') {
    x.roundRect(W * 0.3, 0, W * 0.4, H * 0.66, W * 0.2);
    x.moveTo(W / 2 + W * 0.21, H * 0.87);
    x.ellipse(W / 2, H * 0.87, W * 0.21, H * 0.11, 0, 0, Math.PI * 2);
  } else if (kind === 'burst') {
    // ぎざぎざの爆発（とがりの長さは決まった並び）
    const k = [1, 0.62, 0.92, 0.58, 1, 0.66, 0.88, 0.6, 0.98, 0.63, 0.9, 0.57, 1, 0.64, 0.86, 0.6, 0.95, 0.62];
    k.forEach((r, i) => {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / k.length;
      const px = W / 2 + (Math.cos(a) * W * r) / 2;
      const py = H / 2 + (Math.sin(a) * H * r) / 2;
      if (i) x.lineTo(px, py);
      else x.moveTo(px, py);
    });
    x.closePath();
  } else if (kind === 'speed') {
    // 集中線：外から真ん中へ細くなる線。真ん中は空ける
    const n = 64;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ((i * 7) % 5) * 0.01;
      const w = (0.008 + ((i * 13) % 7) * 0.004) * Math.PI;
      const inner = 0.34 + ((i * 11) % 9) * 0.025;
      const R = Math.hypot(W, H);
      x.moveTo(W / 2 + Math.cos(a - w) * R, H / 2 + Math.sin(a - w) * R);
      x.lineTo(W / 2 + Math.cos(a) * (W / 2) * inner, H / 2 + Math.sin(a) * (H / 2) * inner);
      x.lineTo(W / 2 + Math.cos(a + w) * R, H / 2 + Math.sin(a + w) * R);
      x.closePath();
    }
  }
}

/** 図形アイテムの画像（線の太さの分だけ外側に余白を足す） */
export function shapeImage(c: ShapeClip): HTMLCanvasElement {
  const key = JSON.stringify(['s', c.shape, c.width, c.height, c.fill, c.stroke, c.strokeWidth]);
  return cached(key, () => {
    const sw = c.stroke ? Math.max(0, c.strokeWidth) : 0;
    const pad = Math.ceil(sw / 2) + 1;
    const W = Math.max(1, Math.round(c.width));
    const H = Math.max(1, Math.round(c.height));
    const cv = document.createElement('canvas');
    cv.width = W + pad * 2;
    cv.height = H + pad * 2;
    const x = cv.getContext('2d')!;
    x.translate(pad, pad);
    x.beginPath();
    if (c.shape === 'rect') x.rect(0, 0, W, H);
    else if (c.shape === 'roundRect') x.roundRect(0, 0, W, H, Math.min(W, H) * 0.2);
    else if (c.shape === 'ellipse') x.ellipse(W / 2, H / 2, W / 2, H / 2, 0, 0, Math.PI * 2);
    else if (c.shape === 'triangle') {
      x.moveTo(W / 2, 0);
      x.lineTo(W, H);
      x.lineTo(0, H);
      x.closePath();
    } else if (c.shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.4 : 1;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const px = W / 2 + (Math.cos(a) * W * r) / 2;
        const py = H / 2 + (Math.sin(a) * H * r) / 2 + H * 0.05;
        if (i) x.lineTo(px, py);
        else x.moveTo(px, py);
      }
      x.closePath();
    } else if (c.shape === 'line') {
      x.moveTo(0, H / 2);
      x.lineTo(W, H / 2);
    } else stickerPath(x, c.shape, W, H);
    if (c.shape === 'line') {
      x.strokeStyle = c.fill;
      x.lineWidth = Math.max(1, H);
      x.lineCap = 'round';
      x.stroke();
    } else if (c.shape === 'anger') {
      // 線だけで描くスタンプ（色は塗りの色）
      x.strokeStyle = c.fill;
      x.lineWidth = Math.min(W, H) * 0.12;
      x.lineCap = 'round';
      x.stroke();
    } else if (c.shape === 'question') {
      x.font = `900 ${Math.round(H * 0.95)}px "Arial Black", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      if (sw > 0) {
        x.strokeStyle = c.stroke;
        x.lineWidth = sw * 2;
        x.lineJoin = 'round';
        x.strokeText('?', W / 2, H * 0.54, W);
      }
      x.fillStyle = c.fill;
      x.fillText('?', W / 2, H * 0.54, W);
    } else if (c.shape === 'bubble' || c.shape === 'thought') {
      // 吹き出しは縁を先に描いてから塗る（しっぽとのつなぎ目に線が出ない）
      if (sw > 0) {
        x.strokeStyle = c.stroke;
        x.lineWidth = sw * 2;
        x.lineJoin = 'round';
        x.stroke();
      }
      x.fillStyle = c.fill;
      x.fill();
    } else {
      x.fillStyle = c.fill;
      x.fill();
      if (sw > 0) {
        x.strokeStyle = c.stroke;
        x.lineWidth = sw;
        x.lineJoin = 'round';
        x.stroke();
      }
    }
    return cv;
  });
}

/**
 * 音声の波形・スペクトラムの画像（プレビュー用の目安。level は今の音の大きさ 0〜1、t は秒）。
 * 書き出しは FFmpeg の showwaves・showfreqs で、動画の音そのものから描く
 */
export function vizImage(c: ShapeClip, level: number, t: number): HTMLCanvasElement {
  const W = Math.max(2, Math.round(c.width));
  const H = Math.max(2, Math.round(c.height));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const x = cv.getContext('2d')!;
  x.fillStyle = c.fill;
  x.strokeStyle = c.fill;
  const lv = Math.min(1, Math.max(0, level));
  if (c.viz === 'bars') {
    const n = 24;
    const bw = W / n;
    const step = Math.floor(t * 15);
    for (let i = 0; i < n; i++) {
      const hh = H * lv * (0.25 + 0.75 * hash01(i, step)) * (1 - (i / n) * 0.5);
      x.fillRect(i * bw + bw * 0.15, H - hh, bw * 0.7, hh);
    }
  } else {
    x.lineWidth = Math.max(1, H / 40);
    x.beginPath();
    for (let X = 0; X <= W; X++) {
      const u = X / W;
      const y = H / 2 + (H / 2) * lv * Math.sin(u * Math.PI) * (0.6 * Math.sin(u * 40 + t * 30) + 0.4 * Math.sin(u * 97 - t * 50));
      if (X) x.lineTo(X, y);
      else x.moveTo(X, y);
    }
    x.stroke();
  }
  return cv;
}

/** 「個別に設定」した字幕を、テキストアイテムとして描くための形にする */
export function subtitleTextClip(v: VoiceClip, sc: SubtitleCustom): TextClip {
  return {
    id: v.id,
    trackId: v.trackId,
    start: v.start,
    duration: v.duration,
    type: 'text',
    text: v.subtitle ?? v.text,
    fontFamily: sc.fontFamily,
    fontSize: sc.fontSize,
    color: sc.color,
    outlineColor: sc.outlineColor,
    outlineWidth: sc.outlineWidth,
    bold: sc.bold,
    italic: sc.italic,
    align: sc.align,
    transform: sc.transform,
    look: sc.look,
    gradientColor: sc.gradientColor || undefined,
    outline2Color: sc.outline2Color || undefined,
    outline2Width: sc.outline2Width || undefined,
  } as TextClip;
}

/** 「個別に設定」した字幕の組み方と飾り */
export const subtitleExtra = (sc: SubtitleCustom, visible?: number): TextExtra => ({
  lineHeight: sc.lineHeight,
  letterSpacing: sc.letterSpacing,
  wrapWidth: sc.wrapWidth,
  vertical: sc.vertical,
  shadowColor: sc.shadowColor,
  shadowOffset: sc.shadowOffset,
  boxColor: sc.boxColor,
  boxPadding: sc.boxPadding,
  visible,
});

/** 1 文字ずつ出すとき、その時点で出ている文字の数（local はクリップの頭からのフレーム）。書き出しの prepare_sequences と同じ */
export function visibleChars(sc: SubtitleCustom, text: string, local: number): number | undefined {
  const iv = sc.interval ?? 0;
  if (iv <= 0) return undefined;
  return Math.min(textCharCount(text), Math.floor(local / iv) + 1);
}

/** 「個別に設定」した字幕の画像 */
export function subtitleImage(v: VoiceClip, sc: SubtitleCustom, visible?: number): HTMLCanvasElement {
  return textImage(subtitleTextClip(v, sc), subtitleExtra(sc, visible));
}

/** テキスト・図形の画像（画像・動画は null）。local はアイテムの頭からのフレーム（1 文字ずつ出すテキストで使う） */
export function itemImage(c: VisualClip, local?: number, fps = 30, markers: Marker[] = []): HTMLCanvasElement | null {
  // 動く図形（粒・進行バー・グラフ）：書き出しで並べる画像と同じコマの絵
  if (c.type === 'shape' && c.anim) return animImage(c, animFrameAt(c, local ?? 0, fps), fps, markers);
  // タイマー：その時刻の数字を入れた文
  if (c.type === 'text' && c.timer) return textImage({...c, charAnim: null, text: timerText(c.timer, c.text, local ?? 0, fps)});
  if (c.type === 'text') return textImage(c, c.charAnim ? {charFrame: local ?? 1e9} : {});
  if (c.type === 'shape') return shapeImage(c);
  return null;
}

// ───────────── 書き出し用 ─────────────

function hashKey(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 書き出しに使うテキスト・図形の画像を用意する（クリップ id → PNG のパス）。
 * 中身が同じ画像は前に作ったものを使う（名前を中身から決める）
 */
export async function bakeItemImages(project: Project): Promise<Record<string, string>> {
  const {api} = await import('../ipc');
  const a = await api;
  const out: Record<string, string> = {};
  // 「個別に設定」した字幕（映像トラックのセリフはそのクリップ、分離した字幕は字幕のクリップの id で渡す）。
  // 1 文字ずつ出す字幕は、文字数ごとの画像を id#1, id#2, … で渡す（書き出しの prepare_sequences が順に並べる）
  // 画像はあとで 1 枚ずつ描く（粒などはコマ数が多く、先に全部描くと場所を取る）
  const items: {id: string; img?: HTMLCanvasElement; make?: () => HTMLCanvasElement; key: unknown}[] = [];
  const fps = project.video.fps;
  for (const c of project.clips) {
    if (c.type === 'shape' && c.anim) {
      // 動く図形：書き出しの prepare_sequences が ShapeAnim::sequence の間隔で並べる（粒はくり返す）
      const markers = project.markers ?? [];
      animFrames(c, fps).forEach((f, k) => items.push({id: `${c.id}#${k + 1}`, make: () => animImage(c, f, fps, markers, false), key: animKey(c, f, fps, markers)}));
      continue;
    }
    if (c.type === 'text' && c.timer) {
      // タイマー：表示が変わるごとの画像（id#1 = 頭。書き出しの prepare_sequences が timer.step ずつ並べる）
      const step = timerStep(c.timer, project.video.fps);
      for (let k = 0; k * step < c.duration; k++) {
        const t = {...c, charAnim: null, text: timerText(c.timer, c.text, k * step, project.video.fps)};
        items.push({id: `${c.id}#${k + 1}`, img: textImage(t), key: textKey(t)});
      }
    } else if (c.type === 'text' && c.charAnim) {
      // 1 文字ずつ出すテキスト：出きるまでのコマごとの画像（id#1 = 頭のコマ…。書き出しの prepare_sequences が 1 コマずつ並べる）
      const F = Math.min(c.duration, charAnimFrames(c.charAnim, textCharCount(c.text)));
      for (let f = 0; f <= F; f++) items.push({id: `${c.id}#${f + 1}`, img: textImage(c, {charFrame: f}), key: [...textKey(c), f]});
    } else if (c.type === 'text' || c.type === 'shape') {
      const key = c.type === 'text' ? textKey(c) : ['s', c.shape, c.width, c.height, c.fill, c.stroke, c.strokeWidth];
      items.push({id: c.id, img: itemImage(c)!, key});
    }
    const v = lineOfSubtitle(project, c);
    if (!v?.subtitleCustom || !(v.subtitle ?? v.text).trim()) continue;
    const sc = v.subtitleCustom;
    const t = subtitleTextClip(v, sc);
    const base = ['sub', t.text, t.fontFamily, t.fontSize, t.color, t.outlineColor, t.outlineWidth, t.bold, t.italic, t.align];
    if ((sc.interval ?? 0) > 0) {
      const n = textCharCount(t.text);
      for (let k = 1; k <= n; k++) items.push({id: `${c.id}#${k}`, img: subtitleImage(v, sc, k), key: [...base, subtitleExtra(sc, k)]});
    } else items.push({id: c.id, img: subtitleImage(v, sc), key: [...base, subtitleExtra(sc)]});
  }
  for (const {id, img: made, make, key} of items) {
    const name = `item-${hashKey(JSON.stringify(key))}`;
    let path = await a.portraitPngPath(name);
    if (!path) {
      const img = made ?? make!();
      const png = await new Promise<Uint8Array>((resolve, reject) =>
        img.toBlob(b => (b ? b.arrayBuffer().then(x => resolve(new Uint8Array(x)), reject) : reject(new Error('画像にできません'))), 'image/png'),
      );
      path = await a.writePortraitPng(name, png);
    }
    out[id] = path;
  }
  return out;
}
