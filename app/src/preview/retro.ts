// 映像加工：VHS 風・古いフィルム・ブラウン管・周辺減光・ポスタリゼーション・ドット絵風・線画風・網点・デュオトーン・
// 光漏れ・ブルーム・レンズフレア・魚眼・鏡写し・タイル・パートカラー。
// 書き出し（core/src/render.rs の pixel_effect）と同じ式で、画素ごとに計算する。
// 座標は元の大きさの px（x = X / r）、時刻はアイテムの頭からの秒 t（コマは N = t × fps）。

import {hash01, type Effect} from '../model';

type Kinds =
  | 'hueCycle'
  | 'sharpen'
  | 'innerShadow'
  | 'bevel'
  | 'emboss'
  | 'vhs'
  | 'glitchNoise'
  | 'film'
  | 'crt'
  | 'vignette'
  | 'posterize'
  | 'pixelate'
  | 'lineArt'
  | 'halftone'
  | 'duotone'
  | 'lightLeak'
  | 'bloom'
  | 'lensFlare'
  | 'bulge'
  | 'mirror'
  | 'tile'
  | 'colorKeep';
export type RetroEffect = Extract<Effect, {kind: Kinds}>;
export const RETRO_FX = new Set<string>([
  'hueCycle',
  'sharpen',
  'innerShadow',
  'bevel',
  'emboss',
  'vhs',
  'glitchNoise',
  'film',
  'crt',
  'vignette',
  'posterize',
  'pixelate',
  'lineArt',
  'halftone',
  'duotone',
  'lightLeak',
  'bloom',
  'lensFlare',
  'bulge',
  'mirror',
  'tile',
  'colorKeep',
]);

/** 先に四方に足す余白（元の px。書き出しの pad と同じ） */
export function retroPad(fx: RetroEffect, k: number): number {
  return fx.kind === 'vhs' ? 31 * Math.min(1, fx.amount) * k + 1 : fx.kind === 'glitchNoise' ? 48 * Math.min(1, fx.amount) * k + 1 : 0;
}

/** 掛かるか（強さ 0 などは何もしない。書き出しと同じ条件） */
export function retroActive(fx: RetroEffect): boolean {
  switch (fx.kind) {
    case 'posterize':
    case 'lineArt':
    case 'duotone':
    case 'mirror':
    case 'colorKeep':
    case 'hueCycle':
    case 'innerShadow':
    case 'emboss':
      return true;
    case 'bevel':
      return fx.size > 0;
    case 'pixelate':
    case 'halftone':
      return fx.size >= 2;
    case 'tile':
      return fx.count >= 2;
    case 'bulge':
      return Math.abs(fx.amount) > 0;
    case 'bloom':
      return fx.amount > 0 && fx.radius > 0;
    default:
      return fx.amount > 0;
  }
}

