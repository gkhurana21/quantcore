/**
 * Keyboard shortcuts: the key → action mapping and the rules about when a key is ignored. Pure logic, so it
 * runs in the unit config with no browser. The same behaviour is covered end to end in hotkeys.spec.ts.
 */

import { test, expect } from '@playwright/test';
import {
  SHORTCUTS, isTypingTarget, keyHint, overlayIsOpen, parseSingleKeys, resolveShortcut, stepIndex, WORKSPACE_KEYS,
} from '../lib/shortcuts';
import type { KeyContext, KeyLike } from '../lib/shortcuts';

const FREE: KeyContext = { typing: false, overlayOpen: false, singleKeys: true };
const press = (key: string, extra: Partial<KeyLike> = {}, ctx: Partial<KeyContext> = {}) =>
  resolveShortcut({ key, ...extra }, { ...FREE, ...ctx });

test.describe('shortcut table', () => {
  test('every bare key maps to one action, and no two shortcuts share a key', () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      for (const k of s.keys) {
        const slot = `${s.chord ? 'chord' : 'bare'}:${k}`;
        expect(seen.get(slot), `${slot} is bound twice`).toBeUndefined();
        seen.set(slot, s.id);
      }
      expect(s.display.length, `${s.id} has no keycap`).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  test('the palette reads its key hints from the table', () => {
    expect(keyHint('market')).toBe('M');
    expect(keyHint('surface')).toBe('V');
    expect(keyHint('import')).toBe('I');
    expect(keyHint('reset')).toBe('R');
    expect(keyHint('draw')).toBe('N');
    expect(keyHint('intro')).toBe('T');
    expect(keyHint('shortcuts')).toBe('?');
    expect(keyHint('no-such-shortcut')).toBeUndefined();
  });
});

test.describe('key → action', () => {
  test('1–7 pick a workspace by index', () => {
    WORKSPACE_KEYS.forEach((k, i) => expect(press(k)).toEqual({ type: 'workspace', index: i }));
    expect(press('8')).toBeNull();
    expect(press('0')).toBeNull();
  });

  test('[ and ] step to the previous and next workspace', () => {
    expect(press('[')).toEqual({ type: 'step', dir: -1 });
    expect(press(']')).toEqual({ type: 'step', dir: 1 });
  });

  test('stepping wraps at both ends, and Build is followed by Price', () => {
    expect(stepIndex(0, 1, 7)).toBe(1);        // Build → Price
    expect(stepIndex(6, 1, 7)).toBe(0);        // Engine → Build
    expect(stepIndex(0, -1, 7)).toBe(6);       // Build → Engine
    expect(stepIndex(3, -1, 7)).toBe(2);
  });

  test('the letter and symbol keys', () => {
    expect(press('?', { shiftKey: true })).toEqual({ type: 'shortcuts' });
    expect(press('/')).toEqual({ type: 'palette' });
    expect(press('p')).toEqual({ type: 'palette', query: 'Presets' });
    expect(press('m')).toEqual({ type: 'market' });
    expect(press('v')).toEqual({ type: 'surface' });
    expect(press('i')).toEqual({ type: 'import' });
    expect(press('r')).toEqual({ type: 'resetMarket' });
    expect(press('n')).toEqual({ type: 'newDraw' });
    expect(press('t')).toEqual({ type: 'intro' });
    expect(press('q')).toBeNull();
    expect(press('Enter')).toBeNull();
    expect(press('Escape')).toBeNull();           // dialogs and the sheet close themselves
  });

  test('letters work with Shift or Caps Lock on', () => {
    expect(press('R', { shiftKey: true })).toEqual({ type: 'resetMarket' });
    expect(press('M')).toEqual({ type: 'market' });
  });

  test('⌘K and Ctrl+K open the palette', () => {
    expect(press('k', { metaKey: true })).toEqual({ type: 'palette' });
    expect(press('k', { ctrlKey: true })).toEqual({ type: 'palette' });
    expect(press('K', { metaKey: true })).toEqual({ type: 'palette' });
  });
});

test.describe('when a key is ignored', () => {
  const bare = SHORTCUTS.filter(s => !s.chord).flatMap(s => s.keys);

  test('while typing in a field, no bare key fires', () => {
    for (const k of bare) expect(press(k, {}, { typing: true }), `"${k}" fired while typing`).toBeNull();
  });

  test('while the palette, a sheet or a dialog is open, no bare key fires', () => {
    for (const k of bare) expect(press(k, {}, { overlayOpen: true }), `"${k}" fired over an overlay`).toBeNull();
  });

  test('with Ctrl, ⌘ or Alt held, no bare key fires', () => {
    for (const k of bare) {
      expect(press(k, { ctrlKey: true }), `Ctrl+${k}`).toBeNull();
      expect(press(k, { metaKey: true }), `⌘${k}`).toBeNull();
      expect(press(k, { altKey: true }), `Alt+${k}`).toBeNull();
    }
    expect(press('r', { metaKey: true })).toBeNull();      // ⌘R is the browser's reload
  });

  test('a held key does not repeat an action', () => {
    expect(press('r', { repeat: true })).toBeNull();
    expect(press('k', { metaKey: true, repeat: true })).toBeNull();
  });

  test('⌘K still works while typing and over an overlay', () => {
    expect(press('k', { metaKey: true }, { typing: true })).toEqual({ type: 'palette' });
    expect(press('k', { ctrlKey: true }, { overlayOpen: true })).toEqual({ type: 'palette' });
  });

  test('Alt+K does not open the palette', () => {
    expect(press('k', { altKey: true, metaKey: true })).toBeNull();
    expect(press('k', { altKey: true })).toBeNull();
  });
});

test.describe('typing targets', () => {
  const el = (matches: boolean) => ({ closest: (sel: string) => (matches && /input|textarea|select/.test(sel) && !sel.startsWith('dialog') ? {} : null) });

  test('inputs, textareas, selects and contenteditable regions count as typing', () => {
    expect(isTypingTarget(el(true))).toBe(true);
    expect(isTypingTarget(el(false))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });

  test('a field inside a dialog that has just closed is not being typed in', () => {
    const field = (inClosedDialog: boolean) => ({
      closest: (sel: string) => (sel.startsWith('dialog:not') ? (inClosedDialog ? {} : null) : {}),
    });
    expect(isTypingTarget(field(false))).toBe(true);
    expect(isTypingTarget(field(true))).toBe(false);
  });

  test('the selector names every kind of text control', () => {
    const asked: string[] = [];
    isTypingTarget({ closest: (sel: string) => { asked.push(sel); return null; } });
    for (const part of ['input', 'textarea', 'select', 'contenteditable']) expect(asked[0]).toContain(part);
  });
});

test.describe('the single-key switch (WCAG 2.1.4)', () => {
  const OFF: Partial<KeyContext> = { singleKeys: false };

  test('it defaults to on, and only an explicit "off" turns it off', () => {
    expect(parseSingleKeys(null)).toBe(true);
    expect(parseSingleKeys(undefined)).toBe(true);
    expect(parseSingleKeys('')).toBe(true);
    expect(parseSingleKeys('on')).toBe(true);
    expect(parseSingleKeys('garbage')).toBe(true);
    expect(parseSingleKeys('off')).toBe(false);
  });

  test('off disables every bare key: digits, brackets, letters, ? and /', () => {
    for (const k of ['1', '7', '[', ']', '/', '?', 'm', 'v', 'i', 'r', 'n', 'p', 't']) {
      expect(press(k, {}, OFF), `"${k}" fired with the switch off`).toBeNull();
    }
  });

  test('off leaves ⌘K and Ctrl+K working', () => {
    expect(press('k', { metaKey: true }, OFF)).toEqual({ type: 'palette' });
    expect(press('k', { ctrlKey: true }, OFF)).toEqual({ type: 'palette' });
  });

  test('on again restores the bare keys', () => {
    expect(press('r', {}, { singleKeys: true })).toEqual({ type: 'resetMarket' });
  });
});

test.describe('open overlays are read from the page', () => {
  test('a visible dialog or an unhidden sheet counts; a closed one does not', () => {
    const page = (matches: boolean) => ({ querySelector: (sel: string) => (matches && sel.includes('dialog[open]') && sel.includes(':not([hidden])') ? {} : null) });
    expect(overlayIsOpen(page(true))).toBe(true);
    expect(overlayIsOpen(page(false))).toBe(false);
  });
});
