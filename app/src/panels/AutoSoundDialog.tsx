// BGM・効果音の自動配置（ファイル → BGM・効果音を自動で置く…）。
// BGM は動画の頭から終わりまでくり返して敷き、効果音はマーカーや「？」「！」で終わるセリフ・決めた言葉のセリフの頭に置く

import {useState} from 'react';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {pickSoundFile, placeBgm, placeSe} from '../actions';
import {SE_TRIGGER_LABEL, type SeTrigger} from '../autoSound';
import type {MediaInfo} from '../ipc';
import {setState, useStore} from '../store';

type Sound = {path: string; info: MediaInfo};
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function AutoSoundDialog() {
  const isOpen = useStore(s => s.autoSoundOpen);
  const project = useStore(s => s.project);
  const [bgm, setBgm] = useState<Sound | null>(null);
  const [bgmVol, setBgmVol] = useState(0.25);
  const [se, setSe] = useState<Sound | null>(null);
  const [seVol, setSeVol] = useState(0.8);
  const [trigger, setTrigger] = useState<SeTrigger>('question');
  const [keyword, setKeyword] = useState('');
  if (!project) return null;
  const fps = project.video.fps;
  const close = () => setState({autoSoundOpen: false});
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={520} purpose="info">
      <DialogHeader title="BGM・効果音を自動で置く" onOpenChange={o => !o && close()} />
      <VStack gap={5} padding={4}>
        <VStack gap={2}>
          <Text type="label">BGM（動画の頭から終わりまで、くり返して敷く）</Text>
          <HStack gap={2} vAlign="center">
            <Button label={bgm ? '選び直す' : '音声ファイルを選ぶ'} onClick={async () => setBgm((await pickSoundFile()) ?? bgm)} />
            <Text type="supporting">{bgm ? baseName(bgm.path) : '未選択'}</Text>
          </HStack>
          <Slider label="音量" value={bgmVol} min={0} max={1} step={0.05} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(v: number) => setBgmVol(v)} />
          <Button label="BGM を置く" variant="primary" isDisabled={!bgm} onClick={() => bgm && placeBgm(bgm, bgmVol, Math.round(fps * 1.5))} />
        </VStack>
        <VStack gap={2}>
          <Text type="label">効果音（きっかけの場所の頭に置く）</Text>
          <HStack gap={2} vAlign="center">
            <Button label={se ? '選び直す' : '音声ファイルを選ぶ'} onClick={async () => setSe((await pickSoundFile()) ?? se)} />
            <Text type="supporting">{se ? baseName(se.path) : '未選択'}</Text>
          </HStack>
          <Selector
            label="きっかけ"
            value={trigger}
            options={(Object.keys(SE_TRIGGER_LABEL) as SeTrigger[]).map(k => ({value: k, label: SE_TRIGGER_LABEL[k]}))}
            onChange={v => setTrigger(v as SeTrigger)}
            width="100%"
          />
          {trigger === 'keyword' && <TextInput label="言葉" value={keyword} onChange={setKeyword} />}
          <Slider label="音量" value={seVol} min={0} max={1} step={0.05} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(v: number) => setSeVol(v)} />
          <Button label="効果音を置く" variant="primary" isDisabled={!se || (trigger === 'keyword' && !keyword.trim())} onClick={() => se && placeSe(se, seVol, trigger, keyword)} />
        </VStack>
        <HStack hAlign="end">
          <Button label="閉じる" onClick={close} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
