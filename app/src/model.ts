import type {SubtitleAnimation} from './subtitleAnim';

// Rust 側（core/src/model.rs）と同じ形。時間はすべて整数フレーム。

export type Frame = number;
export type EngineId = 'aivoice' | 'voicepeak' | 'voisona' | 'voicevox' | 'coeiroink' | 'aquestalk' | 'cevio';

export const ENGINE_LABEL: Record<EngineId, string> = {
  aivoice: 'A.I.VOICE',
  voicepeak: 'VOICEPEAK',
  voisona: 'VoiSona Talk',
  voicevox: 'VOICEVOX',
  coeiroink: 'COEIROINK',
  aquestalk: 'ゆっくりボイス（AquesTalk）',
  cevio: 'CeVIO AI',
};

export interface VoiceParams {
  speed: number;
  pitch: number;
  volume: number;
  intonation: number;
  emotions: Record<string, number>;
  /** ソフトごとの細かい調声（名前は各ソフトのパラメータ名。TUNING_EXTRA を参照） */
  extra?: Record<string, number>;
}

/** キャラクターの声のプリセット（「叫び」「ささやき」など）。話者を変えないなら speaker は null */
export interface VoicePreset {
  id: string;
  name: string;
  speaker: string | null;
  params: VoiceParams;
}

