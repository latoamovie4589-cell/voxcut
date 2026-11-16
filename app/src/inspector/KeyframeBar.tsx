// キーフレーム（CapCut の ◆）：再生位置に今の見た目の点を足し、その点の位置・大きさ・回転・不透明度を変える。
// プレビューでドラッグしたときも、再生位置の点を動かす（なければ足す）。点は何個でも置ける
import {Button} from '@astryxdesign/core/Button';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {ChevronLeft, ChevronRight, Diamond, Trash2} from 'lucide-react';
import {Hint} from '../Hint';
import {animStateAt, keyframeTimes, removeKeyframe, setKeyframe, type VisualClip} from '../model';
import {setState, updateClip, useStore} from '../store';
import {TransformFields} from './VisualInspector';

/** 再生位置がキーフレームの上とみなす近さ（フレーム） */
const ON_KEY = 0.5;

export function KeyframeBar({clip}: {clip: VisualClip}) {
  const playhead = useStore(s => s.playhead);
  const local = playhead - clip.start;
  const inside = local >= 0 && local <= clip.duration;
  const frac = Math.min(1, Math.max(0, local / Math.max(1, clip.duration)));
  const times = keyframeTimes(clip.look);
  const frames = times.map(t => Math.round(t * clip.duration));
  const onKey = inside ? frames.findIndex(f => Math.abs(f - local) <= ON_KEY) : -1;
  const now = animStateAt(clip.transform, clip.look, frac);
  const put = (tr = now.transform, rot = now.rotation) => updateClip(clip.id, setKeyframe(clip, onKey >= 0 ? times[onKey] : frac, tr, rot) as Partial<VisualClip>);
  const jump = (f: number) => setState({playhead: clip.start + f});
  const prev = [...frames].reverse().find(f => f < local - ON_KEY);
  const next = frames.find(f => f > local + ON_KEY);
  const middle = onKey > 0 && onKey < times.length - 1;
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <Heading level={3}>キーフレーム</Heading>
      <Hint>再生位置に点（◆）を置くと、点から点へ動きます。プレビューでドラッグすると、再生位置の点が動きます（なければ足します）。</Hint>
      <HStack gap={2} wrap="wrap" vAlign="center">
        <Button size="sm" variant="secondary" icon={<Icon icon={ChevronLeft} />} label="前の点" isDisabled={prev === undefined} onClick={() => jump(prev!)} />
        <Button
          size="sm"
          variant={onKey >= 0 ? 'secondary' : 'primary'}
          icon={<Icon icon={Diamond} />}
          label={onKey >= 0 ? 'この点' : '再生位置に追加'}
          isDisabled={!inside || onKey >= 0}
          onClick={() => put()}
        />
        <Button size="sm" variant="secondary" icon={<Icon icon={ChevronRight} />} label="次の点" isDisabled={next === undefined} onClick={() => jump(next!)} />
        {middle && (
          <Button size="sm" variant="ghost" icon={<Icon icon={Trash2} />} label="この点を消す" onClick={() => updateClip(clip.id, removeKeyframe(clip, times[onKey]) as Partial<VisualClip>)} />
        )}
      </HStack>
      <Text type="supporting">{times.length ? `点 ${times.length} 個（頭と終わりを含む）` : 'まだ点はありません'}</Text>
      {onKey >= 0 && (
        <>
          <Text type="supporting">{onKey === 0 ? '頭の点' : onKey === times.length - 1 ? '終わりの点' : `${onKey + 1} 番目の点`}の値</Text>
          <TransformFields value={now.transform} onChange={tr => put(tr, now.rotation)} />
          <Slider label="回転" value={now.rotation} min={-360} max={360} step={1} valueDisplay="text" formatValue={v => `${Math.round(v)}°`} onChange={(r: number) => put(now.transform, r)} />
        </>
      )}
    </VStack>
  );
}
