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

/** 一部の文字だけの飾り（`<c=#FF0000>赤</c>` で色、`<s=1.5>大</s>` で大きさ（倍）。どちらも入れ子にできる）。core/src/text.rs の Span と同じ */
export interface Span {
  /** "#RRGGBB"（大文字） */
  color?: string;
  /** 大きさの倍率（0.3〜4） */
  size?: number;
}

/** ルビと飾りを読み取った結果。segs は飾りの書き方を外した区切り、styles は文字ごとの飾り（改行は数えない。飾りなしは undefined） */
export interface Markup {
  segs: RubySeg[];
  styles: (Span | undefined)[];
}

type Tag = {kind: 'color'; v: string} | {kind: 'size'; v: number} | {kind: 'endColor'} | {kind: 'endSize'};

/** i 文字目の飾りの書き方（開く・閉じる）と長さ。書き方に合わない `<` は普通の文字（Rust の parse_tag と同じ） */
function parseTag(c: string[], i: number): [Tag, number] | null {
  if (c[i] !== '<') return null;
  let close = -1;
  for (let k = i + 1; k < Math.min(c.length, i + 20); k++)
    if (c[k] === '>') {
      close = k;
      break;
    }
  if (close < 0) return null;
  const inner = c.slice(i + 1, close).join('');
  const n = close + 1 - i;
  if (inner === '/c') return [{kind: 'endColor'}, n];
  if (inner === '/s') return [{kind: 'endSize'}, n];
  if (inner.startsWith('c=')) {
    const v = inner.slice(2);
    const h = v.startsWith('#') ? v.slice(1) : v;
    if (!/^[0-9a-fA-F]*$/.test(h)) return null;
    const full = h.length === 6 ? h : h.length === 3 ? [...h].map(x => x + x).join('') : null;
    return full ? [{kind: 'color', v: `#${full.toUpperCase()}`}, n] : null;
  }
  if (inner.startsWith('s=')) {
    const v = inner.slice(2);
    if (!v || !/^[0-9.]+$/.test(v)) return null;
    const k = Number(v);
    return Number.isFinite(k) ? [{kind: 'size', v: Math.min(4, Math.max(0.3, k))}, n] : null;
  }
  return null;
}

/** ルビを読み取ってから、各区切りの飾りの書き方を外す（飾りは区切りをまたいでよい）。Rust の parse_markup と同じ */
export function parseMarkup(text: string): Markup {
  const colors: string[] = [];
  const sizes: number[] = [];
  const segs: RubySeg[] = [];
  const styles: (Span | undefined)[] = [];
  for (const seg of parseRubyRaw(text)) {
    const c = Array.from(seg.base);
    let base = '';
    for (let i = 0; i < c.length; ) {
      const t = parseTag(c, i);
      if (t) {
        const [tag, n] = t;
        if (tag.kind === 'color') colors.push(tag.v);
        else if (tag.kind === 'size') sizes.push(tag.v);
        else if (tag.kind === 'endColor') colors.pop();
        else sizes.pop();
        i += n;
        continue;
      }
      base += c[i];
      if (c[i] !== '\n') {
        const col = colors[colors.length - 1];
        const sz = sizes[sizes.length - 1];
        styles.push(col === undefined && sz === undefined ? undefined : {...(col !== undefined ? {color: col} : {}), ...(sz !== undefined ? {size: sz} : {})});
      }
      i++;
    }
    // 書き方だけで空になった地の文は捨てる
    if (base || seg.ruby !== undefined) segs.push(seg.ruby === undefined ? {base} : {base, ruby: seg.ruby});
  }
  return {segs, styles};
}

/** ルビの区切り（飾りの書き方を外したもの） */
export const parseRuby = (text: string): RubySeg[] => parseMarkup(text).segs;

/** ｜がなければ《の直前の漢字の並びに付く。閉じていない《や、付ける文字がない《はそのまま文字として残す */
function parseRubyRaw(text: string): RubySeg[] {
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
