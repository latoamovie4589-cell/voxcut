// セリフの言いよどみ（「えーと、」「あの、」など）を取り除く言葉の計算。

const WORDS = ['え[ー〜ぇ]*っ?と', 'ええと', 'え[ー〜]+', 'あの[ー〜うぅぉ]*', 'その[ー〜う]*', 'うー+ん+と?', 'ん[ー〜]+', 'あー+', 'まあ', 'まぁ'];
/** 文の頭か、区切りの後ろにある「言いよどみ＋読点か…」。読点か「…」が続くものだけ（「あの人」のような普通の言葉は消さない） */
const FILLER = new RegExp(`(?<=^|[「『（(、，。！？!?\\s])(?:${WORDS.join('|')})[、，,…‥]+\\s*`, 'gu');

/** 言いよどみを取り除いた文と、取り除いた言葉。何も残らなくなるときは変えない */
export function removeFillers(text: string): {text: string; removed: string[]} {
  const removed: string[] = [];
  const next = text.replace(FILLER, m => {
    removed.push(m.trim());
    return '';
  });
  const out = next.replace(/^\s+/, '');
  if (!removed.length || !/[^\s、，,。．.！？!?…‥「」『』（）()ー〜]/u.test(out)) return {text, removed: []};
  return {text: out, removed};
}
