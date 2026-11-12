// 読み方の辞書。登録した語は、合成するときだけ読みに置き換える（字幕は書いたまま）。すべてのソフトに共通。

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Plus, X} from 'lucide-react';
import {api, type DictEntry} from '../ipc';
import {getState, setState, useStore} from '../store';
import {synthesize, type Notify} from '../actions';

export function DictionaryDialog({notify}: {notify: Notify}) {
  const isOpen = useStore(s => s.dictionaryOpen);
  const saved = useStore(s => s.dictionary);
  const [rows, setRows] = useState<DictEntry[]>([]);
  const [opened, setOpened] = useState(false);
  if (isOpen && !opened) {
    setOpened(true);
    setRows(saved.length ? saved.map(r => ({...r})) : [{word: '', reading: ''}]);
  }
  const close = () => {
    setState({dictionaryOpen: false});
    setOpened(false);
  };
  const set = (i: number, patch: Partial<DictEntry>) => setRows(r => r.map((x, j) => (j === i ? {...x, ...patch} : x)));

  const save = async () => {
    const entries = rows.map(r => ({word: r.word.trim(), reading: r.reading.trim()})).filter(r => r.word && r.reading);
    try {
      await (await api).setDictionary(entries);
      const before = getState().dictionary;
      setState({dictionary: entries});
      close();
      // 変わった語を含むセリフだけ合成し直す
      const key = (d: DictEntry[]) => new Map(d.map(e => [e.word, e.reading]));
      const a = key(before);
      const b = key(entries);
      const changed = [...new Set([...a.keys(), ...b.keys()])].filter(w => a.get(w) !== b.get(w));
      const p = getState().project;
      const ids = changed.length && p ? p.clips.filter(c => c.type === 'voice' && changed.some(w => c.text.includes(w))).map(c => c.id) : [];
      notify(ids.length ? `辞書を保存しました。読みが変わる ${ids.length} 行を合成し直します` : '辞書を保存しました');
      if (ids.length) void synthesize(notify, ids);
    } catch (e) {
      notify(String(e), 'error');
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={560} maxHeight="92dvh" purpose="form">
      <DialogHeader title="読み方の辞書" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 132px)', overflowY: 'auto'}}>
        <VStack gap={3} padding={4}>
          <Text type="supporting">
            読み間違える語と、正しい読みを登録します。合成するときだけ置き換えるので、字幕は書いたままです。すべての音声合成ソフトに効きます。
          </Text>
          {rows.map((r, i) => (
            <HStack key={i} gap={2} vAlign="end">
              <div style={{flex: 1}}>
                <TextInput label="書き方" isLabelHidden={i > 0} placeholder="例：VoxCut" value={r.word} onChange={word => set(i, {word})} />
              </div>
              <div style={{flex: 1}}>
                <TextInput label="読み" isLabelHidden={i > 0} placeholder="例：ボックスカット" value={r.reading} onChange={reading => set(i, {reading})} />
              </div>
              <IconButton label={`${r.word || 'この行'}を消す`} tooltip="消す" variant="ghost" size="sm" icon={<Icon icon={X} />} onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} />
            </HStack>
          ))}
          <div>
            <Button label="語を足す" size="sm" icon={<Icon icon={Plus} />} onClick={() => setRows(rs => [...rs, {word: '', reading: ''}])} />
          </div>
        </VStack>
      </div>
      <HStack gap={2} hAlign="end" padding={3}>
        <Button label="キャンセル" variant="ghost" onClick={close} />
        <Button label="保存" variant="primary" clickAction={save} />
      </HStack>
    </Dialog>
  );
}
