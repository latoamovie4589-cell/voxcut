// PSD の読み込みと合成（Photoshop と同じ見た目にする）
// - 描画モード：Canvas の globalCompositeOperation が Photoshop と同じ式のものはそれを使い、違うものは画素の計算で行う
// - グループ：「通過」は下の絵にそのまま重ね、それ以外（「通常」も）は単独で合成してから重ねる
// - クリッピング：下のレイヤー（土台）の形の中で重ね、まとめて土台の描画モードと不透明度で重ねる
// - マスク（ピクセル・ベクトル）・塗りの不透明度・調整レイヤー・ブレンド条件（Blend If）
// レイヤーごとの下ごしらえ（マスクをかけた画像など）は表示状態によらないので、レイヤーに結びつけて取っておく。

import {readPsd, type BlendMode, type Layer, type LayerMaskData, type LayerVectorMask, type PixelData, type AdjustmentLayer, type Color} from 'ag-psd';
import type {PsdDoc, PsdNode, Visibility} from './types';
import {renderLayerWithEffects} from './effects';

// ───────────── 読み込み ─────────────

export function loadPsd(buf: ArrayBuffer): PsdDoc {
  // 画素は自分でキャンバスにする（16・32 ビットもここで 8 ビットにする。読み返すキャンバスは CPU 側に置く）
  const psd = readPsd(buf, {skipThumbnail: true, useImageData: true});
  const toCanvas = (o: {canvas?: HTMLCanvasElement; imageData?: PixelData}) => {
    if (!o.imageData) return;
    o.canvas = pixelsToCanvas(o.imageData);
    delete o.imageData;
  };
  const byId = new Map<string, PsdNode>();
  const walk = (layers: Layer[] | undefined, parent: string | null): PsdNode[] => {
    // ag-psd は下から上の順。画面で上のものを先にする
    const list = [...(layers ?? [])].reverse();
    return list.map((l, i) => {
      toCanvas(l);
      if (l.mask) toCanvas(l.mask);
      if (l.realMask) toCanvas(l.realMask);
      const id = parent === null ? String(i) : `${parent}/${i}`;
      const name = l.name ?? '';
      const n: PsdNode = {id, name, kind: l.children ? 'group' : 'layer', visible: !l.hidden, radio: name.startsWith('*'), forced: name.startsWith('!'), children: [], parent, layer: l};
      byId.set(id, n);
      n.children = walk(l.children, id);
      return n;
    });
  };
  const nodes = walk(psd.children, null);
  toCanvas(psd);
  const doc: PsdDoc = {width: psd.width, height: psd.height, nodes, byId, composite: psd.canvas ?? null, psd};
  for (const n of byId.values()) docOf.set(n, doc);
  return doc;
}

/** ノード → PSD（isVisible で兄弟の「*」を見るため） */
const docOf = new WeakMap<PsdNode, PsdDoc>();

function pixelsToCanvas(p: PixelData): HTMLCanvasElement {
  const {width: w, height: h, data: src} = p;
  const c = newCanvas(w, h);
  if (!w || !h) return c;
  let px: Uint8ClampedArray<ArrayBuffer>;
  if (src instanceof Uint8ClampedArray || src instanceof Uint8Array) {
    px = new Uint8ClampedArray(src.buffer as ArrayBuffer, src.byteOffset, w * h * 4);
  } else {
    px = new Uint8ClampedArray(w * h * 4);
    if (src instanceof Float32Array) {
      // 32 ビットは線形の値。ag-psd と同じくガンマ 2.2 で戻す
      for (let i = 0; i < px.length; i += 4) {
        px[i] = Math.round(Math.pow(src[i], 1 / 2.2) * 255);
        px[i + 1] = Math.round(Math.pow(src[i + 1], 1 / 2.2) * 255);
        px[i + 2] = Math.round(Math.pow(src[i + 2], 1 / 2.2) * 255);
        px[i + 3] = Math.round(src[i + 3] * 255);
      }
    } else {
      for (let i = 0; i < px.length; i++) px[i] = src[i] >>> 8;
    }
  }
  c.getContext('2d', {willReadFrequently: true})!.putImageData(new ImageData(px, w, h), 0, 0);
  return c;
}

// ───────────── 表示状態 ─────────────

const ownVisible = (n: PsdNode, vis: Visibility) => (n.forced ? true : (vis[n.id] ?? n.visible));

/** 兄弟の並び（上が先）の中で、表示する「*」を 1 つ決める（無ければ null） */
function radioChoice(list: PsdNode[], vis: Visibility): PsdNode | null {
  const radios = list.filter(n => n.radio);
  if (!radios.length) return null;
  // 表示を指定されたものがあればそれ（複数なら上のもの）。無ければ保存時の表示のうち上のもの
  return radios.find(n => vis[n.id] === true) ?? radios.find(n => ownVisible(n, vis)) ?? null;
}

/** すべてのノードの、そのノード自体を表示するか（「!」「*」の決まりを当てたあと。親の表示は含まない） */
export function effectiveVisibility(doc: PsdDoc, vis: Visibility): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const visit = (list: PsdNode[]) => {
    const chosen = radioChoice(list, vis);
    for (const n of list) {
      out.set(n.id, n.radio ? n === chosen : ownVisible(n, vis));
      visit(n.children);
    }
  };
  visit(doc.nodes);
  return out;
}

/** そのノード自体を表示するか（「!」「*」の決まりを含む。親の表示は見ない） */
export function isVisible(n: PsdNode, vis: Visibility): boolean {
  if (!n.radio) return ownVisible(n, vis);
  const doc = docOf.get(n);
  if (!doc) return ownVisible(n, vis);
  const siblings = n.parent === null ? doc.nodes : (doc.byId.get(n.parent)?.children ?? [n]);
  return radioChoice(siblings, vis) === n;
}

// ───────────── キャンバスの小物 ─────────────

type Ctx2D = CanvasRenderingContext2D;
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** 文書の座標 (x, y) に置いた画像 */
interface Src {
  c: HTMLCanvasElement;
  x: number;
  y: number;
}
/** 描き込み先（文書の座標 (x, y) から w×h の範囲） */
interface Surf extends Src {
  ctx: Ctx2D;
  w: number;
  h: number;
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}
// 画素を読み返すので CPU 側のキャンバスにする（GPU との行き来を避ける）
const ctxOf = (c: HTMLCanvasElement): Ctx2D => c.getContext('2d', {willReadFrequently: true})!;
function surf(r: Rect): Surf {
  const c = newCanvas(r.w, r.h);
  return {c, ctx: ctxOf(c), x: r.x, y: r.y, w: r.w, h: r.h};
}
const rectOf = (s: Src): Rect => ({x: s.x, y: s.y, w: s.c.width, h: s.c.height});
function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? {x, y, w: r - x, h: btm - y} : null;
}
function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y};
}
function readPixels(s: Src, r: Rect): ImageData {
  return ctxOf(s.c).getImageData(r.x - s.x, r.y - s.y, r.w, r.h);
}
/** 画像 src を dst に、合成方法 op で描く */
function put(dst: Surf, src: Src, op: GlobalCompositeOperation, alpha = 1) {
  dst.ctx.globalCompositeOperation = op;
  dst.ctx.globalAlpha = alpha;
  dst.ctx.drawImage(src.c, src.x - dst.x, src.y - dst.y);
  dst.ctx.globalCompositeOperation = 'source-over';
  dst.ctx.globalAlpha = 1;
}
/** src の形（アルファ）で dst を切り抜く。src の外側は消える */
function cutBy(dst: Surf, src: Src | null) {
  if (!src) return;
  const r = intersect(rectOf(dst), rectOf(src));
  if (!r) return dst.ctx.clearRect(0, 0, dst.w, dst.h);
  put(dst, src, 'destination-in');
  // 念のため外側は自分で消す（Canvas の実装によっては描いた範囲だけに効くため）
  const lx = r.x - dst.x;
  const ty = r.y - dst.y;
  dst.ctx.clearRect(0, 0, dst.w, ty);
  dst.ctx.clearRect(0, ty + r.h, dst.w, dst.h - ty - r.h);
  dst.ctx.clearRect(0, ty, lx, r.h);
  dst.ctx.clearRect(lx + r.w, ty, dst.w - lx - r.w, r.h);
}

