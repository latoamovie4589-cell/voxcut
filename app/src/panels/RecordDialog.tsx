// マイクで録音：マイクを選んで録り、止めると再生位置（録り始めた位置）に音声として置く。
// 「再生しながら録る」なら、動画を流しながらナレーションを合わせて録れる。

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
import {listMics, startRecording, type Recorder} from '../record';

export function RecordDialog({isOpen, onOpenChange}: {isOpen: boolean; onOpenChange: (o: boolean) => void}) {
  const fps = useStore(s => s.project?.video.fps ?? 30);
  const [mics, setMics] = useState<{id: string; label: string}[]>([]);
  const [mic, setMic] = useState('');
  const [noise, setNoise] = useState(false);
  const [follow, setFollow] = useState(true);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const rec = useRef<Recorder | null>(null);
  const startAt = useRef(0);
  const t0 = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    listMics().then(setMics, () => setMics([]));
  }, [isOpen]);
  // 録っている間は経過を出す
  useEffect(() => {
    if (!rec.current) return;
    const id = setInterval(() => setElapsed((performance.now() - t0.current) / 1000), 100);
    return () => clearInterval(id);
  }, [busy]);
  // 閉じたら止める（録ったものは捨てる）
  useEffect(() => {
    if (!isOpen && rec.current) {
      rec.current.cancel();
      rec.current = null;
      setBusy(false);
      setState({isPlaying: false});
    }
  }, [isOpen]);

  const start = async () => {
    try {
      rec.current = await startRecording({deviceId: mic || undefined, noise, level: setLevel});
      // 許可したあとはマイクの名前が出る
      listMics().then(setMics, () => {});
      startAt.current = getState().playhead;
      t0.current = performance.now();
      setElapsed(0);
      setBusy(true);
      if (follow) setState({isPlaying: true});
    } catch (e) {
      rec.current = null;
      getNotify()(`マイクを使えません：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setBusy(false);
    setState({isPlaying: false});
    setLevel(0);
    try {
      const {wav, seconds} = await r.stop();
      if (seconds < 0.2) {
        getNotify()('録音が短すぎるので置きませんでした', 'info');
        return;
      }
      const path = await (await api).writeRecording(wav);
      // 録り始めた位置に置く
      setState({playhead: startAt.current, selectedClipId: null});
      await addMediaPaths([path]);
      getNotify()('録音を置きました', 'info');
      onOpenChange(false);
    } catch (e) {
      getNotify()(`録音を保存できませんでした：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={440} purpose="form">
      <DialogHeader title="マイクで録音" onOpenChange={onOpenChange} />
      <VStack gap={3} padding={4}>
        <Selector
          label="マイク"
          value={mic}
          options={[{value: '', label: 'いつものマイク'}, ...mics.map(m => ({value: m.id, label: m.label}))]}
          onChange={v => setMic(v)}
          isDisabled={busy}
          width="100%"
        />
        <Switch
          label="再生しながら録る"
          description="動画を流しながら、合わせて話せます"
          value={follow}
          onChange={setFollow}
          isDisabled={busy}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
        <Switch label="雑音を減らす" value={noise} onChange={setNoise} isDisabled={busy} labelPosition="start" labelSpacing="spread" width="100%" />
        {/* 音の大きさ */}
        <div
          role="meter"
          aria-label="マイクの音の大きさ"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          style={{height: 8, borderRadius: 4, background: 'var(--color-background-muted, #8883)', overflow: 'hidden'}}>
          <div style={{width: `${Math.round(level * 100)}%`, height: '100%', background: level > 0.9 ? '#FF3B30' : '#34C759', transition: 'width 80ms linear'}} />
        </div>
        <Text type="supporting">{busy ? `録音中 ${framesToTimecode(Math.round(elapsed * fps), fps)}` : '止めると、録り始めた再生位置に音声として置きます。'}</Text>
      </VStack>
      <Divider />
      <HStack gap={2} hAlign="end" padding={3}>
        {busy ? <Button label="止めて置く" variant="primary" onClick={() => void stop()} /> : <Button label="録音を始める" variant="primary" onClick={() => void start()} />}
      </HStack>
    </Dialog>
  );
}
