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

// ---- 調声：キャラクター → プリセット → 行の話者 → 行の調声 の順に重なる（Rust の effective_voice と同じ） ----
{
  const {effectiveVoice, synthKey, defaultParams} = await import('../src/model.ts');
  const ch = {
    id: 'a',
    name: 'A',
    color: '#000',
    voice: {engine: 'voicevox' as const, speaker: '1', params: defaultParams()},
    subtitle: {} as never,
    portrait: null,
    voicePresets: [{id: 'p1', name: '叫び', speaker: '3', params: {...defaultParams(), speed: 1.4}}],
  };
  const clip = {
    id: 'c',
    type: 'voice',
    trackId: 't',
    start: 0,
    duration: 10,
    characterId: 'a',
    text: 'x',
    subtitle: null,
    paramsOverride: null,
    audio: null,
    gapAfter: 6,
    lockDuration: false,
  } as const;
  assert.equal(effectiveVoice(ch, {...clip}).params.speed, 1);
  const withPreset = effectiveVoice(ch, {...clip, presetId: 'p1'});
  assert.deepEqual([withPreset.speaker, withPreset.params.speed], ['3', 1.4]);
  const both = effectiveVoice(ch, {...clip, presetId: 'p1', speakerOverride: '5', paramsOverride: {...defaultParams(), speed: 0.8}});
  assert.deepEqual([both.speaker, both.params.speed], ['5', 0.8]);
  assert.equal(effectiveVoice(ch, {...clip, presetId: 'gone'}).speaker, '1');
  // 音量は合成し直しの鍵に入らない。細かい調整・感情は入る
  const v = ch.voice;
  assert.equal(synthKey(v), synthKey({...v, params: {...v.params, volume: 0.2}}));
  assert.notEqual(synthKey(v), synthKey({...v, params: {...v.params, extra: {pauseLengthScale: 0.5}}}));
  assert.equal(synthKey({...v, params: {...v.params, emotions: {a: 1, b: 2}}}), synthKey({...v, params: {...v.params, emotions: {b: 2, a: 1}}}));
  console.log('tuning ok');
}

// ---- レイヤー：長さ = 音声 + 余韻。詰めて並んだ行は詰め直し、離した行は保つ。素材も同じレイヤーなら押し出す ----
{
  const {reflowVoiceTrack, voiceLayerFor, newLayer} = await import('../src/model.ts');
  const v = (id: string, start: number, ms: number | null, gap = 6) => ({
    id,
    type: 'voice',
    trackId: 'L1',
    start,
    duration: 30,
    characterId: 'a',
    text: 'x',
    subtitle: null,
    paramsOverride: null,
    audio: ms === null ? null : {cacheKey: id, durationMs: ms},
    gapAfter: gap,
    lockDuration: false,
  });
  const proj = {
    version: 2,
    name: 't',
    video: {width: 1920, height: 1080, fps: 30, sampleRate: 48000, background: '#000'},
    characters: [{id: 'a', name: 'A', color: '#000', voice: {engine: 'voicevox', speaker: '1', params: {}}, subtitle: {}, portrait: null, layer: null}],
    tracks: [newLayer('L1'), newLayer('L2')],
    clips: [v('c1', 0, 1000), v('c2', 30, 2000), v('c3', 200, 1000), {id: 'm', type: 'media', trackId: 'L1', start: 230, duration: 30}],
  } as never;
  const r = reflowVoiceTrack(proj, 'L1') as {clips: {id: string; start: number; duration: number}[]};
  assert.deepEqual(
    r.clips.map(c => [c.id, c.start, c.duration]),
    [
      ['c1', 0, 36],
      ['c2', 36, 66],
      ['c3', 200, 36],
      ['m', 236, 30],
    ],
  );
  // 分離した声がまだ無ければ決まっていない（空いているレイヤーを探す）
  assert.equal(voiceLayerFor(proj, 'a'), -1);
  console.log('layers ok');
}

