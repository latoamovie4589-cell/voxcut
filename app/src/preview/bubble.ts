// 吹き出し：文字の絵のまわりに、丸・四角・ギザギザ（叫び）・もくもく（考え中）の枠としっぽを描く。
// しっぽがどちらを向いても文字が真ん中に来るよう、絵は四方に同じだけ余白を取る（置いた位置がずれない）。

import type {Bubble} from '../model';

const TAU = Math.PI * 2;

/** 吹き出しのいつもの形 */
export const BUBBLE_PRESET: Record<Bubble['kind'], {label: string} & Omit<Bubble, 'kind'>> = {
  round: {label: '丸', fill: '#FFFFFF', stroke: '#222222', strokeWidth: 5, padding: 24, tailAngle: 120, tailLength: 60},
  square: {label: '四角', fill: '#FFFFFF', stroke: '#222222', strokeWidth: 5, padding: 22, tailAngle: 120, tailLength: 50},
  shout: {label: '叫び', fill: '#FFF46B', stroke: '#222222', strokeWidth: 5, padding: 34, tailAngle: 120, tailLength: 50},
  think: {label: '考え中', fill: '#FFFFFF', stroke: '#222222', strokeWidth: 4, padding: 28, tailAngle: 120, tailLength: 70},
};

/** 吹き出しの体の半径（文字の四角がちょうど入る楕円・四角） */
function body(b: Bubble, tw: number, th: number) {
  const pad = Math.max(0, b.padding);
  const hw = tw / 2 + pad;
  const hh = th / 2 + pad;
  // 楕円に四角を入れるには √2 倍（縦横の比は保つ）
  return b.kind === 'square' ? {rx: hw, ry: hh} : {rx: hw * 1.22, ry: hh * 1.3};
}

/** 楕円の、角度 an の方向の縁 */
const edge = (rx: number, ry: number, an: number) => {
  const c = Math.cos(an);
  const s = Math.sin(an);
  const k = 1 / Math.sqrt((c * c) / (rx * rx) + (s * s) / (ry * ry));
  return [c * k, s * k] as const;
};

/** 体としっぽの形（stroke と fill に同じ形を使う） */
function shapePath(x: CanvasRenderingContext2D, b: Bubble, rx: number, ry: number) {
  const an = (b.tailAngle * Math.PI) / 180;
  const tail = Math.max(0, b.tailLength);
  x.beginPath();
  if (b.kind === 'square') {
    x.roundRect(-rx, -ry, rx * 2, ry * 2, Math.min(rx, ry) * 0.35);
  } else if (b.kind === 'shout') {
    // ギザギザ：外と内を交互に（毎回同じ形になるよう、決まった揺らぎ）
    const n = 22;
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * TAU;
      const out = i % 2 === 0;
      const j = 1 + 0.08 * Math.sin(i * 2.7);
      const [ex, ey] = edge(rx, ry, a);
      const k = (out ? 1.18 : 0.94) * j;
      if (i === 0) x.moveTo(ex * k, ey * k);
      else x.lineTo(ex * k, ey * k);
    }
    x.closePath();
  } else if (b.kind === 'think') {
    // もくもく：縁に沿って小さな丸を並べる
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const [ex, ey] = edge(rx * 0.92, ry * 0.92, a);
      const r = Math.min(rx, ry) * (0.36 + 0.06 * Math.sin(i * 1.9));
      x.moveTo(ex + r, ey);
      x.arc(ex, ey, r, 0, TAU);
    }
    x.moveTo(rx * 0.92, 0);
    x.ellipse(0, 0, rx * 0.92, ry * 0.92, 0, 0, TAU);
  } else {
    x.ellipse(0, 0, rx, ry, 0, 0, TAU);
  }
  if (tail <= 0) return;
  if (b.kind === 'think') {
    // 考え中のしっぽ：小さくなっていく丸
    const [ex, ey] = edge(rx, ry, an);
    const c = Math.cos(an);
    const s = Math.sin(an);
    for (const [t, r] of [
      [0.25, 0.16],
      [0.6, 0.11],
      [0.92, 0.07],
    ] as const) {
      const px = ex + c * tail * t;
      const py = ey + s * tail * t;
      const rr = Math.min(rx, ry) * r;
      x.moveTo(px + rr, py);
      x.arc(px, py, rr, 0, TAU);
    }
    return;
  }
  // しっぽ：縁の 2 点から先へ伸びる三角（少し曲げる）
  const w = Math.min(rx, ry) * 0.42;
  const [e1x, e1y] = edge(rx * 0.9, ry * 0.9, an - w / Math.max(rx, ry));
  const [e2x, e2y] = edge(rx * 0.9, ry * 0.9, an + w / Math.max(rx, ry));
  const [ex, ey] = edge(rx, ry, an);
  const tx = ex + Math.cos(an) * tail;
  const ty = ey + Math.sin(an) * tail;
  x.moveTo(e1x, e1y);
  x.quadraticCurveTo((e1x + tx) / 2 + Math.sin(an) * w * 0.25, (e1y + ty) / 2 - Math.cos(an) * w * 0.25, tx, ty);
  x.lineTo(e2x, e2y);
  x.closePath();
}

/** 文字の絵を吹き出しに入れた絵 */
export function bubbleImage(text: HTMLCanvasElement, b: Bubble): HTMLCanvasElement {
  const {rx, ry} = body(b, text.width, text.height);
  const sw = Math.max(0, b.strokeWidth);
  const spike = b.kind === 'shout' ? 1.28 : 1;
  // しっぽがどの向きでも入るよう、四方に同じだけ取る
  const m = Math.ceil(Math.max(0, b.tailLength) + Math.min(rx, ry) * 0.2 + sw * 2 + 4);
  const W = Math.ceil(rx * 2 * spike + m * 2);
  const H = Math.ceil(ry * 2 * spike + m * 2);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const x = cv.getContext('2d')!;
  x.translate(W / 2, H / 2);
  x.lineJoin = 'round';
  // 線は 2 倍の太さで先に描き、上から塗ると、体としっぽがひとつながりの縁になる
  if (sw > 0) {
    shapePath(x, b, rx, ry);
    x.lineWidth = sw * 2;
    x.strokeStyle = b.stroke;
    x.stroke();
  }
  shapePath(x, b, rx, ry);
  x.fillStyle = b.fill;
  x.fill('nonzero');
  x.drawImage(text, -text.width / 2, -text.height / 2);
  return cv;
}

/** 文字の位置から、向けたい所（立ち絵など）への角度（度。0 が右、90 が下） */
export function angleTo(from: {x: number; y: number}, to: {x: number; y: number}): number {
  return Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}
