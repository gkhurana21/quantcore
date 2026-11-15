// Layout scanner 2 of 2: scroll every workspace top to bottom at nine widths and, at each step, flag any visible
// text that is covered by an element that is not its own ancestor or descendant (sticky or fixed rails, panels,
// charts). The app chrome (top bar, market strip, phone tab bar, sheets) is exempt: content is meant to pass under
// it. Scans the exported site (out/) with the first-visit intro band showing (Build only) and dismissed (all
// workspaces). Exits non-zero on any occlusion.
//
//   node scripts/occlusion-scan.mjs [--widths=375x812,1440x900] [--intro=shown|dismissed|both]
import { chromium } from '@playwright/test';
import { serveOut } from './serve-out.mjs';
import { WIDTHS } from './overlap-scan.mjs';

const INTRO_KEY = 'qc-intro-dismissed';
const TABS = ['build', 'lab', 'mc', 'exotics', 'stress', 'risk', 'engine'];
const LABEL = { build: 'build', lab: 'price', mc: 'simulate', exotics: 'exotics', stress: 'stress', risk: 'risk', engine: 'engine' };
const arg = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? fallback;

function probe() {
  const chrome = el => el.closest('header, [class*="stripWrap"], [class*="strip_"], [class*="tabbar"], [class*="tabBar"], [class*="bottomNav"], dialog, [class*="sheet"], [class*="toast"]');
  const out = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    const t = n.textContent.trim(); if (!t) continue;
    const p = n.parentElement; if (!p || p.closest('.sr-only, script, style, title')) continue;
    if (p.closest('details:not([open])') && !p.closest('summary')) continue;
    if (chrome(p)) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    for (const b of r.getClientRects()) {
      if (b.width < 2 || b.height < 2) continue;
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      let hidden = false;
      for (let x = p; x && x !== document.body; x = x.parentElement) {
        if (/hidden|auto|scroll|clip/.test(getComputedStyle(x).overflow)) { const c = x.getBoundingClientRect(); if (cx < c.left || cx > c.right || cy < c.top || cy > c.bottom) { hidden = true; break; } }
      }
      if (hidden) continue;
      const top = document.elementFromPoint(cx, cy);
      if (!top) continue;
      if (top === p || p.contains(top) || top.contains(p)) continue;
      if (chrome(top)) continue;                                   // passing under the app chrome is fine
      if (top.closest('svg') && p.closest('svg') && top.closest('svg') === p.closest('svg')) continue;   // same chart: handled by label checks
      const name = e => `${e.tagName.toLowerCase()}.${(typeof e.className === 'string' ? e.className : e.className?.baseVal || '').split(' ')[0]}`;
      out.push(`"${t.slice(0, 24)}" (${name(p)}) under ${name(top)}"${(top.textContent || '').trim().slice(0, 20)}" @y${Math.round(cy)}`);
      break;
    }
  }
  return [...new Set(out)];
}

async function waitReady(page) {
  await page.waitForSelector('main[data-ready="true"]', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

export async function run() {
  const { server, url } = await serveOut(0);
  const browser = await chromium.launch();
  const only = arg('widths', '');
  const widths = only ? only.split(',').map(s => s.split('x').map(Number)) : WIDTHS;
  const modes = arg('intro', 'both') === 'both' ? ['shown', 'dismissed'] : [arg('intro', 'both')];
  const report = {};
  let views = 0;
  for (const mode of modes) {
    for (const [w, h] of widths) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
      await ctx.addInitScript(([key, dismissed]) => { try { if (dismissed) localStorage.setItem(key, '1'); } catch { /* */ } }, [INTRO_KEY, mode === 'dismissed']);
      const page = await ctx.newPage();
      await page.goto(url);
      await waitReady(page);
      for (const tab of mode === 'shown' ? ['build'] : TABS) {
        const key = `${mode} ${w} ${tab}`;
        if (tab !== 'build') { await page.click(`[data-testid="tab-${tab}"]`); await waitReady(page); }
        const active = await page.evaluate(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent);
        if (!active || !active.toLowerCase().includes(LABEL[tab])) { report[key] = ['TAB DID NOT SWITCH: ' + active]; continue; }
        if (mode === 'shown' && await page.locator('[data-testid="intro-band"]').count() !== 1) { report[key] = ['intro band not shown']; continue; }
        views++;
        const issues = new Set();
        const total = await page.evaluate(() => { const s = document.querySelector('[data-scroller]'); return (s && s.scrollHeight > s.clientHeight) ? s.scrollHeight : document.documentElement.scrollHeight; });
        for (let y = 0; y <= total; y += Math.round(h * 0.4)) {
          await page.evaluate(y => { const s = document.querySelector('[data-scroller]'); if (s && s.scrollHeight > s.clientHeight) s.scrollTo(0, y); else window.scrollTo(0, y); }, y);
          await page.waitForTimeout(120);
          for (const i of await page.evaluate(probe)) issues.add(`scroll ${y}: ${i}`);
        }
        report[key] = [...issues];
      }
      await ctx.close();
    }
  }
  await browser.close();
  server.close();
  let bad = 0;
  for (const [k, v] of Object.entries(report)) { if (v.length) { bad += v.length; console.log(`${k}: ${v.length}\n  ` + v.slice(0, 4).join('\n  ')); } }
  console.log(bad ? `occlusion-scan: ${bad} occlusions` : `occlusion-scan: CLEAN, no occluded text in ${views} views (${modes.join(' + ')} intro; ${widths.length} widths; every workspace; every scroll position)`);
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) ? 1 : 0);
