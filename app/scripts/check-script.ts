// 台本の読み取り（src/script.ts）の確認。npx tsx scripts/check-script.ts
import assert from 'node:assert/strict';
import {namesIn, parseScript} from '../src/script.ts';

const src = `ずんだもん：こんにちはなのだ
めたん: よろしくね
【つむぎ】やっほー
ずんだもん「今日は晴れなのだ」
ナレーション\t場面は変わって

名前のない行です。
詳しくは https://example.com を見てね
10:30 に集合
`;
const r = parseScript(src);
assert.deepEqual(r, [
  {name: 'ずんだもん', text: 'こんにちはなのだ'},
  {name: 'めたん', text: 'よろしくね'},
  {name: 'つむぎ', text: 'やっほー'},
  {name: 'ずんだもん', text: '今日は晴れなのだ'},
  {name: 'ナレーション', text: '場面は変わって'},
  {name: null, text: '名前のない行です。'},
  {name: null, text: '詳しくは https://example.com を見てね'},
  {name: null, text: '10:30 に集合'},
]);
assert.deepEqual(namesIn(r), [
  {name: 'ずんだもん', count: 2},
  {name: 'めたん', count: 1},
  {name: 'つむぎ', count: 1},
  {name: 'ナレーション', count: 1},
]);
console.log('script ok');

// ダッキング（src/ducking.ts）：render.rs のテストと同じ値
import {duckGain, voiceIntervals} from '../src/ducking.ts';
const iv: [number, number][] = [[0, 8.8]];
assert.ok(Math.abs(duckGain(iv, 0.3, 4) - 0.3) < 1e-9);
assert.equal(duckGain(iv, 0.3, 9.05), 1);
assert.ok(Math.abs(duckGain(iv, 0.3, 8.925) - 0.65) < 1e-9);
assert.equal(duckGain([], 0.3, 1), 1);
const proj = {
  video: {fps: 30},
  tracks: [{id: 'v', kind: 'voice', muted: false}],
  clips: [
    {type: 'voice', trackId: 'v', start: 0, duration: 84},
    {type: 'voice', trackId: 'v', start: 90, duration: 84},
    {type: 'voice', trackId: 'v', start: 300, duration: 30},
  ],
} as unknown as Parameters<typeof voiceIntervals>[0];
assert.deepEqual(voiceIntervals(proj), [
  [0, 5.8],
  [10, 11],
]);
console.log('ducking ok');
