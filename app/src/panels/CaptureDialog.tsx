// 画面を録画して置く：画面・ウィンドウを選んで録り、止めると録り始めた再生位置に動画として置く（ゲーム実況・操作の解説）。

import {useEffect, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Divider} from '@astryxdesign/core/Divider';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {api} from '../ipc';
import {framesToTimecode} from '../model';
import {addMediaPaths, getNotify} from '../actions';
import {getState, setState, useStore} from '../store';
import {listMics} from '../record';
import {startCapture, type Capture} from '../capture';

export function CaptureDialog({isOpen, onOpenChange}: {isOpen: boolean; onOpenChange: (o: boolean) => void}) {
  const fps = useStore(s => s.project?.video.fps ?? 30);
  const [systemAudio, setSystemAudio] = useState(true);
  const [withMic, setWithMic] = useState(false);
  const [mics, setMics] = useState<{id: string; label: string}[]>([]);
  const [mic, setMic] = useState('');
  const [busy, setBusy] = useState<'idle' | 'rec' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const cap = useRef<Capture | null>(null);
  const startAt = useRef(0);
  const t0 = useRef(0);

  useEffect(() => {
    if (isOpen) listMics().then(setMics, () => setMics([]));
  }, [isOpen]);
  useEffect(() => {
    if (busy !== 'rec') return;
    const id = setInterval(() => setElapsed((performance.now() - t0.current) / 1000), 200);
    return () => clearInterval(id);
  }, [busy]);
  // 閉じたら捨てる
  useEffect(() => {
    if (!isOpen && cap.current) {
      cap.current.cancel();
      cap.current = null;
      setBusy('idle');
    }
  }, [isOpen]);

  const stop = async () => {
    const c = cap.current;
    if (!c) return;
    cap.current = null;
    setBusy('saving');
    try {
      const {data, seconds} = await c.stop();
      if (seconds < 0.5 || !data.length) {
        getNotify()('録画が短すぎるので置きませんでした', 'info');
        setBusy('idle');
        return;
      }
      const path = await (await api).writeCapture(data);
      setState({playhead: startAt.current, selectedClipId: null});
      await addMediaPaths([path]);
      getNotify()('画面録画を置きました', 'info');
      setBusy('idle');
      onOpenChange(false);
    } catch (e) {
      setBusy('idle');
      getNotify()(`画面録画を保存できませんでした：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const start = async () => {
    try {
      cap.current = await startCapture({systemAudio, mic: withMic, micId: mic || undefined, fps: Math.min(60, fps), onEnded: () => void stop()});
      startAt.current = getState().playhead;
      t0.current = performance.now();
      setElapsed(0);
      setBusy('rec');
    } catch (e) {
      cap.current = null;
      // 選ぶ画面で「キャンセル」したときは知らせない
      if (e instanceof DOMException && e.name === 'NotAllowedError') return;
      getNotify()(`画面を録画できません：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={440} purpose="form">
      <DialogHeader title="画面を録画" onOpenChange={onOpenChange} />
      <VStack gap={3} padding={4}>
        <Switch label="パソコンの音も録る" value={systemAudio} onChange={setSystemAudio} isDisabled={busy !== 'idle'} labelPosition="start" labelSpacing="spread" width="100%" />
        <Switch label="マイクの声も録る" value={withMic} onChange={setWithMic} isDisabled={busy !== 'idle'} labelPosition="start" labelSpacing="spread" width="100%" />
        {withMic && (
          <Selector
            label="マイク"
            value={mic}
            options={[{value: '', label: 'いつものマイク'}, ...mics.map(m => ({value: m.id, label: m.label}))]}
            onChange={v => setMic(v)}
            isDisabled={busy !== 'idle'}
            width="100%"
          />
        )}
        <Text type="supporting" data-capture-status>
          {busy === 'rec'
            ? `録画中 ${framesToTimecode(Math.round(elapsed * fps), fps)}`
            : busy === 'saving'
              ? '保存しています…'
              : '始めると、録る画面かウィンドウを選べます。止めると、録り始めた再生位置に動画として置きます'}
        </Text>
      </VStack>
      <Divider />
      <HStack gap={2} hAlign="end" padding={3}>
        {busy === 'idle' ? (
          <Button label="録画を始める" variant="primary" onClick={() => void start()} />
        ) : (
          <Button label="止めて置く" variant="primary" isDisabled={busy === 'saving'} onClick={() => void stop()} />
        )}
      </HStack>
    </Dialog>
  );
}
