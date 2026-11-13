// BGM を下げる（ダッキング）。core/src/render.rs の voice_intervals / duck_expr と同じ形：
// セリフのある区間（間が 0.6 秒より短いものはまとめる）の前後 0.25 秒で滑らかに下げ・戻す。

import type {Project} from './model';

export const DUCK_RAMP = 0.25;
const MERGE_GAP = 0.6;

/** 下げる区間（秒） */
export function voiceIntervals(p: Project): [number, number][] {
  const fps = p.video.fps;
  // model.ts の audibleTracks と同じ（このファイルは node の確認スクリプトからも読むので、型だけを読み込む）
  const solo = p.tracks.some(t => t.solo && !t.hidden);
  const tracks = new Set(p.tracks.filter(t => !t.hidden && !t.muted && (!solo || t.solo)).map(t => t.id));
  const iv = p.clips
    .filter(c => c.type === 'voice' && tracks.has(c.trackId))
    .map(c => [c.start / fps, (c.start + c.duration) / fps] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of iv) {
    const last = out.at(-1);
    if (last && s - last[1] < MERGE_GAP) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const clip01 = (x: number) => Math.min(1, Math.max(0, x));

/** t 秒での音量の倍率（level は下げたときの音量） */
export function duckGain(intervals: [number, number][], level: number, t: number): number {
  let k = 0;
  for (const [s, e] of intervals) {
    if (t < s - DUCK_RAMP || t > e + DUCK_RAMP) continue;
    k += Math.min(clip01((t - (s - DUCK_RAMP)) / DUCK_RAMP), clip01((e + DUCK_RAMP - t) / DUCK_RAMP));
  }
  return 1 - (1 - clip01(level)) * Math.min(1, k);
}

/** Web Audio の GainNode に、同じ動きを予約する（t0 = 再生開始の AudioContext 時刻、from = 開始位置の秒） */
export function scheduleDuck(g: AudioParam, intervals: [number, number][], level: number, base: number, t0: number, from: number, rate: number) {
  const at = (sec: number) => t0 + (sec - from) / rate;
  g.cancelScheduledValues(0);
  g.setValueAtTime(base * duckGain(intervals, level, from), Math.max(0, t0));
  for (const [s, e] of intervals) {
    if (e + DUCK_RAMP <= from) continue;
    const pts: [number, number][] = [
      [s - DUCK_RAMP, 1],
      [s, level],
      [e, level],
      [e + DUCK_RAMP, 1],
    ];
    for (const [sec, v] of pts) if (sec > from) g.linearRampToValueAtTime(base * v, at(sec));
  }
}
