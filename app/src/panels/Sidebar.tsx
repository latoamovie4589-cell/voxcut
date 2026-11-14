// キャラクター一覧と、音声合成ソフトの接続状態。どちらも配置を変えられるパネル（dock/）として出す。

import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Item} from '@astryxdesign/core/Item';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {List} from '@astryxdesign/core/List';
import {CircleAlert, CircleCheck, CirclePause, Loader, Plus, RefreshCw} from 'lucide-react';
import {ENGINE_LABEL, isSpeakerMissing, speakerLabel} from '../model';
import {addCharacter, getState, removeCharacter, setState, useStore} from '../store';
import {exportCharacterFile, getNotify, importCharacterFile, refreshEngines} from '../actions';
import {MoreMenu} from '@astryxdesign/core/MoreMenu';

function Swatch({color}: {color: string}) {
  return <span className="vx-swatch" style={{background: color}} aria-hidden />;
}

/** 使っているキャラクターのソフトのうち、今使えないもの */
export function useEngineProblems() {
  const project = useStore(s => s.project);
  const engines = useStore(s => s.engines);
  const checking = useStore(s => s.checkingEngines);
  if (!project || checking) return [];
  const used = new Set(project.characters.map(c => c.voice.engine));
  return engines.filter(e => used.has(e.engine) && e.status.state !== 'ready').map(e => e.engine);
}

/**
 * キャラクターの一覧。inDialog のとき（キャラクターの編集ウィンドウ）は、ウィンドウの中だけの選択を使う
 * （設定を見ただけで、セリフ入力欄の話し手が変わらないように）
 */
export function CharactersPanel({inDialog = false}: {inDialog?: boolean}) {
  const project = useStore(s => s.project);
  const panelSel = useStore(s => s.selectedCharacterId);
  const dialogSel = useStore(s => s.dialogCharacterId);
  const selectedCharacterId = inDialog ? (dialogSel ?? panelSel) : panelSel;
  const clipSel = useStore(s => s.selectedClipId);
  const selectedClipId = inDialog ? null : clipSel;
  const add = () => {
    if (!inDialog) return void addCharacter();
    const keep = getState().selectedCharacterId;
    const id = addCharacter();
    setState({selectedCharacterId: keep, dialogCharacterId: id});
  };
  const voices = useStore(s => s.voices);
  const problems = useEngineProblems();
  if (!project) return null;
  return (
    <VStack gap={1} padding={2}>
      <HStack hAlign="between" vAlign="center" paddingInlineStart={1}>
        <Text type="supporting">{project.characters.length} 人</Text>
        <HStack gap={0}>
          <IconButton label="キャラクターを追加" tooltip="キャラクターを追加" variant="ghost" size="sm" icon={<Icon icon={Plus} />} onClick={add} />
          <MoreMenu
            label="キャラクターのメニュー"
            size="sm"
            items={[
              {
                label: 'ファイルから読み込む…',
                onClick: () => void importCharacterFile(getNotify()),
              },
              ...(selectedCharacterId
                ? [
                    {
                      label: '選んだキャラクターをファイルに保存…',
                      onClick: () => void exportCharacterFile(selectedCharacterId, getNotify()),
                    },
                    {type: 'divider' as const},
                    {
                      label: '選んだキャラクターを消す',
                      variant: 'destructive' as const,
                      onClick: () => {
                        if (!removeCharacter(selectedCharacterId)) getNotify()('最後の 1 人は消せません');
                      },
                    },
                  ]
                : []),
            ]}
          />
        </HStack>
      </HStack>
      <List density="compact">
        {project.characters.map(c => (
          <Item
            key={c.id}
            as="li"
            density="compact"
            label={c.name}
            description={`${ENGINE_LABEL[c.voice.engine]} · ${speakerLabel(c.voice, voices)}${problems.includes(c.voice.engine) ? '（今は使えません）' : isSpeakerMissing(c.voice, voices) ? '（話者が入っていません）' : ''}`}
            startContent={<Swatch color={c.color} />}
            isSelected={!selectedClipId && c.id === selectedCharacterId}
            onClick={() => setState(inDialog ? {dialogCharacterId: c.id} : {selectedCharacterId: c.id, selectedClipId: null})}
          />
        ))}
      </List>
    </VStack>
  );
}

export function EnginesPanel() {
  const engines = useStore(s => s.engines);
  const checking = useStore(s => s.checkingEngines);
  const problems = useEngineProblems();
  const readyCount = engines.filter(e => e.status.state === 'ready').length;
  return (
    <VStack gap={1} padding={2}>
      <HStack hAlign="between" vAlign="center" paddingInlineStart={1}>
        <Text type="supporting" maxLines={2}>
          {checking || !engines.length ? '確認しています…' : problems.length ? `${problems.map(e => ENGINE_LABEL[e]).join('・')} が使えません` : `${readyCount} つ使えます`}
        </Text>
        <IconButton label="接続を確認し直す" tooltip="接続を確認し直す" variant="ghost" size="sm" icon={<Icon icon={RefreshCw} />} clickAction={refreshEngines} />
      </HStack>
      <List density="compact">
        {engines.map(({engine, status}) => {
          const ok = !checking && status.state === 'ready';
          const text = checking ? '確認しています…' : ok ? '使えます' : status.state === 'notRunning' ? '起動していません' : '見つかりません';
          return (
            <Item
              key={engine}
              as="li"
              density="compact"
              label={ENGINE_LABEL[engine]}
              description={ok || checking || status.state === 'ready' ? text : `${text}：${status.detail}`}
              descriptionLines={4}
              endContent={
                checking ? undefined : !ok && (engine === 'aivoice' || engine === 'voicepeak') ? (
                  <Button label="場所を選ぶ" size="sm" onClick={() => setState({settingsOpen: true})} />
                ) : !ok ? (
                  <Button label="設定" size="sm" onClick={() => setState({settingsOpen: true})} />
                ) : undefined
              }
              startContent={
                <Icon
                  icon={checking ? Loader : ok ? CircleCheck : status.state === 'notRunning' ? CirclePause : CircleAlert}
                  color={checking ? 'secondary' : ok ? 'success' : status.state === 'notRunning' ? 'warning' : 'error'}
                  label={text}
                />
              }
            />
          );
        })}
      </List>
    </VStack>
  );
}
