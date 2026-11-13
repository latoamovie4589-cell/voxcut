// パネルを並べて表示し、タブのドラッグで組み替えられるようにする（Premiere Pro と同じ操作）。
// - タブを別の枠の中央へ：その枠のタブになる。枠の上下左右の端へ：枠を分けて置く。タブの並びの上：その位置に入る
// - 枠の境目をドラッグ（または矢印キー）で大きさを変える
// - タブのダブルクリックか ` キーで、その枠を最大化／元に戻す
// - 枠の右上の ≡ から、閉じる・最大化・ワークスペースのリセット
// HTML5 のドラッグ＆ドロップは Windows の Tauri では使えない（ファイルのドロップと取り合う）ので、ポインターで実装する。

import {Fragment, useEffect, useRef, useState, type ReactNode} from 'react';
import {DropdownMenu, DropdownMenuDivider, DropdownMenuItem} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {ChevronsRight, Menu} from 'lucide-react';
import {DropdownMenuRadioGroup, DropdownMenuRadioItem} from '@astryxdesign/core/DropdownMenu';
import {canFloat, floatPanel} from '../sync';
import {
  PANEL_TITLE,
  closePanel,
  dockPanel,
  applyWorkspace,
  PRESETS,
  dockToEdge,
  getDock,
  groups,
  panelsIn,
  resetWorkspace,
  setActive,
  setDock,
  setSizes,
  toggleMaximize,
  updateRoot,
  useDock,
  type DockNode,
  type Group,
  type PanelId,
  type Split,
  type Zone,
} from './layout';
import './dock.css';

export type PanelDef = {
  render: () => ReactNode;
  /** 中身が長いパネルは枠の中でスクロールする（プレビュー・タイムラインは自分でスクロールを持つ） */
  scroll?: boolean;
  /** タブに注意の印（●）を付けるか */
  useAlert?: () => boolean;
};
export type Registry = Record<PanelId, PanelDef>;

type Drop = {groupId: string; zone: Zone; index?: number; rect: DOMRect};
type Drag = {pid: PanelId; x: number; y: number; drop: Drop | null};

const MIN_PX = 120;
/** Esc でドラッグをやめた（指を離すまで、ドロップしない） */
let dragCancelled = false;

/** Alt+Shift+数字で切り替えるワークスペースの並び（メニューと同じ順） */
export function workspaceOrder(): string[] {
  return [...PRESETS.map(p => p.id), ...getDock().saved.map(x => x.name)];
}
/** 画面全体の端に置くときの目印（ドロップ先の groupId） */
const ROOT = '__root__';
/** 画面全体の端と見なす幅（px） */
const EDGE_PX = 22;
/** 画面全体の端に置いた枠の大きさ（全体に対する割合） */
const ROOT_SHARE = 0.22;

export function Dock({panels}: {panels: Registry}) {
  const root = useDock(s => s.root);
  const maximized = useDock(s => s.maximized);
  const [drag, setDrag] = useState<Drag | null>(null);

  // ` キー：最後に触った枠を最大化／元に戻す（入力欄の中では効かない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+Shift+1〜9：ワークスペースを切り替える（Premiere Pro と同じ）
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
        const ws = workspaceOrder()[Number(e.code.slice(5)) - 1];
        if (ws) {
          e.preventDefault();
          applyWorkspace(ws);
        }
        return;
      }
      if (e.key !== '`' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)) return;
      const s = getDock();
      const target = s.maximized ?? s.focused ?? groups(s.root)[0]?.id ?? null;
      e.preventDefault();
      toggleMaximize(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ドラッグ中の Esc：やめる
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      dragCancelled = true;
      setDrag(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag]);

  const shown = maximized ? groups(root).find(x => x.id === maximized) : null;
  return (
    <div className="vx-dock" data-dragging={drag ? '' : undefined}>
      {/* ドラッグ中だけ、画面全体の端に置ける場所を示す */}
      {drag &&
        !maximized &&
        (['left', 'right', 'top', 'bottom'] as const).map(z => (
          <div key={z} className="vx-dock-edge" data-edge={z} data-active={(drag.drop?.groupId === ROOT && drag.drop.zone === z) || undefined} aria-hidden />
        ))}
      {shown ? <GroupFrame group={shown} panels={panels} drag={drag} setDrag={setDrag} /> : <NodeView node={root} panels={panels} drag={drag} setDrag={setDrag} />}
      {drag?.drop && <div className="vx-dock-drop" aria-hidden style={dropStyle(drag.drop)} />}
      {drag && (
        <div className="vx-dock-ghost" aria-hidden style={{left: drag.x + 12, top: drag.y + 10}}>
          {PANEL_TITLE[drag.pid]}
        </div>
      )}
    </div>
  );
}

