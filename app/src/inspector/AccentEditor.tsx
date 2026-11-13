// VOICEVOX のアクセント調整（YMM4 の「アクセント調整」と同じ考え方）。
// 文をアクセント句に分けて 1 音ずつ並べる。音の名前を押すとそこがアクセント（その音のあとで下がる）になり、
// 高さは縦のつまみで 1 音ずつ直せる。句のあとの区切り（息つぎ）も入れたり外したりできる。

import {Hint} from '../Hint';
import {useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Heading} from '@astryxdesign/core/Heading';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {AudioLines, RotateCcw, SlidersVertical} from 'lucide-react';
import {api} from '../ipc';
import type {AccentPhrase, Voice, VoiceClip} from '../model';
import {updateClip} from '../store';
import {getNotify, synthesize} from '../actions';

const PAUSE = {text: '、', vowel: 'pau', vowel_length: 0.3, pitch: 0};

export function AccentEditor({clip, voice}: {clip: VoiceClip; voice: Voice}) {
  const [edit, setEdit] = useState<{text: string; phrases: AccentPhrase[]} | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = clip.accent;
  const stale = !!saved && saved.speaker !== voice.speaker;

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await api;
      const r = await a.voicevoxAccent(clip.text, voice.speaker);
      // 前に直したものが今の文・話者と同じなら、それを続きから
      const keep = saved && saved.text === r.text && saved.speaker === voice.speaker;
      setEdit({text: r.text, phrases: keep ? structuredClone(saved.phrases) : r.phrases});
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  const recalc = async (phrases: AccentPhrase[]) => {
    try {
      const r = await (await api).voicevoxMoraData(phrases, voice.speaker);
      setEdit(e => (e ? {...e, phrases: r} : e));
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''));
    }
  };

  const save = () => {
    if (!edit) return;
    updateClip(clip.id, {accent: {text: edit.text, speaker: voice.speaker, phrases: edit.phrases}, audio: null});
    void synthesize(getNotify(), [clip.id]);
    getNotify()('アクセントを保存して、合成し直しています');
  };

  return (
    <VStack gap={2}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={4}>アクセント（VOICEVOX）</Heading>
        {!edit && <Button label={saved ? 'アクセントを直す' : 'アクセントを調整…'} size="sm" variant="ghost" icon={<Icon icon={SlidersVertical} />} isLoading={busy} onClick={() => void open()} />}
      </HStack>
      {!edit && (
        <Text type="supporting">
          {saved
            ? stale
              ? '話者を変えたので、直したアクセントは使われていません。'
              : '手で直したアクセントで読み上げています。文を変えると自動に戻ります。'
            : '読み間違えやアクセントのずれを、1 音ずつ直せます。'}
        </Text>
      )}
      {error && <Banner status="error" title="VOICEVOX から読み方を取れません" description={error} />}
      {edit && (
        <>
          <Hint>音の名前を押すと、そこがアクセント（そのあとで下がる）になります。縦のつまみで 1 音ずつ高さを直せます（いちばん下は無声）。</Hint>
          <div className="vx-accent">
            {edit.phrases.map((ph, pi) => (
              <div key={pi} className="vx-accent-phrase">
                <div className="vx-accent-moras">
                  {ph.moras.map((m, mi) => (
                    <div key={mi} className="vx-accent-mora" data-accent={mi + 1 === ph.accent || undefined}>
                      <input
                        type="range"
                        className="vx-accent-pitch"
                        aria-label={`${m.text} の高さ`}
                        min={0}
                        max={6.5}
                        step={0.01}
                        value={m.pitch}
                        onChange={e => {
                          const v = Number(e.target.value);
                          setEdit(x => (x ? {...x, phrases: x.phrases.map((p, i) => (i === pi ? {...p, moras: p.moras.map((mm, j) => (j === mi ? {...mm, pitch: v < 0.5 ? 0 : v} : mm))} : p))} : x));
                        }}
                      />
                      <button
                        type="button"
                        className="vx-accent-kana"
                        title="ここをアクセントにする"
                        aria-pressed={mi + 1 === ph.accent}
                        onClick={() => void recalc(edit.phrases.map((p, i) => (i === pi ? {...p, accent: mi + 1} : p)))}>
                        {m.text}
                      </button>
                    </div>
                  ))}
                </div>
                {pi < edit.phrases.length - 1 && (
                  <button
                    type="button"
                    className="vx-accent-pause"
                    aria-pressed={!!ph.pause_mora}
                    title={ph.pause_mora ? '区切り（息つぎ）を外す' : '区切り（息つぎ）を入れる'}
                    onClick={() => void recalc(edit.phrases.map((p, i) => (i === pi ? {...p, pause_mora: p.pause_mora ? null : PAUSE} : p)))}>
                    {ph.pause_mora ? '、' : '・'}
                  </button>
                )}
              </div>
            ))}
          </div>
          <HStack gap={2} wrap="wrap">
            <Button label="保存して合成" size="sm" variant="primary" icon={<Icon icon={AudioLines} />} onClick={save} />
            {saved && (
              <Button
                label="自動に戻す"
                size="sm"
                variant="ghost"
                icon={<Icon icon={RotateCcw} />}
                onClick={() => {
                  updateClip(clip.id, {accent: null, audio: null});
                  setEdit(null);
                  void synthesize(getNotify(), [clip.id]);
                }}
              />
            )}
            <Button label="やめる" size="sm" variant="ghost" onClick={() => setEdit(null)} />
          </HStack>
        </>
      )}
    </VStack>
  );
}
