// キャラクターのアバター（丸い顔の絵）。立ち絵があれば顔のあたりを切り抜いて使い、無ければキャラクター色の丸に頭文字。
// 入力欄・台本・キャラクター一覧で、名前の文字だけでなく顔でも見分けられるように

import {useEffect, useState} from 'react';
import type {Character} from '../model';
import {useStore} from '../store';

/** 作ったアバターの画像（キャラクター id と立ち絵の指定ごと） */
const cache = new Map<string, Promise<string | null>>();

/** 絵の、透明でないところの上の端と左右（顔は上のほうにあるので、そこを丸く切り抜く） */
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
  let top = h;
  let left = w;
  let right = 0;
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2)
      if (data[(y * w + x) * 4 + 3] > 24) {
        if (y < top) top = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
  if (top >= h) return null;
  // 横幅のおよそ 6 割を一辺にした正方形を、上の端から少し下げて取る（頭のてっぺんから顎のあたり）
  const side = Math.max(8, Math.min(h - top, (right - left) * 0.62));
  const cx = (left + right) / 2;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const o = out.getContext('2d')!;
  o.imageSmoothingQuality = 'high';
  o.drawImage(probe, cx - side / 2, top + side * 0.04, side, side, 0, 0, size, size);
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
  const style: React.CSSProperties = {width: size, height: size, borderColor: color, background: url ? `${color} url(${url}) center / cover` : color, fontSize: Math.round(size * 0.5)};
  return (
    <span className="vx-avatar" style={style} aria-hidden>
      {!url && (character?.name ?? '?').slice(0, 1)}
    </span>
  );
}
