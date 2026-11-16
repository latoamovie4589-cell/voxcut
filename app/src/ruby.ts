// ルビ（ふりがな）。「漢字《かんじ》」「｜文字《もじ》」の書き方（青空文庫と同じ）。
// 書き出しの core/src/text.rs（parse_ruby）・core/src/subtitle.rs（keep_ruby_words・ruby_rows）と同じ結果にする。
// 合成はルビの読みで、字幕・テキストはルビを外した文の上にルビを小さく出す。

export interface RubySeg {
  base: string;
  /** なければ地の文 */
  ruby?: string;
}

/** ルビを付けられる漢字（「々」「〆」「ヶ」「〇」を含む） */
export function isKanji(c: string): boolean {
  const cp = c.codePointAt(0)!;
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff) || '々〆ヶ〇'.includes(c);
}

/** ｜がなければ《の直前の漢字の並びに付く。閉じていない《や、付ける文字がない《はそのまま文字として残す */
export function parseRuby(text: string): RubySeg[] {
  const c = Array.from(text);
  const out: RubySeg[] = [];
  let cur: string[] = [];
  let mark: number | null = null;
  // i から先、改行の前に《…》があれば、その《と》の位置
  const find = (i: number): [number, number] | null => {
    let open = -1;
    for (let k = i; k < c.length && c[k] !== '\n'; k++)
      if (c[k] === '《') {
        open = k;
        break;
      }
    if (open < 0) return null;
    for (let k = open + 1; k < c.length && c[k] !== '\n'; k++) if (c[k] === '》') return [open, k];
    return null;
  };
  let i = 0;
  while (i < c.length) {
    const ch = c[i];
    if (ch === '｜' || ch === '|') {
      const f = find(i + 1);
      if (f && !c.slice(i + 1, f[0]).some(x => x === '｜' || x === '|')) {
        mark = cur.length;
        i++;
        continue;
      }
    }
    if (ch === '《') {
      const f = find(i);
      if (f && f[0] === i && f[1] > i + 1) {
        let split = mark ?? cur.length;
        if (mark === null) while (split > 0 && isKanji(cur[split - 1])) split--;
        if (split < cur.length) {
          if (split > 0) out.push({base: cur.slice(0, split).join('')});
          out.push({base: cur.slice(split).join(''), ruby: c.slice(i + 1, f[1]).join('')});
          cur = [];
          mark = null;
          i = f[1] + 1;
          continue;
        }
      }
    }
    if (ch === '\n') mark = null;
    cur.push(ch);
    i++;
  }
  if (cur.length) out.push({base: cur.join('')});
  return out;
}

export const hasRuby = (segs: RubySeg[]) => segs.some(s => s.ruby !== undefined);

/** ルビの書き方を外した、画面に出す文 */
export const rubyBase = (text: string) =>
  parseRuby(text)
    .map(s => s.base)
    .join('');

/** ルビを読みにした文（合成する文） */
export const rubyReading = (text: string) =>
  parseRuby(text)
    .map(s => s.ruby ?? s.base)
    .join('');

/** 文字ごとの区切り番号（改行は数えない） */
const ownerOf = (segs: RubySeg[]) => segs.flatMap((s, k) => Array.from(s.base.replace(/\n/g, '')).map(() => k));

/** ルビの付いた語の途中で改行しない（語の頭で改行する。語が行の頭からなら語の終わりまで延ばす） */
export function keepRubyWords(segs: RubySeg[], wrapped: string): string {
  const owner = ownerOf(segs);
  const chars = Array.from(wrapped).filter(c => c !== '\n');
  const cuts: number[] = [];
  let n = 0;
  for (const ch of wrapped) {
    if (ch === '\n') cuts.push(n);
    else n++;
  }
  for (let i = 0; i < cuts.length; i++) {
    const b = cuts[i];
    if (b === 0 || b >= owner.length || owner[b - 1] !== owner[b] || segs[owner[b]].ruby === undefined) continue;
    const k = owner[b];
    const s0 = owner.indexOf(k);
    const e0 = owner.lastIndexOf(k) + 1;
    const prev = i === 0 ? 0 : cuts[i - 1];
    const next = cuts[i + 1] ?? Infinity;
    cuts[i] = s0 > prev ? s0 : Math.min(e0, next);
  }
  let out = '';
  let at = 0;
  for (const c of cuts) {
    out += chars.slice(Math.min(at, c), c).join('') + '\n';
    at = c;
  }
  return out + chars.slice(at).join('');
}

/** 行の中の区切り（地の文・ルビ付きの語と、その語の頭が全文の何文字目か。改行は数えない） */
export interface RubyPiece {
  text: string;
  ruby?: string;
  at: number;
}

/** 改行した文に、ルビを割り当て直す。行をまたいだ語のルビは、頭の行に付ける */
export function rubyRows(segs: RubySeg[], wrapped: string): RubyPiece[][] {
  const owner = ownerOf(segs);
  const rows: RubyPiece[][] = [];
  let n = 0;
  for (const line of wrapped.split('\n')) {
    const row: RubyPiece[] = [];
    for (const ch of Array.from(line)) {
      const k = owner[n] ?? -1;
      const last = row[row.length - 1];
      if (last && n > 0 && owner[n - 1] === k) last.text += ch;
      else row.push({text: ch, ruby: n === 0 || owner[n - 1] !== k ? segs[k]?.ruby : undefined, at: n});
      n++;
    }
    rows.push(row);
  }
  return rows;
}
