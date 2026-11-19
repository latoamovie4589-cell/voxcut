// 声に合わせて、画像・文字・図形を弾ませる。キャラクターの口の開き（立ち絵の口パクと同じ判定）を読んで、
// アイテムの動き（アニメーションの途中の状態）として書き込む。画面も書き出しも ふつうのキーフレームの動きなので、見た目は同じになる。

import type {Look, Project, Transform, VoiceClip} from './model';
import {plainLook, startOffsetOf} from './model';
import {mouthAt} from './lipsync';
import {getPeaks, onPeaks} from './peaks';

export type TalkMode = 'hop' | 'zoom';
export const TALK_MODE_LABEL: Record<TalkMode, string> = {hop: '上へ跳ねる', zoom: 'ぷるっと大きくなる'};

/** キーフレームの数の上限（書き出しの式が長くなりすぎないように） */
const MAX_KEYS = 70;

/** 口の開き（0・1・2）→ 弾みの量（0・半分・全量） */
const LEVEL = [0, 0.5, 1];

/** 声の波形が届くまで待つ（合成していない行は波形が無いので、そのまま進む） */
export async function ensurePeaks(keys: string[], timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (keys.some(k => !getPeaks(k)) && Date.now() - start < timeoutMs) {
    await new Promise<void>(res => {
      const off = onPeaks(() => {
        off();
        res();
      });
      setTimeout(() => {
        off();
        res();
      }, 200);
    });
  }
}

/** そのキャラクターの口の開き（0・1・2）を、アイテムの長さの 1 コマずつ。声が無ければ全部 0 */
export function mouthLevelsFor(p: Project, characterId: string, start: number, duration: number): number[] {
  const fps = p.video.fps;
  const lines = p.clips.filter((c): c is VoiceClip => c.type === 'voice' && c.characterId === characterId && !!c.audio && !c.portrait?.noMouth);
  const out = new Array<number>(duration).fill(0);
  for (const v of lines) {
    const pk = getPeaks(v.audio!.cacheKey);
    if (!pk) continue;
    for (let i = 0; i < duration; i++) {
      const f = start + i;
      if (f < v.start || f >= v.start + v.duration) continue;
      out[i] = Math.max(out[i], mouthAt(pk.data, pk.max, f - v.start + startOffsetOf(v), fps));
    }
  }
  return out;
}

/**
 * 口の開きの並びから、弾むアニメーションを作る。
 * hop は画面の高さの amount %（口が全開のとき）だけ上へ、zoom は大きさが amount %（全開のとき）増える。半開きは半分
 * 口が開く・閉じるところごとに 1 コマで動くキーフレームを置く。短すぎる口の切り替えは、キーフレームが多くなりすぎないよう まとめる。
 * 口がまったく開かないときは null
 */
export function bakeTalkBounce<T extends {transform: Transform; duration: number; look?: Look}>(c: T, levels: number[], mode: TalkMode, amount: number, frameHeight: number): T | null {
  const dur = Math.max(1, c.duration);
  const runsAt = (minRun: number) => {
    const runs: {f: number; lv: number}[] = [];
    let i = 0;
    while (i < dur) {
      const lv = levels[i] ?? 0;
      let j = i;
      while (j < dur && (levels[j] ?? 0) === lv) j++;
      // 短い切り替えは、前の状態に含める
      if (j - i >= minRun || !runs.length) runs.push({f: i, lv});
      i = j;
    }
    return runs.filter((r, k) => k === 0 || r.lv !== runs[k - 1].lv);
  };
  let minRun = 2;
  let runs = runsAt(minRun);
  while (runs.length * 2 > MAX_KEYS && minRun < dur) {
    minRun += 2;
    runs = runsAt(minRun);
  }
  if (!runs.some(r => r.lv > 0)) return null;
  const base = c.transform;
  const px = (frameHeight * amount) / 100;
  const at = (lv: number): Transform => (mode === 'hop' ? {...base, y: base.y - px * LEVEL[lv]} : {...base, scale: base.scale * (1 + (amount / 100) * LEVEL[lv])});
  const rotation = c.look?.rotation ?? 0;
  const keys: {at: number; transform: Transform; rotation: number}[] = [];
  const put = (frame: number, lv: number) => {
    const a = frame / dur;
    if (a > 0.001 && a < 0.999) keys.push({at: a, transform: at(lv), rotation});
  };
  runs.forEach((r, k) => {
    if (k === 0) {
      // はじめから口が開いていたら、1 コマで開く
      if (r.lv > 0) put(1, r.lv);
      return;
    }
    // 前の状態を保ってから、1 コマで切り替える
    put(r.f - 1, runs[k - 1].lv);
    put(r.f, r.lv);
  });
  const last = runs[runs.length - 1].lv;
  const look: Look = {...plainLook(), ...(c.look ?? {})};
  return {...c, look: {...look, anim: {to: at(last), rotation, ease: 'linear', keys}}};
}
