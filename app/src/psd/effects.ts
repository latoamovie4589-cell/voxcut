// レイヤー効果（レイヤースタイル）を Photoshop に近い形で描く。
// 重なり順（下から）：ドロップシャドウ → 光彩（外側）→ 境界線の外側部分 → 本体 → パターン → グラデーション → カラー
//   → サテン → 光彩（内側）→ シャドウ（内側）→ 境界線の内側部分 → ベベル（Photoshop のダイアログの並びと同じ）
// 計算はレイヤーの範囲＋効果のはみ出し分だけで行う（大きな PSD でも全体は見ない）。

import type {
  Color,
  EffectContour,
  EffectNoiseGradient,
  EffectSolidGradient,
  ExtraGradientInfo,
  GradientStyle,
  Layer,
  LayerEffectBevel,
  LayerEffectGradientOverlay,
  LayerEffectPatternOverlay,
  LayerEffectStroke,
  PatternInfo,
  UnitsValue,
} from 'ag-psd';

/** レイヤーからは見えない PSD 全体の設定（無ければ Photoshop の既定値） */
export interface EffectsEnv {
  /** 包括光源の角度（psd.imageResources.globalAngle） */
  globalAngle?: number;
  /** 包括光源の高度（psd.imageResources.globalAltitude） */
  globalAltitude?: number;
  /** パターンの画像（psd.patterns） */
  patterns?: PatternInfo[];
}

type Rect = {x: number; y: number; w: number; h: number};
type Rgb = [number, number, number];
/** 塗る色：単色か、範囲と同じ大きさの RGBA（ストレート） */
type Paint = {rgb: Rgb} | {px: Uint8ClampedArray};
/** clip：shape は形の内側だけ、knock は本体に隠れる分を抜く、atop は下の不透明度を変えない */
type Clip = 'none' | 'shape' | 'knock' | 'atop';

interface Job {
  w: number;
  h: number;
  n: number;
  /** 範囲の左上（文書の座標） */
  x0: number;
  y0: number;
  /** 本体の不透明度（0〜1） */
  A: Float32Array;
  /** 本体の色（RGBA ストレート） */
  C: Uint8ClampedArray;
  /** 塗りの不透明度 */
  fo: number;
  /** 形の外側への距離（遅延計算） */
  F?: Float32Array;
  /** 形の内側への距離（遅延計算） */
  G?: Float32Array;
  /** グラデーションなどを合わせる枠（文書の座標） */
  box: Rect;
  doc: Rect;
  env: EffectsEnv;
  layer: Layer;
}

type Toggle = {enabled?: boolean; present?: boolean};
const isOn = (e: Toggle | undefined): boolean => !!e && e.enabled !== false && e.present !== false;
function listOf<T extends Toggle>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).filter(isOn);
}
const px = (v: UnitsValue | undefined): number => Math.max(0, v?.value ?? 0);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * レイヤー効果付きでレイヤーを描く。content は文書と同じ大きさで、マスク適用済み・塗りの不透明度は未適用。
 * 戻り値は文書と同じ大きさで、レイヤーの不透明度と描画モードはまだ掛けていない。効果が無ければ null。
 */
