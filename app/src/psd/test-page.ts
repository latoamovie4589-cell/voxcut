// PSD 合成の確かめ用ページ（psd-test.html）。scripts/psd-check.py から動かす。
// psd-fixtures/<名前>/src.psd を合成し、Photoshop が保存した合成画像（canvas.png と PSD 内の合成画像）と比べる。

import type {Layer} from 'ag-psd';
import {effectiveVisibility, isVisible, loadPsd, renderPsd} from './compose';
import type {PsdDoc, PsdNode, Visibility} from './types';

interface Diff {
  /** R・G・B・A ごとの平均の差（0〜255。色は不透明度をかけた値で比べる） */
  mae: number[];
  /** どれかの値が 8 より大きく違う画素の割合（%） */
  over8: number;
  diffPng: string;
}

function pixelsOf(src: CanvasImageSource, w: number, h: number): ImageData {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', {willReadFrequently: true})!;
  ctx.drawImage(src, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

/** 正解が全部不透明なら、こちらも白の上に置いてから比べる（透明を白で保存した PSD のため） */
function compare(got: ImageData, want: ImageData): Diff {
  const g = got.data;
  const w = want.data;
  let opaque = true;
  for (let i = 3; i < w.length; i += 4) if (w[i] !== 255) opaque = false;
  const sum = [0, 0, 0, 0];
  let over = 0;
  const out = new ImageData(got.width, got.height);
  const o = out.data;
  const n = got.width * got.height;
  for (let i = 0; i < g.length; i += 4) {
    const ga = g[i + 3] / 255;
    const wa = w[i + 3] / 255;
    let bad = false;
    for (let c = 0; c < 4; c++) {
      let gv: number;
      let wv: number;
      if (c === 3) {
        gv = opaque ? 255 : g[i + 3];
        wv = w[i + 3];
      } else if (opaque) {
        gv = g[i + c] * ga + 255 * (1 - ga);
        wv = w[i + c];
      } else {
        gv = g[i + c] * ga;
        wv = w[i + c] * wa;
      }
      const d = Math.abs(gv - wv);
      sum[c] += d;
      if (d > 8) bad = true;
      if (c < 3) o[i + c] = Math.min(255, d * 4);
    }
    o[i + 3] = 255;
    if (bad) {
      over++;
      // 大きく違う画素は赤で目立たせる
      o[i] = Math.max(o[i], 160);
    }
  }
  const c = document.createElement('canvas');
  c.width = got.width;
  c.height = got.height;
  c.getContext('2d')!.putImageData(out, 0, 0);
  return {mae: sum.map(s => s / n), over8: (over / n) * 100, diffPng: c.toDataURL('image/png')};
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, ng) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => ng(new Error(`読めない: ${url}`));
    im.src = url;
  });
}

async function check(name: string) {
  const dir = name;
  // 「名前.psd」は psd-fixtures 直下のファイル（正解は PSD 内の合成画像だけ）
  const single = dir.endsWith('.psd');
  const buf = await (await fetch(single ? `/psd-fixtures/${dir}` : `/psd-fixtures/${dir}/src.psd`)).arrayBuffer();
  const t0 = performance.now();
  const doc = loadPsd(buf);
  const tLoad = performance.now() - t0;
  const t1 = performance.now();
  const out = renderPsd(doc, {});
  const tFirst = performance.now() - t1;
  const t2 = performance.now();
  renderPsd(doc, {});
  const tAgain = performance.now() - t2;
  const got = pixelsOf(out, doc.width, doc.height);
  const res: Record<string, unknown> = {name, width: doc.width, height: doc.height, tLoad, tFirst, tAgain, renderPng: out.toDataURL('image/png')};
  // 直下の「名前.psd」は、同じ名前の .png があればそれも正解として比べる
  if (!single || !dir.startsWith('akane'))
    try {
      const im = await loadImage(single ? `/psd-fixtures/${dir.replace(/\.psd$/, '.png')}` : `/psd-fixtures/${dir}/canvas.png`);
      if (im.width === doc.width && im.height === doc.height) res.png = compare(got, pixelsOf(im, doc.width, doc.height));
      else res.png = {error: `大きさが違う ${im.width}x${im.height}`};
    } catch (e) {
      res.png = {error: String(e)};
    }
  if (doc.composite) res.composite = compare(got, pixelsOf(doc.composite, doc.width, doc.height));
  return res;
}

