// 画面分割：選んだ素材を、型（左右・上下・3 分割・4 分割・小窓）の枠に収める。
// 位置・大きさ・切り抜き（crop）を決めるだけなので、プレビューと書き出しは同じになる

import type {Clip, Crop, Transform} from './model';

export type SplitLayout = 'lr' | 'tb' | 'pip' | 'l1r2' | 't1b2' | 'row3' | 'grid4';

/** 枠（画面に対する割合の x, y, 幅, 高さ）と、枠をいっぱいに埋めるか（cover）・収めるか（contain） */
type Cell = {x: number; y: number; w: number; h: number; fit?: 'contain'};

export const SPLIT_LAYOUTS: Record<SplitLayout, {label: string; n: number; cells: Cell[]}> = {
  lr: {
    label: '左右',
    n: 2,
    cells: [
      {x: 0, y: 0, w: 0.5, h: 1},
      {x: 0.5, y: 0, w: 0.5, h: 1},
    ],
  },
  tb: {
    label: '上下',
    n: 2,
    cells: [
      {x: 0, y: 0, w: 1, h: 0.5},
      {x: 0, y: 0.5, w: 1, h: 0.5},
    ],
  },
  pip: {
    label: '小窓',
    n: 2,
    cells: [
      {x: 0, y: 0, w: 1, h: 1},
      {x: 0.66, y: 0.62, w: 0.3, h: 0.3, fit: 'contain'},
    ],
  },
  l1r2: {
    label: '左に大きく',
    n: 3,
    cells: [
      {x: 0, y: 0, w: 0.6, h: 1},
      {x: 0.6, y: 0, w: 0.4, h: 0.5},
      {x: 0.6, y: 0.5, w: 0.4, h: 0.5},
    ],
  },
  t1b2: {
    label: '上に大きく',
    n: 3,
    cells: [
      {x: 0, y: 0, w: 1, h: 0.6},
      {x: 0, y: 0.6, w: 0.5, h: 0.4},
      {x: 0.5, y: 0.6, w: 0.5, h: 0.4},
    ],
  },
  row3: {label: '横に 3 つ', n: 3, cells: [0, 1, 2].map(i => ({x: i / 3, y: 0, w: 1 / 3, h: 1}))},
  grid4: {label: '4 分割', n: 4, cells: [0, 1, 2, 3].map(i => ({x: (i % 2) / 2, y: Math.floor(i / 2) / 2, w: 0.5, h: 0.5}))},
};

/** 選んだ数で使える型 */
export const layoutsFor = (n: number) => (Object.keys(SPLIT_LAYOUTS) as SplitLayout[]).filter(k => SPLIT_LAYOUTS[k].n === n);

/**
 * それぞれの素材の位置・大きさ・切り抜き。size は素材のもとの大きさ（画素）、gap は枠どうし・画面の端とのすき間（画素）。
 * 埋めるときは真ん中を残してはみ出す分を切り抜き、収めるときは切り抜かない
 */
export function splitPlacement(
  layout: SplitLayout,
  sizes: [number, number][],
  video: {width: number; height: number},
  gap: number,
): {transform: Pick<Transform, 'x' | 'y' | 'scale'>; crop: Crop | null}[] {
  const {cells} = SPLIT_LAYOUTS[layout];
  const W = video.width;
  const H = video.height;
  return sizes.map(([mw, mh], i) => {
    const c = cells[i];
    const full = c.w >= 1 && c.h >= 1;
    // 画面いっぱいの枠（小窓の下）にはすき間を付けない
    const g = full ? 0 : gap;
    const x0 = c.x * W + (c.x > 0 ? g / 2 : g);
    const y0 = c.y * H + (c.y > 0 ? g / 2 : g);
    const x1 = (c.x + c.w) * W - (c.x + c.w < 0.999 ? g / 2 : g);
    const y1 = (c.y + c.h) * H - (c.y + c.h < 0.999 ? g / 2 : g);
    const cw = Math.max(1, x1 - x0);
    const ch = Math.max(1, y1 - y0);
    const cx = (x0 + x1) / 2 - W / 2;
    const cy = (y0 + y1) / 2 - H / 2;
    const w = Math.max(1, mw);
    const h = Math.max(1, mh);
    if (c.fit === 'contain') return {transform: {x: cx, y: cy, scale: Math.min(cw / w, ch / h)}, crop: null};
    const s = Math.max(cw / w, ch / h);
    const kw = Math.min(1, cw / (s * w));
    const kh = Math.min(1, ch / (s * h));
    const cut = (k: number) => Math.round(((1 - k) / 2) * 1e5) / 1e5;
    const crop = kw < 0.9999 || kh < 0.9999 ? {left: cut(kw), right: cut(kw), top: cut(kh), bottom: cut(kh)} : null;
    // 切り抜いたあとの大きさで置く（プレビューも書き出しも、切り抜いた絵に scale を掛ける）
    return {transform: {x: Math.round(cx * 100) / 100, y: Math.round(cy * 100) / 100, scale: Math.round(s * 1e5) / 1e5}, crop};
  });
}

/** 画面分割に使えるアイテム（画像・動画・テキスト・図形） */
export const splittable = (c: Clip) => (c.type === 'media' && c.mediaKind !== 'audio') || c.type === 'text' || c.type === 'shape';