export function renderLayerWithEffects(layer: Layer, content: HTMLCanvasElement, width: number, height: number, env: EffectsEnv = {}): HTMLCanvasElement | null {
  const fx = layer.effects;
  if (!fx || fx.disabled) return null;
  // ag-psd の配列は先頭が上。下から描くので逆にする
  const drops = listOf(fx.dropShadow).reverse();
  const inners = listOf(fx.innerShadow).reverse();
  const outerGlow = listOf(fx.outerGlow);
  const innerGlow = listOf(fx.innerGlow);
  const bevel = listOf(fx.bevel);
  const fills = listOf(fx.solidFill).reverse();
  const satin = listOf(fx.satin);
  const strokes = listOf(fx.stroke).reverse();
  const grads = listOf(fx.gradientOverlay).reverse();
  const pattern = listOf(fx.patternOverlay);
  const total = drops.length + inners.length + outerGlow.length + innerGlow.length + bevel.length + fills.length + satin.length + strokes.length + grads.length + pattern.length;
  if (!total) return null;

  // 本体のある範囲を探す（レイヤーの範囲が分かればその中だけ見る）
  const doc: Rect = {x: 0, y: 0, w: width, h: height};
  const cctx = content.getContext('2d', {willReadFrequently: true});
  if (!cctx) return null;
  const lb: Rect = {x: layer.left ?? 0, y: layer.top ?? 0, w: (layer.right ?? 0) - (layer.left ?? 0), h: (layer.bottom ?? 0) - (layer.top ?? 0)};
  const hint = !layer.children && lb.w > 0 && lb.h > 0 ? intersect(lb, doc) : doc;
  if (hint.w <= 0 || hint.h <= 0) return null;
  const tight = alphaBounds(cctx.getImageData(hint.x, hint.y, hint.w, hint.h).data, hint);
  if (!tight) return null;

  // 効果がはみ出す分の余白
  let m = 2;
  const blurExt = (s: number) => Math.ceil(s * 1.6) + 2;
  for (const e of drops) m = Math.max(m, px(e.distance) + blurExt(px(e.size)));
  for (const e of inners) m = Math.max(m, px(e.distance) + blurExt(px(e.size)));
  for (const e of outerGlow) m = Math.max(m, blurExt(px(e.size)));
  for (const e of innerGlow) m = Math.max(m, blurExt(px(e.size)));
  for (const e of satin) m = Math.max(m, px(e.distance) + blurExt(px(e.size)));
  for (const e of strokes) m = Math.max(m, Math.ceil(px(e.size)) + 2);
  for (const e of bevel) m = Math.max(m, Math.ceil(px(e.size) * 2 + px(e.soften)) + 2);
  m = Math.ceil(m);
  const r: Rect = {x: tight.x - m, y: tight.y - m, w: tight.w + 2 * m, h: tight.h + 2 * m};

  const img = cctx.getImageData(r.x, r.y, r.w, r.h);
  const n = r.w * r.h;
  const C = img.data;
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = C[i * 4 + 3] / 255;
  const box = !layer.children && lb.w > 0 && lb.h > 0 ? lb : tight;
  const job: Job = {w: r.w, h: r.h, n, x0: r.x, y0: r.y, A, C, fo: clamp01(layer.fillOpacity ?? 1), box, doc, env, layer};
  const globalAngle = env.globalAngle ?? 120;
  const globalAltitude = env.globalAltitude ?? 30;

  // 下にくる効果
  const acc = new Uint8ClampedArray(n * 4);
  for (const e of drops) {
    const ang = e.useGlobalLight ? globalAngle : (e.angle ?? 120);
    let mask = softMask(job, px(e.size), e.choke?.value ?? 0, false, 'softer');
    mask = applyContour(mask, e.contour);
    const [dx, dy] = offsetOf(ang, px(e.distance));
    mask = shift(mask, job.w, job.h, dx, dy, 0);
    composite(acc, job, mask, e.opacity ?? 0.75, e.layerConceals === false ? 'none' : 'knock', {rgb: toRgb(e.color)}, e.blendMode ?? 'multiply');
  }
  for (const e of outerGlow) {
    let mask = softMask(job, px(e.size), e.choke?.value ?? 0, false, e.technique ?? 'softer', true, e.range ?? 0.5);
    mask = applyContour(mask, e.contour);
    glowPaint(acc, job, mask, e.opacity ?? 0.75, 'knock', e.color, e.gradient, e.blendMode ?? 'screen');
  }
  // 境界線の外側（本体の縁と自然になじむよう、本体の下に置く）。上の境界線は下の境界線を隠す
  const sm = strokeMasks(job, strokes);
  strokes.forEach((e, k) => {
    if (sm[k].out) composite(acc, job, sm[k].out, e.opacity ?? 1, 'knock', strokePaint(job, e), e.blendMode ?? 'normal');
  });

  // 本体と内側の効果
  const interior: ((dst: Uint8ClampedArray, clip: Clip) => void)[] = [];
  for (const e of pattern) {
    const paint = patternPaint(job, e);
    if (paint) interior.push((dst, clip) => composite(dst, job, null, e.opacity ?? 1, clip, paint, e.blendMode ?? 'normal'));
  }
  for (const e of grads) {
    interior.push((dst, clip) => composite(dst, job, null, e.opacity ?? 1, clip, gradientOverlayPaint(job, e), e.blendMode ?? 'normal'));
  }
  for (const e of fills) {
    interior.push((dst, clip) => composite(dst, job, null, e.opacity ?? 1, clip, {rgb: toRgb(e.color)}, e.blendMode ?? 'normal'));
  }
  for (const e of satin) {
    interior.push((dst, clip) => {
      const ang = e.angle ?? 19;
      const sig = blurSigma(px(e.size));
      const b = sig > 0 ? blur(A.slice(), job.w, job.h, sig) : A;
      const [dx, dy] = offsetOf(ang, px(e.distance) / 2);
      const s1 = shift(b, job.w, job.h, dx, dy, 0);
      const s2 = shift(b, job.w, job.h, -dx, -dy, 0);
      let mask: Float32Array = new Float32Array(n);
      for (let i = 0; i < n; i++) mask[i] = Math.abs(s1[i] - s2[i]);
      mask = applyContour(mask, e.contour);
      if (e.invert) for (let i = 0; i < n; i++) mask[i] = 1 - mask[i];
      composite(dst, job, mask, e.opacity ?? 0.5, clip, {rgb: toRgb(e.color)}, e.blendMode ?? 'multiply');
    });
  }
  for (const e of innerGlow) {
    interior.push((dst, clip) => {
      let mask = softMask(job, px(e.size), e.choke?.value ?? 0, true, e.technique ?? 'softer', true, e.range ?? 0.5);
      if (e.source === 'center') for (let i = 0; i < n; i++) mask[i] = 1 - mask[i];
      mask = applyContour(mask, e.contour);
      glowPaint(dst, job, mask, e.opacity ?? 0.75, clip, e.color, e.gradient, e.blendMode ?? 'screen');
    });
  }
  for (const e of inners) {
    interior.push((dst, clip) => {
      const ang = e.useGlobalLight ? globalAngle : (e.angle ?? 120);
      let mask = softMask(job, px(e.size), e.choke?.value ?? 0, true, 'softer');
      mask = applyContour(mask, e.contour);
      const [dx, dy] = offsetOf(ang, px(e.distance));
      mask = shift(mask, job.w, job.h, dx, dy, 1);
      composite(dst, job, mask, e.opacity ?? 0.75, clip, {rgb: toRgb(e.color)}, e.blendMode ?? 'multiply');
    });
  }

  if (layer.blendInteriorElements || job.fo >= 1) {
    // 本体と内側の効果をまとめてから、塗りの不透明度を掛けて下の効果に重ねる。
    // 「内部効果をグループとして描画」のときの動きで、塗りが 100% なら通常時とも同じ（縁の色が下の影と混ざらない）
    const g = C.slice();
    for (const f of interior) f(g, 'atop');
    composite(acc, job, null, job.fo, 'none', {px: g}, 'normal');
  } else {
    // 塗りを下げても内側の効果は薄くならない
    composite(acc, job, null, job.fo, 'none', {px: C}, 'normal');
    for (const f of interior) f(acc, 'shape');
  }

  // 境界線の内側
  strokes.forEach((e, k) => {
    if (sm[k].in) composite(acc, job, sm[k].in, e.opacity ?? 1, 'shape', strokePaint(job, e), e.blendMode ?? 'normal');
  });

  for (const e of bevel) drawBevel(acc, job, e, globalAngle, globalAltitude);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  out.getContext('2d')!.putImageData(new ImageData(acc, r.w, r.h), r.x, r.y);
  return out;
}

