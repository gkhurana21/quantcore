// The terminal's keyboard shortcuts, in one table.
//
// The key handler, the command palette's key hints and the shortcuts sheet all read SHORTCUTS, so what the
// documentation says and what the keys do cannot drift apart. resolveShortcut() is a pure function from a key
// event and the state of the page to an action, which keeps the rules (no firing while typing, none while an
// overlay is open, none with a modifier but Shift) unit-testable without a browser.

export type ShortcutAction =
  | { type: 'workspace'; index: number }          // 0-based: Build is 0
  | { type: 'step'; dir: 1 | -1 }                 // previous / next workspace, wrapping
  | { type: 'palette'; query?: string }           // the command palette, optionally pre-filtered
  | { type: 'shortcuts' }
  | { type: 'market' }
  | { type: 'surface' }
  | { type: 'import' }
  | { type: 'resetMarket' }
  | { type: 'newDraw' }
  | { type: 'intro' };

export type ShortcutGroup = 'Move' | 'Find' | 'Open' | 'Act';

export interface Shortcut {
  /** Stable name; the palette command that does the same thing looks its key hint up by this. */
  id: string;
  group: ShortcutGroup;
  label: string;
  /** `event.key` values that trigger it (letters lower case). */
  keys: readonly string[];
  /** What the keycap(s) in the sheet and the palette read. */
  display: readonly string[];
  /** Needs Ctrl or ⌘. Everything else is a bare key, which the single-key switch turns off. */
  chord?: boolean;
  act: (key: string) => ShortcutAction;
}

export const WORKSPACE_KEYS = ['1', '2', '3', '4', '5', '6', '7'] as const;

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'workspace', group: 'Move', label: 'Switch workspace: 1 Build, 2 Price, 3 Simulate, 4 Exotics, 5 Stress, 6 Risk, 7 Engine',
    keys: WORKSPACE_KEYS, display: ['1–7'], act: k => ({ type: 'workspace', index: Number(k) - 1 }) },
  { id: 'prev', group: 'Move', label: 'Previous workspace', keys: ['['], display: ['['], act: () => ({ type: 'step', dir: -1 }) },
  { id: 'next', group: 'Move', label: 'Next workspace', keys: [']'], display: [']'], act: () => ({ type: 'step', dir: 1 }) },

  { id: 'palette-chord', group: 'Find', label: 'Command palette: tickers, presets, scenarios, actions',
    keys: ['k'], display: ['⌘K', 'Ctrl K'], chord: true, act: () => ({ type: 'palette' }) },
  { id: 'palette', group: 'Find', label: 'Command palette (same)', keys: ['/'], display: ['/'], act: () => ({ type: 'palette' }) },
  { id: 'presets', group: 'Find', label: 'Strategy presets', keys: ['p'], display: ['P'], act: () => ({ type: 'palette', query: 'Presets' }) },
  { id: 'shortcuts', group: 'Find', label: 'This list of shortcuts', keys: ['?'], display: ['?'], act: () => ({ type: 'shortcuts' }) },

  { id: 'market', group: 'Open', label: 'Market controls: spot, volatility, rate, dividend', keys: ['m'], display: ['M'], act: () => ({ type: 'market' }) },
  { id: 'surface', group: 'Open', label: 'Volatility surface', keys: ['v'], display: ['V'], act: () => ({ type: 'surface' }) },
  { id: 'import', group: 'Open', label: 'Import a portfolio file', keys: ['i'], display: ['I'], act: () => ({ type: 'import' }) },

  { id: 'reset', group: 'Act', label: 'Reset the market to its reference (undo for 5 s)', keys: ['r'], display: ['R'], act: () => ({ type: 'resetMarket' }) },
  { id: 'draw', group: 'Act', label: 'New Monte Carlo draw', keys: ['n'], display: ['N'], act: () => ({ type: 'newDraw' }) },
  { id: 'intro', group: 'Act', label: 'Show or hide the intro band', keys: ['t'], display: ['T'], act: () => ({ type: 'intro' }) },
];

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Move', 'Find', 'Open', 'Act'];

