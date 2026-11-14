// PSD 立ち絵の設定（YMM4 の PSD 立ち絵と同じ考え方）：
// レイヤーの表示・非表示でいつもの姿を決め、目 [開・半目・閉] と口 [閉・半開き・開] に使うレイヤーを選ぶと、目パチ・口パクが付く。
// 表情は「いつもの姿から、どのレイヤーの表示を変えるか」として登録する。名前の先頭が「*」のレイヤーは同じグループで 1 つだけ、「!」はいつも表示。

import {Hint} from '../Hint';
import {useEffect, useMemo, useRef, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Heading} from '@astryxdesign/core/Heading';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {ChevronDown, ChevronRight, FileImage, Plus, RotateCcw, Trash2, Wand2} from 'lucide-react';
import type {Character, Expression, Portrait, PsdPortrait, VoiceClip} from '../model';
import {lineBaseExpression} from '../model';
import {setPortrait, updateClip, useStore} from '../store';
import {getNotify} from '../actions';
import {allNodes, autoAssign, effectiveVisibility, forgetPsd, isChoiceGroup, loadPsdDoc, nodePath, renderThumb, stateVisibility} from '../psd/portrait';
import type {PsdDoc, PsdNode, Visibility} from '../psd/types';
import {api} from '../ipc';

const effective = effectiveVisibility;

/** PSD を選んで、キャラクターの立ち絵にする（目と口は名前から自動で割り当てる） */
export async function pickPsdPortrait(character: Character, projectHeight: number) {
  const a = await api;
  const path = await a.pickPsd();
  if (!path) return;
  const notify = getNotify();
  try {
    const projectPath = (await import('../store')).getState().projectPath;
    forgetPsd(path);
    const {doc} = await loadPsdDoc(path, projectPath);
    const auto = autoAssign(doc);
    const found = [...auto.eyes, ...auto.mouth].filter(Boolean).length;
    const old = character.portrait;
    // 画面の高さの 9 割に収まる大きさで、右寄りに置く
    const scale = Math.min(1, Number(((projectHeight * 0.9) / doc.height).toFixed(3)));
    const pt: Portrait = {
      base: '',
      eyes: [null, null, null],
      mouth: [null, null, null],
      transform: old?.transform ?? {x: 560, y: Math.round(projectHeight * 0.05), scale, opacity: 1},
      visible: true,
      expressions: old?.psd ? old.expressions : [],
      psd: {src: path, visibility: {}, ...auto},
    };
    if (!old?.transform) pt.transform.scale = scale;
    setPortrait(character.id, pt);
    // まだ立ち絵アイテムが無ければ、全体にわたるアイテムを 1 つ置く（すぐ見えるように）
    const st = await import('../store');
    const placed = !st.getState().project?.clips.some(c => c.type === 'portrait' && c.characterId === character.id) && st.addPortraitItem(character.id, {whole: true});
    const parts = found ? `目と口のパーツを ${found} か所、名前から割り当てました` : '目と口に使うパーツを選んでください';
    notify(`PSD を読み込みました。${parts}${placed ? '。タイムラインに立ち絵アイテムを置きました' : ''}`);
  } catch (e) {
    notify(`PSD を読み込めませんでした：${String(e).replace(/^Error:\s*/, '')}`, 'error');
  }
}