/**
 * 境界線の形（外側部分と、形で切り抜く前提の内側部分）。
 * 上の境界線が覆い切る所は下の境界線を消す（乗算などの境界線が下の境界線と混ざらない。縁は重ねで自然になじむ）
 */
function strokeMasks(job: Job, strokes: LayerEffectStroke[]): {out: Float32Array | null; in: Float32Array | null}[] {
  const {n, A} = job;
  const res: {out: Float32Array | null; in: Float32Array | null}[] = [];
  const coverOut = new Float32Array(n);
  const coverIn = new Float32Array(n);
  // 上から順に作る
  for (let k = strokes.length - 1; k >= 0; k--) {
    const e = strokes[k];
    const s = px(e.size);
    const ro = e.position === 'inside' ? 0 : e.position === 'center' ? s / 2 : s;
    const ri = e.position === 'inside' ? s : e.position === 'center' ? s / 2 : 0;
    let out: Float32Array | null = null;
    let inn: Float32Array | null = null;
    if (ro > 0) {
      const F = outerField(job);
      out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const m = Math.max(A[i], clamp01(ro - F[i]));
        out[i] = coverOut[i] >= 0.999 ? 0 : m;
        coverOut[i] = Math.max(coverOut[i], m);
      }
    }
    if (ri > 0) {
      const G = innerField(job);
      inn = new Float32Array(n);
      // 形 − 縮めた形 を、形に対する割合で
      for (let i = 0; i < n; i++) {
        const a = A[i];
        if (a <= 0) continue;
        const m = clamp01((a - (1 - clamp01(ri - G[i]))) / a);
        inn[i] = coverIn[i] >= 0.999 ? 0 : m;
        coverIn[i] = Math.max(coverIn[i], m);
      }
    }
    res[k] = {out, in: inn};
  }
  return res;
}

// ---- 範囲 ----

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y};
}

function alphaBounds(d: Uint8ClampedArray, r: Rect): Rect | null {
  let x0 = r.w;
  let y0 = r.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < r.h; y++) {
    const row = y * r.w * 4;
    for (let x = 0; x < r.w; x++) {
      if (d[row + x * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) return null;
  return {x: r.x + x0, y: r.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1};
}

/** 光源の角度と距離から影のずれ（光と反対向き、画面は下が +y） */
function offsetOf(angle: number, dist: number): [number, number] {
  const t = (angle * Math.PI) / 180;
  return [Math.round(-Math.cos(t) * dist), Math.round(Math.sin(t) * dist)];
}

// ---- 距離とぼかし ----

/**
 * 最も近い「中身のある画素」までの距離から、その画素の不透明度を引いたもの。
 * clamp(r − F) が r だけ太らせた形の不透明度になる（r = 0 で元の不透明度に戻る）
 */
function edgeField(a: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const INF = 1e20;
  const colD = new Float32Array(n);
  const colArg = new Int32Array(n);
  const len = Math.max(w, h);
  const f = new Float64Array(len);
  const d = new Float64Array(len);
  const arg = new Int32Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  // 縦方向は「上と下で一番近い中身」を 2 回なめるだけで求まる（行ごとに進めてメモリを順に読む）
  const lastY = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (a[row + x] >= SEED) lastY[x] = y;
      const ly = lastY[x];
      colArg[row + x] = ly;
      colD[row + x] = ly < 0 ? INF : (y - ly) * (y - ly);
    }
  }
  lastY.fill(-1);
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (a[row + x] >= SEED) lastY[x] = y;
      const ly = lastY[x];
      if (ly < 0) continue;
      const d2 = (ly - y) * (ly - y);
      if (d2 < colD[row + x]) {
        colD[row + x] = d2;
        colArg[row + x] = ly;
      }
    }
  }
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = colD[row + x];
    dt1(f, w, d, arg, v, z);
    for (let x = 0; x < w; x++) {
      if (d[x] >= INF / 2) {
        out[row + x] = 1e9;
        continue;
      }
      const sx = arg[x];
      const sy = colArg[row + sx];
      out[row + x] = Math.sqrt(d[x]) - a[sy * w + sx];
    }
  }
  return out;
}

const SEED = 0.004;

/** 1 次元の距離変換（Felzenszwalb）。最も近い位置も返す */
function dt1(f: Float64Array, n: number, d: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
    arg[q] = p;
  }
}

function outerField(job: Job): Float32Array {
  if (!job.F) job.F = edgeField(job.A, job.w, job.h);
  return job.F;
}

function innerField(job: Job): Float32Array {
  if (!job.G) {
    const inv = new Float32Array(job.n);
    for (let i = 0; i < job.n; i++) inv[i] = 1 - job.A[i];
    job.G = edgeField(inv, job.w, job.h);
  }
  return job.G;
}

/** 「サイズ」からガウスぼかしの標準偏差 */
function blurSigma(size: number): number {
  return size * 0.42;
}

/**
 * 影・光彩の形：spread% だけ太らせてから、残りのサイズでぼかす。
 * inner なら形の外側（反転した不透明度）を内側へ広げる
 */
