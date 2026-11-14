'use client';

import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

const grid = (v: number, step: number) => +(Math.round(v / step) * step).toFixed(6);

/**
 * Drag sideways on a value to change it — one step every `pxPerStep` pixels, committed as the
 * pointer moves, with the drag anchored to the value it started from so a slow drag never drifts.
 * A press that never moves is a click, which is what opens the control's panel; touch is left to
 * scroll the strip. Keyboard users get the panel's slider, so this stays a pointer shortcut.
 */
export function useScrub({ value, min, max, step, pxPerStep = 6, onChange, onClick }: {
  value: number; min: number; max: number; step: number; pxPerStep?: number;
  onChange: (v: number) => void; onClick: () => void;
}) {
  const from = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    from.current = { x: e.clientX, v: value, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const f = from.current;
    if (!f) return;
    const dx = e.clientX - f.x;
    if (!f.moved) {
      if (Math.abs(dx) < 3) return;
      f.moved = true;
      setScrubbing(true);
    }
    const next = Math.min(max, Math.max(min, grid(f.v + Math.round(dx / pxPerStep) * step, step)));
    if (next !== value) onChange(next);
  };

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const f = from.current;
    from.current = null;
    setScrubbing(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (f && !f.moved) onClick();
  };

  return {
    scrubbing,
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  };
}