// ---- YMM4 の台本ファイル（txt / csv / tsv） ----
{
  const {parseScript, parseDelimited, parseScriptFile, toScriptText} = await import('../src/script.ts');
  const txt = `# コメント
霊夢「こんにちは」
魔理沙「2 行に
またがるセリフ」
霊夢「括弧\\「そのもの\\」も」`;
  assert.deepEqual(parseScript(txt), [
    {name: '霊夢', text: 'こんにちは'},
    {name: '魔理沙', text: '2 行に\nまたがるセリフ'},
    {name: '霊夢', text: '括弧「そのもの」も'},
  ]);
  const csv = `# コメント\n霊夢,こんにちは\n魔理沙,"カンマ, と\n改行と ""引用"""\n`;
  assert.deepEqual(parseDelimited(csv, ','), [
    {name: '霊夢', text: 'こんにちは'},
    {name: '魔理沙', text: 'カンマ, と\n改行と "引用"'},
  ]);
  assert.deepEqual(parseScriptFile('a.TSV', '霊夢\tやあ\n'), [{name: '霊夢', text: 'やあ'}]);
  // 文に戻して読み直しても同じ
  const back = parseScript(toScriptText(parseScript(txt)));
  assert.deepEqual(back, parseScript(txt));
  console.log('script files ok');
}

// ---- 会話はレイヤーをまたいで付いていく。消したら詰まる ----
{
  const {reflowAll, newLayer} = await import('../src/model.ts');
  const v = (id: string, track: string, start: number, ms: number | null) => ({
    id,
    type: 'voice',
    trackId: track,
    start,
    duration: 30,
    characterId: 'a',
    text: 'x',
    subtitle: null,
    paramsOverride: null,
    audio: ms === null ? null : {cacheKey: id, durationMs: ms},
    gapAfter: 0,
    lockDuration: false,
  });
  const base = {version: 2, name: 't', video: {width: 1, height: 1, fps: 30, sampleRate: 48000, background: '#000'}, characters: [], tracks: [newLayer('A'), newLayer('B')]};
  const p = {...base, clips: [v('a1', 'A', 0, 2000), v('b1', 'B', 30, null), v('a2', 'A', 60, null)]} as never;
  const r = reflowAll(p) as {clips: {id: string; start: number}[]};
  assert.deepEqual(
    r.clips.map(c => [c.id, c.start]),
    [
      ['a1', 0],
      ['b1', 60],
      ['a2', 90],
    ],
  );
  const d = reflowAll(p, new Set(['b1'])) as {clips: {id: string; start: number}[]};
  assert.equal(d.clips.find(c => c.id === 'a2')!.start, 60, '消した行の分だけ詰まる');
  console.log('conversation ok');
}

// Premiere Pro 式のリンク：セリフと字幕は一緒に動き、動画と音声は同じだけずれる
{
  const {keepLinks, reflowAll: reflow, newLayer: nl} = await import('../src/model.ts');
  const voice = {
    id: 'v',
    type: 'voice',
    trackId: 'A1',
    start: 0,
    duration: 30,
    linkId: 'L',
    characterId: 'c',
    text: 'x',
    subtitle: null,
    paramsOverride: null,
    audio: {cacheKey: 'k', durationMs: 2000},
    gapAfter: 0,
    lockDuration: false,
  };
  const cap = {id: 'cap', type: 'caption', trackId: 'V1', start: 0, duration: 30, linkId: 'L', voiceId: 'v'};
  const vid = {
    id: 'mv',
    type: 'media',
    trackId: 'V2',
    start: 100,
    duration: 50,
    linkId: 'M',
    src: 'a.mp4',
    mediaKind: 'video',
    hasAudio: true,
    inPoint: 10,
    volume: 1,
    transform: {x: 0, y: 0, scale: 1, opacity: 1},
  };
  const aud = {...vid, id: 'ma', trackId: 'A2', mediaKind: 'audio'};
  const base = {
    version: 3,
    name: 't',
    video: {width: 1, height: 1, fps: 30, sampleRate: 48000, background: '#000'},
    characters: [],
    tracks: [nl('V1'), nl('V2'), nl('A1', 'audio'), nl('A2', 'audio')],
  };
  type P = {clips: {id: string; start: number; duration: number; inPoint?: number}[]};
  const p = {...base, clips: [voice, cap, vid, aud]} as never;
  const get = (q: P, id: string) => q.clips.find(c => c.id === id)!;
  // 合成で長さが変わったら、字幕も付いてくる
  const r = reflow(p) as P;
  assert.deepEqual([get(r, 'cap').start, get(r, 'cap').duration], [0, 60]);
  // 字幕を動かすと、セリフも動く
  const moved = {...base, clips: [voice, {...cap, start: 20}, vid, aud]} as never;
  const m = keepLinks(p, moved) as P;
  assert.equal(get(m, 'v').start, 20);
  assert.equal(get(m, 'cap').start, 20);
  // 動画の左端を詰めると、音声も同じだけ詰まり、切り出し位置もずれる
  const trimmed = {...base, clips: [voice, cap, {...vid, start: 110, duration: 40, inPoint: 20}, aud]} as never;
  const t = keepLinks(p, trimmed) as P;
  assert.deepEqual([get(t, 'ma').start, get(t, 'ma').duration, get(t, 'ma').inPoint], [110, 40, 20]);
  // 移動では切り出し位置は変えない
  const shifted = keepLinks(p, {...base, clips: [voice, cap, {...vid, start: 130}, aud]} as never) as P;
  assert.deepEqual([get(shifted, 'ma').start, get(shifted, 'ma').inPoint], [130, 10]);
  // セリフを消すと字幕も消える
  const gone = keepLinks(p, {...base, clips: [cap, vid, aud]} as never) as P;
  assert.ok(!gone.clips.some(c => c.id === 'cap'));
  console.log('links ok');
}

