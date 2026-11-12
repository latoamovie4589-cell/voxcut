// 立ち絵の口パク・目パチ。core/src/lipsync.rs と同じ計算（プレビューと書き出しで同じ動きにするため）。
// どちらかを変えたら、もう一方と scripts/check-lipsync.ts の期待値も合わせて変えること。

export const PEAKS_PER_SEC = 100;
const MOUTH_HALF = 0.2;
const MOUTH_OPEN = 0.5;

export const EYES_OPEN = 0;
export const EYES_HALF = 1;
export const EYES_CLOSED = 2;

/** 32bit FNV-1a（UTF-8） */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function xorshift(seed: number) {
  let x = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** 瞬きの始まりのフレームと、1 段階あたりのフレーム数 */
export function blinkStarts(characterId: string, fps: number, total: number): {starts: number[]; step: number} {
  const rng = xorshift(fnv1a(characterId));
  const step = Math.max(1, Math.round(fps / 15));
  const starts: number[] = [];
  let t = 0;
  for (;;) {
    const intervalMs = 2500 + (rng() % 3000);
    t += Math.ceil((intervalMs * fps) / 1000);
    if (t >= total) break;
    starts.push(t);
  }
  return {starts, step};
}

/** フレーム f の目の状態（starts は昇順） */
export function eyesAt(f: number, blink: {starts: number[]; step: number}): number {
  // 二分探索で f 以下の最後の瞬き
  let lo = 0;
  let hi = blink.starts.length - 1;
  let s = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blink.starts[mid] <= f) {
      s = blink.starts[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (s < 0) return EYES_OPEN;
  const k = Math.floor((f - s) / blink.step);
  return k === 0 || k === 2 ? EYES_HALF : k === 1 ? EYES_CLOSED : EYES_OPEN;
}

const levelAt = (pk: Int8Array, i: number) => Math.max(Math.abs(pk[i * 2]), Math.abs(pk[i * 2 + 1]));

export function clipMax(pk: Int8Array): number {
  let m = 0;
  for (let i = 0; i < pk.length / 2; i++) m = Math.max(m, levelAt(pk, i));
  return m;
}

/** クリップ先頭から f フレーム目の口の状態 */
export function mouthAt(pk: Int8Array, max: number, f: number, fps: number): number {
  if (max === 0) return 0;
  const n = pk.length / 2;
  const a = Math.floor((f / fps) * PEAKS_PER_SEC);
  const b = Math.max(a + 1, Math.floor(((f + 1) / fps) * PEAKS_PER_SEC));
  let lv = 0;
  for (let i = a; i < b && i < n; i++) lv = Math.max(lv, levelAt(pk, i));
  const r = lv / max;
  return r >= MOUTH_OPEN ? 2 : r >= MOUTH_HALF ? 1 : 0;
}
