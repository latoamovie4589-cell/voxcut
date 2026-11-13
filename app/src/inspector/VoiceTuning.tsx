// 調声：声の速さ・高さ・抑揚・音量・感情と、ソフトごとの細かい項目。
// - セリフごと（LineTuning）：動かすとその行だけの調声になる。プリセットを選ぶこともできる
// - キャラクターごとの声のプリセット（PresetManager）：「叫び」「ささやき」などを登録して、行ごとに選ぶ

import {Hint} from '../Hint';
import {useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Heading} from '@astryxdesign/core/Heading';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {BookmarkPlus, Copy, Plus, RotateCcw, Trash2} from 'lucide-react';
import {TUNING_EXTRA, effectiveVoice, type Character, type Voice, type VoiceClip, type VoiceParams, type VoicePreset} from '../model';
import {addVoicePreset, presetParams, removeVoicePreset, undo, updateClip, updateVoicePreset, useStore} from '../store';
import {getNotify} from '../actions';
import {AccentEditor} from './AccentEditor';

/** VOICEPEAK の感情名（英語）を日本語にする */
export const EMOTION_LABEL: Record<string, string> = {
  happy: '喜び',
  fun: '楽しさ',
  angry: '怒り',
  sad: '悲しみ',
  bosoboso: 'ぼそぼそ',
  doyaru: 'ドヤ',
  honwaka: 'ほんわか',
  teary: '涙声',
  ochoushimono: 'お調子者',
  angry2: '怒り（強）',
};

