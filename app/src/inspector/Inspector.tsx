import {Fragment, useEffect, useRef, useState} from 'react';
import {Hint} from '../Hint';
import {Collapsible} from '@astryxdesign/core/Collapsible';
// 右パネル。選んだセリフ、またはキャラクターの設定を編集する。

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {Icon} from '@astryxdesign/core/Icon';
import {RubyButton} from './RubyButton';
import {SpanButton} from './SpanButton';
import {SpeedSection} from './SpeedSection';
import {CutoutSection} from './CutoutSection';
import {AutoCaptionSection, AutoReframeSection, RemoveBackgroundSection} from './AiSection';
import {SilenceCutSection} from './SilenceCutSection';
import {SoundFxFields} from './SoundFxFields';
import {AudioFilterHint, AudioFilterMenu, AudioFilterRows, ReverbFields} from './AudioFilterFields';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Switch} from '@astryxdesign/core/Switch';
import {Selector} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';
import {applySubtitleStyle, removeSubtitleStyle, saveSubtitleStyle, useSavedSubtitleStyles} from '../savedStyles';
import {AudioLines, Copy, Link2, RotateCcw, MousePointerClick, Plus, Scissors, Settings, Trash2, Unlink, UserPen, FileImage, Volume2} from 'lucide-react';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import type {LineAudio, CaptionClip, LinePortrait, PortraitClip, Project, SubtitleCustom, SubtitleOverride, Character, EngineId, MediaClip, Portrait, VoiceClip} from '../model';
import {
  BASE_EXPRESSION,
  ENGINE_LABEL,
  captionOf,
  framesToTimecode,
  projectDuration,
  isPlainLineAudio,
  isPlainLinePortrait,
  plainLineAudio,
  trackCode,
  isSpeakerMissing,
  lineOf,
  plainLook,
  speakerLabel,
  SPLIT_LAYOUTS,
  prevAudio,
  crossfadeFrames,
} from '../model';
import {LineTuning, PresetManager, VoiceTuner} from './VoiceTuning';
import {LinePsdLayers, PsdPortraitEditor, pickPsdPortrait} from './PsdPortraitEditor';
import {ColorRow, EffectsEditor, PORTRAIT_FX, LookEditor, LookFields, ShapeInspector, TextInspector, TextStyleFields, TransformFields} from './VisualInspector';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {ANIMATION_LABEL, KARAOKE_COLOR, type SubtitleAnimation} from '../subtitleAnim';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {
  canMerge,
  canSeparate,
  deleteClip,
  deleteClips,
  mergeClip,
  separateClip,
  duplicateSelection,
  editableSelection,
  getState,
  setCharacterForSelection,
  setPortrait,
  setPresetForSelection,
  setExpressionForSelection,
  autoExpressionsForSelection,
  splitLongLinesForSelection,
  setGapForSelection,
  setState,
  splitClip,
  updateCharacter,
  updateClip,
  updateTrack,
  addPortraitItem,
  useStore,
  setAftertime,
  setLineAudio,
} from '../store';
import {applySplitLayout, getNotify, loadVoices, previewVoice, splitAtScenes, synthesize, type Notify} from '../actions';

/**
 * セリフと発音（YMM4 と同じ）。セリフ＝字幕に出す文、発音＝読み上げる文。
 * セリフを書き換えると字幕だけ変わり、Enter（または「発音に反映」）で発音もセリフと同じにして合成し直す。
 * 発音だけを変えると、字幕はそのままで読み方だけ変わる
 */
function SerifFields({clip, notify}: {clip: VoiceClip; notify: Notify}) {
  const shown = clip.subtitle ?? clip.text;
  const [draft, setDraft] = useState(shown);
  const [last, setLast] = useState(shown);
  if (shown !== last) {
    setLast(shown);
    setDraft(shown);
  }
  const apply = () => {
    const t = draft.trim();
    if (!t) return;
    updateClip(clip.id, {text: t, subtitle: null});
    void synthesize(notify, [clip.id]);
  };
  const differs = clip.subtitle !== null && clip.subtitle !== clip.text;
  const lineRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div
        ref={lineRef}
        onKeyDownCapture={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            apply();
          }
        }}>
        <TextArea
          label="セリフ"
          description="字幕に出す文。Enter で発音にも反映して合成し直します（Shift+Enter で改行）。ふりがなは 漢字《かんじ》"
          value={draft}
          onChange={v => {
            setDraft(v);
            updateClip(clip.id, {subtitle: v === clip.text ? null : v});
          }}
        />
      </div>
      {/* 字幕だけ書き換えて発音がそのままのときは、ずれていることを言葉でも出す（声は古い文のまま） */}
      {differs && (
        <Text type="supporting" color="accent">
          字幕と発音が違います（声は発音の文のまま）。そろえるなら「発音に反映」
        </Text>
      )}
      <HStack gap={2} hAlign="start">
        <Button label="発音に反映" size="sm" variant={differs ? 'primary' : 'secondary'} tooltip="発音をセリフと同じにして合成し直す（YMM4 の「変」）" isDisabled={!differs} onClick={apply} />
        <RubyButton
          host={() => lineRef.current}
          value={draft}
          onChange={v => {
            setDraft(v);
            updateClip(clip.id, {subtitle: v === clip.text ? null : v});
          }}
        />
        <SpanButton
          host={() => lineRef.current}
          value={draft}
          onChange={v => {
            setDraft(v);
            updateClip(clip.id, {subtitle: v === clip.text ? null : v});
          }}
        />
      </HStack>
      <TextArea
        label="発音"
        description="読み上げる文。読み方だけ直したいときに（字幕はそのまま）"
        value={clip.text}
        onChange={v => updateClip(clip.id, {text: v, subtitle: clip.subtitle ?? clip.text})}
      />
    </>
  );
}

/** セリフ後の余韻の目安（フレーム） */
const GAP_PRESETS: [string, number][] = [
  ['なし', 0],
  ['短め', 3],
  ['普通', 6],
  ['長め', 15],
  ['たっぷり', 30],
];

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <Heading level={3}>{title}</Heading>
      {children}
    </VStack>
  );
}

/** セリフのプロパティのタブ（選ぶセリフを変えても、開いていたタブのまま） */
type LineTab = 'line' | 'voice' | 'subtitle' | 'portrait';
let lastLineTab: LineTab = 'line';

function ClipInspector({clip, notify}: {clip: VoiceClip; notify: Notify}) {
  const project = useStore(s => s.project)!;
  const [tab, setTabState] = useState<LineTab>(lastLineTab);
  const setTab = (t: LineTab) => {
    lastLineTab = t;
    setTabState(t);
  };
  return (
    <>
      {/* YMM4 のセリフアイテムと同じく、音声・字幕・立ち絵の設定をセリフに持たせる。設定ごとにタブで分ける */}
      <div className="vx-linetabs">
        <QuickBar clip={clip} notify={notify} openVoice={() => setTab('voice')} />
        <TabList role="tablist" aria-label="セリフの設定" value={tab} onChange={v => setTab(v as LineTab)} layout="fill" size="sm" hasDivider>
          <Tab value="line" label="セリフ" panelId="vx-line-panel" />
          <Tab value="voice" label="音声" panelId="vx-line-panel" />
          <Tab value="subtitle" label="字幕" panelId="vx-line-panel" />
          <Tab value="portrait" label="立ち絵" panelId="vx-line-panel" />
        </TabList>
      </div>
      <div id="vx-line-panel" role="tabpanel">
        {tab === 'line' && <LineBasics clip={clip} notify={notify} />}
        {tab === 'voice' && (
          <>
            <TabSummary text={voiceSummary(project, clip)} />
            <LineTuning clip={clip} />
            <Divider />
            <LineAudioFields clip={clip} />
            <Divider />
            <GapFields clip={clip} />
            <Divider />
            <GeneralFields clip={clip} />
          </>
        )}
        {tab === 'subtitle' && <LineSubtitleSettings voice={clip} />}
        {tab === 'portrait' && (
          <>
            <TabSummary text={portraitSummary(project, clip)} />
            <LinePortraitSettings clip={clip} />
          </>
        )}
      </div>
    </>
  );
}

/**
 * いちばんよく触る「声（感情のプリセット）」と「表情」を、タブより上にいつも出す（タブを開かずに 1 クリックで変えられる）。
 * どちらも無いキャラクターなら出さない
 */
function QuickBar({clip, notify, openVoice}: {clip: VoiceClip; notify: Notify; openVoice: () => void}) {
  const ch = useStore(s => s.project!.characters.find(c => c.id === clip.characterId));
  if (!ch) return null;
  const presets = ch.voicePresets ?? [];
  const expressions = ch.portrait?.psd ? (ch.portrait.expressions ?? []) : [];
  if (!presets.length && !expressions.length) return null;
  return (
    <div className="vx-quickbar">
      {presets.length > 0 ? (
        <Selector
          label="声"
          size="sm"
          value={presets.some(p => p.id === clip.presetId) ? clip.presetId! : ''}
          options={[{value: '', label: '通常'}, ...presets.map((p, i) => ({value: p.id, label: p.name, description: i < 9 ? `入力欄で Alt+${i + 1}` : undefined}))]}
          onChange={v => {
            updateClip(clip.id, {presetId: v || null, paramsOverride: null});
            void synthesize(notify, [clip.id]);
          }}
          width="100%"
        />
      ) : (
        <Button label="感情・調声…" size="sm" variant="secondary" onClick={openVoice} tooltip="音声タブの調声を開きます" />
      )}
      {expressions.length > 0 && (
        <Selector
          label="表情"
          size="sm"
          value={clip.expression ?? ''}
          options={[{value: '', label: '変えない'}, {value: BASE_EXPRESSION, label: '通常'}, ...expressions.map(e => ({value: e.name, label: e.name}))]}
          onChange={v => updateClip(clip.id, {expression: v || null})}
          width="100%"
        />
      )}
    </div>
  );
}

/** タブの頭に、今の設定のあらまし */
function TabSummary({text}: {text: string}) {
  return (
    <div className="vx-tabsummary">
      <Text type="supporting" maxLines={1}>
        {text}
      </Text>
    </div>
  );
}

