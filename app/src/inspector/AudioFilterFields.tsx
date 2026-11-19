// 声・素材の音に掛ける音声エフェクトの編集（イコライザー・コンプレッサー・リミッター・リバーブ）。
// セリフの「聞こえ方」と、素材の音の加工で同じものを使う（書き出しも同じ値で掛かる）
import {DropdownMenu, DropdownMenuItem, DropdownMenuDivider} from '@astryxdesign/core/DropdownMenu';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Slider} from '@astryxdesign/core/Slider';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {Plus, X} from 'lucide-react';
import {Hint} from '../Hint';
import {AUDIO_FILTER_LABELS, defaultReverb, newAudioFilter, type AudioFilter, type AudioFilterKind, type Reverb} from '../model';

const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

/** 「追加」メニュー：よく使う組み合わせと、1 つずつのエフェクト */
export function AudioFilterMenu({filters, onChange}: {filters: AudioFilter[]; onChange: (f: AudioFilter[]) => void}) {
  const add = (...f: AudioFilter[]) => onChange([...filters, ...f]);
  const one = (kind: AudioFilterKind) => <DropdownMenuItem key={kind} label={AUDIO_FILTER_LABELS[kind]} onClick={() => add(newAudioFilter(kind))} />;
  return (
    <DropdownMenu button={{label: '追加', size: 'sm', variant: 'ghost', icon: <Icon icon={Plus} />}} menuWidth={220}>
      <DropdownMenuItem label="電話風" onClick={() => add({kind: 'highpass', hz: 400}, {kind: 'lowpass', hz: 3000})} />
      <DropdownMenuItem label="こもった声（壁の向こう）" onClick={() => add({kind: 'lowpass', hz: 800})} />
      <DropdownMenuItem label="声をくっきり（低音を削って高音を足す）" onClick={() => add({kind: 'highpass', hz: 90}, {kind: 'eq', lowDb: -2, midDb: 2, highDb: 3, midHz: 2500})} />
      <DropdownMenuItem
        label="声をそろえる（実況向け）"
        onClick={() => add({kind: 'highpass', hz: 80}, {kind: 'compressor', thresholdDb: -22, ratio: 3.5, attackMs: 8, releaseMs: 150, makeupDb: 4}, {kind: 'limiter', ceilingDb: -1})}
      />
      <DropdownMenuDivider />
      {one('eq')}
      {one('compressor')}
      {one('limiter')}
      {one('highpass')}
      {one('lowpass')}
    </DropdownMenu>
  );
}

/** 掛けているエフェクトの一覧（上から順に掛かる） */
export function AudioFilterRows({filters, onChange}: {filters: AudioFilter[]; onChange: (f: AudioFilter[]) => void}) {
  const setF = (i: number, f: AudioFilter | null) => onChange(f ? filters.map((x, j) => (j === i ? f : x)) : filters.filter((_, j) => j !== i));
  return (
    <>
      {filters.map((f, i) => (
        <div key={i} className="vx-preset">
          <HStack hAlign="between" vAlign="center">
            <Text type="label">{AUDIO_FILTER_LABELS[f.kind]}</Text>
            <IconButton label={`${AUDIO_FILTER_LABELS[f.kind]}を外す`} size="sm" variant="ghost" icon={<Icon icon={X} />} onClick={() => setF(i, null)} />
          </HStack>
          <FilterFields f={f} onChange={n => setF(i, n)} />
        </div>
      ))}
    </>
  );
}

