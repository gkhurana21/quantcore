'use client';

import { useState } from 'react';
import l from './lab.module.css';

/** Integer seed field that commits on blur / Enter. */
export function SeedInput({ value, onChange, testid }: { value: number; onChange: (v: number) => void; testid: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft != null) {
      const n = parseInt(draft, 10);
      if (Number.isFinite(n) && n >= 0) onChange(Math.min(n, 2_147_483_647));
    }
    setDraft(null);
  };
  return (
    <label className={l.seed}>
      Seed
      <input className={l.seedInput} inputMode="numeric" data-testid={testid} value={draft ?? String(value)}
             onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))} onBlur={commit}
             onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
    </label>
  );
}