export function PsdPortraitEditor({character}: {character: Character}) {
  const pt = character.portrait!;
  const psd = pt.psd!;
  const projectPath = useStore(s => s.projectPath);
  const projectHeight = useStore(s => s.project?.video.height ?? 1080);
  const [doc, setDoc] = useState<PsdDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** どの表示を編集しているか：いつもの姿（-1）か、表情の番号 */
  const [target, setTarget] = useState(-1);
  /** 見本で見る目・口の状態 */
  const [peek, setPeek] = useState<{eyes: number; mouth: number}>({eyes: 0, mouth: 0});

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError(null);
    loadPsdDoc(psd.src, projectPath).then(
      l => alive && setDoc(l.doc),
      e => alive && setError(String(e).replace(/^Error:\s*/, '')),
    );
    return () => {
      alive = false;
    };
  }, [psd.src, projectPath]);

  const set = (patch: Partial<PsdPortrait>) => setPortrait(character.id, {...pt, psd: {...psd, ...patch}});
  const setPt = (patch: Partial<Portrait>) => setPortrait(character.id, {...pt, ...patch});
  const ex: Expression | undefined = target >= 0 ? pt.expressions[target] : undefined;
  if (target >= pt.expressions.length && target !== -1) setTarget(-1);

  const layerOptions = useMemo(() => (doc ? [{value: '', label: '（使わない）'}, ...allNodes(doc).map(n => ({value: n.id, label: nodePath(doc, n.id)}))] : []), [doc]);

  if (error) {
    return (
      <VStack gap={3}>
        <Banner status="error" title="PSD を読み込めません" description={`${error}（${psd.src}）`} />
        <Button label="PSD を選び直す" icon={<Icon icon={FileImage} />} onClick={() => void pickPsdPortrait(character, projectHeight)} />
      </VStack>
    );
  }
  if (!doc) return <Text type="supporting">PSD を読み込んでいます…</Text>;

  // 今編集している表示（いつもの姿、または表情）
  const editVis: Visibility = ex ? {...psd.visibility, ...(ex.visibility ?? {})} : psd.visibility;
  const shownVis = stateVisibility(doc, psd, ex, peek.eyes, peek.mouth);
  const eff = effective(doc, editVis);
  const toggle = (n: PsdNode) => {
    const now = eff.get(n.id) ?? n.visible;
    // 表示にする変更。差分の選択肢のグループ（ポーズ・口・目など）なら、兄弟は隠す
    const patch: Visibility = {[n.id]: !now};
    const parent = n.parent ? doc.byId.get(n.parent) : undefined;
    if (!now && parent && (n.radio || isChoiceGroup(parent))) for (const sib of parent.children) if (sib.id !== n.id && !sib.forced) patch[sib.id] = false;
    if (ex) {
      const v = {...(ex.visibility ?? {})};
      // いつもの姿と同じに戻したものは、表情の設定から消す（いつもの姿を変えたとき付いてくるように）
      const base = effective(doc, psd.visibility);
      for (const [id, on] of Object.entries(patch)) {
        if ((base.get(id) ?? doc.byId.get(id)?.visible) === on) delete v[id];
        else v[id] = on;
      }
      setPt({expressions: pt.expressions.map((e, i) => (i === target ? {...e, visibility: v} : e))});
    } else {
      set({visibility: {...psd.visibility, ...patch}});
    }
  };
  const part = (kind: 'eyes' | 'mouth', i: number, v: string) => {
    const list = [...psd[kind]] as PsdPortrait['eyes'];
    list[i] = v || null;
    set({[kind]: list});
  };
  const eyesL = ['目（開）', '目（半目）', '目（閉）'];
  const mouthL = ['口（閉）', '口（半開き）', '口（開）'];

  return (
    <VStack gap={4}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <VStack gap={0}>
          <Text type="label">PSD</Text>
          <Text type="supporting" maxLines={1}>
            {psd.src.split(/[\\/]/).pop()}（{doc.width}×{doc.height}・パーツ {allNodes(doc).length}）
          </Text>
        </VStack>
        <Button label="選び直す" size="sm" variant="ghost" icon={<Icon icon={FileImage} />} onClick={() => void pickPsdPortrait(character, projectHeight)} />
      </HStack>

      <Thumb doc={doc} vis={shownVis} />
      <HStack gap={2} wrap="wrap">
        {/* 目も口も「開 → 半 → 閉」の同じ並びで（中の値の順は目と口で違う） */}
        <HStack gap={1} vAlign="center">
          <Text type="label">目</Text>
          <SegmentedControl label="見本の目" size="sm" value={String(peek.eyes)} onChange={v => setPeek(p => ({...p, eyes: Number(v)}))}>
            <SegmentedControlItem value="0" label="開" />
            <SegmentedControlItem value="1" label="半目" />
            <SegmentedControlItem value="2" label="閉" />
          </SegmentedControl>
        </HStack>
        <HStack gap={1} vAlign="center">
          <Text type="label">口</Text>
          <SegmentedControl label="見本の口" size="sm" value={String(peek.mouth)} onChange={v => setPeek(p => ({...p, mouth: Number(v)}))}>
            <SegmentedControlItem value="2" label="開" />
            <SegmentedControlItem value="1" label="半開き" />
            <SegmentedControlItem value="0" label="閉" />
          </SegmentedControl>
        </HStack>
      </HStack>

      <VStack gap={2}>
        <HStack hAlign="between" vAlign="center">
          <Heading level={4}>目パチ・口パク</Heading>
          <Button
            label="名前から自動で割り当て"
            size="sm"
            variant="ghost"
            icon={<Icon icon={Wand2} />}
            onClick={() => {
              const a = autoAssign(doc);
              set(a);
              getNotify()(`${[...a.eyes, ...a.mouth].filter(Boolean).length} か所を割り当てました`);
            }}
          />
        </HStack>
        <Hint>それぞれに使うパーツ（PSD のレイヤー）を選びます。選んだパーツのうち、今の状態のものだけが表示されます。半目・半開きが無ければ「使わない」のままで大丈夫です。</Hint>
        {eyesL.map((l, i) => (
          <Selector key={l} label={l} value={psd.eyes[i] ?? ''} options={layerOptions} hasSearch onChange={v => part('eyes', i, v)} width="100%" />
        ))}
        {[2, 1, 0].map(i => (
          <Selector key={mouthL[i]} label={mouthL[i]} value={psd.mouth[i] ?? ''} options={layerOptions} hasSearch onChange={v => part('mouth', i, v)} width="100%" />
        ))}
      </VStack>

      <VStack gap={2}>
        <Heading level={4}>表情</Heading>
        <Hint>表情を選んでからパーツの表示を変えると、その表情だけの変更になります。セリフごとに表情を選べます。</Hint>
        <HStack gap={1} wrap="wrap">
          <Button label="いつもの姿" size="sm" variant={target === -1 ? 'primary' : 'secondary'} onClick={() => setTarget(-1)} />
          {pt.expressions.map((e, i) => (
            <Button key={i} label={e.name || `表情 ${i + 1}`} size="sm" variant={target === i ? 'primary' : 'secondary'} onClick={() => setTarget(i)} />
          ))}
          <IconButton
            label="表情を足す"
            tooltip="表情を足す"
            size="sm"
            variant="ghost"
            icon={<Icon icon={Plus} />}
            onClick={() => {
              const e: Expression = {name: `表情 ${pt.expressions.length + 1}`, base: null, eyes: [null, null, null], mouth: [null, null, null], visibility: {}};
              setPt({expressions: [...pt.expressions, e]});
              setTarget(pt.expressions.length);
            }}
          />
        </HStack>
        {ex && (
          <HStack gap={2} vAlign="end">
            <div style={{flex: 1, minWidth: 0}}>
              <TextInput label="表情の名前" value={ex.name} onChange={name => setPt({expressions: pt.expressions.map((e, i) => (i === target ? {...e, name} : e))})} />
            </div>
            <IconButton
              label="この表情を消す"
              tooltip="この表情を消す"
              variant="ghost"
              icon={<Icon icon={Trash2} />}
              onClick={() => {
                setPt({expressions: pt.expressions.filter((_, i) => i !== target)});
                setTarget(-1);
              }}
            />
          </HStack>
        )}
      </VStack>

      <VStack gap={1}>
        <HStack hAlign="between" vAlign="center">
          <Heading level={4}>{ex ? `パーツ（${ex.name}）` : 'パーツ（いつもの姿）'}</Heading>
          <Button
            label={ex ? 'いつもの姿と同じに' : 'PSD のままに戻す'}
            size="sm"
            variant="ghost"
            icon={<Icon icon={RotateCcw} />}
            onClick={() => (ex ? setPt({expressions: pt.expressions.map((e, i) => (i === target ? {...e, visibility: {}} : e))}) : set({visibility: {}}))}
          />
        </HStack>
        <LayerTree doc={doc} eff={eff} changed={ex ? (ex.visibility ?? {}) : psd.visibility} onToggle={toggle} />
      </VStack>
    </VStack>
  );
}

