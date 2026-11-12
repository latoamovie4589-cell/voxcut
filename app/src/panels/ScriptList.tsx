// 台本：セリフを時間順に並べた一覧（YMM4 の台本表示に相当）。
// 選ぶとタイムラインとプレビューがその行へ動く。キーボードとスクリーンリーダーでも全部の行をたどれる。

import {Item} from '@astryxdesign/core/Item';
import {List} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/Layout';
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
  if (!lines.length) {
    return (
      <VStack padding={3}>
        <Text type="supporting">まだセリフがありません。下の入力欄に打って Enter で追加できます。</Text>
      </VStack>
    );
  }
  return (
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
  );
}
