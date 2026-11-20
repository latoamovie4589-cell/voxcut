// 立ち位置の自動整列：立ち絵を出しているキャラクターを、画面に均等に並べる（左から右への今の順を保つ）。

import type {Project} from './model';

export interface Arrange {
  characterId: string;
  x: number;
}

/**
 * 並べる位置。span は画面の幅のうち使う割合（0.5〜1）。n 人なら幅を n 等分した真ん中に置く。
 * onlyAppearing なら、セリフのあるキャラクターだけ（それ以外は動かさない）。いまと同じ位置のものは省く
 */
export function planArrange(p: Project, span: number, onlyAppearing: boolean): Arrange[] {
  const speaking = new Set(p.clips.filter(c => c.type === 'voice').map(c => (c as {characterId: string}).characterId));
  const chars = p.characters
    .filter(c => c.portrait?.visible && (!onlyAppearing || speaking.has(c.id)))
    .sort((a, b) => a.portrait!.transform.x - b.portrait!.transform.x);
  const w = p.video.width * Math.min(1, Math.max(0.5, span));
  return chars
    .map((c, i) => ({characterId: c.id, x: Math.round(((i + 0.5) / chars.length - 0.5) * w)}))
    .filter(a => a.x !== Math.round(chars.find(c => c.id === a.characterId)!.portrait!.transform.x));
}
