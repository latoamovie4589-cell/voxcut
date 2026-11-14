// 台本読み込み（YMM4 の「ツール → 台本読み込み」）。台本ファイル（txt・csv・tsv）を読み込むか、
// 「名前「セリフ」」などの台本を貼ると、名前でキャラクターを割り当てて、再生位置から全部の行を追加する。

import {useMemo, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {TextArea} from '@astryxdesign/core/TextArea';
import {namesIn, parseScript, parseScriptFile, toScriptText} from '../script';
import {Icon} from '@astryxdesign/core/Icon';
import {FileText} from 'lucide-react';
import {ENGINE_LABEL, type EngineId} from '../model';
import {addCharacter, addLines, getState, setState, updateCharacter, useStore} from '../store';
import {synthesize, type Notify} from '../actions';

const NEW = '__new__';

export function PasteScriptDialog({notify}: {notify: Notify}) {
  const isOpen = useStore(s => s.pasteOpen);
  const initial = useStore(s => s.pasteText);
  const project = useStore(s => s.project);
  const selected = useStore(s => s.selectedCharacterId);
  const [text, setText] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [synthNow, setSynthNow] = useState(true);
  const [seen, setSeen] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 新しく作るキャラクターの声（"ソフト\u0001話者"） */
  const [newVoice, setNewVoice] = useState<Record<string, string>>({});
  const voices = useStore(s => s.voices);
  const engines = useStore(s => s.engines);
  // 開くたびに、入力欄から渡された文で始める
  if (isOpen && seen !== initial) {
    setSeen(initial);
    setText(initial);
    setMapping({});
    setNewVoice({});
  }
  const lines = useMemo(() => parseScript(text), [text]);
  const names = useMemo(() => namesIn(lines), [lines]);
  if (!project) return null;
  const chars = project.characters;
  const fallback = selected ?? chars[0]?.id ?? '';
  const byName = (n: string) => chars.find(c => c.name === n || c.name.replace(/\s/g, '') === n.replace(/\s/g, ''))?.id;
  /** 名前 → 割り当て先（既にいるキャラクターなら自動、いなければ「新しく作る」） */
  const target = (n: string) => mapping[n] ?? byName(n) ?? NEW;
  const unnamed = lines.filter(l => !l.name).length;
  // 選べる声：使えるソフトの話者すべて
  const ready = new Set(engines.filter(e => e.status.state === 'ready').map(e => e.engine));
  const voiceOptions = (Object.keys(voices) as EngineId[])
    .filter(e => ready.has(e))
    .flatMap(e => (voices[e] ?? []).map(v => ({value: `${e}\u0001${v.speaker}`, label: `${ENGINE_LABEL[e]} · ${v.displayName}`})));
  // 新しいキャラクターには、今いるキャラクターと違う声を順に割り当てておく（同じ声のまま合成されないように）
  const usedVoices = new Set(chars.map(c => `${c.voice.engine}\u0001${c.voice.speaker}`));
  const newNames = names.filter(n => target(n.name) === NEW).map(n => n.name);
  const autoVoice: Record<string, string> = {};
  {
    const free = voiceOptions.map(o => o.value).filter(v => !usedVoices.has(v));
    // 名前が話者の名前に入っていれば、その声を選ぶ（「ずんだもん」→ VOICEVOX のずんだもん、「茜」→ 琴葉 茜）
    const norm = (t: string) => t.replace(/[\s・_＿]/g, '').toLowerCase();
    const byVoiceName = (n: string) => {
      const k = norm(n.replace(/[（(].*$/, ''));
      if (!k) return undefined;
      return voiceOptions.find(o => norm(o.label.split(' · ')[1] ?? '').includes(k))?.value;
    };
    let i = 0;
    for (const n of newNames) {
      const hit = byVoiceName(n);
      if (hit) autoVoice[n] = hit;
      else autoVoice[n] = free[i++ % Math.max(1, free.length)] ?? voiceOptions[0]?.value ?? '';
    }
  }
  const voiceFor = (n: string) => newVoice[n] ?? autoVoice[n] ?? '';
  /** 台本ファイルを読む。UTF-8 で読めなければ Shift_JIS（古いメモ帳の保存）として読む */
  const loadFile = async (f: File) => {
    const buf = await f.arrayBuffer();
    let src: string;
    try {
      src = new TextDecoder('utf-8', {fatal: true}).decode(buf);
    } catch {
      src = new TextDecoder('shift_jis').decode(buf);
    }
    setText(toScriptText(parseScriptFile(f.name, src.replace(/^\uFEFF/, ''))));
    setFileName(f.name);
  };
  const close = () => {
    setState({pasteOpen: false, pasteText: ''});
    setText('');
    setSeen(null);
    setFileName(null);
  };

  const submit = () => {
    if (!lines.length) return;
    const prevSel = getState().selectedCharacterId;
    // 新しく作るキャラクター
    const created = new Map<string, string>();
    for (const {name} of names) {
      if (target(name) !== NEW) continue;
      const id = addCharacter();
      const base = getState().project!.characters.find(c => c.id === id)!;
      const [engine, speaker] = voiceFor(name).split('\u0001') as [EngineId, string];
      updateCharacter(id, speaker ? {name, voice: {...base.voice, engine, speaker}} : {name});
      created.set(name, id);
    }
    const items = lines.map(l => ({characterId: l.name ? (created.get(l.name) ?? target(l.name)) : fallback, text: l.text}));
    // 選んでいたキャラクターに戻す（addCharacter が選択を変えるため）
    setState({selectedCharacterId: prevSel});
    const ids = addLines(items);
    close();
    notify(`${ids.length} 行を追加しました${created.size ? `。キャラクターを ${created.size} 人作りました` : ''}`);
    if (synthNow && ids.length) void synthesize(notify, ids);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={720} maxHeight="92dvh" purpose="form">
      <DialogHeader title="台本読み込み" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 132px)', overflowY: 'auto'}}>
        <VStack gap={4} padding={4}>
          <HStack gap={2} vAlign="center" hAlign="between">
            <Text type="supporting">
              「名前「セリフ」」「名前：セリフ」「【名前】セリフ」の形なら、名前でキャラクターを割り当てます。# で始まる行はコメント。名前の無い行は「{chars.find(c => c.id === fallback)?.name}
              」が話します。
            </Text>
            <Button label="ファイルを読み込む…" icon={<Icon icon={FileText} />} onClick={() => fileRef.current?.click()} />
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv,.tsv,text/plain,text/csv,text/tab-separated-values"
              hidden
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void loadFile(f);
                e.target.value = '';
              }}
            />
          </HStack>
          <TextArea
            label={fileName ? `台本（${fileName}）` : '台本'}
            description="txt：名前「セリフ」（複数行可）／ csv：名前,セリフ ／ tsv：名前<Tab>セリフ"
            placeholder={'霊夢「ゆっくりしていってね」\n魔理沙：今日は何をするんだ？'}
            value={text}
            onChange={setText}
            rows={10}
          />
          {names.length > 0 && (
            <VStack gap={2}>
              <Text type="label">名前の割り当て</Text>
              {newNames.length > 0 && <Text type="supporting">新しく作るキャラクターは、右で声を選べます（名前が同じ話者がいればその声を、いなければ今いるキャラクターと違う声を選んであります）</Text>}
              {names.map(({name, count}) => (
                <HStack key={name} gap={2} vAlign="center">
                  <div style={{width: 160, minWidth: 0}}>
                    <Text maxLines={1}>
                      {name}（{count} 行）
                    </Text>
                  </div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <Selector
                      label={`「${name}」を話すキャラクター`}
                      isLabelHidden
                      value={target(name)}
                      options={[{value: NEW, label: `新しく作る（${name}）`}, ...chars.map(c => ({value: c.id, label: c.name}))]}
                      onChange={v => setMapping(m => ({...m, [name]: v}))}
                      width="100%"
                    />
                  </div>
                  {target(name) === NEW && voiceOptions.length > 0 && (
                    <div style={{flex: 1, minWidth: 0}}>
                      <Selector
                        label={`「${name}」の声`}
                        isLabelHidden
                        value={voiceFor(name)}
                        options={voiceOptions}
                        hasSearch={voiceOptions.length > 8}
                        onChange={v => setNewVoice(m => ({...m, [name]: v}))}
                        width="100%"
                      />
                    </div>
                  )}
                </HStack>
              ))}
            </VStack>
          )}
          <CheckboxInput label="追加したらすぐ合成する" value={synthNow} onChange={setSynthNow} />
        </VStack>
      </div>
      <HStack gap={2} hAlign="between" vAlign="center" padding={3}>
        <Text type="supporting">{lines.length ? `${lines.length} 行${unnamed ? `（名前なし ${unnamed} 行）` : ''}・再生位置から追加します` : 'まだ台本がありません'}</Text>
        <HStack gap={2}>
          <Button label="キャンセル" variant="ghost" onClick={close} />
          <Button label={lines.length ? `タイムラインに追加（${lines.length} 行）` : 'タイムラインに追加'} variant="primary" isDisabled={!lines.length} onClick={submit} />
        </HStack>
      </HStack>
    </Dialog>
  );
}
