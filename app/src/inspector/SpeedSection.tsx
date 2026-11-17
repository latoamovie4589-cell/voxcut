// 素材の「速さ」（CapCut の速度）：速さ・だんだん速く/遅く・逆再生・静止（フリーズ）
import {Button} from '@astryxdesign/core/Button';
import {Slider} from '@astryxdesign/core/Slider';
import {Switch} from '@astryxdesign/core/Switch';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Icon} from '@astryxdesign/core/Icon';
import {Snowflake} from 'lucide-react';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';
import {framesToTimecode, speedsOf, srcSpan, type MediaClip} from '../model';
import {freezeFrame, getState, setMediaFlag, setMediaSpeed, updateClip, useStore} from '../store';

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <Heading level={3}>{title}</Heading>
      {children}
    </VStack>
  );
}

const PRESETS = ['0.5', '1', '1.5', '2', '3'];
const fmt = (v: number) => `${Math.round(v * 100) / 100} 倍`;

export function SpeedSection({clip, notify}: {clip: MediaClip; notify: (m: string) => void}) {
  const fps = useStore(s => s.project!.video.fps);
  const [a, b] = speedsOf(clip);
  const ramp = Math.abs(a - b) > 1e-9;
  const preset = !ramp && PRESETS.find(p => Math.abs(Number(p) - a) < 1e-9);
  return (
    <Section title="速さ">
      {clip.freeze ? (
        <Text type="supporting">静止しています（切り出し位置のコマを出し続けます。音は出しません）</Text>
      ) : (
        <>
          <SegmentedControl label="速さ" size="sm" value={preset || ''} onChange={v => setMediaSpeed(clip.id, Number(v))}>
            {PRESETS.map(p => (
              <SegmentedControlItem key={p} value={p} label={`${p}×`} />
            ))}
          </SegmentedControl>
          <Slider
            label={ramp ? '頭の速さ' : '速さ'}
            value={a}
            min={0.1}
            max={10}
            step={0.05}
            valueDisplay="text"
            formatValue={fmt}
            onChange={(v: number) => setMediaSpeed(clip.id, v, ramp ? b : undefined)}
          />
          <Switch
            label="だんだん変える"
            description="頭の速さから終わりの速さへ、なめらかに変えます"
            value={ramp}
            onChange={on => setMediaSpeed(clip.id, on ? 1 : a, on ? 3 : undefined)}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
          />
          {ramp && (
            <>
              <Slider label="終わりの速さ" value={b} min={0.1} max={10} step={0.05} valueDisplay="text" formatValue={fmt} onChange={(v: number) => setMediaSpeed(clip.id, a, v)} />
              <HStack gap={2} wrap="wrap">
                <Button size="sm" variant="secondary" label="だんだん速く" onClick={() => setMediaSpeed(clip.id, 1, 3)} />
                <Button size="sm" variant="secondary" label="だんだん遅く" onClick={() => setMediaSpeed(clip.id, 3, 0.5)} />
              </HStack>
            </>
          )}
          <Switch label="逆再生" value={!!clip.reverse} onChange={on => setMediaFlag(clip.id, 'reverse', on)} labelPosition="start" labelSpacing="spread" width="100%" />
          {clip.mediaKind === 'video' && Math.min(a, b) < 1 && (
            <VStack gap={1}>
              <Switch label="なめらかスロー" value={!!clip.smooth} onChange={on => updateClip(clip.id, {smooth: on || undefined})} labelPosition="start" labelSpacing="spread" width="100%" />
              <Text type="supporting">遅くしたところのコマを、動きから作って補います（書き出しで効きます。書き出しに時間がかかります）</Text>
            </VStack>
          )}
          <Text type="supporting" hasTabularNumbers>
            素材の {framesToTimecode(Math.round(srcSpan(clip)), fps)} 分を {framesToTimecode(clip.duration, fps)} で{clip.reverse ? '逆から' : ''}再生（音の高さは変わりません）
          </Text>
        </>
      )}
      {clip.mediaKind === 'video' && (
        <HStack gap={2} wrap="wrap">
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon icon={Snowflake} />}
            label="再生位置で 3 秒止める"
            tooltip="再生位置のコマを 3 秒間止めて見せます（後ろのアイテムは 3 秒ずれます）"
            onClick={() => {
              if (!freezeFrame(clip.id, getState().playhead)) notify('再生位置をこの動画の上に動かしてください');
            }}
          />
          {clip.freeze && <Button size="sm" variant="ghost" label="静止をやめる" onClick={() => setMediaFlag(clip.id, 'freeze', false)} />}
        </HStack>
      )}
    </Section>
  );
}
