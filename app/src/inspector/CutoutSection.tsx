// 素材の「切り抜き」「形で切り抜く（マスク）」「色を抜く（クロマキー）」（CapCut の切り抜き・マスク・クロマキー）
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Slider} from '@astryxdesign/core/Slider';
import {Switch} from '@astryxdesign/core/Switch';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {chromaWeights, type Chroma, type Crop, type Mask, type MediaClip} from '../model';
import {updateClip} from '../store';
import {ColorRow} from './VisualInspector';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const NO_CROP: Crop = {left: 0, top: 0, right: 0, bottom: 0};
const DEFAULT_MASK: Mask = {shape: 'ellipse', x: 0, y: 0, w: 0.7, h: 0.7, radius: 0.1, feather: 0.05, invert: false};
const DEFAULT_CHROMA: Chroma = {color: '#00FF00', similarity: 0.4, blend: 0.1};

/** 画面の色を拾う（Chromium の EyeDropper。ない環境では出さない） */
const eyeDropper = (globalThis as unknown as {EyeDropper?: new () => {open: () => Promise<{sRGBHex: string}>}}).EyeDropper;

function Block({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <Heading level={3}>{title}</Heading>
      {children}
    </VStack>
  );
}

export function CutoutSection({clip}: {clip: MediaClip}) {
  const set = (patch: Partial<MediaClip>) => updateClip(clip.id, patch);
  const crop = clip.crop ?? NO_CROP;
  const setCrop = (p: Partial<Crop>) => {
    const c = {...crop, ...p};
    set({crop: c.left || c.top || c.right || c.bottom ? c : undefined});
  };
  const mask = clip.mask;
  const setMask = (p: Partial<Mask>) => set({mask: {...(mask ?? DEFAULT_MASK), ...p}});
  const ch = clip.chroma;
  const setChroma = (p: Partial<Chroma>) => set({chroma: {...(ch ?? DEFAULT_CHROMA), ...p}});
  return (
    <>
      <Block title="切り抜き">
        <HStack gap={3}>
          <Slider label="左" value={crop.left} min={0} max={0.45} step={0.01} valueDisplay="text" formatValue={pct} onChange={(left: number) => setCrop({left})} />
          <Slider label="右" value={crop.right} min={0} max={0.45} step={0.01} valueDisplay="text" formatValue={pct} onChange={(right: number) => setCrop({right})} />
        </HStack>
        <HStack gap={3}>
          <Slider label="上" value={crop.top} min={0} max={0.45} step={0.01} valueDisplay="text" formatValue={pct} onChange={(top: number) => setCrop({top})} />
          <Slider label="下" value={crop.bottom} min={0} max={0.45} step={0.01} valueDisplay="text" formatValue={pct} onChange={(bottom: number) => setCrop({bottom})} />
        </HStack>
        {clip.crop && <Button size="sm" variant="ghost" label="切り抜きをやめる" onClick={() => set({crop: undefined})} />}
      </Block>
      <Block title="形で切り抜く">
        <SegmentedControl label="形" size="sm" value={mask?.shape ?? 'none'} onChange={v => (v === 'none' ? set({mask: undefined}) : setMask({shape: v as Mask['shape']}))}>
          <SegmentedControlItem value="none" label="なし" />
          <SegmentedControlItem value="ellipse" label="丸" />
          <SegmentedControlItem value="rect" label="四角" />
        </SegmentedControl>
        {mask && (
          <>
            <HStack gap={3}>
              <Slider label="幅" value={mask.w} min={0.05} max={1.5} step={0.01} valueDisplay="text" formatValue={pct} onChange={(w: number) => setMask({w})} />
              <Slider label="高さ" value={mask.h} min={0.05} max={1.5} step={0.01} valueDisplay="text" formatValue={pct} onChange={(h: number) => setMask({h})} />
            </HStack>
            <HStack gap={3}>
              <Slider label="横の位置" value={mask.x} min={-0.5} max={0.5} step={0.01} valueDisplay="text" formatValue={pct} onChange={(x: number) => setMask({x})} />
              <Slider label="縦の位置" value={mask.y} min={-0.5} max={0.5} step={0.01} valueDisplay="text" formatValue={pct} onChange={(y: number) => setMask({y})} />
            </HStack>
            {mask.shape === 'rect' && (
              <Slider label="角の丸み" value={mask.radius} min={0} max={0.5} step={0.01} valueDisplay="text" formatValue={pct} onChange={(radius: number) => setMask({radius})} />
            )}
            <Slider label="境目のぼかし" value={mask.feather} min={0} max={0.3} step={0.005} valueDisplay="text" formatValue={pct} onChange={(feather: number) => setMask({feather})} />
            <Switch label="外側を残す" value={mask.invert} onChange={invert => setMask({invert})} labelPosition="start" labelSpacing="spread" width="100%" />
          </>
        )}
      </Block>
      <Block title="背景">
        <Switch
          label="背景をぼかして埋める"
          description="縦長の画面に横長の素材を置いたときなどに、すき間を同じ素材のぼかしで埋めます"
          value={!!clip.fillBlur}
          onChange={on => set({fillBlur: on ? 30 : undefined})}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
        {!!clip.fillBlur && (
          <Slider label="ぼかしの強さ" value={clip.fillBlur} min={2} max={80} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(fillBlur: number) => set({fillBlur})} />
        )}
      </Block>
      <Block title="色を抜く（クロマキー）">
        <Switch
          label="背景の色を抜く"
          description="グリーンバック・ブルーバックの背景を透明にします"
          value={!!ch}
          onChange={on => set({chroma: on ? DEFAULT_CHROMA : undefined})}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
        {ch && (
          <>
            <ColorRow label="抜く色" value={ch.color} onChange={color => setChroma({color})} />
            <HStack gap={2} wrap="wrap">
              <Button size="sm" variant="secondary" label="緑" onClick={() => setChroma({color: '#00FF00'})} />
              <Button size="sm" variant="secondary" label="青" onClick={() => setChroma({color: '#0047BB'})} />
              {eyeDropper && (
                <Button
                  size="sm"
                  variant="secondary"
                  label="プレビューから色を拾う"
                  onClick={() => {
                    void new eyeDropper!()
                      .open()
                      .then(r => setChroma({color: r.sRGBHex.toUpperCase()}))
                      .catch(() => {});
                  }}
                />
              )}
            </HStack>
            {!chromaWeights(ch.color) && <Text type="supporting">白・黒・灰色に近い色は、色で見分けられないので抜けません</Text>}
            <Slider label="抜く強さ" value={ch.similarity} min={0} max={0.95} step={0.01} valueDisplay="text" formatValue={pct} onChange={(similarity: number) => setChroma({similarity})} />
            <Slider label="境目のなめらかさ" value={ch.blend} min={0.01} max={0.6} step={0.01} valueDisplay="text" formatValue={pct} onChange={(blend: number) => setChroma({blend})} />
          </>
        )}
      </Block>
    </>
  );
}
