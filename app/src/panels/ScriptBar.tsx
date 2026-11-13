// セリフ入力欄（YMM4 と同じく、タイムラインの一番下）。
// 左からキャラクターの選択・キャラクター設定ボタン・追加モード・セリフ。Enter でキャラクターのトラックの再生位置に追加し、
// すぐ合成を始める（キャッシュがあれば一瞬で終わる）。何も打たずに Enter を押すと、選んでいるセリフを再生する。
// 追加モード：通常＝再生位置に入れるだけ／追記＝入れたセリフの末尾まで進む（続けて打てる）／連結＝同じトラックの直前のセリフを延ばしてつなぐ

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {TextInput} from '@astryxdesign/core/TextInput';
import {ClipboardPaste, CornerDownLeft, UserPen} from 'lucide-react';
import {IconButton} from '@astryxdesign/core/IconButton';
import {addLine, getState, lineInsertPoint, setInputMode, setState, useStore, type InputMode} from '../store';
import {synthesize, type Notify} from '../actions';
import {play} from '../preview/playback';
import {captionLayerFor, framesToTimecode, lineOf, overlappingLines, trackCode} from '../model';

const MODES: {value: InputMode; short: string; label: string; description: string}[] = [
  {value: 'normal', short: '通常', label: '通常', description: '再生位置に入れるだけ'},
  {value: 'append', short: '追記', label: '追記', description: '入れたセリフの末尾まで進む（続けて打てる）'},
  {value: 'join', short: '連結', label: '連結', description: '同じトラックの直前のセリフを延ばして、すき間なくつなぐ'},
];

export function ScriptBar({notify}: {notify: Notify}) {
  const project = useStore(s => s.project);
  const characterId = useStore(s => s.selectedCharacterId);
  const mode = useStore(s => s.inputMode);
  // 再生位置・内容が変わったら、入る時刻の案内を出し直す
  useStore(s => s.playhead);
  const [text, setText] = useState('');
  if (!project) return null;
  const current = characterId && project.characters.some(c => c.id === characterId) ? characterId : (project.characters[0]?.id ?? '');
  // 置く先（音声トラック・字幕の映像トラック。足りなければ追加時に作る）
  const at = (id: string | undefined, fallback: string) => (id ? trackCode(project, id) : fallback);
  const layer = current ? `${at(project.tracks[captionLayerFor(project, current)]?.id, 'レイヤー 1')}` : '';
  // 入る時刻も出す（クリックで再生位置が動いても、どこに入るか分かるように）
  const insertAt = current ? framesToTimecode(lineInsertPoint(current), project.video.fps) : '';
  const m = MODES.find(x => x.value === mode)!;

  const submit = () => {
    const t = text.trim();
    if (!t) {
      // 何も打たずに Enter：選んでいるセリフを頭から再生（YMM4 と同じ）
      const s = getState();
      const c = s.project
        ? lineOf(
            s.project,
            s.project.clips.find(x => x.id === s.selectedClipId),
          )
        : undefined;
      if (c?.type === 'voice') {
        setState({playhead: c.start});
        void play();
      }
      return;
    }
    if (!current) return;
    const id = addLine(current, t);
    setText('');
    void synthesize(notify, [id]).then(() => {
      // 合成で長さが決まってから、ほかのキャラクターのセリフと重なっていないか確かめる
      const p = getState().project;
      if (p && overlappingLines(p).has(id)) notify('ほかのキャラクターのセリフと時間が重なっています（タイムラインの赤い枠）。字幕も重なって表示されます', 'info');
    });
  };

  return (
    <HStack gap={1} vAlign="center" padding={2} className="vx-scriptbar">
      <Selector
        label="話すキャラクター"
        isLabelHidden
        variant="secondary"
        size="sm"
        width={160}
        value={current}
        options={project.characters.map(c => ({value: c.id, label: c.name}))}
        onChange={v => setState({selectedCharacterId: v})}
      />
      <IconButton
        label="キャラクター設定"
        tooltip="キャラクター設定（声・字幕・立ち絵・トラック）"
        variant="ghost"
        size="sm"
        icon={<Icon icon={UserPen} />}
        onClick={() => setState({characterDialogOpen: true, dialogCharacterId: current})}
      />
      <DropdownMenu button={{label: `入れ方：${m.short}`, tooltip: `入れ方を切り替え（いまは「${m.label}」：${m.description}）`, variant: 'ghost', size: 'sm'}} hasChevron menuWidth={300}>
        <DropdownMenuRadioGroup label="入れ方" value={mode} onChange={v => setInputMode(v as InputMode)}>
          {MODES.map(x => (
            <DropdownMenuRadioItem key={x.value} value={x.value} label={x.label} description={x.description} />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenu>
      <div
        style={{flex: 1, minWidth: 0}}
        data-script-input
        onPasteCapture={e => {
          // 何行もある文を貼ったら、台本読み込みで開く
          const pasted = e.clipboardData.getData('text');
          if (/\n\s*\S/.test(pasted.trim())) {
            e.preventDefault();
            setState({pasteOpen: true, pasteText: pasted});
          }
        }}>
        <TextInput label="新しいセリフ" isLabelHidden size="sm" placeholder={`セリフを入力（Enter で${layer} の ${insertAt} に追加）`} value={text} onChange={setText} onEnter={submit} width="100%" />
      </div>
      <IconButton
        label="台本読み込み"
        tooltip="台本読み込み（ツール → 台本読み込み）"
        variant="ghost"
        size="sm"
        icon={<Icon icon={ClipboardPaste} />}
        onClick={() => setState({pasteOpen: true, pasteText: text.includes('\n') ? text : ''})}
      />
      <Button label="追加" size="sm" icon={<Icon icon={CornerDownLeft} />} onClick={submit} isDisabled={!text.trim()} />
    </HStack>
  );
}
