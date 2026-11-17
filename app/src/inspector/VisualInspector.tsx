// テキスト・図形アイテムのプロパティと、画像・動画・テキスト・図形に共通の「動き・効果」（YMM4 のアニメーション・映像エフェクト）。

import {useRef} from 'react';
import {Hint} from '../Hint';
import {Button} from '@astryxdesign/core/Button';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Divider} from '@astryxdesign/core/Divider';
import {DropdownMenu, DropdownMenuItem} from '@astryxdesign/core/DropdownMenu';
import {Heading} from '@astryxdesign/core/Heading';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {Switch} from '@astryxdesign/core/Switch';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Text} from '@astryxdesign/core/Text';
import {TextArea} from '@astryxdesign/core/TextArea';
import {RubyButton} from './RubyButton';
import {BookmarkPlus, Copy, Plus, Trash2, X} from 'lucide-react';
import {getNotify} from '../actions';
import {itemTemplateName, saveTemplate} from '../templates';
import {QuickEffects} from './QuickEffects';
import {KeyframeBar} from './KeyframeBar';
import {TextDecoFields, TextDecoPicker} from './TextDeco';
import {
  SHAPE_LABEL,
  framesToTimecode,
  plainLook,
  type Ease,
  type Effect,
  type Look,
  type Motion,
  type MotionKind,
  type ShapeClip,
  type ShapeKind,
  type TextClip,
  type Transform,
  type VisualClip,
  GRADES,
  BLEND_MODES,
  type BlendMode,
} from '../model';
import {api} from '../ipc';
import {TrackSection} from './TrackSection';
import {deleteClip, duplicateSelection, setState, updateClip, useStore} from '../store';

const EFFECT_LABEL: Record<Effect['kind'], string> = {
  blur: 'ぼかし',
  shake: '揺れ',
  color: '色調整',
  mono: '白黒',
  invert: '色の反転',
  wave: '波（くねくね）',
  swirl: '渦巻き',
  grade: 'フィルター',
  temperature: '色温度',
  lut: 'LUT（.cube）',
  outline: '縁取り',
  shadow: 'ドロップシャドウ',
  glow: '発光',
  blink: '点滅',
  trail: '残像',
  rgbShift: '色ずれ',
  glitch: 'グリッチ',
  noise: 'ノイズ',
  radialBlur: '放射ブラー',
  dirBlur: '方向ブラー',
  threshold: '二値化',
  jitter: 'ランダム移動',
  oscillate: '反復移動',
};
/** 立ち絵のセリフごとのエフェクトで使えるもの（書き出しの timed_effects と同じ） */
export const PORTRAIT_FX: Effect['kind'][] = ['blur', 'shake', 'color', 'mono', 'invert', 'wave', 'swirl', 'grade', 'temperature', 'lut'];
const NEW_FX: Partial<Record<Effect['kind'], Effect>> = {
  outline: {kind: 'outline', color: '#FFFFFF', width: 6},
  shadow: {kind: 'shadow', color: '#000000', blur: 6, x: 8, y: 8, opacity: 0.6},
  glow: {kind: 'glow', color: '#FFF07A', blur: 12, strength: 2},
  blink: {kind: 'blink', speed: 2},
  trail: {kind: 'trail', count: 4, interval: 3},
  rgbShift: {kind: 'rgbShift', amount: 6},
  glitch: {kind: 'glitch', amount: 30, band: 16, speed: 12},
  noise: {kind: 'noise', amount: 0.25},
  radialBlur: {kind: 'radialBlur', amount: 0.3},
  dirBlur: {kind: 'dirBlur', length: 40, angle: 0},
  threshold: {kind: 'threshold', level: 0.5},
  jitter: {kind: 'jitter', amount: 10, speed: 8},
  oscillate: {kind: 'oscillate', x: 0, y: 20, speed: 1},
};
const newEffect = (k: Effect['kind']): Effect =>
  NEW_FX[k]
    ? structuredClone(NEW_FX[k]!)
    : k === 'blur'
      ? {kind: 'blur', radius: 6}
      : k === 'wave'
        ? {kind: 'wave', amount: 12, length: 160, speed: 1}
        : k === 'swirl'
          ? {kind: 'swirl', angle: 180}
          : k === 'shake'
            ? {kind: 'shake', amount: 8, speed: 6}
            : k === 'color'
              ? {kind: 'color', brightness: 1, contrast: 1, saturation: 1}
              : k === 'grade'
                ? {kind: 'grade', name: 'film', strength: 1}
                : k === 'temperature'
                  ? {kind: 'temperature', warm: 0.3, tint: 0}
                  : ({kind: k} as Effect);

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 位置・大きさ・不透明度（始まりの値。アニメーションしないときはずっとこの値） */
export function TransformFields({value, onChange}: {value: Transform; onChange: (t: Transform) => void}) {
  return (
    <VStack gap={3}>
      <HStack gap={2}>
        <NumberInput label="横の位置" description="画面の中央が 0（右がプラス）" units="px" value={value.x} step={10} onChange={x => onChange({...value, x})} />
        <NumberInput label="縦の位置" description="画面の中央が 0（下がプラス）" units="px" value={value.y} step={10} onChange={y => onChange({...value, y})} />
      </HStack>
      <Slider label="大きさ" value={value.scale} min={0.1} max={3} step={0.01} valueDisplay="text" formatValue={pct} onChange={(scale: number) => onChange({...value, scale})} />
      <Slider label="不透明度" value={value.opacity} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(opacity: number) => onChange({...value, opacity})} />
    </VStack>
  );
}

