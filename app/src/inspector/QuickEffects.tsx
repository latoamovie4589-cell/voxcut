// かんたんエフェクト：一覧から選ぶだけで、登場・退場・動き・画面効果が付く（CapCut と同じ選び方）。
// 中身は「動き・効果」の欄と同じ値を入れているだけなので、選んだあとに下の欄で細かく直せる。書き出しも同じ絵になる。

import {useEffect, useRef} from 'react';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Heading} from '@astryxdesign/core/Heading';
import {VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {Slider} from '@astryxdesign/core/Slider';
import {plainLook, prevAdjacent, transitionFrames, type Effect, type Look, type MotionKind, type Transform, type TransitionKind, type VisualClip} from '../model';
import {play, stop} from '../preview/playback';
import {getState, setState, updateClip, useStore} from '../store';

type Tab = 'in' | 'out' | 'move' | 'fx' | 'trans';
type Ctx = {transform: Transform; look: Look; duration: number; fps: number};
export interface QuickPreset {
  id: string;
  label: string;
  /** 付いているか（付いていれば押すと外れる。「なし」は何も付いていないとき） */
  on: (c: Ctx) => boolean;
  /** 押したときの見た目 */
  apply: (c: Ctx) => Look;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
/** 登場・退場の長さ（半秒。短いアイテムでは長さの 4 割まで） */
const short = (c: Ctx, sec = 0.5) => Math.max(1, Math.min(Math.round(c.fps * sec), Math.floor(c.duration * 0.4)));

function enterPreset(id: string, label: string, kind: MotionKind | null, fade: boolean): QuickPreset {
  return {
    id,
    label,
    on: c => (c.look.enter?.kind ?? null) === kind && c.look.fadeIn > 0 === fade,
    apply: c => ({...c.look, enter: kind ? {kind, frames: short(c)} : null, fadeIn: fade ? short(c) : 0}),
  };
}
function exitPreset(id: string, label: string, kind: MotionKind | null, fade: boolean): QuickPreset {
  return {
    id,
    label,
    on: c => (c.look.exit?.kind ?? null) === kind && c.look.fadeOut > 0 === fade,
    apply: c => ({...c.look, exit: kind ? {kind, frames: short(c)} : null, fadeOut: fade ? short(c) : 0}),
  };
}

/** アイテムの長さいっぱいを使う動き。今の位置・大きさを始まりにして、そこからの差で作る */
type Move = {
  ease: 'linear' | 'in' | 'out' | 'inOut';
  to: {dx?: number; dy?: number; scale?: number; rot?: number};
  mid?: {at: number; dx?: number; dy?: number; scale?: number; rot?: number};
};
const shifted = (t: Transform, d: {dx?: number; dy?: number; scale?: number}): Transform => ({
  x: Math.round(t.x + (d.dx ?? 0)),
  y: Math.round(t.y + (d.dy ?? 0)),
  scale: Math.round(t.scale * (d.scale ?? 1) * 1000) / 1000,
  opacity: t.opacity,
});
const sameT = (a: Transform, b: Transform) => near(a.x, b.x) && near(a.y, b.y) && near(a.scale, b.scale) && near(a.opacity, b.opacity);
function movePreset(id: string, label: string, m: Move | null): QuickPreset {
  const make = (c: Ctx): Look['anim'] =>
    m
      ? {
          to: shifted(c.transform, m.to),
          rotation: c.look.rotation + (m.to.rot ?? 0),
          ease: m.ease,
          mid: m.mid ? {at: m.mid.at, transform: shifted(c.transform, m.mid), rotation: c.look.rotation + (m.mid.rot ?? 0)} : null,
        }
      : null;
  return {
    id,
    label,
    on: c => {
      const a = c.look.anim;
      const b = make(c);
      if (!a || !b) return !a && !b;
      const midSame = !a.mid && !b.mid ? true : !!a.mid && !!b.mid && near(a.mid.at, b.mid.at) && sameT(a.mid.transform, b.mid.transform) && near(a.mid.rotation, b.mid.rotation);
      return a.ease === b.ease && sameT(a.to, b.to) && near(a.rotation, b.rotation) && midSame;
    },
    apply: c => ({...c.look, anim: make(c)}),
  };
}

/** 画面効果は重ねられる。同じ種類は 1 つだけ（押すと付く・もう一度押すと外れる） */
function fxPreset(id: string, label: string, fx: Effect): QuickPreset {
  const same = (e: Effect) => JSON.stringify(e) === JSON.stringify(fx);
  return {
    id,
    label,
    on: c => (c.look.effects ?? []).some(same),
    apply: c => {
      const list = c.look.effects ?? [];
      return {...c.look, effects: list.some(same) ? list.filter(e => !same(e)) : [...list.filter(e => e.kind !== fx.kind), fx]};
    },
  };
}

/** つなぎ目の切り替え（次の場面＝このアイテムに付ける。長さは前と同じなら引き継ぐ） */
function transPreset(id: string, label: string, kind: TransitionKind | null): QuickPreset {
  return {
    id,
    label,
    on: c => (c.look.transition?.kind ?? null) === kind,
    apply: c => ({...c.look, transition: kind ? {kind, frames: c.look.transition?.frames ?? Math.round(c.fps * 0.6)} : null}),
  };
}

export const QUICK: Record<Tab, QuickPreset[]> = {
  in: [
    enterPreset('in-none', 'なし', null, false),
    enterPreset('in-fade', 'フェード', null, true),
    enterPreset('in-pop', 'ポップ', 'zoom', false),
    enterPreset('in-soft', 'ふわっと', 'zoom', true),
    enterPreset('in-left', '左から', 'slideLeft', false),
    enterPreset('in-right', '右から', 'slideRight', false),
    enterPreset('in-up', '上から', 'slideUp', false),
    enterPreset('in-down', '下から', 'slideDown', false),
  ],
  out: [
    exitPreset('out-none', 'なし', null, false),
    exitPreset('out-fade', 'フェード', null, true),
    exitPreset('out-shrink', 'しぼむ', 'zoom', false),
    exitPreset('out-soft', 'すっと', 'zoom', true),
    exitPreset('out-left', '左へ', 'slideLeft', false),
    exitPreset('out-right', '右へ', 'slideRight', false),
    exitPreset('out-up', '上へ', 'slideUp', false),
    exitPreset('out-down', '下へ', 'slideDown', false),
  ],
  move: [
    movePreset('mv-none', 'なし', null),
    movePreset('mv-zoomin', 'ゆっくり拡大', {ease: 'linear', to: {scale: 1.15}}),
    movePreset('mv-zoomout', 'ゆっくり縮小', {ease: 'linear', to: {scale: 0.87}}),
    movePreset('mv-left', '左へ流れる', {ease: 'linear', to: {dx: -160}}),
    movePreset('mv-right', '右へ流れる', {ease: 'linear', to: {dx: 160}}),
    movePreset('mv-float', '浮かぶ', {ease: 'out', to: {dy: -80}}),
    movePreset('mv-bounce', 'はずむ', {ease: 'out', to: {}, mid: {at: 0.5, dy: -70}}),
    movePreset('mv-beat', 'どきっ', {ease: 'out', to: {}, mid: {at: 0.15, scale: 1.25}}),
    movePreset('mv-tilt', 'かたむく', {ease: 'inOut', to: {}, mid: {at: 0.5, rot: 10}}),
    movePreset('mv-spin', '一回転', {ease: 'inOut', to: {rot: 360}}),
  ],
  fx: [
    {id: 'fx-none', label: 'なし', on: c => !(c.look.effects ?? []).length, apply: c => ({...c.look, effects: []})},
    fxPreset('fx-blur', 'ぼかし', {kind: 'blur', radius: 6}),
    fxPreset('fx-mono', '白黒', {kind: 'mono'}),
    fxPreset('fx-vivid', 'あざやか', {kind: 'color', brightness: 1.05, contrast: 1.1, saturation: 1.5}),
    fxPreset('fx-dark', '暗く', {kind: 'color', brightness: 0.6, contrast: 1, saturation: 0.9}),
    fxPreset('fx-bright', '明るく', {kind: 'color', brightness: 1.3, contrast: 1, saturation: 1}),
    fxPreset('fx-invert', '色の反転', {kind: 'invert'}),
    fxPreset('fx-shake', '揺れ', {kind: 'shake', amount: 8, speed: 6}),
    fxPreset('fx-wave', '波', {kind: 'wave', amount: 12, length: 160, speed: 1}),
    fxPreset('fx-swirl', '渦巻き', {kind: 'swirl', angle: 180}),
  ],
  trans: [
    transPreset('tr-none', 'なし', null),
    transPreset('tr-dissolve', 'ディゾルブ', 'dissolve'),
    transPreset('tr-black', '暗転', 'black'),
    transPreset('tr-white', '白く光る', 'white'),
    transPreset('tr-left', '左へ流す', 'slideLeft'),
    transPreset('tr-right', '右へ流す', 'slideRight'),
    transPreset('tr-up', '上へ流す', 'slideUp'),
    transPreset('tr-down', '下へ流す', 'slideDown'),
    transPreset('tr-zoom', 'ズーム', 'zoom'),
  ],
};

const TAB_LABEL: Record<Tab, string> = {in: '登場', out: '退場', move: '動き', fx: '画面効果', trans: '切り替え'};

let previewTimer = 0;
/** 付けた効果をすぐ見せる：その部分だけを再生して止める */
function previewClip(clip: VisualClip, tab: Tab, fps: number) {
  window.clearTimeout(previewTimer);
  if (getState().isPlaying) stop();
  const end = clip.start + clip.duration;
  const span = Math.round(fps * 1.2);
  // 切り替えはつなぎ目の前後（前の場面の終わりから、次の場面の頭まで）
  const lead = tab === 'trans' ? Math.round(fps * 0.8) : 0;
  const from = tab === 'out' ? Math.max(clip.start, end - span) : Math.max(0, clip.start - lead);
  // 動きはアイテムの長さいっぱい（長くても 4 秒）、ほかは 1 秒と少し
  const frames = tab === 'move' ? Math.min(clip.duration, fps * 4) : tab === 'trans' ? Math.min(end - from, lead * 2 + (clip.look?.transition?.frames ?? 0)) : Math.min(end - from, span);
  setState({playhead: from});
  void play(1);
  previewTimer = window.setTimeout(
    () => {
      if (!getState().isPlaying) return;
      stop();
      // 退場のあとは何も映らないので、効果の真ん中あたりで止める
      setState({playhead: tab === 'out' ? Math.max(clip.start, end - Math.round(span / 2)) : Math.min(end - 1, from + frames)});
    },
    (frames / fps) * 1000 + 80,
  );
}

export function QuickEffects({clip, fps}: {clip: VisualClip; fps: number}) {
  const tab = useStore(s => s.fxTab);
  const setTab = (fxTab: Tab) => setState({fxTab});
  const prev = useStore(s => (s.project ? prevAdjacent(s.project, clip) : null));
  const live = useRef(clip);
  live.current = clip;
  useEffect(() => () => window.clearTimeout(previewTimer), []);
  const ctx: Ctx = {transform: clip.transform, look: {...plainLook(), ...(clip.look ?? {})}, duration: clip.duration, fps};
  return (
    <VStack gap={3} paddingBlock={4} paddingInline={4}>
      <Heading level={3}>かんたんエフェクト</Heading>
      <SegmentedControl label="エフェクトの種類" size="sm" value={tab} onChange={v => setTab(v as Tab)}>
        {(Object.keys(TAB_LABEL) as Tab[]).map(t => (
          <SegmentedControlItem key={t} value={t} label={TAB_LABEL[t]} />
        ))}
      </SegmentedControl>
      <div className="vx-fx-grid" role="group" aria-label={`${TAB_LABEL[tab]}のエフェクト`}>
        {QUICK[tab].map(p => {
          const on = p.on(ctx);
          return (
            <button
              key={p.id}
              type="button"
              className="vx-fx-tile"
              data-fx={p.id}
              aria-pressed={on}
              disabled={tab === 'trans' && !prev && p.id !== 'tr-none'}
              onClick={() => {
                // 「なし」以外は、付いているものをもう一度押すと外れる
                const none = QUICK[tab][0];
                const look = on && p !== none ? (tab === 'fx' ? p.apply(ctx) : none.apply(ctx)) : p.apply(ctx);
                updateClip(clip.id, {look} as Partial<VisualClip>);
                if (!(on && p !== none) && p !== none) previewClip({...live.current, look} as VisualClip, tab, fps);
              }}>
              <span className="vx-fx-demo" aria-hidden>
                <span className="vx-fx-dot" />
              </span>
              <span className="vx-fx-name">{p.label}</span>
            </button>
          );
        })}
      </div>
      {tab === 'trans' && prev && ctx.look.transition && (
        <Slider
          label="切り替えの長さ"
          value={ctx.look.transition.frames}
          min={4}
          max={Math.max(5, Math.floor((Math.min(prev.duration, clip.duration) * 4) / 5))}
          step={1}
          valueDisplay="text"
          formatValue={v => `${Math.round(v)} フレーム`}
          onChange={(frames: number) => updateClip(clip.id, {look: {...ctx.look, transition: {...ctx.look.transition!, frames: Math.round(frames)}}} as Partial<VisualClip>)}
        />
      )}
      <Text type="supporting">
        {tab === 'trans'
          ? prev
            ? `同じレイヤーのすぐ前のアイテムから、このアイテムへ切り替わるときの効果です${ctx.look.transition ? `（実際の長さ ${transitionFrames(ctx.look.transition, prev, clip)} フレーム）` : ''}。`
            : '切り替えは、同じレイヤーで前のアイテムとくっついているときに使えます。2 つの場面を同じレイヤーに並べて置いてください。'
          : tab === 'fx'
            ? '画面効果は重ねて付けられます。強さは下の「映像エフェクト」で直せます。'
            : '押すとすぐ付いて、その部分を再生します。長さや動く量は下の欄で直せます。'}
      </Text>
    </VStack>
  );
}