const fmtPitch = (v: number) => (Math.abs(v) < 0.05 ? '標準' : `${v > 0 ? '+' : ''}${v.toFixed(1)} 半音`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 感情（VOICEPEAK の感情、VoiSona のスタイル）。話者が対応していなければ出さない */
function EmotionSliders({voice, value, onChange}: {voice: Voice; value: VoiceParams; onChange: (v: VoiceParams) => void}) {
  const info = useStore(s => s.voices[voice.engine]?.find(v => v.speaker === voice.speaker));
  const names = info?.emotions ?? [];
  if (!names.length) return null;
  // VOICEPEAK は 0〜100、VoiSona は 0〜1 の重み
  const max = voice.engine === 'voisona' ? 1 : 100;
  const set = (k: string, n: number) => {
    const emotions = {...value.emotions};
    if (n <= 0) delete emotions[k];
    else emotions[k] = n;
    onChange({...value, emotions});
  };
  const active = names.filter(n => (value.emotions[n] ?? 0) > 0);
  return (
    <Collapsible
      defaultIsOpen={active.length > 0}
      trigger={
        <HStack gap={2} vAlign="center">
          <Text type="label">感情</Text>
          <Text type="supporting">{active.length ? active.map(n => EMOTION_LABEL[n] ?? n).join('・') : 'なし'}</Text>
        </HStack>
      }>
      <VStack gap={3} paddingBlockStart={2}>
        {names.map(n => (
          <Slider
            key={n}
            label={EMOTION_LABEL[n] ?? n}
            value={value.emotions[n] ?? 0}
            min={0}
            max={max}
            step={max / 100}
            valueDisplay="text"
            formatValue={v => `${Math.round((v / max) * 100)}%`}
            onChange={(v: number) => set(n, v)}
          />
        ))}
      </VStack>
    </Collapsible>
  );
}

/** ソフトごとの細かい項目。標準の値に戻したものは送らない（ソフトの標準のまま） */
function ExtraSliders({voice, value, onChange}: {voice: Voice; value: VoiceParams; onChange: (v: VoiceParams) => void}) {
  const items = TUNING_EXTRA[voice.engine];
  if (!items.length) return null;
  const extra = value.extra ?? {};
  const set = (key: string, def: number, step: number, n: number) => {
    const next = {...extra};
    if (Math.abs(n - def) < step / 2) delete next[key];
    else next[key] = n;
    onChange({...value, extra: next});
  };
  const changed = items.filter(i => extra[i.key] !== undefined);
  return (
    <Collapsible
      defaultIsOpen={changed.length > 0}
      trigger={
        <HStack gap={2} vAlign="center">
          <Text type="label">細かい調整</Text>
          <Text type="supporting" maxLines={1}>
            {changed.length ? changed.map(i => i.label).join('・') : items.map(i => i.label.replace(/（.*）/, '')).join('・')}
          </Text>
        </HStack>
      }>
      <VStack gap={3} paddingBlockStart={2}>
        {items.map(i => (
          <Slider
            key={i.key}
            label={i.label}
            value={extra[i.key] ?? i.def}
            min={i.min}
            max={i.max}
            step={i.step}
            valueDisplay="text"
            formatValue={i.format}
            onChange={(n: number) => set(i.key, i.def, i.step, n)}
          />
        ))}
      </VStack>
    </Collapsible>
  );
}

/** 声の調声一式。voice はソフトと話者（感情の一覧に使う）、value が今の値 */
export function VoiceTuner({voice, value, onChange}: {voice: Voice; value: VoiceParams; onChange: (v: VoiceParams) => void}) {
  const set = (k: 'speed' | 'pitch' | 'intonation' | 'volume') => (n: number) => onChange({...value, [k]: n});
  return (
    <VStack gap={3}>
      <Slider label="話す速さ" value={value.speed} min={0.5} max={2} step={0.05} onChange={set('speed')} valueDisplay="text" formatValue={v => `${v.toFixed(2)}×`} />
      <Slider label="高さ" value={value.pitch} min={-6} max={6} step={0.1} onChange={set('pitch')} valueDisplay="text" formatValue={fmtPitch} />
      <Slider label="抑揚" value={value.intonation} min={0} max={2} step={0.05} onChange={set('intonation')} valueDisplay="text" formatValue={pct} />
      <Slider label="音量" description="合成し直さずに変わります" value={value.volume} min={0} max={2} step={0.05} onChange={set('volume')} valueDisplay="text" formatValue={pct} />
      <EmotionSliders voice={voice} value={value} onChange={onChange} />
      <ExtraSliders voice={voice} value={value} onChange={onChange} />
    </VStack>
  );
}

/** 調声の要点を短く（プリセットの説明に使う） */
export function tuningSummary(p: VoiceParams, base?: VoiceParams): string {
  const b = base ?? {speed: 1, pitch: 0, intonation: 1, volume: 1, emotions: {}};
  const out: string[] = [];
  if (Math.abs(p.speed - b.speed) > 0.001) out.push(`速さ ${p.speed.toFixed(2)}×`);
  if (Math.abs(p.pitch - b.pitch) > 0.001) out.push(`高さ ${fmtPitch(p.pitch)}`);
  if (Math.abs(p.intonation - b.intonation) > 0.001) out.push(`抑揚 ${pct(p.intonation)}`);
  if (Math.abs(p.volume - b.volume) > 0.001) out.push(`音量 ${pct(p.volume)}`);
  const emo = Object.keys(p.emotions).filter(k => p.emotions[k] > 0);
  if (emo.length) out.push(emo.map(k => EMOTION_LABEL[k] ?? k).join('・'));
  if (Object.keys(p.extra ?? {}).length) out.push('細かい調整あり');
  return out.length ? out.join('・') : 'キャラクターの声と同じ';
}

/** 名前を付けて保存する小さなダイアログ */
function NameDialog({isOpen, title, initial, confirm, onClose, onSave}: {isOpen: boolean; title: string; initial: string; confirm: string; onClose: () => void; onSave: (name: string) => void}) {
  const [name, setName] = useState(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setName(initial);
  }
  const n = name.trim();
  const save = () => {
    if (!n) return;
    onSave(n);
    onClose();
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && onClose()} width={400} purpose="form">
      <DialogHeader title={title} onOpenChange={o => !o && onClose()} />
      <VStack gap={3} padding={4}>
        <TextInput
          label="名前"
          description="例：叫び、ささやき、早口"
          value={name}
          onChange={setName}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) save();
          }}
        />
        <HStack gap={2} hAlign="end">
          <Button label="やめる" variant="ghost" onClick={onClose} />
          <Button label={confirm} variant="primary" isDisabled={!n} onClick={save} />
        </HStack>
      </VStack>
    </Dialog>
  );
}

/** 話者の選択肢（VOICEVOX は同じキャラクターのスタイル、ほかのソフトは同じソフトの話者すべて） */
function useStyleOptions(ch: Character) {
  const voices = useStore(s => s.voices[ch.voice.engine]);
  const base = voices?.find(v => v.speaker === ch.voice.speaker);
  const styles = (voices ?? []).filter(v => (ch.voice.engine === 'voicevox' ? v.credit === base?.credit : true));
  return {base, styles};
}

