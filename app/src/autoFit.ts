// 字幕を画面に収める：行が多すぎて画面からはみ出す字幕を、キャラクターごとに文字の大きさを下げて収める。
// 折り返しは字幕の表示・書き出しと同じ計算（subtitleWrap）。

import type {Character, Project, VoiceClip} from './model';
import {rubyBase} from './ruby';
import {wrapEm, wrapSubtitle} from './subtitleWrap';

/** その字幕が何行になるか */
export function subtitleLineCount(text: string, st: Character['subtitle'], videoWidth: number, fontSize = st.fontSize): number {
  return wrapSubtitle(rubyBase(text), wrapEm(fontSize, st.letterSpacing), Math.max(0, videoWidth - 80), st.maxChars ?? 0).split('\n').length;
}

/** 字幕を個別に設定していない、文字のあるセリフ */
const lines = (p: Project, characterId: string) => p.clips.filter((c): c is VoiceClip => c.type === 'voice' && c.characterId === characterId && !c.subtitleCustom && !!c.text.trim());

/** 行数が maxLines を超えるセリフ */
export function overflowLines(p: Project, maxLines: number): VoiceClip[] {
  return p.characters.flatMap(ch => lines(p, ch.id).filter(v => subtitleLineCount(v.text, ch.subtitle, p.video.width) > maxLines));
}

export interface FitPlan {
  characterId: string;
  from: number;
  to: number;
  /** 下げても収まらないセリフの数（最小の大きさまで下げても） */
  left: number;
}

/** キャラクターごとの文字の大きさ。収まる最大の大きさ（2px 刻み）まで下げる。minSize より小さくはしない。変えなくていいものは省く */
export function planFit(p: Project, maxLines: number, minSize: number): FitPlan[] {
  const out: FitPlan[] = [];
  for (const ch of p.characters) {
    const vs = lines(p, ch.id);
    const from = ch.subtitle.fontSize;
    const bad = (fs: number) => vs.filter(v => subtitleLineCount(v.text, ch.subtitle, p.video.width, fs) > maxLines).length;
    if (!bad(from)) continue;
    const floor = Math.min(from, Math.max(8, Math.round(minSize)));
    let to = from;
    while (to - 2 >= floor && bad(to) > 0) to -= 2;
    if (bad(to) > 0) to = floor;
    if (to !== from) out.push({characterId: ch.id, from, to, left: bad(to)});
  }
  return out;
}
