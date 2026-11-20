// 書き出し前の点検：書き出して初めて気づく困りごと（声が未合成・空のセリフ・素材が見つからない・はみ出す字幕・長すぎる間）を前もって見つける。

import {overflowLines} from './autoFit';
import type {Project, VoiceClip} from './model';

export type IssueKind = 'unsynth' | 'empty' | 'missing' | 'overflow' | 'bigGap';

export interface Issue {
  kind: IssueKind;
  /** error は、そのまま書き出すと困るもの。warn は、確かめたほうがいいもの */
  level: 'error' | 'warn';
  title: string;
  /** 該当するアイテムの id（見に行く・選ぶ用） */
  ids: string[];
}

const voices = (p: Project) => p.clips.filter((c): c is VoiceClip => c.type === 'voice');

/** 点検する。error → warn の順に並べる。困りごとがなければ空 */
export function checkProject(p: Project, missingMedia: string[], maxLines = 3): Issue[] {
  const out: Issue[] = [];
  const vs = voices(p);
  const unsynth = vs.filter(v => v.text.trim() && !v.audio).map(v => v.id);
  if (unsynth.length) out.push({kind: 'unsynth', level: 'error', title: `声がまだ作られていないセリフが ${unsynth.length} 個あります`, ids: unsynth});
  const missing = p.clips.filter(c => c.type === 'media' && missingMedia.includes(c.src)).map(c => c.id);
  if (missing.length) out.push({kind: 'missing', level: 'error', title: `素材のファイルが見つからないアイテムが ${missing.length} 個あります`, ids: missing});
  const empty = vs.filter(v => !v.text.trim()).map(v => v.id);
  if (empty.length) out.push({kind: 'empty', level: 'warn', title: `言葉が空のセリフが ${empty.length} 個あります`, ids: empty});
  const over = overflowLines(p, maxLines).map(v => v.id);
  if (over.length) out.push({kind: 'overflow', level: 'warn', title: `字幕が ${maxLines + 1} 行以上になるセリフが ${over.length} 個あります（画面からはみ出すかもしれません）`, ids: over});
  const last = vs.reduce<VoiceClip | null>((m, c) => (!m || c.start + c.duration > m.start + m.duration ? c : m), null);
  const big = vs.filter(v => v.id !== last?.id && v.gapAfter > p.video.fps * 3).map(v => v.id);
  if (big.length) out.push({kind: 'bigGap', level: 'warn', title: `後ろの間が 3 秒より長いセリフが ${big.length} 個あります`, ids: big});
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}