/**
 * セリフの間だけのレイヤーの表示（YMM4 のセリフの「立ち絵」→ レイヤー）。
 * もとになる表情（セリフで選んだ表情か、立ち絵アイテムの既定の表情）から、変えたところだけを残す
 */
export function LinePsdLayers({character, clip}: {character: Character; clip: VoiceClip}) {
  const pt = character.portrait!;
  const psd = pt.psd!;
  const projectPath = useStore(s => s.projectPath);
  const project = useStore(s => s.project)!;
  const [doc, setDoc] = useState<PsdDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError(null);
    loadPsdDoc(psd.src, projectPath).then(
      l => alive && setDoc(l.doc),
      e => alive && setError(String(e).replace(/^Error:\s*/, '')),
    );
    return () => {
      alive = false;
    };
  }, [psd.src, projectPath]);
  if (error) return <Banner status="error" title="PSD を読み込めません" description={error} />;
  if (!doc) return <Text type="supporting">PSD を読み込んでいます…</Text>;
  const baseIdx = lineBaseExpression(project, character, clip);
  const baseEx = baseIdx > 0 ? pt.expressions[baseIdx - 1] : undefined;
  const baseVis: Visibility = {...psd.visibility, ...(baseEx?.visibility ?? {})};
  const lineVis: Visibility = clip.portrait?.visibility ?? {};
  const eff = effective(doc, {...baseVis, ...lineVis});
  const setVis = (visibility: Visibility) => updateClip(clip.id, {portrait: {...(clip.portrait ?? {}), visibility}});
  const toggle = (n: PsdNode) => {
    const now = eff.get(n.id) ?? n.visible;
    const patch: Visibility = {[n.id]: !now};
    const parent = n.parent ? doc.byId.get(n.parent) : undefined;
    if (!now && parent && (n.radio || isChoiceGroup(parent))) for (const sib of parent.children) if (sib.id !== n.id && !sib.forced) patch[sib.id] = false;
    // もとの表情と同じに戻したものは消す（表情を変えたとき付いてくるように）
    const base = effective(doc, baseVis);
    const v = {...lineVis};
    for (const [id, on] of Object.entries(patch)) {
      if ((base.get(id) ?? doc.byId.get(id)?.visible) === on) delete v[id];
      else v[id] = on;
    }
    setVis(v);
  };
  const shown = stateVisibility(doc, psd, {name: '', base: null, eyes: [null, null, null], mouth: [null, null, null], visibility: {...(baseEx?.visibility ?? {}), ...lineVis}}, 0, 0);
  const n = Object.keys(lineVis).length;
  return (
    <VStack gap={2}>
      <Thumb doc={doc} vis={shown} />
      <HStack hAlign="between" vAlign="center">
        <Text type="supporting">
          {baseEx ? `「${baseEx.name}」` : 'いつもの姿'}から{n ? ` ${n} か所変えています` : '変えていません'}
        </Text>
        <Button label="もとに戻す" size="sm" variant="ghost" icon={<Icon icon={RotateCcw} />} isDisabled={!n} onClick={() => setVis({})} />
      </HStack>
      <LayerTree doc={doc} eff={eff} changed={lineVis} onToggle={toggle} />
    </VStack>
  );
}