function softMask(job: Job, size: number, spreadPct: number, inner: boolean, technique: string, glow = false, range = 0.5): Float32Array {
  const {n, w, h} = job;
  const spread = (size * clamp01(spreadPct / 100)) as number;
  const rest = size - spread;
  const out = new Float32Array(n);
  if (technique === 'precise') {
    // 精細：距離に比例して薄くなる
    const field = inner ? innerField(job) : outerField(job);
    for (let i = 0; i < n; i++) out[i] = rest > 0 ? clamp01(1 - (field[i] - spread) / rest) : clamp01(spread - field[i]);
    return out;
  }
  if (spread > 0) {
    const field = inner ? innerField(job) : outerField(job);
    for (let i = 0; i < n; i++) out[i] = clamp01(spread - field[i]);
  } else {
    // 広げないなら距離は要らない
    const A = job.A;
    for (let i = 0; i < n; i++) out[i] = inner ? 1 - A[i] : A[i];
  }
  // 光彩は影より鋭くぼかし、範囲（既定 50%）で割って縁を濃くする（Photoshop の見本に合わせた値）
  const sig = glow ? rest * 0.33 : blurSigma(rest);
  const res = sig > 0 ? blur(out, w, h, sig) : out;
  if (glow) {
    const mul = 1 / Math.max(0.01, range);
    for (let i = 0; i < n; i++) res[i] = clamp01(res[i] * mul);
  }
  return res;
}

/** ガウスぼかし（3 回の箱ぼかしで近似）。端は外側も同じ値が続くとみなす */
function blur(a: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const sizes = boxesForGauss(sigma, 3);
  const tmp = new Float32Array(a.length);
  for (const s of sizes) {
    const r = (s - 1) / 2;
    if (r <= 0) continue;
    boxH(a, tmp, w, h, r);
    boxV(tmp, a, w, h, r);
  }
  return a;
}

function boxesForGauss(sigma: number, n: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i < m ? wl : wu);
  return out;
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row];
    const last = src[row + w - 1];
    let acc = (r + 1) * first;
    for (let j = 0; j < r; j++) acc += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      const addI = x + r;
      const subI = x - r - 1;
      acc += addI < w ? src[row + addI] : last;
      acc -= subI >= 0 ? src[row + subI] : first;
      dst[row + x] = acc * inv;
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  // 行ごとに進めて列の合計を持つ（メモリを順に読む）
  const inv = 1 / (2 * r + 1);
  const sum = new Float64Array(w);
  const lastRow = (h - 1) * w;
  for (let x = 0; x < w; x++) sum[x] = (r + 1) * src[x];
  for (let j = 0; j < r; j++) {
    const row = Math.min(j, h - 1) * w;
    for (let x = 0; x < w; x++) sum[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const add = y + r < h ? (y + r) * w : lastRow;
    const sub = y - r - 1 >= 0 ? (y - r - 1) * w : 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = sum[x] + src[add + x] - src[sub + x];
      sum[x] = v;
      dst[row + x] = v * inv;
    }
  }
}

/** 整数ずらし。はみ出した所は fill */
function shift(a: Float32Array, w: number, h: number, dx: number, dy: number, fill: number): Float32Array {
  if (!dx && !dy) return a;
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      out[y * w + x] = sx >= 0 && sx < w && sy >= 0 && sy < h ? a[sy * w + sx] : fill;
    }
  }
  return out;
}

// ---- 輪郭（コンター） ----

function contourLut(c: EffectContour | undefined): Float32Array | null {
  const pts = c?.curve;
  if (!pts || pts.length < 2) return null;
  const sorted = [...pts].sort((p, q) => p.x - q.x);
  if (sorted.length === 2 && sorted[0].x === 0 && sorted[0].y === 0 && sorted[1].x === 255 && sorted[1].y === 255) return null;
  const xs = sorted.map(p => p.x / 255);
  const ys = sorted.map(p => p.y / 255);
  const lut = new Float32Array(256);
  // 角の指定が無い 3 点以上は滑らかな曲線（Photoshop のカーブと同じ自然スプライン）
  const smooth = sorted.length > 2 && sorted.some(p => p.curved !== false);
  const m = smooth ? splineSlopes(xs, ys) : null;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < xs.length - 2 && t > xs[k + 1]) k++;
    const x0 = xs[k];
    const x1 = xs[k + 1];
    const hseg = x1 - x0 || 1e-6;
    const u = clamp01((t - x0) / hseg);
    let v: number;
    if (m) {
      const a = 1 - u;
      v = a * ys[k] + u * ys[k + 1] + ((a * a * a - a) * m[k] + (u * u * u - u) * m[k + 1]) * ((hseg * hseg) / 6);
    } else v = ys[k] + (ys[k + 1] - ys[k]) * u;
    if (t <= xs[0]) v = ys[0];
    if (t >= xs[xs.length - 1]) v = ys[ys.length - 1];
    lut[i] = clamp01(v);
  }
  return lut;
}

/** 自然スプラインの 2 階微分 */
function splineSlopes(x: number[], y: number[]): number[] {
  const n = x.length;
  const m = new Array<number>(n).fill(0);
  const u = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const sig = (x[i] - x[i - 1]) / (x[i + 1] - x[i - 1]);
    const p = sig * m[i - 1] + 2;
    m[i] = (sig - 1) / p;
    const dy = (y[i + 1] - y[i]) / (x[i + 1] - x[i]) - (y[i] - y[i - 1]) / (x[i] - x[i - 1]);
    u[i] = ((6 * dy) / (x[i + 1] - x[i - 1]) - sig * u[i - 1]) / p;
  }
  m[n - 1] = 0;
  for (let k = n - 2; k >= 0; k--) m[k] = m[k] * m[k + 1] + u[k];
  return m;
}

