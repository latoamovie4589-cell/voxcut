// レイヤー効果の確かめ用ページ（psd-effects-test.html）。
// 効果だけを測るため、合成は最小限（通常系の描画モード・不透明度・グループ・表示）を自前で行い、
// Photoshop が保存した合成画像と比べる。scripts/psd-effects-check.py から使う。

import {readPsd, type Layer, type Psd} from 'ag-psd';
import {renderLayerWithEffects, type EffectsEnv} from './effects';

interface Result {
  name: string;
  width: number;
  height: number;
  before: {mae: number; over8: number};
  after: {mae: number; over8: number};
  ms: number;
  /** 見本 | 効果あり | 差（4 倍） | 効果なし の PNG */
  image: string;
  /** 効果ありの結果（原寸、白の上） */
  full: string;
  /** 見本（原寸、白の上） */
  refFull: string;
}

const CANVAS_OP: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over',
  'pass through': 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

type Fn = (b: number[], s: number[]) => number[];
const sepFn =
  (f: (b: number, s: number) => number): Fn =>
  (b, s) => [f(b[0], s[0]), f(b[1], s[1]), f(b[2], s[2])];
const c01 = (v: number) => Math.min(1, Math.max(0, v));
const burn = (b: number, s: number) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const dodge = (b: number, s: number) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
/** canvas に無い描画モード（確かめ用の合成だけで使う） */
const PIXEL_BLEND: Record<string, Fn> = {
  'linear burn': sepFn((b, s) => c01(b + s - 1)),
  'linear dodge': sepFn((b, s) => c01(b + s)),
  'vivid light': sepFn((b, s) => (s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1))),
  'linear light': sepFn((b, s) => c01(b + 2 * s - 1)),
  'pin light': sepFn((b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1))),
  'hard mix': sepFn((b, s) => (b + s >= 1 ? 1 : 0)),
  subtract: sepFn((b, s) => c01(b - s)),
  divide: sepFn((b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s))),
  'darker color': (b, s) => (b[0] + b[1] + b[2] <= s[0] + s[1] + s[2] ? b : s),
  'lighter color': (b, s) => (b[0] + b[1] + b[2] >= s[0] + s[1] + s[2] ? b : s),
};