export interface Voice {
  engine: EngineId;
  speaker: string;
  params: VoiceParams;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  position: 'top' | 'middle' | 'bottom';
  marginV: number;
  animation: SubtitleAnimation;
  /** 影の色（空か無しなら影なし）とずれ（px、初期値 4） */
  shadowColor?: string;
  shadowOffset?: number;
  /** 文字の後ろの帯（空か無しなら帯なし）。帯を付けると縁取りの代わりになる（書き出しの ASS と同じ） */
  boxColor?: string;
  boxOpacity?: number;
  boxPadding?: number;
  /** 1 行に入れる文字数の上限（全角を 1、半角を 0.55 と数える）。0 か無しなら画面の幅で決める */
  maxChars?: number;
  /** カラオケで塗っていく色（空か無しなら黄色） */
  karaokeColor?: string;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

/** 立ち絵。同じキャンバスサイズの透過 PNG を base → eyes → mouth の順に重ねる */
export interface Portrait {
  base: string;
  /** [開, 半目, 閉] */
  eyes: [string | null, string | null, string | null];
  /** [閉, 半開き, 開] */
  mouth: [string | null, string | null, string | null];
  transform: Transform;
  visible: boolean;
  /** 喋っているとき（このキャラクターのセリフの間）だけ表示する */
  onlyWhileSpeaking?: boolean;
  /** 表情差分（セリフごとに名前で選ぶ） */
  expressions: Expression[];
  /** PSD 立ち絵（あれば base・eyes・mouth の画像の代わりに、PSD のレイヤーの表示を切り替えて描く） */
  psd?: PsdPortrait | null;
  /** 呼吸（しゃべっていない間も、足もとを止めたまま縦にゆっくり伸び縮みする） */
  breath?: Breath | null;
}

/** 立ち絵の呼吸。amount は伸びる大きさ（高さの %）、period は 1 回の長さ（秒） */
export interface Breath {
  amount: number;
  period: number;
}

/** 時刻 t 秒での呼吸の縦の倍率。Rust の Breath::scale_at と同じ式 */
export function breathScale(b: Breath | null | undefined, t: number): number {
  if (!b || !(b.amount > 0)) return 1;
  return 1 + ((Math.min(20, Math.max(0, b.amount)) / 100) * (1 - Math.cos((2 * Math.PI * t) / Math.max(0.2, b.period)))) / 2;
}

/** PSD 立ち絵の設定。レイヤーは上からの位置をつないだ id（例 "2/0/5"）で指す */
export interface PsdPortrait {
  src: string;
  /** いつもの表示状態（id → 表示するか。書いていないものは PSD に保存されていたとおり） */
  visibility: Record<string, boolean>;
  /** 目 [開, 半目, 閉] に使うレイヤー */
  eyes: [string | null, string | null, string | null];
  /** 口 [閉, 半開き, 開] に使うレイヤー */
  mouth: [string | null, string | null, string | null];
}

/** 表情。指定したパーツだけ通常の画像と差し替える */
export interface Expression {
  name: string;
  base: string | null;
  eyes: [string | null, string | null, string | null];
  mouth: [string | null, string | null, string | null];
  /** PSD 立ち絵のとき：この表情で表示を変えるレイヤー（id → 表示するか） */
  visibility?: Record<string, boolean>;
}

export const newPortrait = (base: string): Portrait => ({
  base,
  eyes: [null, null, null],
  mouth: [null, null, null],
  transform: {x: 560, y: 140, scale: 1, opacity: 1},
  visible: true,
  expressions: [],
});

const variant = (parts: (string | null)[], i: number) => parts[i] ?? parts[0] ?? null;

/** Rust の Portrait::layers と同じ（無い差分は 1 つ目で代用。expr は 0 が通常、1 以降が expressions[expr-1]） */
export function portraitLayers(p: Portrait, eyes: number, mouth: number, expr = 0): string[] {
  const ex = expr > 0 ? p.expressions?.[expr - 1] : undefined;
  const v = [ex?.base || p.base];
  const e = (ex && variant(ex.eyes, eyes)) ?? variant(p.eyes, eyes);
  if (e) v.push(e);
  const m = (ex && variant(ex.mouth, mouth)) ?? variant(p.mouth, mouth);
  if (m) v.push(m);
  return v;
}

/** 表情の名前 → 番号（0 は通常） */
export const expressionIndex = (p: Portrait, name: string | null | undefined): number => (name ? (p.expressions ?? []).findIndex(e => e.name === name) + 1 : 0);

export interface Character {
  id: string;
  name: string;
  color: string;
  voice: Voice;
  subtitle: SubtitleStyle;
  portrait: Portrait | null;
  voicePresets?: VoicePreset[];
  /** セリフ（字幕と声）を置くレイヤーの番号（1 から）。無ければ最後にこのキャラクターのセリフを置いたレイヤー */
  layer?: number | null;
  /** 字幕と声を分離したとき、声を置くレイヤーの番号。無ければ最後に分離した声を置いたレイヤー */
  audioLayer?: number | null;
  /** 新しいセリフの「セリフ後の余韻」（フレーム）。無ければ 6 */
  gapAfter?: number | null;
}

/**
 * YMM4 と同じレイヤー（tracks の順にレイヤー 1, 2, …。番号の大きいほど手前に描く）。どのアイテムもどのレイヤーにも置ける。
 * kind は版 3 の名残（読み込むとすべて 'video' になる）
 */
export interface Track {
  id: string;
  kind: 'video' | 'audio';
  name: string;
  /** 音だけ止める（M） */
  muted: boolean;
  /** 表示しない（目）。映像も音も出さない */
  hidden?: boolean;
  locked: boolean;
  /** ソロ（どれかをソロにすると、ソロのレイヤーの音だけ鳴る） */
  solo?: boolean;
  /** セリフの間だけ、このトラックの音（BGM など）を下げる */
  duck: boolean;
  /** 下げたときの音量（0〜1） */
  duckLevel: number;
}

export interface AudioRef {
  cacheKey: string;
  durationMs: number;
}

interface ClipBase {
  id: string;
  trackId: string;
  start: Frame;
  duration: Frame;
  /** リンク（同じ値のクリップは一緒に動く。セリフの音声と字幕、動画の映像と音声） */
  linkId?: string | null;
}

export interface VoiceClip extends ClipBase {
  type: 'voice';
  characterId: string;
  text: string;
  subtitle: string | null;
  paramsOverride: VoiceParams | null;
  audio: AudioRef | null;
  gapAfter: Frame;
  lockDuration: boolean;
  /** この行だけ話者（VOICEVOX のスタイルなど）を変える */
  speakerOverride?: string | null;
  /** この行の間の立ち絵の表情（Portrait.expressions の名前） */
  expression?: string | null;
  /** この行で使う声のプリセット（Character.voicePresets の id） */
  presetId?: string | null;
  /** VOICEVOX のアクセント・音の高さを手で直したもの（作ったときの文と話者が今と同じときだけ使う） */
  accent?: AccentEdit | null;
  /** 字幕を「個別に設定」したときの見た目。null ならキャラクターの字幕設定どおり */
  subtitleCustom?: SubtitleCustom | null;
  /** このセリフの間だけ立ち絵を変える（レイヤーの表示・目パチ・口パク・エフェクト） */
  portrait?: LinePortrait | null;
  /** 声の聞こえ方（左右・フェード・エコー・音声エフェクト・再生開始位置） */
  audioFx?: LineAudio | null;
}

/** セリフの声の聞こえ方。画面（preview/playback.ts）と書き出し（core/src/render.rs）で同じ効き方にする */
export interface LineAudio {
  /** 左右（-1 = 左だけ、0 = 真ん中、1 = 右だけ）。寄せた側はそのまま、反対側だけ小さくする */
  pan: number;
  /** フェードイン・アウト（フレーム） */
  fadeIn: Frame;
  fadeOut: Frame;
  /** 再生開始位置：声の頭をこのフレームだけ飛ばす（セリフの長さもその分短くなる） */
  startOffset: Frame;
  /** エコー（1 回だけ遅れて重なる） */
  echo?: {delayMs: number; decay: number} | null;
  /** 音声エフェクト（上から順に掛ける） */
  filters?: AudioFilter[];
}
export type AudioFilter = {kind: 'highpass'; hz: number} | {kind: 'lowpass'; hz: number};
export const plainLineAudio = (): LineAudio => ({pan: 0, fadeIn: 0, fadeOut: 0, startOffset: 0, echo: null, filters: []});
export const isPlainLineAudio = (a: LineAudio | null | undefined) => !a || (!a.pan && !a.fadeIn && !a.fadeOut && !a.startOffset && !a.echo && !(a.filters ?? []).length);
/** 再生開始位置（フレーム） */
export const startOffsetOf = (c: VoiceClip) => Math.max(0, c.audioFx?.startOffset ?? 0);
/** 左右の大きさ（Rust の pan_gains と同じ） */
export function panGains(pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  return [Math.min(1, 1 - p), Math.min(1, 1 + p)];
}

/** セリフの字幕を「個別に設定」したときの見た目（テキストアイテムと同じ項目。画像にして重ねる） */
export interface SubtitleCustom {
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  transform: Transform;
  look?: Look;
  /** 行の高さ（文字の大きさに対する倍率。既定 1.3） */
  lineHeight?: number;
  /** 文字の間隔（px） */
  letterSpacing?: number;
  /** この幅（px）で折り返す。0 なら折り返さない */
  wrapWidth?: number;
  /** 縦書き */
  vertical?: boolean;
  /** 1 文字ずつ出す間隔（フレーム）。0 なら一度に出す */
  interval?: Frame;
  /** 影の色（空ならなし）と、ずらす量（px） */
  shadowColor?: string;
  shadowOffset?: number;
  /** 背景の帯の色（空ならなし。#RRGGBBAA も可）と、文字の周りの余白（px） */
  boxColor?: string;
  boxPadding?: number;
  /** 下へ向かうグラデーションの色（上は color。空か無しならなし） */
  gradientColor?: string;
  /** 外側の縁（内側の縁の外にもう 1 本） */
  outline2Color?: string;
  outline2Width?: number;
}

/** セリフの間だけの立ち絵の変え方 */
export interface LinePortrait {
  /** PSD のレイヤーの表示（id → 表示するか）。表情の表示の上に当てる */
  visibility?: Record<string, boolean>;
  /** 目パチしない（目を開けたまま） */
  noBlink?: boolean;
  /** 口パクしない（口を閉じたまま） */
  noMouth?: boolean;
  /** このセリフの間、立ち絵に掛けるエフェクト */
  effects?: Effect[];
}

export const isPlainLinePortrait = (lp: LinePortrait | null | undefined) => !lp || (!Object.keys(lp.visibility ?? {}).length && !lp.noBlink && !lp.noMouth && !(lp.effects ?? []).length);

/** VOICEVOX のモーラ（1 音） */
export interface Mora {
  text: string;
  consonant?: string | null;
  consonant_length?: number | null;
  vowel: string;
  vowel_length: number;
  pitch: number;
}
/** VOICEVOX のアクセント句 */
export interface AccentPhrase {
  moras: Mora[];
  accent: number;
  pause_mora?: Mora | null;
  is_interrogative?: boolean;
}
export interface AccentEdit {
  /** 作ったときの文（辞書を当てた後） */
  text: string;
  speaker: string;
  phrases: AccentPhrase[];
}

export interface MediaClip extends ClipBase {
  type: 'media';
  src: string;
  mediaKind: 'image' | 'video' | 'audio';
  /** 動画に音声が入っているか */
  hasAudio: boolean;
  inPoint: Frame;
  volume: number;
  transform: Transform;
  /** 回転・アニメーション・フェード・映像エフェクト */
  look?: Look;
  /** 音を鳴らす長さ（頭から数えたフレーム）。切り替えで映像だけを延ばしたときに付く。保存しない */
  audioUntil?: Frame;
  // ── 素材そのものへの加工（Rust の SourceFx と同じ）──
  /** 速さ（1 が等速）。speedTo があれば頭の速さ */
  speed?: number;
  /** 終わりの速さ（だんだん速く・遅く） */
  speedTo?: number;
  /** 逆再生 */
  reverse?: boolean;
  /** 静止（inPoint のコマを出し続ける。音は出さない） */
  freeze?: boolean;
  /** 切り抜き（それぞれの辺から削る、幅・高さに対する割合 0〜1） */
  crop?: Crop;
  /** 形で切り抜く（マスク） */
  mask?: Mask;
  /** 色を抜く（クロマキー） */
  chroma?: Chroma;
  /** 背景をぼかして埋める（画面いっぱいに広げてぼかした同じ素材を後ろに敷く。値はぼかしの強さ px） */
  fillBlur?: number;
  /** 音の加工（雑音を減らす・声を変える・音量をそろえる） */
  audioFx?: MediaAudioFx;
  /** 手ぶれ補正（動画） */
  stabilize?: boolean;
  /** 背景を消す（人物などを切り抜く）。使うモデルの id。型は先に作っておく */
  matte?: string;
  /** なめらかスロー：遅くしたとき、間のコマを動きから作る（書き出しのみ。画面はコマをくり返す） */
  smooth?: boolean;
  /** 音のフェードイン・フェードアウト（フレーム。音声素材と、音の入った動画） */
  soundFadeIn?: Frame;
  soundFadeOut?: Frame;
  /** 同じレイヤーのすぐ前の音声素材と、この長さ（フレーム）だけ重ねてなめらかにつなぐ（クロスフェード） */
  crossfade?: Frame;
}

/** 効果音集（Rust の sfx::SFX と同じ名前と順） */
export const SFX_LIST: {id: string; label: string}[] = [
  {id: 'pop', label: 'ポン'},
  {id: 'ding', label: 'ピコン'},
  {id: 'whoosh', label: 'シュッ'},
  {id: 'boom', label: 'ドン'},
  {id: 'sparkle', label: 'キラーン'},
  {id: 'buzzer', label: 'ブブー'},
  {id: 'click', label: 'カチッ'},
  {id: 'chime', label: 'ピンポーン'},
  {id: 'stinger', label: 'ジャーン'},
  {id: 'shock', label: 'ガーン'},
];

/** プレビューに使うプロキシの名前（手ぶれ補正したものは別） */
/** 背景を消す型を覚えておく場所（store の proxies）のキー */
export const matteKey = (src: string, model: string) => `${src}#matte:${model}`;

export const proxyKey = (m: {src: string; stabilize?: boolean}) => (m.stabilize ? `${m.src}#stab` : m.src);

export type VoiceFx = 'high' | 'low' | 'robot' | 'radio' | 'echo' | 'megaphone';
/** 素材の音の加工（Rust の audiofx::MediaAudioFx と同じ） */
export interface MediaAudioFx {
  denoise?: boolean;
  voice?: VoiceFx;
  /** 音量をそろえるための増減（dB）。「音量を均一に」で素材を測って決める */
  gainDb?: number;
}
export const hasAudioFx = (m: MediaClip) => !!m.audioFx && (!!m.audioFx.denoise || !!m.audioFx.voice || Math.abs(m.audioFx.gainDb ?? 0) > 1e-6);

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** 形の切り抜き。位置・大きさは（切り抜いた後の）素材の幅・高さに対する割合 */
export interface Mask {
  shape: 'rect' | 'ellipse';
  /** 中心のずれ（-0.5〜0.5） */
  x: number;
  y: number;
  /** 幅・高さ（0〜1） */
  w: number;
  h: number;
  /** 四角の角の丸み（0〜0.5） */
  radius: number;
  /** ぼかし（0〜0.5。短い辺に対する割合） */
  feather: number;
  /** 外側を残す */
  invert: boolean;
}
/** 色を抜く。similarity が大きいほど近い色まで抜き、blend が大きいほど境目がなだらか */
export interface Chroma {
  color: string;
  similarity: number;
  blend: number;
}

/** 色を抜く係数（書き出しの render.rs の chroma_weights と同じ）。抜く色らしさ = wr·R + wg·G + wb·B（0〜1） */
export function chromaWeights(color: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const c = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const mean = (c[0] + c[1] + c[2]) / 3;
  const d = c.map(v => v - mean);
  const n = d.reduce((a, v) => a + v * v, 0);
  if (n < 1e-3) return null;
  return [d[0] / n, d[1] / n, d[2] / n];
}

/** 形の内側がマイナスになる、縁からの距離（px）。W・H は切り抜いた後の大きさ（書き出しの spatial_filters と同じ式） */
export function maskDistance(mk: Mask, X: number, Y: number, W: number, H: number): number {
  const w = Math.min(2, Math.max(0.01, mk.w));
  const h = Math.min(2, Math.max(0.01, mk.h));
  const cx = W * (0.5 + mk.x);
  const cy = H * (0.5 + mk.y);
  const hw = (W * w) / 2;
  const hh = (H * h) / 2;
  const mn = Math.min(hw, hh);
  if (mk.shape === 'ellipse') return (Math.hypot((X - cx) / hw, (Y - cy) / hh) - 1) * mn;
  const r = mn * Math.min(1, Math.min(0.5, Math.max(0, mk.radius)) * 2);
  const qx = Math.abs(X - cx) - hw + r;
  const qy = Math.abs(Y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 形の切り抜きの不透明度（0〜1） */
export function maskAlpha(mk: Mask, X: number, Y: number, W: number, H: number): number {
  const sd = maskDistance(mk, X, Y, W, H);
  const f = Math.min(0.5, Math.max(0, mk.feather));
  const a = f > 1e-6 ? Math.min(1, Math.max(0, 0.5 - sd / (Math.min(W, H) * f))) : sd <= 0 ? 1 : 0;
  return mk.invert ? 1 - a : a;
}

/** 切り抜いた後の大きさの割合 */
export function cropKeep(c: Crop | undefined): [number, number, number, number] {
  if (!c) return [0, 0, 1, 1];
  const l = Math.min(0.95, Math.max(0, c.left));
  const t = Math.min(0.95, Math.max(0, c.top));
  const w = Math.max(0.05, 1 - l - Math.min(0.95, Math.max(0, c.right)));
  const h = Math.max(0.05, 1 - t - Math.min(0.95, Math.max(0, c.bottom)));
  return [l, t, w, h];
}

// ───────────── 速さ・逆再生・静止（書き出しの render.rs の source_filters と同じ対応） ─────────────

/** 頭と終わりの速さ */
export function speedsOf(m: MediaClip): [number, number] {
  const a = Math.max(0.05, m.speed ?? 1);
  return [a, Math.max(0.05, m.speedTo ?? a)];
}

/** クリップの頭から t フレーム進んだとき、元の素材で進むフレーム（速さを積分）。d はクリップの長さ */
export function srcAdvance(m: MediaClip, t: number, d = m.duration): number {
  if (m.freeze) return 0;
  const [a, b] = speedsOf(m);
  return a * t + ((b - a) * t * t) / (2 * Math.max(1e-9, d));
}

/** 元の素材で使う長さ（フレーム） */
export const srcSpan = (m: MediaClip) => srcAdvance(m, m.duration);

/** クリップの頭から t フレーム目に出す、元の素材のフレーム */
export function srcFrameAt(m: MediaClip, t: number): number {
  return m.reverse ? m.inPoint + srcSpan(m) - srcAdvance(m, t) : m.inPoint + srcAdvance(m, t);
}

/** その時点の速さ（静止は 0、逆再生は負） */
export function speedAt(m: MediaClip, t: number): number {
  if (m.freeze) return 0;
  const [a, b] = speedsOf(m);
  const v = a + ((b - a) * t) / Math.max(1e-9, m.duration);
  return m.reverse ? -v : v;
}

/** 素材の t 秒目が、タイムラインの何フレーム目に出るか（速さ・逆再生も考える。範囲の外なら null） */
export function timelineFrameOf(m: MediaClip, srcSec: number, fps: number): number | null {
  const target = srcSec * fps;
  // 素材の位置はクリップの中で単調に動くので、二分探索で探す
  let lo = 0;
  let hi = m.duration;
  const f = (t: number) => srcFrameAt(m, t);
  const up = f(m.duration) >= f(0);
  if (Math.min(f(0), f(m.duration)) > target + 0.5 || Math.max(f(0), f(m.duration)) < target - 0.5) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target === up) lo = mid;
    else hi = mid;
  }
  return Math.round(m.start + lo);
}

export const isRetimed = (m: MediaClip) => !!m.freeze || !!m.reverse || speedsOf(m).some(v => Math.abs(v - 1) > 1e-9);

/**
 * 出す範囲を [start, start+duration) に変えた素材（端を詰める・延ばす・分ける）。
 * 同じ時刻には同じ素材のコマが出るよう、切り出し位置と速さ（だんだん変わるときは頭と終わり）を合わせる
 */
export function retime<T extends MediaClip>(m: T, start: number, duration: number): T {
  const ds = start - m.start;
  const [a, b] = speedsOf(m);
  const ramp = Math.abs(a - b) > 1e-9;
  const at = (t: number) => Math.max(0.05, a + ((b - a) * t) / Math.max(1e-9, m.duration));
  const next: T = {...m, start, duration};
  if (ramp) {
    next.speed = at(ds);
    next.speedTo = at(ds + duration);
  }
  if (!m.freeze) next.inPoint = Math.max(0, m.reverse ? m.inPoint + srcSpan(m) - srcAdvance(m, ds + duration) : m.inPoint + srcAdvance(m, ds));
  return next;
}

/** 速さを変える。使う素材の長さはそのままで、クリップの長さが変わる */
export function withSpeed<T extends MediaClip>(m: T, speed: number, speedTo?: number): T {
  const span = srcSpan({...m, freeze: false});
  const a = Math.max(0.05, speed);
  const b = speedTo === undefined ? a : Math.max(0.05, speedTo);
  const duration = Math.max(1, Math.round(span / ((a + b) / 2)));
  return {...m, speed: a === 1 && b === 1 ? undefined : a, speedTo: speedTo === undefined || Math.abs(a - b) < 1e-9 ? undefined : b, duration};
}

/** 見た目の動きと効果（画像・動画・テキスト・図形で共通。Rust の Look と同じ） */
export interface Look {
  /** 回転（度、時計回り） */
  rotation: number;
  /** アイテムの終わりでの値。始まりは transform・rotation */
  anim?: Anim | null;
  /** 出てくるとき・消えるときのフェード（フレーム） */
  fadeIn: Frame;
  fadeOut: Frame;
  effects?: Effect[];
  /** 登場のしかた（アイテムの頭で、画面の外から滑り込む・大きくなって出る） */
  enter?: Motion | null;
  /** 退場のしかた（アイテムの終わりで、画面の外へ出ていく・小さくなって消える） */
  exit?: Motion | null;
  /** 同じレイヤーのすぐ前のアイテムとのつなぎ目に入れる切り替え（場面転換） */
  transition?: Transition | null;
  /** 合成モード（下の絵との重ね方）。なしはふつうに重ねる */
  blend?: BlendMode | null;
  /** 左右反転・上下反転（エフェクトより前に、素材そのものを裏返す） */
  flipX?: boolean;
  flipY?: boolean;
  /** 画面の横・縦の倍率（大きさに掛ける。回したあとに掛ける。なしは 1・1） */
  stretch?: [number, number] | null;
  /** 回転・拡大の中心（アイテムの真ん中からのずれ。元の大きさの px）。位置はこの点の位置になる */
  pivot?: [number, number] | null;
  /** 3D 回転（X 軸・Y 軸の度）。アニメーションの終わりの値は anim.rot3d */
  rot3d?: [number, number] | null;
}

/** 合成モード（画面は canvas の合成、書き出しは ffmpeg の blend。同じ式） */
export type BlendMode = 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'hardLight' | 'difference' | 'add';
export const BLEND_MODES: {value: BlendMode; label: string}[] = [
  {value: 'multiply', label: '乗算'},
  {value: 'screen', label: 'スクリーン'},
  {value: 'overlay', label: 'オーバーレイ'},
  {value: 'hardLight', label: 'ハードライト'},
  {value: 'darken', label: '比較（暗）'},
  {value: 'lighten', label: '比較（明）'},
  {value: 'difference', label: '差の絶対値'},
  {value: 'add', label: '加算'},
];
/** canvas の globalCompositeOperation */
export const BLEND_CANVAS: Record<BlendMode, GlobalCompositeOperation> = {
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  hardLight: 'hard-light',
  darken: 'darken',
  lighten: 'lighten',
  difference: 'difference',
  add: 'lighter',
};
/** つなぎ目の切り替え。slide は「前の場面がその方向へ流れ、次の場面が反対側から入る」 */
export type TransitionKind = 'dissolve' | 'black' | 'white' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown' | 'zoom';
export interface Transition {
  kind: TransitionKind;
  /** 全体の長さ（フレーム） */
  frames: Frame;
}
/** 登場・退場の動き。slide は「その方向から入る／その方向へ出る」 */
/** wipe はクリッピング解除（ワイプ）：登場は「その向きへ広がって現れる」、退場は「その向きへ消えていく」 */
export type MotionKind = 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown' | 'zoom' | 'wipeRight' | 'wipeLeft' | 'wipeDown' | 'wipeUp';
export interface Motion {
  kind: MotionKind;
  /** 掛ける長さ（フレーム） */
  frames: Frame;
  /** なめらかに動く（ゆっくり出て、ゆっくり止まる）。切り替えの「流す」で、前と次の場面がくっついて動くように */
  smooth?: boolean;
}
export interface Anim {
  to: Transform;
  rotation: number;
  ease: Ease;
  /** 途中の状態（始まり → 途中 → 終わりの順に動く。区間ごとに ease を掛ける） */
  mid?: AnimMid | null;
  /** そのほかの途中の状態（キーフレーム。何点でも） */
  keys?: AnimMid[];
  /** 終わりの 3D 回転（なしは始まりと同じ。途中の状態は通らず、始まりから終わりへ ease で動く） */
  rot3d?: [number, number] | null;
}
export interface AnimMid {
  /** 通る時点（アイテムの長さに対する割合 0〜1） */
  at: number;
  transform: Transform;
  rotation: number;
}
export type Ease = 'linear' | 'in' | 'out' | 'inOut';

// ───────────── キーフレーム（書き出しの render.rs の Anim::waypoints・tween3 と同じ） ─────────────

/** 途中の状態をすべて、通る順に（mid と keys。近すぎるものは 1 つに） */
export function animKeys(an: Anim | null | undefined): AnimMid[] {
  if (!an) return [];
  const v = [...(an.mid ? [an.mid] : []), ...(an.keys ?? [])].map(k => ({...k, at: Math.min(0.999, Math.max(0.001, k.at))})).sort((a, b) => a.at - b.at);
  return v.filter((k, i) => i === 0 || Math.abs(k.at - v[i - 1].at) >= 1e-6);
}

export function easeValue(e: Ease, p: number): number {
  const q = Math.min(1, Math.max(0, p));
  if (e === 'in') return q * q;
  if (e === 'out') return 1 - (1 - q) * (1 - q);
  if (e === 'inOut') return q < 0.5 ? 2 * q * q : 1 - 2 * (1 - q) * (1 - q);
  return q;
}

/** アニメーションのその時点（p はアイテムの長さに対する割合）の置き方と回転（登場・退場・フェードは含まない） */
export function animStateAt(t: Transform, look: Look | undefined, p: number): {transform: Transform; rotation: number} {
  const an = look?.anim;
  const r0 = look?.rotation ?? 0;
  const c01 = (v: number) => Math.min(1, Math.max(0, v));
  if (!an) return {transform: {...t, opacity: c01(t.opacity)}, rotation: r0};
  const pts = [{at: 0, transform: t, rotation: r0}, ...animKeys(an), {at: 1, transform: an.to, rotation: an.rotation}];
  const q = Math.min(1, Math.max(0, p));
  let i = pts.findIndex((k, j) => j > 0 && q < k.at) - 1;
  if (i < 0) i = pts.length - 2;
  const [a, b] = [pts[i], pts[i + 1]];
  const k = easeValue(an.ease, (q - a.at) / Math.max(1e-6, b.at - a.at));
  const mix = (x: number, y: number) => x + (y - x) * k;
  return {
    transform: {
      x: mix(a.transform.x, b.transform.x),
      y: mix(a.transform.y, b.transform.y),
      scale: mix(a.transform.scale, b.transform.scale),
      opacity: mix(c01(a.transform.opacity), c01(b.transform.opacity)),
    },
    rotation: mix(a.rotation, b.rotation),
  };
}

/** キーフレームのある時点（割合。頭 0・終わり 1 を含む）。アニメーションがなければ空 */
export function keyframeTimes(look: Look | undefined): number[] {
  return look?.anim ? [0, ...animKeys(look.anim).map(k => k.at), 1] : [];
}

/** 頭・終わりとみなす近さ（割合） */
const KEY_SNAP = 0.004;

/**
 * その時点（割合）のキーフレームを、置き方 tr・回転 rot にする（なければ足す）。アニメーションがなければ、
 * 今の見た目のまま動かないアニメーションを作ってから足す（CapCut の「キーフレームを追加」と同じ）
 */
export function setKeyframe<T extends {transform: Transform; look?: Look}>(c: T, p: number, tr: Transform, rot: number): T {
  const look: Look = {...plainLook(), ...c.look};
  const an: Anim = look.anim ? {...look.anim} : {to: {...c.transform}, rotation: look.rotation, ease: 'linear'};
  if (p <= KEY_SNAP) return {...c, transform: {...tr}, look: {...look, anim: an, rotation: rot}};
  if (p >= 1 - KEY_SNAP) return {...c, look: {...look, anim: {...an, to: {...tr}, rotation: rot}}};
  const key: AnimMid = {at: p, transform: {...tr}, rotation: rot};
  const near = (k: AnimMid) => Math.abs(k.at - p) <= KEY_SNAP;
  let mid = an.mid ?? null;
  let keys = [...(an.keys ?? [])];
  if (mid && near(mid)) mid = {...key, at: mid.at};
  else {
    const i = keys.findIndex(near);
    if (i >= 0) keys[i] = {...key, at: keys[i].at};
    else keys = [...keys, key].sort((a, b) => a.at - b.at);
  }
  return {...c, look: {...look, anim: {...an, mid, keys}}};
}

/**
 * 自動で位置合わせ（CapCut の自動リフレーム）：素材を画面いっぱいに広げ、被写体（pts の重心。素材の t 秒目に 0〜1 の位置）が
 * 真ん中に来るように位置を決める。動画は時刻ごとのキーフレームにする（ゆっくり追う。画面の外の黒は出さない）
 */
export function reframeClip(m: MediaClip, pts: {t: number; x: number; y: number}[], size: [number, number], canvas: [number, number], fps: number): MediaClip {
  const [sw, sh] = size;
  const [W, H] = canvas;
  const s = Math.max(W / sw, H / sh);
  const lim = [(sw * s - W) / 2, (sh * s - H) / 2];
  const clamp = (v: number, l: number) => Math.round(Math.max(-l, Math.min(l, v)));
  const at = (cx: number, cy: number): Transform => ({x: clamp(-(cx - 0.5) * sw * s, lim[0]), y: clamp(-(cy - 0.5) * sh * s, lim[1]), scale: s, opacity: m.transform.opacity});
  const base = {...m, look: {...plainLook(), ...m.look, anim: null}};
  if (!pts.length) return {...base, transform: at(0.5, 0.5)};
  if (m.mediaKind === 'image') return {...base, transform: at(pts[0].x, pts[0].y)};
  // クリップの中に出る時刻だけを、出る順に
  const seq = pts
    .map(p => ({f: timelineFrameOf(m, p.t, fps), x: p.x, y: p.y}))
    .filter((p): p is {f: number; x: number; y: number} => p.f !== null)
    .map(p => ({...p, at: (p.f - m.start) / Math.max(1, m.duration)}))
    .filter(p => p.at >= 0 && p.at <= 1)
    .sort((a, b) => a.at - b.at);
  if (!seq.length) return {...base, transform: at(0.5, 0.5)};
  // 細かい揺れを均す（前後 2 つずつの平均）
  const sm = seq.map((p, i) => {
    const w = seq.slice(Math.max(0, i - 2), i + 3);
    return {at: p.at, x: w.reduce((a, q) => a + q.x, 0) / w.length, y: w.reduce((a, q) => a + q.y, 0) / w.length};
  });
  const first = at(sm[0].x, sm[0].y);
  const last = at(sm[sm.length - 1].x, sm[sm.length - 1].y);
  // 途中は 0.5 秒ごとくらいに間引く
  const gap = (fps * 0.5) / Math.max(1, m.duration);
  const keys: AnimMid[] = [];
  let prev = 0;
  for (const p of sm.slice(1, -1)) {
    if (p.at - prev < gap || p.at > 1 - gap / 2) continue;
    keys.push({at: p.at, transform: at(p.x, p.y), rotation: base.look.rotation});
    prev = p.at;
  }
  const moves = keys.some(k => k.transform.x !== first.x || k.transform.y !== first.y) || last.x !== first.x || last.y !== first.y;
  if (!moves) return {...base, transform: first};
  return {...base, transform: first, look: {...base.look, anim: {to: last, rotation: base.look.rotation, ease: 'linear', keys}}};
}

/** 分割画面の並べ方。マスの位置と大きさは画面に対する割合 [左, 上, 幅, 高さ] */
export const SPLIT_LAYOUTS: {id: string; label: string; cells: [number, number, number, number][]}[] = [
  {
    id: 'lr',
    label: '左右 2 分割',
    cells: [
      [0, 0, 0.5, 1],
      [0.5, 0, 0.5, 1],
    ],
  },
  {
    id: 'tb',
    label: '上下 2 分割',
    cells: [
      [0, 0, 1, 0.5],
      [0, 0.5, 1, 0.5],
    ],
  },
  {
    id: 'l1r2',
    label: '左 1・右 2',
    cells: [
      [0, 0, 0.5, 1],
      [0.5, 0, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ],
  },
  {
    id: 'h3',
    label: '横に 3 つ',
    cells: [
      [0, 0, 1 / 3, 1],
      [1 / 3, 0, 1 / 3, 1],
      [2 / 3, 0, 1 / 3, 1],
    ],
  },
  {
    id: 'v3',
    label: '縦に 3 つ',
    cells: [
      [0, 0, 1, 1 / 3],
      [0, 1 / 3, 1, 1 / 3],
      [0, 2 / 3, 1, 1 / 3],
    ],
  },
  {
    id: 'g4',
    label: '2×2',
    cells: [
      [0, 0, 0.5, 0.5],
      [0.5, 0, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ],
  },
];

/**
 * 素材をマスいっぱいに置く（はみ出すところは切り抜く。真ん中を残す）。gap はマスの間のすき間（px）。
 * 動き（キーフレーム）は外す
 */
export function fitToCell(m: MediaClip, size: [number, number], cell: [number, number, number, number], canvas: [number, number], gap = 0): MediaClip {
  const [W, H] = canvas;
  const [sw, sh] = size;
  const cw = Math.max(2, cell[2] * W - gap);
  const ch = Math.max(2, cell[3] * H - gap);
  const s = Math.max(cw / sw, ch / sh);
  const ox = Math.max(0, 1 - cw / (sw * s)) / 2;
  const oy = Math.max(0, 1 - ch / (sh * s)) / 2;
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return {
    ...m,
    crop: ox > 1e-4 || oy > 1e-4 ? {left: r(ox), right: r(ox), top: r(oy), bottom: r(oy)} : undefined,
    mask: undefined,
    transform: {x: Math.round((cell[0] + cell[2] / 2) * W - W / 2), y: Math.round((cell[1] + cell[3] / 2) * H - H / 2), scale: Math.round(s * 10000) / 10000, opacity: m.transform.opacity},
    look: {...plainLook(), ...m.look, anim: null},
  };
}

/** 動画の素材の位置（0〜1）が、画面のどこ（transform と同じ、真ん中からの px）に出るか。動画の始まりの置き方で計算する */
export function sourceToCanvas(video: MediaClip, size: [number, number], u: number, v: number): [number, number] {
  const s = video.transform.scale;
  return [video.transform.x + (u - 0.5) * size[0] * s, video.transform.y + (v - 0.5) * size[1] * s];
}
export function canvasToSource(video: MediaClip, size: [number, number], x: number, y: number): [number, number] {
  const s = Math.max(1e-6, video.transform.scale);
  return [(x - video.transform.x) / (size[0] * s) + 0.5, (y - video.transform.y) / (size[1] * s) + 0.5];
}

/**
 * モーショントラッキング：追った点（素材の t 秒目に 0〜1 の位置）に、アイテムを付いて動かす（始まりのずれを保つ）。
 * 位置だけをキーフレームにする（大きさ・不透明度・回転は今のまま）。ほぼまっすぐ動くところのキーフレームは省く
 */
export function followTrack<T extends VisualClip>(item: T, video: MediaClip, pts: {t: number; x: number; y: number}[], size: [number, number], fps: number): T {
  const seq = pts
    .map(p => ({f: timelineFrameOf(video, p.t, fps), pos: sourceToCanvas(video, size, p.x, p.y)}))
    .filter((p): p is {f: number; pos: [number, number]} => p.f !== null)
    .map(p => ({at: (p.f - item.start) / Math.max(1, item.duration), pos: p.pos}))
    .filter(p => p.at >= -1e-6 && p.at <= 1 + 1e-6)
    .sort((a, b) => a.at - b.at);
  if (seq.length < 2) return item;
  const dx = item.transform.x - seq[0].pos[0];
  const dy = item.transform.y - seq[0].pos[1];
  const look: Look = {...plainLook(), ...item.look};
  const tr = (p: {pos: [number, number]}): Transform => ({...item.transform, x: Math.round((p.pos[0] + dx) * 10) / 10, y: Math.round((p.pos[1] + dy) * 10) / 10});
  // 間引く：前に残した点と次の点を結ぶ線から 1.5px 以上ずれる点だけ残す
  const kept = [seq[0]];
  for (let i = 1; i < seq.length - 1; i++) {
    const a = kept[kept.length - 1];
    const b = seq[i + 1];
    const k = (seq[i].at - a.at) / Math.max(1e-9, b.at - a.at);
    const ex = a.pos[0] + (b.pos[0] - a.pos[0]) * k;
    const ey = a.pos[1] + (b.pos[1] - a.pos[1]) * k;
    if (Math.hypot(seq[i].pos[0] - ex, seq[i].pos[1] - ey) > 1.5) kept.push(seq[i]);
  }
  const last = seq[seq.length - 1];
  // 追った区間がアイテムより短いときは、終わりでその場に留まる
  const keys: AnimMid[] = kept.slice(1).map(p => ({at: Math.min(1, Math.max(0, p.at)), transform: tr(p), rotation: look.rotation}));
  if (last.at < 1 - 1e-6) keys.push({at: last.at, transform: tr(last), rotation: look.rotation});
  const anim: Anim = {to: tr(last), rotation: look.rotation, ease: 'linear', keys: keys.filter(k => k.at > 1e-6 && k.at < 1 - 1e-6)};
  return {...item, transform: tr(seq[0]), look: {...look, anim}};
}

/** その時点（割合）の途中のキーフレームを消す。頭・終わりは消さない */
export function removeKeyframe<T extends {look?: Look}>(c: T, p: number): T {
  const an = c.look?.anim;
  if (!an) return c;
  const near = (k: AnimMid) => Math.abs(k.at - p) <= KEY_SNAP;
  return {...c, look: {...c.look!, anim: {...an, mid: an.mid && near(an.mid) ? null : an.mid, keys: (an.keys ?? []).filter(k => !near(k))}}};
}
export type Effect =
  | {kind: 'blur'; radius: number}
  | {kind: 'shake'; amount: number; speed: number}
  | {kind: 'color'; brightness: number; contrast: number; saturation: number}
  | {kind: 'mono'}
  | {kind: 'invert'}
  | {kind: 'wave'; amount: number; length: number; speed: number}
  | {kind: 'swirl'; angle: number}
  /** フィルター（色の雰囲気。name は GRADES の名前、strength は 0〜1） */
  | {kind: 'grade'; name: string; strength: number}
  /** 色温度（warm：-1 で青く 〜 1 で黄色く）と色合い（tint：-1 で緑 〜 1 で赤紫） */
  | {kind: 'temperature'; warm: number; tint: number}
  /** LUT（.cube のファイル）。書き出しはそのまま、画面は近い色。strength は 0〜1 */
  | {kind: 'lut'; path: string; strength: number}
  /** 縁取り（色・太さ px） */
  | {kind: 'outline'; color: string; width: number}
  /** ドロップシャドウ（色・ぼかし px・ずれ px・濃さ 0〜1） */
  | {kind: 'shadow'; color: string; blur: number; x: number; y: number; opacity: number}
  /** 発光（色・広がり px・重ねる回数 1〜5） */
  | {kind: 'glow'; color: string; blur: number; strength: number}
  /** 点滅（1 秒あたりの回数） */
  | {kind: 'blink'; speed: number}
  /** 残像（数・間隔フレーム） */
  | {kind: 'trail'; count: number; interval: number}
  /** 色ずれ（赤を右・青を左へずらす px） */
  | {kind: 'rgbShift'; amount: number}
  /** グリッチ（横のずれ px・帯の高さ px・1 秒あたりに変わる回数） */
  | {kind: 'glitch'; amount: number; band: number; speed: number}
  /** ノイズ（強さ 0〜1） */
  | {kind: 'noise'; amount: number}
  /** 放射ブラー（強さ 0〜0.9） */
  | {kind: 'radialBlur'; amount: number}
  /** 方向ブラー（長さ px・角度） */
  | {kind: 'dirBlur'; length: number; angle: number}
  /** 二値化（しきい値 0〜1） */
  | {kind: 'threshold'; level: number}
  /** ランダム移動（振れ幅 px・1 秒あたりに跳ぶ回数） */
  | {kind: 'jitter'; amount: number; speed: number}
  /** 反復移動（横・縦の振れ幅 px・1 秒あたりの往復の回数） */
  | {kind: 'oscillate'; x: number; y: number; speed: number}
  /** プラグインのエフェクト（書き出しの FFmpeg のフィルターと画面の Canvas の filter の式。{名前} に values の数を入れる） */
  | {kind: 'plugin'; name: string; ffmpeg: string; canvas: string; values: Record<string, number>; params?: PluginParam[]};

/** プラグインのファイル（core/src/plugin.rs と同じ形） */
export interface Plugin {
  name: string;
  effects: PluginEffect[];
}
export interface PluginEffect {
  id: string;
  label: string;
  params: PluginParam[];
  ffmpeg: string;
  canvas: string;
}
export interface PluginParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

/** {名前} に数を入れる。; [ ] があるか入れ残しがあれば null（core/src/plugin.rs の fill と同じ） */
export function fillTemplate(template: string, values: Record<string, number>): string | null {
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    const r = Math.round(v * 1e6) / 1e6;
    out = out.split(`{${k}}`).join(String(r));
  }
  if (!out.trim() || /[{};[\]]/.test(out)) return null;
  return out;
}

/** プラグインのエフェクトを、プロジェクトに入れる形にする（つまみは最初の値で） */
export const pluginEffect = (pl: Plugin, e: PluginEffect): Effect => ({
  kind: 'plugin',
  name: `${pl.name}：${e.label}`,
  ffmpeg: e.ffmpeg,
  canvas: e.canvas ?? '',
  values: Object.fromEntries((e.params ?? []).map(p => [p.key, p.default])),
  params: e.params ?? [],
});

/** 決まった乱数（0〜1）。書き出しの model.rs の hash01 と同じ式 */
export function hash01(a: number, b: number): number {
  const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return v - Math.floor(v);
}
/** ランダム移動のずれ（アイテムの頭からの秒 t で。model.rs の jitter_at と同じ） */
export function jitterAt(amount: number, speed: number, t: number): [number, number] {
  const n = Math.floor(t * speed);
  return [amount * (hash01(n, 1) * 2 - 1), amount * (hash01(n, 2) * 2 - 1)];
}

/**
 * フィルターの中身：色の混ぜ方（3×3、行ごとに R・G・B の出どころ）と、色ごとの明るさの曲線（倍率・指数・足す量）。
 * 書き出しの model.rs の grade_table と同じ数
 */
type Gamma = [number, number, number];
const ID_G: Gamma = [1, 1, 0];
export const GRADES: Record<string, {label: string; m: number[]; g: [Gamma, Gamma, Gamma]}> = {
  vivid: {
    label: 'ビビッド',
    m: [1.2755, -0.2503, -0.0252, -0.0746, 1.0998, -0.0252, -0.0746, -0.2503, 1.3248],
    g: [
      [1.06, 1.1, -0.03],
      [1.06, 1.1, -0.03],
      [1.06, 1.1, -0.03],
    ],
  },
  warm: {label: 'あたたか', m: [1.1225, -0.0386, -0.0039, -0.0107, 1.0143, -0.0036, -0.0092, -0.0307, 0.8999], g: [ID_G, ID_G, ID_G]},
  cool: {label: 'クール', m: [0.8646, 0.0322, 0.0032, 0.0104, 0.966, 0.0035, 0.0119, 0.04, 1.068], g: [ID_G, ID_G, ID_G]},
  sepia: {label: 'セピア', m: [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131], g: [ID_G, ID_G, ID_G]},
  vintage: {
    label: 'ビンテージ',
    m: [0.6662, 0.423, 0.104, 0.192, 0.8273, 0.0924, 0.1496, 0.2937, 0.522],
    g: [
      [0.85, 0.95, 0.08],
      [0.85, 0.95, 0.08],
      [0.8, 1, 0.1],
    ],
  },
  film: {
    label: 'フィルム',
    m: [0.8927, 0.1338, 0.0135, 0.0376, 0.9297, 0.0127, 0.036, 0.121, 0.783],
    g: [
      [0.94, 1.05, 0.05],
      [0.94, 1.05, 0.04],
      [0.92, 1, 0.06],
    ],
  },
  noir: {
    label: 'ノワール',
    m: [0.213, 0.715, 0.072, 0.213, 0.715, 0.072, 0.213, 0.715, 0.072],
    g: [
      [1.15, 1.25, -0.05],
      [1.15, 1.25, -0.05],
      [1.15, 1.25, -0.05],
    ],
  },
  dream: {
    label: 'ふんわり',
    m: [0.882, 0.1072, 0.0108, 0.032, 0.9572, 0.0108, 0.032, 0.1072, 0.8608],
    g: [
      [0.82, 0.8, 0.15],
      [0.82, 0.8, 0.15],
      [0.82, 0.8, 0.15],
    ],
  },
  night: {
    label: '夜',
    m: [0.6572, 0.1115, 0.0112, 0.0375, 0.8298, 0.0127, 0.0477, 0.1602, 0.9121],
    g: [
      [0.9, 1.25, 0],
      [0.9, 1.25, 0],
      [0.9, 1.25, 0],
    ],
  },
};

/** フィルター（強さを掛けた後）・色温度の、色の混ぜ方と曲線（書き出しの color_grade と同じ） */
export function colorGrade(fx: Effect): {m: number[]; g: [Gamma, Gamma, Gamma]} | null {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (fx.kind === 'grade') {
    const t = GRADES[fx.name];
    if (!t) return null;
    const s = c(fx.strength, 0, 1);
    return {m: I.map((v, i) => v + (t.m[i] - v) * s), g: t.g.map(([a, e, o]) => [1 + (a - 1) * s, 1 + (e - 1) * s, o * s]) as [Gamma, Gamma, Gamma]};
  }
  if (fx.kind === 'temperature') {
    const w = c(fx.warm, -1, 1);
    const t = c(fx.tint, -1, 1);
    return {m: [1 + 0.18 * w, 0, 0, 0, 1 - 0.12 * t, 0, 0, 0, 1 - 0.18 * w], g: [ID_G, ID_G, ID_G]};
  }
  return null;
}

export const plainLook = (): Look => ({rotation: 0, anim: null, fadeIn: 0, fadeOut: 0, effects: []});

/** テキストアイテム（字幕とは別に、好きな位置・装飾で文字を出す） */
export interface TextClip extends ClipBase {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  transform: Transform;
  look?: Look;
  // 文字の飾り（書いていなければ無し。Rust の TextDeco と同じ）
  /** 影・光（ぼかした影）の色 */
  shadowColor?: string;
  shadowBlur?: number;
  shadowX?: number;
  shadowY?: number;
  /** 外側の縁（内側の縁の外にもう 1 本） */
  outline2Color?: string;
  outline2Width?: number;
  /** 文字の後ろの帯 */
  boxColor?: string;
  boxOpacity?: number;
  boxPadding?: number;
  boxRadius?: number;
  /** 下へ向かうグラデーションの色（上は color） */
  gradientColor?: string;
  /** 縦書き */
  vertical?: boolean;
  /** 1 文字ずつ出す（書き出しはコマごとの画像を並べる） */
  charAnim?: CharAnim | null;
  /** タイマー（カウントダウン・カウントアップ）。文の中の {t} が時間になる（なければ文全体） */
  timer?: Timer | null;
}

/** テキストのタイマー（core/src/model.rs の Timer と同じ）。from から to へ実際の速さで数え、to で止まる */
export interface Timer {
  /** 始まりの値（秒） */
  from: number;
  /** 終わりの値（秒）。from より小さければカウントダウン */
  to: number;
  /** s（10）・m:ss（1:05）・h:mm:ss（0:01:05）・m:ss.cc（1:05.30） */
  format: 's' | 'm:ss' | 'h:mm:ss' | 'm:ss.cc';
}

/** 表示が変わる間隔（フレーム）。Rust の Timer::step と同じ */
export const timerStep = (t: Timer, fps: number) => (t.format.endsWith('.cc') ? 1 : Math.max(1, fps));

/** アイテムの頭から local フレームでのタイマーの文字。Rust の Timer::text_at と同じ */
export function timerText(t: Timer, template: string, local: number, fps: number): string {
  const sec = Math.max(0, local) / Math.max(1, fps);
  const down = t.to < t.from;
  const v = down ? Math.max(t.to, t.from - sec) : Math.min(t.to, t.from + sec);
  const cc = t.format.endsWith('.cc');
  const q = v * (cc ? 100 : 1);
  const n = Math.max(0, down ? Math.ceil(q - 1e-6) : Math.floor(q + 1e-6));
  const whole = cc ? Math.floor(n / 100) : n;
  const frac = cc ? n % 100 : 0;
  const p2 = (x: number) => String(x).padStart(2, '0');
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  const body =
    t.format === 's'
      ? String(whole)
      : t.format === 'h:mm:ss'
        ? `${h}:${p2(m)}:${p2(s)}`
        : t.format === 'm:ss.cc'
          ? `${Math.floor(whole / 60)}:${p2(s)}.${p2(frac)}`
          : `${Math.floor(whole / 60)}:${p2(s)}`;
  return template.includes('{t}') ? template.split('{t}').join(body) : body;
}

/** テキストの 1 文字ずつの登場（core/src/model.rs の CharAnim と同じ） */
export interface CharAnim {
  /** type：そのまま出る／fade：ふわっと／pop：はねる／slideUp：下から */
  kind: 'type' | 'fade' | 'pop' | 'slideUp';
  /** 次の文字が出るまでのフレーム */
  interval: number;
  /** 1 文字が出きるまでのフレーム */
  length: number;
}
export const CHAR_ANIM_LABEL: Record<CharAnim['kind'], string> = {type: 'そのまま', fade: 'ふわっと', pop: 'はねる', slideUp: '下から'};
/** 全部の文字が出きるまでのフレーム（model.rs の CharAnim::frames と同じ） */
export const charAnimFrames = (a: CharAnim, n: number) => (Math.max(1, n) - 1) * Math.max(0, a.interval) + Math.max(1, a.length);
/** i 文字目の出かた（0〜1）。f はアイテムの頭からのフレーム */
export function charProgress(a: CharAnim, i: number, f: number): number {
  const p = (f - i * Math.max(0, a.interval)) / Math.max(1, a.length);
  if (a.kind === 'type') return f >= i * Math.max(0, a.interval) ? 1 : 0;
  return Math.min(1, Math.max(0, p));
}

export type ShapeKind =
  | 'rect'
  | 'roundRect'
  | 'ellipse'
  | 'triangle'
  | 'line'
  | 'star'
  // スタンプ（CapCut のステッカー。どれもこのアプリで描く図形）
  | 'heart'
  | 'arrow'
  | 'bubble'
  | 'thought'
  | 'sparkle'
  | 'sweat'
  | 'anger'
  | 'exclaim'
  | 'question'
  | 'burst'
  | 'speed';
export const SHAPE_LABEL: Record<ShapeKind, string> = {
  rect: '四角',
  roundRect: '角丸四角',
  ellipse: '円',
  triangle: '三角',
  line: '線',
  star: '星',
  heart: 'ハート',
  arrow: '矢印',
  bubble: '吹き出し',
  thought: '考え中の吹き出し',
  sparkle: 'キラキラ',
  sweat: '汗',
  anger: '怒りマーク',
  exclaim: 'びっくり',
  question: 'はてな',
  burst: 'ドカン',
  speed: '集中線',
};
/** 図形のメニューに出す基本の形 */
export const BASIC_SHAPES: ShapeKind[] = ['rect', 'roundRect', 'ellipse', 'triangle', 'line', 'star'];
/** スタンプ：置いたときの大きさと色 */
export const STICKERS: {kind: ShapeKind; w: number; h: number; fill: string; stroke: string; strokeWidth: number}[] = [
  {kind: 'heart', w: 240, h: 220, fill: '#FF4D6D', stroke: '#FFFFFF', strokeWidth: 8},
  {kind: 'arrow', w: 320, h: 160, fill: '#FF3B30', stroke: '#FFFFFF', strokeWidth: 8},
  {kind: 'bubble', w: 520, h: 300, fill: '#FFFFFF', stroke: '#222222', strokeWidth: 8},
  {kind: 'thought', w: 480, h: 320, fill: '#FFFFFF', stroke: '#222222', strokeWidth: 8},
  {kind: 'sparkle', w: 200, h: 200, fill: '#FFE14D', stroke: '', strokeWidth: 0},
  {kind: 'sweat', w: 110, h: 170, fill: '#7EC8FF', stroke: '#FFFFFF', strokeWidth: 6},
  {kind: 'anger', w: 200, h: 200, fill: '#E5193B', stroke: '', strokeWidth: 0},
  {kind: 'exclaim', w: 120, h: 280, fill: '#FF3B30', stroke: '#FFFFFF', strokeWidth: 8},
  {kind: 'question', w: 200, h: 280, fill: '#3B82F6', stroke: '#FFFFFF', strokeWidth: 8},
  {kind: 'burst', w: 420, h: 340, fill: '#FFD400', stroke: '#E5193B', strokeWidth: 10},
  {kind: 'speed', w: 1920, h: 1080, fill: '#111111', stroke: '', strokeWidth: 0},
];
/** 図形アイテム */
export interface ShapeClip extends ClipBase {
  type: 'shape';
  shape: ShapeKind;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  transform: Transform;
  look?: Look;
  /** モザイク・ぼかし範囲：図形の形の中だけ、下の絵をモザイク・ぼかしにする（図形の色は使わない） */
  region?: Region | null;
  /** グループ制御・カメラ・調整レイヤー（図形そのものは描かず、下のレイヤーに効く） */
  control?: Control | null;
  /** シーンアイテム：このシーン（id）を、アイテムの頭から再生して置く */
  scene?: string | null;
  /** 音声の波形・スペクトラム：動画の音を、図形の大きさ・塗りの色で描く（wave ＝波形、bars ＝周波数の棒） */
  viz?: 'wave' | 'bars' | null;
  /** 動く図形（紙吹雪などの粒・進行バー・グラフ）。画面側がコマごとに描き、書き出しはその画像を並べる */
  anim?: ShapeAnim | null;
}

/** 降ってくる粒 */
export interface Particles {
  kind: 'particles';
  /** confetti 紙吹雪・snow 雪・petals 花びら・sparkle キラキラ */
  type: 'confetti' | 'snow' | 'petals' | 'sparkle';
  /** 粒の数 */
  amount: number;
  /** 速さ（4 秒で画面を何回通るか。1〜3） */
  speed: number;
  /** 粒の大きさ（画素） */
  size: number;
  /** 色（紙吹雪・花びら・キラキラ。いくつかから選ぶ） */
  colors: string[];
}
/** 進行バー：アイテムの頭から終わりまでで伸びる。マーカーを章の区切りにできる */
export interface ProgressBar {
  kind: 'progress';
  /** まだのところの色 */
  trackColor: string;
  /** マーカーの所で区切る */
  chapters: boolean;
  /** 区切りの上に章の名前を出す */
  labels: boolean;
}
/** グラフ：数字を入れると、伸びる動きつきで出る */
export interface Chart {
  kind: 'chart';
  chart: 'bar' | 'pie' | 'line';
  items: {label: string; value: number; color: string}[];
  /** 伸びきるまで（フレーム） */
  grow: number;
  /** 数字を出す */
  showValues: boolean;
  /** 数字のあとに付ける単位 */
  unit: string;
  /** 文字の色 */
  textColor: string;
}
export type ShapeAnim = Particles | ProgressBar | Chart;

/** グループ制御・カメラ・調整レイヤー（core/src/model.rs の Control と同じ） */
export interface Control {
  /** group：すぐ下のレイヤーをまとめて動かす／camera：下の全部をカメラを動かしたように／adjust：下の全部にエフェクトを掛ける */
  kind: 'group' | 'camera' | 'adjust';
  /** グループ制御で、すぐ下の何レイヤーをまとめるか */
  layers: number;
}
export const CONTROL_LABEL: Record<Control['kind'], string> = {group: 'グループ制御', camera: 'カメラ', adjust: '調整レイヤー'};

/** まとめるレイヤーの数（下のレイヤーの数 below まで。model.rs の Control::covers と同じ） */
export const controlCovers = (k: Control, below: number) => (k.kind === 'group' ? Math.min(Math.max(0, Math.floor(k.layers)), below) : k.kind === 'camera' ? below : 0);

/** カメラの動きを、まとめた絵の動きにする（model.rs の camera_view と同じ） */
export function cameraView(t: Transform, look: Look | undefined): [Transform, Look | undefined] {
  const flip = (t: Transform): Transform => ({...t, x: -t.x, y: -t.y});
  if (!look) return [flip(t), look];
  const neg = (v?: [number, number] | null) => (v ? ([-v[0], -v[1]] as [number, number]) : v);
  const an = look.anim;
  return [
    flip(t),
    {
      ...look,
      rotation: -look.rotation,
      rot3d: neg(look.rot3d),
      anim: an
        ? {
            ...an,
            to: flip(an.to),
            rotation: -an.rotation,
            rot3d: neg(an.rot3d),
            mid: an.mid ? {...an.mid, transform: flip(an.mid.transform), rotation: -an.mid.rotation} : an.mid,
            keys: an.keys?.map(k => ({...k, transform: flip(k.transform), rotation: -k.rotation})),
          }
        : an,
    },
  ];
}

/**
 * グループ制御・カメラ：まとめるレイヤーの範囲（from 番目から at 番目の 1 つ下まで）と、そのアイテム（at 番目のレイヤーにある）。
 * 書き出しの render.rs の group_ranges と同じ（範囲は入れ子になるようにそろえる）
 */
export function groupRanges(p: Project): {from: number; at: number; clips: ShapeClip[]}[] {
  const out: {from: number; at: number; clips: ShapeClip[]}[] = [];
  p.tracks.forEach((t, gi) => {
    if (t.hidden) return;
    const cs = p.clips.filter((c): c is ShapeClip => c.trackId === t.id && c.type === 'shape' && !!c.control && controlCovers(c.control, gi) > 0);
    if (!cs.length) return;
    const n = Math.max(...cs.map(c => controlCovers(c.control!, gi)));
    out.push({from: gi - n, at: gi, clips: cs});
  });
  for (let i = 0; i < out.length; i++)
    for (let j = i + 1; j < out.length; j++) {
      const [a, b] = [out[i], out[j]];
      if (a.from < b.from && a.at > b.from && a.at < b.at) a.from = b.from;
    }
  return out;
}

/** モザイク・ぼかし範囲。strength はモザイクのマスの大きさ・ぼかしの強さ（書き出しの画面の px） */
export interface Region {
  kind: 'mosaic' | 'blur';
  strength: number;
}

/** セリフの字幕（映像トラックに置く。文と見た目はセリフとキャラクターの設定を使う） */
export interface CaptionClip extends ClipBase {
  type: 'caption';
  voiceId: string;
  /** この字幕だけの見た目（書いた項目だけキャラクターの字幕の設定を上書きする。Rust の SubtitleOverride と同じ） */
  style?: SubtitleOverride | null;
}
export type SubtitleOverride = Partial<Pick<SubtitleStyle, 'fontFamily' | 'fontSize' | 'outlineWidth' | 'animation' | 'color' | 'outlineColor' | 'position' | 'marginV'>>;

/** 立ち絵アイテム（YMM4 と同じ。置いた間だけ、そのキャラクターの PSD 立ち絵を口パク・目パチ付きで出す） */
export interface PortraitClip extends ClipBase {
  type: 'portrait';
  characterId: string;
  /** 位置・大きさ・不透明度（置いたときはキャラクターの立ち絵の設定の値） */
  transform: Transform;
  /** このアイテムの間のうち、キャラクターが喋っているときだけ出す。未設定ならキャラクターの立ち絵の設定のとおり */
  onlyWhileSpeaking?: boolean | null;
  /** 既定の表情（セリフで表情を選んでいない間はこれ）。未設定なら通常 */
  expression?: string | null;
}

/** セリフで「通常」をはっきり選んだときの値（Rust の lipsync::BASE_EXPRESSION と同じ） */
export const BASE_EXPRESSION = '@base';

/**
 * その時の表情の番号（Rust の expression_track_with と同じ決め方）：
 * セリフで選んでいればその表情（「通常」なら 0）、選んでいなければ立ち絵アイテムの既定の表情
 */
export function lineExpression(p: Portrait, lineExpr: string | null | undefined, itemDefault: number): number {
  if (!lineExpr) return itemDefault;
  if (lineExpr === BASE_EXPRESSION) return 0;
  return expressionIndex(p, lineExpr) || itemDefault;
}

/** その時点にかかる、そのキャラクターの立ち絵アイテムの既定の表情（なければ通常）。Rust の item_default_at と同じ */
export function itemDefaultAt(p: Project, ch: Character, frame: number): number {
  const pt = ch.portrait;
  if (!pt) return 0;
  const it = p.clips.find(c => c.type === 'portrait' && c.characterId === ch.id && c.start <= frame && frame < c.start + c.duration);
  return it?.type === 'portrait' ? expressionIndex(pt, it.expression) : 0;
}

/** そのセリフの間の、もとになる表情の番号（Rust の line_base_expression と同じ） */
export function lineBaseExpression(p: Project, ch: Character, c: VoiceClip): number {
  const pt = ch.portrait;
  if (!pt) return 0;
  return lineExpression(pt, c.expression, itemDefaultAt(p, ch, c.start));
}

/**
 * セリフで立ち絵のレイヤーの表示を変えたもの（clips の順）。表情の後ろに足した「表情」として番号を付ける
 * （番号 = 表情の数 + 1 + 順番）。Rust の lipsync::line_variants と同じ決め方
 */
export function lineVariants(p: Project, ch: Character): {id: string; index: number; base: number; clip: VoiceClip}[] {
  const pt = ch.portrait;
  if (!pt) return [];
  const first = (pt.expressions ?? []).length + 1;
  return p.clips
    .filter((c): c is VoiceClip => c.type === 'voice' && c.characterId === ch.id && Object.keys(c.portrait?.visibility ?? {}).length > 0)
    .map((c, k) => ({id: c.id, index: first + k, base: lineBaseExpression(p, ch, c), clip: c}))
    .filter(v => v.index <= 255);
}

/** 表情の番号（セリフで変えたものを含む）→ 当てる表示（表情の表示 + セリフで変えた表示） */
export function expressionFor(p: Project, ch: Character, idx: number): Expression | undefined {
  const pt = ch.portrait;
  if (!pt || idx <= 0) return undefined;
  const n = (pt.expressions ?? []).length;
  if (idx <= n) return pt.expressions[idx - 1];
  const v = lineVariants(p, ch).find(x => x.index === idx);
  if (!v) return undefined;
  const base = v.base > 0 ? pt.expressions[v.base - 1] : undefined;
  return {name: '', base: null, eyes: [null, null, null], mouth: [null, null, null], visibility: {...(base?.visibility ?? {}), ...(v.clip.portrait?.visibility ?? {})}};
}

/** 画面に出るアイテム（画像・動画・テキスト・図形） */
export type VisualClip = MediaClip | TextClip | ShapeClip;
export const isVisual = (c: Clip): c is VisualClip => c.type === 'text' || c.type === 'shape' || (c.type === 'media' && c.mediaKind !== 'audio');
/** 音声素材か */
export const isAudioClip = (c: Clip) => c.type === 'media' && c.mediaKind === 'audio';

/** このレイヤーに置けるか（YMM4 と同じく、どのアイテムもどのレイヤーにも置ける。Rust の Clip::fits と同じ） */
export function fitsTrack(_c: Clip, _kind: 'video' | 'audio'): boolean {
  return true;
}

/** 字幕を分離したセリフか（声だけ。字幕は字幕のクリップが出す） */
export const isSeparatedVoice = (p: Project, c: Clip) => c.type === 'voice' && p.clips.some(x => x.type === 'caption' && x.voiceId === c.id);

/** 字幕として出るクリップなら、そのセリフ（Rust の line_of_subtitle と同じ） */
export function lineOfSubtitle(p: Project, c: Clip): VoiceClip | null {
  if (c.type === 'voice') return isSeparatedVoice(p, c) ? null : c;
  if (c.type !== 'caption') return null;
  const v = p.clips.find(x => x.id === c.voiceId);
  return v?.type === 'voice' ? v : null;
}

export type Clip = VoiceClip | MediaClip | TextClip | ShapeClip | CaptionClip | PortraitClip;

/** 同じレイヤーで、b のすぐ前に接しているアイテム（2 フレームまでのすき間は接しているとみなす）。Rust の prev_adjacent と同じ */
export function prevAdjacent(p: Project, b: Clip): VisualClip | null {
  if (!isVisual(b)) return null;
  let best: VisualClip | null = null;
  for (const a of p.clips) {
    if (a.id === b.id || a.trackId !== b.trackId || !isVisual(a) || a.start >= b.start) continue;
    const end = a.start + a.duration;
    if (end > b.start || end < b.start - 2) continue;
    if (!best || end > best.start + best.duration || (end === best.start + best.duration && a.start >= best.start)) best = a;
  }
  return best;
}

/** 切り替えに実際に使う長さ（前後のアイテムの長さの 8 割まで） */
export function transitionFrames(t: Transition, a: Clip, b: Clip): number {
  return Math.max(2, Math.min(t.frames, Math.floor((a.duration * 4) / 5), Math.floor((b.duration * 4) / 5)));
}

/** クロスフェードに使う長さ（前後の音の長さの 8 割まで、2 フレーム以上）。Rust の crossfade_frames と同じ */
export function crossfadeFrames(want: number, a: number, b: number): number {
  return Math.max(2, Math.min(want, Math.floor((a * 4) / 5), Math.floor((b * 4) / 5)));
}

/** クロスフェードでつなぐ前の音声素材（同じレイヤーのすぐ前、2 フレームまでのすき間） */
export function prevAudio(p: Project, b: Clip): MediaClip | null {
  let best: MediaClip | null = null;
  for (const a of p.clips) {
    if (a.id === b.id || a.trackId !== b.trackId || a.type !== 'media' || a.mediaKind !== 'audio' || a.start >= b.start) continue;
    const end = a.start + a.duration;
    if (end > b.start || end < b.start - 2) continue;
    if (!best || end > best.start + best.duration || (end === best.start + best.duration && a.start >= best.start)) best = a;
  }
  return best;
}

/**
 * クロスフェード：音声素材 b に crossfade があり、すぐ前に音声素材 a があれば、a を後ろへその長さだけ延ばして消していき、
 * b はその長さで大きくする。Rust の with_crossfades と同じ
 */
export function withCrossfades(p: Project): Project {
  const jobs: [string, string, number][] = [];
  for (const b of p.clips) {
    if (b.type !== 'media' || b.mediaKind !== 'audio' || !(b.crossfade && b.crossfade > 0)) continue;
    const a = prevAudio(p, b);
    if (a) jobs.push([a.id, b.id, crossfadeFrames(b.crossfade, a.duration, b.duration)]);
  }
  if (!jobs.length) return p;
  const clips = p.clips.map(c => ({...c}) as Clip);
  const byId = new Map(clips.map(c => [c.id, c as MediaClip]));
  const orig = new Map(p.clips.map(c => [c.id, c]));
  for (const [ai, bi, d] of jobs) {
    const a = byId.get(ai)!;
    const b = orig.get(bi)!;
    a.duration = b.start - a.start + d;
    a.soundFadeOut = Math.max(a.soundFadeOut ?? 0, d);
    const nb = byId.get(bi)!;
    nb.soundFadeIn = Math.max(nb.soundFadeIn ?? 0, d);
  }
  return {...p, clips};
}

/** 素材の音のフェードの大きさ（tau はクリップの頭からの秒、dur は鳴らす長さの秒）。書き出しの sound_fades と同じ直線 */
export function soundFadeAt(c: MediaClip, tau: number, dur: number, fps: number): number {
  const fi = (c.soundFadeIn ?? 0) / fps;
  const fo = Math.min(dur, (c.soundFadeOut ?? 0) / fps);
  return (fi > 0 ? Math.min(1, Math.max(0, tau / fi)) : 1) * (fo > 0 ? Math.min(1, Math.max(0, (dur - tau) / fo)) : 1);
}

/**
 * 切り替えを、前後のアイテムの登場・退場・フェード（と、暗転・白は画面を覆う図形）に置き換えた写し。
 * プレビューと書き出し用の画像はこれを描く。Rust の with_transitions と同じ結果になる
 */
export function withTransitions(p0: Project): Project {
  const p = withCrossfades(p0);
  const jobs: {a: VisualClip; b: VisualClip; t: Transition}[] = [];
  for (const b of p.clips) {
    if (!isVisual(b) || !b.look?.transition) continue;
    const a = prevAdjacent(p, b);
    if (a) jobs.push({a, b, t: b.look.transition});
  }
  if (!jobs.length) return p;
  const clips = p.clips.map(c => ({...c}) as Clip);
  const byId = new Map(clips.map(c => [c.id, c as VisualClip]));
  const extra: Clip[] = [];
  const edit = (id: string, f: (l: Look) => Partial<Look>) => {
    const c = byId.get(id)!;
    const l = {...plainLook(), ...(c.look ?? {})};
    c.look = {...l, ...f(l)};
  };
  for (const {a, b, t} of jobs) {
    const cut = b.start;
    const d = transitionFrames(t, a, b);
    const outF = Math.max(1, Math.floor(d / 2));
    const inF = Math.max(1, d - Math.floor(d / 2));
    // 前の場面を後ろへ延ばす。動画の音は元の長さで切る（延ばすのは映像だけ）
    const extendA = () => {
      const c = byId.get(a.id)!;
      if (c.type === 'media' && c.mediaKind === 'video') c.audioUntil = a.duration;
      c.duration = cut - a.start + d;
    };
    if (t.kind === 'dissolve') {
      // 前の場面を後ろへ延ばして、次の場面の下で消していく
      extendA();
      edit(a.id, () => ({exit: null, fadeOut: d}));
      edit(b.id, () => ({enter: null, fadeIn: d}));
    } else if (t.kind === 'black' || t.kind === 'white') {
      // 画面を覆う図形を、つなぎ目の前で濃くし、後で薄くする（同じレイヤーの上に重ねる）
      const cover = (id: string, start: number, duration: number, look: Partial<Look>): ShapeClip => ({
        id,
        trackId: b.trackId,
        start,
        duration,
        linkId: null,
        type: 'shape',
        shape: 'rect',
        width: p.video.width + 8,
        height: p.video.height + 8,
        fill: t.kind === 'black' ? '#000000' : '#FFFFFF',
        stroke: '',
        strokeWidth: 0,
        transform: {x: 0, y: 0, scale: 1, opacity: 1},
        look: {...plainLook(), ...look},
      });
      extra.push(cover(`${b.id}~cover1`, cut - outF, outF, {fadeIn: outF}), cover(`${b.id}~cover2`, cut, inF, {fadeOut: inF}));
    } else if (t.kind === 'zoom') {
      edit(a.id, () => ({exit: {kind: 'zoom', frames: outF}, fadeOut: outF}));
      edit(b.id, () => ({enter: {kind: 'zoom', frames: inF}, fadeIn: inF}));
    } else {
      // 前の場面がその方向へ流れて、次の場面が反対側から入る
      const pair: Record<string, [MotionKind, MotionKind]> = {
        slideLeft: ['slideLeft', 'slideRight'],
        slideRight: ['slideRight', 'slideLeft'],
        slideUp: ['slideUp', 'slideDown'],
        slideDown: ['slideDown', 'slideUp'],
      };
      const [go, come] = pair[t.kind];
      // 前の場面を後ろへ延ばして、2 つがくっついたまま同時に動く（押し出し）
      extendA();
      edit(a.id, () => ({exit: {kind: go, frames: d, smooth: true}, fadeOut: 0}));
      edit(b.id, () => ({enter: {kind: come, frames: d, smooth: true}, fadeIn: 0}));
    }
  }
  // 重なりの順（同じレイヤーでは頭の早い順に描く）。覆う図形は同じ時刻のアイテムより手前に
  const sorted = clips
    .map((c, i) => [c, i] as const)
    .sort((x, y) => x[0].start - y[0].start || x[1] - y[1])
    .map(x => x[0]);
  return {...p, clips: [...sorted, ...extra]};
}

export interface Project {
  version: number;
  name: string;
  video: {width: number; height: number; fps: number; sampleRate: number; background: string};
  characters: Character[];
  tracks: Track[];
  clips: Clip[];
  /** マーカー（時刻に付ける目印。YouTube のチャプターにも使う） */
  markers?: Marker[];
  /** シーン（別のタイムライン）。メインは tracks・clips */
  scenes?: Scene[];
  /**
   * 今編集しているシーンの id（画面だけ。保存・書き出しのときは canonicalProject でメインに戻す）。
   * そのあいだ tracks・clips はそのシーンのもので、メインは scenes の MAIN_SCENE に入っている
   */
  sceneId?: string | null;
}

/** シーン（メインとは別のレイヤーとアイテム） */
export interface Scene {
  id: string;
  name: string;
  tracks: Track[];
  clips: Clip[];
}
/** シーンを編集しているあいだ、メインのタイムラインをしまっておく id */
export const MAIN_SCENE = '__main__';

/** 保存・書き出し用：編集中のシーンをしまい、メインのタイムラインに戻した写し */
export function canonicalProject(p: Project): Project {
  if (!p.sceneId) return p;
  const main = p.scenes?.find(s => s.id === MAIN_SCENE);
  if (!main) return {...p, sceneId: null};
  const scenes = (p.scenes ?? []).filter(s => s.id !== MAIN_SCENE).map(s => (s.id === p.sceneId ? {...s, tracks: p.tracks, clips: p.clips} : s));
  const {sceneId: _drop, ...rest} = p;
  return {...rest, tracks: main.tracks, clips: main.clips, scenes};
}

/** シーンを開く（null ならメイン）。今のタイムラインをしまい、開くシーンのタイムラインを tracks・clips にする */
export function switchScene(p0: Project, id: string | null): Project {
  const p = canonicalProject(p0);
  if (!id) return p;
  const sc = p.scenes?.find(s => s.id === id);
  if (!sc) return p;
  return {...p, tracks: sc.tracks, clips: sc.clips, sceneId: id, scenes: [...(p.scenes ?? []), {id: MAIN_SCENE, name: 'メイン', tracks: p.tracks, clips: p.clips}]};
}

/** 今のシーンの一覧（メインを含む、編集中のシーンは今のタイムラインで） */
export function sceneOf(p: Project, id: string): Scene | undefined {
  if (id === p.sceneId) return {id, name: p.scenes?.find(s => s.id === id)?.name ?? '', tracks: p.tracks, clips: p.clips};
  return p.scenes?.find(s => s.id === id);
}

/**
 * シーンアイテムを、シーンのレイヤーとアイテム（アイテムの頭からの時刻にずらし、終わりで切る）と、それをまとめるグループ制御に置き換えた写し（4 段まで）。
 * 書き出しの model.rs の with_scenes と同じ（id は「元の id@シーンアイテムの id」）
 */
export function withScenes(p0: Project): Project {
  let p = p0;
  const src = (id: string) => sceneOf(p0, id);
  for (let depth = 0; depth < 4; depth++) {
    const items = p.clips.filter((c): c is ShapeClip => c.type === 'shape' && !!c.scene);
    if (!items.length) break;
    const tracks: Track[] = [];
    const add: Clip[] = [];
    const layers = new Map<string, number>();
    for (const t of p.tracks) {
      const here = items.filter(c => c.trackId === t.id).sort((a, b) => a.start - b.start);
      let n = 0;
      for (const item of here) {
        const sc = src(item.scene!);
        if (!sc) continue;
        const tag = (id: string) => `${id}@${item.id}`;
        for (const st of sc.tracks) {
          tracks.push({...st, id: tag(st.id)});
          n++;
        }
        for (const c of sc.clips) {
          if (c.start >= item.duration) continue;
          add.push({
            ...c,
            id: tag(c.id),
            trackId: tag(c.trackId),
            linkId: c.linkId ? tag(c.linkId) : c.linkId,
            start: item.start + c.start,
            duration: Math.min(c.duration, item.duration - c.start),
          } as Clip);
        }
      }
      if (n > 0) layers.set(t.id, n);
      tracks.push(t);
    }
    const clips = p.clips.map(c => {
      if (c.type !== 'shape' || !c.scene) return c;
      const n = layers.get(c.trackId) ?? 0;
      return n > 0
        ? {...c, scene: null, control: {kind: 'group' as const, layers: n}}
        : {...c, scene: null, control: {kind: 'adjust' as const, layers: 1}, look: {...(c.look ?? plainLook()), effects: []}};
    });
    p = {...p, tracks, clips: [...clips, ...add]};
  }
  return p;
}

export interface Marker {
  id: string;
  frame: Frame;
  name: string;
}

export interface VoiceInfo {
  engine: EngineId;
  speaker: string;
  displayName: string;
  emotions: string[];
  /** 動画に載せるクレジット表記（VOICEVOX の「VOICEVOX:ずんだもん」など） */
  credit: string | null;
}

export type EngineStatus = {state: 'notFound'; detail: string} | {state: 'notRunning'; detail: string} | {state: 'ready'; version: string | null};

export const defaultParams = (): VoiceParams => ({speed: 1, pitch: 0, volume: 1, intonation: 1, emotions: {}});

export const projectDuration = (p: Project): Frame => p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

/**
 * 時:分:秒:フレーム（Premiere Pro と同じ。例 00:01:08:24 = 1 分 8 秒 24 フレーム目）。
 * 区切りを 4 つにして、分:秒:フレームと読み違えないようにする。小数点も使わない
 */
export const framesToTimecode = (f: Frame, fps: number): string => {
  const total = Math.max(0, Math.floor(f / fps));
  const ff = Math.max(0, Math.floor(f % fps));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return [h, m, s, ff].map(n => String(n).padStart(2, '0')).join(':');
};

/**
 * 時:分:秒:フレーム を読む（右から フレーム・秒・分・時。区切りは : か ; か .）。読めなければ null。
 * 例 "00:00:08:06"、"8:06"（8 秒 6 フレーム）、"1:00:00"（1 分）
 */
export function timecodeToFrames(text: string, fps: number): Frame | null {
  const parts = text.trim().split(/[:;.]/);
  if (!parts.length || parts.length > 4 || parts.some(p => !/^\d+$/.test(p))) return null;
  const [ff = 0, s = 0, m = 0, h = 0] = parts.map(Number).reverse();
  if (ff >= fps) return null;
  return ((h * 60 + m) * 60 + s) * fps + ff;
}

/** 読み上げ用（例「1分8秒」） */
export const framesToSpoken = (f: Frame, fps: number): string => {
  const sec = f / fps;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}分${s.toFixed(1)}秒` : `${s.toFixed(1)}秒`;
};

let seq = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Rust の Project::reflow_all と同じ詰め直し（全トラックをまとめて）。
 * セリフの長さ = 音声 + セリフ後の余韻（gapAfter）。どのトラックでも、セリフのすぐ後ろから始まるセリフは新しい終わりに付いていく。
 * 離して置いたものは位置を保つ（同じトラックで重なるときだけ押し出す）。
 * removed に入れた id のセリフは長さ 0 として扱う（消したときに、後ろの会話を詰める）
 */
export function reflowAll(p: Project, removed: Set<string> = new Set()): Project {
  const fps = p.video.fps;
  const linked = linkedCaptions(p);
  const order = p.clips
    .map((c, i) => [c, i] as const)
    .filter(([c]) => !linked.has(c.id))
    .sort((a, b) => a[0].start - b[0].start || a[1] - b[1]);
  const ends = new Map<number, number>();
  const layerEnd = new Map<string, number>();
  const updated = new Map<string, Clip>();
  /** セリフの（元の）開始と、伸びた長さ */
  const growth: [number, number][] = [];
  for (const [c] of order) {
    const oldEnd = c.start + c.duration;
    let duration = c.duration;
    let start = c.start;
    if (c.type === 'voice') {
      if (removed.has(c.id)) duration = 0;
      // 再生開始位置で頭を飛ばした分だけ短くなる（Rust の reflow_all と同じ）
      else if (!c.lockDuration && c.audio) duration = Math.max(1, Math.ceil((c.audio.durationMs * fps) / 1000) - startOffsetOf(c)) + c.gapAfter;
      growth.push([c.start, duration - c.duration]);
    }
    // セリフのすぐ後ろ（開始 = そのセリフの旧い終わり）から始まるものは、セリフでもそれ以外（立ち絵・素材など）でも付いていく
    {
      const to = ends.get(c.start);
      if (to !== undefined) start = to;
    }
    if (!removed.has(c.id)) {
      const le = layerEnd.get(c.trackId);
      if (le !== undefined) start = Math.max(start, le);
    }
    const newEnd = start + duration;
    if (c.type === 'voice') ends.set(oldEnd, Math.max(ends.get(oldEnd) ?? -Infinity, newEnd));
    if (!removed.has(c.id)) layerEnd.set(c.trackId, newEnd);
    if (start !== c.start || duration !== c.duration) updated.set(c.id, {...c, start, duration});
  }
  // 立ち絵アイテムは、中のセリフが伸び縮みした分だけ長さを変える（後ろのセリフに付いていって、キャラクターが消えないように）
  for (const [c] of order) {
    if (c.type !== 'portrait') continue;
    const d = growth.filter(([s0]) => s0 >= c.start && s0 < c.start + c.duration).reduce((a, [, g]) => a + g, 0);
    if (!d) continue;
    const cur = updated.get(c.id) ?? c;
    updated.set(c.id, {...cur, duration: Math.max(1, cur.duration + d)});
  }
  return syncCaptions(updated.size ? {...p, clips: p.clips.map(c => updated.get(c.id) ?? c)} : p);
}

/** セリフとリンクしている字幕の id（Rust の linked_captions と同じ） */
export function linkedCaptions(p: Project): Set<string> {
  const links = new Map(p.clips.filter(c => c.type === 'voice').map(c => [c.id, c.linkId ?? null]));
  return new Set(p.clips.filter(c => c.type === 'caption' && !!c.linkId && links.get(c.voiceId) === c.linkId).map(c => c.id));
}

/** リンクしている字幕の位置と長さをセリフに合わせる（Rust の sync_captions と同じ） */
export function syncCaptions(p: Project): Project {
  const voices = new Map(p.clips.filter(c => c.type === 'voice').map(c => [c.id, c]));
  let changed = false;
  const clips = p.clips.map(c => {
    if (c.type !== 'caption') return c;
    const v = voices.get(c.voiceId);
    if (!v || !v.linkId || v.linkId !== c.linkId || (v.start === c.start && v.duration === c.duration)) return c;
    changed = true;
    return {...c, start: v.start, duration: v.duration};
  });
  return changed ? {...p, clips} : p;
}

/**
 * リンクを保つ（編集のたびに呼ぶ）。
 * - リンクしたクリップのどれかだけを動かした・長さを変えたら、ほかも同じだけ動かす（動画の切り出し位置も）
 * - 字幕はセリフにぴったり合わせ、セリフが無くなった字幕は消す
 */
export function keepLinks(before: Project, after: Project): Project {
  if (before === after) return after;
  const prev = new Map(before.clips.map(c => [c.id, c]));
  const groups = new Map<string, Clip[]>();
  for (const c of after.clips) if (c.linkId) groups.set(c.linkId, [...(groups.get(c.linkId) ?? []), c]);
  const patch = new Map<string, Clip>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const changed = members.filter(c => {
      const o = prev.get(c.id);
      return o && (o.start !== c.start || o.duration !== c.duration);
    });
    // 1 つだけ（か、セリフと字幕ならセリフ）が変わったときに、ほかを合わせる
    const master = changed.length === 1 ? changed[0] : changed.find(c => c.type === 'voice');
    if (!master) continue;
    const o = prev.get(master.id)!;
    const ds = master.start - o.start;
    const dd = master.duration - o.duration;
    // 左端を詰めたときだけ切り出し位置もずらす（移動では変えない）
    const trimLeft = dd !== 0 && ds !== 0 && master.start + master.duration === o.start + o.duration;
    for (const c of members) {
      if (c === master || (changed.includes(c) && c.type !== 'caption')) continue;
      const q = prev.get(c.id) ?? c;
      const next = {...c, start: Math.max(0, q.start + ds), duration: Math.max(1, q.duration + dd)} as Clip;
      if (next.type === 'media' && q.type === 'media' && (trimLeft || ds === 0)) patch.set(c.id, retime(q, next.start, next.duration));
      else patch.set(c.id, next);
    }
  }
  let p = patch.size ? {...after, clips: after.clips.map(c => patch.get(c.id) ?? c)} : after;
  const voices = new Set(p.clips.filter(c => c.type === 'voice').map(c => c.id));
  if (p.clips.some(c => c.type === 'caption' && !voices.has(c.voiceId))) p = {...p, clips: p.clips.filter(c => c.type !== 'caption' || voices.has(c.voiceId))};
  return syncCaptions(p);
}

/** レイヤー（すべて。レイヤー 1 から順） */
export const videoTracks = (p: Project) => p.tracks;
/** 互換用（レイヤーは映像と音声を分けない） */
export const audioTracks = (p: Project) => p.tracks;

/** 音が出るレイヤー（表示していて、ミュートしていない。どれかをソロにしているなら、ソロのレイヤーだけ）。Rust の audible_tracks と同じ */
export function audibleTracks(p: Project): Set<string> {
  const solo = p.tracks.some(t => t.solo && !t.hidden);
  return new Set(p.tracks.filter(t => !t.hidden && !t.muted && (!solo || t.solo)).map(t => t.id));
}

/** キャラクターの立ち絵を描く映像トラック（Rust の portrait_track_for と同じ） */
export function portraitTrackFor(p: Project, characterId: string): string | null {
  const voices = new Set(p.clips.filter(c => c.type === 'voice' && c.characterId === characterId).map(c => c.id));
  // 字幕（分離した字幕、または字幕と声が 1 つのセリフ）を最後に置いたレイヤー
  const last = p.clips.filter(c => (c.type === 'caption' && voices.has(c.voiceId)) || (voices.has(c.id) && !isSeparatedVoice(p, c))).sort((a, b) => b.start - a.start)[0];
  if (last) return last.trackId;
  const vt = videoTracks(p);
  const ch = p.characters.find(c => c.id === characterId);
  return (ch?.layer ? vt[ch.layer - 1] : undefined)?.id ?? vt.at(-1)?.id ?? null;
}

/** セリフの字幕（リンクしているもの優先） */
export const captionOf = (p: Project, voiceId: string) =>
  p.clips.filter(c => c.type === 'caption' && c.voiceId === voiceId).sort((a, b) => Number(!!b.linkId) - Number(!!a.linkId))[0] as CaptionClip | undefined;

/** 字幕ならそのセリフ、それ以外はそのまま（字幕を選んだときも、セリフの設定を出すため） */
export function lineOf(p: Project, c: Clip | undefined): Clip | undefined {
  if (c?.type !== 'caption') return c;
  return p.clips.find(x => x.id === c.voiceId) ?? c;
}

/** 互換用（トラックを指定しても全体を詰め直す） */
export function reflowVoiceTrack(p: Project, _trackId?: string): Project {
  return reflowAll(p);
}

/** レイヤーの番号（1 から。無ければ 0） */
export const layerNumber = (p: Project, trackId: string) => p.tracks.findIndex(t => t.id === trackId) + 1;

/** レイヤーの短い名前（「レイヤー 2」） */
export function trackCode(p: Project, trackId: string): string {
  const n = layerNumber(p, trackId);
  return n ? `レイヤー ${n}` : '';
}

/** レイヤーの表示名（「レイヤー 2」、名前があれば「レイヤー 2 字幕」） */
export function layerLabel(p: Project, trackId: string): string {
  const t = p.tracks.find(x => x.id === trackId);
  const code = trackCode(p, trackId);
  return t?.name ? `${code} ${t.name}` : code;
}

/** 番号から探す・選ぶ用（Rust の Project::voice_layer_for と同じ順）。kind のトラックの中での位置 */
function layerFor(p: Project, characterId: string, kind: 'video' | 'audio'): number {
  const ch = p.characters.find(c => c.id === characterId);
  const list = kind === 'audio' ? audioTracks(p) : videoTracks(p);
  const n = kind === 'audio' ? ch?.audioLayer : ch?.layer;
  if (n && n >= 1 && n <= list.length) return n - 1;
  const pos = (tid: string) => list.findIndex(t => t.id === tid);
  const voiceIds = new Set(p.clips.filter(c => c.type === 'voice' && c.characterId === characterId).map(c => c.id));
  // そのキャラクターのセリフ（'audio' なら分離した声、'video' なら字幕か、字幕と声が 1 つのセリフ）
  const isLine = (c: Clip) =>
    kind === 'audio'
      ? c.type === 'voice' && voiceIds.has(c.id) && isSeparatedVoice(p, c)
      : (c.type === 'voice' && voiceIds.has(c.id) && !isSeparatedVoice(p, c)) || (c.type === 'caption' && voiceIds.has(c.voiceId));
  const mine = p.clips.filter(c => isLine(c) && pos(c.trackId) >= 0).sort((a, b) => b.start - a.start)[0];
  if (mine) return pos(mine.trackId);
  if (kind === 'audio') return -1; // 決まっていない（空いているレイヤーを探す）
  const any = p.clips.find(c => (c.type === 'voice' || c.type === 'caption') && pos(c.trackId) >= 0);
  if (any) return pos(any.trackId);
  return Math.max(0, list.length - 1);
}

/** キャラクターのセリフを分離したとき、声を置くレイヤーの位置（決まっていなければ -1） */
export const voiceLayerFor = (p: Project, characterId: string) => layerFor(p, characterId, 'audio');
/** キャラクターのセリフ（字幕と声）を置くレイヤーの位置 */
export const captionLayerFor = (p: Project, characterId: string) => layerFor(p, characterId, 'video');

/**
 * ほかのセリフ（同じキャラクターのものも含む）と時間が重なっているセリフ（id）。声が同時に鳴る。掛け合いで声と字幕がかぶっているのに気づけるよう、タイムラインで示す。
 * 余韻（セリフの後ろの間）だけが重なっているときは数えない
 */
export function overlappingLines(p: Project): Set<string> {
  const fps = p.video.fps;
  const lines = p.clips
    .filter((c): c is VoiceClip => c.type === 'voice')
    .map(c => ({c, s: c.start, e: c.start + (c.audio && !c.lockDuration ? Math.ceil((c.audio.durationMs * fps) / 1000) - startOffsetOf(c) : c.duration - c.gapAfter)}))
    .sort((a, b) => a.s - b.s);
  const out = new Set<string>();
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length && lines[j].s < lines[i].e; j++) {
      out.add(lines[i].c.id);
      out.add(lines[j].c.id);
    }
  return out;
}

/**
 * そのレイヤーに今いるキャラクター（そのキャラクターのセリフ・分離した字幕・立ち絵アイテムが置いてあるもの）。
 * レイヤーの見出しに出す。セリフを別のレイヤーへ動かせば、見出しからも消える
 */
export function charactersOnTrack(p: Project, trackId: string): Character[] {
  const ids = new Set<string>();
  for (const c of p.clips) {
    if (c.trackId !== trackId) continue;
    if (c.type === 'voice' || c.type === 'portrait') ids.add(c.characterId);
    else if (c.type === 'caption') {
      const v = p.clips.find(x => x.id === c.voiceId);
      if (v?.type === 'voice') ids.add(v.characterId);
    }
  }
  return p.characters.filter(ch => ids.has(ch.id));
}

/** セリフを置くレイヤーとして決まっている（設定・最後に置いた場所）か */
export function isLineTrack(p: Project, trackId: string): boolean {
  return p.characters.some(ch => p.tracks[captionLayerFor(p, ch.id)]?.id === trackId || (ch.audioLayer && p.tracks[ch.audioLayer - 1]?.id === trackId));
}

/** 互換用（レイヤーは映像と音声を分けない） */
export const trackKindOf = (_p: Project, _c: Clip): 'video' | 'audio' => 'video';

/** start〜end の間、ずっと空いているか（ignore のクリップは数えない） */
export const freeOver = (p: Project, trackId: string, start: number, end: number, ignore: Set<string> = new Set()) =>
  !p.clips.some(c => c.trackId === trackId && !ignore.has(c.id) && c.start < end && start < c.start + c.duration);

export const newLayer = (id: string, kind: 'video' | 'audio' = 'video'): Track => ({id, kind, name: '', muted: false, locked: false, duck: false, duckLevel: 0.3});

/** 話者一覧を取れているのに、その中に話者がいない（ソフトに入っていない）か */
export function isSpeakerMissing(voice: Voice, voices: Partial<Record<EngineId, VoiceInfo[]>>): boolean {
  const list = voices[voice.engine];
  return !!list && list.length > 0 && !list.some(v => v.speaker === voice.speaker);
}

/** 話者の表示名（VOICEVOX の話者は番号なので、一覧から名前を引く） */
export function speakerLabel(voice: Voice, voices: Partial<Record<EngineId, VoiceInfo[]>>): string {
  return voices[voice.engine]?.find(v => v.speaker === voice.speaker)?.displayName ?? (voice.speaker || '話者未設定');
}

/**
 * 動画に載せるクレジット表記。セリフで実際に使っている話者だけを集める（隠したトラックは除く）。
 * 一覧をまだ取れていない話者は分からないので、その旨を返す
 */
export function collectCredits(p: Project, voices: Partial<Record<EngineId, VoiceInfo[]>>): {credits: string[]; unknown: string[]} {
  const audible = audibleTracks(p);
  const used = new Map<string, Voice>();
  for (const c of p.clips) {
    if (c.type !== 'voice' || !audible.has(c.trackId)) continue;
    const ch = p.characters.find(x => x.id === c.characterId);
    if (ch) used.set(`${ch.voice.engine}|${ch.voice.speaker}`, ch.voice);
  }
  const credits: string[] = [];
  const unknown: string[] = [];
  for (const v of used.values()) {
    if (v.engine !== 'voicevox') continue; // クレジット表記が決まっているのは VOICEVOX（ほかは各製品の規約に従う）
    const info = voices.voicevox?.find(x => x.speaker === v.speaker);
    if (info?.credit) {
      if (!credits.includes(info.credit)) credits.push(info.credit);
    } else unknown.push(`VOICEVOX の話者 ${v.speaker}`);
  }
  return {credits, unknown};
}

/** ソフトごとの細かい調声の項目。Rust 側（core/src/tts/*.rs）で送る名前と範囲に合わせる */
export interface TuningExtra {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 指定していないときのソフト側の標準値 */
  def: number;
  format: (v: number) => string;
}
const ms = (v: number) => `${Math.round(v)} ミリ秒`;
export const TUNING_EXTRA: Record<EngineId, TuningExtra[]> = {
  voicevox: [
    {key: 'pauseLengthScale', label: '句読点の間', min: 0, max: 2, step: 0.05, def: 1, format: v => `${Math.round(v * 100)}%`},
    {key: 'prePhonemeLength', label: '話し始めの前の無音', min: 0, max: 1.5, step: 0.01, def: 0.1, format: v => ms(v * 1000)},
    {key: 'postPhonemeLength', label: '話し終わりの後の無音', min: 0, max: 1.5, step: 0.01, def: 0.1, format: v => ms(v * 1000)},
  ],
  aivoice: [
    {key: 'MiddlePause', label: '短いポーズ（読点）', min: 80, max: 500, step: 10, def: 150, format: ms},
    {key: 'LongPause', label: '長いポーズ（句点）', min: 80, max: 2000, step: 10, def: 370, format: ms},
  ],
  voisona: [
    {key: 'alp', label: '声の若さ ↔ 大人っぽさ', min: -1, max: 1, step: 0.05, def: 0, format: v => (Math.abs(v) < 0.025 ? '標準' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`)},
    {key: 'huskiness', label: 'かすれ', min: -20, max: 20, step: 0.5, def: 0, format: v => (Math.abs(v) < 0.25 ? '標準' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`)},
  ],
  voicepeak: [],
  coeiroink: [
    {key: 'prePhonemeLength', label: '話し始めの前の無音', min: 0, max: 1.5, step: 0.01, def: 0.1, format: v => ms(v * 1000)},
    {key: 'postPhonemeLength', label: '話し終わりの後の無音', min: 0, max: 1.5, step: 0.01, def: 0.1, format: v => ms(v * 1000)},
  ],
  aquestalk: [],
  cevio: [{key: 'alpha', label: '声質', min: 0, max: 100, step: 1, def: 50, format: v => `${Math.round(v)}`}],
};

/** この行で実際に使う声（Rust の Project::effective_voice と同じ順：キャラクター → プリセット → 行の話者 → 行の調声） */
export function effectiveVoice(ch: Character, clip: VoiceClip): Voice {
  let voice: Voice = ch.voice;
  const pr = clip.presetId ? ch.voicePresets?.find(x => x.id === clip.presetId) : undefined;
  if (pr) voice = {...voice, params: pr.params, speaker: pr.speaker || voice.speaker};
  if (clip.speakerOverride) voice = {...voice, speaker: clip.speakerOverride};
  if (clip.paramsOverride) voice = {...voice, params: clip.paramsOverride};
  return voice;
}

/** 合成結果を左右する部分だけの鍵（音量は再生・書き出しで掛けるので含めない） */
export function synthKey(v: Voice): string {
  const {volume: _v, emotions, extra, ...rest} = v.params;
  const sort = (o?: Record<string, number>) => JSON.stringify(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify([v.engine, v.speaker, rest.speed, rest.pitch, rest.intonation, sort(emotions), sort(extra)]);
}