function applyContour(a: Float32Array, c: EffectContour | undefined): Float32Array {
  const lut = contourLut(c);
  if (!lut) return a;
  for (let i = 0; i < a.length; i++) {
    const t = clamp01(a[i]) * 255;
    const k = Math.min(254, Math.floor(t));
    a[i] = lut[k] + (lut[k + 1] - lut[k]) * (t - k);
  }
  return a;
}

// ---- 色 ----

function toRgb(c: Color | undefined): Rgb {
  if (!c) return [0, 0, 0];
  const o = c as unknown as Record<string, number>;
  if ('r' in o && 'g' in o) return [o.r, o.g, o.b];
  if ('fr' in o) return [o.fr * 255, o.fg * 255, o.fb * 255];
  if ('h' in o && 's' in o) return hsbToRgb(o.h, o.s, o.b);
  if ('l' in o && 'a' in o) return labToRgb(o.l * 100, o.a * (o.a < 0 ? 128 : 127), o.b * (o.b < 0 ? 128 : 127));
  if ('c' in o && 'm' in o) {
    const k = 1 - o.k / 255;
    return [(255 - o.c) * k, (255 - o.m) * k, (255 - o.y) * k];
  }
  // グレースケールは墨の量
  if ('k' in o) return [255 - o.k, 255 - o.k, 255 - o.k];
  return [0, 0, 0];
}

function hsbToRgb(h: number, s: number, v: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const table: Rgb[] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ];
  const [r, g, b] = table[i % 6];
  return [r * 255, g * 255, b * 255];
}

function labToRgb(l: number, a: number, b: number): Rgb {
  let y = (l + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x);
  y = 1.0 * f(y);
  z = 1.08883 * f(z);
  const lin = [x * 3.2406 + y * -1.5372 + z * -0.4986, x * -0.9689 + y * 1.8758 + z * 0.0415, x * 0.0557 + y * -0.204 + z * 1.057];
  return lin.map(v => toSrgb(clamp01(v)) * 255) as Rgb;
}

const toSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

// ---- 合成 ----

type Sep = (b: number, s: number) => number;

const SEPARABLE: Record<string, Sep> = {
  normal: (_b, s) => s,
  dissolve: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color dodge': (b, s) => colorDodge(b, s),
  'color burn': (b, s) => colorBurn(b, s),
  'hard light': (b, s) => hardLight(b, s),
  'soft light': (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (Math.sqrt(b) - b)),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  'linear burn': (b, s) => Math.max(0, b + s - 1),
  'linear dodge': (b, s) => Math.min(1, b + s),
  'vivid light': (b, s) => (s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1)),
  'linear light': (b, s) => clamp01(b + 2 * s - 1),
  'pin light': (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  'hard mix': (b, s) => (b + s >= 1 ? 1 : 0),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s)),
};

function colorDodge(b: number, s: number): number {
  if (b <= 0) return 0;
  if (s >= 1) return 1;
  return Math.min(1, b / (1 - s));
}
function colorBurn(b: number, s: number): number {
  if (b >= 1) return 1;
  if (s <= 0) return 0;
  return 1 - Math.min(1, (1 - b) / s);
}
function hardLight(b: number, s: number): number {
  return s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1);
}

const lum = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(c: Rgb): Rgb {
  const l = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let [r, g, b] = c;
  if (n < 0) {
    r = l + ((r - l) * l) / (l - n);
    g = l + ((g - l) * l) / (l - n);
    b = l + ((b - l) * l) / (l - n);
  }
  if (x > 1) {
    r = l + ((r - l) * (1 - l)) / (x - l);
    g = l + ((g - l) * (1 - l)) / (x - l);
    b = l + ((b - l) * (1 - l)) / (x - l);
  }
  return [r, g, b];
}
function setLum(c: Rgb, l: number): Rgb {
  const d = l - lum(c[0], c[1], c[2]);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}
const sat = (c: Rgb): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: Rgb, s: number): Rgb {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const out: Rgb = [0, 0, 0];
  const mn = c[idx[0]];
  const mx = c[idx[2]];
  if (mx > mn) {
    out[idx[1]] = ((c[idx[1]] - mn) * s) / (mx - mn);
    out[idx[2]] = s;
  }
  return out;
}

/** 色同士の描画モード（色相・彩度・カラー・輝度・カラー比較） */
function nonSeparable(mode: string, b: Rgb, s: Rgb): Rgb {
  switch (mode) {
    case 'hue':
      return setLum(setSat(s, sat(b)), lum(b[0], b[1], b[2]));
    case 'saturation':
      return setLum(setSat(b, sat(s)), lum(b[0], b[1], b[2]));
    case 'color':
      return setLum(s, lum(b[0], b[1], b[2]));
    case 'luminosity':
      return setLum(b, lum(s[0], s[1], s[2]));
    case 'darker color':
      return b[0] + b[1] + b[2] <= s[0] + s[1] + s[2] ? b : s;
    case 'lighter color':
      return b[0] + b[1] + b[2] >= s[0] + s[1] + s[2] ? b : s;
  }
  return s;
}

