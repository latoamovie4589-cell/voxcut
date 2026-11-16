// 文字の飾りのひな形（CapCut の「テキストテンプレート」と同じ選び方）。
// 押すと、色・縁・影・帯・グラデーション・太さ・書体をまとめて入れ替える。文字・大きさ・位置・揃え・動きはそのまま。

import type {TextClip} from './model';

/** ひな形が入れ替える項目（書いていない飾りは「無し」に戻す） */
export type TextLook = Pick<
  TextClip,
  | 'fontFamily'
  | 'color'
  | 'outlineColor'
  | 'outlineWidth'
  | 'bold'
  | 'italic'
  | 'shadowColor'
  | 'shadowBlur'
  | 'shadowX'
  | 'shadowY'
  | 'outline2Color'
  | 'outline2Width'
  | 'boxColor'
  | 'boxOpacity'
  | 'boxPadding'
  | 'boxRadius'
  | 'gradientColor'
>;

const NONE: TextLook = {
  fontFamily: 'Yu Gothic UI',
  color: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 0,
  bold: true,
  italic: false,
  shadowColor: '',
  shadowBlur: 0,
  shadowX: 0,
  shadowY: 0,
  outline2Color: '',
  outline2Width: 0,
  boxColor: '',
  boxOpacity: 1,
  boxPadding: 16,
  boxRadius: 12,
  gradientColor: '',
};

export interface TextStyle {
  id: string;
  label: string;
  look: TextLook;
}

const st = (id: string, label: string, look: Partial<TextLook>): TextStyle => ({id, label, look: {...NONE, ...look}});

export const TEXT_STYLES: TextStyle[] = [
  st('basic', '基本', {outlineWidth: 6}),
  st('yellow', '黄色テロップ', {color: '#FFE14D', outlineWidth: 8}),
  st('double', '二重の縁', {outlineColor: '#E60033', outlineWidth: 6, outline2Color: '#FFFFFF', outline2Width: 6}),
  st('pop', 'ポップ', {color: '#FF4F8B', outlineColor: '#FFFFFF', outlineWidth: 8, outline2Color: '#3A1C5C', outline2Width: 5}),
  st('shadow', '影つき', {outlineWidth: 2, shadowColor: '#000000', shadowBlur: 4, shadowX: 5, shadowY: 5}),
  st('neon', 'ネオン', {color: '#F2FFFF', outlineColor: '#00E5FF', outlineWidth: 2, shadowColor: '#00E5FF', shadowBlur: 14}),
  st('pink-neon', 'ピンクの光', {color: '#FFF0F7', outlineColor: '#FF4FA3', outlineWidth: 2, shadowColor: '#FF4FA3', shadowBlur: 14}),
  st('gradient', 'グラデーション', {color: '#FFD86B', gradientColor: '#FF5E7E', outlineColor: '#FFFFFF', outlineWidth: 6, outline2Color: '#2B1D3A', outline2Width: 4}),
  st('band', '黒い帯', {boxColor: '#000000', boxOpacity: 0.72, boxPadding: 18, boxRadius: 6}),
  st('bubble', '白い吹き出し', {color: '#222222', boxColor: '#FFFFFF', boxPadding: 22, boxRadius: 28}),
  st('caution', '注意', {color: '#111111', boxColor: '#FFD400', boxPadding: 16, boxRadius: 4}),
  st('mincho', '明朝', {fontFamily: 'Yu Mincho', bold: false, outlineWidth: 0, shadowColor: '#000000', shadowBlur: 6, shadowX: 0, shadowY: 3}),
];

/** 今の文字が、そのひな形の飾りになっているか */
export function isTextStyle(c: TextClip, s: TextStyle): boolean {
  return (Object.keys(s.look) as (keyof TextLook)[]).every(k => (c[k] ?? NONE[k]) === s.look[k]);
}
