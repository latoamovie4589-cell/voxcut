// BGM と効果音の自動配置：置く場所を決めるだけの計算（どこに・いくつ・どの長さで）。置く処理は store.ts の placeAudioItems。

import type {Project} from './model';

export interface Placement {
  /** 置く場所（フレーム） */
  start: number;
  /** 長さ（フレーム） */
  duration: number;
}

/** BGM を、頭から終わりまで くり返して敷く。最後の 1 本は、動画の終わりで切る（1 本が 1 秒より短い素材は置かない） */
export function planBgm(soundMs: number, totalFrames: number, fps: number): Placement[] {
  const d = Math.round((soundMs * fps) / 1000);
  if (d < fps || totalFrames <= 0) return [];
  const out: Placement[] = [];
  for (let at = 0; at < totalFrames && out.length < 200; at += d) out.push({start: at, duration: Math.min(d, totalFrames - at)});
  return out;
}

/** 効果音を鳴らすきっかけ */
export type SeTrigger = 'marker' | 'question' | 'exclaim' | 'keyword';
export const SE_TRIGGER_LABEL: Record<SeTrigger, string> = {
  marker: 'マーカーの位置',
  question: '「？」で終わるセリフの頭',
  exclaim: '「！」で終わるセリフの頭',
  keyword: '決めた言葉を含むセリフの頭',
};

/** 文の終わり（閉じ括弧や空白は無視）の記号 */
export const lastMark = (t: string) => [...t.trim().replace(/[」』）)\]】\s]+$/u, '')].at(-1) ?? '';

/** 効果音を置く位置（フレーム。重複なし・時間順） */
export function planSe(p: Project, trigger: SeTrigger, keyword = ''): number[] {
  const starts: number[] = [];
  if (trigger === 'marker') {
    for (const m of p.markers ?? []) starts.push(m.frame);
  } else {
    const kw = keyword.trim();
    for (const c of p.clips) {
      if (c.type !== 'voice' || !c.text.trim()) continue;
      const end = lastMark(c.text);
      const hit = trigger === 'question' ? end === '？' || end === '?' : trigger === 'exclaim' ? end === '！' || end === '!' : !!kw && c.text.includes(kw);
      if (hit) starts.push(c.start);
    }
  }
  return [...new Set(starts.filter(f => f >= 0))].sort((a, b) => a - b);
}
