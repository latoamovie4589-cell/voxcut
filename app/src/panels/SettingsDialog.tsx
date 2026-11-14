// 設定：音声合成ソフトの場所（ユーザーが選ぶ）・VoiSona の接続情報・FFmpeg の場所。

import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Divider} from '@astryxdesign/core/Divider';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {FolderOpen} from 'lucide-react';
import {api, type AppConfig} from '../ipc';
import {refreshEngines, type Notify} from '../actions';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const sep = (p: string) => (p.includes('\\') ? '\\' : '/');

/** exe の場所：入力欄＋「参照…」 */
function ExeField({label, exeName, value, onChange, note}: {label: string; exeName: string; value: string; onChange: (path: string) => void; note?: string}) {
  const wrongName = value !== '' && fileName(value).toLowerCase() !== exeName.toLowerCase();
  const browse = async () => {
    const p = await (await api).pickExe(`${label}を選ぶ`, value ? dirName(value) : null);
    if (p) onChange(p);
  };
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="end">
        <div style={{flex: 1, minWidth: 0}}>
          <TextInput
            label={label}
            placeholder={`${exeName} を選んでください`}
            description={note}
            value={value}
            onChange={onChange}
            status={wrongName ? {type: 'warning', message: `${exeName} ではないファイルが選ばれています`} : undefined}
          />
        </div>
        <Button label="参照…" icon={<Icon icon={FolderOpen} />} onClick={() => void browse()} />
      </HStack>
    </VStack>
  );
}

export function SettingsDialog({isOpen, onOpenChange, notify}: {isOpen: boolean; onOpenChange: (o: boolean) => void; notify: Notify}) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    void api.then(a => a.getConfig()).then(setCfg);
  }, [isOpen]);
  if (!cfg) return null;
  const e = cfg.engines;
  const setEngines = (patch: Partial<AppConfig['engines']>) => setCfg({...cfg, engines: {...e, ...patch}});
  const setVoisona = (patch: Partial<AppConfig['engines']['voisona']>) => setEngines({voisona: {...e.voisona, ...patch}});
  // A.I.VOICE は AIVoiceEditor.exe を選んでもらい、そのフォルダを覚える
  const aivoiceExe = e.aivoiceDir ? `${e.aivoiceDir}${sep(e.aivoiceDir)}AIVoiceEditor.exe` : '';

  const save = async () => {
    try {
      await (await api).setConfig(cfg);
      onOpenChange(false);
      notify('設定を保存しました。接続を確認しています…');
      void refreshEngines();
    } catch (err) {
      notify(String(err), 'error');
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={560} maxHeight="92dvh" purpose="form">
      <DialogHeader title="音声合成ソフトの設定" onOpenChange={onOpenChange} />
      {/* 窓が小さくても「保存」が隠れないよう、中身だけをスクロールさせる */}
      <div style={{maxHeight: 'calc(92dvh - 132px)', overflowY: 'auto', overscrollBehavior: 'contain'}}>
        <VStack gap={4} padding={4}>
          <Text type="supporting">使う音声合成ソフトだけ設定してください。使わないソフトは空のままで構いません。</Text>
          <Heading level={3}>A.I.VOICE</Heading>
          <ExeField
            label="A.I.VOICE の場所"
            exeName="AIVoiceEditor.exe"
            value={aivoiceExe}
            onChange={p => setEngines({aivoiceDir: p ? (fileName(p).toLowerCase().endsWith('.exe') ? dirName(p) : p) : null})}
          />
          <Divider />
          <Heading level={3}>VOICEPEAK</Heading>
          <ExeField label="VOICEPEAK の場所" exeName="voicepeak.exe" value={e.voicepeakPath ?? ''} note="v1.2.1 以降が必要です" onChange={p => setEngines({voicepeakPath: p || null})} />
          <Divider />
          <Heading level={3}>VoiSona Talk</Heading>
          <Text type="supporting">VoiSona Talk を起動し、環境設定の「API」で決めたメールアドレスとパスワードを入れてください。</Text>
          <TextInput label="メールアドレス" type="email" description="VoiSona にサインインしたメールアドレス" value={e.voisona.user} onChange={v => setVoisona({user: v})} />
          <TextInput label="API のパスワード" type="password" value={e.voisona.password} onChange={v => setVoisona({password: v})} />
          <Collapsible defaultIsOpen={false} trigger={<Text type="supporting">詳しい設定（ふつうは変えません）</Text>}>
            <HStack gap={2} paddingBlockStart={2}>
              <TextInput label="ホスト" value={e.voisona.host} onChange={v => setVoisona({host: v})} />
              <NumberInput label="ポート" value={e.voisona.port} min={1} max={65535} onChange={v => setVoisona({port: v})} />
            </HStack>
          </Collapsible>
          <Divider />
          <Heading level={3}>VOICEVOX</Heading>
          <Text type="supporting">VOICEVOX を起動しておくだけで使えます（場所の指定は要りません）。</Text>
          <Collapsible defaultIsOpen={false} trigger={<Text type="supporting">詳しい設定（AivisSpeech などを使うとき）</Text>}>
            <VStack gap={2} paddingBlockStart={2}>
              <Text type="supporting">同じ仕組みの AivisSpeech などは、ポートを変えると使えます（AivisSpeech は 10101）。</Text>
              <HStack gap={2}>
                <TextInput label="ホスト" value={e.voicevox.host} onChange={v => setEngines({voicevox: {...e.voicevox, host: v}})} />
                <NumberInput label="ポート" value={e.voicevox.port} min={1} max={65535} onChange={v => setEngines({voicevox: {...e.voicevox, port: v}})} />
              </HStack>
            </VStack>
          </Collapsible>
          <Divider />
          <Heading level={3}>書き出し</Heading>
          <ExeField label="FFmpeg" exeName="ffmpeg.exe" value={cfg.ffmpegPath ?? ''} note="空のときは VoxCut に同梱の ffmpeg.exe を使います" onChange={p => setCfg({...cfg, ffmpegPath: p || null})} />
        </VStack>
      </div>
      <Divider />
      <HStack gap={2} hAlign="end" padding={3}>
        <Button label="キャンセル" variant="ghost" onClick={() => onOpenChange(false)} />
        <Button label="保存" variant="primary" clickAction={save} />
      </HStack>
    </Dialog>
  );
}