/** The keycap text for a shortcut, as the palette shows it (the first alternative). */
export function keyHint(id: string): string | undefined {
  return SHORTCUTS.find(s => s.id === id)?.display[0];
}

/** The slice of a keyboard event the resolver reads, so tests can pass a plain object. */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

export interface KeyContext {
  /** Focus is in a text field, select, textarea or contenteditable region. */
  typing: boolean;
  /** The palette, a sheet or a dialog is open. */
  overlayOpen: boolean;
  /** The single-key switch (WCAG 2.1.4). Off leaves only the ⌘K / Ctrl+K chord. */
  singleKeys: boolean;
}

export const TYPING_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Is focus in a text field? A field inside a dialog that has just closed still holds focus for a frame
 * (the browser repairs focus on the next render), and nobody is typing into it, so it does not count.
 */
export function isTypingTarget(target: { closest?: (selector: string) => unknown } | null | undefined): boolean {
  if (!target?.closest) return false;
  return !!target.closest(TYPING_SELECTOR) && !target.closest('dialog:not([open])');
}

/** An open native dialog (the palette, the importer, this list) or a sheet that is not hidden. */
export const OVERLAY_SELECTOR = 'dialog[open], [role="dialog"]:not([hidden])';

/**
 * Read from the page at the moment of the key press, not from React state: a state flag lags a dialog that has
 * just closed itself on Escape, and the next key would be swallowed.
 */
export function overlayIsOpen(doc: { querySelector(selector: string): unknown } = document): boolean {
  return !!doc.querySelector(OVERLAY_SELECTOR);
}

/**
 * What a key press should do, or null to leave it alone.
 *
 *  - The ⌘K / Ctrl+K chord always works, in a field or over an overlay, and with the single-key switch off.
 *  - A bare key is ignored while typing, while an overlay is open, with Ctrl, ⌘ or Alt held, on key repeat, and
 *    when the single-key switch is off. Shift is allowed for symbols (`?` is Shift+/) but not on a letter, so
 *    Shift+R does not reset the market; Caps Lock sends no Shift, so its capitals still work.
 *  - Escape is not handled here: the dialogs and the sheet close themselves on it.
 */
export function resolveShortcut(e: KeyLike, ctx: KeyContext): ShortcutAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = !!(e.metaKey || e.ctrlKey);
  if (e.altKey || e.repeat) return null;
  if (mod) {
    const chord = SHORTCUTS.find(s => s.chord && s.keys.includes(key));
    return chord ? chord.act(key) : null;
  }
  if (!ctx.singleKeys || ctx.typing || ctx.overlayOpen) return null;
  if (e.shiftKey && /^[a-z]$/.test(key)) return null;
  const hit = SHORTCUTS.find(s => !s.chord && s.keys.includes(key));
  return hit ? hit.act(key) : null;
}

/** The workspace the step key lands on, wrapping at both ends. */
export function stepIndex(current: number, dir: 1 | -1, count: number): number {
  return (current + dir + count) % count;
}

// ── the single-key switch, stored per browser ────────────────────────────────

export const SINGLE_KEYS_STORAGE = 'qc-single-keys';

/** Stored value → switch state. Anything but an explicit "off" means on, which is the default. */
export function parseSingleKeys(raw: string | null | undefined): boolean {
  return raw !== 'off';
}

export function readSingleKeys(): boolean {
  try { return parseSingleKeys(window.localStorage.getItem(SINGLE_KEYS_STORAGE)); } catch { return true; }
}

export function writeSingleKeys(on: boolean): void {
  try { window.localStorage.setItem(SINGLE_KEYS_STORAGE, on ? 'on' : 'off'); } catch { /* the switch still works for this visit */ }
}
