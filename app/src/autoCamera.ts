// しゃべる人へ自動でズーム：話している立ち絵へカメラがゆっくり寄って、話し終わったら戻る。
// 同じキャラクターが続けて話している間を 1 つの区間にして、区間ごとに 1 つのカメラ（制御アイテム）を置く。

import type {AnimMid, Project, Transform, VoiceClip} from './model';

export interface ZoomRun {
  start: number;
  duration: number;
  characterId: string;
  /** 寄ったときのカメラの位置と大きさ */
  zoom: Transform;
  /** 寄る・戻るのにかけるコマ数 */
  ease: number;
}

export interface ZoomOptions {
  /** 寄る倍率（1.1 ＝ 10% 大きく） */
  scale: number;
  /** 区間の最短（これより短い区間は寄らない）。フレーム */
  minFrames: number;
  /** 寄る・戻るのにかけるコマ数 */
  ease: number;
}

/**
 * カメラを動かす区間を求める。立ち絵が見えているキャラクターのセリフだけ（同じキャラクターが、すき間 2 コマ以内で続く間を 1 区間に）。
 * カメラは横だけ立ち絵のほうへ寄せる（寄った画面の外が見えないところまで）。縦は動かさない
 */
export function planSpeakerZoom(p: Project, opt: ZoomOptions): ZoomRun[] {
  const {width} = p.video;
  const s = Math.min(2, Math.max(1.02, opt.scale));
  const voices = p.clips.filter((c): c is VoiceClip => c.type === 'voice').sort((a, b) => a.start - b.start);
  const runs: ZoomRun[] = [];
  for (const v of voices) {
    const ch = p.characters.find(c => c.id === v.characterId);
    if (!ch?.portrait?.visible) continue;
    const last = runs[runs.length - 1];
    if (last && last.characterId === v.characterId && v.start <= last.start + last.duration + 2) {
      last.duration = Math.max(last.duration, v.start + v.duration - last.start);
      continue;
    }
    // x は、立ち絵の真ん中の横の位置。寄せる量は、寄った画面から出ない範囲（(倍率 − 1) × 画面の幅 ÷ 2）まで
    const limit = ((s - 1) * width) / 2;
    const x = Math.max(-limit, Math.min(limit, ch.portrait.transform.x * s));
    runs.push({start: v.start, duration: v.duration, characterId: v.characterId, zoom: {x: Math.round(x), y: 0, scale: Number(s.toFixed(4)), opacity: 1}, ease: opt.ease});
  }
  return runs.filter(r => r.duration >= opt.minFrames);
}

/** 区間の中の動き：はじめは寄っていない → 寄る → 話し終わるころ戻る（制御アイテムの動き） */
export function zoomAnim(run: ZoomRun): {keys: AnimMid[]; ease: number} {
  const e = Math.max(1, Math.min(run.ease, Math.floor(run.duration / 3)));
  const keys: AnimMid[] = [
    {at: e / run.duration, transform: run.zoom, rotation: 0},
    {at: 1 - e / run.duration, transform: run.zoom, rotation: 0},
  ];
  return {keys, ease: e};
}