// ───────────── 合成 ─────────────

interface Run {
  doc: PsdDoc;
  eff: Map<string, boolean>;
  full: Rect;
}

/** 表示状態で 1 枚に合成する（文書と同じ大きさ、背景は透明） */
export function renderPsd(doc: PsdDoc, vis: Visibility): HTMLCanvasElement {
  const full = {x: 0, y: 0, w: doc.width, h: doc.height};
  const run: Run = {doc, eff: effectiveVisibility(doc, vis), full};
  const out = surf(full);
  // レイヤーの無い PSD（背景だけ）は、保存された合成画像がそのまま絵
  if (!doc.nodes.length && doc.composite) put(out, {c: doc.composite, x: 0, y: 0}, 'copy');
  drawList(run, out, [...doc.nodes].reverse());
  return out.c;
}

/** 下から順のノードを dst に重ねる（クリッピングは土台とまとめる） */
function drawList(run: Run, dst: Surf, list: PsdNode[]) {
  for (let i = 0; i < list.length;) {
    const base = list[i];
    let j = i + 1;
    while (j < list.length && list[j].layer.clipping) j++;
    const clipped = list.slice(i + 1, j);
    i = j;
    // 土台が隠れていれば、クリッピングされたものも出さない
    if (!run.eff.get(base.id)) continue;
    const shown = clipped.filter(n => run.eff.get(n.id));
    if (shown.length) drawClipped(run, dst, base, shown);
    else drawNode(run, dst, base);
  }
}

function drawNode(run: Run, dst: Surf, n: PsdNode) {
  if (n.kind === 'group') drawGroup(run, dst, n);
  else if (n.layer.adjustment) applyAdjustment(run, dst, n.layer);
  else drawLayer(run, dst, n.layer);
}

const fxOn = (l: Layer) => !!l.effects && !l.effects.disabled;

function drawLayer(run: Run, dst: Surf, l: Layer) {
  const fx = layerWithFx(run, l);
  if (fx) return blend(dst, fx, l.blendMode ?? 'normal', l.opacity ?? 1, l, 1);
  const src = layerContent(run, l);
  if (src) blend(dst, src, l.blendMode ?? 'normal', l.opacity ?? 1, l, l.fillOpacity ?? 1);
}

function drawGroup(run: Run, dst: Surf, n: PsdNode) {
  const l = n.layer;
  const mode = l.blendMode ?? 'pass through';
  const opacity = l.opacity ?? 1;
  const kids = [...n.children].reverse();
  const fx = fxOn(l);
  const ab = l.artboard;
  if (ab) {
    // アートボード：枠の中だけに描き、背景の色（白・黒・指定色。透明なら無し）を敷く
    const area = intersect({x: ab.rect.left, y: ab.rect.top, w: ab.rect.right - ab.rect.left, h: ab.rect.bottom - ab.rect.top}, run.full);
    if (!area) return;
    const s = surf(area);
    const bg = ab.backgroundType === 2 ? 'black' : ab.backgroundType === 4 && ab.color ? cssColor(ab.color) : ab.backgroundType === 3 ? null : 'white';
    if (bg) {
      s.ctx.fillStyle = bg;
      s.ctx.fillRect(0, 0, s.w, s.h);
    }
    drawList(run, s, kids);
    return blend(dst, s, 'normal', opacity, l, 1);
  }
  const mask = groupMask(run, l);
  if (mode === 'pass through' && !fx) {
    if (opacity >= 1 && !mask) return drawList(run, dst, kids);
    // 通過のまま不透明度・マスクがあるとき：中身を重ねた絵と元の絵を、不透明度×マスクの割合で混ぜる
    const tmp = surf(dst);
    put(tmp, dst, 'copy');
    drawList(run, tmp, kids);
    mixInto(dst, tmp, opacity, mask);
    return;
  }
  // 中身がすべて「通常」なら、単独で合成しても直接重ねても同じなので手間を省く
  if (mode === 'normal' && opacity >= 1 && !mask && !fx && flattenable(run, kids)) return drawList(run, dst, kids);
  const g = isolate(run, n, fx);
  if (!g) return;
  let src: Src = g;
  if (fx) {
    const r = drawFx(run, l, g);
    if (r) src = {c: r, x: 0, y: 0};
  }
  blend(dst, src, mode === 'pass through' ? 'normal' : mode, opacity, l, 1);
}

/** グループを単独で合成する（マスクをかけた結果。何も無ければ null） */
function isolate(run: Run, n: PsdNode, full: boolean): Surf | null {
  const kids = [...n.children].reverse();
  const area = full ? run.full : intersect(boundsOf(run, kids) ?? {x: 0, y: 0, w: 0, h: 0}, run.full);
  if (!area) return null;
  const s = surf(area);
  drawList(run, s, kids);
  const mask = groupMask(run, n.layer);
  if (mask) cutBy(s, mask);
  return s;
}

/** 表示するものが描く範囲（調整レイヤーは単独のグループでは何も足さないので数えない） */
function boundsOf(run: Run, list: PsdNode[]): Rect | null {
  let r: Rect | null = null;
  for (const n of list) {
    if (!run.eff.get(n.id) || n.layer.clipping) continue;
    if (fxOn(n.layer)) return run.full;
    if (n.kind === 'group') r = union(r, boundsOf(run, n.children));
    else if (!n.layer.adjustment) {
      const c = layerContent(run, n.layer);
      if (c) r = union(r, rectOf(c));
    }
  }
  return r;
}

/** 単独で合成しても結果が変わらない（下の絵を見るものが無い）か */
function flattenable(run: Run, list: PsdNode[]): boolean {
  for (const n of list) {
    if (!run.eff.get(n.id) || n.layer.clipping) continue;
    const l = n.layer;
    if (l.adjustment) return false;
    const mode = l.blendMode ?? 'normal';
    if (n.kind === 'group') {
      if (mode === 'pass through') {
        if (!flattenable(run, [...n.children].reverse())) return false;
      } else if (mode !== 'normal') return false;
    } else if (mode !== 'normal' && mode !== 'dissolve') return false;
    if (blendIfLooksAtBackdrop(l)) return false;
  }
  return true;
}

/** dst を、mix と「不透明度×マスク」の割合で混ぜる（通過グループ用） */
function mixInto(dst: Surf, mix: Surf, opacity: number, mask: Src | null) {
  if (!mask) {
    dst.ctx.globalCompositeOperation = 'destination-out';
    dst.ctx.globalAlpha = opacity;
    dst.ctx.fillRect(0, 0, dst.w, dst.h);
    put(dst, mix, 'lighter', opacity);
    return;
  }
  const t = surf(dst);
  put(t, mask, 'source-over', opacity);
  put(dst, t, 'destination-out');
  put(mix, t, 'destination-in');
  put(dst, mix, 'lighter');
}

/** レイヤー効果を描く（effects.ts）。包括光源とパターンは PSD 全体の設定から渡す */
function drawFx(run: Run, l: Layer, content: Src): HTMLCanvasElement | null {
  const psd = run.doc.psd;
  const env = {globalAngle: psd.imageResources?.globalAngle, globalAltitude: psd.imageResources?.globalAltitude, patterns: psd.patterns};
  return renderLayerWithEffects(l, toFull(run, content), run.full.w, run.full.h, env);
}