/** 決まった乱数（ディザ合成用） */
function hash01(i: number): number {
  let x = (i ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * dst（RGBA ストレート）の上に 1 枚重ねる。不透明度 = opacity × mask × clip × 塗りのアルファ。
 * 描画モードは W3C の合成式（下が透明なら通常と同じ）
 */
function composite(dst: Uint8ClampedArray, job: Job, mask: Float32Array | null, opacity: number, clip: Clip, paint: Paint, mode: string): void {
  if (opacity <= 0) return;
  const {n, A, fo} = job;
  const sep = SEPARABLE[mode];
  const isNormal = mode === 'normal' || mode === 'pass through';
  const dissolve = mode === 'dissolve';
  const solid = 'rgb' in paint ? paint.rgb.map(v => v / 255) : null;
  const pxs = 'px' in paint ? paint.px : null;
  const bb: Rgb = [0, 0, 0];
  const ss: Rgb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    let as = opacity;
    if (mask) as *= mask[i];
    if (clip === 'shape') as *= A[i];
    else if (clip === 'knock') {
      // 本体に隠れる分を抜く：塗りが 100% のときは通常の重ねと同じ（不透明な所は本体で隠れるので飛ばす）
      const a = A[i];
      if (a >= 1) continue;
      if (fo < 1) as *= (1 - a) / (1 - a * fo);
    }
    const j = i * 4;
    let sr: number, sg: number, sb: number;
    if (pxs) {
      as *= pxs[j + 3] / 255;
      sr = pxs[j] / 255;
      sg = pxs[j + 1] / 255;
      sb = pxs[j + 2] / 255;
    } else {
      sr = solid![0];
      sg = solid![1];
      sb = solid![2];
    }
    if (as <= 0) continue;
    if (dissolve) as = hash01(i) < as ? 1 : 0;
    if (as <= 0) continue;
    const ab = dst[j + 3] / 255;
    if (clip === 'atop' && ab <= 0) continue;
    const cr = dst[j] / 255;
    const cg = dst[j + 1] / 255;
    const cb = dst[j + 2] / 255;
    let br: number, bg: number, bl: number;
    if (isNormal || ab <= 0) {
      br = sr;
      bg = sg;
      bl = sb;
    } else if (sep) {
      br = sep(cr, sr);
      bg = sep(cg, sg);
      bl = sep(cb, sb);
    } else {
      bb[0] = cr;
      bb[1] = cg;
      bb[2] = cb;
      ss[0] = sr;
      ss[1] = sg;
      ss[2] = sb;
      [br, bg, bl] = nonSeparable(mode, bb, ss);
    }
    if (clip === 'atop') {
      dst[j] = (cr + (br - cr) * as) * 255;
      dst[j + 1] = (cg + (bg - cg) * as) * 255;
      dst[j + 2] = (cb + (bl - cb) * as) * 255;
      continue;
    }
    const ao = as + ab * (1 - as);
    const k1 = as * (1 - ab);
    const k2 = as * ab;
    const k3 = (1 - as) * ab;
    dst[j] = ((k1 * sr + k2 * br + k3 * cr) / ao) * 255;
    dst[j + 1] = ((k1 * sg + k2 * bg + k3 * cg) / ao) * 255;
    dst[j + 2] = ((k1 * sb + k2 * bl + k3 * cb) / ao) * 255;
    dst[j + 3] = ao * 255;
  }
}

/** 光彩：単色か、グラデーション（縁が左端） */
function glowPaint(
  dst: Uint8ClampedArray,
  job: Job,
  mask: Float32Array,
  opacity: number,
  clip: Clip,
  color: Color | undefined,
  grad: EffectSolidGradient | EffectNoiseGradient | undefined,
  mode: string,
): void {
  if (!grad) {
    composite(dst, job, mask, opacity, clip, {rgb: toRgb(color)}, mode);
    return;
  }
  const lut = gradientLut(grad, false, undefined);
  const p = new Uint8ClampedArray(job.n * 4);
  for (let i = 0; i < job.n; i++) {
    const k = Math.round((1 - clamp01(mask[i])) * (LUT_N - 1)) * 4;
    p[i * 4] = lut[k];
    p[i * 4 + 1] = lut[k + 1];
    p[i * 4 + 2] = lut[k + 2];
    p[i * 4 + 3] = mask[i] > 0 ? lut[k + 3] : 0;
  }
  composite(dst, job, null, opacity, clip, {px: p}, mode);
}

// ---- グラデーション ----

const LUT_N = 1024;

/** グラデーションの表（RGBA × LUT_N） */
function gradientLut(g: EffectSolidGradient | EffectNoiseGradient, reverse: boolean, method: string | undefined): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_N * 4);
  if (g.type === 'noise') return noiseLut(g, reverse);
  const cs = [...(g.colorStops ?? [])].sort((a, b) => a.location - b.location);
  const os = [...(g.opacityStops ?? [])].sort((a, b) => a.location - b.location);
  const colors = cs.map(s => toRgb(s.color));
  // 「リニア」は γ1.8 相当の空間で混ぜると Photoshop の見本に合う
  const lin = method === 'linear';
  const G = 1.8;
  const mix = (a: number, b: number, u: number) => ((a / 255) ** G + ((b / 255) ** G - (a / 255) ** G) * u) ** (1 / G) * 255;
  for (let i = 0; i < LUT_N; i++) {
    let t = i / (LUT_N - 1);
    if (reverse) t = 1 - t;
    let r = 0,
      gg = 0,
      b = 0,
      a = 1;
    if (cs.length) {
      const [k, u] = stopPos(cs, t);
      const c0 = colors[k];
      const c1 = colors[Math.min(k + 1, colors.length - 1)];
      if (lin) {
        r = mix(c0[0], c1[0], u);
        gg = mix(c0[1], c1[1], u);
        b = mix(c0[2], c1[2], u);
      } else {
        r = c0[0] + (c1[0] - c0[0]) * u;
        gg = c0[1] + (c1[1] - c0[1]) * u;
        b = c0[2] + (c1[2] - c0[2]) * u;
      }
    }
    if (os.length) {
      const [k, u] = stopPos(os, t);
      const o0 = os[k].opacity;
      const o1 = os[Math.min(k + 1, os.length - 1)].opacity;
      a = o0 + (o1 - o0) * u;
    }
    lut[i * 4] = r;
    lut[i * 4 + 1] = gg;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = a * 255;
  }
  return lut;
}

