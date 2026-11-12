// 右パネル。選んだセリフ、またはキャラクターの設定を編集する。

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Selector} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {Switch} from '@astryxdesign/core/Switch';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';
import {AudioLines, ImagePlus, MousePointerClick, Scissors, Trash2, X} from 'lucide-react';
import {IconButton} from '@astryxdesign/core/IconButton';
import type {Character, EngineId, MediaClip, Portrait, Transform, VoiceClip, VoiceParams} from '../model';
import {ENGINE_LABEL, defaultParams, framesToTimecode} from '../model';
import {ANIMATION_LABEL, type SubtitleAnimation} from '../subtitleAnim';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {deleteClip, getState, setPortrait, setState, splitClip, updateCharacter, updateClip, useStore} from '../store';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import {loadVoices, pickPortraitPart, synthesize, type Notify} from '../actions';

function ParamSliders({value, onChange}: {value: VoiceParams; onChange: (v: VoiceParams) => void}) {
  const set = (k: keyof Omit<VoiceParams, 'emotions'>) => (n: number) => onChange({...value, [k]: n});
  return (
    <VStack gap={3}>
      <Slider label="話す速さ" value={value.speed} min={0.5} max={2} step={0.05} onChange={set('speed')} valueDisplay="text" formatValue={v => `${v.toFixed(2)}×`} />
      <Slider label="高さ" value={value.pitch} min={-6} max={6} step={0.1} onChange={set('pitch')} valueDisplay="text" formatValue={v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`} />
      <Slider label="抑揚" value={value.intonation} min={0} max={2} step={0.05} onChange={set('intonation')} valueDisplay="text" formatValue={v => v.toFixed(2)} />
    </VStack>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <Heading level={3}>{title}</Heading>
      {children}
    </VStack>
  );
}

function ClipInspector({clip, notify}: {clip: VoiceClip; notify: Notify}) {
  const project = useStore(s => s.project)!;
  const busy = useStore(s => s.busy);
  const error = useStore(s => s.synthErrors[clip.id]);
  const fps = project.video.fps;
  const ch = project.characters.find(c => c.id === clip.characterId);
  return (
    <>
      <Section title="セリフ">
        <Selector
          label="キャラクター"
          value={clip.characterId}
          options={project.characters.map(c => ({value: c.id, label: c.name}))}
          onChange={v => updateClip(clip.id, {characterId: v, audio: null})}
          width="100%"
        />
        <TextArea
          label="読み上げる文"
          value={clip.text}
          onChange={v => updateClip(clip.id, {text: v, audio: null})}
        />
        <TextArea
          label="字幕"
          description="空のときは読み上げる文をそのまま出します"
          isOptional
          value={clip.subtitle ?? ''}
          onChange={v => updateClip(clip.id, {subtitle: v === '' ? null : v})}
        />
        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="supporting" hasTabularNumbers>
            {framesToTimecode(clip.start, fps)} から {(clip.duration / fps).toFixed(2)} 秒
          </Text>
          <Text type="supporting">{error ? '合成できませんでした' : clip.audio ? '合成済み' : '未合成'}</Text>
        </HStack>
        {error && (
          <Banner status="error" title="この行を合成できませんでした" description={error} />
        )}
        <HStack gap={2}>
          <Button
            label={error ? 'もう一度合成' : 'この行を合成'}
            icon={<Icon icon={AudioLines} />}
            isLoading={!!busy}
            onClick={() => void synthesize(notify, [clip.id])}
          />
          <Button label="削除" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => deleteClip(clip.id)} />
        </HStack>
      </Section>
      <Divider />
      <Section title="この行の声">
        <Switch
          label="キャラクターの設定と変える"
          value={clip.paramsOverride !== null}
          onChange={on => updateClip(clip.id, {paramsOverride: on ? {...(ch?.voice.params ?? defaultParams())} : null, audio: null})}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
        {clip.paramsOverride && (
          <ParamSliders value={clip.paramsOverride} onChange={v => updateClip(clip.id, {paramsOverride: v, audio: null})} />
        )}
        <NumberInput
          label="次のセリフまでの間（フレーム）"
          value={clip.gapAfter}
          min={0}
          max={600}
          onChange={v => updateClip(clip.id, {gapAfter: v})}
        />
      </Section>
    </>
  );
}

function TransformFields({value, onChange}: {value: Transform; onChange: (t: Transform) => void}) {
  return (
    <VStack gap={3}>
      <HStack gap={2}>
        <NumberInput label="横の位置" value={value.x} step={10} onChange={x => onChange({...value, x})} />
        <NumberInput label="縦の位置" value={value.y} step={10} onChange={y => onChange({...value, y})} />
      </HStack>
      <Slider label="大きさ" value={value.scale} min={0.1} max={3} step={0.01} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(scale: number) => onChange({...value, scale})} />
      <Slider label="不透明度" value={value.opacity} min={0} max={1} step={0.01} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(opacity: number) => onChange({...value, opacity})} />
    </VStack>
  );
}

const MEDIA_KIND_LABEL = {image: '画像', video: '動画', audio: '音声'} as const;

function MediaInspector({clip, notify}: {clip: MediaClip; notify: Notify}) {
  const fps = useStore(s => s.project!.video.fps);
  const proxy = useStore(s => s.proxies[clip.src]);
  const name = clip.src.split(/[\\/]/).pop() ?? clip.src;
  return (
    <>
      <Section title={MEDIA_KIND_LABEL[clip.mediaKind]}>
        <Text type="body" maxLines={2} wordBreak="break-all">
          {name}
        </Text>
        <Text type="supporting" hasTabularNumbers>
          {framesToTimecode(clip.start, fps)} から {(clip.duration / fps).toFixed(2)} 秒
          {clip.inPoint > 0 ? `（素材の ${(clip.inPoint / fps).toFixed(2)} 秒目から）` : ''}
        </Text>
        {clip.mediaKind === 'video' && proxy && !proxy.url && !proxy.error && (
          <ProgressBar label="プレビュー用の動画を作っています" value={proxy.ratio * 100} hasValueLabel />
        )}
        {proxy?.error && <Text type="supporting">プレビューを用意できませんでした（書き出しには影響しません）</Text>}
        <HStack gap={2}>
          <Button
            label="再生位置で分ける"
            icon={<Icon icon={Scissors} />}
            onClick={() => {
              if (!splitClip(clip.id, getState().playhead)) notify('再生位置をこの素材の上に動かしてください');
            }}
          />
          <Button label="削除" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => deleteClip(clip.id)} />
        </HStack>
      </Section>
      <Divider />
      {clip.mediaKind !== 'audio' && (
        <Section title="配置">
          <TransformFields value={clip.transform} onChange={transform => updateClip(clip.id, {transform})} />
        </Section>
      )}
      {(clip.mediaKind === 'audio' || (clip.mediaKind === 'video' && clip.hasAudio)) && (
        <Section title="音">
          <Slider label="音量" value={clip.volume} min={0} max={2} step={0.05} valueDisplay="text" formatValue={v => `${Math.round(v * 100)}%`} onChange={(volume: number) => updateClip(clip.id, {volume})} />
        </Section>
      )}
    </>
  );
}

const fileName = (p: string | null) => (p ? (p.split(/[\\/]/).pop() ?? p) : '未設定');

function PartRow({label, path, onPick, onClear}: {label: string; path: string | null; onPick: () => void; onClear?: () => void}) {
  return (
    <HStack gap={2} vAlign="center" hAlign="between">
      <VStack gap={0}>
        <Text type="label">{label}</Text>
        <Text type="supporting" maxLines={1}>
          {fileName(path)}
        </Text>
      </VStack>
      <HStack gap={1}>
        {path && onClear && <IconButton label={`${label}を外す`} tooltip="外す" variant="ghost" size="sm" icon={<Icon icon={X} />} onClick={onClear} />}
        <Button label="選ぶ" size="sm" onClick={onPick} />
      </HStack>
    </HStack>
  );
}

function PortraitSection({character}: {character: Character}) {
  const pt = character.portrait;
  if (!pt) {
    return (
      <Section title="立ち絵">
        <Text type="supporting">体・目・口を別々の透過 PNG（同じ大きさ）で用意すると、口パクと目パチが付きます。</Text>
        <Button label="体の画像を選ぶ" icon={<Icon icon={ImagePlus} />} onClick={() => void pickPortraitPart(character.id, 'base')} />
      </Section>
    );
  }
  const set = (patch: Partial<Portrait>) => setPortrait(character.id, {...pt, ...patch});
  const clearPart = (part: 'eyes' | 'mouth', i: number) => {
    const list = [...pt[part]] as Portrait['eyes'];
    list[i] = null;
    set({[part]: list});
  };
  const eyes = ['目（開）', '目（半目）', '目（閉）'];
  const mouth = ['口（閉）', '口（半開き）', '口（開）'];
  return (
    <Section title="立ち絵">
      <Switch label="表示する" value={pt.visible} onChange={visible => set({visible})} labelPosition="start" labelSpacing="spread" width="100%" />
      <PartRow label="体" path={pt.base} onPick={() => void pickPortraitPart(character.id, 'base')} />
      {eyes.map((l, i) => (
        <PartRow key={l} label={l} path={pt.eyes[i]} onPick={() => void pickPortraitPart(character.id, 'eyes', i)} onClear={() => clearPart('eyes', i)} />
      ))}
      {mouth.map((l, i) => (
        <PartRow key={l} label={l} path={pt.mouth[i]} onPick={() => void pickPortraitPart(character.id, 'mouth', i)} onClear={() => clearPart('mouth', i)} />
      ))}
      <TransformFields value={pt.transform} onChange={transform => set({transform})} />
      <Button label="立ち絵を外す" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => setPortrait(character.id, null)} />
    </Section>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** 色の四角（押すと OS の色選択が開く） */
function ColorSwatchInput({label, value, onChange}: {label: string; value: string; onChange: (v: string) => void}) {
  return (
    <label className="vx-color-swatch" style={{background: HEX.test(value) ? value : '#000'}} title={label}>
      <input type="color" aria-label={label} value={HEX.test(value) ? value : '#000000'} onChange={e => onChange(e.target.value.toUpperCase())} />
    </label>
  );
}

/** 色：四角で選ぶか、#RRGGBB を打つ */
function ColorField({label, value, onChange}: {label: string; value: string; onChange: (v: string) => void}) {
  return (
    <HStack gap={2} vAlign="end">
      <ColorSwatchInput label={`${label}を選ぶ`} value={value} onChange={onChange} />
      <div style={{flex: 1}}>
        <TextInput
          label={label}
          value={value}
          onChange={onChange}
          status={HEX.test(value) ? undefined : {type: 'error', message: '#RRGGBB の形で入力してください'}}
        />
      </div>
    </HStack>
  );
}

function CharacterInspector({character}: {character: Character}) {
  const voices = useStore(s => s.voices[character.voice.engine]);
  const update = (patch: Partial<Character>) => updateCharacter(character.id, patch);
  const setVoice = (patch: Partial<Character['voice']>) => update({voice: {...character.voice, ...patch}});
  const speakerOptions = (voices ?? []).map(v => ({value: v.speaker, label: v.displayName}));
  if (!speakerOptions.some(o => o.value === character.voice.speaker)) {
    speakerOptions.unshift({value: character.voice.speaker, label: character.voice.speaker});
  }
  const tab = useStore(s => s.inspectorTab);
  return (
    <>
      <VStack gap={3} paddingInline={4} paddingBlockStart={4}>
        <HStack gap={2} vAlign="center">
          <ColorSwatchInput label="タイムラインの色" value={character.color} onChange={color => update({color})} />
          <div style={{flex: 1}}>
            <TextInput label="名前" isLabelHidden value={character.name} onChange={v => update({name: v})} />
          </div>
        </HStack>
        <TabList value={tab} onChange={v => setState({inspectorTab: v as 'voice' | 'subtitle' | 'portrait'})} layout="fill" size="sm" role="tablist" hasDivider>
          <Tab value="voice" label="声" panelId="vx-insp-panel" />
          <Tab value="subtitle" label="字幕" panelId="vx-insp-panel" />
          <Tab value="portrait" label="立ち絵" panelId="vx-insp-panel" />
        </TabList>
      </VStack>
      <div id="vx-insp-panel" role="tabpanel">
        {tab === 'voice' && (
          <Section title="声">
            <Selector
              label="音声合成ソフト"
              value={character.voice.engine}
              options={(Object.keys(ENGINE_LABEL) as EngineId[]).map(e => ({value: e, label: ENGINE_LABEL[e]}))}
              onChange={v => {
                void loadVoices(v as EngineId);
                // ソフトを変えたら、そのソフトの最初の話者にする（話者名はソフトごとに違うため）
                const first = getState().voices[v as EngineId]?.[0]?.speaker ?? '';
                setVoice({engine: v as EngineId, speaker: first});
              }}
              width="100%"
            />
            {character.voice.engine === 'voicevox' && (
              <Text type="supporting">VOICEVOX を起動しておくと使えます。動画には「VOICEVOX:キャラクター名」の表記が必要です（書き出し画面に出ます）。</Text>
            )}
            <Selector
              label="話者"
              value={character.voice.speaker}
              options={speakerOptions}
              hasSearch={speakerOptions.length > 8}
              onChange={v => setVoice({speaker: v})}
              width="100%"
            />
            <ParamSliders value={character.voice.params} onChange={params => setVoice({params})} />
            <Slider
              label="音量"
              value={character.voice.params.volume}
              min={0}
              max={2}
              step={0.05}
              valueDisplay="text"
              formatValue={v => `${Math.round(v * 100)}%`}
              onChange={(volume: number) => update({voice: {...character.voice, params: {...character.voice.params, volume}}})}
            />
          </Section>
        )}
        {tab === 'subtitle' && (
          <Section title="字幕">
            <Selector
              label="位置"
              value={character.subtitle.position}
              options={[
                {value: 'bottom', label: '下'},
                {value: 'middle', label: '中央'},
                {value: 'top', label: '上'},
              ]}
              onChange={v => update({subtitle: {...character.subtitle, position: v as Character['subtitle']['position']}})}
              width="100%"
            />
            <Selector
              label="出し方"
              value={character.subtitle.animation}
              options={(Object.keys(ANIMATION_LABEL) as SubtitleAnimation[]).map(a => ({value: a, label: ANIMATION_LABEL[a]}))}
              onChange={v => update({subtitle: {...character.subtitle, animation: v as SubtitleAnimation}})}
              width="100%"
            />
            <HStack gap={2}>
              <NumberInput label="文字の大きさ" value={character.subtitle.fontSize} min={12} max={200} onChange={v => update({subtitle: {...character.subtitle, fontSize: v}})} />
              <NumberInput label="縁取り" value={character.subtitle.outlineWidth} min={0} max={20} onChange={v => update({subtitle: {...character.subtitle, outlineWidth: v}})} />
            </HStack>
            <ColorField label="文字の色" value={character.subtitle.color} onChange={color => update({subtitle: {...character.subtitle, color}})} />
            <ColorField label="縁の色" value={character.subtitle.outlineColor} onChange={outlineColor => update({subtitle: {...character.subtitle, outlineColor}})} />
          </Section>
        )}
        {tab === 'portrait' && <PortraitSection character={character} />}
      </div>
    </>
  );
}

export function Inspector({notify}: {notify: Notify}) {
  const project = useStore(s => s.project);
  const selectedClipId = useStore(s => s.selectedClipId);
  const selectedCharacterId = useStore(s => s.selectedCharacterId);
  if (!project) return null;
  const clip = project.clips.find(c => c.id === selectedClipId);
  if (clip?.type === 'voice') return <ClipInspector key={clip.id} clip={clip} notify={notify} />;
  if (clip?.type === 'media') return <MediaInspector key={clip.id} clip={clip} notify={notify} />;
  const ch = project.characters.find(c => c.id === selectedCharacterId);
  if (ch) return <CharacterInspector key={ch.id} character={ch} />;
  return (
    <VStack padding={6}>
      <EmptyState
        isCompact
        icon={<Icon icon={MousePointerClick} size="lg" color="secondary" />}
        title="何も選ばれていません"
        description="タイムラインのセリフか、左のキャラクターを選ぶと設定が出ます"
      />
    </VStack>
  );
}
