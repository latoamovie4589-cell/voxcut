// 台本の文を「誰が・何を話すか」の並びに分ける（貼り付け用）。
// 受け付ける書き方：
//   名前：セリフ ／ 名前: セリフ ／ 名前「セリフ」 ／ 【名前】セリフ ／ 名前<Tab>セリフ
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
  // 名前「セリフ」 / 名前『セリフ』
  /^([^「『：:\t]{1,20})[「『](.+?)[」』]?$/,
  // 名前：セリフ / 名前: セリフ
  /^([^：:「『\t]{1,20})[：:]\s*(.+)$/,
  // 名前<Tab>セリフ（表計算からの貼り付け）
  /^([^\t]{1,20})\t+(.+)$/,
];

export function parseScript(src: string): ScriptLine[] {
  const out: ScriptLine[] = [];
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
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
      hit = {name, text};
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
