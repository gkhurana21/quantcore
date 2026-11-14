// The first-visit intro band: whether it was dismissed, remembered in localStorage.
//
// The band is in the page's HTML on every load. A tiny blocking script in <head> (INTRO_BOOT_SCRIPT, inlined by
// app/layout.tsx) sets data-intro="off" on <html> before the first paint when the visitor dismissed it, and the
// stylesheet hides the band from that attribute. React reads the same attribute, so server and client markup
// agree, nothing shifts after load, and no height has to be reserved. Storage can throw (private windows,
// blocked site data): every access is wrapped, and without it the band simply shows on each visit.

export const INTRO_STORAGE = 'qc-intro-dismissed';
export const INTRO_ATTR = 'data-intro';

/** Runs in <head> before paint. Keep it tiny and free of anything that can throw outside the try. */
export const INTRO_BOOT_SCRIPT =
  `try{if(localStorage.getItem('${INTRO_STORAGE}')==='1')document.documentElement.setAttribute('${INTRO_ATTR}','off')}catch(e){}`;

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

export function readIntroDismissed(storage: Pick<StorageLike, 'getItem'> | null | undefined): boolean {
  try { return storage?.getItem(INTRO_STORAGE) === '1'; } catch { return false; }
}

export function writeIntroDismissed(storage: Pick<StorageLike, 'setItem' | 'removeItem'> | null | undefined, dismissed: boolean): void {
  try {
    if (dismissed) storage?.setItem(INTRO_STORAGE, '1');
    else storage?.removeItem(INTRO_STORAGE);
  } catch { /* the choice holds for this visit through the attribute */ }
}

export const introHiddenNow = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.getAttribute(INTRO_ATTR) === 'off';

export function setIntroHidden(hidden: boolean): void {
  const root = document.documentElement;
  if (hidden) root.setAttribute(INTRO_ATTR, 'off');
  else root.removeAttribute(INTRO_ATTR);
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { /* blocked */ }
  writeIntroDismissed(storage, hidden);
}
