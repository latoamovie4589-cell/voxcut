// テンプレート：アイテム・字幕の見た目・立ち絵の配置を取っておいて使い回す。

import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Heading} from '@astryxdesign/core/Heading';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Plus, X} from 'lucide-react';
import type {Notify} from '../actions';
import {isVisual, type PortraitClip} from '../model';
import {insertItemTemplate, setState, updateCharacter, updateClip, useStore} from '../store';
import {itemTemplateName, removeTemplate, renameTemplate, saveTemplate, useTemplates, type Template, type TemplateKind} from '../templates';

function Rows({kind, list, action, onUse, disabled}: {kind: TemplateKind; list: Template[]; action: string; onUse: (t: Template) => void; disabled?: string | null}) {
  const rows = list.filter(t => t.kind === kind);
  if (!rows.length) return <Text type="supporting">まだありません。</Text>;
  return (
    <>
      {rows.map(t => (
        <HStack key={t.id} gap={2} vAlign="center">
          <div style={{flex: 1, minWidth: 0}}>
            <TextInput label="テンプレートの名前" isLabelHidden value={t.name} onChange={name => renameTemplate(t.id, name)} />
          </div>
          <Button label={action} size="sm" isDisabled={!!disabled} tooltip={disabled ?? undefined} onClick={() => onUse(t)} />
          <IconButton label={`「${t.name}」を消す`} tooltip="消す" variant="ghost" size="sm" icon={<Icon icon={X} />} onClick={() => removeTemplate(t.id)} />
        </HStack>
      ))}
    </>
  );
}

export function TemplatesDialog({notify}: {notify: Notify}) {
  const isOpen = useStore(s => s.templatesOpen);
  const project = useStore(s => s.project);
  const selectedId = useStore(s => s.selectedClipId);
  const characterId = useStore(s => s.selectedCharacterId);
  const list = useTemplates();
  const close = () => setState({templatesOpen: false});
  if (!project) return null;
  const sel = project.clips.find(c => c.id === selectedId);
  const item = sel && isVisual(sel) ? sel : null;
  // 立ち絵アイテムを選んでいれば、その配置（とそのキャラクター）。選んでいなければ入力欄のキャラクター
  const portraitItem = sel?.type === 'portrait' ? (sel as PortraitClip) : null;
  const ch = project.characters.find(c => c.id === (portraitItem?.characterId ?? characterId)) ?? project.characters[0];
  const placement = portraitItem?.transform ?? ch?.portrait?.transform ?? null;
  const who = ch ? `「${ch.name}」` : '';

  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={600} maxHeight="92dvh" purpose="form">
      <DialogHeader title="テンプレート" onOpenChange={o => !o && close()} />
      <div style={{maxHeight: 'calc(92dvh - 72px)', overflowY: 'auto'}}>
        <VStack gap={5} padding={4}>
          <Text type="supporting">よく使う見た目を名前を付けて取っておけます。この PC に覚えるので、ほかのプロジェクトでも使えます。</Text>
          <VStack gap={2}>
            <Heading level={3}>アイテム（テキスト・図形・画像・動画）</Heading>
            <Rows
              kind="item"
              list={list}
              action="再生位置に置く"
              onUse={t => {
                if (t.kind !== 'item') return;
                insertItemTemplate(t.data);
                close();
              }}
            />
            <div>
              <Button
                label="選んでいるアイテムを保存"
                size="sm"
                icon={<Icon icon={Plus} />}
                isDisabled={!item}
                tooltip={item ? '文字・色・位置・動き・効果・長さをまとめて取っておきます' : 'タイムラインでテキスト・図形・画像・動画を選んでください'}
                onClick={() => {
                  if (!item) return;
                  const t = saveTemplate('item', itemTemplateName(item), item);
                  notify(`テンプレート「${t.name}」に保存しました`, 'info');
                }}
              />
            </div>
          </VStack>
          <VStack gap={2}>
            <Heading level={3}>字幕の見た目</Heading>
            <Rows
              kind="subtitle"
              list={list}
              action={ch ? `${who}に当てる` : '当てる'}
              disabled={ch ? null : 'キャラクターがいません'}
              onUse={t => {
                if (t.kind !== 'subtitle' || !ch) return;
                updateCharacter(ch.id, {subtitle: structuredClone(t.data)});
                notify(`${who}の字幕を「${t.name}」の見た目にしました`, 'info');
              }}
            />
            <div>
              <Button
                label={ch ? `${who}の字幕の見た目を保存` : '字幕の見た目を保存'}
                size="sm"
                icon={<Icon icon={Plus} />}
                isDisabled={!ch}
                onClick={() => {
                  if (!ch) return;
                  const t = saveTemplate('subtitle', `${ch.name}の字幕`, ch.subtitle);
                  notify(`テンプレート「${t.name}」に保存しました`, 'info');
                }}
              />
            </div>
          </VStack>
          <VStack gap={2}>
            <Heading level={3}>立ち絵の配置（位置・大きさ・不透明度）</Heading>
            <Rows
              kind="placement"
              list={list}
              action={portraitItem ? '選んでいる立ち絵に当てる' : ch ? `${who}に当てる` : '当てる'}
              disabled={ch?.portrait ? null : '立ち絵のあるキャラクターを選んでください'}
              onUse={t => {
                if (t.kind !== 'placement' || !ch?.portrait) return;
                // 立ち絵アイテムを選んでいればそのアイテムだけ、そうでなければキャラクターの初期値と、置いてある立ち絵アイテムすべて
                if (portraitItem) updateClip(portraitItem.id, {transform: {...t.data}} as Partial<PortraitClip>);
                else {
                  updateCharacter(ch.id, {portrait: {...ch.portrait, transform: {...t.data}}});
                  for (const c of project.clips) if (c.type === 'portrait' && c.characterId === ch.id) updateClip(c.id, {transform: {...t.data}} as Partial<PortraitClip>);
                }
                notify(`${who}の立ち絵を「${t.name}」の配置にしました`, 'info');
              }}
            />
            <div>
              <Button
                label={portraitItem ? '選んでいる立ち絵の配置を保存' : ch ? `${who}の立ち絵の配置を保存` : '立ち絵の配置を保存'}
                size="sm"
                icon={<Icon icon={Plus} />}
                isDisabled={!placement}
                tooltip={placement ? undefined : '立ち絵のあるキャラクターを選んでください'}
                onClick={() => {
                  if (!placement || !ch) return;
                  const t = saveTemplate('placement', `${ch.name}の配置`, placement);
                  notify(`テンプレート「${t.name}」に保存しました`, 'info');
                }}
              />
            </div>
          </VStack>
        </VStack>
      </div>
    </Dialog>
  );
}
