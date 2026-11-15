/**
 * The intro band's dismissal: stored in localStorage, read through guards, and mirrored by a tiny boot script
 * that runs before paint. Pure logic, so it runs in the unit config. The band in the page is covered by intro.spec.ts.
 */

import { test, expect } from '@playwright/test';
import { INTRO_ATTR, INTRO_BOOT_SCRIPT, INTRO_STORAGE, readIntroDismissed, writeIntroDismissed } from '../lib/intro';

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    m,
  };
};
const blocked = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

test.describe('intro band dismissal', () => {
  test('a fresh visitor has not dismissed it', () => {
    expect(readIntroDismissed(memory())).toBe(false);
    expect(readIntroDismissed(null)).toBe(false);
    expect(readIntroDismissed(undefined)).toBe(false);
  });

  test('dismissing is remembered, and showing it again forgets the dismissal', () => {
    const s = memory();
    writeIntroDismissed(s, true);
    expect(readIntroDismissed(s)).toBe(true);
    expect(s.m.get(INTRO_STORAGE)).toBe('1');
    writeIntroDismissed(s, false);
    expect(readIntroDismissed(s)).toBe(false);
    expect(s.m.has(INTRO_STORAGE)).toBe(false);
  });

  test('only the exact stored flag counts', () => {
    const s = memory();
    s.setItem(INTRO_STORAGE, 'true');
    expect(readIntroDismissed(s)).toBe(false);
  });

  test('storage that throws never throws out of the helpers: the band just shows', () => {
    expect(() => readIntroDismissed(blocked)).not.toThrow();
    expect(readIntroDismissed(blocked)).toBe(false);
    expect(() => writeIntroDismissed(blocked, true)).not.toThrow();
    expect(() => writeIntroDismissed(blocked, false)).not.toThrow();
  });
});

test.describe('boot script (runs in <head> before paint)', () => {
  const run = (storage: unknown) => {
    const attrs = new Map<string, string>();
    const fn = new Function('localStorage', 'document', INTRO_BOOT_SCRIPT);
    fn(storage, { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } });
    return attrs;
  };

  test('sets data-intro="off" only when the band was dismissed', () => {
    const dismissed = memory(); dismissed.setItem(INTRO_STORAGE, '1');
    expect(run(dismissed).get(INTRO_ATTR)).toBe('off');
    expect(run(memory()).size).toBe(0);
  });

  test('does not throw when storage is blocked or missing', () => {
    expect(() => run(blocked)).not.toThrow();
    expect(run(blocked).size).toBe(0);
    expect(() => run(undefined)).not.toThrow();
  });

  test('is a single short statement, safe to inline', () => {
    expect(INTRO_BOOT_SCRIPT.length).toBeLessThan(220);
    expect(INTRO_BOOT_SCRIPT.startsWith('try{')).toBe(true);
    expect(INTRO_BOOT_SCRIPT).not.toContain('</script');
  });
});
