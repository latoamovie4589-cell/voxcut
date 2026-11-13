// 再生。一般的な動画編集ソフトと同じ操作に合わせる：
// - Space / K：再生・停止、L：再生（押すたびに 1→2→4 倍）、J：逆再生（同じく速くなる。音は出さない）
// - 再生中に終わりまで来たら止まる。ループがオンなら先頭へ戻って続ける
// 時計は AudioContext（音と映像がずれない）、描画は requestAnimationFrame。
// 音声は再生開始時に、再生位置以降のセリフだけを予約する。デコード結果はキャッシュする。

import {api} from '../ipc';
import type {MediaClip, VoiceClip} from '../model';
import {scheduleDuck, voiceIntervals} from '../ducking';
import {effectiveVoice, panGains, projectDuration, audibleTracks, startOffsetOf} from '../model';
import {callRemote, getState, setState} from '../store';
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

/** 素材の音声ファイル（BGM・効果音）を読む。URL ごとにデコード結果を使い回す */
function loadUrl(url: string): Promise<AudioBuffer | null> {
  let b = buffers.get(url);
  if (!b) {
    b = fetch(url)
      .then(r => r.arrayBuffer())
      .then(data => audioCtx().decodeAudioData(data))
      .catch(() => null);
    buffers.set(url, b);
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

/**
 * セリフの声のつなぎ（書き出しの voice_audio_filters と同じ順）：音声エフェクト → エコー → 音量とフェード → 左右。
 * into は再生を始めるときのクリップの頭からの秒、at はそれが鳴る時刻
 */
function voiceChain(ac: AudioContext, src: AudioNode, c: VoiceClip, vol: number, fps: number, into: number, at: number, rate: number): AudioNode {
  const fx = c.audioFx;
  let node: AudioNode = src;
  for (const f of fx?.filters ?? []) {
    const bq = ac.createBiquadFilter();
    bq.type = f.kind;
    bq.frequency.value = Math.max(1, f.hz);
    bq.Q.value = Math.SQRT1_2;
    node = node.connect(bq);
  }
  if (fx?.echo && fx.echo.delayMs > 0 && fx.echo.decay > 0) {
    const mix = ac.createGain();
    const delay = ac.createDelay(5);
    delay.delayTime.value = Math.min(5000, fx.echo.delayMs) / 1000 / rate;
    const decay = ac.createGain();
    decay.gain.value = Math.min(1, fx.echo.decay);
    node.connect(mix);
    node.connect(delay).connect(decay).connect(mix);
    node = mix;
  }
  // 音量とフェード（クリップの頭・終わりから。直線）
  const gain = ac.createGain();
  const dur = c.duration / fps;
  const fi = (fx?.fadeIn ?? 0) / fps;
  const fo = (fx?.fadeOut ?? 0) / fps;
  const g = (tau: number) => vol * (fi > 0 ? Math.min(1, tau / fi) : 1) * (fo > 0 ? Math.min(1, Math.max(0, (dur - tau) / fo)) : 1);
  gain.gain.setValueAtTime(g(into), at);
  for (const tau of [fi, dur - fo, dur].filter(x => x > into).sort((a, b) => a - b)) gain.gain.linearRampToValueAtTime(g(tau), at + (tau - into) / rate);
  node = node.connect(gain);
  if (fx?.pan) {
    // モノラルにしてから、寄せた側はそのまま・反対側だけ小さく
    const [l, r] = panGains(fx.pan);
    const mono = ac.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    const gl = ac.createGain();
    const gr = ac.createGain();
    gl.gain.value = l;
    gr.gain.value = r;
    const merger = ac.createChannelMerger(2);
    node.connect(mono);
    mono.connect(gl).connect(merger, 0, 0);
    mono.connect(gr).connect(merger, 0, 1);
    node = merger;
  }
  return node;
}

/** 再生する。rate は 1・2・4（順方向）か -1・-2・-4（逆方向、音なし） */
export async function play(rate = 1) {
  // 切り離したウィンドウでは、再生はメインウィンドウで行う
  if (callRemote('play', [rate])) return;
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
    const audible = audibleTracks(p);
    const voice = p.clips.filter((c): c is VoiceClip => c.type === 'voice' && !!c.audio && audible.has(c.trackId) && c.start + c.duration > startFrame);
    for (const c of voice) {
      void load(c.audio!.cacheKey).then(buf => {
        const st = getState();
        if (!buf || !st.isPlaying || st.playRate !== rate) return;
        const chr = p.characters.find(ch => ch.id === c.characterId);
        const vol = chr ? effectiveVoice(chr, c).params.volume : 1;
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const into = Math.max(0, (startFrame - c.start) / fps);
        const when = t0 + Math.max(0, (c.start - startFrame) / fps / rate);
        const at = Math.max(when, ac.currentTime);
        voiceChain(ac, src, c, vol, fps, into, at, rate).connect(ac.destination);
        // 再生開始位置で頭を飛ばす。書き出しと同じくクリップの終わりで切る
        src.start(at, startOffsetOf(c) / fps + into);
        src.stop(at + Math.max(0, c.duration / fps - into) / rate);
        sources.push(src);
      });
    }
    // 素材の音声（BGM など）。「セリフ中は下げる」トラックは書き出しと同じ動きで音量を下げる
    const intervals = voiceIntervals(p);
    const a = await api;
    const audioClips = p.clips.filter((c): c is MediaClip => c.type === 'media' && c.mediaKind === 'audio' && audible.has(c.trackId) && c.start + c.duration > startFrame);
    for (const c of audioClips) {
      const track = p.tracks.find(t => t.id === c.trackId);
      void loadUrl(a.mediaUrl(c.src, s.projectPath)).then(buf => {
        const st = getState();
        if (!buf || !st.isPlaying || st.playRate !== rate) return;
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const gain = ac.createGain();
        if (track?.duck && intervals.length) scheduleDuck(gain.gain, intervals, track.duckLevel, c.volume, t0, startFrame / fps, rate);
        else gain.gain.value = c.volume;
        src.connect(gain).connect(ac.destination);
        const into = Math.max(0, startFrame - c.start);
        const offset = (c.inPoint + into) / fps;
        const when = t0 + Math.max(0, (c.start - startFrame) / fps / rate);
        const at = Math.max(when, ac.currentTime);
        src.start(at, offset);
        src.stop(at + (c.duration - into) / fps / rate);
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
  // 切り離したウィンドウでは、再生はメインウィンドウで行う
  if (callRemote('stop', [])) return;
  cancelAnimationFrame(raf);
  stopSources();
  pauseAll();
  setState({isPlaying: false, playRate: 1});
}

export function toggle() {
  // 切り離したウィンドウでは、再生はメインウィンドウで行う
  if (callRemote('toggle', [])) return;
  if (getState().isPlaying) stop();
  else void play(1);
}

/** L：順方向に再生。再生中なら速くする（1→2→4 倍） */
export function shuttleForward() {
  // 切り離したウィンドウでは、再生はメインウィンドウで行う
  if (callRemote('shuttleForward', [])) return;
  const s = getState();
  const next = s.isPlaying && s.playRate > 0 ? Math.min(4, s.playRate * 2) : 1;
  void play(next);
}

/** J：逆方向に再生。押すたびに速くする */
export function shuttleBackward() {
  // 切り離したウィンドウでは、再生はメインウィンドウで行う
  if (callRemote('shuttleBackward', [])) return;
  const s = getState();
  const next = s.isPlaying && s.playRate < 0 ? Math.max(-4, s.playRate * 2) : -1;
  void play(next);
}

/** 1 コマ（Shift なら 1 秒）動かす。再生中なら止める */
export function step(frames: number) {
  // 切り離したウィンドウでは、再生はメインウィンドウで行う
  if (callRemote('step', [frames])) return;
  const s = getState();
  if (!s.project) return;
  if (s.isPlaying) stop();
  setState({playhead: Math.max(0, Math.min(projectDuration(s.project), s.playhead + frames))});
}

/** 前後の編集点（クリップの始まり・終わり）へ */
export function jumpToEdit(dir: 1 | -1) {
  // 切り離したウィンドウでは、再生はメインウィンドウで行う
  if (callRemote('jumpToEdit', [dir])) return;
  const s = getState();
  const p = s.project;
  if (!p) return;
  if (s.isPlaying) stop();
  const points = [...new Set([0, projectDuration(p), ...p.clips.flatMap(c => [c.start, c.start + c.duration])])].sort((a, b) => a - b);
  const next = dir > 0 ? points.find(x => x > s.playhead) : [...points].reverse().find(x => x < s.playhead);
  if (next !== undefined) setState({playhead: next});
}

export function jumpTo(where: 'start' | 'end') {
  // 切り離したウィンドウでは、再生はメインウィンドウで行う
  if (callRemote('jumpTo', [where])) return;
  const s = getState();
  if (!s.project) return;
  if (s.isPlaying) stop();
  setState({playhead: where === 'start' ? 0 : projectDuration(s.project)});
}

/** 再合成などでキャッシュキーが変わったものを捨てる */
export function forget(cacheKey: string) {
  buffers.delete(cacheKey);
}
