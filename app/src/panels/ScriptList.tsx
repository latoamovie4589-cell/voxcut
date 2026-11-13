// 台本：セリフを時間順に並べた一覧（YMM4 の台本表示に相当）。
// 選ぶとタイムラインとプレビューがその行へ動く。ダブルクリック（または Enter / F2）でその場で書き直せ、
// 左のつまみをドラッグ（または Alt+↑↓）で並べ替えられる。

import {useRef, useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {ClipboardPaste, Copy, GripVertical} from 'lucide-react';
import {getNotify} from '../actions';
import type {VoiceClip} from '../model';
import {framesToTimecode} from '../model';
import {reorderLine, setState, updateClip, useStore} from '../store';

export function ScriptList() {
  const project = useStore(s => s.project);
  const selected = useStore(s => s.selectedClipId);
  const errors = useStore(s => s.synthErrors);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<{id: string; to: number} | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  if (!project) return null;
  // どのトラックのセリフも、時間順に並べる
  const lines = project.clips.filter((c): c is VoiceClip => c.type === 'voice').sort((a, b) => a.start - b.start);
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
    <HStack gap={1} hAlign="between" vAlign="center" paddingInlineStart={1}>
      <Text type="supporting">{lines.length} 行</Text>
      <HStack gap={0}>
        <Button label="貼り付け…" size="sm" variant="ghost" icon={<Icon icon={ClipboardPaste} />} tooltip="「名前：セリフ」の台本をまとめて追加" onClick={() => setState({pasteOpen: true})} />
        {lines.length > 0 && <IconButton label="台本を写す" tooltip="台本を文として写す（Word やメモ帳に貼れます）" size="sm" variant="ghost" icon={<Icon icon={Copy} />} onClick={copyAll} />}
      </HStack>
    </HStack>
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
        {lines.map((c, i) => {
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
