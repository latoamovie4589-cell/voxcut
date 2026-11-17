// 無音カット（ジャンプカット）：話していないところを切り取って詰める
import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import type {MediaClip} from '../model';
import {cutSilence, type Notify} from '../actions';

/** 詰め方：静かとみなす音の大きさ・長さと、話の前後に残す長さ */
const LEVELS = {
  soft: {thresholdDb: -45, minLen: 1.0, pad: 0.25, label: 'ゆるめ'},
  normal: {thresholdDb: -38, minLen: 0.6, pad: 0.15, label: 'ふつう'},
  hard: {thresholdDb: -32, minLen: 0.35, pad: 0.08, label: 'きつめ'},
} as const;
type Level = keyof typeof LEVELS;

export function SilenceCutSection({clip, notify}: {clip: MediaClip; notify: Notify}) {
  const [level, setLevel] = useState<Level>('normal');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const sec = await cutSilence(clip.id, LEVELS[level]);
      notify(sec > 0 ? `静かなところを ${sec.toFixed(1)} 秒ぶん詰めました（元に戻すで戻せます）` : '詰められる静かなところはありませんでした');
    } catch (e) {
      notify(`詰められませんでした：${String(e).replace(/^Error:\s*/, '')}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <Heading level={3}>無音カット</Heading>
      <Text type="supporting">話していないところを見つけて切り取り、後ろを前へ詰めます。後ろにあるほかのアイテムも一緒に詰まります</Text>
      <SegmentedControl label="詰め方" layout="fill" value={level} onChange={v => setLevel(v as Level)}>
        {(Object.keys(LEVELS) as Level[]).map(k => (
          <SegmentedControlItem key={k} value={k} label={LEVELS[k].label} />
        ))}
      </SegmentedControl>
      <HStack>
        <Button size="sm" variant="secondary" label={busy ? '調べています…' : '静かなところを詰める'} isDisabled={busy || !!clip.freeze} onClick={() => void run()} />
      </HStack>
    </VStack>
  );
}