/** 色の文字（#RRGGBB）を 0〜255 の R・G・B に（読めなければ白。書き出しの rgb255 と同じ） */
export function rgb255(c: string): [number, number, number] {
  let h = c.replace(/^#/, '');
  if (h.length === 3) h = [...h].map(x => x + x).join('');
  const v = (i: number) => {
    const n = parseInt(h.slice(i, i + 2), 16);
    return h.length >= i + 2 && !Number.isNaN(n) ? n : 255;
  };
  return [v(0), v(2), v(4)];
}

/** 色相（ラジアン。書き出しの hue_of と同じ式） */
export const hueOf = (r: number, g: number, b: number) => Math.atan2(1.7320508 * (g - b), 2 * r - g - b);
/** レンズフレアのゴースト（真ん中への進み具合・半径。書き出しの FLARE_GHOSTS と同じ） */
const FLARE_GHOSTS: [number, number][] = [
  [0.5, 0.03],
  [1.2, 0.06],
  [1.7, 0.02],
];
/** 色相の回転の行列（CSS の hue-rotate と同じ。書き出しの HUE_ROTATE と同じ）。[定数・cos・sin] × [r, g, b] */
const HUE_ROTATE = [
  [
    [0.213, 0.715, 0.072],
    [0.787, -0.715, -0.072],
    [-0.213, -0.715, 0.928],
  ],
  [
    [0.213, 0.715, 0.072],
    [-0.213, 0.285, -0.072],
    [0.143, 0.14, -0.283],
  ],
  [
    [0.213, 0.715, 0.072],
    [-0.213, -0.715, 0.928],
    [-0.787, 0.715, 0.072],
  ],
];
/** ベベルで縁を読む距離（幅に対する割合。書き出しの BEVEL_STEPS と同じ） */
const BEVEL_STEPS = [1 / 3, 2 / 3, 1];
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const clip01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const clip = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const mod = (a: number, b: number) => a - b * Math.floor(a / b);
/** 真ん中 0・角 1（書き出しの D2 と同じ） */
const d2 = (x: number, y: number, W: number, H: number) => ((x / W - 0.5) ** 2 + (y / H - 0.5) ** 2) * 2;

/**
 * d（大きさ W×H、今の画像の px）に掛けた画素を返す。r は元の 1px が今の何 px か、k は画面の 1px が元の何 px か
 */
export function retroPixels(fx: RetroEffect, d: ImageData, r: number, k: number, t: number, fps: number): ImageData {
  const W = d.width;
  const H = d.height;
  const Wo = W / r;
  const Ho = H / r;
  const s = d.data;
  const o = new ImageData(W, H);
  const out = o.data;
  const N = Math.round(t * fps);
  // 横に線形で読む（外は透明。書き出しの geq の r(X,Y) と同じ）
  const at = (X: number, Y: number, c: number) => {
    const x0 = Math.floor(X);
    const f = X - x0;
    const g = (xx: number) => (xx < 0 || xx >= W ? 0 : s[(Y * W + xx) * 4 + c]);
    return g(x0) * (1 - f) + g(x0 + 1) * f;
  };
  if (fx.kind === 'glitchNoise') {
    // 1 秒に 12 回、乱れ方が変わる。rate の割合の時間だけ大きく乱れる（書き出しと同じ乱数）
    const a = Math.min(1, fx.amount);
    const step = Math.floor(t * 12);
    const I = a * (0.15 + 0.85 * (hash01(step, 1) < Math.min(1, Math.max(0, fx.rate)) ? 1 : 0) * (0.5 + 0.5 * hash01(step, 2)));
    const b = Math.max(2, fx.block) * k;
    const bh = Math.max(1, b * 0.5);
    const bw = Math.max(1, b * 2);
    for (let Y = 0; Y < H; Y++) {
      const y = Y / r;
      const band = Math.floor(y / bh);
      const off = (hash01(band, step + 3) > 0.55 ? 1 : 0) * I * 40 * k * (hash01(band, step + 4) * 2 - 1);
      const cr = I * 8 * k * hash01(band, step + 5);
      const cb = I * 8 * k * hash01(band, step + 6);
      const line = hash01(Math.floor(y / k), N + 9) > 1 - 0.05 * I;
      for (let X = 0; X < W; X++) {
        const x = X / r;
        const xs = x - off;
        const corrupt = hash01(Math.floor(x / bw) + band * 31.7, step + 7) > 1 - 0.1 * I ? 1 : 0;
        const i = (Y * W + X) * 4;
        const v = [at((xs - cr) * r, Y, 0), at(xs * r, Y, 1), at((xs + cb) * r, Y, 2)];
        const nz = hash01(x + y * 0.37, N + 11) * 255;
        for (let j = 0; j < 3; j++) out[i + j] = clip(line ? nz : v[j] + corrupt * (255 - 2 * v[j]));
        out[i + 3] = Math.max(at((xs - cr) * r, Y, 3), at(xs * r, Y, 3), at((xs + cb) * r, Y, 3));
      }
    }
    return o;
  }
  if (fx.kind === 'vhs') {
    const a = Math.min(1, fx.amount);
    const bp = (mod(t * 0.23, 1) * 1.2 - 0.1) * Ho;
    const c = 5 * a * k;
    for (let Y = 0; Y < H; Y++) {
      const y = Y / r;
      const row = Math.floor(y / (2 * k));
      const bk = Math.max(0, 1 - Math.abs(y - bp) / (0.05 * Ho));
      const wob = a * k * (2 * (hash01(row, N) * 2 - 1) + 24 * bk * (hash01(row, N + 3) * 2 - 1));
      const sl = 1 - 0.2 * a * mod(row, 2);
      for (let X = 0; X < W; X++) {
        const x = X / r;
        const xs = x - wob;
        const nz = (hash01(x + y * 0.618, N + 0.37) - 0.5) * a * (60 + 160 * bk);
        const i = (Y * W + X) * 4;
        out[i] = clip(at((xs - c) * r, Y, 0) * sl + nz);
        out[i + 1] = clip(at(xs * r, Y, 1) * sl + nz);
        out[i + 2] = clip(at((xs + c) * r, Y, 2) * sl + nz);
        out[i + 3] = Math.max(at((xs - c) * r, Y, 3), at(xs * r, Y, 3), at((xs + c) * r, Y, 3));
      }
    }
    return o;
  }
  // 縦横に線形で読む（書き出しの geq と同じく、端は 0〜W−2 に寄せる）。xo・yo は元の px
  const samp = (xo: number, yo: number, c: number) => {
    const X = Math.min(Math.max(xo * r, 0), W - 2);
    const Y = Math.min(Math.max(yo * r, 0), H - 2);
    const xi = Math.floor(X);
    const yi = Math.floor(Y);
    const fx2 = X - xi;
    const fy = Y - yi;
    const p = (xx: number, yy: number) => s[(yy * W + xx) * 4 + c];
    return (1 - fy) * ((1 - fx2) * p(xi, yi) + fx2 * p(xi + 1, yi)) + fy * ((1 - fx2) * p(xi, yi + 1) + fx2 * p(xi + 1, yi + 1));
  };
  // 不透明度を読む。絵の外は透明（書き出しの alpha_out と同じ）
  const alphaOut = (xo: number, yo: number) => (xo < 0 || yo < 0 || xo > Wo - 1 || yo > Ho - 1 ? 0 : samp(xo, yo, 3));
  const sampLum = (xo: number, yo: number) => lum(samp(xo, yo, 0), samp(xo, yo, 1), samp(xo, yo, 2));
  if (fx.kind === 'hueCycle') {
    const th = ((fx.rpm * 6 * t + fx.offset) * Math.PI) / 180;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const M = HUE_ROTATE.map(m => [0, 1, 2].map(j => m[0][j] + m[1][j] * c + m[2][j] * sn));
    for (let i = 0; i < W * H * 4; i += 4) {
      for (let ch = 0; ch < 3; ch++) out[i + ch] = clip(M[ch][0] * s[i] + M[ch][1] * s[i + 1] + M[ch][2] * s[i + 2]);
      out[i + 3] = s[i + 3];
    }
    return o;
  }
  if (fx.kind === 'sharpen') {
    const a = Math.min(2, fx.amount);
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        const x = X / r;
        const y = Y / r;
        const i = (Y * W + X) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = clip(s[i + c] * (1 + 4 * a) - a * (samp(x + k, y, c) + samp(x - k, y, c) + samp(x, y + k, c) + samp(x, y - k, c)));
        out[i + 3] = s[i + 3];
      }
    return o;
  }
  if (fx.kind === 'bevel' || fx.kind === 'emboss') {
    const an = (fx.angle * Math.PI) / 180;
    const lx = Math.cos(an);
    const ly = -Math.sin(an);
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        const x = X / r;
        const y = Y / r;
        const i = (Y * W + X) * 4;
        out[i + 3] = s[i + 3];
        if (fx.kind === 'bevel') {
          // 光の側の縁を明るく、反対側の縁を暗く（書き出しと同じ式）
          const s0 = fx.size * k;
          let dd = 0;
          for (const tt of BEVEL_STEPS) dd += alphaOut(x - s0 * tt * lx, y - s0 * tt * ly) - alphaOut(x + s0 * tt * lx, y + s0 * tt * ly);
          dd /= 255 * BEVEL_STEPS.length;
          const st = clip01(fx.strength);
          for (let c = 0; c < 3; c++) out[i + c] = clip(s[i + c] + Math.max(dd, 0) * st * (255 - s[i + c]) + Math.min(dd, 0) * st * s[i + c]);
        } else {
          const ox = 2 * k * lx;
          const oy = 2 * k * ly;
          const v = (sampLum(x - ox, y - oy) - sampLum(x + ox, y + oy)) * (0.5 + 1.5 * clip01(fx.amount));
          for (let c = 0; c < 3; c++) out[i + c] = clip((fx.keepColor ? s[i + c] : 128) + v);
        }
      }
    return o;
  }
  if (fx.kind === 'innerShadow') {
    // ずらした形の外側を色で塗ってぼかし、形の中にだけ重ねる（書き出しと同じ）
    const base = document.createElement('canvas');
    base.width = W;
    base.height = H;
    base.getContext('2d')!.putImageData(d, 0, 0);
    const sh = document.createElement('canvas');
    sh.width = W;
    sh.height = H;
    const sx = sh.getContext('2d')!;
    sx.globalAlpha = clip01(fx.opacity);
    sx.fillStyle = fx.color;
    sx.fillRect(0, 0, W, H);
    sx.globalAlpha = 1;
    sx.globalCompositeOperation = 'destination-out';
    sx.drawImage(base, fx.x * k * r, fx.y * k * r);
    const res = document.createElement('canvas');
    res.width = W;
    res.height = H;
    const rx = res.getContext('2d', {willReadFrequently: true})!;
    rx.drawImage(base, 0, 0);
    rx.globalCompositeOperation = 'source-atop';
    if (fx.blur > 0) rx.filter = `blur(${fx.blur * k * r}px)`;
    rx.drawImage(sh, 0, 0);
    return rx.getImageData(0, 0, W, H);
  }
  // 読む所を変えるもの（魚眼・鏡写し・タイル）：(x, y) → 読む所
  const remap = (where: (x: number, y: number) => [number, number]) => {
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        const [sx, sy] = where(X / r, Y / r);
        const i = (Y * W + X) * 4;
        for (let c = 0; c < 4; c++) out[i + c] = samp(sx, sy, c);
      }
    return o;
  };
  if (fx.kind === 'bulge') {
    const a = 0.9 * Math.min(1, Math.max(-1, fx.amount));
    const R = Math.min(Wo, Ho) / 2;
    return remap((x, y) => {
      const rr = Math.hypot(x - Wo / 2, y - Ho / 2) / R;
      const f = 1 - a * Math.max(0, 1 - rr) ** 2;
      return [Wo / 2 + (x - Wo / 2) * f, Ho / 2 + (y - Ho / 2) * f];
    });
  }
  if (fx.kind === 'mirror') {
    const m = fx.mode;
    if (m === 'left') return remap((x, y) => [Math.min(x, Wo - 1 - x), y]);
    if (m === 'right') return remap((x, y) => [Math.max(x, Wo - 1 - x), y]);
    if (m === 'top') return remap((x, y) => [x, Math.min(y, Ho - 1 - y)]);
    if (m === 'bottom') return remap((x, y) => [x, Math.max(y, Ho - 1 - y)]);
    if (m === 'quad') return remap((x, y) => [Math.min(x, Wo - 1 - x), Math.min(y, Ho - 1 - y)]);
    const seg = (Math.PI * 2) / Math.min(24, Math.max(2, Math.round(fx.segments)));
    const cx = (Wo - 1) / 2;
    const cy = (Ho - 1) / 2;
    return remap((x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const a = seg / 2 - Math.abs(mod(Math.atan2(dy, dx), seg) - seg / 2);
      const rr = Math.hypot(dx, dy);
      return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
    });
  }
  if (fx.kind === 'tile') {
    const n = Math.min(12, Math.round(fx.count));
    const axis = (v: number, d: number) => {
      const u = (v * n) / d;
      const f = mod(u, 1);
      return (fx.flip ? f + mod(Math.floor(u), 2) * (1 - 2 * f) : f) * d;
    };
    return remap((x, y) => [axis(x, Wo), axis(y, Ho)]);
  }
  if (fx.kind === 'lineArt') {
    const gain = 1 + 7 * clip01(fx.amount);
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        const x = X / r;
        const y = Y / r;
        const e = clip01(((Math.abs(sampLum(x + k, y) - sampLum(x - k, y)) + Math.abs(sampLum(x, y + k) - sampLum(x, y - k))) * gain) / 255);
        const i = (Y * W + X) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = (fx.keepColor ? s[i + c] : 255) * (1 - e);
        out[i + 3] = s[i + 3];
      }
    return o;
  }
  if (fx.kind === 'halftone') {
    const c = fx.size * k;
    const ink = fx.ink ? rgb255(fx.ink) : null;
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        const x = X / r;
        const y = Y / r;
        const cx = (Math.floor(x / c) + 0.5) * c;
        const cy = (Math.floor(y / c) + 0.5) * c;
        const S = [samp(cx, cy, 0), samp(cx, cy, 1), samp(cx, cy, 2)];
        const cov = clip01(c * Math.SQRT1_2 * Math.sqrt(Math.max(0, 1 - lum(S[0], S[1], S[2]) / 255)) - Math.hypot(x - cx, y - cy) + 0.5);
        const i = (Y * W + X) * 4;
        for (let j = 0; j < 3; j++) out[i + j] = 255 + ((ink ? ink[j] : S[j]) - 255) * cov;
        out[i + 3] = s[i + 3];
      }
    return o;
  }
  if (fx.kind === 'bloom') {
    // 明るい所だけを取り出してぼかし、足す（書き出しは gblur と blend の addition）
    const th = Math.min(0.99, Math.max(0, fx.threshold)) * 255;
    const amt = Math.min(2, fx.amount);
    const sig = fx.radius * k * r;
    const pad = Math.ceil(sig * 3);
    const src = document.createElement('canvas');
    src.width = W + pad * 2;
    src.height = H + pad * 2;
    const sx = src.getContext('2d')!;
    sx.fillStyle = '#000';
    sx.fillRect(0, 0, src.width, src.height);
    const br = new ImageData(W, H);
    for (let i = 0; i < W * H * 4; i += 4) {
      const m = clip01((lum(s[i], s[i + 1], s[i + 2]) - th) / (255 - th + 1)) * amt;
      br.data[i] = s[i] * m;
      br.data[i + 1] = s[i + 1] * m;
      br.data[i + 2] = s[i + 2] * m;
      br.data[i + 3] = 255;
    }
    sx.putImageData(br, pad, pad);
    const bl = document.createElement('canvas');
    bl.width = src.width;
    bl.height = src.height;
    const bx = bl.getContext('2d', {willReadFrequently: true})!;
    bx.filter = `blur(${sig}px)`;
    bx.drawImage(src, 0, 0);
    const b = bx.getImageData(pad, pad, W, H).data;
    for (let i = 0; i < W * H * 4; i += 4) {
      out[i] = clip(s[i] + b[i]);
      out[i + 1] = clip(s[i + 1] + b[i + 1]);
      out[i + 2] = clip(s[i + 2] + b[i + 2]);
      out[i + 3] = s[i + 3];
    }
    return o;
  }
  if (fx.kind === 'duotone' || fx.kind === 'colorKeep' || fx.kind === 'lightLeak' || fx.kind === 'lensFlare') {
    const M = Math.max(Wo, Ho);
    const gs = (d2v: number, sg: number) => Math.exp(-d2v / (2 * (sg * M) ** 2));
    const col = rgb255(fx.kind === 'duotone' ? fx.dark : fx.color);
    const light = fx.kind === 'duotone' ? rgb255(fx.light) : col;
    const h0 = hueOf(col[0], col[1], col[2]);
    const sf = fx.kind === 'colorKeep' ? Math.max(0.001, clip01(fx.soft)) : 1;
    const a = fx.kind === 'colorKeep' ? 0 : fx.kind === 'duotone' ? clip01(fx.amount) : Math.min(1, fx.amount);
    // 光漏れの 2 つの光の真ん中（時刻でゆっくり動く）
    const l1 = [Wo * (0.1 + 0.15 * Math.sin(t * 0.4)), Ho * (0.25 + 0.1 * Math.sin(t * 0.31))];
    const l2 = [Wo * (0.9 - 0.1 * Math.sin(t * 0.27 + 1)), Ho * (0.8 + 0.1 * Math.cos(t * 0.35))];
    const P = fx.kind === 'lensFlare' ? [(Wo / 2) * (1 + Math.min(1, Math.max(-1, fx.x))), (Ho / 2) * (1 + Math.min(1, Math.max(-1, fx.y)))] : [0, 0];
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        const x = X / r;
        const y = Y / r;
        const i = (Y * W + X) * 4;
        const v = [s[i], s[i + 1], s[i + 2]];
        out[i + 3] = s[i + 3];
        if (fx.kind === 'duotone') {
          const tt = lum(v[0], v[1], v[2]) / 255;
          for (let j = 0; j < 3; j++) out[i + j] = v[j] + (col[j] + (light[j] - col[j]) * tt - v[j]) * a;
        } else if (fx.kind === 'colorKeep') {
          const diff = Math.abs(mod(hueOf(v[0], v[1], v[2]) - h0 + Math.PI, 2 * Math.PI) - Math.PI) / Math.PI;
          const mx = Math.max(v[0], v[1], v[2]);
          const sat = (mx - Math.min(v[0], v[1], v[2])) / Math.max(mx, 1);
          const keep = clip01((clip01(fx.range) + sf - diff) / sf) * clip01(sat * 4);
          const L = lum(v[0], v[1], v[2]);
          for (let j = 0; j < 3; j++) out[i + j] = L + (v[j] - L) * keep;
        } else {
          let I: number;
          let core = 0;
          if (fx.kind === 'lightLeak') {
            I = clip01(a * (0.9 * gs((x - l1[0]) ** 2 + (y - l1[1]) ** 2, 0.3) + 0.6 * gs((x - l2[0]) ** 2 + (y - l2[1]) ** 2, 0.22)));
          } else {
            const p0 = (x - P[0]) ** 2 + (y - P[1]) ** 2;
            let sum = gs(p0, 0.04) + 0.35 * gs(p0, 0.15);
            sum += 0.6 * Math.exp(-((y - P[1]) ** 2) / (2 * (0.006 * M) ** 2)) * Math.exp(-((x - P[0]) ** 2) / (2 * (0.35 * M) ** 2));
            for (const [tg, rg] of FLARE_GHOSTS) {
              const gx = P[0] + (Wo / 2 - P[0]) * tg;
              const gy = P[1] + (Ho / 2 - P[1]) * tg;
              sum += 0.18 * clip01((rg * M - Math.hypot(x - gx, y - gy)) / (0.01 * M));
            }
            I = a * sum;
            core = a * 255 * 0.6 * gs(p0, 0.04);
          }
          for (let j = 0; j < 3; j++) {
            const lt = fx.kind === 'lightLeak' ? col[j] * I : Math.min(255, col[j] * I + core);
            out[i + j] = 255 - ((255 - v[j]) * (255 - lt)) / 255;
          }
        }
      }
    return o;
  }
  if (fx.kind === 'pixelate') {
    const b = fx.size * k;
    for (let Y = 0; Y < H; Y++) {
      const sy = Math.min(H - 1, Math.floor(Math.floor((Math.floor(Y / r / b) + 0.5) * b) * r));
      for (let X = 0; X < W; X++) {
        const sx = Math.min(W - 1, Math.floor(Math.floor((Math.floor(X / r / b) + 0.5) * b) * r));
        const i = (Y * W + X) * 4;
        const j = (sy * W + sx) * 4;
        out[i] = s[j];
        out[i + 1] = s[j + 1];
        out[i + 2] = s[j + 2];
        out[i + 3] = s[j + 3];
      }
    }
    return o;
  }
  // 色だけ変えるもの（位置で明るさが変わる）
  if (fx.kind !== 'posterize' && fx.kind !== 'vignette' && fx.kind !== 'crt' && fx.kind !== 'film') return o;
  const a = fx.kind === 'posterize' ? 0 : Math.min(1, fx.amount);
  const q = fx.kind === 'posterize' ? Math.min(16, Math.max(2, Math.round(fx.levels))) - 1 : 0;
  const fl = 1 + 0.16 * a * (hash01(N, 5) - 0.5);
  const scratch = [0, 1].map(j => ({on: hash01(N, 21 + j) > 0.4, x: hash01(N, 11 + j) * Wo}));
  for (let Y = 0; Y < H; Y++) {
    const y = Y / r;
    const sl = fx.kind === 'crt' ? 1 - 0.45 * a * (0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (3 * k))) : 1;
    for (let X = 0; X < W; X++) {
      const x = X / r;
      const i = (Y * W + X) * 4;
      const R = s[i];
      const G = s[i + 1];
      const B = s[i + 2];
      out[i + 3] = s[i + 3];
      if (fx.kind === 'posterize') {
        out[i] = (Math.round((R / 255) * q) * 255) / q;
        out[i + 1] = (Math.round((G / 255) * q) * 255) / q;
        out[i + 2] = (Math.round((B / 255) * q) * 255) / q;
      } else if (fx.kind === 'vignette') {
        const v = 1 - a * Math.pow(d2(x, y, Wo, Ho), 1.5);
        out[i] = R * v;
        out[i + 1] = G * v;
        out[i + 2] = B * v;
      } else if (fx.kind === 'crt') {
        const col = mod(Math.floor(x / (2 * k)), 3);
        const v = sl * (1 - 0.5 * a * d2(x, y, Wo, Ho)) * (1 + 0.35 * a);
        const m = (n: number) => 1 - 0.35 * a * (col === n ? 0 : 1);
        out[i] = clip(R * v * m(0));
        out[i + 1] = clip(G * v * m(1));
        out[i + 2] = clip(B * v * m(2));
      } else {
        // 古いフィルム
        const vig = 1 - 0.6 * a * d2(x, y, Wo, Ho);
        const grain = (hash01(x + y * 0.618, N + 0.37) - 0.5) * 50 * a;
        let sc = 0;
        for (const z of scratch) if (z.on) sc += Math.max(0, 1 - Math.abs(x - z.x) / (1.5 * k));
        const add = grain + 110 * a * sc;
        const sep = (m0: number, m1: number, m2: number, v: number) => v + (m0 * R + m1 * G + m2 * B - v) * a;
        out[i] = clip(sep(0.393, 0.769, 0.189, R) * fl * vig + add);
        out[i + 1] = clip(sep(0.349, 0.686, 0.168, G) * fl * vig + add);
        out[i + 2] = clip(sep(0.272, 0.534, 0.131, B) * fl * vig + add);
      }
    }
  }
  return o;
}
