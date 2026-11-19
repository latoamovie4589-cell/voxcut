// 素材の音の加工（CapCut の「ノイズ除去」「音量を均一に」「ボイスチェンジャー」）と、BGM の拍に印を付ける
import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/Layout';
import {Slider} from '@astryxdesign/core/Slider';
import {Selector} from '@astryxdesign/core/Selector';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {api} from '../ipc';
import {timelineFrameOf, type MediaAudioFx, type MediaClip, type VoiceFx} from '../model';
import {AudioFilterHint, AudioFilterMenu, AudioFilterRows, ReverbFields} from './AudioFilterFields';
import {commit, getState, updateClip, useStore} from '../store';

const VOICES: {value: VoiceFx | 'none'; label: string}[] = [
  {value: 'none', label: 'なし'},
  {value: 'high', label: '高い声'},
  {value: 'low', label: '低い声'},
  {value: 'robot', label: 'ロボット'},
  {value: 'radio', label: 'ラジオ・電話'},
  {value: 'echo', label: 'やまびこ'},
  {value: 'megaphone', label: '拡声器'},
];

export {timelineFrameOf};

export function SoundFxFields({clip, notify}: {clip: MediaClip; notify: (m: string) => void}) {
  const projectPath = useStore(s => s.projectPath);
  const fps = useStore(s => s.project!.video.fps);
  const [busy, setBusy] = useState<'' | 'norm' | 'beat'>('');
  const fx: MediaAudioFx = clip.audioFx ?? {};
  const set = (p: Partial<MediaAudioFx>) => {
    const next = {...fx, ...p};
    const plain = !next.denoise && !next.voice && next.gainDb === undefined && !next.pitch && !(next.filters ?? []).length && !next.reverb;
    updateClip(clip.id, {audioFx: plain ? undefined : next});
  };
  return (
    <>
      <Switch
        label="雑音を減らす"
        description="エアコン・ファンなどの「サー」という音を減らします"
        value={!!fx.denoise}
        onChange={on => set({denoise: on || undefined})}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      <Switch
        label="音量を均一に"
        description={
          fx.gainDb !== undefined ? `この素材を測って ${fx.gainDb >= 0 ? '+' : ''}${fx.gainDb.toFixed(1)} dB にしました` : '素材の大きさを測って、ほかの素材と同じくらいの大きさにそろえます'
        }
        value={fx.gainDb !== undefined}
        isDisabled={busy === 'norm'}
        onChange={on => {
          if (!on) return set({gainDb: undefined});
          setBusy('norm');
          void api
            .then(a => a.measureAudio(clip.src, projectPath))
            .then(r => set({gainDb: Math.round(r.gainDb * 10) / 10}))
            .catch(e => notify(String(e)))
            .finally(() => setBusy(''));
        }}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      <Selector label="声を変える" value={fx.voice ?? 'none'} options={VOICES} onChange={(v: string) => set({voice: v === 'none' ? undefined : (v as VoiceFx)})} width="100%" />
      <Slider
        label="音の高さ（長さは変わりません）"
        value={fx.pitch ?? 0}
        min={-12}
        max={12}
        step={1}
        valueDisplay="text"
        formatValue={v => (v === 0 ? 'そのまま' : `${v > 0 ? '+' : ''}${v} 半音`)}
        onChange={(pitch: number) => set({pitch: pitch === 0 ? undefined : pitch})}
      />
      <ReverbFields reverb={fx.reverb} onChange={reverb => set({reverb: reverb ?? undefined})} />
      <HStack hAlign="between" vAlign="center">
        <Text type="label">音声エフェクト</Text>
        <AudioFilterMenu filters={fx.filters ?? []} onChange={filters => set({filters: filters.length ? filters : undefined})} />
      </HStack>
      <AudioFilterHint filters={fx.filters ?? []} />
      <AudioFilterRows filters={fx.filters ?? []} onChange={filters => set({filters: filters.length ? filters : undefined})} />
      {clip.mediaKind === 'audio' && (
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button
            size="sm"
            variant="secondary"
            label={busy === 'beat' ? '拍を探しています…' : '拍に印を付ける'}
            tooltip="BGM の拍を見つけて、タイムラインに印（マーカー）を付けます。印に合わせて切ると、拍に合った切り替えになります"
            isDisabled={busy === 'beat'}
            onClick={() => {
              setBusy('beat');
              void api
                .then(a => a.detectBeats(clip.src, projectPath))
                .then(beats => {
                  const frames = [...new Set(beats.map(t => timelineFrameOf(clip, t, fps)).filter((f): f is number => f !== null && f >= clip.start && f < clip.start + clip.duration))];
                  if (!frames.length) return notify('拍が見つかりませんでした');
                  const have = new Set((getState().project?.markers ?? []).map(m => m.frame));
                  const add = frames.filter(f => !have.has(f));
                  commit(pr => {
                    const list = pr.markers ?? [];
                    const next = [...list, ...add.map((frame, i) => ({id: `mk-beat-${Date.now().toString(36)}-${i}`, frame, name: `拍 ${i + 1}`}))];
                    return {...pr, markers: next.sort((a, b) => a.frame - b.frame)};
                  });
                  notify(`拍に ${add.length} 個の印を付けました`);
                })
                .catch(e => notify(String(e)))
                .finally(() => setBusy(''));
            }}
          />
          <Text type="supporting">印は書き出しには入りません</Text>
        </HStack>
      )}
    </>
  );
}
