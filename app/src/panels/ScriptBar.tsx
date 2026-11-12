// 下部のセリフ入力欄。キャラクターを選んで Enter で末尾に追加（YMM4 と同じ流れ）。
// 追加した行はすぐ合成を始める（キャッシュがあれば一瞬で終わる）。

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {TextInput} from '@astryxdesign/core/TextInput';
import {CornerDownLeft} from 'lucide-react';
import {addLine, setState, useStore} from '../store';
import {synthesize, type Notify} from '../actions';

export function ScriptBar({notify}: {notify: Notify}) {
  const project = useStore(s => s.project);
  const characterId = useStore(s => s.selectedCharacterId);
  const [text, setText] = useState('');
  // 選んでいるセリフがあれば、その後ろに挿入する
  const afterSel = useStore(s => s.project?.clips.find(c => c.id === s.selectedClipId)?.type === 'voice');
  if (!project) return null;
  const current = characterId ?? project.characters[0]?.id ?? '';

  const submit = () => {
    const t = text.trim();
    if (!t || !current) return;
    const id = addLine(current, t);
    setText('');
    void synthesize(notify, [id]);
  };

  return (
    <HStack gap={2} vAlign="end" padding={3}>
      <Selector
        label="話すキャラクター"
        isLabelHidden
        variant="secondary"
        width={180}
        value={current}
        options={project.characters.map(c => ({value: c.id, label: c.name}))}
        onChange={v => setState({selectedCharacterId: v})}
      />
      <div style={{flex: 1, minWidth: 0}} data-script-input>
        <TextInput
          label="セリフ"
          isLabelHidden
          placeholder={afterSel ? '選んでいる行の後ろに挿入（Enter）' : 'セリフを入力して Enter で追加（Ctrl+L でここへ）'}
          value={text}
          onChange={setText}
          onEnter={submit}
          width="100%"
        />
      </div>
      <Button label="追加" icon={<Icon icon={CornerDownLeft} />} onClick={submit} isDisabled={!text.trim()} />
    </HStack>
  );
}