/** 文書と同じ大きさのキャンバスにする（レイヤー効果に渡す形） */
function toFull(run: Run, s: Src): HTMLCanvasElement {
  if (s.x === 0 && s.y === 0 && s.c.width === run.full.w && s.c.height === run.full.h) return s.c;
  const f = surf(run.full);
  put(f, s, 'source-over');
  return f.c;
}

// ───────────── クリッピング ─────────────

/**
 * 土台 + クリッピングされたもの。
 * Photoshop は「形（画素の不透明度×マスク）」と「塗り」を分けて考える：
 * 土台の色を不透明度＝塗りの不透明度で敷き、その上にクリッピングされたものを普通に重ね、最後に土台の形で切り抜く。
 * まとめたものを土台の描画モードと不透明度で下に重ねる。
 */
function drawClipped(run: Run, dst: Surf, base: PsdNode, clipped: PsdNode[]) {
  const l = base.layer;
  if (base.kind === 'layer' && l.adjustment) {
    // 調整レイヤーを土台にしたクリッピング：調整のあと、そのまま重ねる（近似）
    applyAdjustment(run, dst, l);
    for (const c of clipped) drawNode(run, dst, c);
    return;
  }
  const prep = base.kind === 'layer' ? clipPrepLayer(run, l) : clipPrepGroup(run, base);
  if (!prep) return;
  const b = surf(prep.rect);
  put(b, prep.buf, 'copy');
  for (const c of clipped) drawNode(run, b, c);
  cutBy(b, prep.shape);
  if (prep.outside) put(b, prep.outside, 'destination-over');
  const mode = l.blendMode ?? 'normal';
  blend(dst, b, mode === 'pass through' ? 'normal' : mode, l.opacity ?? 1, l, 1);
}

interface ClipPrep {
  rect: Rect;
  /** 土台の色。不透明度は塗りの不透明度（形はまだかけていない） */
  buf: Src;
  /** 土台の形 */
  shape: Src;
  /** 形の外にはみ出したレイヤー効果（ドロップシャドウなど） */
  outside: Src | null;
}
const clipCache = new WeakMap<Layer, ClipPrep | null>();

function clipPrepLayer(run: Run, l: Layer): ClipPrep | null {
  const hit = clipCache.get(l);
  if (hit !== undefined) return hit;
  const shape = layerContent(run, l);
  let prep: ClipPrep | null = null;
  if (shape) {
    const fx = layerWithFx(run, l);
    prep = fx ? clipPrepFx(run, fx, shape) : clipPrepPlain(shape, l.fillOpacity ?? 1);
  }
  clipCache.set(l, prep);
  return prep;
}

function clipPrepGroup(run: Run, n: PsdNode): ClipPrep | null {
  const fx = fxOn(n.layer);
  const g = isolate(run, n, fx);
  if (!g) return null;
  if (fx) {
    const r = drawFx(run, n.layer, g);
    if (r) return clipPrepFx(run, {c: r, x: 0, y: 0}, g);
  }
  return clipPrepPlain(g, 1);
}

/** 効果の無い土台：色はそのまま、不透明度を塗りの不透明度にする */
function clipPrepPlain(shape: Src, fill: number): ClipPrep | null {
  const rect = rectOf(shape);
  const d = readPixels(shape, rect);
  const p = d.data;
  const a = Math.round(fill * 255);
  for (let i = 3; i < p.length; i += 4) p[i] = p[i] ? a : 0;
  const buf = surf(rect);
  buf.ctx.putImageData(d, 0, 0);
  return {rect, buf, shape, outside: null};
}

/** 効果つきの土台：形の中は「効果つきの色 ÷ 形」、形の外にはみ出した分は別に持つ */
function clipPrepFx(run: Run, fx: Src, shape: Src): ClipPrep | null {
  const rect = intersect(rectOf(fx), run.full);
  if (!rect) return null;
  const e = readPixels(fx, rect);
  const sr = intersect(rect, rectOf(shape));
  const sa = new Uint8ClampedArray(rect.w * rect.h);
  if (sr) {
    const sd = readPixels(shape, sr).data;
    for (let y = 0; y < sr.h; y++) {
      const row = (sr.y - rect.y + y) * rect.w + (sr.x - rect.x);
      for (let x = 0; x < sr.w; x++) sa[row + x] = sd[(y * sr.w + x) * 4 + 3];
    }
  }
  const ep = e.data;
  const out = new ImageData(rect.w, rect.h);
  const op = out.data;
  let anyOut = false;
  for (let i = 0, k = 0; k < sa.length; i += 4, k++) {
    const s = sa[k];
    const ea = ep[i + 3];
    if (!ea) continue;
    if (s) {
      const ba = Math.min(255, Math.round((ea * 255) / s));
      const rest = ea - (s * ba) / 255;
      if (rest >= 0.5) {
        op[i] = ep[i];
        op[i + 1] = ep[i + 1];
        op[i + 2] = ep[i + 2];
        op[i + 3] = Math.round(rest);
        anyOut = true;
      }
      ep[i + 3] = ba;
    } else {
      op[i] = ep[i];
      op[i + 1] = ep[i + 1];
      op[i + 2] = ep[i + 2];
      op[i + 3] = ea;
      ep[i + 3] = 0;
      anyOut = true;
    }
  }
  const buf = surf(rect);
  buf.ctx.putImageData(e, 0, 0);
  let outside: Surf | null = null;
  if (anyOut) {
    outside = surf(rect);
    outside.ctx.putImageData(out, 0, 0);
  }
  return {rect, buf, shape, outside};
}

// ───────────── レイヤーの下ごしらえ ─────────────

const contentCache = new WeakMap<Layer, Src | null>();
const fxCache = new WeakMap<Layer, Src | null>();

/** レイヤーの画素にマスクをかけたもの（塗りの不透明度はかけない） */
function layerContent(run: Run, l: Layer): Src | null {
  const hit = contentCache.get(l);
  if (hit !== undefined) return hit;
  let pix: Src | null = null;
  if (l.canvas && l.canvas.width > 0 && l.canvas.height > 0 && (l.right ?? 0) > (l.left ?? 0) && (l.bottom ?? 0) > (l.top ?? 0)) {
    pix = {c: l.canvas, x: l.left ?? 0, y: l.top ?? 0};
  } else if (l.vectorFill) {
    pix = fillContent(run, l);
  }
  let out: Src | null = pix;
  if (pix) {
    const area = rectOf(pix);
    const m = layerMask(l, area, preShaped(l));
    if (m) {
      const s = surf(area);
      put(s, pix, 'copy');
      cutBy(s, m);
      out = s;
    }
  }
  contentCache.set(l, out);
  return out;
}

/** レイヤー効果つきの画像（効果が無い・使わないなら null） */
function layerWithFx(run: Run, l: Layer): Src | null {
  if (!fxOn(l)) return null;
  const hit = fxCache.get(l);
  if (hit !== undefined) return hit;
  const content = layerContent(run, l);
  let out: Src | null = null;
  if (content) {
    const r = drawFx(run, l, content);
    if (r) out = {c: r, x: 0, y: 0};
  }
  fxCache.set(l, out);
  return out;
}

