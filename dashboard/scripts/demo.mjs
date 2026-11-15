// Records the README demo: a ~25 s walk through the terminal driven only by the keyboard and the intro band.
//
//   NEXT_PUBLIC_PROXY_URL=disabled npm run build      # the snapshot market data, never the live proxy
//   npm run demo                                       # writes docs/demo.gif (needs ffmpeg on PATH)
//
// Same rules as the screenshots: the exported site served locally, the default seed, dark scheme, and the hosted
// WebAssembly engine (stop any native engine on ws://localhost:8765 first).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveOut } from './serve-out.mjs';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const OUT = path.join(DOCS, 'demo.gif');
const W = 1280, H = 800;
const BUDGET_MB = 9;

const local = await serveOut(0);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-demo-'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark', recordVideo: { dir: tmp, size: { width: W, height: H } } });
const tRec = Date.now();                                              // the video starts with the page
const page = await ctx.newPage();
const pause = ms => page.waitForTimeout(ms);
const ready = () => page.waitForSelector('main[data-ready="true"]', { timeout: 60_000 });
const key = async (k, ms = 1600) => { await page.keyboard.press(k); await ready(); await pause(ms); };

const t0 = Date.now();
await page.goto(local.url, { waitUntil: 'load' });
await ready(); await page.evaluate(() => document.fonts.ready);
const startTrim = (Date.now() - tRec) / 1000;                         // cut the blank frames before the first full paint
await pause(2200);                                                    // first visit: the intro band says what this is
await page.getByTestId('preset-iron-condor').click(); await ready(); await pause(1400);
await page.getByTestId('chart-mode-delta').click().catch(() => {}); await pause(900);
await page.getByTestId('chart-mode-pnl').click().catch(() => {}); await pause(700);
await key(']', 2200);                                                 // 2 Price: three models, one portfolio
await key('3', 2600);                                                 // 3 Simulate: animated paths
await key('4', 2000);                                                 // 4 Exotics
await key('5', 900);                                                  // 5 Stress
await page.getByTestId('scenario-covid').click().catch(() => {}); await pause(1600);
await key('6', 2000);                                                 // 6 Risk: four VaR methods
await key('?', 1800);                                                 // the shortcut sheet
await page.keyboard.press('Escape'); await pause(500);
await page.keyboard.press('/'); await pause(500);
await page.keyboard.type('vol', { delay: 120 }); await pause(1300);
await page.keyboard.press('Escape'); await pause(300);
await key('1', 1500);
console.log(`walk took ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const video = await page.video().path();
await ctx.close(); await browser.close(); local.server.close();

// two-pass palette GIF: 10 fps at 960 px keeps text legible and the file under budget
const vf = 'fps=10,scale=960:-1:flags=lanczos';
const pal = path.join(tmp, 'pal.png');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(startTrim), '-i', video, '-vf', `${vf},palettegen=max_colors=128:stats_mode=diff`, pal]);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(startTrim), '-i', video, '-i', pal,
  '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', OUT]);
const mb = fs.statSync(OUT).size / 1024 / 1024;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`docs/demo.gif  ${mb.toFixed(2)} MB${mb > BUDGET_MB ? `  OVER the ${BUDGET_MB} MB budget` : ''}`);
if (mb > BUDGET_MB) process.exit(1);
