'use client';

import { useEffect, useRef } from 'react';
import { Icon } from '@/components/ui/Icon';
import { SHORTCUT_GROUPS, SHORTCUTS } from '@/lib/shortcuts';
import s from './layout.module.css';

/**
 * Every shortcut, grouped, read from the same table the key handler reads. A modal dialog, so Escape closes it
 * and focus returns to where it was. The switch at the foot turns the single-key shortcuts off (WCAG 2.1.4):
 * ⌘K and Escape keep working either way.
 */
export function ShortcutsDialog({ open, onClose, singleKeys, onSingleKeys }: {
  open: boolean; onClose: () => void; singleKeys: boolean; onSingleKeys: (on: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={dialog} className={s.shortcutsDialog} aria-label="Keyboard shortcuts" data-testid="shortcuts-dialog"
            onCancel={onClose} onClose={() => { if (!dialog.current?.open) onClose(); }} onClick={e => { if (e.target === dialog.current) onClose(); }}>
      <div className={s.shortcuts}>
        <div className={s.shortcutsHead}>
          <h2 className={s.shortcutsTitle}>Keyboard shortcuts</h2>
          <button type="button" className={s.sheetClose} style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close the shortcuts">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className={s.shortcutsBody} tabIndex={0} role="region" aria-label="All shortcuts">
          {SHORTCUT_GROUPS.map(group => (
            <section key={group} aria-label={group}>
              <h3 className={s.shortcutsGroup}>{group}</h3>
              <ul className={s.shortcutsList}>
                {SHORTCUTS.filter(x => x.group === group).map(x => (
                  <li key={x.id} className={s.shortcutsRow} data-testid={`shortcut-${x.id}`}>
                    <span className={s.shortcutsLabel}>{x.label}</span>
                    <span className={s.shortcutsKeys}>
                      {x.display.map((k, i) => (
                        <span key={k} style={{ display: 'contents' }}>
                          {i > 0 && 'or'}
                          <kbd className={s.kbd}>{k}</kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
                {group === 'Act' && (
                  <li className={s.shortcutsRow}>
                    <span className={s.shortcutsLabel}>Close any sheet or dialog</span>
                    <span className={s.shortcutsKeys}><kbd className={s.kbd}>Esc</kbd></span>
                  </li>
                )}
              </ul>
            </section>
          ))}
        </div>

        <div className={s.shortcutsSwitchRow}>
          <span className={s.shortcutsSwitchText} id="single-key-label">
            <strong>Single-key shortcuts</strong>
            Keys that fire without a modifier. They never fire while you type in a field. Off leaves only ⌘K and Esc.
          </span>
          <button type="button" role="switch" className={s.switch} aria-checked={singleKeys} aria-labelledby="single-key-label"
                  data-testid="single-key-switch" onClick={() => onSingleKeys(!singleKeys)} />
        </div>
      </div>
    </dialog>
  );
}
