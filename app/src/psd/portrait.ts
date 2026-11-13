// PSD 立ち絵をアプリで使う：読み込み（キャッシュ）・状態ごとの表示の決め方・プレビュー用の画像・書き出し用の焼き込み・
// 目と口のレイヤーの自動割り当て。合成そのものは compose.ts（とレイヤー効果は effects.ts）。

import {api, type Api} from '../ipc';
import type {Character, Expression, Portrait, Project, PsdPortrait} from '../model';
import {expressionFor, expressionIndex, lineVariants} from '../model';
// 合成の部分（ag-psd を含めて大きい）は、PSD 立ち絵を使うときだけ読み込む
type Compose = typeof import('./compose');
let composeMod: Compose | null = null;
const loadCompose = async () => (composeMod ??= await import('./compose'));
/** 読み込み済みの PSD があれば、合成の部分も読み込み済み */
const renderPsd: Compose['renderPsd'] = (doc, vis) => composeMod!.renderPsd(doc, vis);
/** 表示の決まり（「!」「*」）を当てた、各レイヤー自身の表示 */
export const effectiveVisibility: Compose['effectiveVisibility'] = (doc, vis) => composeMod!.effectiveVisibility(doc, vis);
import type {PsdDoc, PsdNode, Visibility} from './types';

// ───────────── 読み込み ─────────────

type Loaded = {doc: PsdDoc; stamp: string | null};
const docs = new Map<string, Promise<Loaded>>();

/** PSD を読む（同じファイル・同じ更新日時なら 1 回だけ） */
export async function loadPsdDoc(src: string, projectPath: string | null): Promise<Loaded> {
  const a = await api;
  const stamp = await a.fileStamp(src, projectPath).catch(() => null);
  const key = `${projectPath ?? ''}|${src}|${stamp ?? ''}`;
  let p = docs.get(key);
  if (!p) {
    p = Promise.all([a.readPsd(src, projectPath), loadCompose()]).then(([buf, c]) => ({doc: c.loadPsd(buf), stamp}));
    docs.set(key, p);
    p.catch(() => docs.delete(key));
  }
  return p;
}

/** 読み込み済みなら、すぐ返す（プレビューの描画中に待たないため） */
const ready = new Map<string, Loaded>();
function readyDoc(src: string, projectPath: string | null, onReady: () => void): Loaded | null {
  const k = `${projectPath ?? ''}|${src}`;
  const got = ready.get(k);
  if (got) return got;
  if (!pending.has(k)) {
    pending.add(k);
    void loadPsdDoc(src, projectPath)
      .then(l => {
        ready.set(k, l);
        onReady();
      })
      .catch(() => {})
      .finally(() => pending.delete(k));
  }
  return null;
}
const pending = new Set<string>();

/** PSD を読み直す（ファイルを差し替えたとき） */
export function forgetPsd(src: string) {
  for (const k of [...ready.keys()]) if (k.endsWith(`|${src}`)) ready.delete(k);
  for (const k of [...docs.keys()]) if (k.includes(`|${src}|`)) docs.delete(k);
  frames.clear();
}

// ───────────── 状態 → 表示 ─────────────

function ancestors(doc: PsdDoc, id: string): string[] {
  const out: string[] = [];
  let n = doc.byId.get(id);
  while (n?.parent) {
    out.push(n.parent);
    n = doc.byId.get(n.parent);
  }
  return out;
}

/**
 * 目 eyes・口 mouth・表情 expr のときの表示状態。
 * いつもの表示 → 表情の表示 → 目と口：割り当てたレイヤーのうち、今の状態のものだけを表示し、ほかは隠す
 * （「*」のグループなら compose 側で兄弟も隠れる）。表示するレイヤーの親グループも表示にする
 */
export function stateVisibility(doc: PsdDoc | null, psd: PsdPortrait, ex: Expression | undefined, eyes: number, mouth: number): Visibility {
  const vis: Visibility = {...psd.visibility, ...(ex?.visibility ?? {})};
  const apply = (parts: (string | null)[], i: number) => {
    const chosen = parts[i] ?? parts[0];
    for (const id of parts) if (id && id !== chosen) vis[id] = false;
    if (chosen) {
      vis[chosen] = true;
      if (doc) for (const a of ancestors(doc, chosen)) vis[a] = true;
    }
  };
  apply(psd.eyes, eyes);
  apply(psd.mouth, mouth);
  return vis;
}

const stableKey = (v: Visibility) =>
  Object.keys(v)
    .sort()
    .map(k => `${k}=${v[k] ? 1 : 0}`)
    .join(',');

// ───────────── プレビュー用 ─────────────

/** 状態ごとの合成結果（プレビュー用。大きすぎない大きさに縮めて持つ） */
const frames = new Map<string, HTMLCanvasElement>();
const FRAME_LIMIT = 64;
/** 合成待ち（1 つずつ、描画を止めないよう少しずつ） */
const queue: {key: string; run: () => void}[] = [];
let running = false;
function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  setTimeout(() => {
    try {
      job.run();
    } finally {
      running = false;
      pump();
    }
  }, 0);
}

