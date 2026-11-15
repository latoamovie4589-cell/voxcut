// 保存していない変更があるとき（新規・開く・サンプルを開く）に出す問い。
// ブラウザの「OK／キャンセル」ではなく、「保存して続ける／保存しない／キャンセル」から選べる

import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {answerUnsaved} from '../actions';
import {useStore} from '../store';

export function UnsavedDialog() {
  const isOpen = useStore(s => s.unsavedAsk);
  const name = useStore(s => s.project?.name ?? '');
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && answerUnsaved('cancel')} width={440} purpose="required">
      <DialogHeader title="保存していない変更があります" onOpenChange={o => !o && answerUnsaved('cancel')} />
      <VStack gap={4} padding={4}>
        <Text>「{name}」の変更を保存してから続けますか？保存しないと、この変更はなくなります。</Text>
        <HStack gap={2} hAlign="end">
          <Button label="キャンセル" variant="ghost" onClick={() => answerUnsaved('cancel')} />
          <Button label="保存しない" variant="secondary" onClick={() => answerUnsaved('discard')} />
          <Button label="保存して続ける" variant="primary" onClick={() => answerUnsaved('save')} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
