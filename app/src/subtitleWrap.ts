// 字幕の改行（書き出しの core/src/subtitle.rs の wrap_subtitle と同じ位置で切る）。
// 幅は全角 1・半角 0.55 で数え、上限は maxChars（0 なら画面の幅 ÷ 文字の大きさ）。
// 句読点や閉じ括弧は行の頭に置かず前の行へ（2 文字まで）、開き括弧は行の終わりに置かず次の行へ、英単語は途中で切らない。

const NO_START = new Set([...'、。，．・：；？！ー）」』】〕｝〉》ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々…‥!?,.:;)]}%']);
const NO_END = new Set([...'（「『【〔｛〈《([{']);

const charEm = (c: string) => {
  const cp = c.codePointAt(0)!;
  return cp < 0x2000 || (cp >= 0xff61 && cp <= 0xff9f) ? 0.55 : 1;
};
const isWord = (c: string) => /^[A-Za-z0-9]$/.test(c);

/** 折り返しの計算に使う 1 文字の幅（文字の大きさ + 文字の間隔。間隔が負なら大きさのまま。書き出しの wrap_em と同じ） */
export const wrapEm = (fontSize: number, letterSpacing = 0) => Math.round(fontSize + Math.max(0, letterSpacing));

export function wrapSubtitle(text: string, fontSize: number, width: number, maxChars = 0): string {
  const budget = Math.max(1, maxChars > 0 ? maxChars : Math.floor(width / Math.max(1, fontSize)));
  const out: string[] = [];
  for (const para of text.replace(/\r\n/g, '\n').split('\n')) {
    const c = Array.from(para);
    const n = c.length;
    if (!n) {
      out.push('');
      continue;
    }
    let i0 = 0;
    while (i0 < n) {
      let w = 0;
      let e = i0;
      while (e < n && (e === i0 || w + charEm(c[e]) <= budget + 1e-9)) {
        w += charEm(c[e]);
        e++;
      }
      if (e < n) {
        let b = e;
        while (b < n && b < e + 2 && NO_START.has(c[b])) b++;
        if (b === e) {
          if (b - 1 > i0 && NO_END.has(c[b - 1])) b--;
          else if (isWord(c[b - 1]) && isWord(c[b])) {
            let s = b - 1;
            while (s > i0 && isWord(c[s - 1])) s--;
            if (s > i0) b = s;
          }
        }
        e = b;
      }
      out.push(c.slice(i0, e).join(''));
      i0 = e;
    }
  }
  return out.join('\n');
}