/** セリフタブ：キャラクター・文・合成・削除・分離 */
function LineBasics({clip, notify}: {clip: VoiceClip; notify: Notify}) {
  const project = useStore(s => s.project)!;
  const status = useStore(s => s.synthStatus[clip.id]);
  const error = useStore(s => s.synthErrors[clip.id]);
  const fps = project.video.fps;
  return (
    <>
      <Section title="話す人と文">
        <Selector
          label="キャラクター"
          value={clip.characterId}
          options={project.characters.map(c => ({
            value: c.id,
            label: c.name,
          }))}
          onChange={v => updateClip(clip.id, {characterId: v, presetId: null, audio: null})}
          width="100%"
        />
        <SerifFields key={clip.id} clip={clip} notify={notify} />
        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="supporting" hasTabularNumbers>
            {framesToTimecode(clip.start, fps)} から 長さ {framesToTimecode(clip.duration, fps)}
          </Text>
          <Text type="supporting">{status === 'running' ? '合成中…' : status === 'queued' ? '合成待ち' : error ? '合成できませんでした' : clip.audio ? '合成済み' : '未合成'}</Text>
        </HStack>
        {error && <Banner status="error" title="この行を合成できませんでした" description={error} />}
        <HStack gap={2} wrap="wrap">
          <Button
            label={error ? 'もう一度合成' : clip.audio ? 'この行を合成し直す' : 'この行を合成'}
            icon={<Icon icon={AudioLines} />}
            isLoading={!!status}
            onClick={() => void synthesize(notify, [clip.id])}
          />
          {/* 失敗の多くはソフトが起動していない・場所が違うため。その場で直しに行けるように */}
          {/* 声が選ばれていない・入っていないなら声を選びに、それ以外の失敗はソフトの設定へ */}
          {error && /声|話者/.test(error) && <Button label="声を選ぶ…" variant="secondary" onClick={() => setState({characterDialogOpen: true, dialogCharacterId: clip.characterId})} />}
          {error && <Button label="音声合成ソフトの設定" variant="secondary" icon={<Icon icon={Settings} />} onClick={() => setState({settingsOpen: true})} />}
          <Button label="削除" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => deleteClip(clip.id)} />
        </HStack>
        {canSeparate(project, clip) ? (
          <Button label="字幕と音声を分離" variant="ghost" icon={<Icon icon={Unlink} />} tooltip="字幕はその場に残り、声を近くの空いているレイヤーへ移します" onClick={() => separateClip(clip.id)} />
        ) : canMerge(project, clip) ? (
          <HStack gap={2} wrap="wrap">
            <Button
              label="字幕を選ぶ"
              variant="ghost"
              tooltip="この字幕だけの見た目を変えられます"
              onClick={() => {
                const cap = captionOf(project, clip.id);
                if (cap) setState(s => ({selectedClipId: cap.id, revealSeq: s.revealSeq + 1}));
              }}
            />
            <Button label="字幕と音声をまとめる" variant="ghost" icon={<Icon icon={Link2} />} onClick={() => mergeClip(clip.id)} />
          </HStack>
        ) : null}
      </Section>
    </>
  );
}

/** たたんだ状態は、選ぶセリフを変えても覚えておく */
const groupOpen = new Map<string, boolean>();
function PropGroup({id, title, summary, children}: {id: string; title: string; summary: string; children: React.ReactNode}) {
  const [open, setOpen] = useState(() => groupOpen.get(id) ?? id !== 'voice');
  return (
    <div className="vx-propgroup">
      <Collapsible
        isOpen={open}
        onOpenChange={o => {
          groupOpen.set(id, o);
          setOpen(o);
        }}
        trigger={
          <HStack gap={2} vAlign="center" hAlign="between" width="100%">
            <Heading level={3}>{title}</Heading>
            <Text type="supporting" maxLines={1}>
              {summary}
            </Text>
          </HStack>
        }>
        <div className="vx-propgroup-body">{children}</div>
      </Collapsible>
    </div>
  );
}

function voiceSummary(project: Project, clip: VoiceClip): string {
  const ch = project.characters.find(c => c.id === clip.characterId);
  const preset = ch?.voicePresets?.find(p => p.id === clip.presetId);
  const a = clip.audioFx;
  return [
    preset ? `使う声：プリセット「${preset.name}」` : '使う声：キャラクターの声',
    clip.paramsOverride && '個別に調整',
    a?.pan && (a.pan < 0 ? '左寄り' : '右寄り'),
    (a?.fadeIn || a?.fadeOut) && 'フェード',
    a?.echo && 'エコー',
    a?.reverb && 'リバーブ',
    (a?.filters ?? []).length > 0 && 'エフェクト',
    a?.startOffset && '頭を飛ばす',
  ]
    .filter(Boolean)
    .join('・');
}

function portraitSummary(project: Project, clip: VoiceClip): string {
  const ch = project.characters.find(c => c.id === clip.characterId);
  if (!ch?.portrait?.psd) return 'このキャラクターには PSD 立ち絵がありません';
  const lp = clip.portrait;
  const parts = [
    `表情：${clip.expression ? (clip.expression === BASE_EXPRESSION ? '通常' : clip.expression) : '変更なし'}`,
    Object.keys(lp?.visibility ?? {}).length > 0 && 'パーツを変更',
    lp?.noBlink && '目パチなし',
    lp?.noMouth && '口パクなし',
    (lp?.effects ?? []).length > 0 && 'エフェクト',
  ].filter(Boolean);
  return parts.join('・');
}

const panLabel = (v: number) => (Math.abs(v) < 0.005 ? '中央' : v < 0 ? `左 ${Math.round(-v * 100)}%` : `右 ${Math.round(v * 100)}%`);

/** 素材の音のフェードと、前の音とのクロスフェード（書き出しも同じ） */
function SoundFadeFields({clip}: {clip: MediaClip}) {
  const prev = useStore(s => (clip.mediaKind === 'audio' && s.project ? prevAudio(s.project, clip) : null));
  const cf = clip.crossfade ?? 0;
  return (
    <>
      <HStack gap={2}>
        <NumberInput label="音のフェードイン" units="フレーム" value={clip.soundFadeIn ?? 0} min={0} max={clip.duration} onChange={v => updateClip(clip.id, {soundFadeIn: v || undefined})} />
        <NumberInput label="音のフェードアウト" units="フレーム" value={clip.soundFadeOut ?? 0} min={0} max={clip.duration} onChange={v => updateClip(clip.id, {soundFadeOut: v || undefined})} />
      </HStack>
      {clip.mediaKind === 'audio' && (
        <NumberInput
          label="前の音となめらかにつなぐ（クロスフェード）"
          description={
            !prev
              ? '同じレイヤーのすぐ前に音声素材を置くと使えます'
              : cf > 0
                ? `前の音を ${crossfadeFrames(cf, prev.duration, clip.duration)} フレーム延ばして重ね、だんだん入れ替えます`
                : '0 のときはつながず、つなぎ目で切り替わります'
          }
          units="フレーム"
          value={cf}
          min={0}
          max={clip.duration}
          isDisabled={!prev && cf === 0}
          onChange={v => updateClip(clip.id, {crossfade: v || undefined})}
        />
      )}
    </>
  );
}

/** 声の聞こえ方：左右・フェード・再生開始位置・エコー・音声エフェクト（書き出しも同じ） */
function LineAudioFields({clip}: {clip: VoiceClip}) {
  const a: LineAudio = {...plainLineAudio(), ...(clip.audioFx ?? {})};
  const set = (patch: Partial<LineAudio>) => setLineAudio(clip.id, patch);
  const filters = a.filters ?? [];
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={4}>聞こえ方</Heading>
        <Button label="元に戻す" size="sm" variant="ghost" icon={<Icon icon={RotateCcw} />} isDisabled={isPlainLineAudio(clip.audioFx)} onClick={() => updateClip(clip.id, {audioFx: null})} />
      </HStack>
      <Slider label="左右" value={a.pan} min={-1} max={1} step={0.05} valueDisplay="text" formatValue={panLabel} onChange={(pan: number) => set({pan})} />
      <HStack gap={2}>
        <NumberInput label="フェードイン" units="フレーム" value={a.fadeIn} min={0} max={clip.duration} onChange={fadeIn => set({fadeIn})} />
        <NumberInput label="フェードアウト" units="フレーム" value={a.fadeOut} min={0} max={clip.duration} onChange={fadeOut => set({fadeOut})} />
      </HStack>
      <NumberInput
        label="再生開始位置"
        units="フレーム"
        description="声の頭をこの分だけ飛ばします（セリフの長さも短くなります）"
        value={a.startOffset}
        min={0}
        max={600}
        onChange={startOffset => set({startOffset})}
      />
      <Switch label="エコー" value={!!a.echo} onChange={on => set({echo: on ? {delayMs: 180, decay: 0.35} : null})} labelPosition="start" labelSpacing="spread" width="100%" />
      {a.echo && (
        <VStack gap={2}>
          <Slider
            label="遅れ"
            value={a.echo.delayMs}
            min={20}
            max={1000}
            step={10}
            valueDisplay="text"
            formatValue={v => `${v} ms`}
            onChange={(delayMs: number) => set({echo: {...a.echo!, delayMs}})}
          />
          <Slider
            label="響きの大きさ"
            value={a.echo.decay}
            min={0.05}
            max={1}
            step={0.05}
            valueDisplay="text"
            formatValue={v => `${Math.round(v * 100)}%`}
            onChange={(decay: number) => set({echo: {...a.echo!, decay}})}
          />
        </VStack>
      )}
      <ReverbFields reverb={a.reverb} onChange={reverb => set({reverb})} />
      <HStack hAlign="between" vAlign="center">
        <Text type="label">音声エフェクト</Text>
        <AudioFilterMenu filters={filters} onChange={filters => set({filters})} />
      </HStack>
      <AudioFilterHint filters={filters} />
      <AudioFilterRows filters={filters} onChange={filters => set({filters})} />
    </VStack>
  );
}

