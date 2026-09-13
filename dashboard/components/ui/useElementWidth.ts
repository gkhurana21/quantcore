'use client';

import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

/** Rendered width of an element, tracked with ResizeObserver (charts draw at real pixel size). */
export function useElementWidth<T extends HTMLElement>(ref: RefObject<T>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => {
      const next = Math.round(w);
      if (next > 0) setWidth(prev => (prev === next ? prev : next));
    };
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => apply(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
