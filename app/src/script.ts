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