/** プレビューに描く長辺の上限（大きな PSD でもメモリを使いすぎない） */
const PREVIEW_MAX = 2048;

/**
 * プレビュー用の画像と、元の PSD の大きさ。まだ無ければ null を返し、裏で合成して onReady を呼ぶ
 */
export function psdPreviewFrame(
  pt: Portrait,
  ex: Expression | undefined,
  eyes: number,
  mouth: number,
  projectPath: string | null,
  onReady: () => void,
): {image: HTMLCanvasElement; size: [number, number]} | null {
  const psd = pt.psd;
  if (!psd) return null;
  const loaded = readyDoc(psd.src, projectPath, onReady);
  if (!loaded) return null;
  const {doc} = loaded;
  const vis = stateVisibility(doc, psd, ex, eyes, mouth);
  const key = `${psd.src}|${loaded.stamp}|${stableKey(vis)}`;
  const got = frames.get(key);
  if (got) return {image: got, size: [doc.width, doc.height]};
  if (!queue.some(q => q.key === key)) {
    queue.push({
      key,
      run: () => {
        const full = renderPsd(doc, vis);
        const k = Math.min(1, PREVIEW_MAX / Math.max(doc.width, doc.height));
        let img = full;
        if (k < 1) {
          img = document.createElement('canvas');
          img.width = Math.round(doc.width * k);
          img.height = Math.round(doc.height * k);
          const c = img.getContext('2d')!;
          c.imageSmoothingQuality = 'high';
          c.drawImage(full, 0, 0, img.width, img.height);
        }
        if (frames.size >= FRAME_LIMIT) frames.delete(frames.keys().next().value!);
        frames.set(key, img);
        onReady();
      },
    });
    pump();
  }
  return null;
}

/** 設定画面の見本など：今の表示状態で 1 枚合成する（縮めて） */
export function renderThumb(doc: PsdDoc, vis: Visibility, maxSide: number): HTMLCanvasElement {
  const full = renderPsd(doc, vis);
  const k = Math.min(1, maxSide / Math.max(doc.width, doc.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(doc.width * k));
  c.height = Math.max(1, Math.round(doc.height * k));
  const x = c.getContext('2d')!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(full, 0, 0, c.width, c.height);
  return c;
}

// ───────────── 書き出し用（焼き込み） ─────────────

/** 文字列の短いハッシュ（FNV-1a 64 ビットを 2 つ） */
function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function toPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => c.toBlob(b => (b ? b.arrayBuffer().then(x => resolve(new Uint8Array(x)), reject) : reject(new Error('画像にできません'))), 'image/png'));
}

/**
 * 書き出しに使う PSD 立ち絵の画像を用意する（キャラクター id → 状態の番号 → PNG のパス）。
 * 使う表情（通常＋セリフで選んだ表情）× 目 3 × 口 3 を合成して保存する。同じ状態は前に作ったものを使う
 */
export async function bakePsdFrames(project: Project, projectPath: string | null, onProgress?: (ratio: number) => void): Promise<Record<string, Record<number, string>>> {
  const a: Api = await api;
  const out: Record<string, Record<number, string>> = {};
  const todo: {ch: Character; expr: number}[] = [];
  for (const ch of project.characters) {
    const pt = ch.portrait;
    if (!pt?.visible || !pt.psd) continue;
    const used = new Set<number>([0]);
    for (const c of project.clips) {
      if (c.type === 'voice' && c.characterId === ch.id) used.add(expressionIndex(pt, c.expression));
      // 立ち絵アイテムの既定の表情も
      if (c.type === 'portrait' && c.characterId === ch.id) used.add(expressionIndex(pt, c.expression));
    }
    // セリフでレイヤーの表示を変えたもの（表情の後ろの番号）
    for (const v of lineVariants(project, ch)) used.add(v.index);
    for (const e of used) todo.push({ch, expr: e});
  }
  const total = todo.length * 9;
  let done = 0;
  for (const {ch, expr} of todo) {
    const pt = ch.portrait!;
    const psd = pt.psd!;
    const {doc, stamp} = await loadPsdDoc(psd.src, projectPath);
    const ex = expressionFor(project, ch, expr);
    const m = (out[ch.id] ??= {});
    for (let eyes = 0; eyes < 3; eyes++)
      for (let mouth = 0; mouth < 3; mouth++) {
        const vis = stateVisibility(doc, psd, ex, eyes, mouth);
        const name = `psd-${hash(`${projectPath ?? ''}|${psd.src}|${stamp ?? ''}|${stableKey(vis)}`)}`;
        let path = await a.portraitPngPath(name);
        if (!path) {
          // 描画を止めないよう、1 枚ごとに一息つく
          await new Promise(r => setTimeout(r, 0));
          path = await a.writePortraitPng(name, await toPng(renderPsd(doc, vis)));
        }
        m[expr * 9 + eyes * 3 + mouth] = path;
        onProgress?.(++done / total);
      }
  }
  return out;
}

// ───────────── 目と口の自動割り当て ─────────────

const clean = (s: string) =>
  s
    .replace(/^[*!+]+/, '')
    .trim()
    .toLowerCase();

