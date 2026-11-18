// 画面分割：選んだ 2〜4 個の素材を、型を選んで枠に収める（はみ出す分は真ん中を残して切り抜く）。

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {getNotify} from '../actions';
import type {Clip} from '../model';
import {textImage, shapeImage} from '../preview/visual';
import {commit, getState, setState, useStore} from '../store';
import {SPLIT_LAYOUTS, layoutsFor, splitPlacement, splittable, type SplitLayout} from '../split';

/** 型の小さな絵 */
function LayoutIcon({layout, active}: {layout: SplitLayout; active: boolean}) {
  return (
    <svg viewBox="0 0 64 36" width={64} height={36} aria-hidden>
      <rect x={0.5} y={0.5} width={63} height={35} rx={3} fill="none" stroke="currentColor" opacity={0.4} />
      {SPLIT_LAYOUTS[layout].cells.map((c, i) => (
        <rect key={i} x={c.x * 64 + 2} y={c.y * 36 + 2} width={c.w * 64 - 4} height={c.h * 36 - 4} rx={2} fill="currentColor" opacity={active ? 0.35 + i * 0.15 : 0.2 + i * 0.1} />
      ))}
    </svg>
  );
}

/** 素材のもとの大きさ（画素） */
function sizeOf(c: Clip): [number, number] | null {
  if (c.type === 'media') {
    const m = getState().media[c.src];
    return m?.width && m?.height ? [m.width, m.height] : null;
  }
  if (c.type === 'text') {
    const img = textImage(c);
    return [img.width, img.height];
  }
  if (c.type === 'shape') {
    const img = shapeImage(c);
    return [img.width, img.height];
  }
  return null;
}

export function SplitDialog() {
  const isOpen = useStore(s => s.splitOpen);
  const ids = useStore(s => {
    const p = s.project;
    if (!p) return '';
    const sel = s.selectedClipIds.length ? s.selectedClipIds : s.selectedClipId ? [s.selectedClipId] : [];
    return sel.filter(id => p.clips.some(c => c.id === id && splittable(c))).join(',');
  });
  const [order, setOrder] = useState(0);
  const [gap, setGap] = useState(8);
  const [layout, setLayout] = useState<SplitLayout | null>(null);
  const close = () => setState({splitOpen: false});
  const list = ids ? ids.split(',') : [];
  const n = list.length;
  const choices = layoutsFor(n);
  const chosen = layout && choices.includes(layout) ? layout : (choices[0] ?? null);
  // 並び（どの素材をどの枠に入れるか）を回す
  const rotated = list.map((_, i) => list[(i + order) % Math.max(1, n)]);

  const apply = () => {
    const p = getState().project;
    if (!p || !chosen) return;
    const clips = rotated.map(id => p.clips.find(c => c.id === id)!);
    const sizes = clips.map(sizeOf);
    if (sizes.some(s => !s)) {
      getNotify()('大きさの分からない素材があります。素材を読み込んでから、もう一度選んでください', 'error');
      return;
    }
    // テキスト・図形は切り抜けないので、枠に収める
    const place = splitPlacement(chosen, sizes as [number, number][], p.video, gap);
    commit(pr => ({
      ...pr,
      clips: pr.clips.map(c => {
        const i = rotated.indexOf(c.id);
        if (i < 0) return c;
        const pl = place[i];
        if (c.type === 'media') return {...c, transform: {...c.transform, ...pl.transform}, crop: pl.crop ?? undefined};
        if (c.type === 'text' || c.type === 'shape') {
          const [w, h] = sizes[i]!;
          const cell = SPLIT_LAYOUTS[chosen].cells[i];
          const s = Math.min((cell.w * p.video.width - gap * 2) / w, (cell.h * p.video.height - gap * 2) / h);
          return {...c, transform: {...c.transform, x: pl.transform.x, y: pl.transform.y, scale: Math.max(0.01, Math.round(s * 1e4) / 1e4)}};
        }
        return c;
      }),
    }));
    getNotify()(`${n} 個を「${SPLIT_LAYOUTS[chosen].label}」に並べました`);
    close();
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={o => !o && close()} width={460} purpose="form">
      <DialogHeader title="画面分割" onOpenChange={o => !o && close()} />
      <VStack gap={3} padding={4}>
        {n < 2 || n > 4 ? (
          <Text type="supporting">タイムラインで、並べたい画像・動画を 2〜4 個選んでから開いてください（Ctrl を押しながらクリックで選び足せます）。いま選んでいるのは {n} 個です</Text>
        ) : (
          <>
            <Text type="supporting">{`選んだ ${n} 個を枠に収めます。はみ出す分は真ん中を残して切り抜きます`}</Text>
            <HStack gap={2} wrap="wrap" data-split-layouts>
              {choices.map(k => (
                <button key={k} type="button" className="vx-split-choice" aria-pressed={chosen === k} data-layout={k} onClick={() => setLayout(k)}>
                  <LayoutIcon layout={k} active={chosen === k} />
                  <span>{SPLIT_LAYOUTS[k].label}</span>
                </button>
              ))}
            </HStack>
            <Slider label="すき間" value={gap} min={0} max={60} step={1} valueDisplay="text" formatValue={v => `${v}px`} onChange={(v: number) => setGap(v)} />
            <HStack gap={2} vAlign="center">
              <Text type="supporting" style={{flex: 1}}>
                {`左上の枠から：${rotated
                  .map(id => {
                    const c = getState().project?.clips.find(x => x.id === id);
                    return c?.type === 'media' ? (c.src.split(/[\\/]/).pop() ?? '') : c?.type === 'text' ? c.text.slice(0, 8) : '図形';
                  })
                  .join('、')}`}
              </Text>
              <Button label="入れ替える" size="sm" variant="ghost" onClick={() => setOrder(o => (o + 1) % n)} />
            </HStack>
          </>
        )}
        <HStack gap={2} hAlign="end">
          <Button label="キャンセル" variant="ghost" onClick={close} />
          <Button label="並べる" variant="primary" isDisabled={!chosen || n < 2 || n > 4} onClick={apply} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
