// セリフの「間」（後ろの余韻）を、文の終わりの記号で変える。間の長さはフレーム。

import {lastMark} from './autoSound';

export interface GapRule {
  /** 「。」「…」で終わるセリフの後ろ */
  sentence: number;
  /** 「！」「？」で終わるセリフの後ろ */
  strong: number;
  /** それ以外（読点・記号なし）の後ろ */
  other: number;
  /** 最後のセリフは変えない */
  keepLast: boolean;
}

/** そのセリフの後ろの間（フレーム） */
export function gapFor(text: string, rule: GapRule): number {
  const m = lastMark(text);
  if ('！？!?'.includes(m) && m) return rule.strong;
  if ('。．.…‥'.includes(m) && m) return rule.sentence;
  return rule.other;
}
