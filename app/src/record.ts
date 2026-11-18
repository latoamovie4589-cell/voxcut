// マイクで録音する：マイクの音を PCM のまま集め、止めたら WAV（16bit・モノラル）にする。

/** 集めた音（-1〜1）を WAV のバイト列にする */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // モノラル
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

export interface Recorder {
  /** 止めて、録った音（WAV）を返す */
  stop(): Promise<{wav: Uint8Array; seconds: number}>;
  /** やめる（何も返さない） */
  cancel(): void;
}

/** 使えるマイク（名前はマイクを許可したあとでないと出ないことがある） */
export async function listMics(): Promise<{id: string; label: string}[]> {
  const ds = await navigator.mediaDevices.enumerateDevices();
  return ds.filter(d => d.kind === 'audioinput').map((d, i) => ({id: d.deviceId, label: d.label || `マイク ${i + 1}`}));
}

/**
 * 録音を始める。level には今の音の大きさ（0〜1）を 1 秒に何度か渡す。
 * noise：雑音を減らす（ブラウザの機能）。マイクを許可していなければ、ここで聞かれる
 */
export async function startRecording(opt: {deviceId?: string; noise?: boolean; level?: (v: number) => void}): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {deviceId: opt.deviceId ? {exact: opt.deviceId} : undefined, echoCancellation: false, noiseSuppression: !!opt.noise, autoGainControl: false, channelCount: 1},
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor は古いが、ファイルを分けずに使えて、どのブラウザでも動く
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = e => {
    const d = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(d));
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    opt.level?.(Math.min(1, Math.sqrt(s / d.length) * 4));
  };
  // 出力はつながないと動かないので、音の出ない先へつなぐ
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  const close = () => {
    proc.disconnect();
    src.disconnect();
    stream.getTracks().forEach(t => t.stop());
    void ctx.close();
  };
  return {
    async stop() {
      close();
      const n = chunks.reduce((a, c) => a + c.length, 0);
      const all = new Float32Array(n);
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      return {wav: encodeWav(all, ctx.sampleRate), seconds: n / ctx.sampleRate};
    },
    cancel: close,
  };
}
