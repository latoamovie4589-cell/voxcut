// テキスト・図形アイテムのプロパティと、画像・動画・テキスト・図形に共通の「動き・効果」（YMM4 のアニメーション・映像エフェクト）。

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
import {Copy, Plus, Trash2, X} from 'lucide-react';
import {SHAPE_LABEL, framesToTimecode, plainLook, type Ease, type Effect, type Look, type ShapeClip, type ShapeKind, type TextClip, type Transform, type VisualClip} from '../model';
import {deleteClip, duplicateSelection, updateClip, useStore} from '../store';

const EFFECT_LABEL: Record<Effect['kind'], string> = {blur: 'ぼかし', shake: '揺れ', color: '色調整', mono: '白黒', invert: '色の反転', wave: '波（くねくね）', swirl: '渦巻き'};
const newEffect = (k: Effect['kind']): Effect =>
  k === 'blur'
    ? {kind: 'blur', radius: 6}
    : k === 'wave'
      ? {kind: 'wave', amount: 12, length: 160, speed: 1}
      : k === 'swirl'
        ? {kind: 'swirl', angle: 180}
        : k === 'shake'
          ? {kind: 'shake', amount: 8, speed: 6}
          : k === 'color'
            ? {kind: 'color', brightness: 1, contrast: 1, saturation: 1}
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

/** 配置・回転・アニメーション・フェード・映像エフェクト */
export function LookEditor({clip}: {clip: VisualClip}) {
  return (
    <LookFields
      transform={clip.transform}
      look={clip.look}
      duration={clip.duration}
      onTransform={transform => updateClip(clip.id, {transform} as Partial<VisualClip>)}
      onLook={look => updateClip(clip.id, {look} as Partial<VisualClip>)}
    />
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
            <div>
              <Button label="始まりと同じにする" size="sm" variant="ghost" onClick={() => set({anim: {...anim, to: {...transform}, rotation: look.rotation}})} />
            </div>
          </>
        )}
        <HStack gap={2}>
          <NumberInput label="フェードイン" units="フレーム" value={look.fadeIn} min={0} max={duration} onChange={fadeIn => set({fadeIn})} />
          <NumberInput label="フェードアウト" units="フレーム" value={look.fadeOut} min={0} max={duration} onChange={fadeOut => set({fadeOut})} />
        </HStack>
      </VStack>
      <Divider />
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <EffectsEditor effects={look.effects ?? []} onChange={effects => set({effects})} headingLevel={headingLevel} />
      </VStack>
    </>
  );
}

/** 映像エフェクトの並び（追加・調整・外す） */
export function EffectsEditor({
  effects,
  onChange,
  title = '映像エフェクト',
  empty = 'ぼかし・揺れ・色調整・白黒・色の反転・波・渦巻きを付けられます。',
  headingLevel = 3,
}: {
  effects: Effect[];
  onChange: (e: Effect[]) => void;
  title?: string;
  empty?: string;
  headingLevel?: 3 | 4;
}) {
  const setFx = (i: number, fx: Effect | null) => onChange(fx ? effects.map((e, j) => (j === i ? fx : e)) : effects.filter((_, j) => j !== i));
  return (
    <>
      <HStack hAlign="between" vAlign="center">
        <Heading level={headingLevel}>{title}</Heading>
        <DropdownMenu button={{label: '追加', size: 'sm', variant: 'ghost', icon: <Icon icon={Plus} />}} menuWidth={160}>
          {(Object.keys(EFFECT_LABEL) as Effect['kind'][]).map(k => (
            <DropdownMenuItem key={k} label={EFFECT_LABEL[k]} onClick={() => onChange([...effects, newEffect(k)])} />
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
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <ItemHeader clip={clip} title="テキスト" />
        <TextArea label="文字" value={clip.text} onChange={text => set({text})} />
        <TextStyleFields value={clip} onChange={set} />
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
        <ItemHeader clip={clip} title="図形" />
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
        <ColorRow label={clip.shape === 'line' ? '線の色' : '塗りの色'} value={clip.fill} onChange={fill => set({fill})} />
        {clip.shape !== 'line' && (
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