/** 塗りつぶしレイヤー（画素が保存されていないとき）の中身 */
function fillContent(run: Run, l: Layer): Src | null {
  const f = l.vectorFill!;
  const area = maskArea(l, run.full) ?? run.full;
  const s = surf(area);
  const ctx = s.ctx;
  if (f.type === 'color') {
    ctx.fillStyle = cssColor(f.color);
    ctx.fillRect(0, 0, s.w, s.h);
    return s;
  }
  if (f.type === 'solid') {
    const box = vectorBounds(l.vectorMask) ?? run.full;
    const bx = (f.align ?? true) ? box : run.full;
    const cx = bx.x + bx.w / 2 + ((f.offset?.x ?? 0) / 100) * bx.w - s.x;
    const cy = bx.y + bx.h / 2 + ((f.offset?.y ?? 0) / 100) * bx.h - s.y;
    const ang = ((f.angle ?? 90) * Math.PI) / 180;
    const scale = f.scale ?? 1;
    const dx = Math.cos(ang);
    const dy = -Math.sin(ang);
    const len = ((Math.abs(bx.w * dx) + Math.abs(bx.h * dy)) / 2) * scale;
    const g =
      f.style === 'radial'
        ? ctx.createRadialGradient(cx, cy, 0, cx, cy, len)
        : f.style === 'angle'
          ? ctx.createConicGradient(-ang, cx, cy)
          : ctx.createLinearGradient(cx - dx * len, cy - dy * len, cx + dx * len, cy + dy * len);
    for (const [pos, c] of gradientStops(f.colorStops, f.opacityStops, !!f.reverse, f.interpolationMethod, f.smoothness)) g.addColorStop(pos, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s.w, s.h);
    return s;
  }
  // 模様・ノイズのグラデーションは描けない
  return null;
}

const cssColor = (c: Color, a = 1) => {
  const {r, g, b} = rgbOf(c);
  return `rgba(${r},${g},${b},${a})`;
};
function rgbOf(c: Color): {r: number; g: number; b: number} {
  if ('r' in c) return {r: c.r, g: c.g, b: c.b};
  if ('fr' in c) return {r: c.fr * 255, g: c.fg * 255, b: c.fb * 255};
  if ('k' in c && 'c' in c) {
    const k = 1 - c.k / 255;
    return {r: (255 - c.c) * k, g: (255 - c.m) * k, b: (255 - c.y) * k};
  }
  if ('k' in c) return {r: 255 - c.k, g: 255 - c.k, b: 255 - c.k};
  return {r: 0, g: 0, b: 0};
}

/** グラデーションの色と不透明度の分岐点 → Canvas の addColorStop の並び */
function gradientStops(
  colors: {color: Color; location: number; midpoint: number}[] | undefined,
  alphas: {opacity: number; location: number; midpoint: number}[] | undefined,
  reverse: boolean,
  method?: string,
  smoothness?: number,
): [number, string][] {
  const N = 64;
  return gradientSamples(colors, alphas, reverse, method, N, smoothness).map((c, i) => [i / N, `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3]})`]);
}

/**
 * グラデーションを N+1 点で取り出す（[r, g, b（0〜255）, 不透明度（0〜1）]）。
 * 中間点は区間の中の位置をゆがめて表す。補間の方法：perceptual は Oklab、linear は線形の光、それ以外は sRGB のまま。
 * 滑らかさ（smoothness）は区間の中をなめらかな S 字（smoothstep）に寄せる
 */
function gradientSamples(
  colors: {color: Color; location: number; midpoint: number}[] | undefined,
  alphas: {opacity: number; location: number; midpoint: number}[] | undefined,
  reverse: boolean,
  method: string | undefined,
  N: number,
  smoothness = 0,
): number[][] {
  const cs = colors?.length ? colors : [{color: {r: 0, g: 0, b: 0}, location: 0, midpoint: 0.5}];
  const os = alphas?.length ? alphas : [{opacity: 1, location: 0, midpoint: 0.5}];
  const toLin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const fromLin = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(0, x), 1 / 2.4) - 0.055);
  const enc = (c: {r: number; g: number; b: number}): number[] => {
    if (method === 'linear') return [toLin(c.r), toLin(c.g), toLin(c.b)];
    if (method === 'perceptual') {
      const [r, g, b] = [toLin(c.r), toLin(c.g), toLin(c.b)];
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
    }
    return [c.r, c.g, c.b];
  };
  const dec = (v: number[]): number[] => {
    if (method === 'linear') return v.map(fromLin);
    if (method === 'perceptual') {
      const l = (v[0] + 0.3963377774 * v[1] + 0.2158037573 * v[2]) ** 3;
      const m = (v[0] - 0.1055613458 * v[1] - 0.0638541728 * v[2]) ** 3;
      const s = (v[0] - 0.0894841775 * v[1] - 1.291485548 * v[2]) ** 3;
      return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(fromLin);
    }
    return v;
  };
  const at = <T extends {location: number; midpoint: number}>(list: T[], p: number, get: (t: T) => number[]): number[] => {
    if (p <= list[0].location) return get(list[0]);
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (p <= b.location) {
        let t = b.location > a.location ? (p - a.location) / (b.location - a.location) : 1;
        const m = Math.min(0.99, Math.max(0.01, b.midpoint ?? 0.5));
        t = t < m ? (0.5 * t) / m : 0.5 + (0.5 * (t - m)) / (1 - m);
        t += (t * t * (3 - 2 * t) - t) * smoothness;
        const va = get(a);
        const vb = get(b);
        return va.map((v, k) => v + (vb[k] - v) * t);
      }
    }
    return get(list[list.length - 1]);
  };
  const out: number[][] = [];
  for (let i = 0; i <= N; i++) {
    const p = i / N;
    const q = reverse ? 1 - p : p;
    const [r, g, b] = dec(at(cs, q, s => enc(rgbOf(s.color))));
    const [a] = at(os, q, s => [s.opacity]);
    out.push([Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)), a]);
  }
  return out;
}

// ───────────── マスク ─────────────

/** 使うピクセルマスク（ベクトルから作られたものは除く） */
function userMask(l: Layer): LayerMaskData | null {
  const m = l.mask?.fromVectorData ? l.realMask : l.mask;
  return m && !m.disabled ? m : null;
}
/** ベクトルマスク：Photoshop が描いたもの（あればそれを使う）とパス */
function vectorMask(l: Layer): {raster: LayerMaskData | null; path: LayerVectorMask | null} | null {
  const raster = l.mask?.fromVectorData && l.mask.canvas ? l.mask : null;
  const path = l.vectorMask && l.vectorMask.paths?.length ? l.vectorMask : null;
  if (l.vectorMask?.disable) return null;
  if (!path && (!raster || raster.disabled)) return null;
  return raster || path ? {raster, path} : null;
}
const maskRect = (m: LayerMaskData): Rect => ({x: m.left ?? 0, y: m.top ?? 0, w: (m.right ?? 0) - (m.left ?? 0), h: (m.bottom ?? 0) - (m.top ?? 0)});

/**
 * シェイプレイヤーの画素が、すでに図形の形に切り抜かれているか（縁に半透明がある）。
 * そのときベクトルマスクを重ねると縁が 2 回かかって細るので、マスクは使わない
 */
function preShaped(l: Layer): boolean {
  if (!l.vectorFill || !l.canvas || !l.vectorMask) return false;
  const p = ctxOf(l.canvas).getImageData(0, 0, l.canvas.width, l.canvas.height).data;
  for (let i = 3; i < p.length; i += 4) if (p[i] !== 0 && p[i] !== 255) return true;
  return false;
}

/** マスクが 0 でない範囲（無ければ null = 全体） */
function maskArea(l: Layer, full: Rect): Rect | null {
  let r: Rect | null = full;
  let limited = false;
  const um = userMask(l);
  if (um && !um.defaultColor) {
    r = r && intersect(r, maskRect(um));
    limited = true;
  }
  const vm = vectorMask(l);
  if (vm?.raster && !vm.raster.defaultColor) {
    r = r && intersect(r, maskRect(vm.raster));
    limited = true;
  } else if (vm?.path && !vm.path.invert && !vm.path.fillStartsWithAllPixels) {
    const b = vectorBounds(vm.path);
    if (b) {
      r = r && intersect(r, b);
      limited = true;
    }
  }
  return limited ? (r ?? {x: 0, y: 0, w: 1, h: 1}) : null;
}