/** ドロップ先の見た目：置いたあとに占める場所を青く示す */
function dropStyle(d: Drop): React.CSSProperties {
  const r = d.rect;
  // 画面全体の端なら細い帯（ROOT_SHARE）、枠の端なら半分
  const f = d.groupId === ROOT ? ROOT_SHARE : 0.5;
  const half = {left: r.left, top: r.top, width: r.width, height: r.height};
  if (d.zone === 'left') half.width = r.width * f;
  if (d.zone === 'right') {
    half.left = r.left + r.width * (1 - f);
    half.width = r.width * f;
  }
  if (d.zone === 'top') half.height = r.height * f;
  if (d.zone === 'bottom') {
    half.top = r.top + r.height * (1 - f);
    half.height = r.height * f;
  }
  return {position: 'fixed', ...half};
}

type ViewProps = {
  panels: Registry;
  drag: Drag | null;
  setDrag: (d: Drag | null) => void;
};

function NodeView({node, ...rest}: ViewProps & {node: DockNode}) {
  return node.kind === 'group' ? <GroupFrame group={node} {...rest} /> : <SplitView split={node} {...rest} />;
}

function SplitView({split, ...rest}: ViewProps & {split: Split}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="vx-dock-split" data-dir={split.dir}>
      {split.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <Splitter split={split} index={i - 1} containerRef={ref} />}
          <div className="vx-dock-cell" style={{flex: `${split.sizes[i]} 1 0px`}}>
            <NodeView node={c} {...rest} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** 枠の境目。ドラッグか ←→（上下に並ぶときは ↑↓）で、両側の大きさを変える */
function Splitter({split, index, containerRef}: {split: Split; index: number; containerRef: React.RefObject<HTMLDivElement | null>}) {
  const start = useRef<{pos: number; sizes: number[]; total: number} | null>(null);
  const row = split.dir === 'row';
  const move = (deltaPx: number, base: number[], total: number) => {
    const sizes = [...base];
    const pair = sizes[index] + sizes[index + 1];
    const minFrac = Math.min(pair / 2, MIN_PX / Math.max(1, total));
    const a = Math.max(minFrac, Math.min(pair - minFrac, sizes[index] + deltaPx / Math.max(1, total)));
    sizes[index] = a;
    sizes[index + 1] = pair - a;
    updateRoot(r => setSizes(r, split.id, sizes));
  };
  const totalPx = () => {
    const el = containerRef.current;
    return el ? (row ? el.clientWidth : el.clientHeight) : 1;
  };
  const a = split.sizes[index];
  const b = split.sizes[index + 1];
  return (
    <div
      className="vx-dock-splitter"
      data-dir={split.dir}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="枠の大きさを変える"
      aria-valuenow={Math.round((a / (a + b)) * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={e => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = {
          pos: row ? e.clientX : e.clientY,
          sizes: split.sizes,
          total: totalPx(),
        };
      }}
      onPointerMove={e => {
        const s = start.current;
        if (!s) return;
        move((row ? e.clientX : e.clientY) - s.pos, s.sizes, s.total);
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onKeyDown={e => {
        const dec = row ? 'ArrowLeft' : 'ArrowUp';
        const inc = row ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== dec && e.key !== inc) return;
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 80 : 20;
        move(e.key === inc ? step : -step, split.sizes, totalPx());
      }}
    />
  );
}

/** ポインターの下のドロップ先を探す */
function findDrop(x: number, y: number): Drop | null {
  // 画面全体の端（EDGE_PX 以内）：上から下まで・左から右まで通しで置く（Premiere Pro と同じ）
  const dock = document.querySelector<HTMLElement>('.vx-dock');
  if (dock && !getDock().maximized) {
    const d = dock.getBoundingClientRect();
    const near: [Zone, number][] = [
      ['left', x - d.left],
      ['right', d.right - x],
      ['top', y - d.top],
      ['bottom', d.bottom - y],
    ];
    near.sort((a, b) => a[1] - b[1]);
    if (near[0][1] >= -4 && near[0][1] < EDGE_PX && x >= d.left - 4 && x <= d.right + 4 && y >= d.top - 4 && y <= d.bottom + 4) {
      return {groupId: ROOT, zone: near[0][0], rect: d};
    }
  }
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const frame = el?.closest<HTMLElement>('[data-dock-group]');
  if (!frame) return null;
  const groupId = frame.dataset.dockGroup!;
  const tabs = frame.querySelector<HTMLElement>('[data-dock-tabs]');
  const tr = tabs?.getBoundingClientRect();
  const rect = frame.getBoundingClientRect();
  // タブの並びの上：その位置にタブとして入れる
  if (tabs && tr && y >= tr.top && y <= tr.bottom) {
    const items = [...tabs.querySelectorAll<HTMLElement>('[role="tab"]')];
    let index = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    return {groupId, zone: 'center', index, rect};
  }
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const edges: [Zone, number][] = [
    ['left', rx],
    ['right', 1 - rx],
    ['top', ry],
    ['bottom', 1 - ry],
  ];
  edges.sort((p, q) => p[1] - q[1]);
  const zone: Zone = edges[0][1] < 0.25 ? edges[0][0] : 'center';
  return {groupId, zone, rect};
}

function GroupFrame({group, panels, drag, setDrag}: ViewProps & {group: Group}) {
  const focused = useDock(s => s.focused === group.id);
  const maximized = useDock(s => s.maximized === group.id);
  const onlyPanel = useDock(s => panelsIn(s.root).length <= 1);
  const onlyGroup = useDock(s => groups(s.root).length <= 1);
  const press = useRef<{
    pid: PanelId;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const def = panels[group.active];
  const tabsRef = useRef<HTMLDivElement>(null);
  // タブが枠に入りきらないときだけ「»」（隠れたタブの一覧）を出す
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [group.tabs.length]);
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }, [group.active]);
  const focus = () => {
    if (getDock().focused !== group.id) setDock({focused: group.id});
  };

  const onTabDown = (e: React.PointerEvent, pid: PanelId) => {
    if (e.button !== 0) return;
    focus();
    updateRoot(r => setActive(r, group.id, pid));
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragCancelled = false;
    press.current = {pid, x: e.clientX, y: e.clientY, moved: false};
  };
  const onTabMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || dragCancelled) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
    p.moved = true;
    setDrag({
      pid: p.pid,
      x: e.clientX,
      y: e.clientY,
      drop: findDrop(e.clientX, e.clientY),
    });
  };
  const onTabUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (dragCancelled) {
      dragCancelled = false;
      return;
    }
    if (!p?.moved) return;
    const d = findDrop(e.clientX, e.clientY);
    setDrag(null);
    if (d) {
      if (d.groupId === ROOT) {
        if (d.zone !== 'center') updateRoot(r => dockToEdge(r, p.pid, d.zone as Exclude<Zone, 'center'>, ROOT_SHARE));
        setDock({maximized: null});
      } else {
        updateRoot(r => dockPanel(r, p.pid, d.groupId, d.zone, d.index));
        setDock({focused: d.groupId, maximized: null});
      }
    }
  };
  const cancel = () => {
    press.current = null;
    setDrag(null);
  };

  return (
    <section className="vx-dock-group" data-dock-group={group.id} data-focused={focused || undefined} aria-label={PANEL_TITLE[group.active]} onPointerDownCapture={focus} onFocusCapture={focus}>
      <div className="vx-dock-header">
        <div
          ref={tabsRef}
          className="vx-dock-tabs"
          role="tablist"
          data-dock-tabs
          aria-label="パネル（ドラッグで配置を変える）"
          onWheel={e => {
            if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
          }}>
          {group.tabs.map(pid => (
            <TabButton
              key={pid}
              pid={pid}
              def={panels[pid]}
              selected={pid === group.active}
              dragging={drag?.pid === pid}
              onPointerDown={e => onTabDown(e, pid)}
              onPointerMove={onTabMove}
              onPointerUp={onTabUp}
              onPointerCancel={cancel}
              onDoubleClick={() => toggleMaximize(group.id)}
              onKeyDown={e => {
                const i = group.tabs.indexOf(pid);
                const next = e.key === 'ArrowRight' ? group.tabs[i + 1] : e.key === 'ArrowLeft' ? group.tabs[i - 1] : undefined;
                if (next) {
                  e.preventDefault();
                  e.stopPropagation();
                  updateRoot(r => setActive(r, group.id, next));
                  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-dock-group="${group.id}"] [role="tab"][aria-selected="true"]`)?.focus());
                }
              }}
            />
          ))}
        </div>
        {overflow && (
          <DropdownMenu
            button={{label: 'すべてのタブ', tooltip: '入りきらないタブ', variant: 'ghost', size: 'sm', isIconOnly: true, icon: <Icon icon={ChevronsRight} size="sm" />}}
            hasChevron={false}
            menuWidth={200}>
            <DropdownMenuRadioGroup label="パネル" value={group.active} onChange={v => updateRoot(r => setActive(r, group.id, v as PanelId))}>
              {group.tabs.map(t => (
                <DropdownMenuRadioItem key={t} value={t} label={PANEL_TITLE[t]} />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenu>
        )}
        <DropdownMenu
          button={{
            label: `${PANEL_TITLE[group.active]}のメニュー`,
            tooltip: 'パネルのメニュー',
            variant: 'ghost',
            size: 'sm',
            isIconOnly: true,
            icon: <Icon icon={Menu} size="sm" />,
          }}
          hasChevron={false}
          menuWidth={240}>
          <DropdownMenuItem label="パネルを閉じる" isDisabled={onlyPanel} onClick={() => closePanel(group.active)} />
          {group.tabs.length > 1 && <DropdownMenuItem label="ほかのタブを閉じる" onClick={() => group.tabs.filter(t => t !== group.active).forEach(closePanel)} />}
          <DropdownMenuItem label="この枠を閉じる" isDisabled={onlyGroup} onClick={() => group.tabs.forEach(closePanel)} />
          <DropdownMenuItem label="別ウィンドウに切り離す" description="2 台目のモニターに置くなど" isDisabled={!canFloat(group.active)} onClick={() => void floatPanel(group.active)} />
          <DropdownMenuDivider />
          <DropdownMenuItem label={maximized ? '元の大きさに戻す' : '枠を最大化'} endContent={<span className="vx-kbd">`</span>} onClick={() => toggleMaximize(group.id)} />
          <DropdownMenuItem label="ワークスペースをリセット" onClick={resetWorkspace} />
        </DropdownMenu>
      </div>
      <div className="vx-dock-content" data-scroll={def.scroll || undefined} role="tabpanel" id={`vx-panel-${group.id}`} aria-label={PANEL_TITLE[group.active]}>
        {def.render()}
      </div>
    </section>
  );
}

function TabButton({
  pid,
  def,
  selected,
  dragging,
  ...handlers
}: {
  pid: PanelId;
  def: PanelDef;
  selected: boolean;
  dragging: boolean;
} & Pick<React.HTMLAttributes<HTMLButtonElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onDoubleClick' | 'onKeyDown'>) {
  const alert = (def.useAlert ?? noAlert)();
  return (
    <button
      type="button"
      role="tab"
      className="vx-dock-tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-dragging={dragging || undefined}
      title="ドラッグで別の場所へ・ダブルクリックで最大化"
      {...handlers}>
      {PANEL_TITLE[pid]}
      {alert && <span className="vx-dock-alert" aria-label="（要確認）" />}
    </button>
  );
}
const noAlert = () => false;
