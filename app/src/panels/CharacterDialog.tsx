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
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Icon} from '@astryxdesign/core/Icon';
import {UserPlus} from 'lucide-react';
import {addCharacter, getState, mergeCharacterAsPreset, setState, updateCharacter, useStore} from '../store';
import {Heading} from '@astryxdesign/core/Heading';
import {loadVoices} from '../actions';
import {layerLabel, type Character, type EngineId} from '../model';

type TabId = 'general' | 'voice' | 'subtitle' | 'portrait';

/** 名前の頭の同じ部分（「茜_怒り」と「茜_通常」なら「茜_」）の長さ */
const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/**
 * 感情ごとに分けて作ったキャラクターを、ほかのキャラクターの声のプリセットにまとめる。
 * まとめた後は、セリフ入力欄のプリセット（Alt+数字）やセリフの「音声」タブで切り替えられる
 */
function MergeAsPreset({character}: {character: Character}) {
  const all = useStore(s => s.project!.characters);
  const others = all.filter(c => c.id !== character.id && c.voice.engine === character.voice.engine);
  const guess = [...others].sort((a, b) => commonPrefix(b.name, character.name) - commonPrefix(a.name, character.name))[0];
  const [target, setTarget] = useState(guess?.id ?? '');
  const to = others.find(c => c.id === target) ?? guess;
  const defaultName = to ? character.name.slice(commonPrefix(to.name, character.name)).replace(/^[\s_・\-（(]+|[)）\s]+$/g, '') || character.name : character.name;
  const [name, setName] = useState('');
  if (!others.length) return null;
  return (
    <VStack gap={2} className="vx-preset">
      <Heading level={4}>ほかのキャラクターのプリセットにまとめる</Heading>
      <Hint>「茜_怒り」のように感情ごとにキャラクターを分けているなら、「茜_通常」の声のプリセットにまとめられます。セリフもまとめた先のキャラクターに移ります（元に戻すで戻せます）。</Hint>
      <HStack gap={2}>
        <Selector label="まとめる先" value={to?.id ?? ''} options={others.map(c => ({value: c.id, label: c.name}))} onChange={setTarget} width="100%" />
        <TextInput label="プリセットの名前" value={name || defaultName} onChange={setName} />
      </HStack>
      <div>
        <Button
          label={to ? `「${to.name}」の「${name || defaultName}」にする` : 'まとめる'}
          size="sm"
          isDisabled={!to}
          onClick={() => to && mergeCharacterAsPreset(character.id, to.id, name || defaultName)}
        />
      </div>
    </VStack>
  );
}

export function CharacterDialog() {
  const isOpen = useStore(s => s.characterDialogOpen);
  const project = useStore(s => s.project);
  const panelSel = useStore(s => s.selectedCharacterId);
  const selectedId = useStore(s => s.dialogCharacterId) ?? panelSel;
  const [tab, setTab] = useState<TabId>('voice');
  // 閉じたら、次の手順（セリフを打つ）へすぐ進めるよう下の入力欄へ
  const close = () => {
    setState({characterDialogOpen: false});
    window.setTimeout(() => document.querySelector<HTMLInputElement>('.vx-scriptbar input')?.focus(), 140);
  };
  // 開いたら、どのソフトの話者も選べるように一覧を読み込んでおく
  useEffect(() => {
    if (!isOpen) return;
    for (const e of ['voicevox', 'voicepeak', 'aivoice', 'voisona'] as EngineId[]) void loadVoices(e);
    // プロパティの要約から開いたときは、押した項目のタブで開く
    setTab(getState().inspectorTab);
    // 左の一覧の選び（強調）と右で編集している人をそろえる（タイムラインから開いたときも）
    const st = getState();
    const list = st.project?.characters ?? [];
    const want = list.find(c => c.id === st.dialogCharacterId) ?? list.find(c => c.id === st.selectedCharacterId) ?? list[0];
    if (want && want.id !== st.dialogCharacterId) setState({dialogCharacterId: want.id});
  }, [isOpen]);
  // 作ったばかり（名前が「キャラクター n」のまま）なら、名前の欄を選んだ状態にしてすぐ打てるように
  const chId = useStore(s => (s.characterDialogOpen ? s.dialogCharacterId : null));
  useEffect(() => {
    if (!isOpen || !chId) return;
    const c = getState().project?.characters.find(x => x.id === chId);
    if (!c || !/^キャラクター \d+$/.test(c.name)) return;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>('.vx-chardlg-name input');
      el?.focus();
      el?.select();
    }, 60);
    return () => window.clearTimeout(t);
  }, [isOpen, chId]);
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
                  <div className="vx-chardlg-name" style={{flex: 1, minWidth: 0}}>
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
                {tab === 'voice' && (
                  <>
                    <CharacterVoiceTab character={ch} />
                    <div style={{padding: '0 16px 16px'}}>
                      <MergeAsPreset character={ch} />
                    </div>
                  </>
                )}
                {tab === 'subtitle' && <CharacterSubtitleTab character={ch} />}
                {tab === 'portrait' && <PortraitSection character={ch} />}
              </div>
            </>
          )}
          {/* まだ誰もいないときは、右側にも最初の 1 人を作る入口を出す */}
          {!ch && (
            <VStack padding={6} gap={3} hAlign="center" vAlign="center" height="100%">
              <EmptyState icon={<Icon icon={UserPlus} size="lg" color="secondary" />} title="まだキャラクターがいません" description="話す人を 1 人作ると、声・字幕・立ち絵をここで決められます" />
              <Button label="最初のキャラクターを作る" variant="primary" icon={<Icon icon={UserPlus} />} onClick={() => setState({dialogCharacterId: addCharacter()})} />
            </VStack>
          )}
        </div>
      </div>
      <HStack hAlign="end" padding={3} className="vx-dialog-footer">
        <Button label="閉じる" variant="primary" onClick={close} />
      </HStack>
    </Dialog>
  );
}
