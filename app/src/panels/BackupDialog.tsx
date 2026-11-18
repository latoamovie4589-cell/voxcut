// 以前の版から戻す：上書き保存するたびに残した前の内容を、新しい順に並べて開ける。

import {useEffect, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {openBackup, type Notify} from '../actions';
import {api} from '../ipc';
import {setState, useStore} from '../store';

type Entry = {path: string; savedMs: number; size: number};

const when = (ms: number) => new Date(ms).toLocaleString('ja-JP', {year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function BackupDialog({notify}: {notify: Notify}) {
  const isOpen = useStore(s => s.backupOpen);
  const projectPath = useStore(s => s.projectPath);
  const [list, setList] = useState<Entry[] | null>(null);
  const close = () => setState({backupOpen: false});
  useEffect(() => {
    if (!isOpen) return;
    setList(null);
    if (!projectPath) return setList([]);
    void api.then(a => a.listBackups(projectPath)).then(setList, () => setList([]));
  }, [isOpen, projectPath]);

  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={480} maxHeight="88dvh" purpose="form">
      <DialogHeader title="以前の版から戻す" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(88dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={3} padding={4}>
          {!projectPath ? (
            <Banner status="info" title="まだ保存していないプロジェクトです" description="一度保存すると、そのあと上書き保存するたびに前の内容を残します" />
          ) : list === null ? (
            <Text type="supporting">調べています…</Text>
          ) : !list.length ? (
            <Banner status="info" title="残している版はまだありません" description="上書き保存するたびに、前の内容をこの一覧に残します（新しいものから 30 個まで）" />
          ) : (
            <>
              <Text type="supporting">上書き保存する前の内容です。開いても元のファイルはそのままで、保存したときに置き換わります</Text>
              <VStack gap={1} data-backups>
                {list.map((b, i) => (
                  <HStack key={b.path} gap={2} vAlign="center">
                    <VStack gap={0} style={{flex: 1, minWidth: 0}}>
                      <Text>{`${when(b.savedMs)} より前`}</Text>
                      <Text type="supporting">{i === 0 ? `いちばん新しい版、${kb(b.size)}` : kb(b.size)}</Text>
                    </VStack>
                    <Button
                      label="この版を開く"
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void openBackup(notify, b.path, b.savedMs).then(ok => {
                          if (ok) close();
                        })
                      }
                    />
                  </HStack>
                ))}
              </VStack>
            </>
          )}
          <HStack hAlign="end">
            <Button label="閉じる" variant="ghost" onClick={close} />
          </HStack>
        </VStack>
      </div>
    </Dialog>
  );
}
