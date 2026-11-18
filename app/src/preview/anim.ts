// 動く図形（紙吹雪などの粒・進行バー・グラフ）をコマごとに描く。プレビューも書き出しも、ここで描いた絵を使う
// （書き出しは bakeItemImages がコマごとの画像を渡し、core/src/model.rs の ShapeAnim::sequence の間隔で並べる）

import type {Chart, Lines, Marker, Particles, ProgressBar, ShapeAnim, ShapeClip} from '../model';

/** 粒をくり返す長さ（フレーム）。Rust の ShapeAnim::particle_loop と同じ */
export const particleLoop = (fps: number) => Math.max(1, fps) * 4;

/** 集中線などをくり返す長さ（2 コマごとに描き直す 8 通り） */
export const LINES_LOOP = 16;

/** 画像の並べ方：何フレームごとの画像か・くり返すか。Rust の ShapeAnim::sequence と同じ */
export function animStep(a: ShapeAnim, width: number, duration: number): {step: number; loop: boolean} {
  if (a.kind === 'particles' || a.kind === 'lines') return {step: 1, loop: true};
  if (a.kind === 'progress') return {step: Math.max(1, Math.floor(duration / Math.max(1, Math.round(width)))), loop: false};
  return {step: 1, loop: false};
}

/** 書き出しに渡す画像のコマ（アイテムの頭からのフレーム）の一覧 */
export function animFrames(c: ShapeClip, fps: number): number[] {
  const a = c.anim!;
  const {step} = animStep(a, c.width, c.duration);
  if (a.kind === 'lines') return Array.from({length: a.flicker ? LINES_LOOP : 1}, (_, k) => k);
  const n = a.kind === 'particles' ? particleLoop(fps) : a.kind === 'chart' ? Math.min(c.duration, Math.max(1, a.grow)) + 1 : Math.ceil(c.duration / step);
  return Array.from({length: Math.max(1, n)}, (_, k) => k * step);
}

/** アイテムの頭から local フレームで出す絵のコマ（書き出しで並べる画像と同じコマに丸める） */
export function animFrameAt(c: ShapeClip, local: number, fps: number): number {
  const a = c.anim!;
  const f = Math.max(0, Math.floor(local));
  if (a.kind === 'particles') return f % particleLoop(fps);
  if (a.kind === 'lines') return a.flicker ? f % LINES_LOOP : 0;
  if (a.kind === 'chart') return Math.min(f, Math.min(c.duration, Math.max(1, a.grow)));
  const {step} = animStep(a, c.width, c.duration);
  return Math.min(Math.floor(f / step), Math.ceil(c.duration / step) - 1) * step;
}

/** 同じ種から同じ並びの乱数 */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

