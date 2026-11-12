// 左パネル：キャラクター一覧と、音声合成ソフトの接続状態。

import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Item} from '@astryxdesign/core/Item';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {List} from '@astryxdesign/core/List';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import {ScriptList} from './ScriptList';
import {Plus, RefreshCw} from 'lucide-react';
import {ENGINE_LABEL, speakerLabel} from '../model';
import {addCharacter, removeCharacter, setState, useStore} from '../store';
import {exportCharacterFile, getNotify, importCharacterFile, refreshEngines} from '../actions';
import {MoreMenu} from '@astryxdesign/core/MoreMenu';

function Swatch({color}: {color: string}) {
  return <span className="vx-swatch" style={{background: color}} aria-hidden />;
}

export function Sidebar() {
  const project = useStore(s => s.project);
  const selectedCharacterId = useStore(s => s.selectedCharacterId);
  const selectedClipId = useStore(s => s.selectedClipId);
  const engines = useStore(s => s.engines);
  const checking = useStore(s => s.checkingEngines);
  const voices = useStore(s => s.voices);
  const tab = useStore(s => s.sidebarTab);
  if (!project) return null;
  return (
    <VStack gap={3} padding={3}>
      <TabList value={tab} onChange={v => setState({sidebarTab: v as 'characters' | 'script'})} layout="fill" size="sm" role="tablist">
        <Tab value="characters" label="キャラクター" panelId="vx-side-characters" />
        <Tab value="script" label="台本" panelId="vx-side-script" />
      </TabList>
      {tab === 'script' ? (
        <div id="vx-side-script" role="tabpanel">
          <ScriptList />
        </div>
      ) : (
      <div id="vx-side-characters" role="tabpanel">
      <VStack gap={4}>
      <VStack gap={1}>
        <HStack hAlign="between" vAlign="center" paddingInlineStart={1}>
          <Heading level={3}>キャラクター</Heading>
          <HStack gap={0}>
            <IconButton label="キャラクターを追加" tooltip="キャラクターを追加" variant="ghost" size="sm" icon={<Icon icon={Plus} />} onClick={addCharacter} />
            <MoreMenu
              label="キャラクターのメニュー"
              size="sm"
              items={[
                {label: 'ファイルから読み込む…', onClick: () => void importCharacterFile(getNotify())},
                ...(selectedCharacterId
                  ? [
                      {label: '選んだキャラクターをファイルに保存…', onClick: () => void exportCharacterFile(selectedCharacterId, getNotify())},
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
              description={`${ENGINE_LABEL[c.voice.engine]} · ${speakerLabel(c.voice, voices)}`}
              startContent={<Swatch color={c.color} />}
              isSelected={!selectedClipId && c.id === selectedCharacterId}
              onClick={() => setState({selectedCharacterId: c.id, selectedClipId: null})}
            />
          ))}
        </List>
      </VStack>

      <VStack gap={1}>
        <HStack hAlign="between" vAlign="center" paddingInlineStart={1}>
          <Heading level={3}>音声合成ソフト</Heading>
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
                descriptionLines={2}
                endContent={
                  checking ? undefined : !ok && (engine === 'aivoice' || engine === 'voicepeak') ? (
                    <Button label="場所を選ぶ" size="sm" variant="ghost" onClick={() => setState({settingsOpen: true})} />
                  ) : !ok ? (
                    <Button label="設定" size="sm" variant="ghost" onClick={() => setState({settingsOpen: true})} />
                  ) : undefined
                }
                startContent={
                  <StatusDot
                    variant={checking ? 'neutral' : ok ? 'success' : status.state === 'notRunning' ? 'warning' : 'neutral'}
                    label={text}
                  />
                }
              />
            );
          })}
        </List>
        {engines.length === 0 && (
          <Text type="supporting">確認しています…</Text>
        )}
      </VStack>
      </VStack>
      </div>
      )}
    </VStack>
  );
}