/** 反転・縦横の倍率・回転の中心・3D 回転 */
function ShapeFields({look, set}: {look: Look; set: (p: Partial<Look>) => void}) {
  const st = look.stretch ?? [1, 1];
  const pv = look.pivot ?? [0, 0];
  const r3 = look.rot3d ?? [0, 0];
  const open = !!(look.flipX || look.flipY || look.stretch || look.pivot || look.rot3d);
  const pair = (v: [number, number], i: number, x: number): [number, number] => (i ? [v[0], x] : [x, v[1]]);
  const isZero = (v: [number, number]) => !v[0] && !v[1];
  return (
    <Collapsible defaultIsOpen={open} trigger={<Text type="label">反転・縦横・中心・3D 回転</Text>}>
      <VStack gap={3} paddingBlockStart={2}>
        <HStack gap={4}>
          <Switch label="左右反転" value={!!look.flipX} onChange={flipX => set({flipX: flipX || undefined})} />
          <Switch label="上下反転" value={!!look.flipY} onChange={flipY => set({flipY: flipY || undefined})} />
        </HStack>
        <HStack gap={2}>
          {[0, 1].map(i => (
            <Slider
              key={i}
              label={i ? '縦の倍率' : '横の倍率'}
              value={st[i]}
              min={0.1}
              max={3}
              step={0.01}
              valueDisplay="text"
              formatValue={pct}
              onChange={(v: number) => {
                const n = pair(st, i, v);
                set({stretch: n[0] === 1 && n[1] === 1 ? null : n});
              }}
            />
          ))}
        </HStack>
        <HStack gap={2}>
          {[0, 1].map(i => (
            <NumberInput
              key={i}
              label={i ? '中心の縦' : '中心の横'}
              description={i ? '' : '回転・拡大の中心。真ん中が 0'}
              units="px"
              value={pv[i]}
              step={10}
              onChange={v => {
                const n = pair(pv, i, v);
                set({pivot: isZero(n) ? null : n});
              }}
            />
          ))}
        </HStack>
        <HStack gap={2}>
          {[0, 1].map(i => (
            <Slider
              key={i}
              label={i ? 'Y 軸回転' : 'X 軸回転'}
              value={r3[i]}
              min={-180}
              max={180}
              step={1}
              valueDisplay="text"
              formatValue={v => `${Math.round(v)}°`}
              onChange={(v: number) => {
                const n = pair(r3, i, v);
                set({rot3d: isZero(n) ? null : n});
              }}
            />
          ))}
        </HStack>
      </VStack>
    </Collapsible>
  );
}

/** 配置・回転・アニメーション・フェード・映像エフェクト */
export function LookEditor({clip}: {clip: VisualClip}) {
  const fps = useStore(s => s.project!.video.fps);
  return (
    <>
      <QuickEffects clip={clip} fps={fps} />
      <Divider />
      <KeyframeBar clip={clip} />
      <Divider />
      <TrackSection clip={clip} />
      <LookFields
        transform={clip.transform}
        look={clip.look}
        duration={clip.duration}
        onTransform={transform => updateClip(clip.id, {transform} as Partial<VisualClip>)}
        onLook={look => updateClip(clip.id, {look} as Partial<VisualClip>)}
      />
    </>
  );
}

