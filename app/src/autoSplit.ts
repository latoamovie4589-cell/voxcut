// 長い動画を、指定の長さ以内の何本かに分ける（ショート・リール向け）。切れ目はセリフとセリフの間にそろえる。

import type {Project} from './model';

/**
 * 全体（0〜total）を、1 本が maxFrames 以内になるよう分ける範囲を返す。
 * 切れ目はセリフの終わり（途中でセリフが続いていない所）か、マーカーから選ぶ。残りを均等に近く割れる所を選ぶので、最後だけ極端に短くならない。
 * 1 つのセリフが maxFrames より長いときは、その本だけ超える
 */
export function planSplit(p: Project, total: number, maxFrames: number): [number, number][] {
  if (!(total > 0) || !(maxFrames > 0)) return [];
  if (total <= maxFrames) return [[0, total]];
  const voices = p.clips.filter(c => c.type === 'voice');
  const inside = (f: number) => voices.some(v => v.start < f && f < v.start + v.duration);
  const cand = [...new Set([...voices.map(v => v.start + v.duration), ...(p.markers ?? []).map(m => m.frame)])].filter(f => f > 0 && f < total && !inside(f)).sort((a, b) => a - b);
  const out: [number, number][] = [];
  let at = 0;
  while (at < total) {
    const rest = total - at;
    if (rest <= maxFrames) {
      out.push([at, total]);
      break;
    }
    const ideal = at + rest / Math.ceil(rest / maxFrames);
    const ok = cand.filter(f => f > at && f <= at + maxFrames);
    let cut = ok.length ? ok.reduce((b, f) => (Math.abs(f - ideal) < Math.abs(b - ideal) ? f : b)) : (cand.find(f => f > at) ?? total);
    // セリフの切れ目が無いときは、長さの上限で切る
    if (cut === total && rest > maxFrames) cut = at + maxFrames;
    out.push([at, cut]);
    at = cut;
  }
  return out;
}
