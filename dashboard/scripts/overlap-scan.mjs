// Layout scanner 1 of 2: at scroll 0, in every workspace at nine widths, find text that overlaps other text or a
// control, text that spills out of its box or the screen, truncated text, horizontal scroll, and workspace tabs
// that are cut off. It scans the exported site (out/) twice: with the first-visit intro band showing (Build only,
// since the band lives there) and with it dismissed (every workspace). It also opens the shortcuts sheet at 375
// and 1440 and checks it fits the screen. Exits non-zero on any finding.
//
//   npm run build && npm run scan:ui          (NEXT_PUBLIC_PROXY_URL=disabled for the deterministic snapshot)
//   node scripts/overlap-scan.mjs [--widths=375x812,1440x900] [--intro=shown|dismissed|both]
import { chromium } from '@playwright/test';
import { serveOut } from './serve-out.mjs';

export const WIDTHS = ['375x812', '768x1024', '1000x800', '1100x800', '1280x800', '1383x800', '1440x900', '1600x900', '1920x1080']
  .map(s => s.split('x').map(Number));
export const WORKSPACES = ['Build', 'Price', 'Simulate', 'Exotics', 'Stress', 'Risk', 'Engine'];
const INTRO_KEY = 'qc-intro-dismissed';

const arg = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? fallback;