/** レイヤーのマスク（area の範囲、アルファが値）。マスクが無ければ null */
function layerMask(l: Layer, area: Rect, skipVector = false): Src | null {
  const um = userMask(l);
  const vm = skipVector ? null : vectorMask(l);
  if (!um && !vm) return null;
  let out: Surf | null = null;
  if (um) out = rasterMask(um, area, l.mask?.userMaskDensity ?? 1, l.mask?.userMaskFeather ?? 0);
  if (vm) {
    const density = l.mask?.vectorMaskDensity ?? 1;
    const feather = l.mask?.vectorMaskFeather ?? 0;
    const v = vm.raster ? rasterMask(vm.raster, area, density, feather) : pathMask(vm.path!, area, density, feather);
    if (out) put(out, v, 'destination-in');
    else out = v;
  }
  return out;
}

const groupMaskCache = new WeakMap<Layer, Src | null>();
function groupMask(run: Run, l: Layer): Src | null {
  const hit = groupMaskCache.get(l);
  if (hit !== undefined) return hit;
  let out: Src | null = null;
  if (userMask(l) || vectorMask(l)) {
    const area = maskArea(l, run.full) ?? run.full;
    out = layerMask(l, area);
  }
  groupMaskCache.set(l, out);
  return out;
}

/** ピクセルマスク（灰色の画像）をアルファにして area に置く。範囲の外は既定の色 */
function rasterMask(m: LayerMaskData, area: Rect, density: number, feather: number): Surf {
  const s = surf(area);
  const dens = (v: number) => 255 - density * (255 - v);
  const def = dens(m.defaultColor ?? 0);
  if (def > 0) {
    s.ctx.fillStyle = `rgba(0,0,0,${def / 255})`;
    s.ctx.fillRect(0, 0, s.w, s.h);
  }
  const r = maskRect(m);
  if (m.canvas && r.w > 0 && r.h > 0) {
    const g = ctxOf(m.canvas).getImageData(0, 0, r.w, r.h);
    const p = g.data;
    for (let i = 0; i < p.length; i += 4) {
      p[i + 3] = dens(p[i]);
      p[i] = p[i + 1] = p[i + 2] = 0;
    }
    const t = surf(r);
    t.ctx.putImageData(g, 0, 0);
    s.ctx.clearRect(r.x - area.x, r.y - area.y, r.w, r.h);
    put(s, t, 'source-over');
  }
  return feather > 0 ? blurred(s, feather) : s;
}

function blurred(s: Surf, feather: number): Surf {
  const b = surf(s);
  // Photoshop のぼかし（ガウス）の半径は、Canvas の標準偏差のおよそ 2 倍
  b.ctx.filter = `blur(${feather / 2}px)`;
  b.ctx.drawImage(s.c, 0, 0);
  b.ctx.filter = 'none';
  return b;
}

/** ベクトルマスク（パス）を描く */
function pathMask(vm: LayerVectorMask, area: Rect, density: number, feather: number): Surf {
  const acc = surf(area);
  if (vm.fillStartsWithAllPixels) acc.ctx.fillRect(0, 0, acc.w, acc.h);
  // 演算の指定があるパスから新しい図形が始まり、指定の無いパスはその図形の続き（穴など）
  const comps: {op: string; rule: CanvasFillRule; path: Path2D}[] = [];
  for (const p of vm.paths) {
    if (p.open || p.knots.length < 2) continue;
    if (p.operation !== undefined || !comps.length) comps.push({op: p.operation ?? 'combine', rule: p.fillRule === 'non-zero' ? 'nonzero' : 'evenodd', path: new Path2D()});
    const path = comps[comps.length - 1].path;
    const k = p.knots;
    const pt = (i: number, j: number) => [k[i].points[j] - area.x, k[i].points[j + 1] - area.y] as const;
    path.moveTo(...pt(0, 2));
    for (let i = 1; i <= k.length; i++) {
      const cur = i % k.length;
      path.bezierCurveTo(...pt(i - 1, 4), ...pt(cur, 0), ...pt(cur, 2));
    }
    path.closePath();
  }
  for (const c of comps) {
    const t = surf(area);
    t.ctx.fill(c.path, c.rule);
    const op: GlobalCompositeOperation = c.op === 'subtract' ? 'destination-out' : c.op === 'intersect' ? 'destination-in' : c.op === 'exclude' ? 'xor' : 'source-over';
    put(acc, t, op);
  }
  let out = acc;
  if (vm.invert) {
    out = surf(area);
    out.ctx.fillRect(0, 0, out.w, out.h);
    put(out, acc, 'destination-out');
  }
  if (density < 1) {
    out.ctx.globalCompositeOperation = 'destination-over';
    out.ctx.fillStyle = `rgba(0,0,0,${1 - density})`;
    out.ctx.fillRect(0, 0, out.w, out.h);
    out.ctx.globalCompositeOperation = 'source-over';
  }
  return feather > 0 ? blurred(out, feather) : out;
}

function vectorBounds(vm: LayerVectorMask | undefined): Rect | null {
  if (!vm?.paths?.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of vm.paths)
    for (const k of p.knots)
      for (let i = 0; i < 6; i += 2) {
        x0 = Math.min(x0, k.points[i]);
        x1 = Math.max(x1, k.points[i]);
        y0 = Math.min(y0, k.points[i + 1]);
        y1 = Math.max(y1, k.points[i + 1]);
      }
  if (!(x1 > x0 && y1 > y0)) return null;
  // 縁のなめらかな部分のぶん少し広げる
  const x = Math.floor(x0) - 2;
  const y = Math.floor(y0) - 2;
  return {x, y, w: Math.ceil(x1) + 2 - x, h: Math.ceil(y1) + 2 - y};
}

// ───────────── 描画モード ─────────────

/** Canvas の合成が Photoshop と同じ式になる描画モード */
const NATIVE: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

/** src を dst に、描画モード mode・不透明度 opacity・塗りの不透明度 fill で重ねる */
function blend(dst: Surf, src: Src, mode: BlendMode, opacity: number, l: Layer, fill: number) {
  if (mode === 'pass through') mode = 'normal';
  // 塗りの不透明度は不透明度にかける（効果の無いレイヤー）
  const alpha = opacity * fill;
  if (alpha <= 0) return;
  const native = NATIVE[mode];
  const ranges = activeRanges(l);
  if (native && !ranges) return put(dst, src, native, alpha);
  blendPixels(dst, src, mode, alpha, ranges);
}

const DEFAULT_RANGE = [0, 0, 255, 255];
const isDefaultRange = (r: number[] | undefined) => !r || r.every((v, i) => v === DEFAULT_RANGE[i]);
interface Ranges {
  src: number[][];
  dst: number[][];
}
/** ブレンド条件（Blend If）。既定のままなら null。[灰色, R, G, B] の順 */
function activeRanges(l: Layer): Ranges | null {
  const br = l.blendingRanges;
  if (!br) return null;
  const src = [br.compositeGrayBlendSource, ...br.ranges.slice(0, 3).map(r => r.sourceRange)];
  const dst = [br.compositeGraphBlendDestinationRange, ...br.ranges.slice(0, 3).map(r => r.destRange)];
  if (src.every(isDefaultRange) && dst.every(isDefaultRange)) return null;
  return {src, dst};
}
function blendIfLooksAtBackdrop(l: Layer) {
  const r = activeRanges(l);
  return !!r && !r.dst.every(isDefaultRange);
}
/** ブレンド条件の 1 つの範囲 [黒の下, 黒の上, 白の下, 白の上] での効き方 */
function rangeWeight(v: number, r: number[]): number {
  const [b0, b1, w0, w1] = r;
  if (v < b0) return 0;
  if (v < b1) return (v - b0) / (b1 - b0);
  if (v <= w0) return 1;
  if (v <= w1) return w1 > w0 ? (w1 - v) / (w1 - w0) : 0;
  return 0;
}

