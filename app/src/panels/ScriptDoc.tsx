// 台本モード：台本を文書のように「名前：セリフ」で 1 行ずつ書くと、タイムラインにセリフが並ぶ。
// 書き直した行・増えた行は、改行したとき・欄から離れたときに合成する（打っている途中は並べるだけ）。
// 名前の無い行は、すぐ上の行と同じキャラクター。知らない名前があれば、キャラクターを作るか聞く

import {useEffect, useMemo, useRef, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/Layout';
import {getNotify, synthesize} from '../actions';
import type {Character, Project, VoiceClip} from '../model';
import {parseScript} from '../script';
import {addCharacter, applyScript, getState, setState, updateCharacter, useStore} from '../store';

const IDLE_MS = 1200;

const norm = (t: string) => t.replace(/\s/g, '');

/** プロジェクトのセリフを、台本の文に */
function docOf(p: Project): {text: string; ids: string[]} {
  const lines = p.clips.filter((c): c is VoiceClip => c.type === 'voice').sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
  const name = (c: VoiceClip) => p.characters.find(x => x.id === c.characterId)?.name ?? '';
  return {
    text: lines.map(c => (c.text.includes('\n') ? `${name(c)}「${c.text.replace(/([「」])/g, '\\$1')}」` : `${name(c)}：${c.text}`)).join('\n'),
    ids: lines.map(c => c.id),
  };
}

/** 台本の文を、キャラクターを割り当てた行に。知らない名前は unknown に */
function readDoc(text: string, chars: Character[], fallback: string): {items: {characterId: string; text: string}[]; unknown: string[]} {
  const items: {characterId: string; text: string}[] = [];
  const unknown = new Set<string>();
  let last = fallback;
  for (const l of parseScript(text)) {
    if (l.name) {
      const ch = chars.find(c => c.name === l.name || norm(c.name) === norm(l.name!));
      if (!ch) {
        unknown.add(l.name);
        continue;
      }
      last = ch.id;
    }
    items.push({characterId: last, text: l.text});
  }
  return {items, unknown: [...unknown]};
}

export function ScriptDoc() {
  const project = useStore(s => s.project);
  const selectedChar = useStore(s => s.selectedCharacterId);
  const doc = useMemo(() => (project ? docOf(project) : {text: '', ids: []}), [project]);
  const [draft, setDraft] = useState<string | null>(null); // 書いている途中（欄にいる間）だけ持つ
  const [unknown, setUnknown] = useState<string[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = draft ?? doc.text;
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!project) return null;
  const fallback = selectedChar ?? project.characters[0]?.id ?? '';

  /** 書いた台本をタイムラインへ。synth なら、変わった行を合成する */
  const apply = (src: string, synth: boolean): boolean => {
    window.clearTimeout(timer.current);
    const p = getState().project;
    if (!p) return false;
    const r = readDoc(src, p.characters, fallback);
    setUnknown(r.unknown);
    // 知らない名前があるうちは並べない（その行を消してしまわないように）。書いた文は欄に残す
    if (r.unknown.length) return false;
    const ids = applyScript(r.items);
    if (synth) {
      // 前に並べただけの行も、まだ合成していなければ一緒に
      const now = getState().project;
      const pending = now ? now.clips.filter((c): c is VoiceClip => c.type === 'voice' && !c.audio).map(c => c.id) : [];
      const all = [...new Set([...ids, ...pending])];
      if (all.length) void synthesize(getNotify(), all);
    }
    return true;
  };

  const onChange = (v: string) => {
    draftRef.current = v;
    setDraft(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => apply(v, false), IDLE_MS);
  };

  /** カーソルのある行のセリフを選ぶ（タイムラインとプレビューがその行へ） */
  const followCaret = () => {
    const el = ref.current;
    if (!el || unknown.length) return;
    const row = el.value.slice(0, el.selectionStart).split('\n').length - 1;
    // 空行・コメントを除いた行番号に直す
    const before = el.value.split('\n').slice(0, row + 1);
    const idx = parseScript(before.join('\n')).length - 1;
    if (parseScript(el.value).length !== doc.ids.length) return; // まだ並べていない書きかけがある
    const id = doc.ids[idx];
    const c = id && getState().project?.clips.find(x => x.id === id);
    if (c && getState().selectedClipId !== id) setState(s => ({selectedClipId: id, playhead: c.start, revealSeq: s.revealSeq + 1}));
  };

  const createMissing = () => {
    const prevSel = getState().selectedCharacterId;
    for (const name of unknown) {
      const id = addCharacter();
      updateCharacter(id, {name});
    }
    setState({selectedCharacterId: prevSel});
    getNotify()(`キャラクターを ${unknown.length} 人作りました。声は「キャラクター」タブで選べます`);
    const src = draftRef.current ?? doc.text;
    if (apply(src, true)) setDraft(null);
  };

  return (
    <VStack gap={2} padding={2} height="100%">
      <Text type="supporting">「名前：セリフ」で 1 行ずつ書くと、タイムラインに並びます。名前を省くと、上の行と同じキャラクターです。改行すると合成します。</Text>
      {unknown.length > 0 && (
        <Banner
          status="warning"
          title={`「${unknown.join('」「')}」というキャラクターがいません`}
          description="作るか、名前を直してください。それまでタイムラインは変えません"
          endContent={<Button label="キャラクターを作る" size="sm" onClick={createMissing} />}
        />
      )}
      <textarea
        ref={ref}
        className="vx-script-doc"
        aria-label="台本（名前：セリフ を 1 行ずつ）"
        spellCheck={false}
        placeholder={`${project.characters[0]?.name ?? 'ナレーター'}：こんにちは。\n${project.characters[1]?.name ?? project.characters[0]?.name ?? 'アシスタント'}：よろしくお願いします。`}
        value={text}
        onFocus={() => setDraft(d => d ?? doc.text)}
        onChange={e => onChange(e.target.value)}
        onBlur={() => {
          // 並べられた（知らない名前が無い）ら、欄はタイムラインの内容に戻す
          if (draft === null || draft === doc.text || apply(draft, true)) setDraft(null);
        }}
        onKeyDown={e => {
          // ショートカット（Space で再生など）に取られないように
          e.stopPropagation();
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
            // 改行の直後に、書き終えた行を並べて合成
            const el = e.currentTarget;
            window.setTimeout(() => apply(el.value, true), 0);
          }
        }}
        onKeyUp={followCaret}
        onClick={followCaret}
      />
    </VStack>
  );
}
