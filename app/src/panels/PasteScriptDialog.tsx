// 台本の貼り付け。「名前：セリフ」などの台本をまとめて貼ると、キャラクターを割り当てて全部の行を追加する。

import {useMemo, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {TextArea} from '@astryxdesign/core/TextArea';
import {namesIn, parseScript} from '../script';
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
  // 開くたびに、入力欄から渡された文で始める
  if (isOpen && seen !== initial) {
    setSeen(initial);
    setText(initial);
    setMapping({});
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
  const close = () => {
    setState({pasteOpen: false, pasteText: ''});
    setText('');
    setSeen(null);
  };

  const submit = () => {
    if (!lines.length) return;
    const prevSel = getState().selectedCharacterId;
    // 新しく作るキャラクター
    const created = new Map<string, string>();
    for (const {name} of names) {
      if (target(name) !== NEW) continue;
      const id = addCharacter();
      updateCharacter(id, {name});
      created.set(name, id);
    }
    const items = lines.map(l => ({characterId: l.name ? (created.get(l.name) ?? target(l.name)) : fallback, text: l.text}));
    // 選んでいたキャラクターに戻す（addCharacter が選択を変えるため）
    setState({selectedCharacterId: prevSel});
    const ids = addLines(items);
    close();
    notify(`${ids.length} 行を追加しました${created.size ? `（キャラクターを ${created.size} 人作りました。右のパネルで声を選んでください）` : ''}`);
    if (synthNow && ids.length) void synthesize(notify, ids);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={640} maxHeight="92dvh" purpose="form">
      <DialogHeader title="台本を貼り付け" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 132px)', overflowY: 'auto'}}>
        <VStack gap={4} padding={4}>
          <Text type="supporting">
            1 行に 1 セリフ。「名前：セリフ」「名前「セリフ」」「【名前】セリフ」の形なら、名前でキャラクターを割り当てます。名前の無い行は「{chars.find(c => c.id === fallback)?.name}」が話します。
          </Text>
          <TextArea
            label="台本"
            placeholder={'ずんだもん：こんにちはなのだ\nめたん：今日は何をするの？'}
            value={text}
            onChange={setText}
            rows={10}
          />
          {names.length > 0 && (
            <VStack gap={2}>
              <Text type="label">名前の割り当て</Text>
              {names.map(({name, count}) => (
                <HStack key={name} gap={2} vAlign="center">
                  <div style={{width: 160, minWidth: 0}}>
                    <Text maxLines={1}>
                      {name}（{count} 行）
                    </Text>
                  </div>
                  <div style={{flex: 1}}>
                    <Selector
                      label={`「${name}」を話すキャラクター`}
                      isLabelHidden
                      value={target(name)}
                      options={[{value: NEW, label: `新しく作る（${name}）`}, ...chars.map(c => ({value: c.id, label: c.name}))]}
                      onChange={v => setMapping(m => ({...m, [name]: v}))}
                      width="100%"
                    />
                  </div>
                </HStack>
              ))}
            </VStack>
          )}
          <CheckboxInput label="追加したらすぐ合成する" value={synthNow} onChange={setSynthNow} />
        </VStack>
      </div>
      <HStack gap={2} hAlign="between" vAlign="center" padding={3}>
        <Text type="supporting">
          {lines.length ? `${lines.length} 行${unnamed ? `（名前なし ${unnamed} 行）` : ''}` : 'まだ何も貼られていません'}
        </Text>
        <HStack gap={2}>
          <Button label="キャンセル" variant="ghost" onClick={close} />
          <Button label={lines.length ? `${lines.length} 行を追加` : '追加'} variant="primary" isDisabled={!lines.length} onClick={submit} />
        </HStack>
      </HStack>
    </Dialog>
  );
}