/** 候補の名前に、まず完全に一致するもの、次に含むものを探す */
function pick(children: PsdNode[], exact: string[], partial: string[] = []): PsdNode | undefined {
  for (const w of exact) {
    const hit = children.find(c => clean(c.name) === w);
    if (hit) return hit;
  }
  for (const w of partial) {
    const hit = children.find(c => clean(c.name).includes(w));
    if (hit) return hit;
  }
  return undefined;
}

const EYE_CLOSE = ['閉じ', '閉', 'とじ', '閉じ目', 'close', 'closed'];
const EYE_HALF = ['半目', '半', '細目', 'half'];
const EYE_OPEN = ['通常', '開', '普通', '開き', 'open', 'ノーマル', 'normal'];
const MOUTH_CLOSE = ['通常', 'ん', '閉', '閉じ', '普通', 'close', 'closed', 'む'];
const MOUTH_HALF = ['しゃべる', 'い', 'う', 'え', '半開き', '半', 'half'];
const MOUTH_OPEN = ['あ', 'お', '開', '開き', 'ワ', 'open'];

/** 名前に words のどれかを含むグループの中から、目（口）の状態の候補を子に持つグループを探す */
function findChoiceGroup(doc: PsdDoc, words: string[], marks: string[]): PsdNode | null {
  let best: {n: PsdNode; score: number} | null = null;
  const inside = (n: PsdNode | undefined): boolean => !!n && (words.some(w => clean(n.name).includes(w)) || inside(n.parent ? doc.byId.get(n.parent) : undefined));
  const walk = (ns: PsdNode[]) => {
    for (const n of ns) {
      if (n.kind === 'group' && inside(n)) {
        const score = n.children.filter(c => marks.includes(clean(c.name))).length;
        if (score > 0 && (!best || score > best.score)) best = {n, score};
      }
      walk(n.children);
    }
  };
  walk(doc.nodes);
  return best ? (best as {n: PsdNode}).n : null;
}

/**
 * レイヤー名から目 [開, 半目, 閉]・口 [閉, 半開き, 開] を推測する（YMM4 でよく使われる名前に合わせる）。
 * 「目」の中の「瞼」のように、状態の名前（通常・半目・閉じ）を子に持つグループを探す。見つからないところは null
 */
export function autoAssign(doc: PsdDoc): Pick<PsdPortrait, 'eyes' | 'mouth'> {
  const eyesG = findChoiceGroup(doc, ['目', 'eye', '瞼', 'まぶた'], [...EYE_CLOSE, ...EYE_HALF, ...EYE_OPEN]);
  const mouthG = findChoiceGroup(doc, ['口', 'mouth'], [...MOUTH_CLOSE, ...MOUTH_HALF, ...MOUTH_OPEN]);
  const ek = eyesG?.children ?? [];
  const mk = mouthG?.children ?? [];
  const eClose = pick(ek, EYE_CLOSE, ['閉', 'つぶ', 'つむ', 'close']);
  const eHalf = pick(ek, EYE_HALF, ['半']);
  const eOpen = pick(ek, EYE_OPEN) ?? ek.find(c => c.visible && c !== eClose && c !== eHalf);
  const mOpen = pick(mk, MOUTH_OPEN, ['開', 'open']);
  const mHalf = pick(mk, MOUTH_HALF, ['半', 'しゃべ']);
  const mClose = pick(mk, MOUTH_CLOSE) ?? mk.find(c => c.visible && c !== mOpen && c !== mHalf);
  return {
    eyes: [eOpen?.id ?? null, eHalf?.id ?? null, eClose?.id ?? null],
    mouth: [mClose?.id ?? null, mHalf?.id ?? null, mOpen?.id ?? null],
  };
}

/**
 * 「1 つだけ表示する」グループか（「*」が付いていなくても、子が 3 つ以上で、保存時に表示されている子が 1 つ以下なら、差分の選択肢と見なす）。
 * 設定画面で子を表示にしたとき、兄弟を自動で隠すのに使う
 */
export function isChoiceGroup(n: PsdNode): boolean {
  if (n.kind !== 'group' || n.children.length < 3) return false;
  return n.children.filter(c => c.visible && !c.forced).length <= 1;
}

/** レイヤーの場所を「グループ / レイヤー」の形で（選ぶ一覧の表示に使う） */
export function nodePath(doc: PsdDoc, id: string): string {
  const names: string[] = [];
  let n = doc.byId.get(id);
  while (n) {
    names.unshift(n.name || '（名前なし）');
    n = n.parent ? doc.byId.get(n.parent) : undefined;
  }
  return names.join(' / ');
}

/** すべてのレイヤー（グループも）を、上から順に並べる */
export function allNodes(doc: PsdDoc): PsdNode[] {
  const out: PsdNode[] = [];
  const walk = (ns: PsdNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(doc.nodes);
  return out;
}

/** 新しい PSD 立ち絵（自動割り当てつき） */
export function newPsdPortrait(src: string, doc: PsdDoc): PsdPortrait {
  return {src, visibility: {}, ...autoAssign(doc)};
}
