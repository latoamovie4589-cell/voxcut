// セリフ入力欄（YMM4 と同じく、タイムラインの一番下）。
// 左からキャラクターの選択・キャラクター設定ボタン・追加モード・セリフ。Enter でキャラクターのトラックの再生位置に追加し、
// すぐ合成を始める（キャッシュがあれば一瞬で終わる）。何も打たずに Enter を押すと、選んでいるセリフを再生する。
// 追加モード：通常＝再生位置に入れるだけ／追記＝入れたセリフの末尾まで進む（続けて打てる）／連結＝同じトラックの直前のセリフを延ばしてつなぐ

import {useEffect, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack} from '@astryxdesign/core/Layout';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {ClipboardPaste, CornerDownLeft, ListEnd, UserPen} from 'lucide-react';
import {IconButton} from '@astryxdesign/core/IconButton';
import {addLine, getState, lineInsertPoint, setInputMode, setState, useStore, type InputMode} from '../store';
import {synthesize, type Notify} from '../actions';
import {play} from '../preview/playback';
import {Avatar} from './Avatar';
import {captionLayerFor, framesToTimecode, lineOf, overlappingLines, trackCode} from '../model';

const MODES: {value: InputMode; short: string; label: string; description: string}[] = [
  {value: 'normal', short: '通常', label: '通常', description: '再生位置に入れるだけ'},
  {value: 'append', short: '追記', label: '追記', description: '入れたセリフの末尾まで進む（続けて打てる）'},
  {value: 'join', short: '連結', label: '連結', description: '同じレイヤーの直前のセリフを延ばして、すき間なくつなぐ'},
];

