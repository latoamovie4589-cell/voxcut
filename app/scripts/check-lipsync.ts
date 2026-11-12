// lipsync.ts と core/src/lipsync.rs が同じ結果を出すか確かめる（node で実行）。
// 期待値は core/src/lipsync.rs の PARITY_BLINK_FRAMES と mouth_follows_volume テストと同じ。
import {blinkStarts, clipMax, eyesAt, fnv1a, mouthAt} from '../src/lipsync.ts';

const assert = (ok: boolean, msg: string) => {
  if (!ok) {
    console.error('NG:', msg);
    process.exit(1);
  }
};

assert(fnv1a('') === 0x811c9dc5, 'fnv1a("")');
assert(fnv1a('a') === 0xe40c292c, 'fnv1a("a")');

const b = blinkStarts('ch_a', 30, 600);
assert(JSON.stringify(b.starts) === JSON.stringify([164, 281, 390, 500]), `blink starts ${JSON.stringify(b.starts)}`);
const s = b.starts[0];
const shape = [0, 1, 2, 3, 4, 5].map(i => eyesAt(s + i, b));
assert(JSON.stringify(shape) === '[1,1,2,2,1,1]', `blink shape ${shape}`);
assert(eyesAt(s - 1, b) === 0 && eyesAt(s + 6, b) === 0, 'blink edges');

const pk: number[] = [];
for (const lv of [0, 20, 100]) for (let i = 0; i < 10; i++) pk.push(-lv, lv);
const arr = Int8Array.from(pk);
const m = clipMax(arr);
const mouth = [...Array(9).keys()].map(f => mouthAt(arr, m, f, 30));
assert(JSON.stringify(mouth) === '[0,0,0,1,1,1,2,2,2]', `mouth ${mouth}`);

console.log('lipsync: Rust と同じ結果です');
