'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import s from './layout.module.css';

/**
 * A panel hung under the chip that opened it. Deliberately not a modal: the terminal keeps
 * updating behind it while a slider moves, which is the point of editing the market here.
 * It stays mounted when closed so a half-typed ticker survives, and closes on Escape or a
 * click outside, returning focus to its chip.
 */
export function Sheet({ open, onClose, title, meta, anchor, width = 420, children, testid }: {
  open: boolean; onClose: () => void; title: string; meta?: ReactNode;
  anchor: HTMLElement | null; width?: number; children: ReactNode; testid?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 16, top: 112 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      const w = Math.min(width, window.innerWidth - 16);
      setPos({
        left: Math.max(8, Math.min(r ? r.left : 16, window.innerWidth - w - 8)),
        top: Math.max(8, (r ? r.bottom : 112) + 6),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, anchor, width]);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
      anchor?.focus({ preventScroll: true });
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); };
  }, [open, onClose, anchor]);

  return (
    <div ref={ref} className={s.sheet} role="dialog" aria-label={title} tabIndex={-1} hidden={!open}
         data-testid={testid} style={{ left: pos.left, top: pos.top, width }}>
      <div className={s.sheetHead}>
        <span className={s.sheetTitle}>{title}</span>
        {meta && <span className={s.sheetMeta}>{meta}</span>}
        <button type="button" className={s.sheetClose} onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className={s.sheetBody}>{children}</div>
    </div>
  );
}