/** 全般：置いている場所と長さ */
function GeneralFields({clip}: {clip: VoiceClip}) {
  const project = useStore(s => s.project)!;
  const fps = project.video.fps;
  const track = project.tracks.find(t => t.id === clip.trackId);
  return (
    <VStack gap={2} paddingBlock={4} paddingInline={4}>
      <Heading level={4}>全般</Heading>
      <Text type="supporting" hasTabularNumbers>
        {track ? `${trackCode(project, track.id)}・` : ''}
        {framesToTimecode(clip.start, fps)} から 長さ {framesToTimecode(clip.duration, fps)}
      </Text>
      <Switch
        label="長さを固定（合成し直しても変えない）"
        value={clip.lockDuration}
        onChange={lockDuration => updateClip(clip.id, {lockDuration})}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
    </VStack>
  );
}

/** セリフ後の余韻 */
function GapFields({clip}: {clip: VoiceClip}) {
  return (
    <VStack gap={2} paddingBlock={4} paddingInline={4}>
      <Heading level={4}>セリフ後の余韻</Heading>
      <HStack gap={1} wrap="wrap">
        {GAP_PRESETS.map(([label, f]) => (
          <Button key={label} label={label} size="sm" variant={clip.gapAfter === f ? 'primary' : 'secondary'} onClick={() => setAftertime(clip.id, f)} />
        ))}
      </HStack>
      <NumberInput
        label="細かく"
        units="フレーム"
        description="読み終えてから字幕が消えるまで。セリフの長さに含まれ、後ろのアイテムも付いてきます"
        value={clip.gapAfter}
        min={0}
        max={600}
        onChange={v => setAftertime(clip.id, v)}
      />
    </VStack>
  );
}

const DEFAULT_SUBTITLE: Character['subtitle'] = {
  fontFamily: 'Yu Gothic UI',
  fontSize: 56,
  color: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 4,
  position: 'bottom',
  marginV: 60,
  animation: 'none',
};

/** キャラクターの字幕設定から「個別に設定」の初めの値を作る（見た目がなるべく変わらないように） */
export function subtitleCustomFrom(st: Character['subtitle'], height: number): SubtitleCustom {
  const half = height / 2 - st.marginV - st.fontSize * 0.65;
  return {
    fontFamily: st.fontFamily,
    fontSize: st.fontSize,
    color: st.color,
    outlineColor: st.outlineColor,
    outlineWidth: st.outlineWidth,
    bold: false,
    italic: false,
    align: 'center',
    transform: {x: 0, y: Math.round(st.position === 'bottom' ? half : st.position === 'top' ? -half : 0), scale: 1, opacity: 1},
    look: {...plainLook(), fadeIn: st.animation === 'fade' ? 6 : 0, fadeOut: st.animation === 'fade' ? 6 : 0},
  };
}

/** 字幕設定：キャラクター設定どおりか、このセリフだけ個別に設定するか（YMM4 と同じ） */
function LineSubtitleSettings({voice, caption}: {voice: VoiceClip; caption?: CaptionClip}) {
  const project = useStore(s => s.project)!;
  const ch = project.characters.find(c => c.id === voice.characterId);
  const sc = voice.subtitleCustom;
  const set = (patch: Partial<SubtitleCustom>) => sc && updateClip(voice.id, {subtitleCustom: {...sc, ...patch}});
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <SegmentedControl
          label="字幕の見た目"
          size="sm"
          value={sc ? 'custom' : 'character'}
          onChange={v => updateClip(voice.id, {subtitleCustom: v === 'custom' ? subtitleCustomFrom(ch?.subtitle ?? DEFAULT_SUBTITLE, project.video.height) : null})}>
          <SegmentedControlItem value="character" label="キャラクター設定" />
          <SegmentedControlItem value="custom" label="個別に設定" />
        </SegmentedControl>
        {sc ? (
          <Hint>このセリフの字幕だけの見た目です。位置はプレビューでドラッグしても動かせます。</Hint>
        ) : (
          <HStack gap={2} vAlign="center" hAlign="between" wrap="wrap">
            <Text type="supporting">
              {ch ? `${ch.name}の字幕設定（${ch.subtitle.fontSize}px・${ch.subtitle.position === 'bottom' ? '下' : ch.subtitle.position === 'top' ? '上' : '中央'}）` : 'キャラクターの字幕設定'}
            </Text>
            <Button label="キャラクターの字幕設定…" size="sm" onClick={() => setState({dialogCharacterId: voice.characterId, inspectorTab: 'subtitle', characterDialogOpen: true})} />
          </HStack>
        )}
        {sc && <TextStyleFields value={sc} onChange={set} />}
        {!sc && caption && <CaptionStyleOverride clip={caption} base={ch?.subtitle} />}
      </VStack>
      {sc && (
        <>
          <Divider />
          <SubtitleLayoutFields sc={sc} set={set} />
        </>
      )}
      {sc && (
        <>
          <Divider />
          <LookFields transform={sc.transform} look={sc.look} duration={(caption ?? voice).duration} onTransform={transform => set({transform})} onLook={look => set({look})} headingLevel={4} />
        </>
      )}
    </>
  );
}

/** 「個別に設定」した字幕の組み方（行の高さ・文字の間隔・折り返し・縦書き・1 文字ずつ）と装飾（影・背景の帯） */
function SubtitleLayoutFields({sc, set}: {sc: SubtitleCustom; set: (patch: Partial<SubtitleCustom>) => void}) {
  const box = sc.boxColor ?? '';
  const boxRgb = box.slice(0, 7);
  const boxAlpha = box.length === 9 ? parseInt(box.slice(7), 16) / 255 : 1;
  const withAlpha = (rgb: string, a: number) =>
    rgb
      ? `${rgb}${
          a >= 1
            ? ''
            : Math.round(a * 255)
                .toString(16)
                .padStart(2, '0')
                .toUpperCase()
        }`
      : '';
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <Heading level={4}>組み方</Heading>
        <Slider
          label="行の高さ"
          value={sc.lineHeight ?? 1.3}
          min={0.8}
          max={3}
          step={0.05}
          valueDisplay="text"
          formatValue={v => `${Math.round(v * 100)}%`}
          onChange={(lineHeight: number) => set({lineHeight})}
        />
        <HStack gap={2}>
          <NumberInput label="文字の間隔" units="px" value={sc.letterSpacing ?? 0} min={-50} max={200} onChange={letterSpacing => set({letterSpacing})} />
          <NumberInput label="折り返す幅" units="px" description="0 なら折り返しません" value={sc.wrapWidth ?? 0} min={0} max={8000} step={10} onChange={wrapWidth => set({wrapWidth})} />
        </HStack>
        <Switch label="縦書き" value={!!sc.vertical} onChange={vertical => set({vertical})} labelPosition="start" labelSpacing="spread" width="100%" />
        <NumberInput label="文字の表示間隔" units="フレーム" description="1 文字ずつ出す間隔。0 なら一度に出します" value={sc.interval ?? 0} min={0} max={60} onChange={interval => set({interval})} />
      </VStack>
      <Divider />
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <Heading level={4}>装飾</Heading>
        <ColorRow label="グラデーション（下の色）" value={sc.gradientColor ?? ''} allowNone onChange={gradientColor => set({gradientColor})} />
        <ColorRow label="外側の縁の色" value={sc.outline2Color ?? ''} allowNone onChange={outline2Color => set({outline2Color, outline2Width: outline2Color ? sc.outline2Width || 6 : 0})} />
        {sc.outline2Color && <NumberInput label="外側の縁の太さ" units="px" value={sc.outline2Width ?? 6} min={0} max={60} onChange={outline2Width => set({outline2Width})} />}
        <ColorRow label="影の色" value={sc.shadowColor ?? ''} allowNone onChange={shadowColor => set({shadowColor})} />
        {sc.shadowColor && <NumberInput label="影のずれ" units="px" value={sc.shadowOffset ?? 4} min={-100} max={100} onChange={shadowOffset => set({shadowOffset})} />}
        <ColorRow label="背景の帯の色" value={boxRgb} allowNone onChange={rgb => set({boxColor: withAlpha(rgb, boxAlpha)})} />
        {box && (
          <>
            <Slider
              label="帯の不透明度"
              value={boxAlpha}
              min={0.05}
              max={1}
              step={0.05}
              valueDisplay="text"
              formatValue={v => `${Math.round(v * 100)}%`}
              onChange={(a: number) => set({boxColor: withAlpha(boxRgb, a)})}
            />
            <NumberInput label="帯の余白" units="px" value={sc.boxPadding ?? 16} min={0} max={200} onChange={boxPadding => set({boxPadding})} />
          </>
        )}
      </VStack>
    </>
  );
}

