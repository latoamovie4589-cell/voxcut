// AI の機能：音声から字幕を作る（自動字幕）・人物などの背景を消す（CapCut の自動キャプション・背景削除）。
// モデルは初めて使うときにダウンロードする
import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Selector} from '@astryxdesign/core/Selector';
import {Switch} from '@astryxdesign/core/Switch';
import {api, type AiModel} from '../ipc';
import {matteKey, type MediaClip} from '../model';
import {updateClip, useStore} from '../store';
import {autoCaptions, autoReframe, ensureMatte, watchAi, type Notify} from '../actions';

let models: AiModel[] | null = null;
const listeners = new Set<() => void>();
async function refreshModels() {
  models = await (await api).modelStatus();
  listeners.forEach(f => f());
}

/** モデルの一覧（ダウンロード済みか）を見る */
function useModels(): AiModel[] | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump(n => n + 1);
    listeners.add(f);
    if (!models) void refreshModels();
    return () => void listeners.delete(f);
  }, []);
  return models;
}

const chosen: Record<string, string> = {whisper: 'whisper-base', matte: 'matte-fast'};

/** 使うモデルを選び、まだならダウンロードする。ready ならその下に children */
function ModelPicker({kind, value, onChange, children}: {kind: AiModel['kind']; value: string; onChange: (id: string) => void; children: React.ReactNode}) {
  const all = useModels();
  const [dl, setDl] = useState<{ratio: number} | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = (all ?? []).filter(m => m.kind === kind);
  const m = list.find(x => x.id === value) ?? list[0];
  if (!all) return <Text type="supporting">読み込んでいます…</Text>;
  if (!m) return null;
  const download = async () => {
    setErr(null);
    setDl({ratio: 0});
    const unwatch = await watchAi(p => {
      if (p.stage === 'download' && p.id === m.id) setDl({ratio: p.ratio});
    });
    try {
      await (await api).downloadModel(m.id);
      await refreshModels();
    } catch (e) {
      setErr(String(e));
    } finally {
      unwatch();
      setDl(null);
    }
  };
  return (
    <VStack gap={3}>
      <Selector label="モデル" value={m.id} options={list.map(x => ({value: x.id, label: `${x.label}${x.ready ? '' : '・未ダウンロード'}`}))} onChange={onChange} width="100%" />
      {m.ready ? (
        children
      ) : dl ? (
        <ProgressBar label="モデルをダウンロードしています" value={dl.ratio * 100} hasValueLabel />
      ) : (
        <VStack gap={2}>
          <Text type="supporting">初めて使うときは、モデルをダウンロードします（約 {Math.max(1, Math.round(m.size / 1e6))}MB。この PC に保存して、次からはすぐ使えます）</Text>
          <HStack>
            <Button size="sm" variant="secondary" label="モデルをダウンロード" onClick={() => void download()} />
          </HStack>
        </VStack>
      )}
      {err && <Text type="supporting">ダウンロードできませんでした：{err}</Text>}
    </VStack>
  );
}

function Block({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <Heading level={3}>{title}</Heading>
      {children}
    </VStack>
  );
}

/** 音から字幕を作る */
export function AutoCaptionSection({clip, notify}: {clip: MediaClip; notify: Notify}) {
  const [model, setModel] = useState(chosen.whisper);
  const [busy, setBusy] = useState<number | null>(null);
  const run = async () => {
    setBusy(0);
    const unwatch = await watchAi(p => {
      if (p.stage === 'transcribe') setBusy(p.ratio);
    });
    try {
      const n = await autoCaptions(clip.id, model);
      notify(n ? `字幕を ${n} 個作りました（新しいレイヤー「字幕」）` : '聞き取れる言葉が見つかりませんでした');
    } catch (e) {
      notify(`字幕を作れませんでした：${String(e)}`, 'error');
    } finally {
      unwatch();
      setBusy(null);
    }
  };
  return (
    <Block title="自動で字幕">
      <Text type="supporting">この素材の声を聞き取って、テキストの字幕を時間どおりに並べます（日本語）</Text>
      <ModelPicker
        kind="whisper"
        value={model}
        onChange={id => {
          chosen.whisper = id;
          setModel(id);
        }}>
        {busy !== null ? (
          <ProgressBar label="聞き取っています" value={busy * 100} hasValueLabel />
        ) : (
          <HStack>
            <Button size="sm" variant="secondary" label="文字起こしして字幕を作る" isDisabled={!!clip.freeze} onClick={() => void run()} />
          </HStack>
        )}
      </ModelPicker>
    </Block>
  );
}