/** 今の表示での見本（縮めて描く。表示を変えたら少し待ってから描き直す） */
function Thumb({doc, vis}: {doc: PsdDoc; vis: Visibility}) {
  const ref = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(vis);
  useEffect(() => {
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const c = renderThumb(doc, vis, 480);
      c.className = 'vx-psd-thumb-canvas';
      el.replaceChildren(c);
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key]);
  return <div ref={ref} className="vx-psd-thumb" aria-label="立ち絵の見本" />;
}

/** レイヤーの一覧（グループはたためる）。チェックで表示・非表示。「*」は丸、「!」はいつも表示 */
function LayerTree({doc, eff, changed, onToggle}: {doc: PsdDoc; eff: Map<string, boolean>; changed: Visibility; onToggle: (n: PsdNode) => void}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const rows: {n: PsdNode; depth: number}[] = [];
  const walk = (ns: PsdNode[], depth: number) => {
    for (const n of ns) {
      rows.push({n, depth});
      if (n.kind === 'group' && !closed.has(n.id)) walk(n.children, depth + 1);
    }
  };
  walk(doc.nodes, 0);
  return (
    <ul className="vx-psd-tree" role="tree" aria-label="PSD のパーツ">
      {rows.map(({n, depth}) => {
        const on = eff.get(n.id) ?? n.visible;
        return (
          <li
            key={n.id}
            role="treeitem"
            aria-expanded={n.kind === 'group' ? !closed.has(n.id) : undefined}
            className="vx-psd-row"
            style={{paddingInlineStart: 4 + depth * 14}}
            data-changed={n.id in changed || undefined}>
            {n.kind === 'group' ? (
              <button
                type="button"
                className="vx-psd-fold"
                aria-label={closed.has(n.id) ? '開く' : 'たたむ'}
                onClick={() =>
                  setClosed(s => {
                    const x = new Set(s);
                    if (x.has(n.id)) x.delete(n.id);
                    else x.add(n.id);
                    return x;
                  })
                }>
                <Icon icon={closed.has(n.id) ? ChevronRight : ChevronDown} size="sm" />
              </button>
            ) : (
              <span className="vx-psd-fold" />
            )}
            <input
              type={n.radio ? 'radio' : 'checkbox'}
              checked={on}
              disabled={n.forced}
              aria-label={`${n.name} を表示`}
              onChange={() => onToggle(n)}
              onClick={e => (e.currentTarget.type === 'radio' && on ? (e.preventDefault(), onToggle(n)) : undefined)}
            />
            <span className="vx-psd-name" title={n.name}>
              {n.name || '（名前なし）'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
