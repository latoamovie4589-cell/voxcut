// 映像加工：VHS 風・古いフィルム・ブラウン管・周辺減光・ポスタリゼーション・ドット絵風。
// 書き出し（core/src/render.rs の pixel_effect）と同じ式で、画素ごとに計算する。
// 座標は元の大きさの px（x = X / r）、時刻はアイテムの頭からの秒 t（コマは N = t × fps）。

import {hash01, type Effect} from '../model';

export type RetroEffect = Extract<Effect, {kind: 'vhs' | 'film' | 'crt' | 'vignette' | 'posterize' | 'pixelate'}>;
export const RETRO_FX = new Set(['vhs', 'film', 'crt', 'vignette', 'posterize', 'pixelate']);

/** 先に四方に足す余白（元の px。書き出しの pad と同じ） */
export function retroPad(fx: RetroEffect, k: number): number {
  return fx.kind === 'vhs' ? 31 * Math.min(1, fx.amount) * k + 1 : 0;
}

/** 掛かるか（強さ 0 などは何もしない。書き出しと同じ条件） */
export function retroActive(fx: RetroEffect): boolean {
  if (fx.kind === 'posterize') return true;
  if (fx.kind === 'pixelate') return fx.size >= 2;
  return fx.amount > 0;
}

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