/** 背景を消す（人物などを切り抜く） */
export function RemoveBackgroundSection({clip}: {clip: MediaClip}) {
  const [model, setModel] = useState(clip.matte ?? chosen.matte);
  const key = matteKey(clip.src, clip.matte ?? model);
  const job = useStore(s => s.proxies[key]);
  const kind = clip.mediaKind === 'image' ? 'image' : 'video';
  const turn = (on: boolean) => {
    updateClip(clip.id, {matte: on ? model : undefined});
    if (on) void ensureMatte(clip.src, model, kind);
  };
  return (
    <Block title="背景を消す">
      <Text type="supporting">人物などを見分けて、背景を透明にします。{kind === 'video' ? '動画は全体を先に調べるので、長い動画は時間がかかります' : ''}</Text>
      <ModelPicker
        kind="matte"
        value={model}
        onChange={id => {
          chosen.matte = id;
          setModel(id);
          if (clip.matte) {
            updateClip(clip.id, {matte: id});
            void ensureMatte(clip.src, id, kind);
          }
        }}>
        <Switch label="背景を消す" value={!!clip.matte} onChange={turn} labelPosition="start" labelSpacing="spread" width="100%" />
        {clip.matte && job && !job.url && !job.error && <ProgressBar label="人物を見分けています" value={job.ratio * 100} hasValueLabel />}
        {clip.matte && job?.error && (
          <HStack gap={2} vAlign="center">
            <Text type="supporting">できませんでした</Text>
            <Button size="sm" variant="ghost" label="もう一度" onClick={() => void ensureMatte(clip.src, clip.matte!, kind, false, true)} />
          </HStack>
        )}
      </ModelPicker>
    </Block>
  );
}

/** 自動で位置合わせ（被写体を真ん中に。縦長・横長に変えたときに） */
export function AutoReframeSection({clip, notify}: {clip: MediaClip; notify: Notify}) {
  const [model, setModel] = useState(chosen.matte);
  const [busy, setBusy] = useState<number | null>(null);
  const run = async () => {
    setBusy(0);
    const unwatch = await watchAi(p => {
      if (p.stage === 'matte') setBusy(p.ratio);
    });
    try {
      const ok = await autoReframe(clip.id, model);
      notify(ok ? (clip.mediaKind === 'video' ? '被写体を追って位置を合わせました（キーフレーム）' : '被写体が真ん中に来るように合わせました') : '大きさが分からない素材です', ok ? 'info' : 'error');
    } catch (e) {
      notify(`位置を合わせられませんでした：${String(e)}`, 'error');
    } finally {
      unwatch();
      setBusy(null);
    }
  };
  return (
    <Block title="自動で位置合わせ">
      <Text type="supporting">画面いっぱいに広げて、人物などが真ん中に来るように動かします。縦長・横長に作り直すときに</Text>
      <ModelPicker
        kind="matte"
        value={model}
        onChange={id => {
          chosen.matte = id;
          setModel(id);
        }}>
        {busy !== null ? (
          <ProgressBar label="被写体を探しています" value={busy * 100} hasValueLabel />
        ) : (
          <HStack>
            <Button size="sm" variant="secondary" label="被写体を真ん中にする" onClick={() => void run()} />
          </HStack>
        )}
      </ModelPicker>
    </Block>
  );
}
