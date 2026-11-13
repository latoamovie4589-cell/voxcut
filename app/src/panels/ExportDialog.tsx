// 書き出し：設定を確かめる → 保存先を選ぶ → 進捗（取り消せる）→ 完了（フォルダを開く）

import {useEffect, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {MetadataList, MetadataListItem} from '@astryxdesign/core/MetadataList';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {api, type Encoder, type ExportProgress} from '../ipc';
import {collectCredits, framesToTimecode, projectDuration} from '../model';
import {useStore} from '../store';
import {cancelExport, pickExportPath, revealInFolder, runExport} from '../actions';

type Phase = {kind: 'setup'} | {kind: 'running'; progress: ExportProgress | null} | {kind: 'done'; out: string} | {kind: 'error'; message: string} | {kind: 'cancelled'};

const QUALITY = {high: {crf: 18, label: '高画質'}, normal: {crf: 20, label: '標準'}, light: {crf: 26, label: '軽量'}} as const;
type Quality = keyof typeof QUALITY;

const STAGE: Record<ExportProgress['stage'], string> = {
  synth: 'まだの音声を合成しています',
  portrait: '立ち絵を準備しています',
  encode: '動画を書き出しています',
};

/** 動画に載せるクレジット表記（概要欄や字幕にそのまま貼れる） */
function Credits() {
  const project = useStore(s => s.project);
  const voices = useStore(s => s.voices);
  const [copied, setCopied] = useState(false);
  if (!project) return null;
  const {credits, unknown} = collectCredits(project, voices);
  if (!credits.length && !unknown.length) return null;
  const text = credits.join('\n');
  return (
    <VStack gap={2}>
      <Text type="label">クレジット表記（動画内か概要欄に必要です）</Text>
      {credits.length > 0 && (
        <HStack gap={2} vAlign="start">
          <div className="vx-credit">{text}</div>
          <Button
            label={copied ? 'コピーしました' : 'コピー'}
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => setCopied(true));
            }}
          />
        </HStack>
      )}
      {unknown.length > 0 && <Text type="supporting">VOICEVOX を起動すると、{unknown.join('・')} の名前も分かります</Text>}
    </VStack>
  );
}

const ENCODER_LABEL: Record<Encoder, string> = {
  x264: 'CPU（どの PC でも使えます）',
  nvenc: 'NVIDIA のグラフィックボード（速い）',
  qsv: 'Intel のグラフィック機能（速い）',
  amf: 'AMD のグラフィックボード（速い）',
};

// 調べた結果は覚えておく（毎回試すと開くのが遅くなる）
let encodersCache: Promise<Encoder[]> | null = null;
const loadEncoders = () => (encodersCache ??= api.then(a => a.videoEncoders()).catch(() => ['x264' as Encoder]));

