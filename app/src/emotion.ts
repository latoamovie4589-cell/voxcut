// セリフの感情を決めて、立ち絵の表情に当てはめる（書き出し・プレビューは、セリフの「表情」に入った名前を使うので、ここは入力だけ）。
// 声の感情の設定（VOICEPEAK・CeVIO・VoiSona）があればそれを、なければセリフの言葉づかいから決める。

import type {Character, Portrait, VoiceParams} from './model';

export type Emotion = 'happy' | 'angry' | 'sad' | 'surprised';

export const EMOTION_LABEL: Record<Emotion, string> = {happy: '喜び', angry: '怒り', sad: '悲しみ', surprised: '驚き'};

/** 声の感情の名前（ソフトごと）→ 感情 */
const PARAM_EMOTION: [RegExp, Emotion][] = [
  [/happy|fun|joy|元気|喜|楽|うれ/i, 'happy'],
  [/angry|怒/i, 'angry'],
  [/sad|哀|悲/i, 'sad'],
  [/surpris|驚/i, 'surprised'],
];

/** セリフの言葉づかい。先に当たったものを使う（驚き → 怒り → 悲しみ → 喜び） */
const TEXT_CUES: [RegExp, Emotion][] = [
  [/えっ|えぇ|ええっ|まさか|びっくり|驚|うそ|嘘でしょ|なんと|[!！][?？]|[?？][!！]/, 'surprised'],
  [/怒|ふざけ|バカ|ばか|許さ|うるさ|くそ|ちくしょ|なんだと|いい加減|むかつ|ムカつ/, 'angry'],
  [/悲|泣|ぐすん|しくしく|寂し|さみし|つらい|辛い|ごめん|残念|うぅ|うう/, 'sad'],
  [/嬉|うれし|楽し|やった|わーい|ありがとう|最高|笑|ふふ|えへへ|わくわく|ワクワク|[♪♡♥]|(?:^|[^A-Za-z])w{2,}/, 'happy'],
];

/** 声の感情の設定から（いちばん強いもの）。何も設定していなければ null */
export function emotionFromParams(params: VoiceParams | null | undefined): Emotion | null {
  let best: [Emotion, number] | null = null;
  for (const [name, v] of Object.entries(params?.emotions ?? {})) {
    if (!(v > 0)) continue;
    const e = PARAM_EMOTION.find(([re]) => re.test(name))?.[1];
    if (e && (!best || v > best[1])) best = [e, v];
  }
  return best?.[0] ?? null;
}

export function emotionFromText(text: string): Emotion | null {
  return TEXT_CUES.find(([re]) => re.test(text))?.[1] ?? null;
}

/** そのセリフの感情（声の設定を先に、なければ言葉から） */
export function detectEmotion(text: string, params?: VoiceParams | null): Emotion | null {
  return emotionFromParams(params) ?? emotionFromText(text);
}

/** 表情の名前に含まれる言葉 → 感情 */
const NAME_HINTS: Record<Emotion, RegExp> = {
  happy: /笑|喜|楽|嬉|にっこ|にこ|ニコ|ハッピー|happy|smile|joy|fun/i,
  angry: /怒|おこ|ムッ|むっ|angry|mad/i,
  sad: /悲|泣|哀|しょんぼり|sad|cry/i,
  surprised: /驚|びっくり|おどろ|surpris/i,
};

/** その感情にあたる表情の名前（立ち絵に無ければ null） */
export function expressionNameFor(pt: Portrait | null | undefined, emotion: Emotion): string | null {
  return (pt?.expressions ?? []).find(e => NAME_HINTS[emotion].test(e.name))?.name ?? null;
}

/** そのセリフに付ける表情の名前（感情が決まらない・あてはまる表情が無いときは null） */
export function autoExpression(ch: Character | undefined, text: string, params: VoiceParams | null | undefined): string | null {
  if (!ch?.portrait?.psd) return null;
  const e = detectEmotion(text, params);
  return e ? expressionNameFor(ch.portrait, e) : null;
}
