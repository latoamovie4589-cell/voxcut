// 台本の文を「誰が・何を話すか」の並びに分ける（台本読み込み・貼り付け用）。
// 受け付ける書き方（YMM4 の台本ファイルと同じものを含む）：
//   名前「セリフ」（「」の中は改行してよい。\「 \」で括弧そのもの） ／ 名前：セリフ ／ 名前: セリフ ／ 【名前】セリフ ／ 名前<Tab>セリフ
//   # で始まる行はコメント
//   CSV（名前,セリフ。"" で囲めばカンマ・改行を含められる）／ TSV（名前<Tab>セリフ）
// 名前の無い行は「名前なし」として返す（呼ぶ側で、選んでいるキャラクターに割り当てる）。

export interface ScriptLine {
  /** 書かれていた名前（無ければ null） */
  name: string | null;
  text: string;
}

const NAME_MAX = 20;

const PATTERNS: RegExp[] = [
  // 【名前】セリフ
  /^【([^】]{1,20})】\s*(.+)$/,
  // 名前「セリフ」 / 名前『セリフ』（中は複数行でもよい）
  /^([^「『：:\t]{1,20})[「『]([\s\S]+?)[」』]?$/,
  // 名前：セリフ / 名前: セリフ
  /^([^：:「『\t]{1,20})[：:]\s*(.+)$/,
  // 名前<Tab>セリフ（表計算からの貼り付け）
  /^([^\t]{1,20})\t+(.+)$/,
];

/** 行の終わりに、\ で打ち消していない閉じ括弧があるか */
const closes = (t: string) => /(^|[^\\])[」』]$/.test(t);
const unescape = (t: string) => t.replace(/\\([「」『』])/g, '$1');

/** 名前「…」が複数行にまたがっていたら 1 行にまとめる（YMM4 の台本ファイル） */
function joinBracketLines(lines: string[]): string[] {
  const out: string[] = [];
  let buf: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (buf !== null) {
      buf += '\n' + line;
      if (closes(line)) {
        out.push(buf);
        buf = null;
      }
      continue;
    }
    const open = line.match(/^([^「『：:\t]{1,20})[「『]/);
    if (open && !closes(line)) buf = line;
    else out.push(line);
  }
  if (buf !== null) out.push(buf);
  return out;
}

export function parseScript(src: string): ScriptLine[] {
  const out: ScriptLine[] = [];
  const rows = joinBracketLines(src.replace(/\r\n?/g, '\n').split('\n')).filter(l => !l.startsWith('#'));
  for (const raw of rows) {
    const line = raw.trim();
    if (!line) continue;
    let hit: ScriptLine | null = null;
    for (const re of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[1].trim();
      const text = m[2].trim();
      // URL の「https:」や時刻「10:30」を名前と取り違えない
      if (!name || !text || name.length > NAME_MAX || /(https?|ftp)$/i.test(name) || text.startsWith('//') || /^\d+$/.test(name)) continue;
      hit = {name, text: unescape(text)};
      break;
    }
    out.push(hit ?? {name: null, text: line});
  }
  return out;
}

/** 名前ごとの行数（出てきた順） */
export function namesIn(lines: ScriptLine[]): {name: string; count: number}[] {
  const m = new Map<string, number>();
  for (const l of lines) if (l.name) m.set(l.name, (m.get(l.name) ?? 0) + 1);
  return [...m].map(([name, count]) => ({name, count}));
}

/** CSV・TSV を読む（"" で囲んだ中のカンマ・改行・"" に対応）。# で始まる行はコメント */
export function parseDelimited(src: string, sep: ',' | '\t'): ScriptLine[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atRowStart = true;
  let comment = false;
  const text = src.replace(/\r\n?/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (comment) {
      if (ch === '\n') {
        comment = false;
        atRowStart = true;
      }
      continue;
    }
    if (atRowStart && ch === '#') {
      comment = true;
      continue;
    }
    atRowStart = false;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atRowStart = true;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows
    .filter(r => r.some(c => c.trim()))
    .map(r => (r.length >= 2 ? {name: r[0].trim() || null, text: r.slice(1).join(sep).trim()} : {name: null, text: r[0].trim()}))
    .filter(l => l.text);
}

/** ファイル名の拡張子で読み方を選ぶ（.csv / .tsv / それ以外は文章の台本） */
export function parseScriptFile(fileName: string, src: string): ScriptLine[] {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'csv') return parseDelimited(src, ',');
  if (ext === 'tsv') return parseDelimited(src, '\t');
  return parseScript(src);
}