/** t がどの区間のどこか（中間点の位置も考える） */
function stopPos(stops: {location: number; midpoint: number}[], t: number): [number, number] {
  if (t <= stops[0].location) return [0, 0];
  const last = stops.length - 1;
  if (t >= stops[last].location) return [last, 0];
  let k = 0;
  while (k < last - 1 && t > stops[k + 1].location) k++;
  const l0 = stops[k].location;
  const l1 = stops[k + 1].location;
  let u = l1 > l0 ? (t - l0) / (l1 - l0) : 1;
  // 中間点（次の分岐点の midpoint は手前の区間のもの）
  const mid = clamp01(stops[k + 1].midpoint ?? 0.5);
  if (mid > 0 && mid < 1 && mid !== 0.5) u = u < mid ? (0.5 * u) / mid : 0.5 + (0.5 * (u - mid)) / (1 - mid);
  return [k, u];
}

/** ノイズグラデーション（Photoshop と同じ乱数ではないので見た目だけ近づける） */
function noiseLut(g: EffectNoiseGradient, reverse: boolean): Uint8ClampedArray {
  let seed = (g.randomSeed ?? 1) >>> 0 || 1;
  const rnd = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 4294967296;
  };
  const count = 2 + Math.round((g.roughness ?? 0.5) * 30);
  const mn = g.min ?? [0, 0, 0, 0];
  const mx = g.max ?? [1, 1, 1, 1];
  const stops: number[][] = [];
  for (let i = 0; i < count; i++) stops.push([0, 1, 2].map(c => (mn[c] + (mx[c] - mn[c]) * rnd()) * 255));
  const lut = new Uint8ClampedArray(LUT_N * 4);
  for (let i = 0; i < LUT_N; i++) {
    let t = i / (LUT_N - 1);
    if (reverse) t = 1 - t;
    const f = t * (count - 1);
    const k = Math.min(count - 2, Math.floor(f));
    const u = f - k;
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * u;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/** グラデーションを範囲全体に塗る */
function gradientPaint(
  job: Job,
  g: EffectSolidGradient | EffectNoiseGradient,
  o: {style?: GradientStyle; angle?: number; scale?: number; reverse?: boolean; align?: boolean; offset?: {x: number; y: number}; method?: string},
): Paint {
  const lut = gradientLut(g, !!o.reverse, o.method);
  const b = o.align === false ? job.doc : job.box;
  const scale = Math.max(1e-3, o.scale ?? 1);
  const th = ((o.angle ?? 90) * Math.PI) / 180;
  const ux = Math.cos(th);
  const uy = -Math.sin(th);
  const cx = b.x + b.w / 2 + ((o.offset?.x ?? 0) / 100) * b.w - job.x0;
  const cy = b.y + b.h / 2 + ((o.offset?.y ?? 0) / 100) * b.h - job.y0;
  // 線形：角度方向に枠を投影した長さが 0〜1
  const half = Math.max(1e-3, ((Math.abs(b.w * ux) + Math.abs(b.h * uy)) / 2) * scale);
  const style = o.style ?? 'linear';
  const {w, h} = job;
  const p = new Uint8ClampedArray(job.n * 4);
  for (let y = 0; y < h; y++) {
    const ry = y + 0.5 - cy;
    for (let x = 0; x < w; x++) {
      const rx = x + 0.5 - cx;
      const along = rx * ux + ry * uy;
      let t: number;
      switch (style) {
        case 'radial':
          t = Math.sqrt(rx * rx + ry * ry) / half;
          break;
        case 'reflected':
          t = Math.abs(along) / half;
          break;
        case 'diamond':
          t = (Math.abs(along) + Math.abs(-rx * uy + ry * ux)) / half;
          break;
        case 'angle': {
          const a = Math.atan2(-ry, rx) - th;
          t = 1 - ((((a / (2 * Math.PI)) % 1) + 1) % 1);
          break;
        }
        default:
          t = 0.5 + along / (2 * half);
      }
      const k = Math.round(clamp01(t) * (LUT_N - 1)) * 4;
      const j = (y * w + x) * 4;
      p[j] = lut[k];
      p[j + 1] = lut[k + 1];
      p[j + 2] = lut[k + 2];
      p[j + 3] = lut[k + 3];
    }
  }
  return {px: p};
}

function gradientOverlayPaint(job: Job, e: LayerEffectGradientOverlay): Paint {
  if (!e.gradient) return {rgb: [0, 0, 0]};
  return gradientPaint(job, e.gradient, {style: e.type, angle: e.angle, scale: e.scale, reverse: e.reverse, align: e.align, offset: e.offset, method: e.interpolationMethod});
}

// ---- パターン ----

function patternCanvas(job: Job, id: string | undefined): HTMLCanvasElement | null {
  const info = job.env.patterns?.find(p => p.id === id);
  if (!info || !info.data || info.bounds.w <= 0 || info.bounds.h <= 0) return null;
  const c = document.createElement('canvas');
  c.width = info.bounds.w;
  c.height = info.bounds.h;
  const data = new Uint8ClampedArray(info.bounds.w * info.bounds.h * 4);
  data.set(info.data.subarray(0, data.length));
  c.getContext('2d')!.putImageData(new ImageData(data, info.bounds.w, info.bounds.h), 0, 0);
  return c;
}

function tiledPaint(job: Job, tile: HTMLCanvasElement, o: {scale?: number; angle?: number; phase?: {x: number; y: number}; align?: boolean}): Paint {
  const c = document.createElement('canvas');
  c.width = job.w;
  c.height = job.h;
  const ctx = c.getContext('2d', {willReadFrequently: true})!;
  const pat = ctx.createPattern(tile, 'repeat');
  if (!pat) return {rgb: [0, 0, 0]};
  // 「レイヤーにリンク」なら効果の基準点に合わせて動く
  const ref = o.align !== false ? (job.layer.referencePoint ?? {x: 0, y: 0}) : {x: 0, y: 0};
  const s = o.scale ?? 1;
  const m = new DOMMatrix()
    .translateSelf(ref.x + (o.phase?.x ?? 0) - job.x0, ref.y + (o.phase?.y ?? 0) - job.y0)
    .rotateSelf(-(o.angle ?? 0))
    .scaleSelf(s, s);
  pat.setTransform(m);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, job.w, job.h);
  return {px: ctx.getImageData(0, 0, job.w, job.h).data};
}

