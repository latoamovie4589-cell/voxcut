// 再生。一般的な動画編集ソフトと同じ操作に合わせる：
// - Space / K：再生・停止、L：再生（押すたびに 1→2→4 倍）、J：逆再生（同じく速くなる。音は出さない）
// - 再生中に終わりまで来たら止まる。ループがオンなら先頭へ戻って続ける
// 時計は AudioContext（音と映像がずれない）、描画は requestAnimationFrame。
// 音声は再生開始時に、再生位置以降のセリフだけを予約する。デコード結果はキャッシュする。

import {api} from '../ipc';
import type {VoiceClip} from '../model';
import {projectDuration} from '../model';
import {getState, setState} from '../store';
import {pauseAll} from './video';

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let sources: AudioBufferSourceNode[] = [];
let raf = 0;

function audioCtx() {
  ctx ??= new AudioContext({latencyHint: 'interactive'});
  return ctx;
}

function load(cacheKey: string): Promise<AudioBuffer | null> {
  let b = buffers.get(cacheKey);
  if (!b) {
    b = api
      .then(a => a.audioUrl(cacheKey))
      .then(url => (url ? fetch(url).then(r => r.arrayBuffer()) : null))
      .then(data => (data ? audioCtx().decodeAudioData(data) : null))
      .catch(() => null);
    buffers.set(cacheKey, b);
  }
  return b;
}

function stopSources() {
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      // 未開始のものは無視
    }
  }
  sources = [];
}

/** 再生する。rate は 1・2・4（順方向）か -1・-2・-4（逆方向、音なし） */
export async function play(rate = 1) {
  const s = getState();
  const p = s.project;
  if (!p) return;
  cancelAnimationFrame(raf);
  stopSources();
  const ac = audioCtx();
  await ac.resume();
  const fps = p.video.fps;
  const end = projectDuration(p);
  if (end <= 0) return;
  // 端にいるときは反対側から始める
  let startFrame = s.playhead;
  if (rate > 0 && startFrame >= end) startFrame = 0;
  if (rate < 0 && startFrame <= 0) startFrame = end;
  const t0 = ac.currentTime + 0.05; // 予約に少し余裕を持たせる

  if (rate > 0) {
    const mutedTracks = new Set(p.tracks.filter(t => t.muted).map(t => t.id));
    const voice = p.clips.filter(
      (c): c is VoiceClip => c.type === 'voice' && !!c.audio && !mutedTracks.has(c.trackId) && c.start + c.duration > startFrame,
    );
    for (const c of voice) {
      void load(c.audio!.cacheKey).then(buf => {
        const st = getState();
        if (!buf || !st.isPlaying || st.playRate !== rate) return;
        const vol = p.characters.find(ch => ch.id === c.characterId)?.voice.params.volume ?? 1;
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const gain = ac.createGain();
        gain.gain.value = vol;
        src.connect(gain).connect(ac.destination);
        const offset = Math.max(0, (startFrame - c.start) / fps);
        const when = t0 + Math.max(0, (c.start - startFrame) / fps / rate);
        src.start(Math.max(when, ac.currentTime), offset);
        sources.push(src);
      });
    }
  }

  setState({isPlaying: true, playRate: rate, playhead: startFrame});
  const tick = () => {
    const f = startFrame + Math.max(0, ac.currentTime - t0) * fps * rate;
    const out = rate > 0 ? f >= end : f <= 0;
    if (out) {
      if (getState().loop) {
        setState({playhead: rate > 0 ? 0 : end, isPlaying: false});
        void play(rate);
        return;
      }
      stop();
      setState({playhead: rate > 0 ? end : 0});
      return;
    }
    setState({playhead: Math.floor(f)});
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

export function stop() {
  cancelAnimationFrame(raf);
  stopSources();
  pauseAll();
  setState({isPlaying: false, playRate: 1});
}

export function toggle() {
  if (getState().isPlaying) stop();
  else void play(1);
}

/** L：順方向に再生。再生中なら速くする（1→2→4 倍） */
export function shuttleForward() {
  const s = getState();
  const next = s.isPlaying && s.playRate > 0 ? Math.min(4, s.playRate * 2) : 1;
  void play(next);
}

/** J：逆方向に再生。押すたびに速くする */
export function shuttleBackward() {
  const s = getState();
  const next = s.isPlaying && s.playRate < 0 ? Math.max(-4, s.playRate * 2) : -1;
  void play(next);
}

/** 1 コマ（Shift なら 1 秒）動かす。再生中なら止める */
export function step(frames: number) {
  const s = getState();
  if (!s.project) return;
  if (s.isPlaying) stop();
  setState({playhead: Math.max(0, Math.min(projectDuration(s.project), s.playhead + frames))});
}

/** 前後の編集点（クリップの始まり・終わり）へ */
export function jumpToEdit(dir: 1 | -1) {
  const s = getState();
  const p = s.project;
  if (!p) return;
  if (s.isPlaying) stop();
  const points = [...new Set([0, projectDuration(p), ...p.clips.flatMap(c => [c.start, c.start + c.duration])])].sort((a, b) => a - b);
  const next = dir > 0 ? points.find(x => x > s.playhead) : [...points].reverse().find(x => x < s.playhead);
  if (next !== undefined) setState({playhead: next});
}

export function jumpTo(where: 'start' | 'end') {
  const s = getState();
  if (!s.project) return;
  if (s.isPlaying) stop();
  setState({playhead: where === 'start' ? 0 : projectDuration(s.project)});
}

/** 再合成などでキャッシュキーが変わったものを捨てる */
export function forget(cacheKey: string) {
  buffers.delete(cacheKey);
}
