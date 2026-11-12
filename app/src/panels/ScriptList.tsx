// 台本：セリフを時間順に並べた一覧（YMM4 の台本表示に相当）。
// 選ぶとタイムラインとプレビューがその行へ動く。キーボードとスクリーンリーダーでも全部の行をたどれる。

import {Item} from '@astryxdesign/core/Item';
import {List} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {ClipboardPaste, Copy} from 'lucide-react';
import {getNotify} from '../actions';
import type {VoiceClip} from '../model';
import {framesToTimecode} from '../model';
import {setState, useStore} from '../store';

export function ScriptList() {
  const project = useStore(s => s.project);
  const selected = useStore(s => s.selectedClipId);
  const errors = useStore(s => s.synthErrors);
  if (!project) return null;
  const voiceTracks = new Set(project.tracks.filter(t => t.kind === 'voice').map(t => t.id));
  const lines = project.clips
    .filter((c): c is VoiceClip => c.type === 'voice' && voiceTracks.has(c.trackId))
    .sort((a, b) => a.start - b.start);
  const copyAll = () => {
    const text = lines.map(c => `${project.characters.find(x => x.id === c.characterId)?.name ?? ''}：${c.text}`).join('\n');
    void navigator.clipboard?.writeText(text).then(() => getNotify()(`${lines.length} 行を「名前：セリフ」の形で写しました`));
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
      <VStack gap={2}>
        {header}
        <VStack padding={2}>
          <Text type="supporting">まだセリフがありません。下の入力欄に打って Enter で追加するか、「貼り付け…」で台本をまとめて入れられます。</Text>
        </VStack>
      </VStack>
    );
  }
  return (
    <VStack gap={2}>
    {header}
    <List density="compact" aria-label="台本">
      {lines.map((c, i) => {
        const ch = project.characters.find(x => x.id === c.characterId);
        const state = errors[c.id] ? '⚠ 合成できませんでした' : c.audio ? '' : '未合成';
        return (
          <Item
            key={c.id}
            as="li"
            density="compact"
            label={c.text || '（空のセリフ）'}
            labelLines={2}
            description={[`${i + 1}. ${ch?.name ?? '?'}`, framesToTimecode(c.start, project.video.fps), state].filter(Boolean).join(' · ')}
            startContent={<span className="vx-swatch" style={{background: ch?.color ?? '#8E8E93'}} aria-hidden />}
            isSelected={c.id === selected}
            onClick={() => setState(s => ({selectedClipId: c.id, playhead: c.start, revealSeq: s.revealSeq + 1}))}
          />
        );
      })}
    </List>
    </VStack>
  );
}
