// 文字の飾り：ひな形を押すだけで飾りが付く。下の欄で影・外側の縁・背景の帯・グラデーションを細かく直せる。
// 見本は実際の textImage で描くので、プレビューと書き出しと同じ見た目になる。

import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import type {TextClip} from '../model';
import {textImage} from '../preview/visual';
import {updateClip} from '../store';
import {isTextStyle, TEXT_STYLES, type TextStyle} from '../textStyles';
import {ColorRow} from './VisualInspector';

/** 見本の画像（ひな形ごとに 1 回だけ描く） */
const thumbs = new Map<string, string>();
function thumb(s: TextStyle): string {
  let url = thumbs.get(s.id);
  if (!url) {
    const c = {
      id: 'thumb',
      trackId: '',
      start: 0,
      duration: 1,
      type: 'text',
      text: 'あア',
      fontSize: 56,
      align: 'center',
      transform: {x: 0, y: 0, scale: 1, opacity: 1},
      ...s.look,
    } as TextClip;
    url = textImage(c).toDataURL('image/png');
    thumbs.set(s.id, url);
  }
  return url;
}

export function TextDecoPicker({clip}: {clip: TextClip}) {
  const set = (patch: Partial<TextClip>) => updateClip(clip.id, patch);
  return (
    <VStack gap={3}>
      <Heading level={3}>文字の飾り</Heading>
      <div className="vx-fx-grid vx-ts-grid" role="group" aria-label="文字の飾りのひな形">
        {TEXT_STYLES.map(s => (
          <button key={s.id} type="button" className="vx-fx-tile" data-style={s.id} aria-pressed={isTextStyle(clip, s)} onClick={() => set(s.look)}>
            <span className="vx-fx-demo vx-ts-demo" aria-hidden>
              <img src={thumb(s)} alt="" />
            </span>
            <span className="vx-fx-name">{s.label}</span>
          </button>
        ))}
      </div>
      <Text type="supporting">押すと、色・縁・影・帯がまとめて変わります。文字・大きさ・位置・動きはそのままです。</Text>
    </VStack>
  );
}

/** 飾りの細かい設定（ひな形を選んだあとに直す） */
export function TextDecoFields({clip}: {clip: TextClip}) {
  const set = (patch: Partial<TextClip>) => updateClip(clip.id, patch);
  const px = (v: number) => `${Math.round(v)} px`;
  return (
    <>
      <Collapsible defaultIsOpen={!!clip.shadowColor} trigger={<Text type="label">影・光</Text>}>
        <VStack gap={2} paddingBlockStart={2}>
          <ColorRow
            label="影の色"
            value={clip.shadowColor ?? ''}
            allowNone
            onChange={shadowColor => set({shadowColor, shadowBlur: clip.shadowBlur ?? 6, shadowX: clip.shadowX ?? 4, shadowY: clip.shadowY ?? 4})}
          />
          {clip.shadowColor && (
            <>
              <Slider label="ぼかし" value={clip.shadowBlur ?? 0} min={0} max={40} step={1} valueDisplay="text" formatValue={px} onChange={(shadowBlur: number) => set({shadowBlur})} />
              <HStack gap={2}>
                <NumberInput label="横のずれ" units="px" value={clip.shadowX ?? 0} min={-60} max={60} onChange={shadowX => set({shadowX})} />
                <NumberInput label="縦のずれ" units="px" value={clip.shadowY ?? 0} min={-60} max={60} onChange={shadowY => set({shadowY})} />
              </HStack>
              <Text type="supporting">ずれを 0 にしてぼかすと、文字が光って見えます。</Text>
            </>
          )}
        </VStack>
      </Collapsible>
      <Collapsible defaultIsOpen={!!clip.outline2Color} trigger={<Text type="label">外側の縁</Text>}>
        <VStack gap={2} paddingBlockStart={2}>
          <ColorRow label="外側の縁の色" value={clip.outline2Color ?? ''} allowNone onChange={outline2Color => set({outline2Color, outline2Width: clip.outline2Width || 6})} />
          {clip.outline2Color && <NumberInput label="外側の縁の太さ" units="px" value={clip.outline2Width ?? 0} min={0} max={60} onChange={outline2Width => set({outline2Width})} />}
        </VStack>
      </Collapsible>
      <Collapsible defaultIsOpen={!!clip.boxColor} trigger={<Text type="label">背景の帯</Text>}>
        <VStack gap={2} paddingBlockStart={2}>
          <ColorRow label="帯の色" value={clip.boxColor ?? ''} allowNone onChange={boxColor => set({boxColor})} />
          {clip.boxColor && (
            <>
              <Slider
                label="帯の不透明度"
                value={clip.boxOpacity ?? 1}
                min={0.1}
                max={1}
                step={0.01}
                valueDisplay="text"
                formatValue={v => `${Math.round(v * 100)}%`}
                onChange={(boxOpacity: number) => set({boxOpacity})}
              />
              <HStack gap={2}>
                <NumberInput label="文字のまわりの余白" units="px" value={clip.boxPadding ?? 16} min={0} max={200} onChange={boxPadding => set({boxPadding})} />
                <NumberInput label="角の丸み" units="px" value={clip.boxRadius ?? 12} min={0} max={200} onChange={boxRadius => set({boxRadius})} />
              </HStack>
            </>
          )}
        </VStack>
      </Collapsible>
      <Collapsible defaultIsOpen={!!clip.gradientColor} trigger={<Text type="label">グラデーション</Text>}>
        <VStack gap={2} paddingBlockStart={2}>
          <ColorRow label="下の色" value={clip.gradientColor ?? ''} allowNone onChange={gradientColor => set({gradientColor})} />
          <Text type="supporting">上は「文字の色」、下へ向かってこの色に変わります。</Text>
        </VStack>
      </Collapsible>
    </>
  );
}
