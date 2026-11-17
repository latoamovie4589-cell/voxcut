// モーショントラッキング（CapCut のトラッキング）：下の動画の中の物に、文字やスタンプを付いて動かす
import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {Heading, Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import type {VisualClip} from '../model';
import {getNotify, trackItem, videoUnder, watchAi} from '../actions';
import {useStore} from '../store';

const SIZES = {small: 0.04, normal: 0.06, large: 0.1} as const;
type Size = keyof typeof SIZES;

export function TrackSection({clip}: {clip: VisualClip}) {
  // 下に動画があるときだけ出す（プロジェクトが変わったら調べ直す）
  useStore(s => s.project);
  const video = videoUnder(clip.id);
  const [busy, setBusy] = useState<number | null>(null);
  const [size, setSize] = useState<Size>('normal');
  if (!video) return null;
  const run = async () => {
    const notify = getNotify();
    setBusy(0);
    const unwatch = await watchAi(p => {
      if (p.stage === 'track') setBusy(p.ratio);
    });
    try {
      await trackItem(clip.id, SIZES[size]);
      notify('動画の動きに付いていくようにしました（位置のキーフレーム）');
    } catch (e) {
      notify(`追えませんでした：${String(e).replace(/^Error:\s*/, '')}`, 'error');
    } finally {
      unwatch();
      setBusy(null);
    }
  };
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <Heading level={3}>動きに付いていく</Heading>
        <Text type="supporting">このアイテムの頭の時点で、追わせたい物の上にアイテムを置いてから押してください。下の動画の中でその物を追い、アイテムが付いて動きます</Text>
        <VStack gap={1}>
          <Text type="label">追う範囲</Text>
          <SegmentedControl label="追う範囲" layout="fill" value={size} onChange={v => setSize(v as Size)}>
            <SegmentedControlItem value="small" label="小さめ" />
            <SegmentedControlItem value="normal" label="ふつう" />
            <SegmentedControlItem value="large" label="大きめ" />
          </SegmentedControl>
        </VStack>
        {busy !== null ? (
          <ProgressBar label="動きを追っています" value={busy * 100} hasValueLabel />
        ) : (
          <HStack>
            <Button size="sm" variant="secondary" label="動画の動きに付いていく" onClick={() => void run()} />
          </HStack>
        )}
      </VStack>
      <Divider />
    </>
  );
}