function blendPixels(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, opacity: number, f: Fn): void {
  const w = src.width;
  const h = src.height;
  const dst = ctx.getImageData(0, 0, w, h);
  const s = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  const d = dst.data;
  for (let i = 0; i < d.length; i += 4) {
    const as = (s[i + 3] / 255) * opacity;
    if (as <= 0) continue;
    const ab = d[i + 3] / 255;
    const cb = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
    const cs = [s[i] / 255, s[i + 1] / 255, s[i + 2] / 255];
    const bl = f(cb, cs);
    const ao = as + ab * (1 - as);
    for (let c = 0; c < 3; c++) d[i + c] = ((as * (1 - ab) * cs[c] + as * ab * bl[c] + (1 - as) * ab * cb[c]) / ao) * 255;
    d[i + 3] = ao * 255;
  }
  ctx.putImageData(dst, 0, 0);
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 最小限の合成。useFx が false なら効果を無視する */
function renderDoc(psd: Psd, useFx: boolean, env: EffectsEnv, timing: {ms: number}): HTMLCanvasElement {
  const W = psd.width;
  const H = psd.height;
  const draw = (layers: Layer[] | undefined, ctx: CanvasRenderingContext2D) => {
    for (const l of layers ?? []) {
      if (l.hidden) continue;
      let content: HTMLCanvasElement;
      if (l.children) {
        content = newCanvas(W, H);
        draw(l.children, content.getContext('2d')!);
      } else if (l.canvas) {
        content = newCanvas(W, H);
        const cctx = content.getContext('2d')!;
        cctx.drawImage(l.canvas, l.left ?? 0, l.top ?? 0);
        applyMask(l, content);
      } else continue;
      let out: HTMLCanvasElement | null = null;
      if (useFx) {
        const t0 = performance.now();
        out = renderLayerWithEffects(l, content, W, H, env);
        timing.ms += performance.now() - t0;
      }
      if (!out) {
        // 塗りの不透明度だけ掛ける
        const fo = l.fillOpacity ?? 1;
        if (fo < 1) {
          const c = newCanvas(W, H);
          const x = c.getContext('2d')!;
          x.globalAlpha = fo;
          x.drawImage(content, 0, 0);
          content = c;
        }
        out = content;
      }
      const bm = l.blendMode ?? 'normal';
      if (!CANVAS_OP[bm] && PIXEL_BLEND[bm]) {
        blendPixels(ctx, out, l.opacity ?? 1, PIXEL_BLEND[bm]);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = l.opacity ?? 1;
      ctx.globalCompositeOperation = CANVAS_OP[l.blendMode ?? 'normal'] ?? 'source-over';
      ctx.drawImage(out, 0, 0);
      ctx.restore();
    }
  };
  const c = newCanvas(W, H);
  draw(psd.children, c.getContext('2d')!);
  return c;
}

function applyMask(l: Layer, content: HTMLCanvasElement): void {
  const m = l.mask;
  if (!m || m.disabled || !m.canvas) return;
  const ctx = content.getContext('2d')!;
  const img = ctx.getImageData(0, 0, content.width, content.height);
  const mc = m.canvas.getContext('2d')!.getImageData(0, 0, m.canvas.width, m.canvas.height).data;
  const ml = m.left ?? 0;
  const mt = m.top ?? 0;
  const mw = m.canvas.width;
  const mh = m.canvas.height;
  const def = (m.defaultColor ?? 0) / 255;
  const d = img.data;
  for (let y = 0; y < content.height; y++) {
    for (let x = 0; x < content.width; x++) {
      const i = (y * content.width + x) * 4;
      if (!d[i + 3]) continue;
      const mx = x - ml;
      const my = y - mt;
      const v = mx >= 0 && my >= 0 && mx < mw && my < mh ? mc[(my * mw + mx) * 4] / 255 : def;
      d[i + 3] *= v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 白の上に置いた RGB */
function flatten(c: HTMLCanvasElement): Uint8ClampedArray {
  const f = newCanvas(c.width, c.height);
  const ctx = f.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, f.width, f.height);
  ctx.drawImage(c, 0, 0);
  return ctx.getImageData(0, 0, f.width, f.height).data;
}

function compare(ref: Uint8ClampedArray, got: Uint8ClampedArray): {mae: number; over8: number} {
  let sum = 0;
  let over = 0;
  const n = ref.length / 4;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const dr = Math.abs(ref[j] - got[j]);
    const dg = Math.abs(ref[j + 1] - got[j + 1]);
    const db = Math.abs(ref[j + 2] - got[j + 2]);
    sum += (dr + dg + db) / 3;
    if (Math.max(dr, dg, db) > 8) over++;
  }
  return {mae: sum / n, over8: (over / n) * 100};
}

async function loadImage(url: string): Promise<HTMLCanvasElement | null> {
  const res = await fetch(url);
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('image')) return null;
  const bmp = await createImageBitmap(await res.blob(), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
  const c = newCanvas(bmp.width, bmp.height);
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return c;
}

function sheet(ref: Uint8ClampedArray, got: Uint8ClampedArray, before: Uint8ClampedArray, w: number, h: number, maxW: number): string {
  const diff = new Uint8ClampedArray(ref.length);
  for (let i = 0; i < ref.length; i += 4) {
    const d = Math.max(Math.abs(ref[i] - got[i]), Math.abs(ref[i + 1] - got[i + 1]), Math.abs(ref[i + 2] - got[i + 2])) * 4;
    diff[i] = d;
    diff[i + 1] = d > 32 ? 0 : d;
    diff[i + 2] = d > 32 ? 0 : d;
    diff[i + 3] = 255;
  }
  const s = Math.min(1, maxW / w);
  const tw = Math.round(w * s);
  const th = Math.round(h * s);
  const out = newCanvas(tw * 4, th);
  const ctx = out.getContext('2d')!;
  [ref, got, diff, before].forEach((d, k) => {
    const c = newCanvas(w, h);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d), w, h), 0, 0);
    ctx.drawImage(c, k * tw, 0, tw, th);
  });
  return out.toDataURL('image/png');
}

