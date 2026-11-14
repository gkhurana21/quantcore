'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import s from './layout.module.css';

export interface Command {
  id: string;
  group: string;
  label: string;
  meta?: string;
  /** One or two characters in the leading square — a ticker, a number key, an arrow. */
  glyph: string;
  keywords?: string;
  testid?: string;
  run: () => void;
}

const matches = (c: Command, q: string) => {
  if (!q) return true;
  const hay = `${c.label} ${c.group} ${c.meta ?? ''} ${c.keywords ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every(t => hay.includes(t));
};

/**
 * ⌘K: everything the terminal can do, by name — workspaces, presets, tickers, scenarios and the
 * guided examples that used to sit in a row of "try this" buttons under the bar.
 */
export function CommandPalette({ open, onClose, commands }: {
  open: boolean; onClose: () => void; commands: Command[];
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const shown = useMemo(() => commands.filter(c => matches(c, query)).slice(0, 40), [commands, query]);
  const groups = useMemo(() => {
    const out: { group: string; items: Command[] }[] = [];
    for (const c of shown) {
      const last = out[out.length - 1];
      if (last && last.group === c.group) last.items.push(c);
      else out.push({ group: c.group, items: [c] });
    }
    return out;
  }, [shown]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
      d.showModal();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <dialog ref={dialog} className={s.paletteDialog} aria-label="Command palette"
            onClose={onClose}
            onClick={e => { if (e.target === dialog.current) onClose(); }}>
      <div className={s.palette}>
        <div className={s.paletteHead}>
          <Icon name="search" size={16} />
          <input ref={input} className={s.paletteInput} value={query} placeholder="Search tickers, presets, scenarios, actions…"
                 aria-label="Search the terminal" autoComplete="off" spellCheck={false}
                 onChange={e => setQuery(e.target.value)}
                 onKeyDown={e => {
                   if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(shown.length - 1, a + 1)); }
                   else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
                   else if (e.key === 'Enter') { e.preventDefault(); run(shown[active]); }
                 }} />
          <kbd className={s.navKey}>esc</kbd>
        </div>

        <div className={s.paletteList} role="listbox" aria-label="Results">
          {groups.map(g => (
            <div key={g.group}>
              <div className={s.paletteGroup}>{g.group}</div>
              {g.items.map(c => {
                const i = shown.indexOf(c);
                return (
                  <button key={c.id} type="button" role="option" aria-selected={i === active}
                          data-testid={c.testid} className={s.paletteItem}
                          onPointerMove={() => setActive(i)} onClick={() => run(c)}>
                    <span className={s.paletteIcon} aria-hidden="true">{c.glyph}</span>
                    <span className={s.paletteLabel}>{c.label}</span>
                    {c.meta && <span className={s.paletteMeta}>{c.meta}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!shown.length && <p className={s.paletteEmpty}>Nothing matches “{query}”. Try a ticker, a preset or a scenario.</p>}
        </div>

        <div className={s.paletteFoot}>
          <span>↑ ↓ move</span><span>↵ run</span><span>1–7 switch workspace</span>
        </div>
      </div>
    </dialog>
  );
}
