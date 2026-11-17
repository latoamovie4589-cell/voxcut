// 字幕アニメーションの時間配分。core/src/subtitle.rs と同じ式にしてある（プレビューと書き出しを揃えるため）。

export type SubtitleAnimation = 'none' | 'fade' | 'pop' | 'typewriter' | 'karaoke';

export const ANIMATION_LABEL: Record<SubtitleAnimation, string> = {
  none: 'なし',
  fade: 'フェード',
  pop: 'ポップ',
  typewriter: '1文字ずつ',
  karaoke: 'カラオケ',
};

/** カラオケの塗りの色の決まり */
export const KARAOKE_COLOR = '#FFD400';

const LIGHT = new Set([...'、。，．,.!?！？…‥・「」『』（）()〜~－-：:；;"\'”“’‘']);

/**
 * カラオケの区切り（センチ秒。文字ごとの塗り始め、最後は塗り終わり。改行は数えない）。
 * 句読点・記号・空白は 0.3 文字ぶん。長さの 9 割で塗り終わる。core/src/subtitle.rs と同じ式
 */
export function karaokeBounds(chars: string[], duration: number, fps: number): number[] {
  const w = chars.map(c => (LIGHT.has(c) || /\s/.test(c) ? 0.3 : 1));
  const total = Math.max(
    1e-9,
    w.reduce((a, b) => a + b, 0),
  );
  const span = ((duration * 0.9) / Math.max(1, fps)) * 100;
  const out = [0];
  let acc = 0;
  for (const x of w) {
    acc += x;
    out.push(Math.round((acc / total) * span));
  }
  return out;
}

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