/** 読み込んだ行を、台本の文（名前「セリフ」）に戻す。読み込み画面の編集欄に入れる */
export function toScriptText(lines: ScriptLine[]): string {
  return lines.map(l => (l.name ? `${l.name}「${l.text.replace(/([「」])/g, '\\$1')}」` : l.text)).join('\n');
}

// ───────────── 長いセリフを自動で分ける ─────────────

const SENTENCE_END = new Set([...'。！？!?…‥']);
const OPEN = new Set([...'「『（(【']);
const CLOSE = new Set([...'」』）)】']);
const CLAUSE = new Set([...'、，,']);
/** 行の頭に置かない文字（句読点・閉じ括弧・小さい仮名）。切れ目をずらして前の行に含める */
const NO_LINE_START = new Set([...'、。，．・：；？！ー）」』】〕｝〉》ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ…‥!?,.:;)]}%']);

/** 区切り（文の終わり／読点）で、括弧の中を除いて、記号を前に付けたまま分ける */
function cutAt(text: string, marks: Set<string>): string[] {
  const chars = [...text];
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    cur += c;
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth = Math.max(0, depth - 1);
    if (depth === 0 && marks.has(c)) {
      // 続く記号・閉じ括弧も同じところに含める（「！？」「。」」など）
      while (i + 1 < chars.length && (marks.has(chars[i + 1]) || CLOSE.has(chars[i + 1]) || SENTENCE_END.has(chars[i + 1]))) {
        i++;
        cur += chars[i];
        if (CLOSE.has(chars[i])) depth = Math.max(0, depth - 1);
      }
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** どこにも切れ目が無い長い文を、max 文字ずつで切る（行の頭に来てはいけない文字は前の行へ） */
function hardSplit(text: string, max: number): string[] {
  const c = [...text];
  const out: string[] = [];
  let i = 0;
  while (i < c.length) {
    let e = Math.min(c.length, i + max);
    while (e < c.length && e < i + max + 2 && NO_LINE_START.has(c[e])) e++;
    out.push(c.slice(i, e).join(''));
    i = e;
  }
  return out;
}

/** 単位（文や節）を、max 文字を超えないよう順に詰める。1 つで超えるものは、細かい単位で詰め直す */
function pack(units: string[], max: number, finer?: (u: string) => string[]): string[] {
  const out: string[] = [];
  let line = '';
  const push = () => {
    if (line) out.push(line);
    line = '';
  };
  for (const u of units) {
    const n = [...u].length;
    if (n > max) {
      push();
      const parts = finer ? finer(u) : hardSplit(u, max);
      out.push(...parts);
      continue;
    }
    if ([...line].length + n <= max) line += u;
    else {
      push();
      line = u;
    }
  }
  push();
  return out;
}

/**
 * 長いセリフを、読みやすい長さ（max 文字まで）に分ける。
 * 文の終わり（。！？）で切り、足りなければ読点（、）で、それでも長ければ max 文字ごとに切る。「」の中では切らない。
 * 短いセリフはそのまま 1 つで返す
 */
export function splitLongText(text: string, max: number): string[] {
  const t = text.replace(/\s*\n\s*/g, '').trim();
  const limit = Math.max(8, Math.floor(max));
  if ([...t].length <= limit) return [t];
  const byClause = (s: string) => pack(cutAt(s, CLAUSE), limit);
  return pack(cutAt(t, SENTENCE_END), limit, byClause).filter(s => s.trim());
}