type Sep = (b: number, s: number) => number;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const colorDodge: Sep = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const colorBurn: Sep = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
/** 各色ごとに計算できる描画モード（Photoshop の式） */
const SEP: Partial<Record<BlendMode, Sep>> = {
  normal: (_b, s) => s,
  dissolve: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color dodge': colorDodge,
  'color burn': colorBurn,
  'linear dodge': (b, s) => Math.min(1, b + s),
  'linear burn': (b, s) => Math.max(0, b + s - 1),
  'hard light': (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  // Photoshop のソフトライト（暗い部分も平方根の式。W3C の式とは暗部が違う）
  'soft light': (b, s) => (s <= 0.5 ? 2 * b * s + b * b * (1 - 2 * s) : Math.sqrt(b) * (2 * s - 1) + 2 * b * (1 - s)),
  'vivid light': (b, s) => (s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1)),
  'linear light': (b, s) => clamp01(b + 2 * s - 1),
  'pin light': (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  'hard mix': (b, s) => (b + s >= 1 ? 1 : 0),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  subtract: (b, s) => Math.max(0, b - s),
  subtraction: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s)),
};

// 色相・彩度・カラー・輝度（W3C と同じ、Photoshop 由来の式）
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c: number[]) {
  const l = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / (l - n);
  if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (1 - l)) / (x - l);
  return c;
}
function setLum(c: number[], l: number) {
  const d = l - lum(c[0], c[1], c[2]);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}
const sat = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: number[], s: number) {
  const out = [0, 0, 0];
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [lo, mid, hi] = idx;
  if (c[hi] > c[lo]) {
    out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo]);
    out[hi] = s;
  }
  out[lo] = 0;
  return out;
}
type NonSep = (b: number[], s: number[]) => number[];
const NONSEP: Partial<Record<BlendMode, NonSep>> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b[0], b[1], b[2])),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b[0], b[1], b[2])),
  color: (b, s) => setLum(s, lum(b[0], b[1], b[2])),
  luminosity: (b, s) => setLum(b, lum(s[0], s[1], s[2])),
  // 輝度で比べる（3 色の合計ではない。Photoshop の結果で確かめた）
  'darker color': (b, s) => (lum(s[0], s[1], s[2]) < lum(b[0], b[1], b[2]) ? s : b),
  'lighter color': (b, s) => (lum(s[0], s[1], s[2]) > lum(b[0], b[1], b[2]) ? s : b),
};

/** 決まった種から作る、位置ごとの乱数（ディザ合成用） */
function hash01(x: number, y: number) {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y + 0x9e3779b9, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 画素の計算で重ねる（Canvas に無い描画モード・ブレンド条件） */
function blendPixels(dst: Surf, src: Src, mode: BlendMode, alpha: number, ranges: Ranges | null) {
  const r = intersect(rectOf(dst), rectOf(src));
  if (!r) return;
  const d = dst.ctx.getImageData(r.x - dst.x, r.y - dst.y, r.w, r.h);
  const s = readPixels(src, r);
  const dp = d.data;
  const sp = s.data;
  const nonsep = NONSEP[mode];
  const lut = nonsep ? null : sepLut(mode);
  const dissolve = mode === 'dissolve';
  const bb = [0, 0, 0];
  const ss = [0, 0, 0];
  const res = [0, 0, 0];
  for (let y = 0, i = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++, i += 4) {
      const sa = sp[i + 3];
      if (!sa) continue;
      let as = (sa / 255) * alpha;
      if (ranges) {
        as *= blendIfWeight(sp, dp, i, ranges);
        if (as <= 0) continue;
      }
      if (dissolve) {
        if (hash01(r.x + x, r.y + y) >= as) continue;
        as = 1;
      }
      const ba = dp[i + 3];
      if (lut) {
        res[0] = lut[(dp[i] << 8) | sp[i]];
        res[1] = lut[(dp[i + 1] << 8) | sp[i + 1]];
        res[2] = lut[(dp[i + 2] << 8) | sp[i + 2]];
      } else {
        for (let c = 0; c < 3; c++) {
          bb[c] = dp[i + c] / 255;
          ss[c] = sp[i + c] / 255;
        }
        const o = nonsep!(bb, ss);
        res[0] = o[0] * 255;
        res[1] = o[1] * 255;
        res[2] = o[2] * 255;
      }
      if (ba === 255) {
        // 下が不透明（よくある場合）：描画モードの色へ as の割合で寄せる
        dp[i] = Math.round(dp[i] + (res[0] - dp[i]) * as);
        dp[i + 1] = Math.round(dp[i + 1] + (res[1] - dp[i + 1]) * as);
        dp[i + 2] = Math.round(dp[i + 2] + (res[2] - dp[i + 2]) * as);
        continue;
      }
      // 下が透明なところは元の色、不透明なところは描画モードの色。それを通常の重ね方で重ねる
      const ab = ba / 255;
      const ao = as + ab * (1 - as);
      for (let c = 0; c < 3; c++) {
        const cs = (1 - ab) * sp[i + c] + ab * res[c];
        dp[i + c] = Math.round((as * cs + (1 - as) * ab * dp[i + c]) / ao);
      }
      dp[i + 3] = Math.round(ao * 255);
    }
  }
  dst.ctx.putImageData(d, r.x - dst.x, r.y - dst.y);
}

/** 各色ごとの描画モードの表（下の値 × 256 + 上の値 → 結果。0〜255） */
const lutCache = new Map<BlendMode, Uint8ClampedArray>();
function sepLut(mode: BlendMode): Uint8ClampedArray {
  let t = lutCache.get(mode);
  if (t) return t;
  const f = SEP[mode] ?? SEP.normal!;
  t = new Uint8ClampedArray(65536);
  for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) t[(b << 8) | s] = Math.round(f(b / 255, s / 255) * 255);
  lutCache.set(mode, t);
  return t;
}

/** ブレンド条件での効き方（0〜1） */
function blendIfWeight(sp: Uint8ClampedArray, dp: Uint8ClampedArray, i: number, ranges: Ranges): number {
  const sr = sp[i];
  const sg = sp[i + 1];
  const sb = sp[i + 2];
  const dr = dp[i];
  const dg = dp[i + 1];
  const db = dp[i + 2];
  return (
    rangeWeight(lum(sr, sg, sb), ranges.src[0]) *
    rangeWeight(lum(dr, dg, db), ranges.dst[0]) *
    rangeWeight(sr, ranges.src[1] ?? DEFAULT_RANGE) *
    rangeWeight(sg, ranges.src[2] ?? DEFAULT_RANGE) *
    rangeWeight(sb, ranges.src[3] ?? DEFAULT_RANGE) *
    rangeWeight(dr, ranges.dst[1] ?? DEFAULT_RANGE) *
    rangeWeight(dg, ranges.dst[2] ?? DEFAULT_RANGE) *
    rangeWeight(db, ranges.dst[3] ?? DEFAULT_RANGE)
  );
}

// ───────────── 調整レイヤー ─────────────

type AdjFn = (rgb: number[]) => void;
const adjCache = new WeakMap<Layer, AdjFn | null>();
const adjMaskCache = new WeakMap<Layer, Src | null>();