/** 立ち絵設定：このセリフの間の表情・レイヤー・目パチ・口パク・エフェクト */
function LinePortraitSettings({clip}: {clip: VoiceClip}) {
  const ch = useStore(s => s.project!.characters.find(c => c.id === clip.characterId));
  if (!ch) return null;
  const pt = ch.portrait;
  const goPortrait = () => setState({dialogCharacterId: ch.id, inspectorTab: 'portrait', characterDialogOpen: true});
  if (!pt?.psd) {
    return (
      <VStack gap={2} paddingBlock={4} paddingInline={4}>
        <Text type="supporting">{ch.name}には PSD 立ち絵がありません。</Text>
        <div>
          <Button label="立ち絵を設定…" size="sm" onClick={goPortrait} />
        </div>
      </VStack>
    );
  }
  const lp = clip.portrait ?? {};
  const setLp = (patch: Partial<LinePortrait>) => {
    const next = {...lp, ...patch};
    updateClip(clip.id, {portrait: isPlainLinePortrait(next) ? null : next});
  };
  const expressions = pt.expressions ?? [];
  return (
    <>
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        {expressions.length > 0 ? (
          <Selector
            label="表情を変更"
            description="このセリフの間だけ立ち絵の表情を変えます。選ばなければ、立ち絵アイテムの既定の表情のまま"
            value={clip.expression ?? ''}
            options={[{value: '', label: '立ち絵アイテムのまま'}, {value: BASE_EXPRESSION, label: '通常'}, ...expressions.map(e => ({value: e.name, label: e.name}))]}
            onChange={v => updateClip(clip.id, {expression: v || null})}
            width="100%"
          />
        ) : (
          <HStack gap={2} vAlign="center" hAlign="between" wrap="wrap">
            <Text type="supporting">立ち絵に表情（笑顔など）を足すと、セリフごとに選べます</Text>
            <Button label="表情を登録…" size="sm" onClick={goPortrait} />
          </HStack>
        )}
        <Selector
          label="目パチ"
          value={lp.noBlink ? 'off' : ''}
          options={[
            {value: '', label: 'キャラクター設定どおり'},
            {value: 'off', label: '目パチしない（開けたまま）'},
          ]}
          onChange={v => setLp({noBlink: v === 'off'})}
          width="100%"
        />
        <Selector
          label="口パク"
          value={lp.noMouth ? 'off' : ''}
          options={[
            {value: '', label: 'キャラクター設定どおり'},
            {value: 'off', label: '口パクしない（閉じたまま）'},
          ]}
          onChange={v => setLp({noMouth: v === 'off'})}
          width="100%"
        />
      </VStack>
      <Divider />
      <VStack gap={2} paddingBlock={4} paddingInline={4}>
        <Collapsible
          defaultIsOpen={Object.keys(lp.visibility ?? {}).length > 0}
          trigger={
            <VStack gap={0}>
              <Heading level={4}>PSD のパーツ表示</Heading>
              <Hint>このセリフの間だけ、PSD のパーツ（PSD のレイヤー）の表示を変えます</Hint>
            </VStack>
          }>
          <div style={{paddingBlockStart: 8}}>
            <LinePsdLayers character={ch} clip={clip} />
          </div>
        </Collapsible>
      </VStack>
      <Divider />
      <VStack gap={3} paddingBlock={4} paddingInline={4}>
        <EffectsEditor
          title="立ち絵エフェクト"
          empty="このセリフの間だけ、立ち絵を白黒にしたり揺らしたりできます。"
          effects={lp.effects ?? []}
          onChange={effects => setLp({effects})}
          headingLevel={4}
          kinds={PORTRAIT_FX}
        />
      </VStack>
    </>
  );
}

const MEDIA_KIND_LABEL = {
  image: '画像',
  video: '動画',
  audio: '音声',
} as const;

function MediaInspector({clip, notify}: {clip: MediaClip; notify: Notify}) {
  const fps = useStore(s => s.project!.video.fps);
  const proxy = useStore(s => s.proxies[clip.src]);
  // リンクした相手（動画の映像 ↔ 音声）。音量は音声クリップのものを使う
  const clips = useStore(s => s.project!.clips);
  const linked = clip.linkId ? clips.filter(c => c.linkId === clip.linkId && c.id !== clip.id) : [];
  const sound = clip.mediaKind === 'audio' || (clip.mediaKind === 'video' && clip.hasAudio) ? clip : (linked.find(c => c.type === 'media' && c.mediaKind === 'audio') as MediaClip | undefined);
  const project = useStore(s => s.project!);
  const name = clip.src.split(/[\\/]/).pop() ?? clip.src;
  const soundTrack = sound ? project.tracks.find(t => t.id === sound.trackId) : undefined;
  const missing = useStore(s => s.missingMedia.includes(clip.src));
  return (
    <>
      <Section title={MEDIA_KIND_LABEL[clip.mediaKind]}>
        {missing && (
          <Banner
            status="warning"
            title="この素材のファイルが見つかりません"
            description="動かしたか、名前を変えたか、消したときに起こります。"
            endContent={<Button size="sm" label="場所を選び直す" onClick={() => setState({mediaOpen: true})} />}
          />
        )}
        <Text type="body" maxLines={2} wordBreak="break-all">
          {name}
        </Text>
        <Text type="supporting" hasTabularNumbers>
          {framesToTimecode(clip.start, fps)} から 長さ {framesToTimecode(clip.duration, fps)}
          {clip.inPoint > 0 ? `（素材の ${framesToTimecode(clip.inPoint, fps)} から）` : ''}
        </Text>
        {clip.mediaKind === 'video' && proxy && !proxy.url && !proxy.error && <ProgressBar label="プレビュー用の動画を作っています" value={proxy.ratio * 100} hasValueLabel />}
        {proxy?.error && <Text type="supporting">プレビューを用意できませんでした（書き出しには影響しません）</Text>}
        <HStack gap={2} wrap="wrap">
          <Button
            label="再生位置で分ける"
            icon={<Icon icon={Scissors} />}
            onClick={() => {
              if (!splitClip(clip.id, getState().playhead)) notify('再生位置をこの素材の上に動かしてください');
            }}
          />
          {clip.mediaKind === 'video' && (
            <Button
              label="場面ごとに分ける"
              variant="ghost"
              tooltip="映像が大きく変わるところを見つけて、そこで分けます"
              onClick={() => {
                void splitAtScenes(clip.id)
                  .then(n => notify(n ? `${n} か所で分けました` : '場面の変わり目が見つかりませんでした'))
                  .catch(e => notify(String(e), 'error'));
              }}
            />
          )}
          {canSeparate(project, clip) && <Button label="音声を分離" variant="ghost" icon={<Icon icon={Unlink} />} onClick={() => separateClip(clip.id)} />}
          {canMerge(project, clip) && <Button label="映像と音声をまとめる" variant="ghost" icon={<Icon icon={Link2} />} onClick={() => mergeClip(clip.id)} />}
          <Button label="削除" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => deleteClips([clip.id, ...linked.map(c => c.id)])} />
        </HStack>
        {linked.length > 0 && <Text type="supporting">{clip.mediaKind === 'audio' ? '映像とリンクしています（一緒に動きます）' : '音声とリンクしています（一緒に動きます）'}</Text>}
      </Section>
      <Divider />
      {clip.mediaKind !== 'image' && <SpeedSection clip={clip} notify={notify} />}
      {clip.mediaKind !== 'image' && <Divider />}
      {clip.mediaKind !== 'audio' && <CutoutSection clip={clip} />}
      {clip.mediaKind !== 'audio' && <Divider />}
      {clip.mediaKind !== 'audio' && <RemoveBackgroundSection clip={clip} />}
      {clip.mediaKind !== 'audio' && <Divider />}
      {clip.mediaKind !== 'audio' && <AutoReframeSection clip={clip} notify={notify} />}
      {clip.mediaKind !== 'audio' && <Divider />}
      {(clip.mediaKind === 'audio' || clip.hasAudio) && <AutoCaptionSection clip={clip} notify={notify} />}
      {(clip.mediaKind === 'audio' || clip.hasAudio) && <Divider />}
      {(clip.mediaKind === 'audio' || clip.hasAudio) && <SilenceCutSection clip={clip} notify={notify} />}
      {(clip.mediaKind === 'audio' || clip.hasAudio) && <Divider />}
      {clip.mediaKind !== 'audio' && <LookEditor clip={clip} />}
      {sound && (
        <Section title="音">
          <Slider
            label="音量"
            value={sound.volume}
            min={0}
            max={2}
            step={0.05}
            valueDisplay="text"
            formatValue={v => `${Math.round(v * 100)}%`}
            onChange={(volume: number) => updateClip(sound.id, {volume})}
          />
          <SoundFadeFields clip={sound} />
          <SoundFxFields clip={sound} notify={notify} />
          {/* BGM の自動音量下げ（レイヤーごとの設定。レイヤーのメニューと同じもの） */}
          {soundTrack && (
            <>
              <Switch
                label="セリフの間は音を下げる"
                description={`${trackCode(project, soundTrack.id)} の音すべてに効きます。BGM がセリフの邪魔になりません`}
                value={soundTrack.duck}
                onChange={duck => updateTrack(soundTrack.id, {duck})}
                labelPosition="start"
                labelSpacing="spread"
                width="100%"
              />
              {soundTrack.duck && (
                <Slider
                  label="下げたときの音量"
                  value={soundTrack.duckLevel}
                  min={0}
                  max={0.9}
                  step={0.05}
                  valueDisplay="text"
                  formatValue={v => `${Math.round(v * 100)}%`}
                  onChange={(duckLevel: number) => updateTrack(soundTrack.id, {duckLevel})}
                />
              )}
            </>
          )}
        </Section>
      )}
    </>
  );
}

