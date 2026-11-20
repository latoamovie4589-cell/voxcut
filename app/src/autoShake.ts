// 強い感情で画面を揺らす：「！」「？」で終わるセリフ（強くは、怒り・驚きのもの）の頭で、カメラをぶるっと揺らす。

import {lastMark} from './autoSound';
import {detectEmotion} from './emotion';
import type {AnimMid, Project, VoiceClip} from './model';

export type ShakeMode = 'strong' | 'all';
export const SHAKE_MODE_LABEL: Record<ShakeMode, string> = {
  strong: '怒り・驚きの「！」「？」だけ',
  all: '「！」「？」で終わるセリフすべて',
};

export interface ShakeRun {
  start: number;
  duration: number;
  /** 揺れの大きさ（px。だんだん小さくなる） */
  amp: number;
}

/** 揺らす所。セリフの頭から frames コマ（セリフが短ければそのぶん）。前の揺れと重なるものは省く */
export function planShake(p: Project, mode: ShakeMode, frames: number, amp: number): ShakeRun[] {
  const len = Math.max(3, Math.round(frames));
  const runs: ShakeRun[] = [];
  const voices = p.clips.filter((c): c is VoiceClip => c.type === 'voice').sort((a, b) => a.start - b.start);
  for (const v of voices) {
    if (!'！？!?'.includes(lastMark(v.text) || ' ')) continue;
    if (mode === 'strong') {
      const ch = p.characters.find(c => c.id === v.characterId);
      const e = detectEmotion(v.text, v.paramsOverride ?? ch?.voice.params);
      if (e !== 'angry' && e !== 'surprised') continue;
    }
    const duration = Math.min(len, v.duration);
    const last = runs[runs.length - 1];
    if (duration < 3 || (last && v.start < last.start + last.duration)) continue;
    runs.push({start: v.start, duration, amp});
  }
  return runs;
}

/** 揺れの動き：右上・左下…と交互に振れて、だんだん小さくなって元に戻る（制御アイテムの動き） */
export function shakeKeys(run: ShakeRun): AnimMid[] {
  const n = Math.max(2, Math.floor(run.duration / 2));
  return Array.from({length: n}, (_, i) => {
    const k = run.amp * (1 - i / n);
    const s = i % 2 ? -1 : 1;
    return {at: (i + 1) / (n + 1), transform: {x: Math.round(s * k), y: Math.round(-s * k * 0.5), scale: 1, opacity: 1}, rotation: 0};
  });
}
