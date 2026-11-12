// エクスプローラーからのドラッグ＆ドロップ。
// 画像・動画・音声 → 再生位置に素材として追加、.voxcut → 開く、.voxchar → キャラクターを読み込む。

import {useEffect} from 'react';
import {isTauri} from './ipc';
import {setState} from './store';
import {addMediaPaths, importCharacterFile, openProject, type Notify} from './actions';

const MEDIA = /\.(png|jpe?g|webp|bmp|gif|avif|mp4|mov|mkv|webm|avi|wav|mp3|m4a|aac|flac|ogg)$/i;

export async function handleDrop(paths: string[], notify: Notify) {
  const project = paths.find(p => /\.voxcut$/i.test(p));
  if (project) return openProject(notify, project);
  for (const p of paths.filter(p => /\.voxchar$/i.test(p))) await importCharacterFile(notify, p);
  const media = paths.filter(p => MEDIA.test(p));
  if (media.length) {
    await addMediaPaths(media);
    notify(`${media.length} 個の素材を再生位置に追加しました`);
  }
  const other = paths.length - media.length - paths.filter(p => /\.voxchar$/i.test(p)).length;
  if (other > 0) notify('画像・動画・音声・.voxcut・.voxchar のファイルを置けます', 'error');
}

export function useFileDrop(notify: Notify) {
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    void import('@tauri-apps/api/webview').then(({getCurrentWebview}) =>
      getCurrentWebview()
        .onDragDropEvent(e => {
          const t = e.payload.type;
          if (t === 'enter' || t === 'over') setState({dropActive: true});
          else if (t === 'leave') setState({dropActive: false});
          else if (t === 'drop') {
            setState({dropActive: false});
            void handleDrop(e.payload.paths, notify);
          }
        })
        .then(u => (off = u)),
    );
    return () => off?.();
  }, [notify]);
}