// セリフの立ち絵設定：レイヤーを変えたセリフは、表情の後ろの番号になる（Rust の lipsync::line_variants と同じ）
{
  const {lineVariants, expressionFor} = await import('../src/model.ts');
  const ex = (name: string, visibility = {}) => ({name, base: null, eyes: [null, null, null], mouth: [null, null, null], visibility});
  const ch = {id: 'a', portrait: {expressions: [ex('怒り', {x: true}), ex('笑顔', {y: true})], psd: {src: 'a.psd'}}};
  const line = (id: string, extra = {}) => ({id, type: 'voice', characterId: 'a', trackId: 'V2', start: 0, duration: 90, ...extra});
  const p = {
    characters: [ch],
    clips: [
      {id: 'pt', type: 'portrait', characterId: 'a', trackId: 'V1', start: 0, duration: 600, expression: '笑顔'},
      line('c1', {portrait: {visibility: {z: false}}}),
      line('c2', {start: 90}),
      line('c3', {start: 180, expression: '怒り', portrait: {visibility: {y: true}}}),
    ],
  } as never;
  const v = lineVariants(p, ch as never).map(x => [x.id, x.index, x.base]);
  assert.deepEqual(v, [
    ['c1', 3, 2],
    ['c3', 4, 1],
  ]);
  assert.deepEqual(expressionFor(p, ch as never, 3)?.visibility, {y: true, z: false});
  assert.deepEqual(expressionFor(p, ch as never, 4)?.visibility, {x: true, y: true});
  console.log('line portrait ok');
}

// 声の左右と再生開始位置（Rust の pan_gains・reflow_all と同じ）
{
  const {panGains, reflowAll} = await import('../src/model.ts');
  assert.deepEqual(panGains(0), [1, 1]);
  assert.deepEqual(panGains(-0.5), [1, 0.5]);
  assert.deepEqual(panGains(1), [0, 1]);
  const v = {
    id: 'v',
    type: 'voice',
    characterId: 'a',
    trackId: 'V1',
    start: 0,
    duration: 10,
    gapAfter: 6,
    lockDuration: false,
    audio: {cacheKey: 'k', durationMs: 1000},
    audioFx: {pan: 0, fadeIn: 0, fadeOut: 0, startOffset: 10},
  };
  const p = {video: {fps: 30}, tracks: [{id: 'V1', kind: 'video'}], characters: [], clips: [v]} as never;
  const r = reflowAll(p) as {clips: {duration: number}[]};
  assert.equal(r.clips[0].duration, 30 - 10 + 6);
  console.log('line audio ok');
}
