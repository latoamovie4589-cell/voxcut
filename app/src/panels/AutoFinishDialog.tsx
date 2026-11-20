// 仕上げの自動整え（ファイル → 間・ズーム・サムネイルを自動で…）。
// セリフの間を文の終わりの記号で変える／しゃべる人へ自動でズーム／サムネイル候補をまとめて書き出す

import {useState} from 'react';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Selector} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {adjustGapsAuto, arrangeAuto, clearShakeAuto, clearZoomAuto, exportStills, placeShakeAuto, placeZoomAuto, type Notify} from '../actions';
import {SHAKE_MODE_LABEL, type ShakeMode} from '../autoShake';
import {planStills, STILL_MODE_LABEL, type StillMode} from '../autoStills';
import {setState, useStore} from '../store';

export function AutoFinishDialog({notify}: {notify: Notify}) {
  const isOpen = useStore(s => s.autoFinishOpen);
  const project = useStore(s => s.project);
  const busy = useStore(s => s.busy);
  const selCount = useStore(s => s.selectedClipIds.length);
  const fps = project?.video.fps ?? 30;
  const [sentence, setSentence] = useState(Math.round(fps * 0.4));
  const [strong, setStrong] = useState(Math.round(fps * 0.5));
  const [other, setOther] = useState(Math.round(fps * 0.2));
  const [keepLast, setKeepLast] = useState(true);
  const [gapScope, setGapScope] = useState<'all' | 'selected'>('all');
  const [scale, setScale] = useState(1.15);
  const [ease, setEase] = useState(12);
  const [mode, setMode] = useState<StillMode>('markers');
  const [count, setCount] = useState(6);
  const [shakeMode, setShakeMode] = useState<ShakeMode>('strong');
  const [shakeLen, setShakeLen] = useState(10);
  const [shakeAmp, setShakeAmp] = useState(14);
  const [span, setSpan] = useState(0.8);
  const [onlyAppearing, setOnlyAppearing] = useState(true);
  if (!project) return null;
  const close = () => setState({autoFinishOpen: false});
  const frames = planStills(project, mode, count);
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={520} maxHeight="92dvh" purpose="info">
      <DialogHeader title="間・ズーム・揺れ・立ち位置・サムネイルを自動で" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={5} padding={4}>
          <VStack gap={2}>
            <Text type="label">セリフの間（文の終わりの記号で、後ろの間を変える）</Text>
            <HStack gap={2} wrap="wrap">
              <div style={{width: 150}}>
                <NumberInput label="「。」「…」の後" units="コマ" value={sentence} min={0} max={fps * 5} onChange={v => setSentence(Math.max(0, Math.round(v || 0)))} />
              </div>
              <div style={{width: 150}}>
                <NumberInput label="「！」「？」の後" units="コマ" value={strong} min={0} max={fps * 5} onChange={v => setStrong(Math.max(0, Math.round(v || 0)))} />
              </div>
              <div style={{width: 150}}>
                <NumberInput label="それ以外の後" units="コマ" value={other} min={0} max={fps * 5} onChange={v => setOther(Math.max(0, Math.round(v || 0)))} />
              </div>
            </HStack>
            <Selector
              label="変えるセリフ"
              value={gapScope}
              options={[
                {value: 'all', label: 'すべてのセリフ'},
                {value: 'selected', label: selCount ? `選んだセリフ（${selCount} 個を選択中）` : '選んだセリフ（セリフを選んでください）'},
              ]}
              onChange={v => setGapScope(v as 'all' | 'selected')}
              width="100%"
            />
            <Switch label="最後のセリフは変えない" value={keepLast} onChange={setKeepLast} labelPosition="start" labelSpacing="spread" width="100%" />
            <Button label="間を整える" variant="primary" isDisabled={gapScope === 'selected' && !selCount} onClick={() => adjustGapsAuto({sentence, strong, other, keepLast}, gapScope === 'all')} />
          </VStack>
          <VStack gap={2}>
            <Text type="label">しゃべる人へズーム（話している立ち絵へ寄って、話し終わると戻る）</Text>
            <Slider label="寄る大きさ" value={scale} min={1.05} max={1.5} step={0.01} valueDisplay="text" formatValue={v => `${Math.round((v - 1) * 100)}% 大きく`} onChange={(v: number) => setScale(v)} />
            <Slider label="寄る・戻るのにかける長さ" value={ease} min={4} max={40} step={1} valueDisplay="text" formatValue={v => `${v} コマ`} onChange={(v: number) => setEase(Math.round(v))} />
            <HStack gap={2}>
              <Button label="ズームを置く" variant="primary" onClick={() => placeZoomAuto(scale, ease)} />
              <Button label="自動のズームを消す" variant="ghost" onClick={clearZoomAuto} />
            </HStack>
            <Text type="supporting">立ち絵を表示しているキャラクターが 1 秒以上続けてしゃべる所へ、いちばん上のレイヤーにカメラを置きます。置き直すと前の自動のものは入れ替わります。</Text>
          </VStack>
          <VStack gap={2}>
            <Text type="label">サムネイル候補（画像でまとめて書き出す）</Text>
            <Selector label="コマの選び方" value={mode} options={(Object.keys(STILL_MODE_LABEL) as StillMode[]).map(k => ({value: k, label: STILL_MODE_LABEL[k]}))} onChange={v => setMode(v as StillMode)} width="100%" />
            {mode !== 'markers' && (
              <div style={{width: 150}}>
                <NumberInput label="枚数" units="枚" value={count} min={1} max={60} onChange={v => setCount(Math.max(1, Math.round(v || 1)))} />
              </div>
            )}
            <Button label={frames.length ? `${frames.length} 枚を書き出す…` : '書き出せるコマがありません'} variant="primary" isDisabled={!frames.length || !!busy} onClick={() => void exportStills(notify, frames)} />
          </VStack>
          <VStack gap={2}>
            <Text type="label">画面の揺れ（強い感情のセリフの頭で、カメラをぶるっと揺らす）</Text>
            <Selector label="揺らすセリフ" value={shakeMode} options={(Object.keys(SHAKE_MODE_LABEL) as ShakeMode[]).map(k => ({value: k, label: SHAKE_MODE_LABEL[k]}))} onChange={v => setShakeMode(v as ShakeMode)} width="100%" />
            <Slider label="揺れの大きさ" value={shakeAmp} min={4} max={40} step={1} valueDisplay="text" formatValue={v => `${v} px`} onChange={(v: number) => setShakeAmp(Math.round(v))} />
            <Slider label="揺れる長さ" value={shakeLen} min={4} max={30} step={1} valueDisplay="text" formatValue={v => `${v} コマ`} onChange={(v: number) => setShakeLen(Math.round(v))} />
            <HStack gap={2}>
              <Button label="揺れを置く" variant="primary" onClick={() => placeShakeAuto(shakeMode, shakeLen, shakeAmp)} />
              <Button label="自動の揺れを消す" variant="ghost" onClick={clearShakeAuto} />
            </HStack>
          </VStack>
          <VStack gap={2}>
            <Text type="label">立ち位置（立ち絵を画面に均等に並べる）</Text>
            <Slider label="使う画面の幅" value={span} min={0.5} max={1} step={0.05} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(v: number) => setSpan(v)} />
            <Switch label="セリフのあるキャラクターだけ並べる" value={onlyAppearing} onChange={setOnlyAppearing} labelPosition="start" labelSpacing="spread" width="100%" />
            <Button label="立ち位置を並べる" variant="primary" onClick={() => arrangeAuto(span, onlyAppearing)} />
            <Text type="supporting">いまの左から右への順のまま、立ち絵の横の位置だけを等間隔にします（大きさ・縦の位置は変えません）。</Text>
          </VStack>
          <HStack hAlign="end">
            <Button label="閉じる" onClick={close} />
          </HStack>
        </VStack>
      </div>
    </Dialog>
  );
}