/** セリフの調声。プリセットを選び、スライダーを動かすとこの行だけの値になる */
export function LineTuning({clip}: {clip: VoiceClip}) {
  const ch = useStore(s => s.project!.characters.find(c => c.id === clip.characterId));
  const [saving, setSaving] = useState(false);
  const {base, styles} = useStyleOptions(ch ?? ({voice: {engine: 'voicevox', speaker: ''}} as Character));
  if (!ch) return null;
  const presets = ch.voicePresets ?? [];
  const preset = presets.find(p => p.id === clip.presetId);
  const eff = effectiveVoice(ch, clip);
  const from = preset ? `プリセット「${preset.name}」` : 'キャラクターの声';
  const tuned = !!clip.paramsOverride;
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={3}>調声</Heading>
        <Button label="プリセットに登録…" size="sm" variant="ghost" icon={<Icon icon={BookmarkPlus} />} tooltip="この行の調声を、キャラクターのプリセットとして残す" onClick={() => setSaving(true)} />
      </HStack>
      <Selector
        label="プリセット"
        value={clip.presetId && preset ? clip.presetId : ''}
        options={[{value: '', label: 'キャラクターの声（標準）'}, ...presets.map(p => ({value: p.id, label: p.name}))]}
        description={presets.length ? undefined : 'よく使う調声は「プリセットに登録…」で残しておくと、ほかの行でも選べます'}
        onChange={v => updateClip(clip.id, {presetId: v || null, paramsOverride: null})}
        width="100%"
      />
      {styles.length > 1 && (
        <Selector
          label={ch.voice.engine === 'voicevox' ? 'スタイル' : '声'}
          value={clip.speakerOverride ?? ''}
          options={[
            {value: '', label: `${from}と同じ（${styles.find(v => v.speaker === (preset?.speaker || ch.voice.speaker))?.displayName ?? base?.displayName ?? ch.voice.speaker}）`},
            ...styles.filter(v => v.speaker !== (preset?.speaker || ch.voice.speaker)).map(v => ({value: v.speaker, label: v.displayName})),
          ]}
          hasSearch={styles.length > 8}
          onChange={v => updateClip(clip.id, {speakerOverride: v || null})}
          width="100%"
        />
      )}
      {tuned ? (
        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="supporting">この行だけ調整しています</Text>
          <Button
            label={`${preset ? 'プリセット' : 'キャラクター'}の値に戻す`}
            size="sm"
            variant="ghost"
            icon={<Icon icon={RotateCcw} />}
            onClick={() => updateClip(clip.id, {paramsOverride: null})}
          />
        </HStack>
      ) : (
        <Hint>{from}の値です。動かすとこの行だけ変わります。</Hint>
      )}
      <VoiceTuner voice={eff} value={eff.params} onChange={v => updateClip(clip.id, {paramsOverride: v})} />
      {eff.engine === 'voicevox' && <AccentEditor key={clip.id} clip={clip} voice={eff} />}
      <NameDialog
        isOpen={saving}
        title="この行の調声をプリセットに登録"
        initial={`プリセット ${presets.length + 1}`}
        confirm="登録"
        onClose={() => setSaving(false)}
        onSave={name => {
          addVoicePreset(ch.id, {name, speaker: eff.speaker !== ch.voice.speaker ? eff.speaker : null, params: presetParams(eff.params)}, clip.id);
          getNotify()(`「${ch.name}」のプリセット「${name}」を登録しました。ほかの行でも選べます`);
        }}
      />
    </VStack>
  );
}