function toPng(d: Uint8ClampedArray, w: number, h: number): string {
  const c = newCanvas(w, h);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d), w, h), 0, 0);
  return c.toDataURL('image/png');
}

async function runFixture(name: string, maxW = 600): Promise<Result> {
  const buf = await (await fetch(`/psd-fixtures/${name}.psd`)).arrayBuffer();
  const psd = readPsd(buf, {skipThumbnail: true});
  const env: EffectsEnv = {globalAngle: psd.imageResources?.globalAngle, globalAltitude: psd.imageResources?.globalAltitude, patterns: psd.patterns};
  const refCanvas = (await loadImage(`/psd-fixtures/${name}.png`)) ?? psd.canvas;
  if (!refCanvas) throw new Error(`${name}: 見本の画像がない`);
  const timing = {ms: 0};
  const before = flatten(renderDoc(psd, false, env, {ms: 0}));
  const after = flatten(renderDoc(psd, true, env, timing));
  const ref = flatten(refCanvas);
  return {
    name,
    width: psd.width,
    height: psd.height,
    before: compare(ref, before),
    after: compare(ref, after),
    ms: Math.round(timing.ms),
    image: sheet(ref, after, before, psd.width, psd.height, maxW),
    full: toPng(after, psd.width, psd.height),
    refFull: toPng(ref, psd.width, psd.height),
  };
}

/** 大きな文書での速さ（3000×4000、立ち絵ほどの形に境界線とドロップシャドウ） */
function perfTest(): Record<string, number> {
  const W = 3000;
  const H = 4000;
  const content = newCanvas(W, H);
  const ctx = content.getContext('2d')!;
  ctx.fillStyle = '#c86';
  ctx.beginPath();
  ctx.ellipse(1500, 1300, 700, 900, 0, 0, Math.PI * 2);
  ctx.ellipse(1500, 3000, 1000, 900, 0, 0, Math.PI * 2);
  ctx.fill();
  const base: Layer = {name: 'perf', left: 0, top: 0, right: W, bottom: H};
  const cases: Record<string, Layer['effects']> = {
    stroke: {stroke: [{enabled: true, position: 'outside', fillType: 'color', size: {units: 'Pixels', value: 12}, color: {r: 255, g: 255, b: 255}, opacity: 1, blendMode: 'normal'}]},
    shadow: {
      dropShadow: [
        {
          enabled: true,
          size: {units: 'Pixels', value: 30},
          distance: {units: 'Pixels', value: 20},
          angle: 120,
          opacity: 0.5,
          color: {r: 0, g: 0, b: 0},
          blendMode: 'multiply',
          choke: {units: 'Pixels', value: 0},
        },
      ],
    },
    both: {
      stroke: [{enabled: true, position: 'outside', fillType: 'color', size: {units: 'Pixels', value: 12}, color: {r: 255, g: 255, b: 255}, opacity: 1, blendMode: 'normal'}],
      dropShadow: [
        {
          enabled: true,
          size: {units: 'Pixels', value: 30},
          distance: {units: 'Pixels', value: 20},
          angle: 120,
          opacity: 0.5,
          color: {r: 0, g: 0, b: 0},
          blendMode: 'multiply',
          choke: {units: 'Pixels', value: 0},
        },
      ],
    },
  };
  const out: Record<string, number> = {};
  for (const [k, effects] of Object.entries(cases)) {
    const t0 = performance.now();
    renderLayerWithEffects({...base, effects}, content, W, H);
    out[k] = Math.round(performance.now() - t0);
  }
  return out;
}

declare global {
  interface Window {
    runFixture: typeof runFixture;
    perfTest: typeof perfTest;
  }
}
window.runFixture = runFixture;
window.perfTest = perfTest;
document.body.dataset.ready = '1';