export function ScriptBar({notify}: {notify: Notify}) {
  const project = useStore(s => s.project);
  const characterId = useStore(s => s.selectedCharacterId);
  const mode = useStore(s => s.inputMode);
  const inputPresets = useStore(s => s.inputPresets);
  // 再生位置・内容が変わったら、入る時刻の案内を出し直す
  useStore(s => s.playhead);
  const [text, setText] = useState('');
  // 欄の幅が狭いときは、選ぶものを細くして、セリフを打つ欄の幅を残す
  const barRef = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  // さらに狭い（800px ほどの窓でプリセットもある）：入れ方は絵だけにする
  const [tight, setTight] = useState(false);
  // Alt+数字で声を切り替えたときに、打つ欄の上に少しだけ出す名前（打っている途中は案内文が見えないので）
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCompact(el.clientWidth < 820);
      setTight(el.clientWidth < 680);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project === null]);
  if (!project) return null;
  const current = characterId && project.characters.some(c => c.id === characterId) ? characterId : (project.characters[0]?.id ?? '');
  // 置く先（音声トラック・字幕の映像トラック。足りなければ追加時に作る）
  const at = (id: string | undefined, fallback: string) => (id ? trackCode(project, id) : fallback);
  const layer = current ? `${at(project.tracks[captionLayerFor(project, current)]?.id, 'レイヤー 1')}` : '';
  // 入る時刻も出す（クリックで再生位置が動いても、どこに入るか分かるように）
  const insertAt = current ? framesToTimecode(lineInsertPoint(current), project.video.fps) : '';
  // 声のプリセット（感情など）。キャラクターを分けなくても、ここで切り替えて足せる
  const presets = project.characters.find(c => c.id === current)?.voicePresets ?? [];
  const presetId = presets.some(x => x.id === inputPresets[current]) ? (inputPresets[current] ?? null) : null;
  // 狭くて選ぶ欄の名前が切れても、どの声で入るかが分かるよう、打つ欄の案内にも出す
  const presetName = presets.find(x => x.id === presetId)?.name ?? null;
  const setPreset = (id: string | null) => setState(s => ({inputPresets: {...s.inputPresets, [current]: id}}));
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
    // 「名前：セリフ」と打ったら、その名前のキャラクターで入れる（以後もそのキャラクターのまま。台本と同じ書き方）
    let who = current;
    let line = t;
    let pre = presetId;
    const m2 = /^(.{1,24}?)[：:]\s*(.+)$/s.exec(t);
    if (m2) {
      const key = m2[1].replace(/\s/g, '');
      const hit = project.characters.find(c => c.name === m2[1] || c.name.replace(/\s/g, '') === key);
      if (hit) {
        who = hit.id;
        line = m2[2].trim();
        pre = hit.id === current ? presetId : (inputPresets[hit.id] ?? null);
        if (hit.id !== current) setState({selectedCharacterId: hit.id});
      }
    }
    const id = addLine(who, line, pre);
    setText('');
    void synthesize(notify, [id]).then(() => {
      // 合成で長さが決まってから、ほかのキャラクターのセリフと重なっていないか確かめる
      const p = getState().project;
      if (p && overlappingLines(p).has(id)) notify('ほかのキャラクターのセリフと時間が重なっています（タイムラインの「⚠ 重なり」の札と、上の辺のしま）。字幕も重なって表示されます', 'info');
    });
  };

  return (
    <HStack ref={barRef} gap={1} vAlign="center" padding={2} className="vx-scriptbar">
      {/* キャラクターが 1 人なら選ぶものがないので、名前だけ出す */}
      {project.characters.length > 1 ? (
        <Selector
          label="話すキャラクター"
          isLabelHidden
          variant="secondary"
          size="sm"
          width={tight ? 112 : compact ? 128 : 160}
          value={current}
          startIcon={<Avatar character={project.characters.find(c => c.id === current)} size={18} />}
          options={project.characters.map(c => ({value: c.id, label: c.name, icon: <Avatar character={c} size={18} />}))}
          onChange={v => setState({selectedCharacterId: v})}
        />
      ) : (
        <div className="vx-scriptbar-char" aria-label="話すキャラクター">
          <Avatar character={project.characters[0]} size={20} />
          <Text type="label" maxLines={1}>
            {project.characters[0]?.name ?? 'キャラクターなし'}
          </Text>
        </div>
      )}
      {presets.length > 0 && (
        <span className="vx-scriptbar-preset" data-hint="声のプリセット。セリフを打ちながら Alt+1〜9 で切り替え、Alt+0 で通常に戻せます" style={{display: 'contents'}}>
          <Selector
            label="声のプリセット"
            isLabelHidden
            variant="secondary"
            size="sm"
            width={tight ? 100 : compact ? 100 : 130}
            value={presetId ?? ''}
            // 選ぶ欄には Alt+数字の番号も出す（打ちながら Alt+1〜9 で切り替えられる）
            options={[{value: '', label: '通常', description: 'Alt+0'}, ...presets.map((x, i) => ({value: x.id, label: x.name, description: i < 9 ? `Alt+${i + 1}` : undefined}))]}
            onChange={v => setPreset(v || null)}
          />
        </span>
      )}
      <IconButton
        label="キャラクター設定"
        tooltip="キャラクター設定（声・字幕・立ち絵・声のプリセット）"
        variant="ghost"
        size="sm"
        icon={<Icon icon={UserPen} />}
        onClick={() => setState({characterDialogOpen: true, dialogCharacterId: current})}
      />
      <DropdownMenu
        button={{
          label: tight ? `入れ方：${m.short}` : compact ? m.short : `入れ方：${m.short}`,
          tooltip: `入れ方を切り替え（いまは「${m.label}」：${m.description}）`,
          variant: 'secondary',
          size: 'sm',
          ...(tight ? {isIconOnly: true, icon: <Icon icon={ListEnd} />} : {}),
        }}
        hasChevron={!tight}
        menuWidth={300}>
        <DropdownMenuRadioGroup label="入れ方" value={mode} onChange={v => setInputMode(v as InputMode)}>
          {MODES.map(x => (
            <DropdownMenuRadioItem key={x.value} value={x.value} label={x.label} description={x.description} />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenu>
      <div
        style={{flex: 1, minWidth: 140, position: 'relative'}}
        data-script-input
        data-hint={current ? `Enter で${layer}の ${insertAt} に追加します。Ctrl+↑↓ で話す人を切り替え、Alt+1〜9 で声のプリセット。「名前：セリフ」と打つとその人で入ります` : undefined}
        onKeyDownCapture={e => {
          // 打ちながら話す人を切り替える：Ctrl+↑↓（⌘+↑↓）で前・次のキャラクター
          if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && project.characters.length > 1) {
            e.preventDefault();
            const list = project.characters;
            const i = Math.max(
              0,
              list.findIndex(c => c.id === current),
            );
            const next = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
            setState({selectedCharacterId: next.id});
            setFlash(`話す人：${next.name}`);
            window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setFlash(null), 1400);
            return;
          }
          // 打ちながら声のプリセットを切り替える：Alt+1〜9 でプリセット、Alt+0 で通常
          if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || !/^Digit\d$/.test(e.code)) return;
          const n = Number(e.code.slice(5));
          const show = (name: string) => {
            setFlash(`声：${name}`);
            window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setFlash(null), 1400);
          };
          if (n === 0) {
            setPreset(null);
            show('通常');
          } else if (presets[n - 1]) {
            setPreset(presets[n - 1].id);
            show(presets[n - 1].name);
          } else {
            e.preventDefault();
            notify(
              presets.length
                ? `Alt+${n} のプリセットはありません（Alt+1〜${Math.min(9, presets.length)} が使えます）`
                : 'このキャラクターには声のプリセットがありません（キャラクター設定の「声」で作れます）',
              'info',
            );
            return;
          }
          e.preventDefault();
        }}
        onPasteCapture={e => {
          // 何行もある文を貼ったら、台本読み込みで開く
          const pasted = e.clipboardData.getData('text');
          if (/\n\s*\S/.test(pasted.trim())) {
            e.preventDefault();
            setState({pasteOpen: true, pasteText: pasted});
          }
        }}>
        {flash && (
          <span className="vx-preset-flash" role="status">
            {flash}
          </span>
        )}
        <TextInput
          label="新しいセリフ"
          isLabelHidden
          size="sm"
          placeholder={
            !current
              ? 'まずキャラクターを作ってください（上の「キャラクター」）'
              : compact
                ? presetName
                  ? `${presetName}：セリフを入力`
                  : 'セリフを入力 → Enter'
                : `${presetName ? `${presetName}で ` : ''}セリフを入力 → Enter で${layer}へ`
          }
          value={text}
          onChange={setText}
          onEnter={submit}
          width="100%"
        />
      </div>
      {/* とても狭いときは、台本読み込みはメニュー（ツール → 台本読み込み）から。「追加」は絵だけにして、打つ欄を広く残す */}
      {!tight && (
        <IconButton
          label="台本読み込み"
          tooltip="台本読み込み（ツール → 台本読み込み）"
          variant="ghost"
          size="sm"
          icon={<Icon icon={ClipboardPaste} />}
          onClick={() => setState({pasteOpen: true, pasteText: text.includes('\n') ? text : ''})}
        />
      )}
      {tight ? (
        <IconButton label="追加" tooltip="追加（Enter）" size="sm" icon={<Icon icon={CornerDownLeft} />} onClick={submit} isDisabled={!text.trim()} />
      ) : (
        <Button label="追加" size="sm" icon={<Icon icon={CornerDownLeft} />} onClick={submit} isDisabled={!text.trim()} />
      )}
    </HStack>
  );
}
