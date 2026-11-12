// 字幕アニメーションの時間配分。core/src/subtitle.rs と同じ式にしてある（プレビューと書き出しを揃えるため）。

export type SubtitleAnimation = 'none' | 'fade' | 'pop' | 'typewriter';

export const ANIMATION_LABEL: Record<SubtitleAnimation, string> = {
  none: 'なし',
  fade: 'フェード',
  pop: 'ポップ',
  typewriter: '1文字ずつ',
};

/** アニメーションにかけるフレーム数（0.2 秒） */
export const animFrames = (fps: number) => Math.max(1, Math.round(fps * 0.2));

/** タイプライターで見せる文字数（改行は数えない）。f はクリップ先頭からのフレーム */
export function typewriterCount(chars: number, duration: number, f: number): number {
  const reveal = Math.min(Math.floor(duration * 0.6), chars * 2);
  if (reveal <= 0) return chars;
  return Math.min(chars, Math.floor(((f + 1) * chars) / reveal));
}

/** フェードの不透明度（ASS の \fad と同じく、頭と終わりで直線的に変わる） */
export function fadeAlpha(f: number, duration: number, fps: number): number {
  const n = animFrames(fps);
  return Math.max(0, Math.min(1, (f + 1) / n, (duration - f) / n));
}

/** ポップの大きさ（ASS の \t(0,ms,0.5,…) と同じく、進み具合の 0.5 乗で 85%→100%） */
export function popScale(f: number, fps: number): number {
  const p = Math.min(1, f / animFrames(fps));
  return 0.85 + 0.15 * Math.pow(p, 0.5);
}
