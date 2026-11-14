'use client';

import { useEffect, useRef } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { Icon } from '@/components/ui/Icon';
import { PortfolioUpload } from './PortfolioUpload';
import io from './io.module.css';

/**
 * Importing a book is a task, not a panel: it opens over the terminal, shows the file row by row
 * with its errors, and closes when the positions are applied or thrown away. The file input itself
 * stays mounted so a drop anywhere in the terminal can open this with a preview already in it.
 */
export function ImportDialog({ open, onOpen, onClose, market, symbol, onApply }: {
  open: boolean; onOpen: () => void; onClose: () => void;
  market: Market; symbol: string; onApply: (legs: Leg[], label: string) => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className={io.dialog} aria-label="Import a portfolio" onCancel={onClose} onClose={() => { if (!ref.current?.open) onClose(); }}
            onClick={e => { if (e.target === ref.current) onClose(); }}>
      <div className={io.dialogInner}>
        <div className={io.dialogHead}>
          <h2 className={io.dialogTitle}>Import a portfolio</h2>
          <span className={io.dialogMeta}>CSV, XLSX or XLS — parsed in this tab</span>
          <button type="button" className={io.dialogClose} onClick={onClose} aria-label="Close the importer">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className={io.dialogBody}>
          <PortfolioUpload market={market} symbol={symbol} onFile={onOpen}
                           onApply={(legs, label) => { onApply(legs, label); onClose(); }}
                           onDiscard={onClose} />
        </div>
      </div>
    </dialog>
  );
}
