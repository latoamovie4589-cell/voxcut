// 今のパネルの配置に名前を付けて保存する（メニュー → ワークスペース → 今の配置を保存…）

import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {PRESETS, saveWorkspace, useDock} from '../dock/layout';
import {getNotify} from '../actions';
import {setState, useStore} from '../store';

export function WorkspaceDialog() {
  const isOpen = useStore(s => s.workspaceDialogOpen);
  const saved = useDock(s => s.saved);
  const [name, setName] = useState('');
  useEffect(() => {
    if (isOpen) setName(`ワークスペース ${saved.length + 1}`);
  }, [isOpen, saved.length]);
  const close = () => setState({workspaceDialogOpen: false});
  const n = name.trim();
  const clash = PRESETS.some(p => p.name === n || p.id === n);
  const overwrite = saved.some(x => x.name === n);
  const save = () => {
    if (!n || clash) return;
    saveWorkspace(n);
    close();
    getNotify()(`今の配置を「${n}」として保存しました`);
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={420} purpose="form">
      <DialogHeader title="今の配置を保存" onOpenChange={o => !o && close()} />
      <VStack gap={3} padding={4}>
        <TextInput
          label="名前"
          value={name}
          onChange={setName}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) save();
          }}
        />
        <Text type="supporting">
          {clash
            ? '最初から入っているワークスペースと同じ名前は使えません。'
            : overwrite
              ? '同じ名前のワークスペースを、今の配置で置き換えます。'
              : 'メニューの「ワークスペース」からいつでも呼び出せます。'}
        </Text>
        <HStack gap={2} hAlign="end">
          <Button label="やめる" variant="ghost" onClick={close} />
          <Button label={overwrite ? '置き換える' : '保存'} variant="primary" isDisabled={!n || clash} onClick={save} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