/** 任意の PSD（大きいもの）を読み、何度か合成して時間を測る */
async function bench(url: string, times = 5) {
  const buf = await (await fetch(url)).arrayBuffer();
  const t0 = performance.now();
  const doc = loadPsd(buf);
  const tLoad = performance.now() - t0;
  const ts: number[] = [];
  const ids = [...doc.byId.keys()];
  for (let i = 0; i < times; i++) {
    // 毎回いくつかの表示を変える
    const vis: Visibility = {};
    for (let k = 0; k < ids.length; k += 7) vis[ids[(k + i) % ids.length]] = i % 2 === 0;
    const t = performance.now();
    renderPsd(doc, vis);
    ts.push(performance.now() - t);
  }
  // いちばん重い場合：すべてのノードを表示
  const all: Visibility = {};
  for (const id of ids) all[id] = true;
  for (let i = 0; i < 2; i++) {
    const t = performance.now();
    renderPsd(doc, all);
    ts.push(performance.now() - t);
  }
  return {layers: doc.byId.size, width: doc.width, height: doc.height, tLoad, times: ts};
}

// ───────────── 表示状態の決まりの確かめ ─────────────

function fakeDoc(): PsdDoc {
  const byId = new Map<string, PsdNode>();
  const mk = (id: string, name: string, visible: boolean, parent: string | null, children: PsdNode[] = []): PsdNode => {
    const n: PsdNode = {id, name, kind: children.length ? 'group' : 'layer', visible, radio: name.startsWith('*'), forced: name.startsWith('!'), children, parent, layer: {name, hidden: !visible}};
    byId.set(id, n);
    return n;
  };
  const mouth = mk('0', '口', true, null, [mk('0/0', '*あ', true, '0'), mk('0/1', '*い', true, '0'), mk('0/2', '*う', false, '0'), mk('0/3', '普通', false, '0')]);
  const eyes = mk('1', '目', false, null, [mk('1/0', '*開', false, '1'), mk('1/1', '*閉', false, '1')]);
  const always = mk('2', '!影', false, null);
  return {width: 1, height: 1, nodes: [mouth, eyes, always], byId, composite: null, psd: {width: 1, height: 1}};
}

function unit() {
  const results: {name: string; ok: boolean; detail?: string}[] = [];
  const expect = (name: string, got: unknown, want: unknown) =>
    results.push({name, ok: JSON.stringify(got) === JSON.stringify(want), detail: `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`});
  const doc = fakeDoc();
  const ev = (v: Visibility) => Object.fromEntries(effectiveVisibility(doc, v));
  // 保存時に「*」が 2 つ表示 → 上のものだけ
  expect('保存時の * は上のもの 1 つ', ev({}), {'0': true, '0/0': true, '0/1': false, '0/2': false, '0/3': false, '1': false, '1/0': false, '1/1': false, '2': true});
  // 指定で別のものを表示 → ほかの * は隠れる（* でないものは関係ない）
  const v1 = ev({'0/2': true, '0/3': true});
  expect('指定した * だけ表示', [v1['0/0'], v1['0/1'], v1['0/2'], v1['0/3']], [false, false, true, true]);
  // 上のものを隠す指定 → 保存時に表示の次のもの
  const v2 = ev({'0/0': false});
  expect('上の * を隠すと次の * ', [v2['0/0'], v2['0/1'], v2['0/2']], [false, true, false]);
  // 全部隠す指定
  const v3 = ev({'0/0': false, '0/1': false});
  expect('* を全部隠せる', [v3['0/0'], v3['0/1'], v3['0/2']], [false, false, false]);
  // 「!」はいつも表示（隠す指定も効かない）
  expect('! はいつも表示', ev({'2': false})['2'], true);
  // 親が隠れていても、ノード自体の表示は別（合成のときに親も見る）
  const v4 = ev({'1/1': true});
  expect('親とは別に決まる', [v4['1'], v4['1/0'], v4['1/1']], [false, false, true]);
  return results;
}