/** キャラクターの立ち絵（PSD だけ）。タイムラインには「立ち絵アイテム」として置く */
export function PortraitSection({character}: {character: Character}) {
  const pt = character.portrait;
  const projectHeight = useStore(s => s.project?.video.height ?? 1080);
  const items = useStore(s => s.project!.clips.filter(c => c.type === 'portrait' && c.characterId === character.id).length);
  if (!pt?.psd) {
    return (
      <Section title="立ち絵">
        {pt && <Banner status="warning" title="PNG の立ち絵は使えなくなりました" description="立ち絵は PSD だけに対応しています。PSD を読み込み直してください。" />}
        <Text type="supporting">PSD を読み込むと、パーツ（PSD のレイヤー）の表示を切り替えて口パク・目パチ・表情が付きます。タイムラインに「立ち絵アイテム」を置いた間だけ表示されます。</Text>
        <HStack gap={2} wrap="wrap">
          <Button label="PSD を読み込む" variant="primary" icon={<Icon icon={FileImage} />} onClick={() => void pickPsdPortrait(character, projectHeight)} />
          {pt && <Button label="立ち絵を外す" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => setPortrait(character.id, null)} />}
        </HStack>
      </Section>
    );
  }
  const setPt = (patch: Partial<Portrait>) => setPortrait(character.id, {...pt, ...patch});
  return (
    <Section title="立ち絵（PSD）">
      <HStack gap={2} vAlign="center" hAlign="between">
        <Text type="supporting">タイムラインの立ち絵アイテム：{items} 個</Text>
        <Button label="立ち絵アイテムを追加" size="sm" icon={<Icon icon={Plus} />} tooltip="再生位置に置きます" onClick={() => addPortraitItem(character.id)} />
      </HStack>
      <Switch label="表示する" value={pt.visible} onChange={visible => setPt({visible})} labelPosition="start" labelSpacing="spread" width="100%" />
      <Switch
        label="喋っているときだけ表示（初期値）"
        description="新しく置く立ち絵アイテムの初期値です。アイテムごとにも変えられます"
        value={!!pt.onlyWhileSpeaking}
        isDisabled={!pt.visible}
        onChange={onlyWhileSpeaking => setPt({onlyWhileSpeaking})}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      <Switch
        label="呼吸する"
        description="しゃべっていない間も、足もとを止めたまま縦にゆっくり伸び縮みします（書き出しも同じ）"
        value={!!pt.breath}
        isDisabled={!pt.visible}
        onChange={on => setPt({breath: on ? {amount: 1.5, period: 3} : null})}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      {pt.breath && (
        <>
          <Slider
            label="呼吸の大きさ"
            value={pt.breath.amount}
            min={0.5}
            max={6}
            step={0.1}
            valueDisplay="text"
            formatValue={v => `${v.toFixed(1)}%`}
            onChange={(amount: number) => setPt({breath: {...pt.breath!, amount}})}
          />
          <Slider
            label="呼吸の速さ"
            description="1 分間に呼吸する回数"
            value={Math.round(60 / pt.breath.period)}
            min={8}
            max={60}
            step={1}
            valueDisplay="text"
            formatValue={v => `${v} 回`}
            onChange={(n: number) => setPt({breath: {...pt.breath!, period: 60 / n}})}
          />
        </>
      )}
      <Switch
        label="声に合わせて弾む"
        description="口が開いている間、足もとを止めたまま縦に伸びます（半開きは半分。書き出しも同じ）"
        value={!!pt.talk}
        isDisabled={!pt.visible}
        onChange={on => setPt({talk: on ? 4 : null})}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      {!!pt.talk && (
        <Slider
          label="弾む大きさ"
          value={pt.talk}
          min={1}
          max={15}
          step={0.5}
          valueDisplay="text"
          formatValue={v => `${v.toFixed(1)}%`}
          onChange={(talk: number) => setPt({talk})}
        />
      )}
      {!!pt.talk && (
        <Selector
          label="弾み方"
          value={pt.talkHop ? 'hop' : 'stretch'}
          options={[
            {value: 'stretch', label: '縦に伸びる（足もとは動かさない）'},
            {value: 'hop', label: '上へ跳ねる（形は変えない）'},
          ]}
          onChange={(v: string) => setPt({talkHop: v === 'hop'})}
          width="100%"
        />
      )}
      <PsdPortraitEditor character={character} />
      <Heading level={4}>新しく置く立ち絵アイテムの位置と大きさ</Heading>
      <TransformFields value={pt.transform} onChange={transform => setPt({transform})} />
      <Button label="立ち絵を外す" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => setPortrait(character.id, null)} />
    </Section>
  );
}

