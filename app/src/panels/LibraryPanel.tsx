// 素材ライブラリ：よく使う画像・動画・効果音・BGM を、プロジェクトをまたいで使う。
// 押すと再生位置に置き、タイムラインへドラッグすると落とした所に置く。分類（効果音・BGM など）で絞り込める。

import {useEffect, useMemo, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Film, Image as ImageIcon, Music, Play, Square} from 'lucide-react';
import {addMediaPaths, getNotify} from '../actions';
import {api, type LibraryItem} from '../ipc';
import {getState, useStore} from '../store';
import {timelineHit} from '../timeline/Timeline';

type Kind = 'all' | LibraryItem['kind'];
const KIND_ICON = {image: ImageIcon, video: Film, audio: Music};
/** 分類なしを表す値（Selector の値に空文字は使えないので） */
const NONE = '__none';
const ALL = '__all';

let version = 0;
const listeners = new Set<() => void>();
/** 一覧が変わったことを知らせる（ほかのウィンドウ・パネルも読み直す） */
export function libraryChanged() {
  version++;
  listeners.forEach(f => f());
}

export function LibraryPanel() {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [folder, setFolder] = useState(ALL);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const projectPath = useStore(s => s.projectPath);
  // 選んだ素材のパス（文字にまとめて購読する。配列を返すと毎回変わったことになる）
  const selectedKey = useStore(s => {
    const p = s.project;
    const ids = new Set([...s.selectedClipIds, s.selectedClipId]);
    return p ? [...new Set(p.clips.flatMap(c => (ids.has(c.id) && c.type === 'media' ? [c.src] : [])))].join('\n') : '';
  });
  const selectedMedia = selectedKey ? selectedKey.split('\n') : [];

  const reload = () => void api.then(a => a.libraryList()).then(setItems, () => setItems([]));
  useEffect(() => {
    reload();
    const f = () => reload();
    listeners.add(f);
    return () => {
      listeners.delete(f);
      audio.current?.pause();
    };
  }, []);

  const folders = useMemo(() => [...new Set((items ?? []).map(i => i.folder).filter(Boolean))].sort(), [items]);
  const shown = (items ?? []).filter(
    i =>
      (kind === 'all' || i.kind === kind) &&
      (folder === ALL || (folder === NONE ? !i.folder : i.folder === folder)) &&
      (!query.trim() || i.name.toLowerCase().includes(query.trim().toLowerCase()) || i.folder.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const intoFolder = folder === ALL || folder === NONE ? '' : folder;

  const add = async (paths: string[], from: string | null) => {
    if (!paths.length) return;
    try {
      const a = await api;
      const got = await a.libraryAdd(paths, intoFolder, from);
      libraryChanged();
      getNotify()(got.length ? `${got.length} 個をライブラリに入れました` : '画像・動画・音声のファイルを入れられます', got.length ? 'info' : 'error');
    } catch (e) {
      getNotify()(String(e), 'error');
    }
  };
  const pickFiles = async () => add(await (await api).pickMedia('media', true), null);

  const place = async (it: LibraryItem, drop?: {frame: number; trackId?: string}) => {
    await addMediaPaths([it.path], drop);
    getNotify()(drop ? `「${it.name}」を置きました` : `「${it.name}」を再生位置に置きました`);
  };

  const listen = async (it: LibraryItem) => {
    audio.current?.pause();
    if (playing === it.id) return setPlaying(null);
    const el = new Audio((await api).mediaUrl(it.path, null));
    audio.current = el;
    el.onended = () => setPlaying(p => (p === it.id ? null : p));
    setPlaying(it.id);
    void el.play().catch(() => setPlaying(null));
  };

  // タイムラインへドラッグ（ポインターで動かす。Windows の WebView ではファイルのドロップと HTML のドラッグが両立しないため）
  const drag = (it: LibraryItem) => (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost: HTMLDivElement | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'vx-library-ghost';
        ghost.textContent = it.name;
        document.body.appendChild(ghost);
      }
      ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
      ghost.dataset.over = timelineHit.current?.(ev.clientX, ev.clientY) ? '1' : '';
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!ghost) return;
      ghost.remove();
      const hit = timelineHit.current?.(ev.clientX, ev.clientY);
      if (hit) void place(it, hit);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const update = async (id: string, patch: {name?: string; folder?: string}) => {
    await (await api).libraryUpdate(id, patch);
    libraryChanged();
  };
  const remove = async (id: string) => {
    await (await api).libraryRemove(id);
    setConfirm(null);
    libraryChanged();
  };

  return (
    <VStack gap={3} padding={3} data-library>
      <HStack gap={2} wrap="wrap">
        <Button label="ファイルを入れる…" size="sm" variant="secondary" onClick={() => void pickFiles()} />
        <Button
          label={selectedMedia.length > 1 ? `選んだ素材 ${selectedMedia.length} 個を入れる` : '選んだ素材を入れる'}
          size="sm"
          variant="ghost"
          isDisabled={!selectedMedia.length}
          tooltip="タイムラインで選んだ画像・動画・音声を、ほかのプロジェクトでも使えるようにします"
          onClick={() => void add(selectedMedia, projectPath ?? getState().projectPath)}
        />
      </HStack>
      <SegmentedControl label="種類" layout="fill" value={kind} onChange={k => setKind(k as Kind)}>
        <SegmentedControlItem value="all" label="すべて" />
        <SegmentedControlItem value="image" label="画像" />
        <SegmentedControlItem value="video" label="動画" />
        <SegmentedControlItem value="audio" label="音声" />
      </SegmentedControl>
      <HStack gap={2}>
        <div style={{flex: 1, minWidth: 0}}>
          <Selector
            label="分類"
            isLabelHidden
            value={folder}
            options={[{value: ALL, label: 'すべての分類'}, ...folders.map(f => ({value: f, label: f})), {value: NONE, label: '分類なし'}]}
            onChange={v => setFolder(v as string)}
            width="100%"
          />
        </div>
        <div style={{flex: 1, minWidth: 0}}>
          <TextInput label="探す" isLabelHidden placeholder="名前で探す" value={query} onChange={setQuery} />
        </div>
      </HStack>
      {items === null ? (
        <Text type="supporting">読み込んでいます…</Text>
      ) : !items.length ? (
        <VStack gap={1}>
          <Text>ライブラリは空です</Text>
          <Text type="supporting">
            よく使う効果音・BGM・画像を入れておくと、どのプロジェクトからでも押すだけ（タイムラインへドラッグ）で置けます。入れたファイルはアプリのフォルダに写すので、元を動かしても使えます
          </Text>
        </VStack>
      ) : !shown.length ? (
        <Text type="supporting">合うものがありません</Text>
      ) : (
        <div className="vx-library">
          {shown.map(it => (
            <div key={it.id} className="vx-library-item" data-library-item={it.id} onPointerDown={drag(it)}>
              <div className="vx-library-thumb">{it.kind === 'image' ? <img src={apiUrl(it.path)} alt="" draggable={false} /> : <Icon icon={KIND_ICON[it.kind]} />}</div>
              {editing === it.id ? (
                <EditRow
                  item={it}
                  confirming={confirm === it.id}
                  onSave={patch => void update(it.id, patch)}
                  onRemove={() => (confirm === it.id ? void remove(it.id) : setConfirm(it.id))}
                  onDone={() => (setEditing(null), setConfirm(null))}
                />
              ) : (
                <>
                  <VStack gap={0} style={{flex: 1, minWidth: 0}}>
                    <Text className="vx-library-name">{it.name}</Text>
                    {it.folder && <Text type="supporting">{it.folder}</Text>}
                  </VStack>
                  {it.kind === 'audio' && (
                    <IconButton label={playing === it.id ? '止める' : '聞く'} size="sm" variant="ghost" icon={<Icon icon={playing === it.id ? Square : Play} />} onClick={() => void listen(it)} />
                  )}
                  <Button label="置く" size="sm" variant="ghost" onClick={() => void place(it)} />
                  <Button label="直す" size="sm" variant="ghost" onClick={() => setEditing(it.id)} />
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </VStack>
  );
}

/** 名前と分類を直す・外す */
function EditRow({
  item,
  confirming,
  onSave,
  onRemove,
  onDone,
}: {
  item: LibraryItem;
  confirming: boolean;
  onSave: (p: {name: string; folder: string}) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [folder, setFolder] = useState(item.folder);
  return (
    <VStack gap={1} style={{flex: 1, minWidth: 0}}>
      <TextInput label="名前" size="sm" value={name} onChange={setName} />
      <TextInput label="分類" size="sm" placeholder="効果音・BGM など" value={folder} onChange={setFolder} />
      <HStack gap={1} hAlign="end">
        <Button label={confirming ? 'ファイルも消して外す' : 'ライブラリから外す'} size="sm" variant={confirming ? 'secondary' : 'ghost'} onClick={onRemove} />
        <Button
          label="できた"
          size="sm"
          variant="primary"
          onClick={() => {
            if (name !== item.name || folder !== item.folder) onSave({name, folder});
            onDone();
          }}
        />
      </HStack>
    </VStack>
  );
}

let urlOf: ((p: string) => string) | null = null;
void api.then(a => (urlOf = p => a.mediaUrl(p, null)));
const apiUrl = (p: string) => (urlOf ? urlOf(p) : p);

// 一覧の読み直しを数で知らせる（テスト用）
export const libraryVersion = () => version;
