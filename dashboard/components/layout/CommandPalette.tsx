'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { keyHint } from '@/lib/shortcuts';
import s from './layout.module.css';

export interface Command {
  id: string;
  group: string;
  label: string;
  meta?: string;
  /** One or two characters in the leading square — a ticker, a number key, an arrow. */
  glyph: string;
  keywords?: string;
  /** The key that does the same thing, shown as a keycap. Read from lib/shortcuts so it cannot drift. */
  hotkey?: string;
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
export function CommandPalette({ open, onClose, commands, initialQuery = '' }: {
  open: boolean; onClose: () => void; commands: Command[];
  /** Text the search box starts with each time the palette opens — "Presets" for the P key. */
  initialQuery?: string;
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
      setQuery(initialQuery);
      setActive(0);
      d.showModal();
      requestAnimationFrame(() => { input.current?.focus(); if (initialQuery) input.current?.select(); });
    }
    if (!open && d.open) d.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the query is read when the palette opens, not when it changes
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    // `close` fires a task after Escape; if the palette was reopened in between, that stale event must not close it again
    <dialog ref={dialog} className={s.paletteDialog} aria-label="Command palette"
            onCancel={onClose} onClose={() => { if (!dialog.current?.open) onClose(); }}
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
                    {c.hotkey && <kbd className={s.kbd} aria-label={`shortcut ${c.hotkey}`}>{c.hotkey}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
          {!shown.length && <p className={s.paletteEmpty}>Nothing matches “{query}”. Try a ticker, a preset or a scenario.</p>}
        </div>

        <div className={s.paletteFoot}>
          <span><kbd className={s.kbd}>↑</kbd><kbd className={s.kbd}>↓</kbd> move</span>
          <span><kbd className={s.kbd}>↵</kbd> run</span>
          <span><kbd className={s.kbd}>{keyHint('workspace')}</kbd> workspace</span>
          <span><kbd className={s.kbd}>{keyHint('shortcuts')}</kbd> all shortcuts</span>
        </div>
      </div>
    </dialog>
  );
}