/** 立ち絵アイテムを選んだとき */
function PortraitItemInspector({clip}: {clip: PortraitClip}) {
  const project = useStore(s => s.project)!;
  const fps = project.video.fps;
  const ch = project.characters.find(c => c.id === clip.characterId);
  const usable = project.characters.filter(c => c.portrait?.psd);
  return (
    <>
      <Section title="立ち絵アイテム">
        <Selector
          label="キャラクター"
          value={clip.characterId}
          options={usable.map(c => ({value: c.id, label: c.name}))}
          onChange={v => updateClip(clip.id, {characterId: v} as Partial<PortraitClip>)}
          width="100%"
        />
        {!ch?.portrait?.psd && <Banner status="warning" title="このキャラクターには PSD 立ち絵がありません" description="キャラクターの編集の「立ち絵」で PSD を読み込んでください。" />}
        {ch?.portrait && (ch.portrait.expressions?.length ?? 0) > 0 && (
          <Selector
            label="既定の表情"
            description="セリフで表情を選んでいない間の表情。セリフの「表情」で、その行だけ変えられます"
            value={clip.expression ?? ''}
            options={[{value: '', label: '通常'}, ...ch.portrait.expressions.map(e => ({value: e.name, label: e.name}))]}
            onChange={v => updateClip(clip.id, {expression: v || null} as Partial<PortraitClip>)}
            width="100%"
          />
        )}
        {ch?.portrait && (
          <Switch
            label="喋っているときだけ表示"
            description="このアイテムの間のうち、このキャラクターのセリフの間だけ出します"
            value={clip.onlyWhileSpeaking ?? !!ch.portrait.onlyWhileSpeaking}
            onChange={onlyWhileSpeaking => updateClip(clip.id, {onlyWhileSpeaking} as Partial<PortraitClip>)}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
          />
        )}
        <Text type="supporting" hasTabularNumbers>
          {framesToTimecode(clip.start, fps)} から 長さ {framesToTimecode(clip.duration, fps)}
        </Text>
        <HStack gap={2} wrap="wrap">
          <Button
            label="立ち絵の設定…"
            variant="secondary"
            tooltip="PSD の表示・目と口・表情（キャラクターの編集）"
            onClick={() => setState({dialogCharacterId: clip.characterId, inspectorTab: 'portrait', characterDialogOpen: true})}
          />
          <Button label="削除" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => deleteClip(clip.id)} />
        </HStack>
      </Section>
      <Divider />
      <Section title="位置と大きさ">
        <TransformFields value={clip.transform} onChange={transform => updateClip(clip.id, {transform} as Partial<PortraitClip>)} />
      </Section>
    </>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Windows に最初から入っている和文フォント（書き出しの ASS 字幕でもこの名前で探す） */
export const FONTS: [string, string][] = [
  ['Yu Gothic UI', '游ゴシック UI（標準）'],
  ['Yu Gothic', '游ゴシック'],
  ['Meiryo', 'メイリオ'],
  ['BIZ UDPGothic', 'BIZ UDP ゴシック（読みやすい）'],
  ['UD Digi Kyokasho NK-B', 'UD デジタル 教科書体（太）'],
  ['Yu Mincho', '游明朝'],
  ['MS Gothic', 'ＭＳ ゴシック'],
];
const fontOptions = (current: string) => {
  const list = FONTS.map(([value, label]) => ({value, label}));
  return list.some(o => o.value === current) ? list : [{value: current, label: current}, ...list];
};

/** 色の四角（押すと OS の色選択が開く） */
export function ColorSwatchInput({label, value, onChange}: {label: string; value: string; onChange: (v: string) => void}) {
  return (
    <label className="vx-color-swatch" style={{background: HEX.test(value) ? value : '#000'}} title={label}>
      <input type="color" aria-label={label} value={HEX.test(value) ? value : '#000000'} onChange={e => onChange(e.target.value.toUpperCase())} />
    </label>
  );
}

/** 色：四角で選ぶか、#RRGGBB を打つ */
function ColorField({label, value, onChange, isLabelHidden}: {label: string; value: string; onChange: (v: string) => void; isLabelHidden?: boolean}) {
  return (
    <HStack gap={2} vAlign="end">
      <ColorSwatchInput label={`${label}を選ぶ`} value={value} onChange={onChange} />
      <div style={{flex: 1}}>
        <TextInput label={label} isLabelHidden={isLabelHidden} value={value} onChange={onChange} status={HEX.test(value) ? undefined : {type: 'error', message: '#RRGGBB の形で入力してください'}} />
      </div>
    </HStack>
  );
}

/** キャラクターの声：ソフト・話者・調声・セリフ後の余韻・声のプリセット（プロパティとキャラクター設定ウィンドウで使う） */
/** 声を試しに聞く（今の声と調声で、短い文を合成して鳴らす） */
function VoiceAudition({character}: {character: Character}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fallback = `こんにちは。${character.name}です。よろしくお願いします。`;
  const listen = async () => {
    setBusy(true);
    try {
      await previewVoice(getNotify(), character.id, text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <HStack gap={2} vAlign="end">
      <div style={{flex: 1, minWidth: 0}}>
        <TextInput
          label="試しに読ませる文"
          value={text}
          placeholder={fallback}
          onChange={setText}
          onKeyDown={e => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault();
              void listen();
            }
          }}
        />
      </div>
      <Button label={busy ? '合成しています…' : '声を聞く'} icon={<Icon icon={Volume2} />} isDisabled={busy} onClick={() => void listen()} />
    </HStack>
  );
}

export function CharacterVoiceTab({character}: {character: Character}) {
  const update = (patch: Partial<Character>) => updateCharacter(character.id, patch);
  const setVoice = (patch: Partial<Character['voice']>) => update({voice: {...character.voice, ...patch}});
  const allVoices = useStore(s => s.voices);
  const missing = isSpeakerMissing(character.voice, allVoices);
  // 声：YMM4 と同じく「ソフト / 話者」を 1 つの一覧から選ぶ
  const SEP = '\u0001';
  const engines = Object.keys(ENGINE_LABEL) as EngineId[];
  useEffect(() => {
    for (const e of engines) if (!getState().voices[e]) void loadVoices(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const options = engines.flatMap(e => (allVoices[e] ?? []).map(v => ({value: `${e}${SEP}${v.speaker}`, label: `${ENGINE_LABEL[e]} / ${v.displayName}`})));
  const current = `${character.voice.engine}${SEP}${character.voice.speaker}`;
  if (!options.some(o => o.value === current)) {
    options.unshift({value: current, label: `${ENGINE_LABEL[character.voice.engine]} / ${character.voice.speaker || '話者未設定'}${missing ? '（入っていません）' : ''}`});
  }
  return (
    <>
      <Section title="声">
        <Selector
          label="使う声"
          description="音声合成ソフトと話者。使えるソフトの話者だけが並びます（設定でソフトの場所を選ぶと増えます）"
          value={current}
          options={options}
          hasSearch
          onChange={v => {
            const [engine, speaker] = v.split(SEP);
            setVoice({engine: engine as EngineId, speaker});
          }}
          width="100%"
        />
        <VoiceAudition character={character} />
        {character.voice.engine === 'voicevox' && <Text type="supporting">VOICEVOX を起動しておくと使えます。動画には「VOICEVOX:キャラクター名」の表記が必要です（書き出し画面に出ます）。</Text>}
        {missing && <Banner status="warning" title="この話者はこのPCに入っていません" description={`${ENGINE_LABEL[character.voice.engine]} に入っている話者を選び直してください`} />}
        <VoiceTuner voice={character.voice} value={character.voice.params} onChange={params => setVoice({params})} />
        <NumberInput
          label="セリフ後の余韻"
          units="フレーム"
          description="読み終えてから字幕が消えるまで。新しく追加するセリフに使います"
          value={character.gapAfter ?? 6}
          min={0}
          max={600}
          onChange={v => update({gapAfter: v})}
        />
      </Section>
      <Divider />
      <PresetManager character={character} />
    </>
  );
}

/** キャラクターの字幕（位置・出し方・フォント・色） */
export function CharacterSubtitleTab({character}: {character: Character}) {
  const update = (patch: Partial<Character>) => updateCharacter(character.id, patch);
  return (
    <Section title="字幕">
      <Selector
        label="位置"
        value={character.subtitle.position}
        options={[
          {value: 'bottom', label: '下'},
          {value: 'middle', label: '中央'},
          {value: 'top', label: '上'},
        ]}
        onChange={v =>
          update({
            subtitle: {
              ...character.subtitle,
              position: v as Character['subtitle']['position'],
            },
          })
        }
        width="100%"
      />
      <Selector
        label="出し方"
        value={character.subtitle.animation}
        options={(Object.keys(ANIMATION_LABEL) as SubtitleAnimation[]).map(a => ({value: a, label: ANIMATION_LABEL[a]}))}
        onChange={v =>
          update({
            subtitle: {
              ...character.subtitle,
              animation: v as SubtitleAnimation,
            },
          })
        }
        width="100%"
      />
      {character.subtitle.animation === 'karaoke' && (
        <ColorRow label="カラオケで塗る色" value={character.subtitle.karaokeColor || KARAOKE_COLOR} onChange={karaokeColor => update({subtitle: {...character.subtitle, karaokeColor}})} />
      )}
      <Selector
        label="フォント"
        description="書き出した動画でも同じフォントを使います（この PC に入っているもの）"
        value={character.subtitle.fontFamily}
        options={fontOptions(character.subtitle.fontFamily)}
        hasSearch
        onChange={v => update({subtitle: {...character.subtitle, fontFamily: v}})}
        width="100%"
      />
      <HStack gap={2}>
        <NumberInput label="文字の大きさ" units="px" value={character.subtitle.fontSize} min={12} max={200} onChange={v => update({subtitle: {...character.subtitle, fontSize: v}})} />
        <NumberInput
          label="縁取り"
          units="px"
          value={character.subtitle.outlineWidth}
          min={0}
          max={20}
          onChange={v =>
            update({
              subtitle: {...character.subtitle, outlineWidth: v},
            })
          }
        />
        <NumberInput label="上下の余白" units="px" value={character.subtitle.marginV} min={0} max={1000} onChange={v => update({subtitle: {...character.subtitle, marginV: v}})} />
      </HStack>
      <ColorField label="文字の色" value={character.subtitle.color} onChange={color => update({subtitle: {...character.subtitle, color}})} />
      <ColorField label="縁の色" value={character.subtitle.outlineColor} onChange={outlineColor => update({subtitle: {...character.subtitle, outlineColor}})} />
      <NumberInput
        label="1 行の文字数"
        units="文字"
        description="これより長い字幕は改行します（半角は約半分と数えます）。0 なら画面の幅いっぱいで改行します。句読点が行の頭に来ないよう調整します"
        value={character.subtitle.maxChars ?? 0}
        min={0}
        max={80}
        onChange={maxChars => update({subtitle: {...character.subtitle, maxChars}})}
      />
      <SubtitleDeco character={character} />
    </Section>
  );
}

/** 字幕の影と帯（書き出しの ASS でも描ける飾りだけ） */
/** 選んだセリフのうち長いものを、文の終わり・読点で分ける */
function SplitLongLines({notify}: {notify: Notify}) {
  const [max, setMax] = useState(30);
  return (
    <HStack gap={2} vAlign="end">
      <div style={{width: 160}}>
        <NumberInput label="1 行の文字数" units="文字" value={max} min={8} max={200} onChange={v => setMax(Math.max(8, Math.round(v || 30)))} />
      </div>
      <Button
        label="長いセリフを自動で分ける"
        variant="secondary"
        onClick={() => {
          const r = splitLongLinesForSelection(max);
          notify(r.lines ? `${r.lines} 行を分けて、${r.added} 行増えました（声は作り直してください）` : `${max} 文字を超えるセリフがありません`);
        }}
      />
    </HStack>
  );
}

/** 字幕の見た目を名前を付けて保存し、ほかのキャラクターにも使えるようにする（位置・下の余白・1 行の文字数は今のまま） */
function SavedSubtitleStyles({character}: {character: Character}) {
  const list = useSavedSubtitleStyles();
  const [name, setName] = useState('');
  const st = character.subtitle;
  return (
    <VStack gap={2}>
      {list.length > 0 && (
        <HStack gap={2} vAlign="end">
          <div style={{flex: 1}}>
            <Selector
              label="保存した字幕のスタイル"
              value=""
              placeholder="選ぶと見た目が入れ替わります"
              options={list.map(s => ({value: s.id, label: s.name}))}
              onChange={(id: string) => {
                const s = list.find(x => x.id === id);
                if (s) updateCharacter(character.id, {subtitle: applySubtitleStyle(st, s.style)});
              }}
              width="100%"
            />
          </div>
        </HStack>
      )}
      <HStack gap={2} vAlign="end">
        <div style={{flex: 1}}>
          <TextInput label="いまの字幕を保存" placeholder="スタイルの名前" value={name} onChange={setName} />
        </div>
        <Button
          label="保存"
          variant="secondary"
          onClick={() => {
            saveSubtitleStyle(name, st);
            setName('');
          }}
        />
      </HStack>
      {list.length > 0 && (
        <HStack gap={2} wrap="wrap">
          {list.map(s => (
            <Button key={s.id} label={`「${s.name}」を消す`} size="sm" variant="ghost" onClick={() => removeSubtitleStyle(s.id)} />
          ))}
        </HStack>
      )}
    </VStack>
  );
}

function SubtitleDeco({character}: {character: Character}) {
  const st = character.subtitle;
  const set = (patch: Partial<Character['subtitle']>) => updateCharacter(character.id, {subtitle: {...st, ...patch}});
  return (
    <>
      <SavedSubtitleStyles character={character} />
      <Switch
        label="影を付ける"
        value={!!st.shadowColor}
        onChange={on => set({shadowColor: on ? '#000000' : '', shadowOffset: st.shadowOffset ?? 4})}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      {st.shadowColor && (
        <HStack gap={2} vAlign="end">
          <div style={{flex: 1}}>
            <ColorField label="影の色" value={st.shadowColor} onChange={shadowColor => set({shadowColor})} />
          </div>
          <div style={{width: 132}}>
            <NumberInput label="影のずれ" units="px" value={st.shadowOffset ?? 4} min={1} max={40} onChange={shadowOffset => set({shadowOffset})} />
          </div>
        </HStack>
      )}
      <NumberInput label="文字の間隔" units="px" value={st.letterSpacing ?? 0} min={-20} max={60} onChange={letterSpacing => set({letterSpacing})} />
      {!st.boxColor && (
        <>
          <Switch
            label="外側にもう 1 本縁を付ける"
            description="背景が明るくても暗くても読みやすくなります"
            value={!!st.outline2Color && !!st.outline2Width}
            onChange={on => set({outline2Color: on ? st.outline2Color || '#000000' : '', outline2Width: on ? st.outline2Width || 4 : 0})}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
          />
          {!!st.outline2Color && !!st.outline2Width && (
            <HStack gap={2} vAlign="end">
              <div style={{flex: 1}}>
                <ColorField label="外側の縁の色" value={st.outline2Color} onChange={outline2Color => set({outline2Color})} />
              </div>
              <div style={{width: 132}}>
                <NumberInput label="外側の縁の太さ" units="px" value={st.outline2Width} min={1} max={30} onChange={outline2Width => set({outline2Width})} />
              </div>
            </HStack>
          )}
        </>
      )}
      <Switch
        label="文字の後ろに帯を敷く"
        description="帯を敷くと、縁取りの代わりになります"
        value={!!st.boxColor}
        onChange={on => set({boxColor: on ? '#000000' : '', boxOpacity: st.boxOpacity ?? 0.7, boxPadding: st.boxPadding ?? 12})}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
      />
      {st.boxColor && (
        <>
          <ColorField label="帯の色" value={st.boxColor} onChange={boxColor => set({boxColor})} />
          <HStack gap={2}>
            <div style={{flex: 1}}>
              <Slider
                label="帯の不透明度"
                value={st.boxOpacity ?? 1}
                min={0.1}
                max={1}
                step={0.01}
                valueDisplay="text"
                formatValue={v => `${Math.round(v * 100)}%`}
                onChange={(boxOpacity: number) => set({boxOpacity})}
              />
            </div>
            <div style={{width: 132}}>
              <NumberInput label="帯の余白" units="px" value={st.boxPadding ?? 12} min={0} max={80} onChange={boxPadding => set({boxPadding})} />
            </div>
          </HStack>
        </>
      )}
    </>
  );
}

/**
 * 何も選んでいないとき：キャラクターの要約。細かい設定は「キャラクターの編集」ウィンドウにまとめる（入口を 1 つにする）。
 * プレビューで立ち絵を選んだときは、その場で位置と大きさを直せるようにする
 */
function CharacterInspector({character}: {character: Character}) {
  const voices = useStore(s => s.voices);
  const lines = useStore(s => s.project!.clips.filter(c => c.type === 'voice' && c.characterId === character.id).length);
  const tab = useStore(s => s.inspectorTab);
  const open = (t: 'voice' | 'subtitle' | 'portrait') => setState({dialogCharacterId: character.id, inspectorTab: t, characterDialogOpen: true});
  const st = character.subtitle;
  const pt = character.portrait;
  const row = (label: string, value: string, t: 'voice' | 'subtitle' | 'portrait') => (
    <button type="button" className="vx-charsum-row" onClick={() => open(t)} aria-label={`${label}：${value}。押すと${label}の設定を開きます`}>
      <Text type="supporting">{label}</Text>
      <Text type="body" maxLines={1}>
        {value}
      </Text>
    </button>
  );
  return (
    <>
      <Section title="キャラクター">
        <HStack gap={2} vAlign="center">
          <span className="vx-charsum-dot" style={{background: character.color}} aria-hidden />
          <Heading level={3}>{character.name}</Heading>
        </HStack>
        <div className="vx-charsum">
          {row('声', `${ENGINE_LABEL[character.voice.engine]} / ${speakerLabel(character.voice, voices)}`, 'voice')}
          {row('字幕', `${(FONTS.find(([v]) => v === st.fontFamily)?.[1] ?? st.fontFamily).replace('（標準）', '')}・${st.fontSize}`, 'subtitle')}
          {row('立ち絵', pt ? `${pt.psd ? 'PSD' : 'PNG（使えません）'}${!pt.visible ? '（非表示）' : pt.onlyWhileSpeaking ? '（喋っているときだけ）' : ''}` : 'なし', 'portrait')}
          {row('セリフ', `${lines} 行`, 'voice')}
        </div>
        <Button label="キャラクターの編集…" icon={<Icon icon={UserPen} />} onClick={() => open(tab)} />
      </Section>
      {pt?.psd && <Button label="立ち絵アイテムを追加" variant="ghost" icon={<Icon icon={Plus} />} tooltip="再生位置に置きます" onClick={() => addPortraitItem(character.id)} />}
    </>
  );
}

/** 分離した字幕だけを選んだとき */
function CaptionInspector({clip}: {clip: CaptionClip}) {
  const project = useStore(s => s.project)!;
  const voice = project.clips.find(c => c.id === clip.voiceId);
  const fps = project.video.fps;
  const capRef = useRef<HTMLDivElement>(null);
  if (voice?.type !== 'voice') return null;
  const ch = project.characters.find(c => c.id === voice.characterId);
  const linked = !!clip.linkId && clip.linkId === voice.linkId;
  const setCap = (v: string) => updateClip(voice.id, {subtitle: v === voice.text ? null : v} as Partial<VoiceClip>);
  return (
    <Section title={linked ? '字幕（セリフとリンク）' : '字幕'}>
      <Text type="supporting">
        {ch?.name ?? ''} のセリフの字幕です。{linked ? 'セリフと一緒に動きます。' : 'リンクを外しているので、別々に動かせます。'}
      </Text>
      <div ref={capRef}>
        <TextArea label="字幕に出す文" value={voice.subtitle ?? voice.text} rows={3} onChange={setCap} />
      </div>
      <HStack gap={2} hAlign="start">
        <RubyButton host={() => capRef.current} value={voice.subtitle ?? voice.text} onChange={setCap} />
        <SpanButton host={() => capRef.current} value={voice.subtitle ?? voice.text} onChange={setCap} />
      </HStack>
      <Text type="supporting" hasTabularNumbers>
        {framesToTimecode(clip.start, fps)} から 長さ {framesToTimecode(clip.duration, fps)}
      </Text>
      <HStack gap={2} wrap="wrap">
        <Button label="セリフを選ぶ" variant="secondary" onClick={() => setState(s => ({selectedClipId: voice.id, revealSeq: s.revealSeq + 1}))} />
        <Button
          label="キャラクターの字幕設定…"
          variant="secondary"
          tooltip="このキャラクターの字幕すべての見た目（キャラクターの編集）"
          onClick={() => setState({dialogCharacterId: voice.characterId, inspectorTab: 'subtitle', characterDialogOpen: true})}
        />
        {canMerge(project, clip) && <Button label="字幕と音声をまとめる" variant="ghost" icon={<Icon icon={Link2} />} onClick={() => mergeClip(clip.id)} />}
      </HStack>
    </Section>
  );
}

function CaptionInspectorBody({clip}: {clip: CaptionClip}) {
  const voice = useStore(s => s.project!.clips.find(c => c.id === clip.voiceId));
  if (voice?.type !== 'voice') return null;
  return (
    <>
      <Divider />
      <PropGroup id="subtitle" title="字幕設定" summary={voice.subtitleCustom ? '個別に設定（セリフと共通）' : 'キャラクター設定'}>
        <LineSubtitleSettings voice={voice} caption={clip} />
      </PropGroup>
    </>
  );
}

/** 上書きの 1 項目：変えていれば「変更」と ↺（キャラクターの値に戻す）、変えていなければ「キャラクターと同じ」 */
function OverrideRow({label, isSet, onReset, children}: {label: string; isSet: boolean; onReset: () => void; children: React.ReactNode}) {
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <Text type="label">{label}</Text>
        {isSet ? (
          <HStack gap={1} vAlign="center">
            <span className="vx-override-badge">変更</span>
            <IconButton label={`${label}をキャラクターの設定に戻す`} tooltip="キャラクターの設定に戻す" size="sm" variant="ghost" icon={<Icon icon={RotateCcw} />} onClick={onReset} />
          </HStack>
        ) : (
          <Text type="supporting">キャラクターと同じ</Text>
        )}
      </HStack>
      <div data-inherited={!isSet || undefined} className="vx-override-field">
        {children}
      </div>
    </VStack>
  );
}

/** この字幕だけの見た目（キャラクターの字幕の設定を、変えた項目だけ上書き）。キャラクターの字幕設定と同じ項目 */
function CaptionStyleOverride({clip, base}: {clip: CaptionClip; base?: Character['subtitle']}) {
  if (!base) return null;
  const ov: SubtitleOverride = clip.style ?? {};
  const eff = {...base, ...ov};
  const save = (next: SubtitleOverride) => updateClip(clip.id, {style: Object.keys(next).length ? next : null} as Partial<CaptionClip>);
  const set = (patch: SubtitleOverride) => save({...ov, ...patch});
  const reset = (k: keyof SubtitleOverride) => {
    const next = {...ov};
    delete next[k];
    save(next);
  };
  const changed = Object.keys(ov).length;
  return (
    <Collapsible defaultIsOpen={changed > 0} trigger={<Text type="label">{changed ? `この字幕だけの見た目（${changed} 項目を変更）` : 'この字幕だけ見た目を変える'}</Text>}>
      <VStack gap={3} paddingBlockStart={2}>
        <OverrideRow label="位置" isSet={ov.position !== undefined} onReset={() => reset('position')}>
          <Selector
            label="位置"
            isLabelHidden
            value={eff.position}
            options={[
              {value: 'bottom', label: '下'},
              {value: 'middle', label: '中央'},
              {value: 'top', label: '上'},
            ]}
            onChange={v => set({position: v as Character['subtitle']['position']})}
            width="100%"
          />
        </OverrideRow>
        <OverrideRow label="出し方" isSet={ov.animation !== undefined} onReset={() => reset('animation')}>
          <Selector
            label="出し方"
            isLabelHidden
            value={eff.animation}
            options={(Object.keys(ANIMATION_LABEL) as SubtitleAnimation[]).map(a => ({value: a, label: ANIMATION_LABEL[a]}))}
            onChange={v => set({animation: v as SubtitleAnimation})}
            width="100%"
          />
        </OverrideRow>
        <OverrideRow label="フォント" isSet={ov.fontFamily !== undefined} onReset={() => reset('fontFamily')}>
          <Selector label="フォント" isLabelHidden value={eff.fontFamily} options={fontOptions(eff.fontFamily)} hasSearch onChange={v => set({fontFamily: v})} width="100%" />
        </OverrideRow>
        <OverrideRow label="文字の大きさ" isSet={ov.fontSize !== undefined} onReset={() => reset('fontSize')}>
          <NumberInput label="文字の大きさ" units="px" isLabelHidden value={eff.fontSize} min={12} max={200} onChange={fontSize => set({fontSize})} />
        </OverrideRow>
        <OverrideRow label="縁取り" isSet={ov.outlineWidth !== undefined} onReset={() => reset('outlineWidth')}>
          <NumberInput label="縁取り" units="px" isLabelHidden value={eff.outlineWidth} min={0} max={20} onChange={outlineWidth => set({outlineWidth})} />
        </OverrideRow>
        <OverrideRow label="上下の余白" isSet={ov.marginV !== undefined} onReset={() => reset('marginV')}>
          <NumberInput label="上下の余白" units="px" isLabelHidden value={eff.marginV} min={0} max={1000} onChange={marginV => set({marginV})} />
        </OverrideRow>
        <OverrideRow label="文字の色" isSet={ov.color !== undefined} onReset={() => reset('color')}>
          <ColorField label="文字の色" isLabelHidden value={eff.color} onChange={color => set({color})} />
        </OverrideRow>
        <OverrideRow label="縁の色" isSet={ov.outlineColor !== undefined} onReset={() => reset('outlineColor')}>
          <ColorField label="縁の色" isLabelHidden value={eff.outlineColor} onChange={outlineColor => set({outlineColor})} />
        </OverrideRow>
        {changed > 0 && <Button label="すべてキャラクターの設定に戻す" variant="ghost" icon={<Icon icon={RotateCcw} />} onClick={() => save({})} />}
      </VStack>
    </Collapsible>
  );
}

/** 複数選んでいるとき：まとめてできること */
function MultiInspector({ids, notify}: {ids: string[]; notify: Notify}) {
  const project = useStore(s => s.project)!;
  const clips = project.clips.filter(c => ids.includes(c.id));
  const lines = clips.filter((c): c is VoiceClip => c.type === 'voice');
  const fps = project.video.fps;
  const start = Math.min(...clips.map(c => c.start));
  const end = Math.max(...clips.map(c => c.start + c.duration));
  const sameCh = lines.length && lines.every(l => l.characterId === lines[0].characterId) ? project.characters.find(c => c.id === lines[0].characterId) : undefined;
  return (
    <Section title={`${clips.length} 個を選んでいます`}>
      <Text type="supporting" hasTabularNumbers>
        セリフ {lines.length} 行・素材 {clips.length - lines.length} 個（
        {framesToTimecode(start, fps)} 〜 {framesToTimecode(end, fps)}）
      </Text>
      {(() => {
        const vis = clips.filter(c => c.type === 'media' && c.mediaKind !== 'audio').length;
        if (vis < 2) return null;
        const lays = SPLIT_LAYOUTS.filter(l => l.cells.length === Math.min(4, vis));
        return (
          <VStack gap={2}>
            <Text type="label">分割画面</Text>
            <Text type="supporting">
              選んだ動画・画像を、マスいっぱいに並べます（上のレイヤーから順に。時間は変えません。{vis > 4 ? '5 つ目からは使いません' : '同じ時間に見えるよう、別々のレイヤーに置いてください'}）
            </Text>
            <HStack gap={2} wrap="wrap">
              {lays.map(l => (
                <Button
                  key={l.id}
                  size="sm"
                  variant="secondary"
                  label={l.label}
                  onClick={() => void applySplitLayout(ids, l.id).then(n => notify(n ? `${n} 個を「${l.label}」に並べました` : '並べられませんでした'))}
                />
              ))}
            </HStack>
          </VStack>
        );
      })()}
      {lines.length > 0 && (
        <Selector
          label="セリフのキャラクターをまとめて変える"
          value={lines.every(l => l.characterId === lines[0].characterId) ? lines[0].characterId : ''}
          placeholder="キャラクターを選ぶ"
          options={project.characters.map(c => ({
            value: c.id,
            label: c.name,
          }))}
          onChange={v => setCharacterForSelection(v)}
          width="100%"
        />
      )}
      {sameCh && (sameCh.voicePresets ?? []).length > 0 && (
        <Selector
          label="声のプリセットをまとめて変える"
          value={lines.every(l => (l.presetId ?? '') === (lines[0].presetId ?? '')) ? (lines[0].presetId ?? '') : '__mixed'}
          options={[
            ...(lines.some(l => (l.presetId ?? '') !== (lines[0].presetId ?? '')) ? [{value: '__mixed', label: 'いろいろ'}] : []),
            {value: '', label: 'キャラクターの声（標準）'},
            ...(sameCh.voicePresets ?? []).map(p => ({value: p.id, label: p.name})),
          ]}
          description="行だけの調声は外れます"
          onChange={v => {
            if (v === '__mixed') return;
            const n = setPresetForSelection(sameCh.id, v || null);
            notify(`${n} 行の声を「${v ? sameCh.voicePresets!.find(p => p.id === v)!.name : 'キャラクターの声'}」にしました`);
          }}
          width="100%"
        />
      )}
      {sameCh?.portrait?.psd && (sameCh.portrait.expressions ?? []).length > 0 && (
        <Selector
          label="表情をまとめて変える"
          value={lines.every(l => (l.expression ?? '') === (lines[0].expression ?? '')) ? (lines[0].expression ?? '') : '__mixed'}
          options={[
            ...(lines.some(l => (l.expression ?? '') !== (lines[0].expression ?? '')) ? [{value: '__mixed', label: 'いろいろ'}] : []),
            {value: '', label: '変えない'},
            {value: BASE_EXPRESSION, label: '通常'},
            ...(sameCh.portrait.expressions ?? []).map(e => ({value: e.name, label: e.name})),
          ]}
          onChange={v => {
            if (v === '__mixed') return;
            const n = setExpressionForSelection(v || null);
            notify(`${n} 行の表情を「${v === BASE_EXPRESSION ? '通常' : v || '変えない'}」にしました`);
          }}
          width="100%"
        />
      )}
      {sameCh?.portrait?.psd && (sameCh.portrait.expressions ?? []).length > 0 && (
        <Button
          label="セリフの感情から表情を付ける"
          variant="secondary"
          onClick={() => {
            const r = autoExpressionsForSelection();
            notify(
              r.set
                ? `${r.set} 行に表情を付けました${r.skipped ? `（${r.skipped} 行は感情が決まらないか、合う表情がありません）` : ''}`
                : '付けられる行がありません。表情の名前に「笑」「怒」「悲」「驚」などを入れると、感情に合わせて選べます',
            );
          }}
        />
      )}
      {lines.length > 0 && <SplitLongLines notify={notify} />}
      {lines.length > 0 && (
        <NumberInput
          label="セリフの後ろの間をまとめて変える"
          units="フレーム"
          value={lines.every(l => l.gapAfter === lines[0].gapAfter) ? lines[0].gapAfter : null}
          placeholder="いろいろ"
          min={0}
          max={fps * 10}
          onChange={v => {
            if (v === null || v === undefined || Number.isNaN(v)) return;
            const n = setGapForSelection(v);
            notify(`${n} 行の後ろの間を ${v} フレームにしました`);
          }}
          width="100%"
        />
      )}
      <HStack gap={2} wrap="wrap">
        {lines.length > 0 && (
          <Button
            label="選んだ行を合成"
            icon={<Icon icon={AudioLines} />}
            onClick={() =>
              void synthesize(
                notify,
                lines.map(l => l.id),
              )
            }
          />
        )}
        <Button label="複製" variant="ghost" icon={<Icon icon={Copy} />} onClick={() => duplicateSelection()} />
        <Button label="削除" variant="ghost" icon={<Icon icon={Trash2} />} onClick={() => deleteClips(editableSelection().map(c => c.id))} />
      </HStack>
      <Hint>Ctrl+C で写す・Ctrl+V で貼る・Ctrl+D で複製。Alt+←→ でまとめて動かせます。</Hint>
    </Section>
  );
}

export function Inspector({notify}: {notify: Notify}) {
  const project = useStore(s => s.project);
  const selectedClipId = useStore(s => s.selectedClipId);
  const selectedCharacterId = useStore(s => s.selectedCharacterId);
  const multi = useStore(s => s.selectedClipIds);
  if (!project) return null;
  // リンクしたクリップ（セリフと字幕、映像と音声）は 1 つとして数える。字幕を選んだらセリフの設定を出す
  const sel = project.clips.find(c => c.id === selectedClipId);
  const units = new Set(
    project.clips
      .filter(c => multi.includes(c.id))
      .map(c => lineOf(project, c)!)
      .map(c => c.linkId ?? c.id),
  );
  if (units.size > 1)
    return (
      <MultiInspector
        ids={[
          ...new Set(
            multi.map(
              id =>
                lineOf(
                  project,
                  project.clips.find(c => c.id === id),
                )?.id ?? id,
            ),
          ),
        ]}
        notify={notify}
      />
    );
  // 字幕だけを選んだとき（Alt+クリック・リンク解除後）は、字幕の設定を出す
  // 字幕をクリックしたら（リンクしたセリフも一緒に選ばれていても）、字幕の設定を出す。セリフの設定へは「セリフを選ぶ」で
  if (sel?.type === 'caption')
    return (
      <Fragment key={sel.id}>
        <CaptionInspector clip={sel} />
        <CaptionInspectorBody clip={sel} />
      </Fragment>
    );
  const clip = lineOf(project, sel);
  if (clip?.type === 'voice') return <ClipInspector key={clip.id} clip={clip} notify={notify} />;
  if (clip?.type === 'media') return <MediaInspector key={clip.id} clip={clip} notify={notify} />;
  if (clip?.type === 'portrait') return <PortraitItemInspector key={clip.id} clip={clip} />;
  if (clip?.type === 'text') return <TextInspector key={clip.id} clip={clip} />;
  if (clip?.type === 'shape') return <ShapeInspector key={clip.id} clip={clip} />;
  const ch = project.characters.find(c => c.id === selectedCharacterId);
  if (ch) return <CharacterInspector key={ch.id} character={ch} />;
  return (
    <VStack padding={4} gap={4}>
      {/* 何も選んでいないときは、プロジェクトのあらましを主役に。選び方の案内は 1 行だけ */}
      <ProjectSummary project={project} notify={notify} />
      <HStack gap={2} vAlign="center">
        <Icon icon={MousePointerClick} size="sm" color="secondary" />
        <Text type="supporting">タイムラインのアイテムか、「キャラクター」タブの人物を選ぶと、ここに設定が出ます</Text>
      </HStack>
    </VStack>
  );
}

/** 何も選んでいないときに出す、プロジェクトのあらまし（長さ・大きさ・セリフの数・未合成） */
function ProjectSummary({project, notify}: {project: Project; notify: Notify}) {
  const synthStatus = useStore(s => s.synthStatus);
  const errors = useStore(s => s.synthErrors);
  const lines = project.clips.filter((c): c is VoiceClip => c.type === 'voice');
  const pending = lines.filter(c => !c.audio && c.text.trim() && !synthStatus[c.id]).length;
  const failed = lines.filter(c => errors[c.id]).length;
  const v = project.video;
  // 手当てが要る行（失敗・未合成）を先頭から少しだけ並べ、押すとその行へ
  const todo = lines
    .filter(c => errors[c.id] || (!c.audio && c.text.trim()))
    .sort((x, y) => x.start - y.start)
    .slice(0, 30);
  const nameOf = (id: string) => project.characters.find(c => c.id === id)?.name ?? '';
  const row = (k: string, val: React.ReactNode) => (
    <HStack gap={2} hAlign="between" vAlign="center">
      <Text type="supporting">{k}</Text>
      <Text hasTabularNumbers>{val}</Text>
    </HStack>
  );
  return (
    <Section title="このプロジェクト">
      {row('長さ', framesToTimecode(projectDuration(project), v.fps))}
      {row('大きさ', `${v.width}×${v.height}・${v.fps} fps`)}
      {row('キャラクター', `${project.characters.length} 人`)}
      {row('セリフ', `${lines.length} 行`)}
      {row('未合成', `${pending} 行`)}
      {failed > 0 && row('合成できなかった行', `${failed} 行`)}
      <HStack gap={2} wrap="wrap">
        {pending > 0 && <Button label={`未合成の ${pending} 行を合成`} size="sm" icon={<Icon icon={AudioLines} />} onClick={() => void synthesize(notify)} />}
        <Button label="プロジェクトの設定…" size="sm" variant="secondary" onClick={() => setState({projectSettingsOpen: true})} />
      </HStack>
      {todo.length > 0 && (
        <VStack gap={1}>
          <Text type="label">手当てが要る行（押すとその行へ）</Text>
          {todo.map(c => (
            <button
              key={c.id}
              type="button"
              className="vx-todo-row"
              data-error={errors[c.id] ? true : undefined}
              onClick={() => setState(s => ({selectedClipId: c.id, playhead: c.start, revealSeq: s.revealSeq + 1}))}>
              <span className="vx-todo-tag">{errors[c.id] ? '失敗' : synthStatus[c.id] ? '合成中' : '未合成'}</span>
              <span className="vx-todo-text">
                {nameOf(c.characterId)}：{c.text}
              </span>
            </button>
          ))}
        </VStack>
      )}
    </Section>
  );
}
