// 画像・動画・テキスト・図形の見た目：アニメーション・フェード・揺れ・映像エフェクトの計算と、テキスト・図形の描画。
// 書き出し（core/src/render.rs の visual_filters）と同じ計算になるようにそろえる。
// テキスト・図形は、ここで描いた画像をそのまま書き出しにも渡す（画面と動画で同じ見た目にするため）。

import type {Effect, Look, Project, ShapeClip, SubtitleCustom, TextClip, Transform, VisualClip, VoiceClip} from '../model';
import {animStateAt, chromaWeights, colorGrade, cropKeep, lineOfSubtitle, maskAlpha, type MediaClip} from '../model';
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
}

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
  const rotation = st.rotation;
  const c01 = (v: number) => Math.min(1, Math.max(0, v));
  let alpha = tr.opacity;
  const sec = local / fps;
  if (l?.fadeIn) alpha *= Math.min(1, sec / (l.fadeIn / fps));
  if (l?.fadeOut) alpha *= Math.min(1, Math.max(0, (d - sec) / (l.fadeOut / fps)));
  // 登場（残り 1 → 0。だんだん遅く）と退場（進み 0 → 1。だんだん速く）
  const [fw, fh] = frame ?? [1920, 1080];
  const apply = (m: Look['enter'], k: (len: number) => number) => {
    if (!m || m.frames <= 0) return;
    const len = Math.min(m.frames / fps, Math.max(1e-3, d));
    const v = k(len);
    if (m.kind === 'slideLeft') tr.x -= fw * v;
    else if (m.kind === 'slideRight') tr.x += fw * v;
    else if (m.kind === 'slideUp') tr.y -= fh * v;
    else if (m.kind === 'slideDown') tr.y += fh * v;
    else tr.scale *= 1 - v;
  };
  // なめらか（押し出し）は 3p²−2p³（出ていく側と入る側の和がいつも 1）。書き出しと同じ式
  const smooth = (p: number) => p * p * (3 - 2 * p);
  apply(l?.enter, len => (l?.enter?.smooth ? 1 - smooth(c01(sec / len)) : (1 - c01(sec / len)) ** 2));
  apply(l?.exit, len => (l?.exit?.smooth ? smooth(c01((sec - Math.max(0, d - len)) / len)) : c01((sec - Math.max(0, d - len)) / len) ** 2));
  const filters: string[] = [];
  let blur = 0;
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
    } else if (fx.kind === 'blur') blur += Math.max(0, fx.radius);
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
export function sourceView(img: CanvasImageSource, size: [number, number], m: MediaClip, still: boolean, key = ''): {img: CanvasImageSource; size: [number, number]} {
  if (!m.crop && !m.mask && !m.chroma) return {img, size};
  const [l, t, kw, kh] = cropKeep(m.crop);
  const out: [number, number] = [size[0] * kw, size[1] * kh];
  const iw = (img as HTMLVideoElement).videoWidth || (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width;
  const ih = (img as HTMLVideoElement).videoHeight || (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height;
  if (!iw || !ih) return {img, size};
  const ck = still ? JSON.stringify([key, iw, ih, m.crop, m.mask, m.chroma]) : '';
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
];

/** テキストアイテムの画像（大きさは文字に合わせる。縁取りの分だけ余白を足す）。字幕の「個別に設定」では組み方と飾りも */
export function textImage(c: TextClip, ex: TextExtra = {}): HTMLCanvasElement {
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
    const pad = Math.ceil(c.outlineWidth + o2 + c.fontSize * 0.1);
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
    const glyphs: {s: string; px: number; py: number; rot: boolean; punct?: boolean; k?: number; sx?: number}[] = [];
    const shownAll = ex.visible ?? Infinity;
    lines.forEach((l, i) => {
      const chars = Array.from(l);
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
        for (let k = 0; k < n; k++) glyphs.push({s: chars[k], px: colX, py: y0 + charStep * k + charStep / 2, rot: ROTATE_V.has(chars[k]), punct: PUNCT_V.has(chars[k])});
        for (const pc of pieces) {
          if (!pc.ruby || pc.at >= shownAll) continue;
          const rc = Array.from(pc.ruby);
          const span = Array.from(pc.text).length * charStep;
          const step = Math.min(rs + ls * rk, span / rc.length);
          const top = y0 + (pc.at - at0) * charStep + (span - step * rc.length) / 2;
          rc.forEach((r, k) => glyphs.push({s: r, px: colX + lineH / 2 + rh / 2, py: top + step * k + step / 2, rot: ROTATE_V.has(r), k: rk}));
        }
      } else {
        const lx = edge + (c.align === 'left' ? 0 : c.align === 'right' ? tw - widths[i] : (tw - widths[i]) / 2);
        const rh = rhOf[i];
        const py = edge + off[i] + rh + lineH / 2;
        glyphs.push({s: chars.slice(0, n).join(''), px: lx, py, rot: false});
        let x0 = lx;
        for (const pc of pieces) {
          const wb = m.measureText(pc.text).width;
          if (pc.ruby && pc.at < shownAll) {
            const wr = m.measureText(pc.ruby).width * rk;
            glyphs.push({s: pc.ruby, px: wr <= wb ? x0 + (wb - wr) / 2 : x0, py: py - lineH / 2 - rh / 2, rot: false, k: rk, sx: wr <= wb ? 1 : wb / wr});
          }
          x0 += wb;
        }
      }
    });
    const outline = c.outlineWidth > 0 && c.outlineColor ? c.outlineWidth : 0;
    const paint = (dx: number, dy: number, fill: string, stroke: boolean, all = false) => {
      for (const g of glyphs) {
        x.save();
        // 縦書きの句読点は、横書きの字形（左下）を升目の右上へ
        x.translate(g.px + dx + (g.punct ? c.fontSize * 0.6 : 0), g.py + dy - (g.punct ? c.fontSize * 0.6 : 0));
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
