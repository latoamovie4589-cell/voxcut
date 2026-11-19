// 場面の切り替え・キーワード画像の自動配置（ファイル → 切り替え・画像を自動で置く…）。
// 切り替え：すき間なく続く画像・動画のつなぎ目にまとめて付ける。キーワード画像：言葉を含むセリフの間だけ、その画像を置く

import {useState} from 'react';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {addTransitionsAuto, pickImageFile, placeKeywordRules} from '../actions';
import {IMAGE_POS_LABEL, TRANSITION_LABEL, type ImagePos} from '../autoScene';
import type {TransitionKind} from '../model';
import {setState, useStore} from '../store';

type Rule = {keyword: string; path: string; width: number; height: number};
const KEY = 'voxcut.keywordImages.v1';
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const loadRules = (): Rule[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((r: Rule) => r && typeof r.keyword === 'string' && typeof r.path === 'string' && r.width > 0 && r.height > 0) : [];
  } catch {
    return [];
  }
};
const saveRules = (rs: Rule[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(rs));
  } catch {
    // 覚えられなくても、この場では使える
  }
};

export function AutoSceneDialog() {
  const isOpen = useStore(s => s.autoSceneOpen);
  const project = useStore(s => s.project);
  const selCount = useStore(s => s.selectedClipIds.length);
  const [kind, setKind] = useState<TransitionKind | 'mixed'>('mixed');
  const [frames, setFrames] = useState(15);
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [replace, setReplace] = useState(false);
  const [rules, setRules] = useState<Rule[]>(loadRules);
  const [word, setWord] = useState('');
  const [size, setSize] = useState(0.35);
  const [pos, setPos] = useState<ImagePos>('topRight');
  if (!project) return null;
  const close = () => setState({autoSceneOpen: false});
  const update = (rs: Rule[]) => {
    setRules(rs);
    saveRules(rs);
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={520} maxHeight="92dvh" purpose="info">
      <DialogHeader title="切り替え・画像を自動で置く" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={5} padding={4}>
          <VStack gap={2}>
            <Text type="label">場面の切り替え（すき間なく続く画像・動画のつなぎ目）</Text>
            <Selector
              label="種類"
              value={kind}
              options={[{value: 'mixed', label: 'いろいろ順番に'}, ...(Object.keys(TRANSITION_LABEL) as TransitionKind[]).map(k => ({value: k, label: TRANSITION_LABEL[k]}))]}
              onChange={v => setKind(v as TransitionKind | 'mixed')}
              width="100%"
            />
            <Slider label="つなぎ目の長さ" value={frames} min={6} max={60} step={1} valueDisplay="text" formatValue={v => `${v} コマ`} onChange={(v: number) => setFrames(Math.round(v))} />
            <Selector
              label="付ける場所"
              value={scope}
              options={[
                {value: 'all', label: 'すべてのつなぎ目'},
                {value: 'selected', label: selCount ? `選んだ ${selCount} 個のアイテムの頭` : '選んだアイテムの頭（アイテムを選んでください）'},
              ]}
              onChange={v => setScope(v as 'all' | 'selected')}
              width="100%"
            />
            <Switch label="すでに付いている切り替えも置き換える" value={replace} onChange={setReplace} labelPosition="start" labelSpacing="spread" width="100%" />
            <Button label="切り替えを付ける" variant="primary" isDisabled={scope === 'selected' && !selCount} onClick={() => addTransitionsAuto(kind, frames, scope, replace)} />
          </VStack>
          <VStack gap={2}>
            <Text type="label">キーワードで画像（その言葉を含むセリフの間だけ画像を出す）</Text>
            {rules.map((r, i) => (
              <HStack key={`${r.keyword}:${r.path}`} gap={2} vAlign="center">
                <Text>「{r.keyword}」</Text>
                <Text type="supporting">{baseName(r.path)}</Text>
                <Button label="消す" variant="ghost" onClick={() => update(rules.filter((_, j) => j !== i))} />
              </HStack>
            ))}
            <HStack gap={2} vAlign="end" wrap="wrap">
              <div style={{width: 200}}>
                <TextInput label="言葉" value={word} onChange={setWord} />
              </div>
              <Button
                label="画像を選んで足す"
                variant="secondary"
                isDisabled={!word.trim()}
                onClick={async () => {
                  const pick = await pickImageFile();
                  if (!pick) return;
                  update([...rules.filter(r => r.keyword !== word.trim()), {keyword: word.trim(), path: pick.path, width: pick.info.width!, height: pick.info.height!}]);
                  setWord('');
                }}
              />
            </HStack>
            <Slider label="画像の大きさ" description="画面の幅・高さに対する割合（収まるように）" value={size} min={0.1} max={1} step={0.05} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(v: number) => setSize(v)} />
            <Selector label="置く位置" value={pos} options={(Object.keys(IMAGE_POS_LABEL) as ImagePos[]).map(k => ({value: k, label: IMAGE_POS_LABEL[k]}))} onChange={v => setPos(v as ImagePos)} width="100%" />
            <Button label="画像を置く" variant="primary" isDisabled={!rules.length} onClick={() => placeKeywordRules(rules, size, pos)} />
          </VStack>
          <HStack hAlign="end">
            <Button label="閉じる" onClick={close} />
          </HStack>
        </VStack>
      </div>
    </Dialog>
  );
}
