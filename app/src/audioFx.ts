// 音の加工のプレビュー：書き出しと同じフィルターで素材まるごとを加工した WAV を作ってもらい、それを鳴らす
import {api as apiP} from './ipc';
import {hasAudioFx, type MediaClip} from './model';

type Entry = {url: string | null; error?: string};
const done = new Map<string, Entry>();
const pending = new Set<string>();
const listeners = new Set<() => void>();

const keyOf = (m: MediaClip, projectPath: string | null) => JSON.stringify([projectPath, m.src, m.audioFx]);

/** 加工した音の URL。まだなら作り始めて null（できたら onReady） */
export function processedAudio(m: MediaClip, projectPath: string | null, onReady: () => void): string | null {
  if (!hasAudioFx(m)) return null;
  const key = keyOf(m, projectPath);
  const hit = done.get(key);
  if (hit) return hit.url;
  listeners.add(onReady);
  if (!pending.has(key)) {
    pending.add(key);
    void apiP
      .then(a => a.processAudio(m.src, projectPath, m.audioFx!))
      .then(url => done.set(key, {url}))
      .catch(e => done.set(key, {url: null, error: String(e)}))
      .finally(() => {
        pending.delete(key);
        listeners.forEach(cb => cb());
        listeners.clear();
      });
  }
  return null;
}