function FilterFields({f, onChange}: {f: AudioFilter; onChange: (f: AudioFilter) => void}) {
  switch (f.kind) {
    case 'highpass':
    case 'lowpass':
      return (
        <Slider
          label={f.kind === 'highpass' ? 'これより低い音を削る' : 'これより高い音を削る'}
          value={f.hz}
          min={50}
          max={12000}
          step={50}
          valueDisplay="text"
          formatValue={v => `${v} Hz`}
          onChange={(hz: number) => onChange({...f, hz})}
        />
      );
    case 'eq':
      return (
        <VStack gap={2}>
          <Slider label="低音（200 Hz より下）" value={f.lowDb} min={-12} max={12} step={0.5} valueDisplay="text" formatValue={db} onChange={(lowDb: number) => onChange({...f, lowDb})} />
          <Slider label={`中音（${f.midHz ?? 1000} Hz あたり）`} value={f.midDb} min={-12} max={12} step={0.5} valueDisplay="text" formatValue={db} onChange={(midDb: number) => onChange({...f, midDb})} />
          <Slider label="中音の高さ" value={f.midHz ?? 1000} min={200} max={6000} step={50} valueDisplay="text" formatValue={v => `${v} Hz`} onChange={(midHz: number) => onChange({...f, midHz})} />
          <Slider label="高音（5 kHz より上）" value={f.highDb} min={-12} max={12} step={0.5} valueDisplay="text" formatValue={db} onChange={(highDb: number) => onChange({...f, highDb})} />
        </VStack>
      );
    case 'compressor':
      return (
        <VStack gap={2}>
          <Slider label="しきい値（これより大きい音を抑える）" value={f.thresholdDb} min={-60} max={0} step={1} valueDisplay="text" formatValue={v => `${v} dB`} onChange={(thresholdDb: number) => onChange({...f, thresholdDb})} />
          <Slider label="抑える強さ" value={f.ratio} min={1} max={20} step={0.5} valueDisplay="text" formatValue={v => `${v} : 1`} onChange={(ratio: number) => onChange({...f, ratio})} />
          <Slider label="効き始め" value={f.attackMs} min={1} max={200} step={1} valueDisplay="text" formatValue={v => `${v} ms`} onChange={(attackMs: number) => onChange({...f, attackMs})} />
          <Slider label="戻り" value={f.releaseMs} min={10} max={1000} step={10} valueDisplay="text" formatValue={v => `${v} ms`} onChange={(releaseMs: number) => onChange({...f, releaseMs})} />
          <Slider label="全体を上げる" value={f.makeupDb} min={0} max={24} step={0.5} valueDisplay="text" formatValue={db} onChange={(makeupDb: number) => onChange({...f, makeupDb})} />
        </VStack>
      );
    case 'limiter':
      return <Slider label="これ以上は大きくしない" value={f.ceilingDb} min={-24} max={0} step={0.5} valueDisplay="text" formatValue={v => `${v} dB`} onChange={(ceilingDb: number) => onChange({...f, ceilingDb})} />;
  }
}

const REVERB_PRESETS: {label: string; r: Reverb}[] = [
  {label: '部屋', r: {size: 0.3, decay: 0.4, wet: 0.3}},
  {label: 'ホール', r: {size: 0.8, decay: 0.7, wet: 0.4}},
  {label: 'お風呂', r: {size: 0.5, decay: 0.9, wet: 0.5}},
  {label: '洞窟', r: {size: 1, decay: 0.95, wet: 0.6}},
];

/** リバーブ（部屋・ホールの響き） */
export function ReverbFields({reverb, onChange}: {reverb: Reverb | null | undefined; onChange: (r: Reverb | null) => void}) {
  return (
    <>
      <HStack hAlign="between" vAlign="center" gap={2}>
        <Switch label="リバーブ" value={!!reverb} onChange={on => onChange(on ? defaultReverb() : null)} labelPosition="start" labelSpacing="spread" width="100%" />
        {reverb && (
          <DropdownMenu button={{label: '例', size: 'sm', variant: 'ghost'}} menuWidth={140}>
            {REVERB_PRESETS.map(p => (
              <DropdownMenuItem key={p.label} label={p.label} onClick={() => onChange(p.r)} />
            ))}
          </DropdownMenu>
        )}
      </HStack>
      {reverb && (
        <VStack gap={2}>
          <Slider label="部屋の広さ" value={reverb.size} min={0} max={1} step={0.05} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(size: number) => onChange({...reverb, size})} />
          <Slider label="響きの残り方" value={reverb.decay} min={0} max={1} step={0.05} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(decay: number) => onChange({...reverb, decay})} />
          <Slider label="響きの量" value={reverb.wet} min={0} max={1} step={0.05} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(wet: number) => onChange({...reverb, wet})} />
        </VStack>
      )}
    </>
  );
}

/** エフェクトが 1 つもないときの案内 */
export function AudioFilterHint({filters}: {filters: AudioFilter[]}) {
  return filters.length ? null : <Hint>イコライザー・コンプレッサー・リミッター、電話風・こもった声などを付けられます。上から順に掛かります。</Hint>;
}
