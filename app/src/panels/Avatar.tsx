// キャラクターのアバター（丸い顔の絵）。立ち絵があれば顔のあたりを切り抜いて使い、無ければキャラクター色の丸に頭文字。
// 入力欄・台本・キャラクター一覧で、名前の文字だけでなく顔でも見分けられるように

import {useEffect, useState} from 'react';
import type {Character} from '../model';
import {useStore} from '../store';

/** 作ったアバターの画像（キャラクター id と立ち絵の指定ごと） */
const cache = new Map<string, Promise<string | null>>();

/**
 * 立ち絵から顔のあたりを正方形に切り抜く。
 * 透明でないところの高さ H から頭の大きさ（立ち絵ではおよそ H の 1/6〜1/7）を見積もり、
 * 上の端から頭 1 つ分の行で、絵のある横位置の真ん中を顔の中心にする（髪のてっぺんではなく目と口が入るように）
 */
function faceCrop(src: CanvasImageSource & {width: number; height: number}, size: number): string | null {
  const w = src.width;
  const h = src.height;
  if (!w || !h) return null;
  const probe = document.createElement('canvas');
  probe.width = w;
  probe.height = h;
  const px = probe.getContext('2d', {willReadFrequently: true})!;
  px.drawImage(src, 0, 0);
  const data = px.getImageData(0, 0, w, h).data;
  const solid = (x: number, y: number) => data[(y * w + x) * 4 + 3] > 24;
  let top = h;
  let bottom = 0;
  let left = w;
  let right = 0;
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2)
      if (solid(x, y)) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
  if (top >= h) return null;
  const tall = bottom - top;
  // 縦長の立ち絵なら頭 1 つ分、横長・顔だけの絵なら絵全体
  const portraitLike = tall > (right - left) * 1.3;
  // 頭の高さ：上から 1 行ずつ絵の幅を見て、いったん広がった幅が細くなる所（首）まで。見つからなければ全体の 1/6 ほど
  const rowWidth = (y: number) => {
    let l = -1;
    let r = -1;
    for (let x = left; x <= right; x += 2)
      if (solid(x, y)) {
        if (l < 0) l = x;
        r = x;
      }
    return l < 0 ? 0 : r - l;
  };
  let neck = 0;
  let peak = 0;
  for (let y = top; y < top + tall * 0.6; y += 2) {
    const wy = rowWidth(y);
    if (wy > peak) peak = wy;
    else if (peak > 0 && y - top > tall * 0.06 && wy < peak * 0.62) {
      neck = y - top;
      break;
    }
  }
  const head = portraitLike ? Math.max(16, neck || tall * 0.17) : Math.min(tall, right - left);
  // 頭の行の、絵のある横位置の中心（体が傾いていても顔を追う）
  let sx = 0;
  let n = 0;
  for (let y = top; y < Math.min(h, top + head); y += 2)
    for (let x = left; x <= right; x += 2)
      if (solid(x, y)) {
        sx += x;
        n++;
      }
  const cx = n ? sx / n : (left + right) / 2;
  // 正方形の一辺は頭の高さ。首が見つかったなら頭全体が入る。見積もりなら上の髪を少し切る
  const side = portraitLike ? (neck ? head * 1.05 : head * 1.15) : head;
  const y0 = portraitLike ? top + (neck ? -head * 0.02 : head * 0.12) : top;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const o = out.getContext('2d')!;
  o.imageSmoothingQuality = 'high';
  o.drawImage(probe, cx - side / 2, y0, side, side, 0, 0, size, size);
  return out.toDataURL('image/png');
}

async function makeAvatar(ch: Character, projectPath: string | null): Promise<string | null> {
  const pt = ch.portrait;
  if (!pt) return null;
  if (pt.psd) {
    const {loadPsdDoc, stateVisibility, renderThumb} = await import('../psd/portrait');
    const {doc} = await loadPsdDoc(pt.psd.src, projectPath);
    // 目を開けて口を閉じた、いつもの姿
    return faceCrop(renderThumb(doc, stateVisibility(doc, pt.psd, undefined, 0, 0), 360), 64);
  }
  if (!pt.base) return null;
  const {api} = await import('../ipc');
  const url = (await api).mediaUrl(pt.base, projectPath);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  return faceCrop(img, 64);
}

/** キャラクターの丸いアバター。size は px */
export function Avatar({character, size = 20}: {character: Character | undefined; size?: number}) {
  const projectPath = useStore(s => s.projectPath);
  const pt = character?.portrait;
  const key = character ? `${character.id}|${projectPath ?? ''}|${pt?.psd?.src ?? pt?.base ?? ''}|${JSON.stringify(pt?.psd?.visibility ?? {})}` : '';
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!character?.portrait) return;
    let p = cache.get(key);
    if (!p) {
      p = makeAvatar(character, projectPath).catch(() => null);
      cache.set(key, p);
    }
    void p.then(u => alive && setUrl(u));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const color = character?.color ?? '#8E8E93';
  // 顔の絵も人の形も、キャラクター色の薄い下地＋色の枠で同じ重さに見せる（人の形はキャラクター色で描く）
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderColor: color,
    color,
    background: url ? `url(${url}) center / cover, color-mix(in srgb, ${color} 22%, var(--color-background-surface))` : `color-mix(in srgb, ${color} 22%, var(--color-background-surface))`,
    fontSize: Math.round(size * 0.5),
  };
  return (
    <span className="vx-avatar" style={style} aria-hidden>
      {/* 立ち絵が無ければ、立ち絵の顔アイコンと同じ調子の簡単な顔（髪の色がキャラクターの色） */}
      {!url && (
        <svg viewBox="0 0 24 24" width="100%" height="100%">
          <circle cx="12" cy="14" r="8.4" fill="#F8D9C4" />
          <path d="M3.2 14.5C3 8.6 7 4.6 12 4.6s9 4 8.8 9.9c-1.6-3.2-4.6-4.9-8.8-4.1-4.2-.8-7.2.9-8.8 4.1z" fill="currentColor" />
          <circle cx="9.3" cy="15" r="1.05" fill="#2B2B3A" />
          <circle cx="14.7" cy="15" r="1.05" fill="#2B2B3A" />
          <ellipse cx="7.6" cy="17.4" rx="1.4" ry="0.8" fill="#F4A6A0" opacity="0.7" />
          <ellipse cx="16.4" cy="17.4" rx="1.4" ry="0.8" fill="#F4A6A0" opacity="0.7" />
          <path d="M10.9 18.3q1.1.8 2.2 0" stroke="#B5645C" strokeWidth="0.7" fill="none" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}
