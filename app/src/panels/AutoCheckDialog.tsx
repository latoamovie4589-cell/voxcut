// 書き出し前の点検（ファイル → 書き出し前の点検…）。
// 声が未合成・素材が見つからない・空のセリフ・はみ出す字幕・長すぎる間を見つけて、その場で直す

import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {capGapsAuto, fitSubtitlesAuto, synthesize, type Notify} from '../actions';
import {checkProject, type Issue} from '../autoCheck';
import {deleteClips, setState, useStore} from '../store';

export function AutoCheckDialog({notify}: {notify: Notify}) {
  const isOpen = useStore(s => s.autoCheckOpen);
  const project = useStore(s => s.project);
  const missing = useStore(s => s.missingMedia);
  const busy = useStore(s => !!s.busy);
  if (!project) return null;
  const close = () => setState({autoCheckOpen: false});
  const issues = isOpen ? checkProject(project, missing) : [];
  const show = (i: Issue) => {
    const first = project.clips.find(c => c.id === i.ids[0]);
    setState(s => ({selectedClipIds: i.ids, selectedClipId: i.ids[0] ?? null, playhead: first?.start ?? s.playhead, revealSeq: s.revealSeq + 1}));
    close();
  };
  const fix = (i: Issue): {label: string; run: () => void} | null => {
    switch (i.kind) {
      case 'unsynth':
        return {label: '声を作る', run: () => void synthesize(notify, i.ids)};
      case 'empty':
        return {label: '消す', run: () => deleteClips(i.ids)};
      case 'missing':
        return {label: '素材を探し直す', run: () => setState({mediaOpen: true})};
      case 'overflow':
        return {label: '文字を小さくして収める', run: () => void fitSubtitlesAuto(3, 36)};
      case 'bigGap':
        return {label: '3 秒に詰める', run: () => void capGapsAuto(project.video.fps * 3, true)};
    }
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={540} maxHeight="92dvh" purpose="info">
      <DialogHeader title="書き出し前の点検" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={4} padding={4}>
          {issues.length === 0 ? (
            <Text>困りそうなところは見つかりませんでした。このまま書き出せます。</Text>
          ) : (
            issues.map(i => {
              const f = fix(i);
              return (
                <VStack key={i.kind} gap={2}>
                  <Text type="label">{i.level === 'error' ? '直してから書き出したほうがいい：' : '確かめたほうがいい：'}</Text>
                  <Text>{i.title}</Text>
                  <HStack gap={2} wrap="wrap">
                    <Button label="見に行く" variant="secondary" onClick={() => show(i)} />
                    {f && <Button label={f.label} variant="primary" isDisabled={busy} onClick={f.run} />}
                  </HStack>
                </VStack>
              );
            })
          )}
          <HStack hAlign="end">
            <Button label="閉じる" onClick={close} />
          </HStack>
        </VStack>
      </div>
    </Dialog>
  );
}