/** 実際の PSD で、表示の指定が合成に効くか（全部隠すと透明、親を隠すと子も出ない） */
async function renderUnit(name: string) {
  const buf = await (await fetch(`/psd-fixtures/${name}`)).arrayBuffer();
  const doc = loadPsd(buf);
  const results: {name: string; ok: boolean; detail?: string}[] = [];
  const alphaSum = (c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 3; i < d.length; i += 4) s += d[i];
    return s;
  };
  const hideAll: Visibility = {};
  for (const n of doc.nodes) hideAll[n.id] = false;
  const forced = doc.nodes.filter(n => n.forced);
  const nonForcedHidden = alphaSum(renderPsd(doc, hideAll));
  // 「!」のレイヤーだけが残るはず
  results.push({name: `${name}: 全部隠すと「!」だけ残る`, ok: forced.length ? nonForcedHidden > 0 : nonForcedHidden === 0, detail: `alpha=${nonForcedHidden}`});
  // isVisible は effectiveVisibility と同じ答え（「*」の兄弟も見る）
  for (const vis of [{}, ...[...doc.byId.values()].filter(n => n.radio).map(n => ({[n.id]: true}))] as Visibility[]) {
    const all = effectiveVisibility(doc, vis);
    const same = [...doc.byId.values()].every(n => isVisible(n, vis) === all.get(n.id));
    results.push({name: `${name}: isVisible と effectiveVisibility が同じ ${JSON.stringify(vis)}`, ok: same});
  }
  // 「*」の切り替えで絵が変わる
  for (const g of doc.byId.values()) {
    const radios = g.children.filter(n => n.radio);
    if (radios.length < 2) continue;
    const a = renderPsd(doc, {[radios[0].id]: true}).toDataURL();
    const b = renderPsd(doc, {[radios[1].id]: true}).toDataURL();
    const b2 = renderPsd(doc, {[radios[1].id]: true, [radios[0].id]: true}).toDataURL();
    results.push({name: `${name}: ${g.name} の「*」で絵が変わる`, ok: a !== b});
    // 2 つ表示を指定すると上のものだけ（= 上だけ指定したのと同じ）
    results.push({name: `${name}: ${g.name} の「*」を 2 つ指定すると上のもの`, ok: b2 === a});
    // 親グループを隠すと「*」を指定しても出ない
    const hiddenParent = renderPsd(doc, {[g.id]: false, [radios[1].id]: true}).toDataURL();
    const hiddenParent2 = renderPsd(doc, {[g.id]: false}).toDataURL();
    results.push({name: `${name}: ${g.name} を隠すと子も出ない`, ok: hiddenParent === hiddenParent2});
  }
  return results;
}

// ───────────── 手で作った PSD での確かめ（クリッピング・グループなど、正解の PSD が無いもの） ─────────────

