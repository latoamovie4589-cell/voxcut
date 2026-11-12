// 波形ピークのキャッシュ（タイムラインとプレビューで共有）。
import {api} from './ipc';
import {clipMax} from './lipsync';

const peaks = new Map<string, {data: Int8Array; max: number}>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

export function getPeaks(key: string) {
  const p = peaks.get(key);
  if (!p && !pending.has(key)) {
    pending.set(
      key,
      api
        .then(a => a.waveform(key))
        .then(d => void peaks.set(key, {data: d, max: clipMax(d)}))
        .catch(() => void peaks.set(key, {data: new Int8Array(), max: 0}))
        .finally(() => {
          pending.delete(key);
          listeners.forEach(l => l());
        }),
    );
  }
  return p;
}

/** ピークが届いたときに呼ばれる */
export function onPeaks(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