/** 配置・回転・アニメーション・フェード・映像エフェクトの欄（テキストアイテムと「個別に設定」した字幕で共通） */
export function LookFields({
  transform,
  look: given,
  duration,
  onTransform,
  onLook,
  headingLevel = 3,
}: {
  transform: Transform;
  look: Look | undefined | null;
  duration: number;
  onTransform: (t: Transform) => void;
  onLook: (l: Look) => void;
  headingLevel?: 3 | 4;
}) {
  const look: Look = {...plainLook(), ...(given ?? {})};
  const set = (patch: Partial<Look>) => onLook({...look, ...patch});
  const anim = look.anim;
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <Heading level={headingLevel}>配置</Heading>
        <Hint>{anim ? 'アニメーションの始まりの値です。' : 'プレビューでドラッグしても動かせます。'}</Hint>
        <TransformFields value={transform} onChange={onTransform} />
        <Slider label="回転" value={look.rotation} min={-180} max={180} step={1} valueDisplay="text" formatValue={v => `${Math.round(v)}°`} onChange={(rotation: number) => set({rotation})} />
        <ShapeFields look={look} set={set} />
      </VStack>
      <Divider />
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <Switch
          label="アニメーション（終わりの状態へ動かす）"
          value={!!anim}
          onChange={on => set({anim: on ? {to: {...transform}, rotation: look.rotation, ease: 'inOut'} : null})}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
        {anim && (
          <>
            <SegmentedControl label="動き方" size="sm" value={anim.ease} onChange={v => set({anim: {...anim, ease: v as Ease}})}>
              <SegmentedControlItem value="linear" label="一定" />
              <SegmentedControlItem value="in" label="加速" />
              <SegmentedControlItem value="out" label="減速" />
              <SegmentedControlItem value="inOut" label="加減速" />
            </SegmentedControl>
            <Text type="label">終わりの状態</Text>
            <TransformFields value={anim.to} onChange={to => set({anim: {...anim, to}})} />
            <Slider
              label="終わりの回転"
              value={anim.rotation}
              min={-720}
              max={720}
              step={1}
              valueDisplay="text"
              formatValue={v => `${Math.round(v)}°`}
              onChange={(rotation: number) => set({anim: {...anim, rotation}})}
            />
            {(look.rot3d || anim.rot3d) && (
              <HStack gap={2}>
                {[0, 1].map(i => (
                  <Slider
                    key={i}
                    label={i ? '終わりの Y 軸回転' : '終わりの X 軸回転'}
                    value={(anim.rot3d ?? look.rot3d ?? [0, 0])[i]}
                    min={-360}
                    max={360}
                    step={1}
                    valueDisplay="text"
                    formatValue={v => `${Math.round(v)}°`}
                    onChange={(v: number) => {
                      const r: [number, number] = [...(anim.rot3d ?? look.rot3d ?? [0, 0])];
                      r[i] = v;
                      set({anim: {...anim, rot3d: r}});
                    }}
                  />
                ))}
              </HStack>
            )}
            <div>
              <Button label="始まりと同じにする" size="sm" variant="ghost" onClick={() => set({anim: {...anim, to: {...transform}, rotation: look.rotation, rot3d: null}})} />
            </div>
            <Switch
              label="途中の状態を通る"
              description="始まり → 途中 → 終わりの順に動きます"
              value={!!anim.mid}
              onChange={on =>
                set({
                  anim: {
                    ...anim,
                    // はじめは、始まりと終わりのちょうど真ん中
                    mid: on
                      ? {
                          at: 0.5,
                          transform: {
                            x: Math.round((transform.x + anim.to.x) / 2),
                            y: Math.round((transform.y + anim.to.y) / 2),
                            scale: (transform.scale + anim.to.scale) / 2,
                            opacity: (transform.opacity + anim.to.opacity) / 2,
                          },
                          rotation: Math.round((look.rotation + anim.rotation) / 2),
                        }
                      : null,
                  },
                })
              }
              labelPosition="start"
              labelSpacing="spread"
              width="100%"
            />
            {anim.mid && (
              <>
                <Slider
                  label="通る時点"
                  value={anim.mid.at}
                  min={0.05}
                  max={0.95}
                  step={0.01}
                  valueDisplay="text"
                  formatValue={v => `${Math.round(v * 100)}%（${Math.round(duration * v)} フレーム目）`}
                  onChange={(at: number) => set({anim: {...anim, mid: {...anim.mid!, at}}})}
                />
                <Text type="label">途中の状態</Text>
                <TransformFields value={anim.mid.transform} onChange={tr => set({anim: {...anim, mid: {...anim.mid!, transform: tr}}})} />
                <Slider
                  label="途中の回転"
                  value={anim.mid.rotation}
                  min={-720}
                  max={720}
                  step={1}
                  valueDisplay="text"
                  formatValue={v => `${Math.round(v)}°`}
                  onChange={(rotation: number) => set({anim: {...anim, mid: {...anim.mid!, rotation}}})}
                />
              </>
            )}
          </>
        )}
        <MotionField label="登場" none="そのまま出る" value={look.enter} duration={duration} onChange={enter => set({enter})} labels={ENTER_LABEL} />
        <MotionField label="退場" none="そのまま消える" value={look.exit} duration={duration} onChange={exit => set({exit})} labels={EXIT_LABEL} />
        <HStack gap={2}>
          <NumberInput label="フェードイン" units="フレーム" value={look.fadeIn} min={0} max={duration} onChange={fadeIn => set({fadeIn})} />
          <NumberInput label="フェードアウト" units="フレーム" value={look.fadeOut} min={0} max={duration} onChange={fadeOut => set({fadeOut})} />
        </HStack>
        <Selector
          label="合成モード"
          value={look.blend ?? 'normal'}
          options={[{value: 'normal', label: '通常'}, ...BLEND_MODES]}
          onChange={v => set({blend: v === 'normal' ? null : (v as BlendMode)})}
          width="100%"
        />
      </VStack>
      <Divider />
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <EffectsEditor effects={look.effects ?? []} onChange={effects => set({effects})} headingLevel={headingLevel} />
      </VStack>
    </>
  );
}

