// テキスト・図形アイテムのプロパティと、画像・動画・テキスト・図形に共通の「動き・効果」（YMM4 のアニメーション・映像エフェクト）。

import {useEffect, useRef, useState} from 'react';
import {Hint} from '../Hint';
import {Button} from '@astryxdesign/core/Button';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Divider} from '@astryxdesign/core/Divider';
import {DropdownMenu, DropdownMenuItem, DropdownMenuSubMenu} from '@astryxdesign/core/DropdownMenu';
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
import {SpanButton} from './SpanButton';
import {KARAOKE_COLOR} from '../subtitleAnim';
import {BookmarkPlus, Copy, Plus, Trash2, X} from 'lucide-react';
import {getNotify} from '../actions';
import {itemTemplateName, saveTemplate} from '../templates';
import {QuickEffects} from './QuickEffects';
import {KeyframeBar} from './KeyframeBar';
import {TextDecoFields, TextDecoPicker} from './TextDeco';
import {LINES_PRESET, PARTICLE_PRESET} from '../preview/anim';
import {BUBBLE_PRESET, angleTo} from '../preview/bubble';
import {
  SHAPE_LABEL,
  CONTROL_LABEL,
  MAIN_SCENE,
  type Scene,
  type Plugin,
  pluginEffect,
  CHAR_ANIM_LABEL,
  type CharAnim,
  type Control,
  framesToTimecode,
  plainLook,
  type Ease,
  EASE_LABEL,
  type Effect,
  type Look,
  type Motion,
  type MotionKind,
  type ShapeClip,
  type ShapeKind,
  type TextClip,
  type Timer,
  type ShapeAnim,
  type Particles,
  type Chart,
  type Lines,
  type Bubble,
  type PortraitClip,
  type Transform,
  type VisualClip,
  GRADES,
  BLEND_MODES,
  type BlendMode,
} from '../model';
import {api} from '../ipc';
import {TrackSection} from './TrackSection';
import {deleteClip, duplicateSelection, openScene, renameScene, setState, updateClip, useStore} from '../store';

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
  vhs: 'VHS 風',
  glitchNoise: 'グリッチノイズ',
  film: '古いフィルム',
  crt: 'ブラウン管',
  vignette: '周辺減光',
  posterize: 'ポスタリゼーション',
  pixelate: 'ドット絵風',
  lineArt: '線画風',
  halftone: '網点（漫画のトーン）',
  duotone: 'デュオトーン（2 色）',
  lightLeak: '光漏れ',
  bloom: 'ブルーム（光のにじみ）',
  lensFlare: 'レンズフレア',
  bulge: '魚眼・膨らみ',
  mirror: '鏡写し・万華鏡',
  tile: 'タイル（くり返し）',
  colorKeep: 'パートカラー（1 色だけ残す）',
  pulse: '拍動（ドクンと大きく）',
  spin: '回り続ける',
  bounce: '跳ねる',
  hueCycle: '色相の回転（虹色）',
  sharpen: 'シャープ（くっきり）',
  innerShadow: '内側の影',
  bevel: 'ベベル（縁の立体感）',
  emboss: 'エンボス（浮き彫り）',
  jitter: 'ランダム移動',
  oscillate: '反復移動',
  plugin: 'プラグイン',
};
/** 立ち絵のセリフごとのエフェクトで使えるもの（書き出しの timed_effects と同じ） */
export const PORTRAIT_FX: Effect['kind'][] = ['blur', 'shake', 'color', 'mono', 'invert', 'wave', 'swirl', 'grade', 'temperature', 'lut'];

