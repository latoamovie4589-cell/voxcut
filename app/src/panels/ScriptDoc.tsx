// 台本モード：台本を文書のように「名前：セリフ」で 1 行ずつ書くと、タイムラインにセリフが並ぶ。
// 書き直した行・増えた行は、改行したとき・欄から離れたときに合成する（打っている途中は並べるだけ）。
// 名前の無い行は、すぐ上の行と同じキャラクター。知らない名前があれば、キャラクターを作るか聞く。
// 名前はキャラクターの色で見せる（欄の後ろに同じ文字を重ねて色だけ付ける）。
// 「元に戻す」は 1 行ずつ（改行で確定するまでの書き直しを 1 つにまとめる）。欄を離れる・タブを替えるときは書きかけも必ず反映する

import {useEffect, useMemo, useRef, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/Layout';
import {getNotify, synthesize} from '../actions';
import type {Character, Project, VoiceClip} from '../model';
import {parseScript, type ScriptLine} from '../script';
import {addCharacter, applyScript, getState, redo, setState, undo, useStore} from '../store';

const IDLE_MS = 1500;

const norm = (t: string) => t.replace(/\s/g, '');

/** 「茜：」のように名前だけ打った行（セリフはこれから）。書きかけなので並べない */
const nameOnly = (l: ScriptLine) => !l.name && /^[^\s:：「」]{1,20}[:：]$/.test(l.text.trim());

/** 台本の文から、並べる行（書きかけの名前だけの行は除く） */
const docLines = (text: string) => parseScript(text).filter(l => !nameOnly(l));

/** タブを替えて戻っても、まだ並べられていない書きかけを残す（知らない名前があるときなど） */
let keptDraft: string | null = null;

/** この欄から並べただけで、まだ合成していない行（次に合成するとき一緒に。もとからある未合成の行には手を出さない） */
const placedOnly = new Set<string>();

/** プロジェクトのセリフを、台本の文に */
function docOf(p: Project): {text: string; ids: string[]} {
  const lines = p.clips.filter((c): c is VoiceClip => c.type === 'voice').sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
  const name = (c: VoiceClip) => p.characters.find(x => x.id === c.characterId)?.name ?? '';
  return {
    text: lines.map(c => (c.text.includes('\n') ? `${name(c)}「${c.text.replace(/([「」])/g, '\\$1')}」` : `${name(c)}：${c.text}`)).join('\n'),
    ids: lines.map(c => c.id),
  };
}

const findChar = (chars: Character[], name: string) => chars.find(c => c.name === name || norm(c.name) === norm(name));

type DocItem = {characterId: string; text: string; hold?: boolean};

/**
 * 台本の文を、キャラクターを割り当てた行に。知らない名前の行は hold（その行だけ保留：今ある行はそのまま残し、新しくは入れない）。
 * 知らない名前は unknown に
 */
function readDoc(text: string, chars: Character[], fallback: string): {items: DocItem[]; unknown: string[]} {
  const items: DocItem[] = [];
  const unknown = new Set<string>();
  let last = fallback;
  for (const l of docLines(text)) {
    if (l.name) {
      const ch = findChar(chars, l.name);
      if (!ch) {
        unknown.add(l.name);
        items.push({characterId: '', text: l.text, hold: true});
        continue;
      }
      last = ch.id;
    }
    items.push({characterId: last, text: l.text});
  }
  return {items, unknown: [...unknown]};
}

/** 欄の後ろに重ねる、名前に色を付けた同じ文字 */
function Highlight({text, chars}: {text: string; chars: Character[]}) {
  const rows = text.split('\n');
  return (
    <>
      {rows.map((row, i) => {
        const m = row.match(/^(\s*)(【[^】]{1,20}】|[^\s:：「」【】]{1,20}(?=[:：「『]))/);
        const name = m ? m[2].replace(/^【|】$/g, '') : null;
        const ch = name ? findChar(chars, name) : undefined;
        return (
          <span key={i}>
            {m ? (
              <>
                {m[1]}
                <span className="vx-doc-name" data-unknown={ch ? undefined : true} style={ch ? {background: `${ch.color}30`, boxShadow: `inset 0 -2px 0 ${ch.color}`} : undefined}>
                  {m[2]}
                </span>
                {row.slice(m[0].length)}
              </>
            ) : (
              row
            )}
            {i < rows.length - 1 ? '\n' : ''}
          </span>
        );
      })}
      {/* 最後が改行のとき、欄と同じ高さにする */}
      {'\n'}
    </>
  );
}

export function ScriptDoc() {
  const project = useStore(s => s.project);
  const selectedChar = useStore(s => s.selectedCharacterId);
  const doc = useMemo(() => (project ? docOf(project) : {text: '', ids: []}), [project]);
  // 欄にいる間と、並べられない書きかけがある間だけ持つ。それ以外はタイムラインの内容をそのまま出す
  const [draft, setDraftState] = useState<string | null>(() => keptDraft);
  // 戻ってきたとき、残っていた書きかけの知らない名前をもう一度知らせる
  const [unknown, setUnknown] = useState<string[]>(() => {
    const p = getState().project;
    return keptDraft && p ? readDoc(keptDraft, p.characters, '').unknown : [];
  });
  const timer = useRef<number | undefined>(undefined);
  const ref = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<string | null>(draft);
  /** 最後にタイムラインへ並べた文（これと同じなら、書きかけは無い） */
  const appliedRef = useRef<string | null>(null);
  /** 最後に並べたとき、保留の行（知らない名前）が残っていたか。残っているうちは書きかけとして扱い、欄の文を捨てない */
  const heldRef = useRef(false);
  const text = draft ?? doc.text;

  const setDraft = (v: string | null) => {
    draftRef.current = v;
    setDraftState(v);
  };

  /** いまの行の書き直しをまとめる「元に戻す」の単位。改行で確定するたびに次へ */
  const lineKey = useRef(0);
  // 欄を出したまま別のタブ・一覧へ移る（Ctrl+F / Ctrl+H を含む）ときも、書きかけを捨てずに反映する
  const applyRef = useRef<(src: string, synth: boolean) => boolean>(() => false);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      const d = draftRef.current;
      if (d !== null && (d !== appliedRef.current || placedOnly.size)) applyRef.current(d, true);
    },
    [],
  );
  // 欄から離れたまま残った書きかけ（知らない名前）を、タブを替えても失わない
  useEffect(() => {
    keptDraft = unknown.length ? draft : null;
  }, [draft, unknown]);

  if (!project) return null;
  const fallback = selectedChar ?? project.characters[0]?.id ?? '';

  /** 書いた台本をタイムラインへ。synth なら、変わった行を合成する。並べられたら true */
  const apply = (src: string, synth: boolean): boolean => {
    window.clearTimeout(timer.current);
    const p = getState().project;
    if (!p) return false;
    const r = readDoc(src, p.characters, fallback);
    setUnknown(r.unknown);
    // 知らない名前の行だけ保留し、ほかの行は並べる。保留の行が残るうちは書いた文を欄に残す
    const ids = applyScript(r.items, `drag:script-doc-${lineKey.current}`);
    appliedRef.current = src;
    heldRef.current = r.unknown.length > 0;
    for (const id of ids) placedOnly.add(id);
    if (synth) {
      lineKey.current++;
      // この欄で書いた・直した行だけ合成する（前に並べただけの行も一緒に。もとからの未合成の行は頼まれていないので作らない）
      const now = getState().project;
      const all = now ? now.clips.filter((c): c is VoiceClip => c.type === 'voice' && !c.audio && placedOnly.has(c.id)).map(c => c.id) : [];
      placedOnly.clear();
      if (all.length) void synthesize(getNotify(), all);
    }
    return r.unknown.length === 0;
  };
  applyRef.current = apply;

  /** 並べていない書きかけが無いか */
  const clean = () => draftRef.current === null || draftRef.current === doc.text || (draftRef.current === appliedRef.current && !heldRef.current);

  const onChange = (v: string) => {
    setDraft(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => apply(v, false), IDLE_MS);
  };

  /** カーソルのある行のセリフを選ぶ（タイムラインとプレビューがその行へ） */
  const followCaret = () => {
    const el = ref.current;
    if (!el || unknown.length) return;
    if (docLines(el.value).length !== doc.ids.length) return; // まだ並べていない書きかけがある
    const before = el.value.slice(0, el.selectionStart).split('\n');
    // 空行・コメント・名前だけの行を除いた行番号に直す
    const idx = Math.max(0, docLines(before.join('\n')).length - 1);
    const id = doc.ids[idx];
    const c = id && getState().project?.clips.find(x => x.id === id);
    if (c && getState().selectedClipId !== id) setState(s => ({selectedClipId: id, playhead: c.start, revealSeq: s.revealSeq + 1}));
  };

  const createMissing = () => {
    // 押した時点の欄の文を先に押さえる（欄から離れたときの処理で消えないように）
    const src = ref.current?.value ?? draftRef.current ?? doc.text;
    const p = getState().project;
    const names = p ? readDoc(src, p.characters, fallback).unknown : [];
    if (!names.length) return;
    const prevSel = getState().selectedCharacterId;
    // 作るのと名前を付けるのを 1 つの「元に戻す」に
    for (const name of names) addCharacter(name);
    setState({selectedCharacterId: prevSel});
    getNotify()(`キャラクターを ${names.length} 人作りました。声は「キャラクター」で選べます`);
    setDraft(src);
    if (apply(src, true) && document.activeElement !== ref.current) setDraft(null);
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
      <div className="vx-script-doc-wrap">
        <div ref={backRef} className="vx-script-doc vx-script-doc-back" aria-hidden>
          <Highlight text={text} chars={project.characters} />
        </div>
        <textarea
          ref={ref}
          className="vx-script-doc vx-script-doc-input"
          aria-label="台本（名前：セリフ を 1 行ずつ）"
          spellCheck={false}
          placeholder={`${project.characters[0]?.name ?? 'ナレーター'}：こんにちは。\n${project.characters[1]?.name ?? project.characters[0]?.name ?? 'アシスタント'}：よろしくお願いします。`}
          value={text}
          onScroll={e => {
            if (backRef.current) backRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onFocus={() => {
            if (draftRef.current === null) setDraft(doc.text);
          }}
          onChange={e => onChange(e.target.value)}
          onBlur={() => {
            // 並べられた（知らない名前が無い）ら、欄はタイムラインの内容に戻す
            if (clean() || apply(draftRef.current!, true)) setDraft(null);
          }}
          onKeyDown={e => {
            const mod = e.ctrlKey || e.metaKey;
            const k = e.key.toLowerCase();
            // 探す・置き換える（Ctrl+F / Ctrl+H）と保存はアプリのショートカットへ。ほかは欄の中だけで使う（Space で再生などに取られないように）
            if (mod && (k === 'f' || k === 'h' || k === 's')) return;
            e.stopPropagation();
            // Ctrl+Z / Ctrl+Y はいつもタイムラインの元に戻す・やり直す（1 文字ずつではなく 1 行ずつ）。
            // 書きかけがあれば、先にそれを 1 つの手順として並べてから戻す（＝その行の書き直しをまとめて取り消す）
            if (mod && (k === 'z' || k === 'y')) {
              e.preventDefault();
              const redoing = k === 'y' || e.shiftKey;
              if (!redoing && !clean()) apply(draftRef.current!, false);
              lineKey.current++;
              if (redoing) redo();
              else undo();
              appliedRef.current = null;
              setDraft(null);
              return;
            }
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
              // 改行の直後に、書き終えた行を並べて合成
              const el = e.currentTarget;
              window.setTimeout(() => apply(el.value, true), 0);
            }
          }}
          onKeyUp={followCaret}
          onClick={followCaret}
        />
      </div>
    </VStack>
  );
}