/** 粒：4 秒でちょうど元に戻る動き（速さ・揺れ・回転を、くり返しの長さの整数倍にする）ので、つなぎ目が見えない */
function drawParticles(x: CanvasRenderingContext2D, a: Particles, id: string, W: number, H: number, f: number, fps: number) {
  const r = rng(`${id}:${a.type}`);
  const u = f / particleLoop(fps);
  const n = Math.max(1, Math.min(600, Math.round(a.amount)));
  const colors = a.colors.length ? a.colors : ['#ffffff'];
  const sp = Math.max(1, Math.min(3, Math.round(a.speed)));
  for (let i = 0; i < n; i++) {
    const x0 = r() * W;
    const p0 = r();
    const k = sp + (r() < 0.35 ? 1 : 0);
    const sway = (0.02 + r() * 0.05) * W;
    const sf = 1 + Math.floor(r() * 2);
    const p1 = r();
    const rf = Math.floor(r() * 5) - 2 || 1;
    const p2 = r();
    const s = a.size * (0.6 + r() * 0.8);
    const col = colors[Math.floor(r() * colors.length)];
    const m = s * 2;
    if (a.type === 'sparkle') {
      // キラキラ：動かずにまたたく
      const tw = 0.5 + 0.5 * Math.sin(TAU * (u * (1 + (i % 3)) + p1));
      x.save();
      x.globalAlpha = tw;
      x.translate(x0, p0 * H);
      x.rotate(TAU * p2);
      x.scale(0.5 + tw * 0.7, 0.5 + tw * 0.7);
      x.fillStyle = col;
      x.beginPath();
      for (let j = 0; j < 8; j++) {
        const rr = j % 2 ? s * 0.16 : s * 0.7;
        const an = (j * Math.PI) / 4;
        x.lineTo(Math.cos(an) * rr, Math.sin(an) * rr);
      }
      x.closePath();
      x.fill();
      x.restore();
      continue;
    }
    const y = (((p0 + u * k) % 1) + 1) % 1;
    const py = y * (H + m * 2) - m;
    const px = x0 + sway * Math.sin(TAU * (u * sf + p1));
    x.save();
    x.translate(px, py);
    if (a.type === 'snow') {
      const g = x.createRadialGradient(0, 0, 0, 0, 0, s / 2);
      g.addColorStop(0, col);
      g.addColorStop(0.6, col);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.globalAlpha = 0.9;
      x.fillStyle = g;
      x.beginPath();
      x.arc(0, 0, s / 2, 0, TAU);
      x.fill();
    } else {
      // 紙吹雪・花びら：回りながら、裏返るように縦につぶれる
      x.rotate(TAU * (u * rf + p2));
      x.scale(1, Math.max(0.15, Math.abs(Math.cos(TAU * (u * (sf + 1) + p2)))));
      x.fillStyle = col;
      x.beginPath();
      if (a.type === 'confetti') x.rect(-s / 2, -s / 4, s, s / 2);
      else x.ellipse(0, 0, s / 2, s / 3.2, 0, 0, TAU);
      x.fill();
    }
    x.restore();
  }
}

/** 進行バー：頭から終わりまでで伸びる。マーカーの所で区切り、名前を出す */
function drawProgress(x: CanvasRenderingContext2D, c: ShapeClip, a: ProgressBar, W: number, H: number, f: number, markers: Marker[]) {
  const ratio = c.duration > 1 ? Math.min(1, f / (c.duration - 1)) : 1;
  const chapters = a.chapters ? markers.map(m => (m.frame - c.start) / c.duration).filter(q => q > 0.001 && q < 0.999) : [];
  const withLabels = a.chapters && a.labels && H >= 24;
  const barH = withLabels ? Math.max(4, Math.round(H * 0.38)) : H;
  const top = H - barH;
  const rad = Math.min(barH / 2, 8);
  const shape = () => {
    x.beginPath();
    x.roundRect(0, top, W, barH, rad);
  };
  x.save();
  shape();
  x.clip();
  x.fillStyle = a.trackColor;
  x.fillRect(0, top, W, barH);
  x.fillStyle = c.fill;
  x.fillRect(0, top, Math.round(W * ratio), barH);
  // 章の区切り（すき間）
  x.globalCompositeOperation = 'destination-out';
  for (const q of chapters) x.fillRect(Math.round(q * W) - 1.5, top, 3, barH);
  x.restore();
  if (withLabels) {
    const names = [0, ...chapters];
    const ms = a.chapters ? markers.filter(m => (m.frame - c.start) / c.duration > 0.001 && (m.frame - c.start) / c.duration < 0.999) : [];
    const fs = Math.max(10, Math.min(22, Math.round((H - barH) * 0.7)));
    x.font = `bold ${fs}px sans-serif`;
    x.textBaseline = 'bottom';
    x.fillStyle = c.stroke || '#ffffff';
    for (let i = 0; i < names.length; i++) {
      const name = i === 0 ? '' : (ms[i - 1]?.name ?? '');
      if (!name) continue;
      const left = names[i] * W + 4;
      const right = (names[i + 1] ?? 1) * W - 4;
      if (right - left < fs) continue;
      x.save();
      x.beginPath();
      x.rect(left, 0, right - left, top);
      x.clip();
      x.fillText(name, left, top - 3);
      x.restore();
    }
  }
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('ja-JP') : String(Math.round(v * 10) / 10));

