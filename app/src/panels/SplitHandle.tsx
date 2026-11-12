// プレビューとタイムラインの境目。ドラッグか、フォーカスして ↑↓ で高さを変えられる。

import {useRef} from 'react';

export function SplitHandle({value, min, max, onChange}: {value: number; min: number; max: number; onChange: (v: number) => void}) {
  const drag = useRef<{y: number; v: number} | null>(null);
  return (
    <div
      className="vx-split"
      role="separator"
      aria-orientation="horizontal"
      aria-label="プレビューとタイムラインの境目"
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      onPointerDown={e => {
        drag.current = {y: e.clientY, v: value};
        (e.target as Element).setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (!drag.current) return;
        // 上へ動かすとタイムラインが高くなる
        onChange(Math.min(max, Math.max(min, drag.current.v - (e.clientY - drag.current.y))));
      }}
      onPointerUp={() => (drag.current = null)}
      onKeyDown={e => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowUp') onChange(Math.min(max, value + step));
        else if (e.key === 'ArrowDown') onChange(Math.max(min, value - step));
        else return;
        e.preventDefault();
      }}>
      <span className="vx-split-pill" />
    </div>
  );
}
