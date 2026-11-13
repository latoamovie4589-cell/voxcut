// キャラクター設定ウィンドウ（YMM4 の「ファイル → キャラクターの編集」と同じ）。
// 左にキャラクターの一覧（追加・読み込み・書き出し・削除）、右に選んだキャラクターの
// 全般（名前・アイテムの色・トラック）／声（声・調声・余韻・プリセット）／字幕／立ち絵。

import {Hint} from '../Hint';
import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import {TextInput} from '@astryxdesign/core/TextInput';
import {CharactersPanel} from './Sidebar';
import {CharacterSubtitleTab, CharacterVoiceTab, ColorSwatchInput, PortraitSection} from '../inspector/Inspector';
import {getState, setState, updateCharacter, useStore} from '../store';
import {loadVoices} from '../actions';
import {layerLabel, type EngineId} from '../model';

type TabId = 'general' | 'voice' | 'subtitle' | 'portrait';

export function CharacterDialog() {
  const isOpen = useStore(s => s.characterDialogOpen);
  const project = useStore(s => s.project);
  const panelSel = useStore(s => s.selectedCharacterId);
  const selectedId = useStore(s => s.dialogCharacterId) ?? panelSel;
  const [tab, setTab] = useState<TabId>('voice');
  const close = () => setState({characterDialogOpen: false});
  // 開いたら、どのソフトの話者も選べるように一覧を読み込んでおく
  useEffect(() => {
    if (!isOpen) return;
    for (const e of ['voicevox', 'voicepeak', 'aivoice', 'voisona'] as EngineId[]) void loadVoices(e);
    // プロパティの要約から開いたときは、押した項目のタブで開く
    setTab(getState().inspectorTab);
  }, [isOpen]);
  if (!project) return null;
  const ch = project.characters.find(c => c.id === selectedId) ?? project.characters[0];
  const update = (patch: Parameters<typeof updateCharacter>[1]) => ch && updateCharacter(ch.id, patch);
  const options = (kind: 'video' | 'audio') => {
    const list = project.tracks;
    return [
      {value: '', label: kind === 'audio' ? '自動（前回分離した声のレイヤー、無ければ近くの空いているレイヤー）' : '自動（最後にこのキャラクターのセリフを置いたレイヤー）'},
      ...list.map((t, i) => ({value: String(i + 1), label: layerLabel(project, t.id)})),
      {value: String(list.length + 1), label: `レイヤー ${list.length + 1}（新しく作る）`},
    ];
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={920} maxHeight="92dvh" purpose="form">
      <DialogHeader title="キャラクターの編集" onOpenChange={o => !o && close()} />
      <div className="vx-chardlg">
        <div className="vx-chardlg-list">
          <CharactersPanel inDialog />
        </div>
        <div className="vx-chardlg-body">
          {ch && (
            <>
              <VStack gap={3} paddingInline={4} paddingBlockStart={4}>
                <HStack gap={2} vAlign="center">
                  <ColorSwatchInput label="アイテムの色" value={ch.color} onChange={color => update({color})} />
                  <div style={{flex: 1, minWidth: 0}}>
                    <TextInput label="名前" isLabelHidden value={ch.name} onChange={v => update({name: v})} />
                  </div>
                </HStack>
                <TabList value={tab} onChange={v => setTab(v as TabId)} layout="fill" size="sm" role="tablist" hasDivider>
                  <Tab value="general" label="全般" panelId="vx-chardlg-panel" />
                  <Tab value="voice" label="声" panelId="vx-chardlg-panel" />
                  <Tab value="subtitle" label="字幕" panelId="vx-chardlg-panel" />
                  <Tab value="portrait" label="立ち絵" panelId="vx-chardlg-panel" />
                </TabList>
              </VStack>
              <div id="vx-chardlg-panel" role="tabpanel" className="vx-chardlg-scroll">
                {tab === 'general' && (
                  <VStack gap={3} padding={4}>
                    <Hint>名前と色は上の欄で変えられます。名前は台本を読み込むときに話し手を見分けるのに使い、色はタイムラインのセリフの色になります。</Hint>
                    <Selector
                      label="セリフのレイヤー"
                      description="セリフ入力欄や台本読み込みで、このキャラクターのセリフ（字幕と声）を置くレイヤー（番号の大きいレイヤーほど手前）"
                      value={ch.layer ? String(ch.layer) : ''}
                      options={options('video')}
                      onChange={v => update({layer: v ? Number(v) : null})}
                      width="100%"
                    />
                    <Selector
                      label="分離した声のレイヤー"
                      description="右クリックの「字幕と音声を分離」をしたとき、このキャラクターの声を置くレイヤー"
                      value={ch.audioLayer ? String(ch.audioLayer) : ''}
                      options={options('audio')}
                      onChange={v => update({audioLayer: v ? Number(v) : null})}
                      width="100%"
                    />
                  </VStack>
                )}
                {tab === 'voice' && <CharacterVoiceTab character={ch} />}
                {tab === 'subtitle' && <CharacterSubtitleTab character={ch} />}
                {tab === 'portrait' && <PortraitSection character={ch} />}
              </div>
            </>
          )}
        </div>
      </div>
      <HStack hAlign="end" padding={3} className="vx-dialog-footer">
        <Button label="閉じる" variant="primary" onClick={close} />
      </HStack>
    </Dialog>
  );
}
