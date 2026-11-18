// キー操作の割り当て：操作ごとに、押したキーをそのまま割り当てる（同じキーを使っていた操作からは外す）

import {Fragment, useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';
import {ACTION, ACTIONS, assignKey, clearKeys, comboLabel, comboOf, isCustom, keysFor, resetKeys, useKeymap, type ActionId} from '../keymap';
import {setState, useStore} from '../store';

/** 割り当てられないキー（ダイアログを閉じる・フォーカスを移すのに使う） */
const RESERVED = ['Escape', 'Tab', 'Shift+Tab'];

export function KeymapDialog() {
  const isOpen = useStore(s => s.keymapOpen);
  const [listening, setListening] = useState<{id: ActionId; add: boolean} | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useKeymap();
  const close = () => {
    setListening(null);
    setState({keymapOpen: false});
  };

  // キーを待っている間は、押したキーを横取りして割り当てる（Esc でやめる）
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      const c = comboOf(e);
      if (!c) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (c === 'Escape') {
        setListening(null);
        return;
      }
      if (RESERVED.includes(c)) {
        setNote(`${comboLabel(c)} は割り当てられません`);
        return;
      }
      const taken = assignKey(listening.id, c, listening.add);
      setNote(taken.length ? `${comboLabel(c)} を「${taken.map(t => ACTION[t].label).join('」「')}」から外して、「${ACTION[listening.id].label}」に割り当てました` : null);
      setListening(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening]);

  const groups = [...new Set(ACTIONS.map(a => a.group))];
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={620} maxHeight="88dvh" purpose="form">
      <DialogHeader title="キー操作の割り当て" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(88dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={4} padding={4}>
          <Text type="supporting">「変える」を押してから、使いたいキーを押してください（Ctrl・Shift・Alt との組み合わせもできます）。Esc でやめます</Text>
          {note && (
            <Text type="supporting" data-keymap-note>
              {note}
            </Text>
          )}
          {groups.map(g => (
            <VStack key={g} gap={2}>
              <Heading level={3}>{g}</Heading>
              <div className="vx-keymap">
                {ACTIONS.filter(a => a.group === g).map(a => {
                  const keys = keysFor(a.id);
                  const wait = listening?.id === a.id;
                  return (
                    <Fragment key={a.id}>
                      <Text>{a.label}</Text>
                      <HStack gap={1} wrap="wrap" data-keymap-keys={a.id}>
                        {wait ? (
                          <Text type="supporting">キーを押してください…</Text>
                        ) : keys.length ? (
                          keys.map(k => (
                            <kbd key={k} className="vx-kbd">
                              {comboLabel(k)}
                            </kbd>
                          ))
                        ) : (
                          <Text type="supporting">なし</Text>
                        )}
                      </HStack>
                      <HStack gap={1} hAlign="end">
                        <Button
                          size="sm"
                          label={wait ? 'やめる' : '変える'}
                          variant={wait ? 'secondary' : 'ghost'}
                          data-keymap-change={a.id}
                          onClick={() => setListening(wait ? null : {id: a.id, add: false})}
                        />
                        <Button size="sm" label="足す" variant="ghost" isDisabled={!!listening} onClick={() => setListening({id: a.id, add: true})} />
                        {keys.length > 0 && <Button size="sm" label="外す" variant="ghost" isDisabled={!!listening} onClick={() => clearKeys(a.id)} />}
                        {isCustom(a.id) && <Button size="sm" label="既定に戻す" variant="ghost" isDisabled={!!listening} onClick={() => resetKeys(a.id)} />}
                      </HStack>
                    </Fragment>
                  );
                })}
              </div>
            </VStack>
          ))}
          <HStack gap={2} hAlign="end">
            <Button
              label="すべて既定に戻す"
              variant="secondary"
              isDisabled={!ACTIONS.some(a => isCustom(a.id))}
              onClick={() => {
                resetKeys();
                setNote(null);
              }}
            />
            <Button label="閉じる" variant="primary" onClick={close} />
          </HStack>
        </VStack>
      </div>
    </Dialog>
  );
}