/** 調整レイヤーを dst（その下にある絵）に当てる。不透明度・マスク・描画モードも使う。アルファは変えない */
function applyAdjustment(run: Run, dst: Surf, l: Layer) {
  let fn = adjCache.get(l);
  if (fn === undefined) {
    fn = adjustmentFn(l.adjustment!);
    adjCache.set(l, fn);
  }
  if (!fn) return;
  const t0 = (l.opacity ?? 1) * (l.fillOpacity ?? 1);
  if (t0 <= 0) return;
  let mask = adjMaskCache.get(l);
  if (mask === undefined) {
    mask = userMask(l) || vectorMask(l) ? layerMask(l, maskArea(l, run.full) ?? run.full) : null;
    adjMaskCache.set(l, mask);
  }
  const r = mask ? intersect(rectOf(dst), rectOf(mask)) : rectOf(dst);
  if (!r) return;
  const d = dst.ctx.getImageData(r.x - dst.x, r.y - dst.y, r.w, r.h);
  const m = mask ? readPixels(mask, r).data : null;
  const p = d.data;
  let mode = l.blendMode ?? 'normal';
  if (mode === 'pass through' || mode === 'dissolve') mode = 'normal';
  const sep = mode === 'normal' ? null : SEP[mode];
  const nonsep = NONSEP[mode];
  const rgb = [0, 0, 0];
  const bb = [0, 0, 0];
  const ss = [0, 0, 0];
  for (let i = 0; i < p.length; i += 4) {
    if (!p[i + 3]) continue;
    const t = m ? (t0 * m[i + 3]) / 255 : t0;
    if (t <= 0) continue;
    rgb[0] = p[i];
    rgb[1] = p[i + 1];
    rgb[2] = p[i + 2];
    fn(rgb);
    if (sep || nonsep) {
      for (let c = 0; c < 3; c++) {
        bb[c] = p[i + c] / 255;
        ss[c] = clamp01(rgb[c] / 255);
      }
      const res = nonsep ? nonsep(bb, ss) : bb.map((b, c) => sep!(b, ss[c]));
      for (let c = 0; c < 3; c++) rgb[c] = res[c] * 255;
    }
    for (let c = 0; c < 3; c++) p[i + c] = Math.round(p[i + c] + (rgb[c] - p[i + c]) * t);
  }
  dst.ctx.putImageData(d, r.x - dst.x, r.y - dst.y);
}

/** 0〜255 の表を 3 色に当てる関数 */
const lutFn =
  (lr: Float64Array, lg: Float64Array = lr, lb: Float64Array = lr): AdjFn =>
  c => {
    c[0] = lr[c[0] | 0];
    c[1] = lg[c[1] | 0];
    c[2] = lb[c[2] | 0];
  };
const makeLut = (f: (v: number) => number) => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = Math.max(0, Math.min(255, f(i)));
  return t;
};
const compose2 = (a: Float64Array, b: Float64Array) => makeLut(v => b[Math.round(a[v])]);

/** 調整レイヤーの種類ごとの色の変え方（作れないものは null） */
function adjustmentFn(a: AdjustmentLayer): AdjFn | null {
  switch (a.type) {
    case 'invert':
      return lutFn(makeLut(v => 255 - v));
    case 'posterize': {
      const n = Math.max(2, a.levels ?? 4);
      return lutFn(makeLut(v => Math.round((Math.min(n - 1, Math.floor((v * n) / 256)) * 255) / (n - 1))));
    }
    case 'threshold': {
      const lv = a.level ?? 128;
      return c => {
        const y = lum(c[0], c[1], c[2]);
        c[0] = c[1] = c[2] = y >= lv ? 255 : 0;
      };
    }
    case 'levels': {
      const ch = a.channels ?? [];
      const lut = (k: number) => {
        const c = ch[k];
        if (!c) return makeLut(v => v);
        const g = c.midtoneInput || 1;
        return makeLut(v => {
          const x = clamp01((v - c.shadowInput) / Math.max(1, c.highlightInput - c.shadowInput));
          return c.shadowOutput + Math.pow(x, 1 / g) * (c.highlightOutput - c.shadowOutput);
        });
      };
      const m = lut(0);
      return lutFn(compose2(lut(1), m), compose2(lut(2), m), compose2(lut(3), m));
    }
    case 'curves': {
      const lut = (k: number) => {
        const vals = a.values?.[k];
        if (vals && vals.length >= 256) return makeLut(v => vals[v]);
        const pts = a.channels?.[k];
        if (!pts || pts.length < 2) return makeLut(v => v);
        return splineLut(pts.map(p => [p.input, p.output] as [number, number]));
      };
      const m = lut(0);
      return lutFn(compose2(lut(1), m), compose2(lut(2), m), compose2(lut(3), m));
    }
    case 'brightness/contrast': {
      const br = a.brightness ?? 0;
      const ct = a.contrast ?? 0;
      if (a.useLegacy) {
        const k = ct >= 0 ? 1 / Math.max(0.01, 1 - ct / 100) : 1 + ct / 100;
        return lutFn(makeLut(v => (v + br - 127.5) * k + 127.5));
      }
      // 新しい方式の正確な式は公開されていないので、近い曲線で代える
      const mean = (a.meanValue ?? 127) / 255;
      const b = br / 150;
      const slant = Math.tan(((ct / 100 + 1) * Math.PI) / 4);
      return lutFn(
        makeLut(v => {
          let x = v / 255;
          x = b < 0 ? x * (1 + b) : x + (1 - x) * b;
          x = (x - mean) * (ct < 0 ? 1 + ct / 100 : slant) + mean;
          return x * 255;
        }),
      );
    }
    case 'exposure': {
      const e = Math.pow(2, a.exposure ?? 0);
      const off = a.offset ?? 0;
      const gm = a.gamma ?? 1;
      return lutFn(makeLut(v => Math.pow(Math.max(0, Math.pow(v / 255, 2.2) * e + off), 1 / (gm * 2.2)) * 255));
    }
    case 'hue/saturation':
      return hueSatFn(a);
    case 'color balance':
      return colorBalanceFn(a);
    case 'black & white': {
      const w = [a.reds ?? 40, a.yellows ?? 60, a.greens ?? 40, a.cyans ?? 60, a.blues ?? 20, a.magentas ?? 80].map(v => v / 100);
      const tint = a.useTint && a.tintColor ? rgbOf(a.tintColor) : null;
      return c => {
        const [r, g, b] = c;
        const lo = Math.min(r, g, b);
        const hi = Math.max(r, g, b);
        const mid = r + g + b - lo - hi;
        // いちばん強い色（赤・緑・青）と 2 番目までの混色（黄・シアン・マゼンタ）の重みで灰色を作る
        const primary = hi === r ? 0 : hi === g ? 2 : 4;
        const secondIsR = lo !== r && hi !== r;
        const secondIsG = lo !== g && hi !== g;
        const secondary = (hi === r && secondIsG) || (hi === g && secondIsR) ? 1 : (hi === g && !secondIsR) || (hi === b && secondIsG) ? 3 : 5;
        let y = lo + (mid - lo) * w[secondary] + (hi - mid) * w[primary];
        y = Math.max(0, Math.min(255, y));
        if (tint) {
          const t = setLum([tint.r / 255, tint.g / 255, tint.b / 255], y / 255);
          c[0] = t[0] * 255;
          c[1] = t[1] * 255;
          c[2] = t[2] * 255;
        } else c[0] = c[1] = c[2] = y;
      };
    }
    case 'channel mixer': {
      const row = (m: {red: number; green: number; blue: number; constant: number} | undefined, k: number) =>
        m ?? {red: k === 0 ? 100 : 0, green: k === 1 ? 100 : 0, blue: k === 2 ? 100 : 0, constant: 0};
      const mix = (m: {red: number; green: number; blue: number; constant: number}, c: number[]) => (c[0] * m.red + c[1] * m.green + c[2] * m.blue) / 100 + m.constant * 2.55;
      if (a.monochrome) {
        const g = row(a.gray, 0);
        return c => {
          c[0] = c[1] = c[2] = mix(g, c);
        };
      }
      const rr = row(a.red, 0);
      const gg = row(a.green, 1);
      const bb = row(a.blue, 2);
      return c => {
        const r = mix(rr, c);
        const g = mix(gg, c);
        const b = mix(bb, c);
        c[0] = r;
        c[1] = g;
        c[2] = b;
      };
    }
    case 'gradient map': {
      const lut = gradientSamples(a.colorStops, undefined, !!a.reverse, a.method, 255, a.smoothness);
      return c => {
        const y = Math.max(0, Math.min(255, Math.round(lum(c[0], c[1], c[2]))));
        c[0] = lut[y][0];
        c[1] = lut[y][1];
        c[2] = lut[y][2];
      };
    }
    case 'selective color':
      return selectiveColorFn(a);
    default:
      // 自然な彩度・レンズフィルター・カラールックアップは未対応
      return null;
  }
}