/** グラフ：棒・円・折れ線。grow フレームかけて伸びる（棒は少しずつずらして） */
function drawChart(x: CanvasRenderingContext2D, a: Chart, W: number, H: number, f: number) {
  const items = a.items.length ? a.items : [{label: '', value: 1, color: '#5AC8FA'}];
  const g = Math.max(1, a.grow);
  const fs = Math.max(12, Math.round(Math.min(W, H) * 0.055));
  x.font = `bold ${fs}px sans-serif`;
  x.fillStyle = a.textColor;
  x.strokeStyle = a.textColor;
  const label = (v: number) => (a.showValues ? `${fmt(v)}${a.unit}` : '');
  if (a.chart === 'pie') {
    const total = items.reduce((s, it) => s + Math.max(0, it.value), 0) || 1;
    const R = Math.min(W * 0.6, H) / 2 - fs * 0.5;
    const cx = Math.min(W * 0.32, R + fs);
    const cy = H / 2;
    const sweep = ease(f / g) * TAU;
    let at = -Math.PI / 2;
    for (const it of items) {
      const span = (Math.max(0, it.value) / total) * TAU;
      const end = Math.min(at + span, -Math.PI / 2 + sweep);
      if (end > at) {
        x.fillStyle = it.color;
        x.beginPath();
        x.moveTo(cx, cy);
        x.arc(cx, cy, R, at, end);
        x.closePath();
        x.fill();
      }
      at += span;
    }
    // 凡例
    x.textBaseline = 'middle';
    const lx = cx + R + fs;
    const lh = Math.min(fs * 1.6, (H - fs) / items.length);
    items.forEach((it, i) => {
      const y = cy - ((items.length - 1) * lh) / 2 + i * lh;
      x.globalAlpha = ease((f / g) * 1.5 - i * 0.1);
      x.fillStyle = it.color;
      x.fillRect(lx, y - fs * 0.35, fs * 0.7, fs * 0.7);
      x.fillStyle = a.textColor;
      const pct = a.showValues ? `  ${Math.round((Math.max(0, it.value) / total) * 100)}%` : '';
      x.fillText(`${it.label}${pct}`, lx + fs, y);
    });
    x.globalAlpha = 1;
    return;
  }
  const max = Math.max(...items.map(it => it.value), 0) || 1;
  const min = Math.min(0, ...items.map(it => it.value));
  const padB = fs * 1.6;
  const padT = a.showValues ? fs * 1.5 : fs * 0.5;
  const plotH = H - padB - padT;
  const yOf = (v: number) => padT + plotH * (1 - (v - min) / (max - min || 1));
  const n = items.length;
  const slot = W / n;
  x.textAlign = 'center';
  // 下の線と、項目の名前
  x.globalAlpha = 0.5;
  x.fillRect(0, yOf(0), W, Math.max(1, fs * 0.08));
  x.globalAlpha = 1;
  x.textBaseline = 'top';
  items.forEach((it, i) => x.fillText(it.label, slot * (i + 0.5), H - padB + fs * 0.3, slot * 0.95));
  x.textBaseline = 'bottom';
  if (a.chart === 'bar') {
    items.forEach((it, i) => {
      // 棒は少しずつずらして伸びる
      const t = ease((f / g) * (1 + n * 0.15) - i * 0.15);
      const v = it.value * t;
      const bw = slot * 0.6;
      const y0 = yOf(0);
      const y1 = yOf(v);
      x.fillStyle = it.color;
      x.beginPath();
      x.roundRect(slot * (i + 0.5) - bw / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0)), [Math.min(bw * 0.15, 8), Math.min(bw * 0.15, 8), 0, 0]);
      x.fill();
      x.fillStyle = a.textColor;
      if (t > 0.02) x.fillText(label(v), slot * (i + 0.5), Math.min(y0, y1) - fs * 0.2);
    });
    return;
  }
  // 折れ線：左から右へ線を引いていく
  const t = ease(f / g) * (n - 1 || 1);
  const pts = items.map((it, i) => [slot * (i + 0.5), yOf(it.value)] as const);
  x.strokeStyle = items[0].color;
  x.lineWidth = Math.max(2, fs * 0.22);
  x.lineJoin = 'round';
  x.lineCap = 'round';
  x.beginPath();
  x.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length && i - 1 < t; i++) {
    const q = Math.min(1, t - (i - 1));
    x.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * q, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * q);
  }
  x.stroke();
  pts.forEach(([px, py], i) => {
    if (i > t + 1e-6) return;
    x.fillStyle = items[i].color;
    x.beginPath();
    x.arc(px, py, Math.max(3, fs * 0.3), 0, TAU);
    x.fill();
    x.fillStyle = a.textColor;
    x.fillText(label(items[i].value), px, py - fs * 0.5);
  });
}