const ENTER_LABEL: Record<MotionKind, string> = {
  slideLeft: '左から入る',
  slideRight: '右から入る',
  slideUp: '上から入る',
  slideDown: '下から入る',
  zoom: '大きくなって出る',
  wipeRight: 'クリッピング解除（左から右へ）',
  wipeLeft: 'クリッピング解除（右から左へ）',
  wipeDown: 'クリッピング解除（上から下へ）',
  wipeUp: 'クリッピング解除（下から上へ）',
};
const EXIT_LABEL: Record<MotionKind, string> = {
  slideLeft: '左へ出る',
  slideRight: '右へ出る',
  slideUp: '上へ出る',
  slideDown: '下へ出る',
  zoom: '小さくなって消える',
  wipeRight: 'クリッピング（左から右へ消える）',
  wipeLeft: 'クリッピング（右から左へ消える）',
  wipeDown: 'クリッピング（上から下へ消える）',
  wipeUp: 'クリッピング（下から上へ消える）',
};

/** 登場・退場（場面の切り替わりで、画面の外から滑り込む・出ていく） */
function MotionField({
  label,
  none,
  value,
  duration,
  labels,
  onChange,
}: {
  label: string;
  none: string;
  value: Motion | null | undefined;
  duration: number;
  labels: Record<MotionKind, string>;
  onChange: (m: Motion | null) => void;
}) {
  return (
    <HStack gap={2} vAlign="end">
      <div style={{flex: 1, minWidth: 0}}>
        <Selector
          label={label}
          value={value?.kind ?? 'none'}
          options={[{value: 'none', label: none}, ...(Object.keys(labels) as MotionKind[]).map(k => ({value: k, label: labels[k]}))]}
          onChange={v => onChange(v === 'none' ? null : {kind: v as MotionKind, frames: value?.frames ?? Math.min(15, duration)})}
          width="100%"
        />
      </div>
      {value && (
        <div style={{width: 132}}>
          <NumberInput label="長さ" units="フレーム" value={value.frames} min={1} max={duration} onChange={frames => onChange({...value, frames})} />
        </div>
      )}
    </HStack>
  );
}

