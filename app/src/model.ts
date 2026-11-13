import type {SubtitleAnimation} from './subtitleAnim';

// Rust 側（core/src/model.rs）と同じ形。時間はすべて整数フレーム。

export type Frame = number;
export type EngineId = 'aivoice' | 'voicepeak' | 'voisona' | 'voicevox';

export const ENGINE_LABEL: Record<EngineId, string> = {
  aivoice: 'A.I.VOICE',
  voicepeak: 'VOICEPEAK',
  voisona: 'VoiSona Talk',
  voicevox: 'VOICEVOX',
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
}
export interface Anim {
  to: Transform;
  rotation: number;
  ease: Ease;
}
export type Ease = 'linear' | 'in' | 'out' | 'inOut';
export type Effect =
  | {kind: 'blur'; radius: number}
  | {kind: 'shake'; amount: number; speed: number}
  | {kind: 'color'; brightness: number; contrast: number; saturation: number}
  | {kind: 'mono'}
  | {kind: 'invert'}
  | {kind: 'wave'; amount: number; length: number; speed: number}
  | {kind: 'swirl'; angle: number};

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
}

export type ShapeKind = 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'line' | 'star';
export const SHAPE_LABEL: Record<ShapeKind, string> = {rect: '四角', roundRect: '角丸四角', ellipse: '円', triangle: '三角', line: '線', star: '星'};
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

export interface Project {
  version: number;
  name: string;
  video: {width: number; height: number; fps: number; sampleRate: number; background: string};
  characters: Character[];
  tracks: Track[];
  clips: Clip[];
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
      if (next.type === 'media' && trimLeft && q.type === 'media') next.inPoint = Math.max(0, q.inPoint + ds);
      patch.set(c.id, next);
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
 * ほかのキャラクターのセリフと時間が重なっているセリフ（id）。掛け合いで声と字幕がかぶっているのに気づけるよう、タイムラインで示す。
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
      if (lines[i].c.characterId === lines[j].c.characterId) continue;
      out.add(lines[i].c.id);
      out.add(lines[j].c.id);
    }
  return out;
}

/**
 * そのトラックを使うキャラクター（映像トラック：セリフを置くトラック、音声トラック：分離した声を置くトラックとして設定・使用しているもの）
 */
export function charactersOnTrack(p: Project, trackId: string): Character[] {
  if (!p.tracks.some(x => x.id === trackId)) return [];
  // セリフを置くレイヤー、分離した声を置くレイヤー、そのキャラクターのセリフ・立ち絵アイテムがあるレイヤー
  return p.characters.filter(
    ch =>
      p.tracks[captionLayerFor(p, ch.id)]?.id === trackId ||
      (ch.audioLayer && p.tracks[ch.audioLayer - 1]?.id === trackId) ||
      p.clips.some(c => (c.type === 'portrait' || c.type === 'voice') && c.characterId === ch.id && c.trackId === trackId),
  );
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
