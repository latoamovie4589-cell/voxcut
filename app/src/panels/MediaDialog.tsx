// 素材の場所と整理：見つからない素材の場所を選び直す・素材を 1 つのフォルダに集める。

import {useEffect} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Heading} from '@astryxdesign/core/Heading';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {FolderInput, FolderSearch} from 'lucide-react';
import {checkMedia, collectMediaAction, mediaPaths, relinkMedia, type Notify} from '../actions';
import {setState, useStore} from '../store';

export function MediaDialog({notify}: {notify: Notify}) {
  const isOpen = useStore(s => s.mediaOpen);
  const project = useStore(s => s.project);
  const projectPath = useStore(s => s.projectPath);
  const missing = useStore(s => s.missingMedia);
  const busy = useStore(s => !!s.busy);
  const close = () => setState({mediaOpen: false});
  // 開くたびに調べ直す（開いている間にファイルを戻したかもしれない）
  useEffect(() => {
    if (isOpen) void checkMedia();
  }, [isOpen]);
  if (!project) return null;
  const total = mediaPaths(project).length;

  const relink = async (path: string) => {
    try {
      const n = await relinkMedia(path);
      if (n > 1) notify(`同じフォルダにあった素材もあわせて、${n} 個をつなぎ直しました`, 'info');
      else if (n === 1) notify('素材をつなぎ直しました', 'info');
    } catch (e) {
      notify(String(e), 'error');
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={600} maxHeight="92dvh" purpose="form">
      <DialogHeader title="素材の場所と整理" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={5} padding={4}>
          <VStack gap={2}>
            <Heading level={3}>見つからない素材</Heading>
            {missing.length === 0 ? (
              <Text type="supporting">{total ? `${total} 個の素材は、すべて見つかっています。` : 'このプロジェクトは、まだ素材を使っていません。'}</Text>
            ) : (
              <>
                <Banner
                  status="warning"
                  title={`${missing.length} 個の素材が見つかりません`}
                  description="ファイルを動かしたか、名前を変えたか、消したときに起こります。今の場所を選ぶと、同じフォルダにあるほかの素材もまとめてつなぎ直します。"
                />
                {missing.map(path => (
                  <HStack key={path} gap={2} vAlign="center">
                    <div style={{flex: 1, minWidth: 0}}>
                      <Text type="body" maxLines={1} wordBreak="break-all">
                        {path.split(/[\\/]/).pop()}
                      </Text>
                      <Text type="supporting" maxLines={1} wordBreak="break-all">
                        {path}
                      </Text>
                    </div>
                    <Button label="場所を選ぶ…" size="sm" icon={<Icon icon={FolderSearch} />} onClick={() => void relink(path)} />
                  </HStack>
                ))}
              </>
            )}
          </VStack>
          <VStack gap={2}>
            <Heading level={3}>素材を 1 つのフォルダに集める</Heading>
            <Text type="supporting">
              使っている素材と立ち絵を、プロジェクトの隣の「（プロジェクト名）の素材」フォルダへコピーします。元のファイルはそのまま残ります。PC
              を移すときや人に渡すときは、プロジェクトのファイルとこのフォルダだけ持っていけば開けます。
            </Text>
            <div>
              <Button
                label="素材を集める"
                icon={<Icon icon={FolderInput} />}
                isDisabled={!projectPath || !total || busy}
                tooltip={!projectPath ? '先にプロジェクトを保存してください（保存した場所の隣に集めます）' : !total ? '集める素材がありません' : undefined}
                onClick={() => void collectMediaAction(notify)}
              />
            </div>
            {!projectPath && <Text type="supporting">先にプロジェクトを保存してください（保存した場所の隣に集めます）。</Text>}
          </VStack>
        </VStack>
      </div>
    </Dialog>
  );
}
