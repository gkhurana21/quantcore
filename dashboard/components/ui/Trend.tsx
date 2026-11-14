'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Wraps a headline value: when `value` changes it tints green (it went up) or red (it went down) and
 * settles over ~600 ms. Colour only — the text keeps its box, so nothing shifts. Reduced motion is
 * handled by the global animation override.
 */
export function Trend({ value, text, children, className }: { value: number; text?: string; children: ReactNode; className?: string }) {
  const prev = useRef(value);
  const prevText = useRef(text);
  const [tint, setTint] = useState<{ up: boolean; n: number } | null>(null);
  useEffect(() => {
    const before = prev.current;
    const sameText = text !== undefined && text === prevText.current;   // changed by less than the display shows
    prev.current = value;
    prevText.current = text;
    if (sameText || value === before || !Number.isFinite(value) || !Number.isFinite(before)) return;
    setTint(t => ({ up: value > before, n: (t?.n ?? 0) + 1 }));
  }, [value, text]);
  return (
    <span key={tint?.n ?? 0} className={[className, tint ? (tint.up ? 'tint-up' : 'tint-down') : ''].filter(Boolean).join(' ') || undefined}>
      {children}
    </span>
  );
}
