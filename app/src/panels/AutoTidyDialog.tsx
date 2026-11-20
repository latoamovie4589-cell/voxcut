// セリフと字幕の自動整え（ファイル → 言いよどみ・字幕の色を自動で…）。
// 言いよどみを取り除く／長い間を詰める／字幕を感情ごとの色にする

import {useState} from 'react';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {capGapsAuto, clearTintAuto, fitSubtitlesAuto, removeFillersAuto, tintSubtitlesAuto} from '../actions';
import {TINT_COLOR, TINT_LABEL, TINT_TARGET_LABEL, type TintTarget} from '../autoTint';
import type {Emotion} from '../emotion';
import {setState, useStore} from '../store';

export function AutoTidyDialog() {
  const isOpen = useStore(s => s.autoTidyOpen);
  const project = useStore(s => s.project);
  const selCount = useStore(s => s.selectedClipIds.length);
  const fps = project?.video.fps ?? 30;
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [maxGap, setMaxGap] = useState(Math.round(fps * 0.8));
  const [target, setTarget] = useState<TintTarget>('text');
  const [maxLines, setMaxLines] = useState(2);
  const [minSize, setMinSize] = useState(36);
  if (!project) return null;
  const close = () => setState({autoTidyOpen: false});
  const all = scope === 'all';
  const noSel = !all && !selCount;
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={520} maxHeight="92dvh" purpose="info">
      <DialogHeader title="言いよどみ・字幕を自動で整える" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={5} padding={4}>
          <Selector
            label="対象のセリフ"
            value={scope}
            options={[
              {value: 'all', label: 'すべてのセリフ'},
              {value: 'selected', label: selCount ? `選んだセリフ（${selCount} 個を選択中）` : '選んだセリフ（セリフを選んでください）'},
            ]}
            onChange={v => setScope(v as 'all' | 'selected')}
            width="100%"
          />
          <VStack gap={2}>
            <Text type="label">言いよどみを取り除く</Text>
            <Text type="supporting">「えーと、」「あの、」「うーん…」「まあ、」のように、読点か「…」が続く言いよどみを消します。「あの人」のような普通の言葉は消しません。声は作り直しになります。</Text>
            <Button label="言いよどみを取り除く" variant="primary" isDisabled={noSel} onClick={() => removeFillersAuto(all)} />
          </VStack>
          <VStack gap={2}>
            <Text type="label">長い間を詰める</Text>
            <div style={{width: 200}}>
              <NumberInput label="間の上限" units="コマ" value={maxGap} min={0} max={fps * 10} onChange={v => setMaxGap(Math.max(0, Math.round(v || 0)))} />
            </div>
            <Button label="上限より長い間を詰める" variant="primary" isDisabled={noSel} onClick={() => capGapsAuto(maxGap, all)} />
          </VStack>
          <VStack gap={2}>
            <Text type="label">字幕を感情ごとの色にする</Text>
            <Selector label="変える色" value={target} options={(Object.keys(TINT_TARGET_LABEL) as TintTarget[]).map(k => ({value: k, label: TINT_TARGET_LABEL[k]}))} onChange={v => setTarget(v as TintTarget)} width="100%" />
            <HStack gap={3} wrap="wrap">
              {(Object.keys(TINT_COLOR) as Emotion[]).map(e => (
                <HStack key={e} gap={1} vAlign="center">
                  <span style={{width: 14, height: 14, borderRadius: 4, background: TINT_COLOR[e], display: 'inline-block'}} />
                  <Text type="supporting">{TINT_LABEL(e)}</Text>
                </HStack>
              ))}
            </HStack>
            <HStack gap={2}>
              <Button label="色を付ける" variant="primary" isDisabled={noSel} onClick={() => tintSubtitlesAuto(target, all)} />
              <Button label="自動の色を戻す" variant="ghost" onClick={clearTintAuto} />
            </HStack>
            <Text type="supporting">感情は、声の感情の設定か、セリフの言葉づかいから決めます。字幕を個別に設定したセリフは触りません。</Text>
          </VStack>
          <VStack gap={2}>
            <Text type="label">字幕を画面に収める</Text>
            <HStack gap={2} wrap="wrap">
              <div style={{width: 150}}>
                <NumberInput label="行数の上限" units="行" value={maxLines} min={1} max={6} onChange={v => setMaxLines(Math.max(1, Math.round(v || 1)))} />
              </div>
              <div style={{width: 150}}>
                <NumberInput label="文字の最小の大きさ" units="px" value={minSize} min={8} max={200} onChange={v => setMinSize(Math.max(8, Math.round(v || 8)))} />
              </div>
            </HStack>
            <Button label="行が多い字幕を収める" variant="primary" onClick={() => fitSubtitlesAuto(maxLines, minSize)} />
            <Text type="supporting">行数の上限を超える字幕のあるキャラクターの文字を、収まる大きさまで小さくします（個別に設定した字幕は変えません）。それでも収まらないときは、セリフを分けてください。</Text>
          </VStack>
          <HStack hAlign="end">
            <Button label="閉じる" onClick={close} />
          </HStack>
        </VStack>
      </div>
    </Dialog>
  );
}
