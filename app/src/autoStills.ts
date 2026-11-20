// サムネイル候補を、まとめて書き出すコマの決め方。

import type {Project, VoiceClip} from './model';
import {projectDuration} from './model';
import {lastMark} from './autoSound';

export type StillMode = 'markers' | 'even' | 'strong';
export const STILL_MODE_LABEL: Record<StillMode, string> = {
  markers: 'マーカーの位置',
  even: '全体を等間隔に',
  strong: '「！」「？」で終わるセリフの途中',
};

/** 書き出すコマ（昇順・重複なし）。count は「等間隔」「！？」の枚数（多いときは均等に間引く） */
export function planStills(p: Project, mode: StillMode, count: number): number[] {
  const total = projectDuration(p);
  if (total <= 0) return [];
  const last = total - 1;
  const n = Math.max(1, Math.min(60, Math.round(count)));
  let frames: number[];
  if (mode === 'markers') frames = (p.markers ?? []).map(m => m.frame);
  else if (mode === 'even') frames = Array.from({length: n}, (_, i) => Math.floor(((i + 0.5) / n) * total));
  else {
    const hits = p.clips
      .filter((c): c is VoiceClip => c.type === 'voice' && '！？!?'.includes(lastMark(c.text) || ' '))
      .sort((a, b) => a.start - b.start)
      .map(c => c.start + Math.floor(c.duration * 0.4));
    frames = hits.length <= n ? hits : Array.from({length: n}, (_, i) => hits[Math.floor(((i + 0.5) / n) * hits.length)]);
  }
  return [...new Set(frames.map(f => Math.min(last, Math.max(0, f))))].sort((a, b) => a - b);
}