function patternPaint(job: Job, e: LayerEffectPatternOverlay): Paint | null {
  const tile = patternCanvas(job, e.pattern?.id);
  if (!tile) return null;
  return tiledPaint(job, tile, e);
}

function strokePaint(job: Job, e: LayerEffectStroke): Paint {
  if (e.fillType === 'gradient' && e.gradient) {
    const g = e.gradient as (EffectSolidGradient | EffectNoiseGradient) & ExtraGradientInfo;
    return gradientPaint(job, g, {style: g.style, angle: g.angle, scale: g.scale, reverse: g.reverse, align: g.align, offset: g.offset, method: g.interpolationMethod});
  }
  if (e.fillType === 'pattern' && e.pattern) {
    const tile = patternCanvas(job, e.pattern.id);
    if (tile) return tiledPaint(job, tile, e.pattern);
  }
  return {rgb: toRgb(e.color)};
}

// ---- ベベルとエンボス（近似） ----

function drawBevel(acc: Uint8ClampedArray, job: Job, e: LayerEffectBevel, globalAngle: number, globalAltitude: number): void {
  const {w, h, n, A} = job;
  const size = Math.max(1, px(e.size));
  const style = e.style ?? 'inner bevel';
  const ang = ((e.useGlobalLight ? globalAngle : (e.angle ?? 120)) * Math.PI) / 180;
  const alt = ((e.useGlobalLight ? globalAltitude : (e.altitude ?? 30)) * Math.PI) / 180;
  const F = outerField(job);
  const G = innerField(job);
  // 高さ：縁からの距離で 0〜1。内側は形の中、外側は形の外
  const hm = new Float32Array(n);
  const prof = (t: number) => (e.technique === 'smooth' || !e.technique ? 1 - (1 - t) * (1 - t) : t);
  for (let i = 0; i < n; i++) {
    const inside = clamp01(G[i] / size);
    const outside = clamp01(F[i] / size);
    switch (style) {
      case 'outer bevel':
        hm[i] = 1 - prof(outside);
        break;
      case 'emboss':
        hm[i] = A[i] >= 0.5 ? 0.5 + 0.5 * prof(clamp01((2 * G[i]) / size)) : 0.5 - 0.5 * prof(clamp01((2 * F[i]) / size));
        break;
      case 'pillow emboss':
        hm[i] = A[i] >= 0.5 ? prof(inside) : prof(outside);
        break;
      default:
        hm[i] = prof(inside);
    }
  }
  // ぼかし量と深さの係数は Photoshop の見本に合わせた値
  const hb = e.technique === 'smooth' || !e.technique ? blur(hm, w, h, Math.max(0.5, size * 0.25)) : hm;
  const depth = (e.strength ?? 1) * size * 0.6 * (e.direction === 'down' ? -1 : 1);
  const lx = Math.cos(alt) * Math.cos(ang);
  const ly = -Math.cos(alt) * Math.sin(ang);
  const lz = Math.sin(alt);
  let hi: Float32Array = new Float32Array(n);
  let sh: Float32Array = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (hb[i + 1] - hb[i - 1]) / 2;
      const gy = (hb[i + w] - hb[i - w]) / 2;
      if (!gx && !gy) continue;
      const nx = -gx * depth;
      const ny = -gy * depth;
      const s = (nx * lx + ny * ly + lz) / Math.sqrt(nx * nx + ny * ny + 1);
      if (s > lz) hi[i] = (s - lz) / (1 - lz || 1);
      else sh[i] = (lz - s) / (lz || 1);
    }
  }
  const soft = px(e.soften);
  if (soft > 0) {
    hi = blur(hi, w, h, soft / 2);
    sh = blur(sh, w, h, soft / 2);
  }
  hi = applyContour(hi, e.contour);
  sh = applyContour(sh, e.contour);
  // 内側のベベルは形の中、外側は形の外だけ
  if (style === 'inner bevel' || style === 'outer bevel') {
    const outer = style === 'outer bevel';
    for (let i = 0; i < n; i++) {
      const k = outer ? 1 - A[i] : A[i];
      hi[i] *= k;
      sh[i] *= k;
    }
  }
  composite(acc, job, sh, e.shadowOpacity ?? 0.75, 'none', {rgb: toRgb(e.shadowColor)}, e.shadowBlendMode ?? 'multiply');
  composite(acc, job, hi, e.highlightOpacity ?? 0.75, 'none', {rgb: toRgb(e.highlightColor)}, e.highlightBlendMode ?? 'screen');
}