type L = Layer & {kids?: L[]};
/** 100×100 の文書。rect の範囲を色 rgba（0〜255、a は 0〜1）で塗ったレイヤー */
function px(name: string, rect: [number, number, number, number], rgba: [number, number, number, number], extra: Partial<Layer> = {}): L {
  const [x, y, w, h] = rect;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3]})`;
  ctx.fillRect(0, 0, w, h);
  return {name, canvas: c, left: x, top: y, right: x + w, bottom: y + h, blendMode: 'normal', opacity: 1, ...extra};
}
const grp = (name: string, kids: L[], extra: Partial<Layer> = {}): L => ({name, children: kids, blendMode: 'pass through', opacity: 1, ...extra});
/** 上が先の並びから PsdDoc を作る */
function synthDoc(top: L[]): PsdDoc {
  const byId = new Map<string, PsdNode>();
  const walk = (list: L[], parent: string | null): PsdNode[] =>
    list.map((l, i) => {
      const id = parent === null ? String(i) : `${parent}/${i}`;
      const name = l.name ?? '';
      const n: PsdNode = {id, name, kind: l.children ? 'group' : 'layer', visible: !l.hidden, radio: name.startsWith('*'), forced: name.startsWith('!'), children: [], parent, layer: l};
      byId.set(id, n);
      n.children = walk((l.children as L[] | undefined) ?? [], id);
      // ag-psd と同じく、レイヤーの子は下から上の順で持つ
      if (l.children) l.children = [...l.children].reverse();
      return n;
    });
  const nodes = walk(top, null);
  return {width: 100, height: 100, nodes, byId, composite: null, psd: {width: 100, height: 100, children: [...top].reverse()}};
}

function synth() {
  const results: {name: string; ok: boolean; detail?: string}[] = [];
  const white = () => px('白', [0, 0, 100, 100], [255, 255, 255, 1]);
  const at = (doc: PsdDoc, x: number, y: number, vis: Visibility = {}) => [...renderPsd(doc, vis).getContext('2d')!.getImageData(x, y, 1, 1).data];
  const near = (name: string, got: number[], want: number[]) => results.push({name, ok: got.every((v, i) => Math.abs(v - want[i]) <= 2), detail: `got ${got} want ${want}`});

  // クリッピング：土台（赤、不透明度 50% の画素）に青 50% をクリップ → 土台の形の中だけ、土台の色に混ぜる
  const clipDoc = () => synthDoc([px('青', [0, 0, 100, 100], [0, 0, 255, 1], {clipping: true, opacity: 0.5}), px('赤', [20, 20, 40, 40], [255, 0, 0, 0.5]), white()]);
  near('クリッピング：土台の中', at(clipDoc(), 30, 30), [191, 128, 191, 255]);
  near('クリッピング：土台の外は出ない', at(clipDoc(), 80, 80), [255, 255, 255, 255]);
  near('クリッピング：土台を隠すと出ない', at(clipDoc(), 30, 30, {'1': false}), [255, 255, 255, 255]);
  near('クリッピング：クリップされたものだけ隠す', at(clipDoc(), 30, 30, {'0': false}), [255, 128, 128, 255]);
  // 土台の塗り 0%：土台の色は出ず、形だけが効く
  const fill0 = synthDoc([px('青', [0, 0, 100, 100], [0, 0, 255, 1], {clipping: true, opacity: 0.5}), px('赤', [20, 20, 40, 40], [255, 0, 0, 0.5], {fillOpacity: 0}), white()]);
  near('クリッピング：土台の塗り 0%', at(fill0, 30, 30), [191, 191, 255, 255]);
  // 乗算でクリップ：赤×緑 = 黒（土台の色に対して乗算）
  const mul = synthDoc([px('緑', [0, 0, 100, 100], [0, 255, 0, 1], {clipping: true, blendMode: 'multiply'}), px('赤', [20, 20, 40, 40], [255, 0, 0, 1]), white()]);
  near('クリッピング：乗算は土台の色に', at(mul, 30, 30), [0, 0, 0, 255]);
  // 土台の不透明度は、まとめた結果にかかる
  const baseOp = synthDoc([px('青', [0, 0, 100, 100], [0, 0, 255, 1], {clipping: true}), px('赤', [20, 20, 40, 40], [255, 0, 0, 1], {opacity: 0.5}), white()]);
  near('クリッピング：土台の不透明度', at(baseOp, 30, 30), [128, 128, 255, 255]);
  // グループが土台
  const gBase = synthDoc([px('青', [0, 0, 100, 100], [0, 0, 255, 1], {clipping: true, blendMode: 'screen'}), grp('グ', [px('赤', [20, 20, 40, 40], [255, 0, 0, 1])], {blendMode: 'normal'}), white()]);
  near('クリッピング：グループが土台', at(gBase, 30, 30), [255, 0, 255, 255]);
  near('クリッピング：グループの外', at(gBase, 70, 70), [255, 255, 255, 255]);

  // 通過グループ：中の乗算は下の白まで届く。通常グループ：単独で合成するので、透明の上の乗算 = そのままの色
  const gray = () => px('灰', [0, 0, 100, 100], [128, 128, 128, 1]);
  const inner = () => [px('赤', [0, 0, 100, 100], [255, 0, 0, 1], {blendMode: 'multiply'})];
  near('通過グループ：乗算が下に届く', at(synthDoc([grp('グ', inner()), gray()]), 50, 50), [128, 0, 0, 255]);
  near('通常グループ：単独の合成', at(synthDoc([grp('グ', inner(), {blendMode: 'normal'}), gray()]), 50, 50), [255, 0, 0, 255]);
  near('乗算グループ：結果を乗算', at(synthDoc([grp('グ', [px('黄', [0, 0, 100, 100], [255, 255, 0, 1])], {blendMode: 'multiply'}), gray()]), 50, 50), [128, 128, 0, 255]);
  // 通過グループの不透明度 50%：中身を重ねた絵と元の絵を半々に混ぜる
  near('通過グループの不透明度', at(synthDoc([grp('グ', inner(), {opacity: 0.5}), gray()]), 50, 50), [128, 64, 64, 255]);
  near('通常グループの不透明度', at(synthDoc([grp('グ', inner(), {blendMode: 'normal', opacity: 0.5}), gray()]), 50, 50), [191, 64, 64, 255]);
  // グループの中のクリッピングは、そのグループの中だけ
  const nested = synthDoc([grp('グ', [px('青', [0, 0, 100, 100], [0, 0, 255, 1], {clipping: true}), px('赤', [20, 20, 40, 40], [255, 0, 0, 1])]), white()]);
  near('グループの中のクリッピング', at(nested, 30, 30), [0, 0, 255, 255]);
  near('グループの中のクリッピング（外）', at(nested, 80, 80), [255, 255, 255, 255]);
  // 文書の外にはみ出したレイヤー・空のレイヤー
  near('はみ出したレイヤー', at(synthDoc([px('赤', [-50, -50, 100, 100], [255, 0, 0, 1]), white()]), 10, 10), [255, 0, 0, 255]);
  near('はみ出したレイヤー（外）', at(synthDoc([px('赤', [-50, -50, 100, 100], [255, 0, 0, 1]), white()]), 60, 60), [255, 255, 255, 255]);
  near('空のレイヤー', at(synthDoc([{name: '空', blendMode: 'multiply', opacity: 1}, white()]), 10, 10), [255, 255, 255, 255]);
  // 調整レイヤー（階調の反転）：通過グループの中なら下まで、通常グループの中ならグループの中だけ
  const inv = (): L => ({name: '反転', adjustment: {type: 'invert'}, blendMode: 'normal', opacity: 1});
  near('反転', at(synthDoc([inv(), gray()]), 10, 10), [127, 127, 127, 255]);
  near('反転（通常グループの中は下に届かない）', at(synthDoc([grp('グ', [inv()], {blendMode: 'normal'}), px('赤', [0, 0, 100, 100], [255, 0, 0, 1])]), 10, 10), [255, 0, 0, 255]);
  near('反転（通過グループの中は届く）', at(synthDoc([grp('グ', [inv()]), px('赤', [0, 0, 100, 100], [255, 0, 0, 1])]), 10, 10), [0, 255, 255, 255]);
  // ベクトルマスク（パス）：四角の和から小さな四角を引く。反転も
  const box = (x0: number, y0: number, x1: number, y1: number) =>
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map(([x, y]) => ({linked: false, points: [x, y, x, y, x, y]}));
  const vm = (invert: boolean) =>
    synthDoc([
      px('赤', [0, 0, 100, 100], [255, 0, 0, 1], {
        vectorMask: {
          invert,
          paths: [
            {open: false, operation: 'combine', fillRule: 'even-odd', knots: box(10, 10, 60, 60)},
            {open: false, operation: 'subtract', fillRule: 'even-odd', knots: box(30, 30, 40, 40)},
          ],
        },
      }),
      white(),
    ]);
  near('ベクトルマスク：中', at(vm(false), 20, 20), [255, 0, 0, 255]);
  near('ベクトルマスク：引いた穴', at(vm(false), 35, 35), [255, 255, 255, 255]);
  near('ベクトルマスク：外', at(vm(false), 80, 80), [255, 255, 255, 255]);
  near('ベクトルマスク：反転', at(vm(true), 80, 80), [255, 0, 0, 255]);
  // グループのマスク（ピクセルマスクを手で作る：左半分だけ白）
  const mk = document.createElement('canvas');
  mk.width = 100;
  mk.height = 100;
  const mctx = mk.getContext('2d')!;
  mctx.fillStyle = 'black';
  mctx.fillRect(0, 0, 100, 100);
  mctx.fillStyle = 'white';
  mctx.fillRect(0, 0, 50, 100);
  const gm = (mode: Layer['blendMode']) => synthDoc([grp('グ', inner(), {blendMode: mode, mask: {left: 0, top: 0, right: 100, bottom: 100, defaultColor: 0, canvas: mk}}), gray()]);
  near('通過グループのマスク：中', at(gm('pass through'), 20, 50), [128, 0, 0, 255]);
  near('通過グループのマスク：外', at(gm('pass through'), 80, 50), [128, 128, 128, 255]);
  near('通常グループのマスク：中', at(gm('normal'), 20, 50), [255, 0, 0, 255]);
  near('通常グループのマスク：外', at(gm('normal'), 80, 50), [128, 128, 128, 255]);
  // ディザ合成：不透明度 50% なら、画素はおよそ半分が不透明・半分が透明
  const dz = renderPsd(synthDoc([px('赤', [0, 0, 100, 100], [255, 0, 0, 1], {blendMode: 'dissolve', opacity: 0.5})]), {});
  const dd = dz.getContext('2d')!.getImageData(0, 0, 100, 100).data;
  let on = 0;
  let mid = 0;
  for (let i = 3; i < dd.length; i += 4) {
    if (dd[i] === 255) on++;
    else if (dd[i] !== 0) mid++;
  }
  results.push({name: 'ディザ合成', ok: mid === 0 && on > 4500 && on < 5500, detail: `on=${on} mid=${mid}`});
  return results;
}

/** 3000×4000・150 レイヤー（3 割はクリッピング、乗算・スクリーン・ソフトライトなどを混ぜる）の合成時間。#native を付けて開くと Canvas で描けるモードだけにする */
function synthBench() {
  const W = 3000;
  const H = 4000;
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const modes: Layer['blendMode'][] = (
    location.hash === '#native' ? ['normal', 'normal', 'normal', 'multiply', 'screen', 'overlay'] : ['normal', 'normal', 'normal', 'multiply', 'screen', 'overlay', 'soft light', 'linear dodge']
  ) as Layer['blendMode'][];
  const layers: L[] = [];
  for (let i = 0; i < 150; i++) {
    const w = 400 + Math.floor(rnd() * 1200);
    const h = 400 + Math.floor(rnd() * 1600);
    const l = px(`L${i}`, [Math.floor(rnd() * (W - w)), Math.floor(rnd() * (H - h)), w, h], [Math.floor(rnd() * 255), Math.floor(rnd() * 255), Math.floor(rnd() * 255), 0.9], {
      blendMode: modes[Math.floor(rnd() * modes.length)],
      clipping: i % 3 === 1,
    });
    layers.push(l);
  }
  // 10 枚ずつグループにする（通過と通常を交互に）
  const groups: L[] = [];
  for (let g = 0; g < 15; g++) groups.push(grp(`G${g}`, layers.slice(g * 10, g * 10 + 10).reverse(), {blendMode: g % 2 ? 'normal' : 'pass through'}));
  const doc = synthDoc(groups.reverse());
  (doc as {width: number}).width = W;
  (doc as {height: number}).height = H;
  const ts: number[] = [];
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    renderPsd(doc, i % 2 ? {'3': false} : {});
    ts.push(performance.now() - t);
  }
  return ts;
}

declare global {
  interface Window {
    psdCheck: typeof check;
    psdBench: typeof bench;
    psdUnit: typeof unit;
    psdRenderUnit: typeof renderUnit;
    psdSynth: typeof synth;
    psdSynthBench: typeof synthBench;
    psdReady: boolean;
  }
}
window.psdCheck = check;
window.psdBench = bench;
window.psdUnit = unit;
window.psdRenderUnit = renderUnit;
window.psdSynth = synth;
window.psdSynthBench = synthBench;
window.psdReady = true;
document.body.textContent = 'PSD 合成の確かめ：scripts/psd-check.py から動かす';