/** トーンカーブの点を通る自然 3 次スプライン → 表 */
function splineLut(pts: [number, number][]): Float64Array {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const xs = p.map(q => q[0]);
  const ys = p.map(q => q[1]);
  const m = new Float64Array(n);
  if (n > 2) {
    // 2 階微分を三重対角の連立方程式で求める
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    const c = new Float64Array(n);
    const d = new Float64Array(n);
    b[0] = b[n - 1] = 1;
    for (let i = 1; i < n - 1; i++) {
      const h0 = xs[i] - xs[i - 1];
      const h1 = xs[i + 1] - xs[i];
      a[i] = h0;
      b[i] = 2 * (h0 + h1);
      c[i] = h1;
      d[i] = 6 * ((ys[i + 1] - ys[i]) / h1 - (ys[i] - ys[i - 1]) / h0);
    }
    for (let i = 1; i < n; i++) {
      const w = a[i] / b[i - 1];
      b[i] -= w * c[i - 1];
      d[i] -= w * d[i - 1];
    }
    m[n - 1] = d[n - 1] / b[n - 1];
    for (let i = n - 2; i >= 0; i--) m[i] = (d[i] - c[i] * m[i + 1]) / b[i];
  }
  return makeLut(v => {
    if (v <= xs[0]) return ys[0];
    if (v >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (k < n - 2 && v > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k];
    const t = (v - xs[k]) / h;
    const s = 1 - t;
    return s * ys[k] + t * ys[k + 1] + ((s * s * s - s) * m[k] + (t * t * t - t) * m[k + 1]) * ((h * h) / 6);
  });
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const l = (hi + lo) / 2;
  if (hi === lo) return [0, 0, l];
  const d = hi - lo;
  const s = l > 0.5 ? d / (2 - hi - lo) : d / (hi + lo);
  let h = hi === r ? (g - b) / d + (g < b ? 6 : 0) : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** 色相・彩度（GIMP が Photoshop に合わせた式に近いもの） */
function hueSatFn(a: Extract<AdjustmentLayer, {type: 'hue/saturation'}>): AdjFn {
  const master = a.master ?? {hue: 0, saturation: 0, lightness: 0};
  const ranges = [a.reds, a.yellows, a.greens, a.cyans, a.blues, a.magentas].filter(r => r && (r.hue || r.saturation || r.lightness));
  const light = (v: number, l: number) => (l < 0 ? v * (1 + l) : v + (1 - v) * l);
  if (a.colorize) {
    const z = a.colorization ?? {hue: 0, saturation: 25, lightness: 0};
    return c => {
      const y = lum(c[0], c[1], c[2]) / 255;
      const o = hslToRgb(z.hue / 360, z.saturation / 100, light(y, z.lightness / 100));
      c[0] = o[0] * 255;
      c[1] = o[1] * 255;
      c[2] = o[2] * 255;
    };
  }
  const weight = (deg: number, r: {a: number; b: number; c: number; d: number}) => {
    const rel = (v: number) => (((v - r.a) % 360) + 360) % 360;
    const x = rel(deg);
    const b = rel(r.b);
    const cc = rel(r.c);
    const d = rel(r.d);
    if (x < b) return b > 0 ? x / b : 1;
    if (x <= cc) return 1;
    if (x < d) return (d - x) / (d - cc);
    return 0;
  };
  return c => {
    let [h, s, l] = rgbToHsl(c[0] / 255, c[1] / 255, c[2] / 255);
    let dh = master.hue;
    let ds = master.saturation;
    let dl = master.lightness;
    for (const r of ranges) {
      const w = s > 0 ? weight(h * 360, r!) : 0;
      dh += w * r!.hue;
      ds += w * r!.saturation;
      dl += w * r!.lightness;
    }
    h += dh / 360;
    s = clamp01(s * (1 + ds / 100));
    l = clamp01(light(l, dl / 100));
    const o = hslToRgb(h, s, l);
    c[0] = o[0] * 255;
    c[1] = o[1] * 255;
    c[2] = o[2] * 255;
  };
}

/** 特定色域の選択：色の系統ごとの重み（最大・中間・最小の差）で、C・M・Y・K のずらしを混ぜる */
function selectiveColorFn(a: Extract<AdjustmentLayer, {type: 'selective color'}>): AdjFn {
  const z = {c: 0, m: 0, y: 0, k: 0};
  const cls = [a.reds, a.yellows, a.greens, a.cyans, a.blues, a.magentas, a.whites, a.neutrals, a.blacks].map(v => {
    const q = v ?? z;
    return [q.c / 100, q.m / 100, q.y / 100, q.k / 100];
  });
  const relative = a.mode === 'relative';
  const w = new Float64Array(9);
  return c => {
    const r = c[0] / 255;
    const g = c[1] / 255;
    const b = c[2] / 255;
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    const mid = r + g + b - hi - lo;
    w.fill(0);
    if (hi === r) w[0] = hi - mid;
    else if (hi === g) w[2] = hi - mid;
    else w[4] = hi - mid;
    if (lo === b) w[1] = mid - lo;
    else if (lo === r) w[3] = mid - lo;
    else w[5] = mid - lo;
    if (lo > 0.5) w[6] = (lo - 0.5) * 2;
    else if (hi < 0.5) w[8] = (0.5 - hi) * 2;
    w[7] = Math.max(0, 1 - (Math.abs(hi - 0.5) + Math.abs(lo - 0.5)));
    const v = [r, g, b];
    const out = [r, g, b];
    for (let k = 0; k < 9; k++) {
      if (!w[k]) continue;
      const q = cls[k];
      for (let ch = 0; ch < 3; ch++) {
        let d = (-1 - q[ch]) * q[3] - q[ch];
        if (relative) d *= 1 - v[ch];
        out[ch] += d * w[k];
      }
    }
    c[0] = clamp01(out[0]) * 255;
    c[1] = clamp01(out[1]) * 255;
    c[2] = clamp01(out[2]) * 255;
  };
}

/** カラーバランス（GIMP が Photoshop に合わせた式） */
function colorBalanceFn(a: Extract<AdjustmentLayer, {type: 'color balance'}>): AdjFn {
  const z = {cyanRed: 0, magentaGreen: 0, yellowBlue: 0};
  const sh = a.shadows ?? z;
  const md = a.midtones ?? z;
  const hl = a.highlights ?? z;
  const vals = (v: {cyanRed: number; magentaGreen: number; yellowBlue: number}) => [v.cyanRed / 100, v.magentaGreen / 100, v.yellowBlue / 100];
  const s = vals(sh);
  const m = vals(md);
  const h = vals(hl);
  const A = 0.25;
  const B = 0.333;
  const S = 0.7;
  return c => {
    const [, , l0] = rgbToHsl(c[0] / 255, c[1] / 255, c[2] / 255);
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = c[k] / 255;
      const ws = clamp01((v - B) / -A + 0.5) * S;
      const wm = clamp01((v - B) / A + 0.5) * clamp01((v + B - 1) / -A + 0.5) * S;
      const wh = clamp01((v + B - 1) / A + 0.5) * S;
      out[k] = clamp01(v + s[k] * ws + m[k] * wm + h[k] * wh);
    }
    let o = out;
    if (a.preserveLuminosity) {
      const [hh, ss] = rgbToHsl(out[0], out[1], out[2]);
      o = hslToRgb(hh, ss, l0);
    }
    c[0] = o[0] * 255;
    c[1] = o[1] * 255;
    c[2] = o[2] * 255;
  };
}
