// 動画素材のプレビュー。プロキシ（360p・キーフレーム 0.5 秒間隔）を <video> で読み、Canvas に描く。
// 止まっているときは目的の時刻へシーク、再生中は再生させて、ずれが大きいときだけシークし直す。

const videos = new Map<string, HTMLVideoElement>();

export function videoFor(url: string, onFrame: () => void): HTMLVideoElement {
  let v = videos.get(url);
  if (!v) {
    const el = document.createElement('video');
    v = el;
    el.preload = 'auto';
    el.playsInline = true;
    el.muted = true;
    el.addEventListener('seeked', onFrame);
    el.addEventListener('loadeddata', onFrame);
    // crossOrigin は付けない：asset プロトコルは別オリジン扱いで、CORS ヘッダーが無いと読めなくなる。
    // Canvas に描くだけ（画素を読み出さない）なので汚染されても困らない
    el.src = url;
    // WebView によっては独自スキームの動画を直接読めない（Linux の WebKitGTK など）。
    // 読み込みが進まないときは、プロキシ（小さい）を丸ごと取ってきて Blob URL で読む
    const fallback = () => {
      if (el.readyState >= 2 || el.dataset.blob) return;
      el.dataset.blob = '1';
      void fetch(url)
        .then(r => r.blob())
        .then(b => {
          el.src = URL.createObjectURL(b);
        })
        .catch(() => {});
    };
    el.addEventListener('error', fallback, {once: true});
    setTimeout(fallback, 2500);
    videos.set(url, el);
  }
  return v;
}

/** 目的の時刻（秒）に合わせる。描ける状態なら true */
export function syncVideo(v: HTMLVideoElement, t: number, playing: boolean, volume: number, rate = 1): boolean {
  const target = Math.max(0, Math.min(t, (v.duration || Infinity) - 0.001));
  // 逆再生は <video> ではできないので、止めたまま 1 コマずつシークする（音は出さない）
  if (playing && rate > 0) {
    v.playbackRate = rate;
    v.muted = volume <= 0;
    v.volume = Math.min(1, Math.max(0, volume));
    if (v.paused) {
      v.currentTime = target;
      void v.play().catch(() => {});
    } else if (Math.abs(v.currentTime - target) > 0.2 * rate) {
      v.currentTime = target;
    }
  } else {
    if (!v.paused) v.pause();
    v.muted = true;
    if (Math.abs(v.currentTime - target) > 0.02 && !v.seeking) v.currentTime = target;
  }
  return v.readyState >= 2;
}

/** 使っていない動画を止める */
export function pauseExcept(active: Set<HTMLVideoElement>) {
  for (const v of videos.values()) if (!active.has(v) && !v.paused) v.pause();
}

export function pauseAll() {
  pauseExcept(new Set());
}
