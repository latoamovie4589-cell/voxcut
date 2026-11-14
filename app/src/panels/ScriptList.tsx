// 台本：セリフを時間順に並べた一覧（YMM4 の台本表示に相当）。
// 選ぶとタイムラインとプレビューがその行へ動く。ダブルクリック（または Enter / F2）でその場で書き直せ、
// 左のつまみをドラッグ（または Alt+↑↓）で並べ替えられる。

import {useEffect, useRef, useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {ClipboardPaste, Copy, GripVertical, Replace, Search} from 'lucide-react';
import {TextInput} from '@astryxdesign/core/TextInput';
import {getNotify, synthesize} from '../actions';
import type {VoiceClip} from '../model';
import {framesToTimecode} from '../model';
import {reorderLine, replaceInLines, setState, updateClip, useStore} from '../store';

export function ScriptList() {
  const project = useStore(s => s.project);
  const selected = useStore(s => s.selectedClipId);
  const errors = useStore(s => s.synthErrors);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<{id: string; to: number} | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // 探す・置き換える（Ctrl+F でここへ）
  const [query, setQuery] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [to, setTo] = useState('');
  // Ctrl+H（App から）：置き換えの欄を開く
  useEffect(() => {
    const on = () => setReplacing(true);
    window.addEventListener('vx-open-replace', on);
    return () => window.removeEventListener('vx-open-replace', on);
  }, []);
  if (!project) return null;
  // どのトラックのセリフも、時間順に並べる
  const all = project.clips.filter((c): c is VoiceClip => c.type === 'voice').sort((a, b) => a.start - b.start);
  const nameOf = (c: VoiceClip) => project.characters.find(x => x.id === c.characterId)?.name ?? '';
  const q = query.trim();
  const hits = q ? all.filter(c => c.text.includes(q) || (c.subtitle ?? '').includes(q) || nameOf(c).includes(q)) : all;
  const lines = all;
  const shown = hits;
  const replaceAll = () => {
    const ids = replaceInLines(q, to, {onlyIds: hits.map(c => c.id)});
    if (!ids.length) return getNotify()(`「${q}」は見つかりませんでした`);
    getNotify()(`${ids.length} 行の「${q}」を「${to}」に置き換えました（音声を作り直します）`, 'info', undefined, {label: '元に戻す', onClick: () => void import('../store').then(m => m.undo())});
    void synthesize(getNotify(), ids);
  };
  const copyAll = () => {
    const text = lines.map(c => `${project.characters.find(x => x.id === c.characterId)?.name ?? ''}：${c.text}`).join('\n');
    void navigator.clipboard?.writeText(text).then(() => getNotify()(`${lines.length} 行を「名前：セリフ」の形で写しました`));
  };
  const select = (c: VoiceClip) =>
    setState(s => ({
      selectedClipId: c.id,
      playhead: c.start,
      revealSeq: s.revealSeq + 1,
    }));
  const startEdit = (c: VoiceClip) => {
    setEditing(c.id);
    setDraft(c.subtitle ?? c.text);
  };
  const commitEdit = (c: VoiceClip) => {
    const t = draft.trim();
    if (t && t !== (c.subtitle ?? c.text)) updateClip(c.id, {text: t, subtitle: null, audio: null});
    setEditing(null);
  };
  /** 同じトラックの中での番号（並べ替えは同じトラックの中だけ） */
  const indexInTrack = (c: VoiceClip) => lines.findIndex(l => l.id === c.id);

  // つまみのドラッグ：行の真ん中より上か下かで、入る場所を決める
  const onGripDown = (e: React.PointerEvent, c: VoiceClip) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({id: c.id, to: indexInTrack(c)});
  };
  const onGripMove = (e: React.PointerEvent, c: VoiceClip) => {
    if (!drag || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>('.vx-script-row')];
    let to = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        to = i;
        break;
      }
    }
    const from = indexInTrack(c);
    if (to > from && e.clientY >= rows[to].getBoundingClientRect().top + rows[to].getBoundingClientRect().height / 2) to = rows.length - 1;
    else if (to > from) to -= 1;
    if (to !== drag.to) setDrag({id: c.id, to});
  };
  const onGripUp = (c: VoiceClip) => {
    if (drag && drag.to !== indexInTrack(c)) reorderLine(c.id, drag.to);
    setDrag(null);
  };

  const header = (
    <VStack gap={1}>
      <HStack gap={1} hAlign="between" vAlign="center" paddingInlineStart={1}>
        <Text type="supporting" hasTabularNumbers>
          {q ? `${hits.length} / ${lines.length} 行` : `${lines.length} 行`}
        </Text>
        <HStack gap={0}>
          <Button label="貼り付け…" size="sm" variant="ghost" icon={<Icon icon={ClipboardPaste} />} tooltip="「名前：セリフ」の台本をまとめて追加" onClick={() => setState({pasteOpen: true})} />
          {lines.length > 0 && <IconButton label="台本を写す" tooltip="台本を文として写す（Word やメモ帳に貼れます）" size="sm" variant="ghost" icon={<Icon icon={Copy} />} onClick={copyAll} />}
          {lines.length > 0 && (
            <IconButton
              label="置き換え"
              tooltip="文を探して置き換える（Ctrl+H）"
              size="sm"
              variant="ghost"
              icon={<Icon icon={Replace} />}
              aria-pressed={replacing}
              onClick={() => setReplacing(r => !r)}
            />
          )}
        </HStack>
      </HStack>
      {lines.length > 0 && (
        <div data-script-search>
          <TextInput label="台本を探す" isLabelHidden size="sm" startIcon={Search} placeholder="台本を探す（Ctrl+F）" value={query} onChange={setQuery} width="100%" />
        </div>
      )}
      {replacing && lines.length > 0 && (
        <HStack gap={1} vAlign="center">
          <div style={{flex: 1, minWidth: 0}}>
            <TextInput label="置き換える文" isLabelHidden size="sm" placeholder="置き換える文" value={to} onChange={setTo} onEnter={replaceAll} width="100%" />
          </div>
          <Button label={`${q ? hits.length : 0} 行を置き換え`} size="sm" isDisabled={!q || !hits.length} onClick={replaceAll} />
        </HStack>
      )}
    </VStack>
  );
  if (!lines.length) {
    return (
      <VStack gap={2} padding={2}>
        {header}
        <VStack padding={2}>
          <Text type="supporting">まだセリフがありません。下の入力欄に打って Enter で追加するか、「貼り付け…」で台本をまとめて入れられます。</Text>
        </VStack>
      </VStack>
    );
  }
  const dragged = drag && lines.find(l => l.id === drag.id);
  return (
    <VStack gap={2} padding={2}>
      {header}
      <ol ref={listRef} className="vx-script" aria-label="台本（ダブルクリックで書き直し、Alt+↑↓ で並べ替え）">
        {q && !shown.length && (
          <li className="vx-script-empty">
            <Text type="supporting">「{q}」を含む行はありません</Text>
          </li>
        )}
        {shown.map(c => {
          const i = lines.indexOf(c);
          const ch = project.characters.find(x => x.id === c.characterId);
          const err = errors[c.id];
          const isSel = c.id === selected;
          const ti = indexInTrack(c);
          const dropHere = dragged && drag!.to === ti && drag!.id !== c.id;
          const below = dragged && indexInTrack(dragged) < ti;
          return (
            <li
              key={c.id}
              data-track={c.trackId}
              className={`vx-script-row${isSel ? ' is-selected' : ''}${drag?.id === c.id ? ' is-dragging' : ''}${dropHere ? (below ? ' drop-after' : ' drop-before') : ''}`}
              tabIndex={0}
              aria-selected={isSel}
              onClick={() => select(c)}
              onDoubleClick={() => startEdit(c)}
              onKeyDown={e => {
                if (editing === c.id) return;
                if (e.key === 'Enter' || e.key === 'F2') {
                  e.preventDefault();
                  startEdit(c);
                } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                  e.preventDefault();
                  reorderLine(c.id, ti + (e.key === 'ArrowUp' ? -1 : 1));
                  requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('.vx-script-row.is-selected')?.focus());
                }
              }}>
              <span
                className="vx-script-grip"
                title="ドラッグで並べ替え"
                aria-hidden
                onPointerDown={e => onGripDown(e, c)}
                onPointerMove={e => onGripMove(e, c)}
                onPointerUp={() => onGripUp(c)}
                onPointerCancel={() => setDrag(null)}
                onClick={e => e.stopPropagation()}>
                <Icon icon={GripVertical} size="sm" color="secondary" />
              </span>
              <span className="vx-swatch" style={{background: ch?.color ?? '#8E8E93'}} aria-hidden />
              <div className="vx-script-body">
                {editing === c.id ? (
                  <textarea
                    className="vx-script-edit"
                    aria-label={`${i + 1} 行目のセリフ`}
                    value={draft}
                    autoFocus
                    rows={2}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={() => commitEdit(c)}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        commitEdit(c);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditing(null);
                      }
                    }}
                  />
                ) : (
                  <Text maxLines={2}>{(c.subtitle ?? c.text) || '（空のセリフ）'}</Text>
                )}
                <div className="vx-script-meta">
                  <Text type="supporting" hasTabularNumbers>
                    {i + 1}. {ch?.name ?? '?'} · {framesToTimecode(c.start, project.video.fps)}
                  </Text>
                  {err ? <Badge variant="error" label="合成できず" /> : !c.audio ? <Badge label="未合成" /> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </VStack>
  );
}
