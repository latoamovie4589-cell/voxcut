// セリフの字幕を「個別に設定」するときの、はじめの値。

import type {Character, SubtitleCustom} from './model';
import {plainLook} from './model';

/** キャラクターの字幕設定から「個別に設定」の初めの値を作る（見た目がなるべく変わらないように） */
export function subtitleCustomFrom(st: Character['subtitle'], height: number): SubtitleCustom {
  const half = height / 2 - st.marginV - st.fontSize * 0.65;
  return {
    fontFamily: st.fontFamily,
    fontSize: st.fontSize,
    color: st.color,
    outlineColor: st.outlineColor,
    outlineWidth: st.outlineWidth,
    bold: false,
    italic: false,
    align: 'center',
    transform: {x: 0, y: Math.round(st.position === 'bottom' ? half : st.position === 'top' ? -half : 0), scale: 1, opacity: 1},
    look: {...plainLook(), fadeIn: st.animation === 'fade' ? 6 : 0, fadeOut: st.animation === 'fade' ? 6 : 0},
  };
}