/** キャラクターの声のプリセットの一覧と編集 */
export function PresetManager({character}: {character: Character}) {
  const presets = character.voicePresets ?? [];
  const usage = useStore(s => {
    const m: Record<string, number> = {};
    for (const c of s.project?.clips ?? []) if (c.type === 'voice' && c.characterId === character.id && c.presetId) m[c.presetId] = (m[c.presetId] ?? 0) + 1;
    return JSON.stringify(m);
  });
  const used = JSON.parse(usage) as Record<string, number>;
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const {styles} = useStyleOptions(character);
  const speakerName = (sp: string) => styles.find(v => v.speaker === sp)?.displayName ?? sp;
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <HStack hAlign="between" vAlign="center">
        <VStack gap={0}>
          <Heading level={3}>声のプリセット</Heading>
          <Text type="supporting">セリフごとに選べる声の調子（叫び・ささやきなど）</Text>
        </VStack>
        <IconButton label="プリセットを追加" tooltip="今の声の設定から追加" variant="ghost" size="sm" icon={<Icon icon={Plus} />} onClick={() => setAdding(true)} />
      </HStack>
      {!presets.length && <Text type="supporting">まだありません。「＋」で今の声から作るか、セリフの「調声」で調整してから「プリセットに登録…」を押してください。</Text>}
      {presets.map(pr => (
        <PresetRow
          key={pr.id}
          character={character}
          preset={pr}
          uses={used[pr.id] ?? 0}
          isOpen={open === pr.id}
          onOpenChange={o => setOpen(o ? pr.id : null)}
          speakerOptions={styles.map(v => ({value: v.speaker, label: v.displayName}))}
          speakerName={speakerName}
        />
      ))}
      <NameDialog
        isOpen={adding}
        title="プリセットを追加"
        initial={`プリセット ${presets.length + 1}`}
        confirm="追加"
        onClose={() => setAdding(false)}
        onSave={name => {
          const id = addVoicePreset(character.id, {name, speaker: null, params: presetParams(character.voice.params)});
          setOpen(id);
        }}
      />
    </VStack>
  );
}

function PresetRow({
  character,
  preset,
  uses,
  isOpen,
  onOpenChange,
  speakerOptions,
  speakerName,
}: {
  character: Character;
  preset: VoicePreset;
  uses: number;
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  speakerOptions: {value: string; label: string}[];
  speakerName: (s: string) => string;
}) {
  const voice: Voice = {...character.voice, speaker: preset.speaker || character.voice.speaker, params: preset.params};
  const set = (patch: Partial<Omit<VoicePreset, 'id'>>) => updateVoicePreset(character.id, preset.id, patch);
  const summary = [preset.speaker ? speakerName(preset.speaker) : null, tuningSummary(preset.params, character.voice.params), uses ? `${uses} 行で使用` : null].filter(Boolean).join(' · ');
  return (
    <div className="vx-preset">
      <Collapsible
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        trigger={
          <VStack gap={0}>
            <Text type="label">{preset.name}</Text>
            <Text type="supporting" maxLines={2}>
              {summary}
            </Text>
          </VStack>
        }>
        <VStack gap={3} paddingBlockStart={3}>
          <TextInput label="名前" value={preset.name} onChange={name => set({name})} />
          {speakerOptions.length > 1 && (
            <Selector
              label={character.voice.engine === 'voicevox' ? 'スタイル' : '声'}
              value={preset.speaker ?? ''}
              options={[{value: '', label: `キャラクターと同じ（${speakerName(character.voice.speaker)}）`}, ...speakerOptions.filter(o => o.value !== character.voice.speaker)]}
              hasSearch={speakerOptions.length > 8}
              onChange={v => set({speaker: v || null})}
              width="100%"
            />
          )}
          <VoiceTuner voice={voice} value={preset.params} onChange={params => set({params})} />
          {uses > 0 && <Banner status="info" title={`${uses} 行がこのプリセットを使っています`} description="変えると、その行は合成し直しになります（音量だけなら合成し直しません）" />}
          <HStack gap={2} wrap="wrap">
            <Button
              label="複製"
              size="sm"
              variant="ghost"
              icon={<Icon icon={Copy} />}
              onClick={() => addVoicePreset(character.id, {name: `${preset.name} のコピー`, speaker: preset.speaker, params: presetParams(preset.params)})}
            />
            <Button
              label="削除"
              size="sm"
              variant="ghost"
              icon={<Icon icon={Trash2} />}
              onClick={() => {
                removeVoicePreset(character.id, preset.id);
                getNotify()(
                  uses ? `プリセット「${preset.name}」を削除しました。使っていた ${uses} 行はキャラクターの声に戻ります` : `プリセット「${preset.name}」を削除しました`,
                  'info',
                  'preset-deleted',
                  {label: '元に戻す', onClick: undo},
                );
              }}
            />
          </HStack>
        </VStack>
      </Collapsible>
    </div>
  );
}