/** Runs in the page. Returns counts and the first few offenders for what is on screen at scroll 0. */
export function scanPage() {
  const vis = e => { const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  const shown = e => {
    const dd = e.closest('details:not([open])'); if (dd && !e.closest('summary')) return false;
    for (let x = e; x && x !== document.body; x = x.parentElement) if (!vis(x)) return false;
    const d = e.closest('dialog'); return !d || d.open;
  };
  const name = e => {
    const c = (typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || '').split(' ')[0].replace(/^[a-z]+_/, '').replace(/__\w+$/, '');
    return `${e.tagName.toLowerCase()}${c ? '.' + c : ''}`;
  };
  const txt = e => (e.textContent || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 28);
  const clipTo = (e, b) => {
    let l = b.left, t = b.top, r = b.right, bo = b.bottom;
    for (let x = e; x && x !== document.body; x = x.parentElement) {
      if (/hidden|auto|scroll|clip/.test(getComputedStyle(x).overflow) || x.tagName === 'svg') {
        const c = x.getBoundingClientRect(); l = Math.max(l, c.left); t = Math.max(t, c.top); r = Math.min(r, c.right); bo = Math.min(bo, c.bottom);
      }
    }
    return r - l > 1 && bo - t > 1 ? { left: l, top: t, right: r, bottom: bo, width: r - l, height: bo - t } : null;
  };
  const boxes = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    if (!n.textContent.trim()) continue;
    const p = n.parentElement;
    if (!p || p.closest('.sr-only') || ['SCRIPT', 'STYLE', 'TITLE'].includes(p.tagName) || !shown(p)) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    for (const b0 of r.getClientRects()) { const b = clipTo(p, b0); if (b && b.width > 1 && b.height > 1) boxes.push({ el: p, b, kind: 't', raw: b0 }); }
  }
  for (const e of document.querySelectorAll('input,select,button,textarea,[role=slider]')) {
    if (!shown(e)) continue;
    const b = clipTo(e, e.getBoundingClientRect());
    if (b && b.width > 1 && b.height > 1) boxes.push({ el: e, b, kind: 'c' });
  }
  const clipOk = e => { for (let x = e; x && x !== document.body; x = x.parentElement) { if (/hidden|auto|scroll|clip/.test(getComputedStyle(x).overflow)) return x; } return null; };

  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const A = boxes[i], B = boxes[j];
    if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
    const w = Math.min(A.b.right, B.b.right) - Math.max(A.b.left, B.b.left);
    const h = Math.min(A.b.bottom, B.b.bottom) - Math.max(A.b.top, B.b.top);
    if (w > 3 && h > 3) overlaps.push(`${name(A.el)}"${txt(A.el)}" × ${name(B.el)}"${txt(B.el)}" (${Math.round(w)}x${Math.round(h)} @${Math.round(A.b.left)},${Math.round(A.b.top + scrollY)})`);
  }

  // text that leaves its own box or an ancestor's clip box
  const spill = [];
  for (const { el, raw: b, kind } of boxes) {
    if (kind !== 't') continue;
    const ecs = getComputedStyle(el); if (ecs.textOverflow === 'ellipsis' && /hidden|clip/.test(ecs.overflow)) continue;
    // not a spill: text inside a horizontally scrollable box that is itself fully on screen
    { let sc = el.parentElement, ok = false;
      for (; sc && sc !== document.body; sc = sc.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(sc).overflowX)) { const q = sc.getBoundingClientRect(); if (q.left >= -1 && q.right <= innerWidth + 1) { ok = true; break; } }
      }
      if (ok) continue; }
    const c = clipOk(el);
    const host = el.getBoundingClientRect();
    if (b.right > host.right + 2 || b.left < host.left - 2) { spill.push(`${name(el)}"${txt(el)}" spills its box by ${Math.round(Math.max(b.right - host.right, host.left - b.left))}px`); continue; }
    // the phone layout scrolls vertically inside [data-scroller]: text below the fold is not "clipped"
    if (c) { const cb = c.getBoundingClientRect(); if (b.right > cb.right + 2 || (b.bottom > cb.bottom + 2 && !c.hasAttribute('data-scroller'))) spill.push(`${name(el)}"${txt(el)}" clipped by ${name(c)}`); }
    if (b.right > innerWidth + 1) spill.push(`${name(el)}"${txt(el)}" off-screen right by ${Math.round(b.right - innerWidth)}px`);
  }
  const uniq = a => [...new Set(a)];
  const nav = document.querySelector('[role=tablist][aria-label=Workspaces]');
  const nb = nav && nav.getBoundingClientRect();
  const hiddenTabs = nav ? [...nav.querySelectorAll('[role=tab]')].filter(t => { const b = t.getBoundingClientRect(); return b.right > nb.right + 1 || b.left < nb.left - 1; }).map(t => t.textContent.replace(/\d+$/, '')) : [];

  // content wider than the screen outside a scroller, and ellipsis truncation
  const sc = document.querySelector('[data-scroller]');
  const xo = [], tr = [];
  for (const e of document.querySelectorAll('header *, [data-scroller] *, main *')) {
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || e.closest('.sr-only')) continue;
    const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    if (cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1) tr.push((e.className || '').toString().split(' ')[0] + ':' + (e.textContent || '').trim().slice(0, 30));
    if (r.right > innerWidth + 1 || r.left < -1) {
      let x = e.parentElement, ok = false;
      for (; x && x !== document.body; x = x.parentElement) {
        if (!x.hasAttribute('data-scroller') && /auto|scroll|hidden|clip/.test(getComputedStyle(x).overflowX)) { const q = x.getBoundingClientRect(); if (q.left >= -1 && q.right <= innerWidth + 1) { ok = true; break; } }
      }
      if (!ok && e.tagName !== 'svg' && !e.closest('svg')) xo.push((e.className || '').toString().split(' ')[0] + ':' + (e.textContent || '').trim().slice(0, 24) + ' r' + Math.round(r.right));
    }
  }
  return {
    hiddenTabs, hscroll: document.documentElement.scrollWidth - innerWidth,
    overlaps: uniq(overlaps).length, spills: uniq(spill).length,
    sx: sc ? sc.scrollWidth - sc.clientWidth : 0, xo: uniq(xo).length, tr: uniq(tr).length,
    detail: [...uniq(overlaps).slice(0, 6), ...uniq(spill).slice(0, 4), ...uniq(xo).slice(0, 3), ...uniq(tr).slice(0, 3)],
  };
}

