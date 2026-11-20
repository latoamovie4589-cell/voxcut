// 字幕の自動色分け：セリフの感情（声の設定か言葉づかい）ごとに、字幕の文字（か縁）の色を変える。
// セリフの字幕を「個別に設定」にして色だけ変える。手で個別に設定したセリフは触らない。

import {detectEmotion, EMOTION_LABEL, type Emotion} from './emotion';
import type {Character, Project, SubtitleCustom, VoiceClip} from './model';
import {subtitleCustomFrom} from './subtitleCustom';

export type TintTarget = 'text' | 'outline';
export const TINT_TARGET_LABEL: Record<TintTarget, string> = {text: '文字の色', outline: '縁の色'};

export const TINT_COLOR: Record<Emotion, string> = {happy: '#FFD84A', angry: '#FF5C5C', sad: '#6DA8FF', surprised: '#FF9F43'};
export const TINT_LABEL = (e: Emotion) => `${EMOTION_LABEL[e]}（${TINT_COLOR[e]}）`;

const EMOTIONS = Object.keys(TINT_COLOR) as Emotion[];
const TARGETS: TintTarget[] = ['text', 'outline'];

/** その感情の色を付けた「個別に設定」の値 */
export function tintFor(ch: Character, height: number, emotion: Emotion, target: TintTarget): SubtitleCustom {
  const base = subtitleCustomFrom(ch.subtitle, height);
  return target === 'text' ? {...base, color: TINT_COLOR[emotion]} : {...base, outlineColor: TINT_COLOR[emotion]};
}

const same = (a: SubtitleCustom, b: SubtitleCustom) => JSON.stringify(a) === JSON.stringify(b);

/** 前に自動で付けた色か（いまのキャラクターの字幕設定から作った値と同じ） */
export function isAutoTint(v: VoiceClip, ch: Character | undefined, height: number): boolean {
  const sc = v.subtitleCustom;
  if (!sc || !ch) return false;
  return EMOTIONS.some(e => TARGETS.some(t => same(sc, tintFor(ch, height, e, t))));
}

/** 色を付けるセリフ：感情が分かるもので、まだ手で個別に設定していない（前に自動で付けたものは付け直す）。ids があればその中だけ */
export function planTint(p: Project, target: TintTarget, ids: string[] | null): {id: string; custom: SubtitleCustom}[] {
  const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
  const out: {id: string; custom: SubtitleCustom}[] = [];
  for (const c of p.clips) {
    if (c.type !== 'voice' || locked.has(c.trackId) || (ids && !ids.includes(c.id)) || !c.text.trim()) continue;
    const ch = p.characters.find(x => x.id === c.characterId);
    if (!ch || (c.subtitleCustom && !isAutoTint(c, ch, p.video.height))) continue;
    const e = detectEmotion(c.text, c.paramsOverride ?? ch.voice.params);
    if (e) out.push({id: c.id, custom: tintFor(ch, p.video.height, e, target)});
  }
  return out;
}

/** 自動で付けた色のセリフ（元に戻す対象） */
export function autoTinted(p: Project): string[] {
  return p.clips.filter((c): c is VoiceClip => c.type === 'voice' && isAutoTint(c, p.characters.find(x => x.id === c.characterId), p.video.height)).map(c => c.id);
}
