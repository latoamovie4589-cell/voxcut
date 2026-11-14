// プロジェクトの設定（ファイル → プロジェクトの設定…）：動画の大きさ（横長・縦長のショート・正方形）、fps、背景色。
// fps はアイテムの長さがコマ数で決まっているので、まだ何も置いていないときだけ変えられる

import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {setState, updateVideo, useStore} from '../store';

const SIZES: {value: string; label: string; w: number; h: number}[] = [
  {value: '1920x1080', label: '横長 1920×1080（YouTube など）', w: 1920, h: 1080},
  {value: '1280x720', label: '横長 1280×720（軽い）', w: 1280, h: 720},
  {value: '3840x2160', label: '横長 3840×2160（4K）', w: 3840, h: 2160},
  {value: '1080x1920', label: '縦長 1080×1920（ショート・リール・TikTok）', w: 1080, h: 1920},
  {value: '1080x1080', label: '正方形 1080×1080', w: 1080, h: 1080},
];
const FPS = [24, 30, 60];

export function ProjectSettingsDialog() {
  const isOpen = useStore(s => s.projectSettingsOpen);
  const project = useStore(s => s.project);
  if (!project) return null;
  const v = project.video;
  const size = `${v.width}x${v.height}`;
  const sizes = SIZES.some(x => x.value === size) ? SIZES : [{value: size, label: `${v.width}×${v.height}（今の大きさ）`, w: v.width, h: v.height}, ...SIZES];
  const fpsLocked = project.clips.length > 0;
  const close = () => setState({projectSettingsOpen: false});
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={480} purpose="info">
      <DialogHeader title="プロジェクトの設定" onOpenChange={o => !o && close()} />
      <VStack gap={4} padding={4}>
        <Selector
          label="動画の大きさ"
          value={size}
          options={sizes.map(x => ({value: x.value, label: x.label}))}
          onChange={val => {
            const x = sizes.find(s => s.value === val);
            if (x) updateVideo({width: x.w, height: x.h});
          }}
          width="100%"
        />
        <Selector
          label="1 秒のコマ数（fps）"
          value={String(v.fps)}
          isDisabled={fpsLocked}
          options={(FPS.includes(v.fps) ? FPS : [v.fps, ...FPS]).map(f => ({value: String(f), label: `${f} fps`}))}
          onChange={val => updateVideo({fps: Number(val)})}
          width="100%"
        />
        {fpsLocked && <Banner status="info" title="fps は、セリフや素材を置く前に決めます" description="置いたあとに変えると、アイテムの長さが変わってしまうためです。" />}
        <HStack gap={2} vAlign="center">
          <Text type="label">背景の色</Text>
          <input
            type="color"
            aria-label="背景の色"
            value={/^#[0-9a-fA-F]{6}$/.test(v.background) ? v.background : '#000000'}
            onChange={e => updateVideo({background: e.target.value})}
            style={{width: 40, height: 28, padding: 0, border: 'none', background: 'none', cursor: 'pointer'}}
          />
          <Text type="supporting">{v.background.toUpperCase()}（何も置いていない所の色）</Text>
        </HStack>
        <HStack hAlign="end">
          <Button label="閉じる" variant="primary" onClick={close} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