/** 映像エフェクトの並び（追加・調整・外す） */
export function EffectsEditor({
  effects,
  onChange,
  title = '映像エフェクト',
  empty = 'ぼかし・揺れ・色調整・縁取り・影・発光・点滅・残像・グリッチなどを付けられます。',
  headingLevel = 3,
  kinds,
}: {
  effects: Effect[];
  onChange: (e: Effect[]) => void;
  title?: string;
  empty?: string;
  headingLevel?: 3 | 4;
  /** 追加できる種類（なければ全部） */
  kinds?: Effect['kind'][];
}) {
  const setFx = (i: number, fx: Effect | null) => onChange(fx ? effects.map((e, j) => (j === i ? fx : e)) : effects.filter((_, j) => j !== i));
  return (
    <>
      <HStack hAlign="between" vAlign="center">
        <Heading level={headingLevel}>{title}</Heading>
        <DropdownMenu button={{label: '追加', size: 'sm', variant: 'ghost', icon: <Icon icon={Plus} />}} menuWidth={160}>
          {(kinds ?? (Object.keys(EFFECT_LABEL) as Effect['kind'][])).map(k => (
            <DropdownMenuItem
              key={k}
              label={EFFECT_LABEL[k] + (k === 'lut' ? '…' : '')}
              onClick={() => {
                if (k !== 'lut') return onChange([...effects, newEffect(k)]);
                // LUT はファイルを選んでから足す
                void api
                  .then(a => a.pickLutPath())
                  .then(path => {
                    if (path) onChange([...effects, {kind: 'lut', path, strength: 1}]);
                  });
              }}
            />
          ))}
        </DropdownMenu>
      </HStack>
      {!effects.length && <Text type="supporting">{empty}</Text>}
      {effects.map((fx, i) => (
        <div key={i} className="vx-preset">
          <HStack hAlign="between" vAlign="center">
            <Text type="label">{EFFECT_LABEL[fx.kind]}</Text>
            <IconButton label={`${EFFECT_LABEL[fx.kind]}を外す`} size="sm" variant="ghost" icon={<Icon icon={X} />} onClick={() => setFx(i, null)} />
          </HStack>
          {fx.kind === 'blur' && (
            <Slider label="強さ" value={fx.radius} min={0} max={40} step={0.5} valueDisplay="text" formatValue={v => `${v} px`} onChange={(radius: number) => setFx(i, {...fx, radius})} />
          )}
          {fx.kind === 'shake' && (
            <VStack gap={2}>
              <Slider label="振れ幅" value={fx.amount} min={0} max={80} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(amount: number) => setFx(i, {...fx, amount})} />
              <Slider label="速さ" value={fx.speed} min={0.5} max={20} step={0.5} valueDisplay="text" formatValue={v => `${v} 回/秒`} onChange={(speed: number) => setFx(i, {...fx, speed})} />
            </VStack>
          )}
          {fx.kind === 'wave' && (
            <VStack gap={2}>
              <Slider label="振れ幅" value={fx.amount} min={0} max={100} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(amount: number) => setFx(i, {...fx, amount})} />
              <Slider label="波の長さ" value={fx.length} min={10} max={1000} step={10} valueDisplay="text" formatValue={v => `${v} px`} onChange={(length: number) => setFx(i, {...fx, length})} />
              <Slider label="速さ" value={fx.speed} min={0} max={10} step={0.1} valueDisplay="text" formatValue={v => `${v} 回/秒`} onChange={(speed: number) => setFx(i, {...fx, speed})} />
            </VStack>
          )}
          {fx.kind === 'swirl' && (
            <Slider label="ねじる角度" value={fx.angle} min={-720} max={720} step={5} valueDisplay="text" formatValue={v => `${v}°`} onChange={(angle: number) => setFx(i, {...fx, angle})} />
          )}
          {fx.kind === 'grade' && (
            <VStack gap={2}>
              <Selector label="フィルター" value={fx.name} options={Object.entries(GRADES).map(([value, g]) => ({value, label: g.label}))} onChange={(name: string) => setFx(i, {...fx, name})} />
              <Slider label="強さ" value={fx.strength} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(strength: number) => setFx(i, {...fx, strength})} />
            </VStack>
          )}
          {fx.kind === 'lut' && (
            <VStack gap={2}>
              <Text type="supporting">{fx.path.split(/[\\/]/).pop()}（プレビューは近い色。書き出しはファイルのとおり）</Text>
              <Slider label="強さ" value={fx.strength} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(strength: number) => setFx(i, {...fx, strength})} />
            </VStack>
          )}
          {fx.kind === 'temperature' && (
            <VStack gap={2}>
              <Slider
                label="色温度（青 ← → 黄）"
                value={fx.warm}
                min={-1}
                max={1}
                step={0.01}
                valueDisplay="text"
                formatValue={v => `${Math.round(v * 100)}`}
                onChange={(warm: number) => setFx(i, {...fx, warm})}
              />
              <Slider
                label="色合い（緑 ← → 赤紫）"
                value={fx.tint}
                min={-1}
                max={1}
                step={0.01}
                valueDisplay="text"
                formatValue={v => `${Math.round(v * 100)}`}
                onChange={(tint: number) => setFx(i, {...fx, tint})}
              />
            </VStack>
          )}
          {fx.kind === 'outline' && (
            <VStack gap={2}>
              <ColorRow label="色" value={fx.color} onChange={color => setFx(i, {...fx, color})} />
              <Slider label="太さ" value={fx.width} min={1} max={60} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(width: number) => setFx(i, {...fx, width})} />
            </VStack>
          )}
          {fx.kind === 'shadow' && (
            <VStack gap={2}>
              <ColorRow label="色" value={fx.color} onChange={color => setFx(i, {...fx, color})} />
              <Slider label="ぼかし" value={fx.blur} min={0} max={40} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(blur: number) => setFx(i, {...fx, blur})} />
              <Slider label="横のずれ" value={fx.x} min={-80} max={80} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(x: number) => setFx(i, {...fx, x})} />
              <Slider label="縦のずれ" value={fx.y} min={-80} max={80} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(y: number) => setFx(i, {...fx, y})} />
              <Slider label="濃さ" value={fx.opacity} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(opacity: number) => setFx(i, {...fx, opacity})} />
            </VStack>
          )}
          {fx.kind === 'glow' && (
            <VStack gap={2}>
              <ColorRow label="色" value={fx.color} onChange={color => setFx(i, {...fx, color})} />
              <Slider label="広がり" value={fx.blur} min={1} max={60} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(blur: number) => setFx(i, {...fx, blur})} />
              <Slider label="強さ" value={fx.strength} min={1} max={5} step={1} valueDisplay="text" formatValue={v => `${v} 回`} onChange={(strength: number) => setFx(i, {...fx, strength})} />
            </VStack>
          )}
          {fx.kind === 'blink' && (
            <VStack gap={2}>
              <Slider label="速さ" value={fx.speed} min={0.25} max={20} step={0.25} valueDisplay="text" formatValue={v => `${v} 回/秒`} onChange={(speed: number) => setFx(i, {...fx, speed})} />
            </VStack>
          )}
          {fx.kind === 'trail' && (
            <VStack gap={2}>
              <Slider label="数" value={fx.count} min={1} max={8} step={1} valueDisplay="text" formatValue={v => `${v}`} onChange={(count: number) => setFx(i, {...fx, count})} />
              <Slider label="間隔" value={fx.interval} min={1} max={30} step={1} valueDisplay="text" formatValue={v => `${v} フレーム`} onChange={(interval: number) => setFx(i, {...fx, interval})} />
            </VStack>
          )}
          {fx.kind === 'rgbShift' && (
            <VStack gap={2}>
              <Slider label="ずれ" value={fx.amount} min={-40} max={40} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(amount: number) => setFx(i, {...fx, amount})} />
            </VStack>
          )}
          {fx.kind === 'glitch' && (
            <VStack gap={2}>
              <Slider label="ずれ" value={fx.amount} min={0} max={200} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(amount: number) => setFx(i, {...fx, amount})} />
              <Slider label="帯の高さ" value={fx.band} min={2} max={200} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(band: number) => setFx(i, {...fx, band})} />
              <Slider label="速さ" value={fx.speed} min={1} max={30} step={1} valueDisplay="text" formatValue={v => `${v} 回/秒`} onChange={(speed: number) => setFx(i, {...fx, speed})} />
            </VStack>
          )}
          {fx.kind === 'noise' && (
            <VStack gap={2}>
              <Slider label="強さ" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
            </VStack>
          )}
          {fx.kind === 'radialBlur' && (
            <VStack gap={2}>
              <Slider label="強さ" value={fx.amount} min={0} max={0.9} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
            </VStack>
          )}
          {fx.kind === 'dirBlur' && (
            <VStack gap={2}>
              <Slider label="長さ" value={fx.length} min={1} max={300} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(length: number) => setFx(i, {...fx, length})} />
              <Slider label="角度" value={fx.angle} min={-180} max={180} step={1} valueDisplay="text" formatValue={v => `${v}°`} onChange={(angle: number) => setFx(i, {...fx, angle})} />
            </VStack>
          )}
          {fx.kind === 'threshold' && (
            <VStack gap={2}>
              <Slider label="しきい値" value={fx.level} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(level: number) => setFx(i, {...fx, level})} />
            </VStack>
          )}
          {fx.kind === 'jitter' && (
            <VStack gap={2}>
              <Slider label="振れ幅" value={fx.amount} min={0} max={200} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(amount: number) => setFx(i, {...fx, amount})} />
              <Slider label="速さ" value={fx.speed} min={1} max={30} step={1} valueDisplay="text" formatValue={v => `${v} 回/秒`} onChange={(speed: number) => setFx(i, {...fx, speed})} />
            </VStack>
          )}
          {fx.kind === 'oscillate' && (
            <VStack gap={2}>
              <Slider label="横の振れ幅" value={fx.x} min={-400} max={400} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(x: number) => setFx(i, {...fx, x})} />
              <Slider label="縦の振れ幅" value={fx.y} min={-400} max={400} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(y: number) => setFx(i, {...fx, y})} />
              <Slider label="速さ" value={fx.speed} min={0.1} max={10} step={0.1} valueDisplay="text" formatValue={v => `${v} 回/秒`} onChange={(speed: number) => setFx(i, {...fx, speed})} />
            </VStack>
          )}
          {fx.kind === 'color' && (
            <VStack gap={2}>
              <Slider label="明るさ" value={fx.brightness} min={0} max={2} step={0.01} valueDisplay="text" formatValue={pct} onChange={(brightness: number) => setFx(i, {...fx, brightness})} />
              <Slider label="コントラスト" value={fx.contrast} min={0} max={2} step={0.01} valueDisplay="text" formatValue={pct} onChange={(contrast: number) => setFx(i, {...fx, contrast})} />
              <Slider label="彩度" value={fx.saturation} min={0} max={2} step={0.01} valueDisplay="text" formatValue={pct} onChange={(saturation: number) => setFx(i, {...fx, saturation})} />
            </VStack>
          )}
        </div>
      ))}
    </>
  );
}

