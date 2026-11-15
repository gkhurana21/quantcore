'use client';

import { useEffect } from 'react';
import s from './layout.module.css';

export interface ToastMessage { id: number; text: string; undo?: () => void; }

/** A short status line with an optional Undo, announced politely and gone after `ms`. */
export function Toast({ toast, onDone, ms = 5000 }: { toast: ToastMessage | null; onDone: () => void; ms?: number }) {
  const id = toast?.id;
  useEffect(() => {
    if (id == null) return;
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [id, ms, onDone]);

  if (!toast) return null;
  return (
    <div className={s.toast} role="status" aria-live="polite" data-testid="toast">
      <span>{toast.text}</span>
      {toast.undo && (
        <button type="button" className={s.toastUndo} data-testid="toast-undo"
                onClick={() => { toast.undo?.(); onDone(); }}>
          Undo
        </button>
      )}
    </div>
  );
}
