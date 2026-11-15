// Regenerates the README images from the exported site, the same way every time.
//
//   NEXT_PUBLIC_PROXY_URL=disabled npm run build      # the snapshot market data, never the live proxy
//   npm run screenshots [-- --url=http://localhost:3000]
//
// Writes, at 2x device scale, as WebP (Chromium encodes it; no image tooling needed):
//   docs/terminal.webp         Build, 1440x900     (budget 500 KB)
//   docs/screens/risk.webp     Risk, 1440x900      (budget 250 KB)
//   docs/screens/exotics.webp  Exotics, 1440x900   (budget 250 KB)
//   docs/screens/phone.webp    Build, 390x844      (budget 250 KB)
//
// Repeatable: the market snapshot is static, the default seed is used, reduced motion switches the animations
// off, and each shot waits for main[data-ready="true"] (the app sets it once the workspace on screen has no
// skeleton and the WebAssembly engine is up) and for the webfonts. Every shot holds the same position, an iron
// condor on SPY, so the images agree with each other.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveOut } from './serve-out.mjs';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const SHOTS = [
  { file: 'terminal.webp', tab: 'build', w: 1440, h: 900, budget: 500 },
  { file: 'screens/risk.webp', tab: 'risk', w: 1440, h: 900, budget: 250 },
  { file: 'screens/exotics.webp', tab: 'exotics', w: 1440, h: 900, budget: 250 },
  { file: 'screens/phone.webp', tab: 'build', w: 390, h: 844, budget: 250 },
];

const urlArg = process.argv.find(a => a.startsWith('--url='))?.split('=')[1];
const local = urlArg ? null : await serveOut(0);
const base = urlArg ?? local.url;

const browser = await chromium.launch();

/** PNG bytes in, WebP bytes out, quality lowered until the file fits its budget. */
async function toWebp(png, budgetKb) {
  const page = await browser.newPage();
  try {
    const b64 = png.toString('base64');
    for (const q of [0.88, 0.82, 0.76, 0.7, 0.64, 0.58]) {
      const out = await page.evaluate(async ([data, quality]) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      }, [b64, q]);
      const buf = Buffer.from(out, 'base64');
      if (buf.length <= budgetKb * 1024 || q === 0.58) return { buf, q };
    }
  } finally { await page.close(); }
}

let failed = false;
for (const shot of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: 'dark',
    isMobile: shot.w < 768, hasTouch: shot.w < 768,
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('qc-intro-dismissed', '1'); } catch { /* */ } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await page.getByTestId('preset-iron-condor').click();                 // the one position every image shows
  if (shot.tab !== 'build') await page.getByTestId(`tab-${shot.tab}`).click();
  await page.waitForSelector('main[data-ready="true"]', { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  if (shot.tab === 'build') {                                           // the images show the hosted build: no native engine
    await page.waitForSelector('[data-testid="calc-source"][data-kind="wasm"]', { timeout: 15_000 }).catch(() => {
      throw new Error('The tiles are not priced by WebAssembly: a native engine is answering on ws://localhost:8765. Stop it and re-run.');
    });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);                                       // one settled frame after the last result
  const png = await page.screenshot({ type: 'png' });
  const { buf, q } = await toWebp(png, shot.budget);
  const out = path.join(DOCS, shot.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  const kb = Math.round(buf.length / 1024);
  const over = kb > shot.budget;
  failed ||= over;
  console.log(`${over ? 'OVER BUDGET ' : ''}${path.relative(path.dirname(DOCS), out)}  ${shot.w}x${shot.h} @2x  ${kb} KB (budget ${shot.budget}, quality ${q})`);
  await ctx.close();
}
await browser.close();
local?.server.close();
process.exit(failed ? 1 : 0);
