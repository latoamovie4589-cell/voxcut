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
}

export const newPortrait = (base: string): Portrait => ({
  base,
  eyes: [null, null, null],
  mouth: [null, null, null],
  transform: {x: 560, y: 140, scale: 1, opacity: 1},
  visible: true,
});

/** Rust の Portrait::layers と同じ（無い差分は 1 つ目で代用） */
export function portraitLayers(p: Portrait, eyes: number, mouth: number): string[] {
  const v = [p.base];
  const e = p.eyes[eyes] ?? p.eyes[0];
  if (e) v.push(e);
  const m = p.mouth[mouth] ?? p.mouth[0];
  if (m) v.push(m);
  return v;
}

export interface Character {
  id: string;
  name: string;
  color: string;
  voice: Voice;
  subtitle: SubtitleStyle;
  portrait: Portrait | null;
}

export interface Track {
  id: string;
  kind: 'voice' | 'media';
  name: string;
  muted: boolean;
  locked: boolean;
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
}

export type Clip = VoiceClip | MediaClip;

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

export type EngineStatus =
  | {state: 'notFound'; detail: string}
  | {state: 'notRunning'; detail: string}
  | {state: 'ready'; version: string | null};

export const defaultParams = (): VoiceParams => ({speed: 1, pitch: 0, volume: 1, intonation: 1, emotions: {}});

export const projectDuration = (p: Project): Frame =>
  p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

/** 分:秒:フレーム（例 01:08:24 = 1 分 8 秒 24 フレーム目）。小数点を使わず、秒の小数と読み違えないようにする */
export const framesToTimecode = (f: Frame, fps: number): string => {
  const total = Math.max(0, Math.floor(f / fps));
  const ff = Math.max(0, Math.floor(f % fps));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
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
 * Rust の Project::reflow_voice_track と同じ詰め直し。
 * 直前に詰めて置かれていた行は詰め直し、手で離した行は位置を保つ（重なるときだけ押し出す）。
 */
export function reflowVoiceTrack(p: Project, trackId: string): Project {
  const fps = p.video.fps;
  const voice = p.clips
    .filter((c): c is VoiceClip => c.type === 'voice' && c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
  const updated = new Map<string, Clip>();
  let prev: [number, number] | null = null; // [旧い終わり+間, 新しい終わり+間]
  for (const c of voice) {
    const oldEnd = c.start + c.duration;
    let duration = c.duration;
    if (!c.lockDuration && c.audio) duration = Math.max(1, Math.ceil((c.audio.durationMs * fps) / 1000));
    let start = c.start;
    if (prev) start = c.start === prev[0] ? prev[1] : Math.max(c.start, prev[1]);
    updated.set(c.id, {...c, start, duration});
    prev = [oldEnd + c.gapAfter, start + duration + c.gapAfter];
  }
  return {...p, clips: p.clips.map(c => updated.get(c.id) ?? c)};
}

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
  const hidden = new Set(p.tracks.filter(t => t.muted).map(t => t.id));
  const used = new Map<string, Voice>();
  for (const c of p.clips) {
    if (c.type !== 'voice' || hidden.has(c.trackId)) continue;
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
