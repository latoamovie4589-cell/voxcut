// 書き出し：設定を確かめる → 保存先を選ぶ → 進捗（取り消せる）→ 完了（フォルダを開く）

import {useEffect, useRef, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {MetadataList, MetadataListItem} from '@astryxdesign/core/MetadataList';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {Hint} from '../Hint';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {api, type Encoder, type ExportProgress, type ExportRequest} from '../ipc';
import {collectCredits, framesToTimecode, overlappingLines, projectDuration, timecodeToFrames, ENGINE_LABEL, type Project} from '../model';
import {getState, setState, useStore, type ExportJob} from '../store';
import {cancelExport, exportSubtitles, openFile, pickExportPath, revealInFolder, runExport, type ExportKind} from '../actions';
import {useEngineProblems} from './Sidebar';

/** まとめて書き出したそれぞれの結果 */
type BatchResult = {out: string; ok: boolean; message?: string};
type Phase =
  | {kind: 'batch'; index: number; total: number; out: string; progress: ExportProgress | null; results: BatchResult[]}
  | {kind: 'batchDone'; results: BatchResult[]}
  | {kind: 'setup'}
  | {kind: 'running'; progress: ExportProgress | null}
  | {kind: 'done'; out: string; what: ExportKind}
  | {kind: 'error'; message: string}
  | {kind: 'cancelled'};

let jobSeq = 0;
const jobId = () => `job${Date.now().toString(36)}${jobSeq++}`;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** 予約に足す（同じ保存先のものは新しいほうに置き換える） */
function addJobs(jobs: ExportJob[]) {
  const outs = new Set(jobs.map(j => j.out));
  setState({exportQueue: [...getState().exportQueue.filter(j => !outs.has(j.out)), ...jobs]});
}
const useQueue = () => useStore(s => s.exportQueue);

const KIND_LABEL: Record<ExportKind, string> = {video: '動画', gif: 'GIF', audio: '音声だけ', subtitle: '字幕だけ'};

/** その行を選んで、タイムラインとプロパティで見せる（書き出す前の確認から） */
function goToLine(id: string) {
  const c = getState().project?.clips.find(x => x.id === id);
  if (c) setState(st => ({selectedClipId: c.id, selectedClipIds: [c.id], playhead: c.start, revealSeq: st.revealSeq + 1}));
}

type Span = 'all' | 'selection' | 'custom';

/** 選んでいるアイテムが占める範囲（始まりと終わりのフレーム）。選んでいなければ null */
function selectionRange(p: Project, ids: string[]): [number, number] | null {
  const cs = p.clips.filter(c => ids.includes(c.id));
  if (!cs.length) return null;
  return [Math.min(...cs.map(c => c.start)), Math.max(...cs.map(c => c.start + c.duration))];
}

/** 背景：いつもの MP4 か、透明のまま（MOV / WebM） */
type Backdrop = 'fill' | 'mov' | 'webm';
const BACKDROP: Record<Backdrop, string> = {fill: '背景の色で塗る（MP4）', mov: '透明（MOV・ProRes 4444）', webm: '透明（WebM・VP9）'};

const QUALITY = {high: {crf: 18, label: '高画質'}, normal: {crf: 20, label: '標準'}, light: {crf: 26, label: '軽量'}} as const;
type Quality = keyof typeof QUALITY;

/** 用途から選ぶ：書き出すもの・大きさの上限・画質・音の大きさをまとめて決める */
interface ExportPreset {
  id: string;
  label: string;
  description: string;
  what: ExportKind;
  /** 出力の高さの上限（プロジェクトがこれより小さければそのまま） */
  maxHeight: number;
  quality: Quality;
  loudness: string;
}
const PRESETS: ExportPreset[] = [
  {id: 'youtube', label: 'YouTube などの動画サイト向け', description: '1080 まで・標準の画質・音の大きさを -14 LUFS にそろえます', what: 'video', maxHeight: 1080, quality: 'normal', loudness: '-14'},
  {id: 'sns', label: 'スマホ・SNS 向け（軽め）', description: '720 まで・軽量・音の大きさを -16 LUFS にそろえます。ファイルが小さくなります', what: 'video', maxHeight: 720, quality: 'light', loudness: '-16'},
  {id: 'master', label: '保存・編集用（高画質）', description: 'プロジェクトの大きさのまま・高画質。音はそのままです', what: 'video', maxHeight: 99999, quality: 'high', loudness: 'off'},
  {id: 'gif', label: 'GIF（軽め）', description: '480 まで。短い範囲を選ぶと軽くなります', what: 'gif', maxHeight: 480, quality: 'normal', loudness: 'off'},
  {id: 'audio', label: '音声だけ（動画サイト向けの音量）', description: 'WAV で書き出し、音の大きさを -14 LUFS にそろえます', what: 'audio', maxHeight: 99999, quality: 'normal', loudness: '-14'},
];

const STAGE: Record<ExportProgress['stage'], string> = {
  synth: 'まだの音声を合成しています',
  portrait: '立ち絵を準備しています',
  loudness: '音の大きさを測っています',
  encode: '動画を書き出しています',
};

/** 音の大きさの目標（LUFS）。off ならそのまま */
const LOUDNESS: {value: string; label: string}[] = [
  {value: 'off', label: '調整しない（そのまま）'},
  {value: '-14', label: 'YouTube などの動画サイト向け（-14 LUFS）'},
  {value: '-16', label: 'スマホ・配信向け（-16 LUFS）'},
  {value: '-24', label: 'テレビ放送向け（-24 LUFS）'},
];
const LOUDNESS_KEY = 'voxcut.export.loudness';
const readLoudness = () => {
  try {
    const v = localStorage.getItem(LOUDNESS_KEY);
    return v && LOUDNESS.some(l => l.value === v) ? v : 'off';
  } catch {
    return 'off';
  }
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
  const [what, setWhat] = useState<ExportKind>('video');
  const [span, setSpan] = useState<Span>('all');
  const [backdrop, setBackdrop] = useState<Backdrop>('fill');
  const [loudness, setLoudnessState] = useState<string>(readLoudness);
  const setLoudness = (v: string) => {
    setLoudnessState(v);
    try {
      localStorage.setItem(LOUDNESS_KEY, v);
    } catch {
      // 覚えられなくても書き出しはできる
    }
  };
  const stopRef = useRef(false);
  const queue = useQueue();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const selIds = useStore(s => s.selectedClipIds);
  const errors = useStore(s => s.synthErrors);
  const problems = useEngineProblems();

  useEffect(() => {
    if (!isOpen) return;
    setPhase({kind: 'setup'});
    // 範囲の初期値は、選んでいるアイテムがあればその範囲、なければ全体
    const p = getState().project;
    if (p) {
      const sel = selectionRange(p, getState().selectedClipIds);
      setFrom(framesToTimecode(sel?.[0] ?? 0, p.video.fps));
      setTo(framesToTimecode(sel?.[1] ?? projectDuration(p), p.video.fps));
    }
    void loadEncoders().then(list => {
      setEncoders(list);
      // グラフィックボードが使えるなら、はじめからそれにする（速い）
      setEncoder(e => (list.includes(e) && e !== 'x264' ? e : (list.find(x => x !== 'x264') ?? 'x264')));
    });
  }, [isOpen]);

  if (!project) return null;
  const v = project.video;
  const pending = project.clips.filter(c => c.type === 'voice' && !c.audio && c.text.trim()).length;
  const heights = [v.height, 1080, 720, 480, ...(what === 'gif' ? [360, 240] : [])].filter((h, i, a) => h <= v.height && a.indexOf(h) === i);
  // 用途の「大きさの上限」を、この種類で選べる高さに直す（プロジェクトのままなら 'same'）
  const heightFor = (kind: ExportKind, max: number) => {
    const list = [v.height, 1080, 720, 480, ...(kind === 'gif' ? [360, 240] : [])].filter(h => h <= v.height);
    const h = Math.max(...list.filter(x => x <= max), Math.min(...list));
    return h === v.height ? 'same' : String(h);
  };
  const applyPreset = (id: string) => {
    const pr = PRESETS.find(x => x.id === id);
    if (!pr) return;
    setWhat(pr.what);
    setHeight(heightFor(pr.what, pr.maxHeight));
    setQuality(pr.quality);
    setBackdrop('fill');
    setLoudnessState(pr.loudness);
  };
  // いまの設定がどの用途と同じか（どれとも違えば「自分で選ぶ」）
  const presetNow =
    PRESETS.find(pr => pr.what === what && heightFor(pr.what, pr.maxHeight) === height && backdrop === 'fill' && (what === 'gif' || what === 'audio' || pr.quality === quality) && (what === 'gif' || pr.loudness === loudness))?.id ?? 'custom';
  const sizeLabel = (h: number) => `${Math.round((v.width * h) / v.height / 2) * 2}×${h}`;
  const running = phase.kind === 'running' || phase.kind === 'batch';

  // 書き出す前の確認：失敗した行・止まっている音声合成ソフト・時間の重なり
  const failedIds = project.clips.filter(c => c.type === 'voice' && errors[c.id]).map(c => c.id);
  const overlaps = [...overlappingLines(project)];
  const needsVoice = what !== 'subtitle';
  // 書き出す範囲（字幕だけは全体）
  const total = projectDuration(project);
  const selRange = selectionRange(project, selIds);
  const fromF = timecodeToFrames(from, v.fps);
  const toF = timecodeToFrames(to, v.fps);
  const customBad = fromF === null || toF === null ? '時:分:秒:フレーム の形で入れてください' : toF <= fromF ? '終わりは始まりより後にしてください' : fromF >= total ? '動画の長さより後です' : null;
  const range: [number, number] | null = what === 'subtitle' || span === 'all' ? null : span === 'selection' ? selRange : customBad ? null : [fromF!, Math.min(toF!, total)];
  const rangeBad = what !== 'subtitle' && span !== 'all' && !range;

  const alpha = what === 'video' && backdrop !== 'fill' ? backdrop : undefined;
  const request = (r: [number, number] | null = range): ExportRequest => ({
    crf: QUALITY[quality].crf,
    height: height === 'same' ? null : Number(height),
    encoder,
    ...(loudness !== 'off' && (what === 'video' || what === 'audio') ? {loudness: Number(loudness)} : {}),
    ...(r ? {rangeFrames: r} : {}),
    ...(alpha ? {transparent: true} : {}),
  });
  // 予約の説明（形式と範囲）
  const kindDesc = what === 'video' ? (alpha === 'mov' ? '透明な MOV' : alpha === 'webm' ? '透明な WebM' : 'MP4') : KIND_LABEL[what];
  const spanDesc = (r: [number, number] | null) => (r ? `${framesToTimecode(r[0], v.fps)}〜${framesToTimecode(r[1], v.fps)}` : '全体');
  const markers = [...(project.markers ?? [])].map(m => m.frame).filter(f => f > 0 && f < total);
  // マーカーで区切った範囲（頭から最初のマーカー、マーカーどうしの間、最後のマーカーから終わり）
  const cuts = [...new Set([0, ...markers, total])].sort((a, b) => a - b);
  const pieces = cuts
    .slice(1)
    .map((e, i) => [cuts[i], e] as [number, number])
    .filter(([a, b]) => b - a > 0);

  const enqueue = async () => {
    const out = await pickExportPath(what, alpha);
    if (!out) return;
    const r = what === 'subtitle' ? null : range;
    addJobs([{id: jobId(), out, what, options: request(r), label: what === 'subtitle' ? KIND_LABEL[what] : `${kindDesc}、${spanDesc(r)}`}]);
  };
  // マーカーごとに分けて予約する（選んだ名前に _01・_02… を付ける）
  const enqueueMarkers = async () => {
    const out = await pickExportPath(what, alpha);
    if (!out) return;
    const dot = out.lastIndexOf('.');
    const [stem, ext] = dot > out.lastIndexOf('/') && dot > out.lastIndexOf('\\') ? [out.slice(0, dot), out.slice(dot)] : [out, ''];
    addJobs(pieces.map((r, i) => ({id: jobId(), out: `${stem}_${String(i + 1).padStart(2, '0')}${ext}`, what, options: request(r), label: `${kindDesc}、${spanDesc(r)}`})));
  };

  // 予約を順番に書き出す。失敗したものは飛ばして次へ。取り消したら残りもやめる
  const runQueue = async () => {
    const jobs = getState().exportQueue;
    if (!jobs.length) return;
    stopRef.current = false;
    const results: BatchResult[] = [];
    for (const [i, j] of jobs.entries()) {
      if (stopRef.current) break;
      setPhase({kind: 'batch', index: i, total: jobs.length, out: j.out, progress: null, results: [...results]});
      try {
        if (j.what === 'subtitle') await exportSubtitles(j.out);
        else await runExport(j.out, j.options, p => setPhase({kind: 'batch', index: i, total: jobs.length, out: j.out, progress: p, results: [...results]}));
        results.push({out: j.out, ok: true});
        setState({exportQueue: getState().exportQueue.filter(x => x.id !== j.id)});
      } catch (e) {
        const cancelled = String(e).includes('cancelled');
        if (cancelled) stopRef.current = true;
        results.push({out: j.out, ok: false, message: cancelled ? '取り消しました' : String(e).replace(/^Error:\s*/, '')});
      }
    }
    setPhase({kind: 'batchDone', results});
  };

  const start = async () => {
    const out = await pickExportPath(what, alpha);
    if (!out) return;
    setPhase({kind: 'running', progress: null});
    try {
      if (what === 'subtitle') await exportSubtitles(out);
      else await runExport(out, request(), p => setPhase({kind: 'running', progress: p}));
      setPhase({kind: 'done', out, what});
    } catch (e) {
      setPhase(String(e).includes('cancelled') ? {kind: 'cancelled'} : {kind: 'error', message: String(e).replace(/^Error:\s*/, '')});
    }
  };

  // 書き出し中に閉じようとしたら取り消す
  const close = (open: boolean) => {
    if (!open && running) {
      stopRef.current = true;
      void cancelExport();
    }
    onOpenChange(open);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={close} width={480} maxHeight="92dvh" purpose="form">
      <DialogHeader title="書き出す" onOpenChange={close} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={4} padding={4}>
          {phase.kind === 'setup' && (
            <>
              <VStack gap={1}>
                <Text type="label">書き出すもの</Text>
                <SegmentedControl
                  label="書き出すもの"
                  layout="fill"
                  value={what}
                  onChange={k => {
                    setWhat(k as ExportKind);
                    // GIF は重くなりやすいので、はじめは小さめ
                    setHeight(k === 'gif' && v.height > 480 ? '480' : 'same');
                  }}>
                  {(Object.keys(KIND_LABEL) as ExportKind[]).map(k => (
                    <SegmentedControlItem key={k} value={k} label={KIND_LABEL[k]} />
                  ))}
                </SegmentedControl>
              </VStack>
              <Selector
                label="用途から選ぶ"
                description={PRESETS.find(x => x.id === presetNow)?.description ?? '下の設定を自分で選んでいます'}
                value={presetNow}
                options={[...PRESETS.map(x => ({value: x.id, label: x.label})), {value: 'custom', label: '自分で選ぶ'}]}
                onChange={id => applyPreset(id)}
                width="100%"
              />
              {what !== 'subtitle' && (
                <VStack gap={2}>
                  <Text type="label">書き出す範囲</Text>
                  <SegmentedControl label="書き出す範囲" layout="fill" value={span} onChange={k => setSpan(k as Span)}>
                    <SegmentedControlItem value="all" label="全体" />
                    <SegmentedControlItem value="selection" label="選んだアイテム" isDisabled={!selRange} />
                    <SegmentedControlItem value="custom" label="時刻で指定" />
                  </SegmentedControl>
                  {span === 'selection' && !selRange && <Hint>タイムラインでアイテムを選ぶと、その範囲だけを書き出せます</Hint>}
                  {span === 'custom' && (
                    <HStack gap={2}>
                      <TextInput label="始まり" value={from} onChange={setFrom} status={fromF === null ? {type: 'error', message: '時:分:秒:フレーム'} : undefined} />
                      <TextInput label="終わり" value={to} onChange={setTo} status={customBad && fromF !== null ? {type: 'error', message: customBad} : undefined} />
                    </HStack>
                  )}
                </VStack>
              )}
              <MetadataList>
                <MetadataListItem label="長さ">
                  {range ? `${framesToTimecode(range[1] - range[0], v.fps)}（${framesToTimecode(range[0], v.fps)} から）` : framesToTimecode(total, v.fps)}
                </MetadataListItem>
                <MetadataListItem label="形式">
                  {what === 'video'
                    ? backdrop === 'mov'
                      ? `MOV（ProRes 4444 / PCM・背景が透明）・${v.width}×${v.height}・${v.fps} fps`
                      : backdrop === 'webm'
                        ? `WebM（VP9 / Opus・背景が透明）・${v.width}×${v.height}・${v.fps} fps`
                        : `MP4（H.264 / AAC）・${v.width}×${v.height}・${v.fps} fps`
                    : what === 'gif'
                      ? `GIF（音なし・繰り返し再生・${Math.min(v.fps, 15)} fps）。長いと大きなファイルになるので、範囲を短く選ぶのがおすすめです`
                      : what === 'audio'
                        ? 'WAV（PCM 16bit）'
                        : 'SRT（字幕の文と時刻だけ。見た目は付きません）'}
                </MetadataListItem>
              </MetadataList>
              {/* 書き出す前の確認（直せるものは、その場で直しに行ける） */}
              {needsVoice && problems.length > 0 && pending > 0 && (
                <Banner
                  status="warning"
                  title={`${problems.map(e => ENGINE_LABEL[e]).join('・')} を使えないため、まだの ${pending} 行を合成できません`}
                  description="起動してから書き出すか、設定でソフトの場所を選んでください。"
                  endContent={<Button size="sm" label="音声合成ソフトの設定" onClick={() => setState({settingsOpen: true})} />}
                />
              )}
              {needsVoice && failedIds.length > 0 && (
                <Banner
                  status="error"
                  title={`合成できなかったセリフが ${failedIds.length} 行あります`}
                  description="このまま書き出すと止まります。その行の理由を確かめてください。"
                  endContent={
                    <Button
                      size="sm"
                      label="その行へ"
                      onClick={() => {
                        goToLine(failedIds[0]);
                        close(false);
                      }}
                    />
                  }
                />
              )}
              {overlaps.length > 0 && (
                <Banner
                  status="info"
                  title={`時間が重なっているセリフが ${overlaps.length} 行あります`}
                  description="声が同時に鳴り、字幕も重なります。わざとでなければ直してから書き出してください。"
                  endContent={
                    <Button
                      size="sm"
                      label="その行へ"
                      onClick={() => {
                        goToLine(overlaps[0]);
                        close(false);
                      }}
                    />
                  }
                />
              )}
              {what === 'gif' && (
                <Selector
                  label="大きさ"
                  value={height}
                  options={heights.map(h => ({value: h === v.height ? 'same' : String(h), label: h === v.height ? `${sizeLabel(h)}（プロジェクトのまま）` : sizeLabel(h)}))}
                  onChange={setHeight}
                  width="100%"
                />
              )}
              {what === 'video' && (
                <>
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
                    <Hint>軽量にするとファイルが小さくなり、細かい部分が少し粗くなります</Hint>
                  </VStack>
                  <Selector
                    label="背景"
                    description={backdrop === 'fill' ? undefined : '何も置いていないところは透明になります。ほかの動画に重ねる素材に使えます（MOV はファイルが大きくなります）'}
                    value={backdrop}
                    options={(Object.keys(BACKDROP) as Backdrop[]).map(b => ({value: b, label: BACKDROP[b]}))}
                    onChange={b => setBackdrop(b as Backdrop)}
                    width="100%"
                  />
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
                    isDisabled={!encoders || encoders.length < 2 || backdrop !== 'fill'}
                    options={(encoders ?? ['x264']).map(e => ({value: e, label: ENCODER_LABEL[e]}))}
                    onChange={v => setEncoder(v as Encoder)}
                    width="100%"
                  />
                </>
              )}
              {(what === 'video' || what === 'audio') && (
                <Selector
                  label="音の大きさ"
                  description={loudness === 'off' ? undefined : '書き出す前に全体の大きさを測り、同じ倍率で上げ下げして目標にそろえます（音割れしないよう上限は -1 dB）。測る分、時間が少し長くなります'}
                  value={loudness}
                  options={LOUDNESS}
                  onChange={setLoudness}
                  width="100%"
                />
              )}
              {needsVoice && pending > 0 && !problems.length && <Banner status="info" title={`まだ合成していないセリフが ${pending} 行あります`} description="書き出す前にまとめて合成します" />}
              <Credits />
              <HStack gap={2} hAlign="end" wrap="wrap">
                <Button label="キャンセル" variant="ghost" onClick={() => close(false)} />
                {what !== 'subtitle' && pieces.length > 1 && (
                  <Button label={`マーカーで ${pieces.length} 本に分けて予約…`} variant="ghost" isDisabled={needsVoice && failedIds.length > 0} onClick={() => void enqueueMarkers()} />
                )}
                <Button label="予約に足す…" variant="secondary" isDisabled={(needsVoice && failedIds.length > 0) || rangeBad} onClick={() => void enqueue()} />
                <Button label="保存先を選んで書き出す…" variant="primary" isDisabled={(needsVoice && failedIds.length > 0) || rangeBad} onClick={() => void start()} />
              </HStack>
              {queue.length > 0 && (
                <VStack gap={2} data-export-queue>
                  <Text type="label">{`予約（${queue.length} 件）`}</Text>
                  {queue.map(j => (
                    <HStack key={j.id} gap={2} vAlign="center">
                      <VStack gap={0} style={{flex: 1, minWidth: 0}}>
                        <Text>{fileName(j.out)}</Text>
                        <Text type="supporting">{j.label}</Text>
                      </VStack>
                      <Button label="外す" size="sm" variant="ghost" onClick={() => setState({exportQueue: getState().exportQueue.filter(x => x.id !== j.id)})} />
                    </HStack>
                  ))}
                  <HStack gap={2} hAlign="end">
                    <Button label="予約を空にする" variant="ghost" onClick={() => setState({exportQueue: []})} />
                    <Button label={`予約した ${queue.length} 件を順番に書き出す`} variant="primary" isDisabled={needsVoice && failedIds.length > 0} onClick={() => void runQueue()} />
                  </HStack>
                </VStack>
              )}
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
              <Text type="supporting">終わるまで少しお待ちください。取り消すと、書きかけのファイルは消します</Text>
              <HStack hAlign="end">
                <Button label="取り消す" variant="secondary" onClick={() => void cancelExport()} />
              </HStack>
            </>
          )}
          {phase.kind === 'batch' && (
            <>
              <Text type="label">{`${phase.total} 件のうち ${phase.index + 1} 件目：${fileName(phase.out)}`}</Text>
              <ProgressBar
                label={phase.progress ? STAGE[phase.progress.stage] : '準備しています'}
                value={(phase.progress?.ratio ?? 0) * 100}
                isIndeterminate={!phase.progress || phase.progress.stage === 'portrait'}
                hasValueLabel={phase.progress?.stage === 'encode'}
              />
              <Text type="supporting">取り消すと、書き出し中のものと残りの予約をやめます（予約は残ります）</Text>
              <HStack hAlign="end">
                <Button
                  label="取り消す"
                  variant="secondary"
                  onClick={() => {
                    stopRef.current = true;
                    void cancelExport();
                  }}
                />
              </HStack>
            </>
          )}
          {phase.kind === 'batchDone' && (
            <>
              <Banner
                status={phase.results.every(r => r.ok) ? 'success' : 'warning'}
                title={`${phase.results.filter(r => r.ok).length} 件を書き出しました`}
                description={phase.results.some(r => !r.ok) ? '書き出せなかったものは予約に残しています' : undefined}
              />
              <VStack gap={1} data-export-results>
                {phase.results.map(r => (
                  <Text key={r.out} type={r.ok ? 'body' : 'supporting'}>
                    {`${r.ok ? '書き出し済み' : '書き出せず'}：${fileName(r.out)}${r.message ? `（${r.message}）` : ''}`}
                  </Text>
                ))}
              </VStack>
              <HStack gap={2} hAlign="end">
                <Button label="閉じる" variant="ghost" onClick={() => close(false)} />
                {phase.results.some(r => r.ok) && <Button label="フォルダを開く" variant="secondary" onClick={() => void revealInFolder(phase.results.find(r => r.ok)!.out)} />}
                <Button label="設定に戻る" variant="primary" onClick={() => setPhase({kind: 'setup'})} />
              </HStack>
            </>
          )}
          {phase.kind === 'done' && (
            <>
              <Banner status="success" title={`${KIND_LABEL[phase.what]}を書き出しました`} description={phase.out} />
              {phase.what !== 'subtitle' && <Credits />}
              <HStack gap={2} hAlign="end">
                <Button label="閉じる" variant="ghost" onClick={() => close(false)} />
                <Button label="フォルダを開く" variant={phase.what === 'subtitle' ? 'primary' : 'secondary'} onClick={() => void revealInFolder(phase.out)} />
                {phase.what !== 'subtitle' && <Button label={phase.what === 'audio' ? '聞く' : '再生する'} variant="primary" onClick={() => void openFile(phase.out)} />}
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