/** The shortcuts sheet must fit the screen: inside the viewport, and its own body scrolls rather than the page. */
export function sheetFits() {
  const d = document.querySelector('[data-testid="shortcuts-dialog"] > div');
  if (!d || !d.closest('dialog').open) return { ok: false, why: 'the shortcuts sheet did not open' };
  const r = d.getBoundingClientRect();
  const wide = r.left < -0.5 || r.right > innerWidth + 0.5, tall = r.top < -0.5 || r.bottom > innerHeight + 0.5;
  const spill = [...d.querySelectorAll('*')].filter(e => { const q = e.getBoundingClientRect(); return q.width > 0 && (q.right > r.right + 1 || q.left < r.left - 1); }).length;
  return { ok: !wide && !tall && !spill && document.documentElement.scrollWidth <= innerWidth, why: `box ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${innerWidth}x${innerHeight}; ${spill} child(ren) outside` };
}

async function waitReady(page) {
  // main[data-ready] is set by the app once the workspace on screen has no skeleton and the WebAssembly engine is up
  await page.waitForSelector('main[data-ready="true"]', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

export async function run() {
  const { server, url } = await serveOut(0);
  const browser = await chromium.launch();
  const only = arg('widths', '');
  const widths = only ? only.split(',').map(s => s.split('x').map(Number)) : WIDTHS;
  const modes = arg('intro', 'both') === 'both' ? ['shown', 'dismissed'] : [arg('intro', 'both')];
  const rows = [];
  for (const mode of modes) {
    for (const [w, h] of widths) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      await ctx.addInitScript(([key, dismissed]) => { try { if (dismissed) localStorage.setItem(key, '1'); } catch { /* */ } }, [INTRO_KEY, mode === 'dismissed']);
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'load' });
      await waitReady(page);
      const bandNow = await page.locator('[data-testid="intro-band"]').count();
      if (mode === 'shown' && bandNow !== 1) rows.push({ mode, w, nav: 'Build', err: 'intro band not shown on a first visit' });
      if (mode === 'dismissed' && bandNow !== 0) rows.push({ mode, w, nav: 'Build', err: 'intro band shown after dismissal' });
      for (const nav of mode === 'shown' ? ['Build'] : WORKSPACES) {
        if (nav !== 'Build') {
          const ok = await page.evaluate(n => {
            const btn = [...document.querySelectorAll('[role=tablist][aria-label=Workspaces] [role=tab]')].find(b => b.textContent.trim().replace(/\d+$/, '').trim() === n);
            if (!btn) return false; btn.click(); return true;
          }, nav);
          if (!ok) { rows.push({ mode, w, nav, err: 'no tab' }); continue; }
          await waitReady(page);
        }
        await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('[data-scroller]').forEach(e => { e.scrollTop = 0; }); });
        rows.push({ mode, w, nav, ...(await page.evaluate(scanPage)) });
      }
      if (mode === 'dismissed' && (w === 375 || w === 1440)) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.keyboard.press('?');
        await page.waitForTimeout(250);
        const fit = await page.evaluate(sheetFits);
        rows.push({ mode, w, nav: 'Shortcuts sheet', ...(fit.ok ? {} : { err: `sheet does not fit: ${fit.why}` }), detail: fit.ok ? [] : [fit.why] });
      }
      await ctx.close();
    }
  }
  await browser.close();
  server.close();
  let bad = 0;
  for (const r of rows) {
    const flagged = r.err || r.overlaps || r.spills || r.hscroll || r.sx || r.xo || r.tr || (r.hiddenTabs || []).length;
    if (flagged) { bad++; console.log(`[${r.mode} ${r.w}px ${r.nav}] ${r.err ?? `overlaps ${r.overlaps}, spills ${r.spills}, hscroll ${r.hscroll}, scroller-x ${r.sx}, off-screen ${r.xo}, truncated ${r.tr}, cut-off tabs [${(r.hiddenTabs || []).join(',')}]`}\n   ${(r.detail || []).join('\n   ')}`); }
  }
  console.log(bad ? `overlap-scan: ${bad} of ${rows.length} views have findings` : `overlap-scan: CLEAN, ${rows.length} views (${modes.join(' + ')} intro; ${widths.length} widths; every workspace; shortcuts sheet at 375 and 1440)`);
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) ? 1 : 0);
