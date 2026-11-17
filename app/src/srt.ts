// 字幕ファイル（.srt・.vtt）を読む。時刻はフレームに直す

export interface SubtitleCue {
  start: number;
  duration: number;
  text: string;
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

const secs = (h: string | undefined, m: string, s: string, ms: string) => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

/** SRT・WebVTT の字幕を読む（番号・VTT の見出し・タグは無視。改行は残す） */
export function parseSubtitles(text: string, fps: number): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  const blocks = text
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => TIME.test(l));
    if (i < 0) continue;
    const m = TIME.exec(lines[i])!;
    const a = secs(m[1], m[2], m[3], m[4]);
    const e = secs(m[5], m[6], m[7], m[8]);
    const body = lines
      .slice(i + 1)
      .map(l =>
        l
          .replace(/<[^>]+>/g, '')
          .replace(/\{\\[^}]*\}/g, '')
          .trim(),
      )
      .filter(Boolean)
      .join('\n');
    if (!body || e <= a) continue;
    const start = Math.round(a * fps);
    out.push({start, duration: Math.max(1, Math.round(e * fps) - start), text: body});
  }
  return out.sort((x, y) => x.start - y.start);
}
