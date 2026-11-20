// 場面の切り替えとキーワード画像の自動配置：置く場所・種類を決めるだけの計算。置く処理は store.ts（applyTransitions・placeKeywordImages）。

import type {MediaClip, Project, Transition, TransitionKind, VoiceClip} from './model';
import {prevAdjacent} from './model';

export const TRANSITION_LABEL: Record<TransitionKind, string> = {
  dissolve: 'ディゾルブ',
  black: '暗転',
  white: '白く光る',
  slideLeft: '左へ流す',
  slideRight: '右へ流す',
  slideUp: '上へ流す',
  slideDown: '下へ流す',
  zoom: 'ズーム',
  wipeRight: 'ワイプ（右へ）',
  wipeLeft: 'ワイプ（左へ）',
  wipeDown: 'ワイプ（下へ）',
  wipeUp: 'ワイプ（上へ）',
  iris: '円形',
  blur: 'ブラー',
  glitch: 'グリッチ',
};

/** 「いろいろ順番に」で使う種類（落ち着いたものを順に） */
export const MIXED_KINDS: TransitionKind[] = ['dissolve', 'slideLeft', 'wipeRight', 'zoom', 'blur', 'slideUp', 'iris'];

const isPicture = (c: {type: string; mediaKind?: string}): c is MediaClip => c.type === 'media' && (c.mediaKind === 'image' || c.mediaKind === 'video');

/**
 * 切り替えを付ける場所：同じレイヤーで前の画像・動画にすき間なく続く画像・動画（頭から順）。
 * only があればその中だけ。replace でなければ、すでに切り替えが付いているものは飛ばす。
 * 種類は kinds を順番に（1 つならずっとそれ）
 */
export function planTransitions(p: Project, kinds: TransitionKind[], frames: number, opts: {only?: string[] | null; replace?: boolean} = {}): {id: string; transition: Transition}[] {
  if (!kinds.length) return [];
  const out: {id: string; transition: Transition}[] = [];
  const list = p.clips.filter(isPicture).sort((a, b) => a.start - b.start);
  for (const b of list) {
    if (opts.only && !opts.only.includes(b.id)) continue;
    const a = prevAdjacent(p, b);
    if (!a || !isPicture(a)) continue;
    if (!opts.replace && b.look?.transition) continue;
    out.push({id: b.id, transition: {kind: kinds[out.length % kinds.length], frames}});
  }
  return out;
}

/** 言葉と画像の対応 */
export interface KeywordRule {
  keyword: string;
  path: string;
}

/** 画像を出す区間（フレーム） */
export interface Span {
  start: number;
  duration: number;
}

/**
 * 言葉を含むセリフの間を、言葉ごとに（すき間なく続くセリフはまとめて 1 つの区間に）求める。
 * 戻りは rules と同じ並びで、当てはまる区間が無ければ空
 */
export function planKeywordSpans(p: Project, rules: KeywordRule[]): Span[][] {
  const voices = p.clips.filter((c): c is VoiceClip => c.type === 'voice' && !!c.text.trim()).sort((a, b) => a.start - b.start);
  return rules.map(r => {
    const kw = r.keyword.trim();
    if (!kw) return [];
    const spans: Span[] = [];
    for (const v of voices) {
      if (!v.text.includes(kw)) continue;
      const last = spans[spans.length - 1];
      if (last && v.start <= last.start + last.duration + 2) last.duration = Math.max(last.duration, v.start + v.duration - last.start);
      else spans.push({start: v.start, duration: v.duration});
    }
    return spans;
  });
}

export type ImagePos = 'center' | 'topRight' | 'topLeft' | 'bottomRight' | 'bottomLeft';
export const IMAGE_POS_LABEL: Record<ImagePos, string> = {center: '真ん中', topRight: '右上', topLeft: '左上', bottomRight: '右下', bottomLeft: '左下'};

/** 置く画像の大きさ（画面の幅・高さの size 割の箱に収める倍率）と位置（画面の外に出ないよう、少し内側） */
export function imagePlacement(frame: {width: number; height: number}, img: {width: number; height: number}, size: number, pos: ImagePos): {x: number; y: number; scale: number} {
  const scale = Math.min((frame.width * size) / img.width, (frame.height * size) / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const mx = frame.width * 0.04;
  const my = frame.height * 0.04;
  const dx = Math.max(0, (frame.width - w) / 2 - mx);
  const dy = Math.max(0, (frame.height - h) / 2 - my);
  const x = pos === 'topRight' || pos === 'bottomRight' ? dx : pos === 'topLeft' || pos === 'bottomLeft' ? -dx : 0;
  const y = pos === 'bottomRight' || pos === 'bottomLeft' ? dy : pos === 'topRight' || pos === 'topLeft' ? -dy : 0;
  return {x: Math.round(x), y: Math.round(y), scale: Number(scale.toFixed(4))};
}

/** 背景を切り替える区間：マーカー（チャプター）で区切る（頭から最初のマーカー、マーカーどうしの間、最後のマーカーから終わり）か、一定のコマ数ごと */
export function planBackgroundSpans(p: Project, mode: 'markers' | 'every', every: number): {start: number; duration: number}[] {
  const total = p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  if (total <= 0) return [];
  let cuts: number[];
  if (mode === 'markers') cuts = [...new Set([0, ...(p.markers ?? []).map(m => m.frame).filter(f => f > 0 && f < total), total])].sort((a, b) => a - b);
  else {
    const n = Math.max(1, Math.round(every));
    cuts = [];
    for (let f = 0; f < total; f += n) cuts.push(f);
    cuts.push(total);
  }
  return cuts
    .slice(1)
    .map((e, i) => ({start: cuts[i], duration: e - cuts[i]}))
    .filter(s => s.duration > 0);
}

/** 画面いっぱいに敷く（余白ができないように大きいほうに合わせる）画像の位置 */
export function coverPlacement(frame: {width: number; height: number}, img: {width: number; height: number}): {x: number; y: number; scale: number} {
  return {x: 0, y: 0, scale: Number(Math.max(frame.width / img.width, frame.height / img.height).toFixed(4))};
}
