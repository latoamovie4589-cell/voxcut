// 画面録画：パソコンの画面・ウィンドウを選んで録る（パソコンの音・マイクの声も入れられる）。
// 録ったものは WebM。保存すると Rust 側で長さを書き込む（capture.rs）

export interface Capture {
  /** 止めて、録った動画を返す */
  stop(): Promise<{data: Uint8Array; seconds: number}>;
  /** 捨てる */
  cancel(): void;
}

/** 使える形式（VP9 → VP8 → おまかせ） */
export function captureMime(): string {
  const can = (m: string) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m);
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(can) ?? '';
}

/** 画面録画を始める。onEnded は画面の共有を止めた（ブラウザ側の「共有を停止」）とき */
export async function startCapture(o: {systemAudio: boolean; mic: boolean; micId?: string; fps?: number; onEnded?: () => void}): Promise<Capture> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('この環境では画面を録画できません');
  const screen = await navigator.mediaDevices.getDisplayMedia({video: {frameRate: o.fps ?? 30}, audio: o.systemAudio});
  const streams: MediaStream[] = [screen];
  let ac: AudioContext | null = null;
  const tracks: MediaStreamTrack[] = [...screen.getVideoTracks()];
  try {
    const mic = o.mic ? await navigator.mediaDevices.getUserMedia({audio: {deviceId: o.micId ? {exact: o.micId} : undefined, echoCancellation: true}}) : null;
    if (mic) streams.push(mic);
    const audios = streams.filter(s => s.getAudioTracks().length);
    if (audios.length === 1) tracks.push(...audios[0].getAudioTracks());
    else if (audios.length > 1) {
      // パソコンの音とマイクを 1 本に混ぜる
      ac = new AudioContext();
      const dst = ac.createMediaStreamDestination();
      for (const s of audios) ac.createMediaStreamSource(s).connect(dst);
      tracks.push(...dst.stream.getAudioTracks());
    }
  } catch (e) {
    screen.getTracks().forEach(t => t.stop());
    throw e;
  }
  const mime = captureMime();
  const rec = new MediaRecorder(new MediaStream(tracks), mime ? {mimeType: mime, videoBitsPerSecond: 8_000_000} : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const t0 = performance.now();
  rec.start(1000);
  const release = () => {
    for (const s of streams) s.getTracks().forEach(t => t.stop());
    void ac?.close();
  };
  screen.getVideoTracks()[0]?.addEventListener('ended', () => o.onEnded?.());
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        const seconds = (performance.now() - t0) / 1000;
        rec.onstop = () => {
          release();
          new Blob(chunks, {type: mime || 'video/webm'}).arrayBuffer().then(b => resolve({data: new Uint8Array(b), seconds}), reject);
        };
        if (rec.state === 'inactive') rec.onstop(new Event('stop'));
        else rec.stop();
      }),
    cancel: () => {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
  };
}