/** 集中線・スピード線・ガーン・怒りマーク。ちらつかせるときは 2 コマごとに線の並びを変える */
function drawLines(x: CanvasRenderingContext2D, a: Lines, id: string, W: number, H: number, f: number) {
  const r = rng(`${id}:${a.type}:${Math.floor(f / 2)}`);
  const n = Math.max(4, Math.min(400, Math.round(a.density)));
  const th = Math.max(1, a.thickness);
  x.fillStyle = a.color;
  x.strokeStyle = a.color;
  if (a.type === 'focus') {
    // 画面の外から真ん中へ向かう、先の細い三角
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.hypot(W, H) / 2;
    const inner = Math.max(0, Math.min(0.9, a.inner));
    for (let i = 0; i < n; i++) {
      const an = TAU * (i / n + (r() - 0.5) / n);
      const len = inner + (1 - inner) * r() * 0.35;
      const w = th * (0.6 + r() * 1.4);
      const ca = Math.cos(an);
      const sa = Math.sin(an);
      // 中の端は楕円（画面の縦横比に合わせる）
      const ix = cx + ca * (W / 2) * len;
      const iy = cy + sa * (H / 2) * len;
      x.beginPath();
      x.moveTo(ix, iy);
      x.lineTo(cx + ca * R * 1.1 - sa * w, cy + sa * R * 1.1 + ca * w);
      x.lineTo(cx + ca * R * 1.1 + sa * w, cy + sa * R * 1.1 - ca * w);
      x.closePath();
      x.fill();
    }
    return;
  }
  if (a.type === 'speed') {
    // 横に流れる線（両端は細く）
    for (let i = 0; i < n; i++) {
      const y = r() * H;
      const len = W * (0.15 + r() * 0.5);
      const x0 = r() * (W + len) - len;
      const w = th * (0.4 + r());
      const g = x.createLinearGradient(x0, 0, x0 + len, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.3, a.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      x.fillRect(x0, y - w / 2, len, w);
    }
    return;
  }
  if (a.type === 'shock') {
    // ガーン：上から垂れる縦線（上が太く、下で消える）
    for (let i = 0; i < n; i++) {
      const px = ((i + r() * 0.8) / n) * W;
      const len = H * (0.35 + r() * 0.55);
      const w = th * (0.5 + r());
      const g = x.createLinearGradient(0, 0, 0, len);
      g.addColorStop(0, a.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      x.beginPath();
      x.moveTo(px - w, 0);
      x.lineTo(px + w, 0);
      x.lineTo(px, len);
      x.closePath();
      x.fill();
    }
    return;
  }
  // 怒りマーク：四つの曲がった線が真ん中で向かい合う。ちらつかせるときは少し脈打つ
  const s = Math.min(W, H) * 0.42 * (a.flicker ? 1 + 0.06 * Math.sin((TAU * f) / LINES_LOOP) : 1);
  x.save();
  x.translate(W / 2, H / 2);
  x.lineWidth = Math.max(2, th * 1.6);
  x.lineCap = 'round';
  for (let k = 0; k < 4; k++) {
    x.save();
    x.rotate((k * Math.PI) / 2);
    x.beginPath();
    x.moveTo(s * 0.18, -s * 0.95);
    x.quadraticCurveTo(s * 0.2, -s * 0.2, s * 0.95, -s * 0.18);
    x.stroke();
    x.restore();
  }
  x.restore();
}

const cache = new Map<string, HTMLCanvasElement>();

/** そのコマの絵（同じコマは使い回す。プレビューで毎コマ描き直さないように少しだけ覚える） */
export function animImage(c: ShapeClip, frame: number, fps: number, markers: Marker[] = [], keep = true): HTMLCanvasElement {
  const a = c.anim!;
  const key = JSON.stringify([c.id, a, c.width, c.height, c.fill, c.stroke, c.duration, c.start, frame, fps, a.kind === 'progress' ? markers.map(m => [m.frame, m.name]) : 0]);
  const hit = cache.get(key);
  if (hit) return hit;
  const W = Math.max(1, Math.round(c.width));
  const H = Math.max(1, Math.round(c.height));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const x = cv.getContext('2d')!;
  if (a.kind === 'particles') drawParticles(x, a, c.id, W, H, frame, fps);
  else if (a.kind === 'lines') drawLines(x, a, c.id, W, H, frame);
  else if (a.kind === 'progress') drawProgress(x, c, a, W, H, frame, markers);
  else drawChart(x, a, W, H, frame);
  // 大きな絵が多いので、覚えるのは少しだけ（書き出しでは覚えない）
  if (keep) {
    cache.set(key, cv);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  return cv;
}

/** 書き出しの画像の名前に使う鍵（同じ絵なら作り直さない） */
export function animKey(c: ShapeClip, frame: number, fps: number, markers: Marker[]): unknown {
  return [
    'anim',
    c.anim,
    c.width,
    c.height,
    c.fill,
    c.stroke,
    c.duration,
    c.anim?.kind === 'progress' ? [c.start, markers.map(m => [m.frame, m.name])] : c.anim?.kind === 'particles' || c.anim?.kind === 'lines' ? c.id : 0,
    frame,
    fps,
  ];
}

export const LINES_PRESET: Record<Lines['type'], {label: string; color: string; density: number; inner: number; thickness: number; flicker: boolean}> = {
  focus: {label: '集中線', color: '#000000', density: 120, inner: 0.55, thickness: 6, flicker: true},
  speed: {label: 'スピード線', color: '#FFFFFF', density: 60, inner: 0, thickness: 4, flicker: true},
  shock: {label: 'ガーン', color: '#2B2B5A', density: 26, inner: 0, thickness: 6, flicker: false},
  anger: {label: '怒りマーク', color: '#E0201B', density: 4, inner: 0, thickness: 8, flicker: true},
};

export const PARTICLE_PRESET: Record<Particles['type'], {label: string; amount: number; size: number; speed: number; colors: string[]}> = {
  confetti: {label: '紙吹雪', amount: 140, size: 18, speed: 2, colors: ['#FF3B30', '#FFCC00', '#34C759', '#5AC8FA', '#AF52DE', '#FF9500']},
  snow: {label: '雪', amount: 160, size: 10, speed: 1, colors: ['#FFFFFF']},
  petals: {label: '花びら', amount: 70, size: 20, speed: 1, colors: ['#FFB7C5', '#FFD1DC', '#FFC0CB']},
  sparkle: {label: 'キラキラ', amount: 50, size: 26, speed: 1, colors: ['#FFF6C8', '#FFFFFF', '#FFE27A']},
};