function ItemHeader({clip, title}: {clip: VisualClip; title: string}) {
  const fps = useStore(s => s.project!.video.fps);
  return (
    // セリフ・素材のプロパティと同じ並び：見出し → 時刻 → 操作のボタン
    <VStack gap={3}>
      <Heading level={3}>{title}</Heading>
      <Text type="supporting" hasTabularNumbers>
        {framesToTimecode(clip.start, fps)} から 長さ {framesToTimecode(clip.duration, fps)}
      </Text>
      <HStack gap={2} wrap="wrap">
        <Button label="複製" variant="ghost" icon={<Icon icon={Copy} />} tooltip="複製（Ctrl+D）" onClick={() => duplicateSelection()} />
        <Button label="削除" variant="ghost" icon={<Icon icon={Trash2} />} tooltip="削除（Delete）" onClick={() => deleteClip(clip.id)} />
        <Button
          label="テンプレートに保存"
          variant="ghost"
          icon={<Icon icon={BookmarkPlus} />}
          tooltip="文字・色・位置・動き・効果をまとめて取っておきます（ツール → テンプレート から置けます）"
          onClick={() => {
            const t = saveTemplate('item', itemTemplateName(clip), clip);
            getNotify()(`テンプレート「${t.name}」に保存しました`, 'info', 'template', {label: 'テンプレートを開く', onClick: () => setState({templatesOpen: true})});
          }}
        />
      </HStack>
    </VStack>
  );
}