export function ExportDialog({isOpen, onOpenChange}: {isOpen: boolean; onOpenChange: (o: boolean) => void}) {
  const project = useStore(s => s.project);
  const [phase, setPhase] = useState<Phase>({kind: 'setup'});
  const [quality, setQuality] = useState<Quality>('normal');
  const [height, setHeight] = useState<string>('same');
  const [encoders, setEncoders] = useState<Encoder[] | null>(null);
  const [encoder, setEncoder] = useState<Encoder>('x264');

  useEffect(() => {
    if (!isOpen) return;
    setPhase({kind: 'setup'});
    void loadEncoders().then(list => {
      setEncoders(list);
      // グラフィックボードが使えるなら、はじめからそれにする（速い）
      setEncoder(e => (list.includes(e) && e !== 'x264' ? e : (list.find(x => x !== 'x264') ?? 'x264')));
    });
  }, [isOpen]);

  if (!project) return null;
  const v = project.video;
  const pending = project.clips.filter(c => c.type === 'voice' && !c.audio && c.text.trim()).length;
  const heights = [v.height, 1080, 720, 480].filter((h, i, a) => h <= v.height && a.indexOf(h) === i);
  const sizeLabel = (h: number) => `${Math.round((v.width * h) / v.height / 2) * 2}×${h}`;
  const running = phase.kind === 'running';

  const start = async () => {
    const out = await pickExportPath();
    if (!out) return;
    setPhase({kind: 'running', progress: null});
    try {
      await runExport(out, {crf: QUALITY[quality].crf, height: height === 'same' ? null : Number(height), encoder}, p => setPhase({kind: 'running', progress: p}));
      setPhase({kind: 'done', out});
    } catch (e) {
      setPhase(String(e).includes('cancelled') ? {kind: 'cancelled'} : {kind: 'error', message: String(e).replace(/^Error:\s*/, '')});
    }
  };

  // 書き出し中に閉じようとしたら取り消す
  const close = (open: boolean) => {
    if (!open && running) void cancelExport();
    onOpenChange(open);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={close} width={480} maxHeight="92dvh" purpose="form">
      <DialogHeader title="動画を書き出す" onOpenChange={close} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={4} padding={4}>
          {phase.kind === 'setup' && (
            <>
              <MetadataList>
                <MetadataListItem label="長さ">{framesToTimecode(projectDuration(project), v.fps)}</MetadataListItem>
                <MetadataListItem label="形式">MP4（H.264 / AAC）・{v.fps} fps</MetadataListItem>
              </MetadataList>
              <Selector
                label="大きさ"
                value={height}
                options={heights.map(h => ({value: h === v.height ? 'same' : String(h), label: h === v.height ? `${sizeLabel(h)}（プロジェクトのまま）` : sizeLabel(h)}))}
                onChange={setHeight}
                width="100%"
              />
              <VStack gap={1}>
                <Text type="label">画質</Text>
                <SegmentedControl label="画質" layout="fill" value={quality} onChange={q => setQuality(q as Quality)}>
                  {(Object.keys(QUALITY) as Quality[]).map(q => (
                    <SegmentedControlItem key={q} value={q} label={QUALITY[q].label} />
                  ))}
                </SegmentedControl>
                <Text type="supporting">軽量にするとファイルが小さくなり、細かい部分が少し粗くなります</Text>
              </VStack>
              <Selector
                label="書き出しに使うもの"
                description={
                  encoders
                    ? encoders.length > 1
                      ? 'グラフィックボードを使うと数倍速くなります。うまくいかないときは自動で CPU に切り替えます'
                      : 'この PC では CPU で書き出します'
                    : 'この PC で使えるものを調べています…'
                }
                value={encoder}
                isDisabled={!encoders || encoders.length < 2}
                options={(encoders ?? ['x264']).map(e => ({value: e, label: ENCODER_LABEL[e]}))}
                onChange={v => setEncoder(v as Encoder)}
                width="100%"
              />
              {pending > 0 && <Banner status="info" title={`まだ合成していないセリフが ${pending} 行あります`} description="書き出す前にまとめて合成します" />}
              <Credits />
              <HStack gap={2} hAlign="end">
                <Button label="キャンセル" variant="ghost" onClick={() => close(false)} />
                <Button label="保存先を選んで書き出す…" variant="primary" onClick={() => void start()} />
              </HStack>
            </>
          )}
          {phase.kind === 'running' && (
            <>
              <ProgressBar
                label={phase.progress ? STAGE[phase.progress.stage] : '準備しています'}
                value={(phase.progress?.ratio ?? 0) * 100}
                isIndeterminate={!phase.progress || phase.progress.stage === 'portrait'}
                hasValueLabel={phase.progress?.stage === 'encode'}
              />
              <Text type="supporting">書き出している間も、ほかの作業はできます</Text>
              <HStack hAlign="end">
                <Button label="取り消す" variant="secondary" onClick={() => void cancelExport()} />
              </HStack>
            </>
          )}
          {phase.kind === 'done' && (
            <>
              <Banner status="success" title="書き出しました" description={phase.out} />
              <Credits />
              <HStack gap={2} hAlign="end">
                <Button label="閉じる" variant="ghost" onClick={() => close(false)} />
                <Button label="フォルダを開く" variant="primary" onClick={() => void revealInFolder(phase.out)} />
              </HStack>
            </>
          )}
          {phase.kind === 'cancelled' && (
            <>
              <Banner status="info" title="書き出しを取り消しました" description="書きかけのファイルは消しました" />
              <HStack gap={2} hAlign="end">
                <Button label="閉じる" variant="ghost" onClick={() => close(false)} />
                <Button label="もう一度" variant="primary" onClick={() => setPhase({kind: 'setup'})} />
              </HStack>
            </>
          )}
          {phase.kind === 'error' && (
            <>
              <Banner status="error" title="書き出せませんでした" description={phase.message} />
              <HStack gap={2} hAlign="end">
                <Button label="閉じる" variant="ghost" onClick={() => close(false)} />
                <Button label="設定に戻る" variant="primary" onClick={() => setPhase({kind: 'setup'})} />
              </HStack>
            </>
          )}
        </VStack>
      </div>
    </Dialog>
  );
}
