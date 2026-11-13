// プレビューの下の操作バー（一般的な動画編集ソフトと同じ並び）
// 左：先頭へ・1 コマ戻る・再生/停止・1 コマ進む・末尾へ・ループ
// 中：現在位置 / 全体の長さ（再生速度が 1 倍以外なら速度も）
// 右：表示倍率・プレビュー画質・セーフエリア・全画面

import {useEffect, useRef, useState, type RefObject} from 'react';
import {DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuDivider, DropdownMenuRadioGroup, DropdownMenuRadioItem} from '@astryxdesign/core/DropdownMenu';
import {isTauri} from '../ipc';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {ToggleButton} from '@astryxdesign/core/ToggleButton';
import {Maximize, Minimize, Pause, Play, Repeat, SquareDashed, SkipBack, SkipForward, SlidersHorizontal, StepBack, StepForward} from 'lucide-react';
import {framesToTimecode, projectDuration} from '../model';
import {getState, setState, useStore} from '../store';
import {jumpTo, step, toggle} from './playback';
import './preview.css';

/**
 * 全画面：プレビュー（映像＋操作バー）を画面いっぱいに出す。
 * Tauri ではウィンドウ自体を全画面にし、ブラウザでは Fullscreen API を使う。Esc でやめる
 */
export async function toggleFullscreen(_el?: HTMLElement | null) {
  const next = !getState().previewFull;
  setState({previewFull: next});
  try {
    if (isTauri) {
      const {getCurrentWindow} = await import('@tauri-apps/api/window');
      await getCurrentWindow().setFullscreen(next);
    } else if (next) {
      await document.documentElement.requestFullscreen?.();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch {
    // ウィンドウを全画面にできなくても、プレビューは画面いっぱいに出ている
  }
}

const ZOOMS: {value: string; label: string}[] = [
  {value: 'fit', label: '全体'},
  {value: '0.25', label: '25%'},
  {value: '0.5', label: '50%'},
  {value: '1', label: '100%'},
  {value: '2', label: '200%'},
];
const QUALITIES: {value: string; label: string}[] = [
  {value: '1', label: 'フル画質'},
  {value: '0.5', label: '1/2 画質'},
  {value: '0.25', label: '1/4 画質'},
];

export function PreviewControls({fullscreenTarget}: {fullscreenTarget: RefObject<HTMLDivElement | null>}) {
  const project = useStore(s => s.project);
  const playhead = useStore(s => s.playhead);
  const isPlaying = useStore(s => s.isPlaying);
  const playRate = useStore(s => s.playRate);
  const loop = useStore(s => s.loop);
  const zoom = useStore(s => s.previewZoom);
  const quality = useStore(s => s.previewQuality);
  const safe = useStore(s => s.showSafeArea);
  const isFull = useStore(s => s.previewFull);
  // パネルの幅に合わせて詰める（配置を自由に変えられるので、狭い枠にも置かれる）
  const barRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mid = width < 640;
  const small = width < 440;
  useEffect(() => {
    // ブラウザの全画面を Esc などでやめたら、こちらも戻す
    const on = () => {
      if (!document.fullscreenElement && getState().previewFull && !isTauri) setState({previewFull: false});
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  if (!project) return null;
  const fps = project.video.fps;
  const rateLabel = isPlaying && playRate !== 1 ? (playRate < 0 ? `◀ ${-playRate}×` : `${playRate}×`) : null;

  return (
    <div ref={barRef} className="vx-preview-controls" role="toolbar" aria-label="再生の操作">
      <div className="vx-pc-group">
        {!small && <IconButton label="先頭へ" tooltip="先頭へ（Home）" variant="ghost" size="sm" icon={<Icon icon={SkipBack} />} onClick={() => jumpTo('start')} />}
        <IconButton label="1 コマ戻る" tooltip="1 コマ戻る（←）" variant="ghost" size="sm" icon={<Icon icon={StepBack} />} onClick={() => step(-1)} />
        <IconButton
          label={isPlaying ? '停止' : '再生'}
          tooltip={isPlaying ? '停止（Space / K）' : '再生（Space / L）'}
          variant="secondary"
          icon={<Icon icon={isPlaying ? Pause : Play} />}
          onClick={toggle}
        />
        <IconButton label="1 コマ進む" tooltip="1 コマ進む（→）" variant="ghost" size="sm" icon={<Icon icon={StepForward} />} onClick={() => step(1)} />
        {!small && <IconButton label="末尾へ" tooltip="末尾へ（End）" variant="ghost" size="sm" icon={<Icon icon={SkipForward} />} onClick={() => jumpTo('end')} />}
        {!small && <ToggleButton label="ループ再生" tooltip="ループ再生" size="sm" icon={<Icon icon={Repeat} />} isIconOnly isPressed={loop} onPressedChange={v => setState({loop: v})} />}
      </div>

      <div className="vx-pc-time" aria-live="off">
        <Text type="code" hasTabularNumbers>
          {framesToTimecode(playhead, fps)}
        </Text>
        {!small && (
          <Text type="supporting" hasTabularNumbers>
            / {framesToTimecode(projectDuration(project), fps)}
          </Text>
        )}
        {rateLabel && <span className="vx-pc-rate">{rateLabel}</span>}
      </div>

      <div className="vx-pc-group">
        {mid ? (
          <DropdownMenu
            button={{
              label: '表示の設定',
              tooltip: '表示倍率・画質・セーフエリア',
              variant: 'ghost',
              size: 'sm',
              isIconOnly: true,
              icon: <Icon icon={SlidersHorizontal} />,
            }}
            hasChevron={false}
            menuWidth={220}>
            <DropdownMenuRadioGroup label="表示倍率" value={zoom === 'fit' ? 'fit' : String(zoom)} onChange={v => setState({previewZoom: v === 'fit' ? 'fit' : Number(v)})}>
              {ZOOMS.map(z => (
                <DropdownMenuRadioItem key={z.value} value={z.value} label={`表示 ${z.label}`} />
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuDivider />
            <DropdownMenuRadioGroup label="プレビュー画質" value={String(quality)} onChange={v => setState({previewQuality: Number(v) as 1 | 0.5 | 0.25})}>
              {QUALITIES.map(q => (
                <DropdownMenuRadioItem key={q.value} value={q.value} label={`画質 ${q.label}`} />
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuDivider />
            <DropdownMenuCheckboxItem label="セーフエリアを表示" value={safe} onChange={v => setState({showSafeArea: v})} />
            {small && <DropdownMenuCheckboxItem label="ループ再生" value={loop} onChange={v => setState({loop: v})} />}
          </DropdownMenu>
        ) : (
          <>
            <Selector
              label="表示倍率"
              isLabelHidden
              size="md"
              variant="ghost"
              width={104}
              value={zoom === 'fit' ? 'fit' : String(zoom)}
              options={ZOOMS}
              onChange={v => setState({previewZoom: v === 'fit' ? 'fit' : Number(v)})}
            />
            <Selector
              label="プレビュー画質（書き出しには影響しません）"
              isLabelHidden
              size="md"
              variant="ghost"
              width={128}
              value={String(quality)}
              options={QUALITIES}
              onChange={v => setState({previewQuality: Number(v) as 1 | 0.5 | 0.25})}
            />
            <ToggleButton
              label="セーフエリアを表示"
              tooltip="セーフエリアを表示"
              size="sm"
              icon={<Icon icon={SquareDashed} />}
              isIconOnly
              isPressed={safe}
              onPressedChange={v => setState({showSafeArea: v})}
            />
          </>
        )}
        <IconButton
          label={isFull ? '全画面をやめる' : '全画面で見る'}
          tooltip={isFull ? '全画面をやめる（Esc）' : '全画面で見る（プレビューをダブルクリックでも）'}
          variant="ghost"
          size="md"
          icon={<Icon icon={isFull ? Minimize : Maximize} />}
          onClick={() => void toggleFullscreen(fullscreenTarget.current)}
        />
      </div>
    </div>
  );
}
