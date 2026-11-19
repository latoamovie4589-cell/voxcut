// プロジェクトの設定（ファイル → プロジェクトの設定…）：動画の大きさ（横長・縦長のショート・正方形）、fps、背景色。
// fps はアイテムの長さがコマ数で決まっているので、まだ何も置いていないときだけ変えられる

import {useState} from 'react';
import {Switch} from '@astryxdesign/core/Switch';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {resizeVideoTo} from '../actions';
import {setState, updateVideo, useStore} from '../store';

const SIZES: {value: string; label: string; w: number; h: number}[] = [
  {value: '1920x1080', label: '横長 1920×1080（YouTube など）', w: 1920, h: 1080},
  {value: '1280x720', label: '横長 1280×720（軽い）', w: 1280, h: 720},
  {value: '3840x2160', label: '横長 3840×2160（4K）', w: 3840, h: 2160},
  {value: '1080x1920', label: '縦長 1080×1920（ショート・リール・TikTok）', w: 1080, h: 1920},
  {value: '720x1280', label: '縦長 720×1280（軽い）', w: 720, h: 1280},
  {value: '1080x1350', label: '縦長 4:5 1080×1350（Instagram の投稿）', w: 1080, h: 1350},
  {value: '1080x1080', label: '正方形 1080×1080', w: 1080, h: 1080},
];
const FPS = [24, 30, 60];

export function ProjectSettingsDialog() {
  const isOpen = useStore(s => s.projectSettingsOpen);
  const project = useStore(s => s.project);
  const [relayout, setRelayout] = useState(true);
  if (!project) return null;
  const v = project.video;
  const size = `${v.width}x${v.height}`;
  const sizes = SIZES.some(x => x.value === size) ? SIZES : [{value: size, label: `${v.width}×${v.height}（今の大きさ）`, w: v.width, h: v.height}, ...SIZES];
  const fpsLocked = project.clips.length > 0;
  const hasItems = project.clips.length > 0 || project.characters.some(c => c.portrait);
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
            if (x) void resizeVideoTo(x.w, x.h, relayout && hasItems);
          }}
          width="100%"
        />
        {hasItems && (
          <Switch
            label="置いてあるものも新しい大きさに合わせる"
            description="横長から縦長に変えるときなど、立ち絵・画像・文字の位置と大きさを直します。画面いっぱいに置いた画像・動画は、新しい画面もいっぱいに埋めます（元に戻すで戻せます）"
            value={relayout}
            onChange={setRelayout}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
          />
        )}
        <Selector
          label="1 秒のコマ数（fps）"
          description={fpsLocked ? '置いてあるアイテムの位置と長さは、同じ時間になるよう数え直します（元に戻すで戻せます）' : undefined}
          value={String(v.fps)}
          options={(FPS.includes(v.fps) ? FPS : [v.fps, ...FPS]).map(f => ({value: String(f), label: `${f} fps`}))}
          onChange={val => updateVideo({fps: Number(val)})}
          width="100%"
        />
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