/** 読み込んだプラグイン（エフェクトの「追加」を開いたときに読み直す） */
function usePlugins() {
  const [list, setList] = useState<{dir: string; plugins: {file: string; plugin: Plugin | null; error: string | null}[]} | null>(null);
  const reload = () => void api.then(a => a.listPlugins()).then(setList, () => setList({dir: '', plugins: []}));
  useEffect(reload, []);
  return [list, reload] as const;
}
/** エフェクトの「追加」の分け方 */
const FX_GROUPS: {label: string; kinds: Effect['kind'][]}[] = [
  {label: '色', kinds: ['color', 'mono', 'invert', 'grade', 'temperature', 'lut', 'threshold', 'posterize', 'duotone', 'colorKeep', 'hueCycle']},
  {label: 'ぼかし・くっきり', kinds: ['blur', 'radialBlur', 'dirBlur', 'sharpen']},
  {label: '縁取り・影・立体感', kinds: ['outline', 'shadow', 'innerShadow', 'bevel', 'emboss']},
  {label: '光', kinds: ['glow', 'bloom', 'lightLeak', 'lensFlare']},
  {label: '映像加工（VHS・フィルムなど）', kinds: ['glitchNoise', 'glitch', 'vhs', 'film', 'crt', 'vignette', 'rgbShift', 'noise', 'pixelate']},
  {label: '漫画・イラスト風', kinds: ['lineArt', 'halftone']},
  {label: '変形', kinds: ['wave', 'swirl', 'bulge', 'mirror', 'tile']},
  {label: '動き', kinds: ['pulse', 'spin', 'bounce', 'shake', 'jitter', 'oscillate', 'blink', 'trail']},
];

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
  vhs: {kind: 'vhs', amount: 0.6},
  glitchNoise: {kind: 'glitchNoise', amount: 0.7, rate: 0.35, block: 24},
  film: {kind: 'film', amount: 0.7},
  crt: {kind: 'crt', amount: 0.6},
  vignette: {kind: 'vignette', amount: 0.6},
  posterize: {kind: 'posterize', levels: 4},
  pixelate: {kind: 'pixelate', size: 12},
  lineArt: {kind: 'lineArt', amount: 0.5, keepColor: false},
  halftone: {kind: 'halftone', size: 10, ink: '#1A1A1A'},
  duotone: {kind: 'duotone', dark: '#2B1055', light: '#FF9E5E', amount: 1},
  lightLeak: {kind: 'lightLeak', color: '#FF8A3D', amount: 0.6},
  bloom: {kind: 'bloom', threshold: 0.6, amount: 0.8, radius: 12},
  lensFlare: {kind: 'lensFlare', x: -0.5, y: -0.5, amount: 0.8, color: '#FFE2A8'},
  bulge: {kind: 'bulge', amount: 0.5},
  mirror: {kind: 'mirror', mode: 'left', segments: 6},
  tile: {kind: 'tile', count: 2, flip: false},
  colorKeep: {kind: 'colorKeep', color: '#E53935', range: 0.08, soft: 0.06},
  pulse: {kind: 'pulse', amount: 0.15, bpm: 70},
  spin: {kind: 'spin', rpm: 30},
  bounce: {kind: 'bounce', height: 40, bpm: 90},
  hueCycle: {kind: 'hueCycle', rpm: 12, offset: 0},
  sharpen: {kind: 'sharpen', amount: 0.6},
  innerShadow: {kind: 'innerShadow', color: '#000000', blur: 6, x: 4, y: 4, opacity: 0.6},
  bevel: {kind: 'bevel', size: 6, strength: 0.6, angle: 135},
  emboss: {kind: 'emboss', amount: 0.5, angle: 135, keepColor: false},
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
            <Selector
              label="動き方"
              value={anim.ease}
              options={(Object.keys(EASE_LABEL) as Ease[]).map(k => ({value: k, label: EASE_LABEL[k]}))}
              onChange={(v: string) => set({anim: {...anim, ease: v as Ease}})}
              width="100%"
            />
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
  spin: '回転しながら出る',
  bounce: '跳ねて出る',
  blur: 'ぼかしから出る',
  iris: '真ん中から丸く広がる',
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
  spin: '回転しながら消える',
  bounce: '跳ねて消える',
  blur: 'ぼやけて消える',
  iris: '丸く狭まって消える',
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
  empty = 'ぼかし・揺れ・色調整・縁取り・影・発光・点滅・残像・グリッチ・VHS 風・古いフィルムなどを付けられます。',
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
  const [plugins, reloadPlugins] = usePlugins();
  const withPlugins = !kinds;
  const addItem = (k: Effect['kind']) => (
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
  );
  return (
    <>
      <HStack hAlign="between" vAlign="center">
        <Heading level={headingLevel}>{title}</Heading>
        <DropdownMenu button={{label: '追加', size: 'sm', variant: 'ghost', icon: <Icon icon={Plus} />}} menuWidth={220}>
          {kinds
            ? kinds.map(addItem)
            : FX_GROUPS.map(g => (
                <DropdownMenuSubMenu key={g.label} label={g.label} menuWidth={200}>
                  {g.kinds.map(addItem)}
                </DropdownMenuSubMenu>
              ))}
          {withPlugins &&
            (plugins?.plugins ?? []).flatMap(f =>
              f.plugin
                ? f.plugin.effects.map(e => (
                    <DropdownMenuItem key={`${f.file}:${e.id}`} label={e.label} description={`プラグイン（${f.plugin!.name}）`} onClick={() => onChange([...effects, pluginEffect(f.plugin!, e)])} />
                  ))
                : [<DropdownMenuItem key={f.file} label={`${f.file}（読めません）`} description={f.error ?? ''} onClick={() => {}} />],
            )}
          {withPlugins && plugins?.dir && (
            <DropdownMenuItem
              label="プラグインのフォルダを開く"
              description="エフェクトの .json を置くと、ここに出ます"
              onClick={() => {
                void api.then(a => a.openPath(plugins.dir));
                reloadPlugins();
              }}
            />
          )}
        </DropdownMenu>
      </HStack>
      {!effects.length && <Text type="supporting">{empty}</Text>}
      {effects.map((fx, i) => (
        <div key={i} className="vx-preset">
          <HStack hAlign="between" vAlign="center">
            <Text type="label">{fx.kind === 'plugin' ? fx.name : EFFECT_LABEL[fx.kind]}</Text>
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
          {(fx.kind === 'vhs' || fx.kind === 'film' || fx.kind === 'crt' || fx.kind === 'vignette') && (
            <VStack gap={2}>
              <Slider label="強さ" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
            </VStack>
          )}
          {fx.kind === 'posterize' && (
            <VStack gap={2}>
              <Slider label="色の段階" value={fx.levels} min={2} max={16} step={1} valueDisplay="text" formatValue={v => `${v} 段階`} onChange={(levels: number) => setFx(i, {...fx, levels})} />
            </VStack>
          )}
          {fx.kind === 'pixelate' && (
            <VStack gap={2}>
              <Slider label="点の大きさ" value={fx.size} min={2} max={80} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(size: number) => setFx(i, {...fx, size})} />
            </VStack>
          )}
          {fx.kind === 'pulse' && (
            <VStack gap={2}>
              <Slider label="大きくなる量" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
              <Slider label="速さ" value={fx.bpm} min={10} max={240} step={1} valueDisplay="text" formatValue={v => `1 分間に ${v} 回`} onChange={(bpm: number) => setFx(i, {...fx, bpm})} />
            </VStack>
          )}
          {fx.kind === 'spin' && (
            <VStack gap={2}>
              <Slider
                label="速さ"
                description="マイナスにすると左回り"
                value={fx.rpm}
                min={-240}
                max={240}
                step={1}
                valueDisplay="text"
                formatValue={v => (v < 0 ? '左回り' : '右回り') + `・1 分間に ${Math.abs(v)} 回転`}
                onChange={(rpm: number) => setFx(i, {...fx, rpm})}
              />
            </VStack>
          )}
          {fx.kind === 'bounce' && (
            <VStack gap={2}>
              <Slider label="跳ねる高さ" value={fx.height} min={0} max={400} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(height: number) => setFx(i, {...fx, height})} />
              <Slider label="速さ" value={fx.bpm} min={10} max={240} step={1} valueDisplay="text" formatValue={v => `1 分間に ${v} 回`} onChange={(bpm: number) => setFx(i, {...fx, bpm})} />
            </VStack>
          )}
          {fx.kind === 'hueCycle' && (
            <VStack gap={2}>
              <Slider
                label="速さ"
                description="0 にすると色がずれたまま止まります"
                value={fx.rpm}
                min={-120}
                max={120}
                step={1}
                valueDisplay="text"
                formatValue={v => (v ? `1 分間に ${Math.abs(v)} 周` : '止める')}
                onChange={(rpm: number) => setFx(i, {...fx, rpm})}
              />
              <Slider label="色のずれ" value={fx.offset} min={0} max={359} step={1} valueDisplay="text" formatValue={v => `${v}°`} onChange={(offset: number) => setFx(i, {...fx, offset})} />
            </VStack>
          )}
          {fx.kind === 'sharpen' && (
            <VStack gap={2}>
              <Slider label="強さ" value={fx.amount} min={0} max={2} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
            </VStack>
          )}
          {fx.kind === 'innerShadow' && (
            <VStack gap={2}>
              <ColorRow label="色" value={fx.color} onChange={color => setFx(i, {...fx, color})} />
              <HStack gap={2}>
                <NumberInput label="横のずれ" units="px" value={fx.x} min={-100} max={100} onChange={x => setFx(i, {...fx, x})} />
                <NumberInput label="縦のずれ" units="px" value={fx.y} min={-100} max={100} onChange={y => setFx(i, {...fx, y})} />
              </HStack>
              <Slider label="ぼかし" value={fx.blur} min={0} max={60} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(blur: number) => setFx(i, {...fx, blur})} />
              <Slider label="濃さ" value={fx.opacity} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(opacity: number) => setFx(i, {...fx, opacity})} />
            </VStack>
          )}
          {(fx.kind === 'bevel' || fx.kind === 'emboss') && (
            <VStack gap={2}>
              {fx.kind === 'bevel' ? (
                <>
                  <Slider label="縁の幅" value={fx.size} min={1} max={60} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(size: number) => setFx(i, {...fx, size})} />
                  <Slider label="強さ" value={fx.strength} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(strength: number) => setFx(i, {...fx, strength})} />
                </>
              ) : (
                <>
                  <Slider label="強さ" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
                  <Switch label="元の色を残す" value={fx.keepColor} onChange={keepColor => setFx(i, {...fx, keepColor})} labelPosition="start" labelSpacing="spread" width="100%" />
                </>
              )}
              <Slider
                label="光の向き"
                value={fx.angle}
                min={0}
                max={359}
                step={1}
                valueDisplay="text"
                formatValue={v => `${['右', '右上', '上', '左上', '左', '左下', '下', '右下'][Math.round(v / 45) % 8]}から（${v}°）`}
                onChange={(angle: number) => setFx(i, {...fx, angle})}
              />
            </VStack>
          )}
          {fx.kind === 'glitchNoise' && (
            <VStack gap={2}>
              <Slider label="強さ" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
              <Slider
                label="乱れる時間"
                description="大きく乱れる時間の割合。100% でずっと乱れます"
                value={fx.rate}
                min={0}
                max={1}
                step={0.01}
                valueDisplay="text"
                formatValue={pct}
                onChange={(rate: number) => setFx(i, {...fx, rate})}
              />
              <Slider label="ブロックの大きさ" value={fx.block} min={4} max={120} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(block: number) => setFx(i, {...fx, block})} />
            </VStack>
          )}
          {fx.kind === 'lineArt' && (
            <VStack gap={2}>
              <Slider label="線の濃さ" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
              <Switch label="元の色を残す" value={fx.keepColor} onChange={keepColor => setFx(i, {...fx, keepColor})} labelPosition="start" labelSpacing="spread" width="100%" />
            </VStack>
          )}
          {fx.kind === 'halftone' && (
            <VStack gap={2}>
              <Slider label="点の間隔" value={fx.size} min={3} max={60} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(size: number) => setFx(i, {...fx, size})} />
              <Switch label="点を元の色にする" value={!fx.ink} onChange={on => setFx(i, {...fx, ink: on ? '' : '#1A1A1A'})} labelPosition="start" labelSpacing="spread" width="100%" />
              {!!fx.ink && <ColorRow label="点の色" value={fx.ink} onChange={ink => setFx(i, {...fx, ink})} />}
            </VStack>
          )}
          {fx.kind === 'duotone' && (
            <VStack gap={2}>
              <ColorRow label="暗い所の色" value={fx.dark} onChange={dark => setFx(i, {...fx, dark})} />
              <ColorRow label="明るい所の色" value={fx.light} onChange={light => setFx(i, {...fx, light})} />
              <Slider label="強さ" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
            </VStack>
          )}
          {fx.kind === 'lightLeak' && (
            <VStack gap={2}>
              <ColorRow label="光の色" value={fx.color} onChange={color => setFx(i, {...fx, color})} />
              <Slider label="強さ" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
            </VStack>
          )}
          {fx.kind === 'bloom' && (
            <VStack gap={2}>
              <Slider
                label="光る明るさ"
                description="これより明るい所がにじみます"
                value={fx.threshold}
                min={0}
                max={0.95}
                step={0.01}
                valueDisplay="text"
                formatValue={pct}
                onChange={(threshold: number) => setFx(i, {...fx, threshold})}
              />
              <Slider label="強さ" value={fx.amount} min={0} max={2} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
              <Slider label="広がり" value={fx.radius} min={1} max={60} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(radius: number) => setFx(i, {...fx, radius})} />
            </VStack>
          )}
          {fx.kind === 'lensFlare' && (
            <VStack gap={2}>
              <HStack gap={2}>
                <Slider
                  label="光の横の位置"
                  value={fx.x}
                  min={-1}
                  max={1}
                  step={0.01}
                  valueDisplay="text"
                  formatValue={v => (v < -0.05 ? '左' : v > 0.05 ? '右' : '真ん中') + `（${Math.round(v * 100)}）`}
                  onChange={(x: number) => setFx(i, {...fx, x})}
                />
                <Slider
                  label="光の縦の位置"
                  value={fx.y}
                  min={-1}
                  max={1}
                  step={0.01}
                  valueDisplay="text"
                  formatValue={v => (v < -0.05 ? '上' : v > 0.05 ? '下' : '真ん中') + `（${Math.round(v * 100)}）`}
                  onChange={(y: number) => setFx(i, {...fx, y})}
                />
              </HStack>
              <ColorRow label="光の色" value={fx.color} onChange={color => setFx(i, {...fx, color})} />
              <Slider label="強さ" value={fx.amount} min={0} max={1} step={0.01} valueDisplay="text" formatValue={pct} onChange={(amount: number) => setFx(i, {...fx, amount})} />
            </VStack>
          )}
          {fx.kind === 'bulge' && (
            <VStack gap={2}>
              <Slider
                label="膨らみ"
                description="マイナスにすると真ん中が縮みます"
                value={fx.amount}
                min={-1}
                max={1}
                step={0.01}
                valueDisplay="text"
                formatValue={pct}
                onChange={(amount: number) => setFx(i, {...fx, amount})}
              />
            </VStack>
          )}
          {fx.kind === 'mirror' && (
            <VStack gap={2}>
              <Selector
                label="写し方"
                value={fx.mode}
                options={[
                  {value: 'left', label: '左半分を右へ'},
                  {value: 'right', label: '右半分を左へ'},
                  {value: 'top', label: '上半分を下へ'},
                  {value: 'bottom', label: '下半分を上へ'},
                  {value: 'quad', label: '左上を 4 つに'},
                  {value: 'kaleido', label: '万華鏡'},
                ]}
                onChange={v => setFx(i, {...fx, mode: v as typeof fx.mode})}
              />
              {fx.mode === 'kaleido' && (
                <Slider
                  label="分かれる数"
                  value={fx.segments}
                  min={2}
                  max={24}
                  step={1}
                  valueDisplay="text"
                  formatValue={v => `${v} つ`}
                  onChange={(segments: number) => setFx(i, {...fx, segments})}
                />
              )}
            </VStack>
          )}
          {fx.kind === 'tile' && (
            <VStack gap={2}>
              <Slider label="縦横の数" value={fx.count} min={2} max={12} step={1} valueDisplay="text" formatValue={v => `${v} × ${v}`} onChange={(count: number) => setFx(i, {...fx, count})} />
              <Switch
                label="ひとつおきに裏返す"
                description="つなぎ目が目立たなくなります"
                value={fx.flip}
                onChange={flip => setFx(i, {...fx, flip})}
                labelPosition="start"
                labelSpacing="spread"
                width="100%"
              />
            </VStack>
          )}
          {fx.kind === 'colorKeep' && (
            <VStack gap={2}>
              <ColorRow label="残す色" value={fx.color} onChange={color => setFx(i, {...fx, color})} />
              <Slider
                label="色の幅"
                description="広げると近い色も残ります"
                value={fx.range}
                min={0}
                max={0.5}
                step={0.01}
                valueDisplay="text"
                formatValue={pct}
                onChange={(range: number) => setFx(i, {...fx, range})}
              />
              <Slider label="境目のなめらかさ" value={fx.soft} min={0} max={0.5} step={0.01} valueDisplay="text" formatValue={pct} onChange={(soft: number) => setFx(i, {...fx, soft})} />
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
          {fx.kind === 'plugin' && (
            <VStack gap={2}>
              {(fx.params ?? []).map(pa => (
                <Slider
                  key={pa.key}
                  label={pa.label}
                  value={fx.values[pa.key] ?? pa.default}
                  min={pa.min}
                  max={pa.max}
                  step={pa.step || 0.01}
                  valueDisplay="text"
                  formatValue={v => `${Math.round(v * 1000) / 1000}`}
                  onChange={(v: number) => setFx(i, {...fx, values: {...fx.values, [pa.key]: v}})}
                />
              ))}
              {!fx.canvas && <Text type="supporting">このエフェクトはプレビューには出ません（書き出しでは掛かります）</Text>}
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

const TIMER_FORMAT: Record<Timer['format'], string> = {s: '10', 'm:ss': '1:05', 'h:mm:ss': '0:01:05', 'm:ss.cc': '1:05.30'};

/** 分と秒で入れる（タイマーの値） */
function MinSec({label, value, onChange}: {label: string; value: number; onChange: (v: number) => void}) {
  const m = Math.floor(value / 60);
  const sec = Math.round((value - m * 60) * 100) / 100;
  return (
    <HStack gap={2} vAlign="end">
      <NumberInput label={label} units="分" value={m} min={0} max={999} onChange={v => onChange(Math.max(0, v) * 60 + sec)} />
      <NumberInput label="" aria-label={`${label}（秒）`} units="秒" value={sec} min={0} max={59.99} step={1} onChange={v => onChange(m * 60 + Math.min(59.99, Math.max(0, v)))} />
    </HStack>
  );
}

/** タイマー：数字が時間どおりに減る・増える（カウントダウン・カウントアップ） */
function TimerFields({clip}: {clip: TextClip}) {
  const fps = useStore(s => s.project?.video.fps ?? 30);
  const t = clip.timer;
  const set = (timer: Timer | null) => updateClip(clip.id, {timer, ...(timer ? {charAnim: null} : {})});
  return (
    <>
      <Switch
        label="タイマーにする"
        description="数字が時間どおりに減る（増える）文字にします。文の中の {t} が時間になり、{t} がなければ文全体が時間になります"
        value={!!t}
        onChange={on => set(on ? {from: Math.round(clip.duration / fps), to: 0, format: 'm:ss'} : null)}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      {t && (
        <VStack gap={2} data-timer-fields>
          <SegmentedControl label="表し方" size="sm" layout="fill" value={t.format} onChange={v => set({...t, format: v as Timer['format']})}>
            {(Object.keys(TIMER_FORMAT) as Timer['format'][]).map(k => (
              <SegmentedControlItem key={k} value={k} label={TIMER_FORMAT[k]} />
            ))}
          </SegmentedControl>
          <MinSec label="始まりの値" value={t.from} onChange={from => set({...t, from})} />
          <MinSec label="終わりの値" value={t.to} onChange={to => set({...t, to})} />
          <HStack gap={2} hAlign="start" wrap="wrap">
            <Button label="アイテムの長さで 0 まで数える" size="sm" variant="ghost" onClick={() => set({...t, from: Math.round((clip.duration / fps) * 100) / 100, to: 0})} />
            <Button label="0 から数え上げる" size="sm" variant="ghost" onClick={() => set({...t, from: 0, to: Math.max(t.from, t.to, 5999)})} />
          </HStack>
          <Hint>{t.to < t.from ? 'カウントダウン：終わりの値で止まります' : 'カウントアップ：終わりの値で止まります'}</Hint>
        </VStack>
      )}
    </>
  );
}

/** 吹き出し：形・色・しっぽの向き（立ち絵へ向けられる） */
function BubbleFields({clip}: {clip: TextClip}) {
  const b = clip.bubble;
  const set = (bubble: Bubble | null) => updateClip(clip.id, {bubble});
  // しっぽを向ける先：このアイテムの間に出ている立ち絵（いちばん近いもの）
  const target = useStore(s => {
    const p = s.project;
    if (!p) return null;
    const mid = clip.start + clip.duration / 2;
    const ps = p.clips.filter((c): c is PortraitClip => c.type === 'portrait' && c.start < clip.start + clip.duration && clip.start < c.start + c.duration);
    const best = ps.sort(
      (a, z) => Math.abs(a.start + a.duration / 2 - mid) - Math.abs(z.start + z.duration / 2 - mid) || Math.abs(a.transform.x - clip.transform.x) - Math.abs(z.transform.x - clip.transform.x),
    )[0];
    if (!best) return null;
    const name = p.characters.find(ch => ch.id === best.characterId)?.name ?? '立ち絵';
    return `${name}|${best.transform.x}|${best.transform.y}`;
  });
  return (
    <>
      <Switch
        label="吹き出しにする"
        description="文字のまわりに枠としっぽを描きます"
        value={!!b}
        onChange={on => {
          if (!on) return set(null);
          const {label: _l, ...pr} = BUBBLE_PRESET.round;
          updateClip(clip.id, {bubble: {kind: 'round', ...pr}, ...(clip.color.toUpperCase() === '#FFFFFF' ? {color: '#222222', outlineWidth: 0} : {})});
        }}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      {b && (
        <VStack gap={2} data-bubble-fields>
          <SegmentedControl
            label="形"
            size="sm"
            layout="fill"
            value={b.kind}
            onChange={v => {
              const k = v as Bubble['kind'];
              const {label: _l, fill, padding} = BUBBLE_PRESET[k];
              set({...b, kind: k, padding, fill: b.fill === BUBBLE_PRESET[b.kind].fill ? fill : b.fill});
            }}>
            {(Object.keys(BUBBLE_PRESET) as Bubble['kind'][]).map(k => (
              <SegmentedControlItem key={k} value={k} label={BUBBLE_PRESET[k].label} />
            ))}
          </SegmentedControl>
          <ColorRow label="中の色" value={b.fill} onChange={fill => set({...b, fill})} />
          <ColorRow label="枠の色" value={b.stroke} onChange={stroke => set({...b, stroke})} />
          <HStack gap={2}>
            <NumberInput label="枠の太さ" units="px" value={b.strokeWidth} min={0} max={40} onChange={strokeWidth => set({...b, strokeWidth})} />
            <NumberInput label="文字との間" units="px" value={b.padding} min={0} max={200} onChange={padding => set({...b, padding})} />
          </HStack>
          <Slider
            label="しっぽの長さ"
            value={b.tailLength}
            min={0}
            max={300}
            step={2}
            valueDisplay="text"
            formatValue={v => (v ? `${v}px` : 'なし')}
            onChange={(tailLength: number) => set({...b, tailLength})}
          />
          {b.tailLength > 0 && (
            <>
              <Slider
                label="しっぽの向き"
                value={((b.tailAngle % 360) + 360) % 360}
                min={0}
                max={359}
                step={1}
                valueDisplay="text"
                formatValue={v => `${['右', '右下', '下', '左下', '左', '左上', '上', '右上'][Math.round(v / 45) % 8]}（${v}°）`}
                onChange={(tailAngle: number) => set({...b, tailAngle})}
              />
              <Button
                label={target ? `しっぽを${target.split('|')[0]}へ向ける` : 'しっぽを立ち絵へ向ける'}
                size="sm"
                variant="ghost"
                isDisabled={!target}
                tooltip={target ? undefined : 'このアイテムの間に立ち絵アイテムがありません'}
                onClick={() => {
                  if (!target) return;
                  const [, tx, ty] = target.split('|').map(Number);
                  set({...b, tailAngle: (angleTo(clip.transform, {x: tx, y: ty}) + 360) % 360});
                }}
              />
            </>
          )}
        </VStack>
      )}
    </>
  );
}

const ANIM_TITLE = (a: ShapeAnim) => (a.kind === 'particles' ? PARTICLE_PRESET[a.type].label : a.kind === 'lines' ? LINES_PRESET[a.type].label : a.kind === 'progress' ? '進行バー' : 'グラフ');
const CHART_LABEL: Record<Chart['chart'], string> = {bar: '棒', pie: '円', line: '折れ線'};
const PALETTE = ['#5AC8FA', '#FF9500', '#34C759', '#FF3B30', '#AF52DE', '#FFCC00', '#FF2D55', '#8E8E93'];

/** 動く図形（粒・進行バー・グラフ）の設定 */
function AnimFields({clip}: {clip: ShapeClip}) {
  const a = clip.anim!;
  const set = (anim: ShapeAnim) => updateClip(clip.id, {anim});
  if (a.kind === 'particles')
    return (
      <VStack gap={2} data-anim-fields="particles">
        <SegmentedControl
          label="種類"
          size="sm"
          layout="fill"
          value={a.type}
          onChange={v => {
            const t = v as Particles['type'];
            const pr = PARTICLE_PRESET[t];
            set({...a, type: t, amount: pr.amount, size: pr.size, speed: pr.speed, colors: pr.colors});
          }}>
          {(Object.keys(PARTICLE_PRESET) as Particles['type'][]).map(k => (
            <SegmentedControlItem key={k} value={k} label={PARTICLE_PRESET[k].label} />
          ))}
        </SegmentedControl>
        <Slider label="量" value={a.amount} min={5} max={400} step={5} valueDisplay="text" formatValue={v => `${v} 個`} onChange={(amount: number) => set({...a, amount})} />
        <Slider label="粒の大きさ" value={a.size} min={2} max={80} step={1} valueDisplay="text" formatValue={v => `${v}px`} onChange={(size: number) => set({...a, size})} />
        {a.type !== 'sparkle' && (
          <SegmentedControl label="速さ" size="sm" layout="fill" value={String(a.speed)} onChange={v => set({...a, speed: Number(v)})}>
            <SegmentedControlItem value="1" label="ゆっくり" />
            <SegmentedControlItem value="2" label="ふつう" />
            <SegmentedControlItem value="3" label="はやい" />
          </SegmentedControl>
        )}
        <ColorRow label="色" value={a.colors[0] ?? '#ffffff'} onChange={c => set({...a, colors: [c, ...a.colors.slice(1)]})} />
        {a.colors.length > 1 && <Button label="色を 1 つにする" size="sm" variant="ghost" onClick={() => set({...a, colors: a.colors.slice(0, 1)})} />}
        {a.colors.length <= 1 && <Button label="いつもの色に戻す" size="sm" variant="ghost" onClick={() => set({...a, colors: PARTICLE_PRESET[a.type].colors})} />}
        <Hint>4 秒ごとにくり返す動きなので、アイテムを長くしても途切れません</Hint>
      </VStack>
    );
  if (a.kind === 'progress')
    return (
      <VStack gap={2} data-anim-fields="progress">
        <Text type="supporting">アイテムの頭から終わりまでで伸びます。動画全体に合わせるときは、アイテムを動画の長さにしてください</Text>
        <ColorRow label="まだのところの色" value={a.trackColor} onChange={trackColor => set({...a, trackColor})} />
        <Switch label="マーカーで章に区切る" value={a.chapters} onChange={chapters => set({...a, chapters})} labelPosition="start" labelSpacing="spread" width="100%" />
        {a.chapters && (
          <Switch
            label="章の名前を出す"
            description="マーカーの名前を、区切りの上に出します"
            value={a.labels}
            onChange={labels => set({...a, labels})}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
          />
        )}
        {a.chapters && a.labels && <ColorRow label="章の名前の色" value={clip.stroke || '#ffffff'} onChange={stroke => updateClip(clip.id, {stroke})} />}
      </VStack>
    );
  if (a.kind === 'lines')
    return (
      <VStack gap={2} data-anim-fields="lines">
        <SegmentedControl
          label="種類"
          size="sm"
          layout="fill"
          value={a.type}
          onChange={v => {
            const t = v as Lines['type'];
            const pr = LINES_PRESET[t];
            set({...a, type: t, color: pr.color, density: pr.density, inner: pr.inner, thickness: pr.thickness, flicker: pr.flicker});
          }}>
          {(Object.keys(LINES_PRESET) as Lines['type'][]).map(k => (
            <SegmentedControlItem key={k} value={k} label={LINES_PRESET[k].label} />
          ))}
        </SegmentedControl>
        <ColorRow label="色" value={a.color} onChange={color => set({...a, color})} />
        {a.type !== 'anger' && (
          <Slider label="線の数" value={a.density} min={8} max={300} step={2} valueDisplay="text" formatValue={v => `${v} 本`} onChange={(density: number) => set({...a, density})} />
        )}
        {a.type === 'focus' && (
          <Slider
            label="真ん中の空き"
            value={a.inner}
            min={0}
            max={0.9}
            step={0.01}
            valueDisplay="text"
            formatValue={v => `${Math.round(v * 100)}%`}
            onChange={(inner: number) => set({...a, inner})}
          />
        )}
        <Slider label="太さ" value={a.thickness} min={1} max={30} step={1} valueDisplay="text" formatValue={v => `${v}px`} onChange={(thickness: number) => set({...a, thickness})} />
        <Switch
          label={a.type === 'anger' ? '脈打たせる' : 'ちらつかせる'}
          description={a.type === 'anger' ? undefined : '2 コマごとに線を描き直して、勢いを出します'}
          value={a.flicker}
          onChange={flicker => set({...a, flicker})}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
      </VStack>
    );
  const items = a.items;
  const setItem = (i: number, patch: Partial<Chart['items'][number]>) => set({...a, items: items.map((it, k) => (k === i ? {...it, ...patch} : it))});
  return (
    <VStack gap={2} data-anim-fields="chart">
      <SegmentedControl label="グラフの種類" size="sm" layout="fill" value={a.chart} onChange={v => set({...a, chart: v as Chart['chart']})}>
        {(Object.keys(CHART_LABEL) as Chart['chart'][]).map(k => (
          <SegmentedControlItem key={k} value={k} label={CHART_LABEL[k]} />
        ))}
      </SegmentedControl>
      {items.map((it, i) => (
        <HStack key={i} gap={1} vAlign="end">
          <div style={{flex: 2, minWidth: 0}}>
            <TextInput label={i === 0 ? '名前' : ''} aria-label={`${i + 1} つ目の名前`} size="sm" value={it.label} onChange={label => setItem(i, {label})} />
          </div>
          <div style={{flex: 1.4, minWidth: 0}}>
            <NumberInput label={i === 0 ? '数' : ''} aria-label={`${i + 1} つ目の数`} size="sm" value={it.value} step={1} onChange={value => setItem(i, {value})} />
          </div>
          <ColorRow label="" value={it.color} onChange={color => setItem(i, {color})} />
          <IconButton label="この行を消す" size="sm" variant="ghost" icon={<Icon icon={X} />} isDisabled={items.length <= 1} onClick={() => set({...a, items: items.filter((_, k) => k !== i)})} />
        </HStack>
      ))}
      <Button
        label="行を足す"
        size="sm"
        variant="ghost"
        icon={<Icon icon={Plus} />}
        isDisabled={items.length >= 12}
        onClick={() => set({...a, items: [...items, {label: `項目 ${items.length + 1}`, value: 10, color: PALETTE[items.length % PALETTE.length]}]})}
      />
      <HStack gap={2}>
        <TextInput label="単位" size="sm" placeholder="%・人・円 など" value={a.unit} onChange={unit => set({...a, unit})} />
        <NumberInput label="伸びきるまで" units="フレーム" size="sm" value={a.grow} min={1} max={600} onChange={grow => set({...a, grow: Math.max(1, grow)})} />
      </HStack>
      <Switch label="数を出す" value={a.showValues} onChange={showValues => set({...a, showValues})} labelPosition="start" labelSpacing="spread" width="100%" />
      <ColorRow label="文字の色" value={a.textColor} onChange={textColor => set({...a, textColor})} />
    </VStack>
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
          <SpanButton host={() => textRef.current} value={clip.text} onChange={text => set({text})} />
        </HStack>
        <Switch label="縦書き" value={!!clip.vertical} onChange={vertical => set({vertical: vertical || undefined})} labelPosition="start" labelSpacing="spread" width="100%" />
        <Switch
          label="1 文字ずつ出す"
          value={!!clip.charAnim}
          onChange={on => set({charAnim: on ? {kind: 'fade', interval: 3, length: 8} : null})}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
        {clip.charAnim && (
          <VStack gap={2}>
            <Selector
              label="出かた"
              value={clip.charAnim.kind}
              options={(Object.keys(CHAR_ANIM_LABEL) as CharAnim['kind'][]).map(k => ({value: k, label: CHAR_ANIM_LABEL[k]}))}
              onChange={(v: string) => set({charAnim: {...clip.charAnim!, kind: v as CharAnim['kind']}})}
              width="100%"
            />
            {clip.charAnim.kind === 'karaoke' && <ColorRow label="塗る色" value={clip.charAnim.color || KARAOKE_COLOR} onChange={color => set({charAnim: {...clip.charAnim!, color}})} />}
            <Slider
              label="次の文字までの間隔"
              value={clip.charAnim.interval}
              min={1}
              max={30}
              step={1}
              valueDisplay="text"
              formatValue={v => `${v} フレーム`}
              onChange={(interval: number) => set({charAnim: {...clip.charAnim!, interval}})}
            />
            {clip.charAnim.kind !== 'type' && (
              <Slider
                label="1 文字が出きるまで"
                value={clip.charAnim.length}
                min={1}
                max={60}
                step={1}
                valueDisplay="text"
                formatValue={v => `${v} フレーム`}
                onChange={(length: number) => set({charAnim: {...clip.charAnim!, length}})}
              />
            )}
          </VStack>
        )}
        <TimerFields clip={clip} />
        <BubbleFields clip={clip} />
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

const NO_SCENES: Scene[] = [];

export function ShapeInspector({clip}: {clip: ShapeClip}) {
  const set = (patch: Partial<ShapeClip>) => updateClip(clip.id, patch);
  const ctl = clip.control;
  const scenes = (useStore(s => s.project?.scenes) ?? NO_SCENES).filter(x => x.id !== MAIN_SCENE);
  const editing = useStore(s => s.project?.sceneId ?? null);
  if (clip.scene)
    return (
      <>
        <VStack gap={3} paddingBlock={4} paddingInline={4}>
          <ItemHeader clip={clip} title="シーン" />
          <Selector label="置くシーン" value={clip.scene} options={scenes.filter(x => x.id !== editing).map(x => ({value: x.id, label: x.name}))} onChange={v => set({scene: v})} width="100%" />
          <Text type="supporting">シーンを、このアイテムの頭から再生して置きます。位置・大きさ・回転・エフェクトはシーン全体に掛かります。</Text>
          <TextInput label="シーンの名前" value={scenes.find(x => x.id === clip.scene)?.name ?? ''} onChange={name => renameScene(clip.scene!, name)} />
          <div>
            <Button label="このシーンを開く" size="sm" variant="secondary" onClick={() => openScene(clip.scene!)} />
          </div>
        </VStack>
        <Divider />
        <LookEditor clip={clip} />
      </>
    );
  if (ctl)
    return (
      <>
        <VStack gap={3} paddingBlock={4} paddingInline={4}>
          <ItemHeader clip={clip} title={CONTROL_LABEL[ctl.kind]} />
          <SegmentedControl label="種類" layout="fill" value={ctl.kind} onChange={v => set({control: {...ctl, kind: v as Control['kind']}})}>
            <SegmentedControlItem value="group" label="グループ制御" />
            <SegmentedControlItem value="camera" label="カメラ" />
            <SegmentedControlItem value="adjust" label="調整レイヤー" />
          </SegmentedControl>
          <Text type="supporting">
            {ctl.kind === 'group'
              ? 'すぐ下のレイヤーをまとめて、このアイテムの位置・大きさ・回転・不透明度・エフェクトで動かします。'
              : ctl.kind === 'camera'
                ? '下のレイヤー全部を、カメラを動かしたように見せます（右へ動かすと絵は左へ、大きくすると寄ります）。字幕は動きません。'
                : '下のレイヤー全部に、このアイテムの映像エフェクト・不透明度・フェードを掛けます。'}
          </Text>
          {ctl.kind === 'group' && (
            <NumberInput
              label="まとめるレイヤーの数"
              description="このレイヤーのすぐ下から数えます"
              value={ctl.layers}
              min={1}
              max={99}
              step={1}
              onChange={layers => set({control: {...ctl, layers: Math.max(1, Math.round(layers))}})}
            />
          )}
        </VStack>
        <Divider />
        <LookEditor clip={clip} />
      </>
    );
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <ItemHeader
          clip={clip}
          title={
            clip.anim
              ? ANIM_TITLE(clip.anim)
              : clip.viz
                ? clip.viz === 'bars'
                  ? '音声のスペクトラム'
                  : '音声の波形'
                : clip.region
                  ? clip.region.kind === 'mosaic'
                    ? 'モザイク範囲'
                    : 'ぼかし範囲'
                  : '図形'
          }
        />
        {clip.anim && <AnimFields clip={clip} />}
        {clip.viz && (
          <VStack gap={2}>
            <SegmentedControl label="出しかた" layout="fill" value={clip.viz} onChange={v => set({viz: v as 'wave' | 'bars'})}>
              <SegmentedControlItem value="wave" label="波形" />
              <SegmentedControlItem value="bars" label="スペクトラム" />
            </SegmentedControl>
            <Text type="supporting">動画の音（セリフ・BGM・効果音を混ぜたもの）を、この大きさと色で描きます。プレビューはセリフの音の大きさからの目安です。</Text>
          </VStack>
        )}
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
        {!clip.viz && !clip.anim && (
          <Selector
            label="形"
            value={clip.shape}
            options={(Object.keys(SHAPE_LABEL) as ShapeKind[]).map(k => ({value: k, label: SHAPE_LABEL[k]}))}
            onChange={v => set({shape: v as ShapeKind})}
            width="100%"
          />
        )}
        <HStack gap={2}>
          <NumberInput label="幅" units="px" value={clip.width} min={1} max={8000} step={10} onChange={width => set({width})} />
          <NumberInput label={clip.shape === 'line' ? '太さ' : '高さ'} units="px" value={clip.height} min={1} max={8000} step={clip.shape === 'line' ? 1 : 10} onChange={height => set({height})} />
        </HStack>
        {!clip.region && (!clip.anim || clip.anim.kind === 'progress') && (
          <ColorRow label={clip.anim ? '進んだところの色' : clip.shape === 'line' ? '線の色' : '塗りの色'} value={clip.fill} onChange={fill => set({fill})} />
        )}
        {clip.shape !== 'line' && !clip.region && !clip.viz && !clip.anim && (
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