const FONTS: [string, string][] = [
  ['Yu Gothic UI', '游ゴシック UI'],
  ['Yu Gothic', '游ゴシック'],
  ['Meiryo', 'メイリオ'],
  ['BIZ UDPGothic', 'BIZ UDP ゴシック'],
  ['UD Digi Kyokasho NK-B', 'UD デジタル 教科書体（太）'],
  ['Yu Mincho', '游明朝'],
  ['MS Gothic', 'ＭＳ ゴシック'],
];

/** 色の入力（字幕・キャラクターの色の欄と同じ形：左に色見本、右に #RRGGBB） */
export function ColorRow({label, value, onChange, allowNone}: {label: string; value: string; onChange: (v: string) => void; allowNone?: boolean}) {
  const ok = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <HStack gap={2} vAlign="end">
      <label className="vx-color-swatch" style={{background: ok ? value : 'transparent'}} title={`${label}を選ぶ`}>
        <input type="color" aria-label={`${label}を選ぶ`} value={ok ? value : '#000000'} onChange={e => onChange(e.target.value.toUpperCase())} />
      </label>
      <div style={{flex: 1}}>
        <TextInput
          label={label}
          value={value}
          placeholder={allowNone ? 'なし' : undefined}
          onChange={onChange}
          status={value === '' && allowNone ? undefined : ok ? undefined : {type: 'error', message: '#RRGGBB の形で入力してください'}}
        />
      </div>
      {allowNone && value && <Button label="なし" variant="ghost" onClick={() => onChange('')} />}
    </HStack>
  );
}

/** 文字の見た目（テキストアイテムと「個別に設定」した字幕で共通） */
export type TextStyle = Pick<TextClip, 'fontFamily' | 'fontSize' | 'color' | 'outlineColor' | 'outlineWidth' | 'bold' | 'italic' | 'align'>;
export function TextStyleFields({value, onChange}: {value: TextStyle; onChange: (patch: Partial<TextStyle>) => void}) {
  const set = onChange;
  const fonts = FONTS.some(f => f[0] === value.fontFamily) ? FONTS : [[value.fontFamily, value.fontFamily] as [string, string], ...FONTS];
  return (
    <>
      <Selector label="フォント" value={value.fontFamily} options={fonts.map(([v, label]) => ({value: v, label}))} hasSearch onChange={fontFamily => set({fontFamily})} width="100%" />
      <HStack gap={2}>
        <NumberInput label="文字の大きさ" units="px" value={value.fontSize} min={8} max={600} onChange={fontSize => set({fontSize})} />
        <NumberInput label="縁取り" units="px" value={value.outlineWidth} min={0} max={60} onChange={outlineWidth => set({outlineWidth})} />
      </HStack>
      <HStack gap={2} wrap="wrap">
        <Switch label="太字" value={value.bold} onChange={bold => set({bold})} />
        <Switch label="斜体" value={value.italic} onChange={italic => set({italic})} />
      </HStack>
      <SegmentedControl label="揃え" size="sm" value={value.align} onChange={v => set({align: v as TextClip['align']})}>
        <SegmentedControlItem value="left" label="左" />
        <SegmentedControlItem value="center" label="中央" />
        <SegmentedControlItem value="right" label="右" />
      </SegmentedControl>
      <ColorRow label="文字の色" value={value.color} onChange={color => set({color})} />
      <ColorRow label="縁の色" value={value.outlineColor} onChange={outlineColor => set({outlineColor})} />
    </>
  );
}

