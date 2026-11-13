// 画像・動画・テキスト・図形の見た目：アニメーション・フェード・揺れ・映像エフェクトの計算と、テキスト・図形の描画。
// 書き出し（core/src/render.rs の visual_filters）と同じ計算になるようにそろえる。
// テキスト・図形は、ここで描いた画像をそのまま書き出しにも渡す（画面と動画で同じ見た目にするため）。

import type {Ease, Effect, Look, Project, ShapeClip, SubtitleCustom, TextClip, Transform, VisualClip, VoiceClip} from '../model';
import {lineOfSubtitle} from '../model';

function ease(e: Ease, p: number): number {
  const q = Math.min(1, Math.max(0, p));
  if (e === 'in') return q * q;
  if (e === 'out') return 1 - (1 - q) * (1 - q);
  if (e === 'inOut') return q < 0.5 ? 2 * q * q : 1 - 2 * (1 - q) * (1 - q);
  return q;
}

export interface VisualState {
  transform: Transform;
  rotation: number;
  /** 不透明度（フェードを含む） */
  alpha: number;
  /** Canvas の filter（明るさ・コントラスト・彩度・反転。ぼかしは scale を掛けた px で別に足す） */
  filter: string;
  /** ぼかしの半径（書き出しの画面 px） */
  blur: number;
}

/**
 * その時点の見た目。local は アイテムの頭からのフレーム、dur はアイテムの長さ（フレーム）、abs はプロジェクトの頭からの秒
 */
export function visualAt(t: Transform, look: Look | undefined, local: number, dur: number, fps: number, abs: number): VisualState {
  const l = look;
  const d = dur / fps;
  const e = l?.anim ? ease(l.anim.ease, local / fps / Math.max(1e-3, d)) : 0;
  const to = l?.anim?.to;
  const mix = (a: number, b: number | undefined) => (b === undefined ? a : a + (b - a) * e);
  const tr: Transform = {
    x: mix(t.x, to?.x),
    y: mix(t.y, to?.y),
    scale: mix(t.scale, to?.scale),
    opacity: mix(Math.min(1, Math.max(0, t.opacity)), to ? Math.min(1, Math.max(0, to.opacity)) : undefined),
  };
  const rotation = mix(l?.rotation ?? 0, l?.anim ? l.anim.rotation : undefined);
  let alpha = tr.opacity;
  const sec = local / fps;
  if (l?.fadeIn) alpha *= Math.min(1, sec / (l.fadeIn / fps));
  if (l?.fadeOut) alpha *= Math.min(1, Math.max(0, (d - sec) / (l.fadeOut / fps)));
  const filters: string[] = [];
  let blur = 0;
  for (const fx of l?.effects ?? []) {
    if (fx.kind === 'color') {
      if (fx.brightness !== 1) filters.push(`brightness(${fx.brightness})`);
      if (fx.contrast !== 1) filters.push(`contrast(${fx.contrast})`);
      if (fx.saturation !== 1) filters.push(`saturate(${fx.saturation})`);
    } else if (fx.kind === 'mono') filters.push('saturate(0)');
    else if (fx.kind === 'invert') filters.push('invert(1)');
    else if (fx.kind === 'blur') blur += Math.max(0, fx.radius);
    else if (fx.kind === 'wave' || fx.kind === 'swirl')
      continue; // distort で
    else if (fx.kind === 'shake') {
      tr.x += fx.amount * Math.sin(2 * Math.PI * fx.speed * abs);
      tr.y += fx.amount * Math.cos(2 * Math.PI * fx.speed * abs * 1.37);
    }
  }
  return {transform: tr, rotation, alpha, filter: filters.join(' '), blur};
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
  const f = [st.filter, st.blur > 0 ? `blur(${st.blur * viewScale}px)` : ''].filter(Boolean).join(' ');
  if (f) ctx.filter = f;
  ctx.translate(cx, cy);
  if (st.rotation) ctx.rotate((st.rotation * Math.PI) / 180);
  ctx.drawImage(img, (-size[0] * s) / 2, (-size[1] * s) / 2, size[0] * s, size[1] * s);
  ctx.restore();
  return {x: cx - (bw * s) / 2, y: cy - (bh * s) / 2, w: bw * s, h: bh * s};
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
}

/** 縦書きで横に倒して描く文字（伸ばし棒・括弧など） */
const ROTATE_V = new Set([...'ー－―〜～…‥（）「」『』【】〔〕()[]{}<>＜＞-=＝']);

/** 1 文字ずつ出すときに数える文字の数（改行は数えない） */
export const textCharCount = (text: string) => Array.from(text.replace(/\n/g, '')).length;

