// マーカー（タイムラインの目印）の一覧と、YouTube の概要欄に貼る文章（チャプター + 声のクレジット）。

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Heading} from '@astryxdesign/core/Heading';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Copy, Plus, X} from 'lucide-react';
import {collectCredits, framesToTimecode, projectDuration, type Marker, type Project} from '../model';
import {addMarker, removeMarker, setState, updateMarker, useStore} from '../store';

/** YouTube のチャプターの時刻（0:00 / 12:34 / 1:02:03。YouTube が読める形はこれだけ） */
export function chapterTime(frame: number, fps: number): string {
  const total = Math.floor(frame / fps);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** チャプターの行。先頭が 0:00 でなければ、YouTube の決まりに合わせて 0:00 の行を足す */
export function chapterLines(p: Project): string[] {
  const fps = p.video.fps;
  const ms = [...(p.markers ?? [])].sort((a, b) => a.frame - b.frame);
  if (!ms.length) return [];
  const rows = ms.map(m => `${chapterTime(m.frame, fps)} ${m.name.trim() || '場面'}`);
  return Math.floor(ms[0].frame / fps) > 0 ? ['0:00 オープニング', ...rows] : rows;
}

/** YouTube がチャプターとして扱う条件（3 つ以上・それぞれ 10 秒以上）に足りないところ */
function chapterProblems(p: Project): string[] {
  const fps = p.video.fps;
  const ms = [...(p.markers ?? [])].sort((a, b) => a.frame - b.frame);
  if (!ms.length) return [];
  const starts = [...(Math.floor(ms[0].frame / fps) > 0 ? [0] : []), ...ms.map(m => m.frame)];
  const out: string[] = [];
  if (starts.length < 3) out.push(`チャプターは 3 つ以上で有効になります（今は ${starts.length} つ）`);
  const ends = [...starts.slice(1), projectDuration(p)];
  if (starts.some((s, i) => ends[i] - s < 10 * fps)) out.push('10 秒より短い区間があります。YouTube ではチャプターになりません');
  return out;
}

export function DescriptionDialog() {
  const isOpen = useStore(s => s.descriptionOpen);
  const project = useStore(s => s.project);
  const voices = useStore(s => s.voices);
  const playhead = useStore(s => s.playhead);
  const [copied, setCopied] = useState(false);
  const close = () => {
    setState({descriptionOpen: false});
    setCopied(false);
  };
  if (!project) return null;
  const fps = project.video.fps;
  const markers: Marker[] = [...(project.markers ?? [])].sort((a, b) => a.frame - b.frame);
  const chapters = chapterLines(project);
  const {credits} = collectCredits(project, voices);
  const text = [chapters.join('\n'), credits.join('\n')].filter(Boolean).join('\n\n');
  const problems = chapterProblems(project);
  const here = markers.some(m => m.frame === playhead);

  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={600} maxHeight="92dvh" purpose="form">
      <DialogHeader title="マーカーと概要欄" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={4} padding={4}>
          <VStack gap={2}>
            <Heading level={3}>マーカー</Heading>
            <Text type="supporting">場面の変わり目に付ける目印です。タイムラインの目盛りに出て、押すとその位置へ移ります。名前はそのままチャプターの見出しになります。</Text>
            {markers.map(m => (
              <HStack key={m.id} gap={2} vAlign="center">
                <Button label={framesToTimecode(m.frame, fps)} size="sm" variant="ghost" tooltip="この位置へ移る" onClick={() => setState({playhead: m.frame})} />
                <div style={{flex: 1, minWidth: 0}}>
                  <TextInput label={`${framesToTimecode(m.frame, fps)} のマーカーの名前`} isLabelHidden value={m.name} placeholder="場面の名前" onChange={name => updateMarker(m.id, {name})} />
                </div>
                <IconButton label={`「${m.name || 'マーカー'}」を消す`} tooltip="消す" variant="ghost" size="sm" icon={<Icon icon={X} />} onClick={() => removeMarker(m.id)} />
              </HStack>
            ))}
            <div>
              <Button
                label={`再生位置（${framesToTimecode(playhead, fps)}）にマーカーを付ける`}
                size="sm"
                icon={<Icon icon={Plus} />}
                isDisabled={here}
                tooltip={here ? 'この位置にはもうマーカーがあります' : 'タイムラインで M キーでも付けられます'}
                onClick={() => addMarker()}
              />
            </div>
          </VStack>
          <VStack gap={2}>
            <Heading level={3}>概要欄に貼る文章</Heading>
            {text ? (
              <>
                <pre className="vx-description" tabIndex={0} aria-label="概要欄に貼る文章">
                  {text}
                </pre>
                {problems.map(x => (
                  <Text key={x} type="supporting">
                    {x}
                  </Text>
                ))}
                {chapters.length > 0 && <Text type="supporting">チャプターの時刻は YouTube が読める「分:秒」の形で書いています。</Text>}
                <div>
                  <Button
                    label={copied ? 'コピーしました' : 'コピー'}
                    variant="primary"
                    icon={<Icon icon={Copy} />}
                    onClick={() => {
                      void navigator.clipboard.writeText(text).then(() => setCopied(true));
                    }}
                  />
                </div>
              </>
            ) : (
              <Text type="supporting">マーカーを付けるとチャプターが、VOICEVOX の声を使うとクレジット表記が、ここに出ます。</Text>
            )}
          </VStack>
        </VStack>
      </div>
    </Dialog>
  );
}