export function TextInspector({clip}: {clip: TextClip}) {
  const set = (patch: Partial<TextClip>) => updateClip(clip.id, patch);
  const textRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <ItemHeader clip={clip} title="テキスト" />
        <div ref={textRef}>
          <TextArea label="文字" description="ふりがなは 漢字《かんじ》" value={clip.text} onChange={text => set({text})} />
        </div>
        <HStack gap={2} hAlign="start">
          <RubyButton host={() => textRef.current} value={clip.text} onChange={text => set({text})} />
        </HStack>
      </VStack>
      <Divider />
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <TextDecoPicker clip={clip} />
        <TextStyleFields value={clip} onChange={set} />
        <TextDecoFields clip={clip} />
      </VStack>
      <Divider />
      <LookEditor clip={clip} />
    </>
  );
}

export function ShapeInspector({clip}: {clip: ShapeClip}) {
  const set = (patch: Partial<ShapeClip>) => updateClip(clip.id, patch);
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <ItemHeader clip={clip} title={clip.region ? (clip.region.kind === 'mosaic' ? 'モザイク範囲' : 'ぼかし範囲') : '図形'} />
        {clip.region && (
          <VStack gap={2}>
            <Text type="supporting">形の中だけ、下にある絵を{clip.region.kind === 'mosaic' ? 'モザイク' : 'ぼかし'}にします。動く物に合わせるときは、下の「動きに付いていく」を使ってください</Text>
            <SegmentedControl label="種類" layout="fill" value={clip.region.kind} onChange={v => set({region: {...clip.region!, kind: v as 'mosaic' | 'blur'}})}>
              <SegmentedControlItem value="mosaic" label="モザイク" />
              <SegmentedControlItem value="blur" label="ぼかし" />
            </SegmentedControl>
            <Slider
              label={clip.region.kind === 'mosaic' ? 'マスの大きさ' : 'ぼかしの強さ'}
              value={clip.region.strength}
              min={2}
              max={120}
              step={1}
              valueDisplay="text"
              formatValue={(v: number) => `${Math.round(v)}px`}
              onChange={(strength: number) => set({region: {...clip.region!, strength}})}
            />
          </VStack>
        )}
        <Selector
          label="形"
          value={clip.shape}
          options={(Object.keys(SHAPE_LABEL) as ShapeKind[]).map(k => ({value: k, label: SHAPE_LABEL[k]}))}
          onChange={v => set({shape: v as ShapeKind})}
          width="100%"
        />
        <HStack gap={2}>
          <NumberInput label="幅" units="px" value={clip.width} min={1} max={8000} step={10} onChange={width => set({width})} />
          <NumberInput label={clip.shape === 'line' ? '太さ' : '高さ'} units="px" value={clip.height} min={1} max={8000} step={clip.shape === 'line' ? 1 : 10} onChange={height => set({height})} />
        </HStack>
        {!clip.region && <ColorRow label={clip.shape === 'line' ? '線の色' : '塗りの色'} value={clip.fill} onChange={fill => set({fill})} />}
        {clip.shape !== 'line' && !clip.region && (
          <Collapsible defaultIsOpen={!!clip.stroke} trigger={<Text type="label">枠線</Text>}>
            <VStack gap={2} paddingBlockStart={2}>
              <ColorRow label="枠線の色" value={clip.stroke} allowNone onChange={stroke => set({stroke, strokeWidth: stroke && !clip.strokeWidth ? 6 : clip.strokeWidth})} />
              <NumberInput label="枠線の太さ" units="px" value={clip.strokeWidth} min={0} max={200} onChange={strokeWidth => set({strokeWidth})} />
            </VStack>
          </Collapsible>
        )}
      </VStack>
      <Divider />
      <LookEditor clip={clip} />
    </>
  );
}