/** テキストアイテムの画像（大きさは文字に合わせる。縁取りの分だけ余白を足す）。字幕の「個別に設定」では組み方と飾りも */
export function textImage(c: TextClip, ex: TextExtra = {}): HTMLCanvasElement {
  const key = JSON.stringify(['t', c.text, c.fontFamily, c.fontSize, c.color, c.outlineColor, c.outlineWidth, c.bold, c.italic, c.align, ex]);
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
    for (const para of (c.text || ' ').split('\n')) {
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
    const pad = Math.ceil(c.outlineWidth + c.fontSize * 0.1);
    const box = ex.boxColor ? Math.max(0, ex.boxPadding ?? 16) : 0;
    const sh = ex.shadowColor ? Math.abs(ex.shadowOffset ?? 4) : 0;
    const widths = lines.map(l => m.measureText(l).width);
    const longest = Math.max(1, ...lines.map(l => Array.from(l).length));
    // 文字が占める大きさ
    const tw = ex.vertical ? lineH * lines.length : Math.ceil(Math.max(...widths));
    const th = ex.vertical ? Math.ceil(longest * charStep) : lineH * lines.length;
    const edge = pad + box;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, tw + edge * 2 + sh);
    cv.height = Math.max(1, th + edge * 2 + sh);
    const x = cv.getContext('2d')!;
    if (box) {
      x.fillStyle = ex.boxColor!;
      x.beginPath();
      x.roundRect(pad, pad, tw + box * 2 + sh, th + box * 2 + sh, Math.min(box, c.fontSize * 0.3));
      x.fill();
    }
    x.font = font;
    x.letterSpacing = `${ls}px`;
    x.textBaseline = 'middle';
    x.lineJoin = 'round';
    x.miterLimit = 2;
    // 出す文字の位置（1 文字ずつ出すときも位置は全部出したときと同じ）
    let left = ex.visible ?? Infinity;
    const glyphs: {s: string; px: number; py: number; rot: boolean}[] = [];
    lines.forEach((l, i) => {
      const chars = Array.from(l);
      const n = Math.max(0, Math.min(chars.length, left));
      left -= chars.length;
      if (!n) return;
      if (ex.vertical) {
        // 右の列から左へ。揃えは列の中の上・中央・下
        const colX = edge + tw - lineH * i - lineH / 2;
        const colH = chars.length * charStep;
        const y0 = edge + (c.align === 'left' ? 0 : c.align === 'right' ? th - colH : (th - colH) / 2);
        for (let k = 0; k < n; k++) glyphs.push({s: chars[k], px: colX, py: y0 + charStep * k + charStep / 2, rot: ROTATE_V.has(chars[k])});
      } else {
        const lx = edge + (c.align === 'left' ? 0 : c.align === 'right' ? tw - widths[i] : (tw - widths[i]) / 2);
        glyphs.push({s: chars.slice(0, n).join(''), px: lx, py: edge + lineH * i + lineH / 2, rot: false});
      }
    });
    const paint = (dx: number, dy: number, fill: string, stroke: boolean) => {
      for (const g of glyphs) {
        x.save();
        x.translate(g.px + dx, g.py + dy);
        if (g.rot) x.rotate(Math.PI / 2);
        x.textAlign = ex.vertical ? 'center' : 'left';
        if (stroke && c.outlineWidth > 0 && c.outlineColor) {
          x.strokeStyle = c.outlineColor;
          x.lineWidth = c.outlineWidth * 2;
          x.strokeText(g.s, 0, 0);
        }
        x.fillStyle = fill;
        x.fillText(g.s, 0, 0);
        x.restore();
      }
    };
    if (sh) paint(ex.shadowOffset ?? 4, ex.shadowOffset ?? 4, ex.shadowColor!, false);
    paint(0, 0, c.color, true);
    return cv;
  });
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
    }
    if (c.shape === 'line') {
      x.strokeStyle = c.fill;
      x.lineWidth = Math.max(1, H);
      x.lineCap = 'round';
      x.stroke();
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

/** テキスト・図形の画像（画像・動画は null） */
export function itemImage(c: VisualClip): HTMLCanvasElement | null {
  if (c.type === 'text') return textImage(c);
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
  const items: {id: string; img: HTMLCanvasElement; key: unknown}[] = [];
  for (const c of project.clips) {
    if (c.type === 'text' || c.type === 'shape') {
      const key =
        c.type === 'text'
          ? ['t', c.text, c.fontFamily, c.fontSize, c.color, c.outlineColor, c.outlineWidth, c.bold, c.italic, c.align]
          : ['s', c.shape, c.width, c.height, c.fill, c.stroke, c.strokeWidth];
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
  for (const {id, img, key} of items) {
    const name = `item-${hashKey(JSON.stringify(key))}`;
    let path = await a.portraitPngPath(name);
    if (!path) {
      const png = await new Promise<Uint8Array>((resolve, reject) =>
        img.toBlob(b => (b ? b.arrayBuffer().then(x => resolve(new Uint8Array(x)), reject) : reject(new Error('画像にできません'))), 'image/png'),
      );
      path = await a.writePortraitPng(name, png);
    }
    out[id] = path;
  }
  return out;
}
