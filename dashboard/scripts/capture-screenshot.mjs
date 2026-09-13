// Captures the README screenshot of the terminal from a running build.
//
//   node scripts/capture-screenshot.mjs [url] [output]
//   node scripts/capture-screenshot.mjs http://localhost:3000 ../docs/terminal.png
//
// Uses Playwright's bundled Chromium, so it works headless without a visible browser.

import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';
import path from 'path';

const url = process.argv[2] ?? 'http://localhost:3000';
const out = path.resolve(process.argv[3] ?? '../docs/terminal.png');
mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'load' });
await page.getByTestId('lab-row-mc200k').waitFor({ timeout: 30_000 });
await page.getByTestId('preset-iron-condor').click();
await page.getByTestId('breakevens').waitFor();
await page.waitForTimeout(3000);                       // worker results and chart animations settle
await page.screenshot({ path: out });
await browser.close();
console.log(`saved ${out}`);
