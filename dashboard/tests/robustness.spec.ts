/**
 * UI robustness harness.
 *
 *  - Seeded random walks: long sequences of real user actions (instruments, presets,
 *    leg edits with invalid input, sliders at their limits, stress apply/restore, VaR
 *    and Monte Carlo controls, uploads, keyboard) on desktop and mobile. After every
 *    step the terminal must render no NaN/undefined/Infinity, keep every Greeks tile
 *    populated, stay within 1–8 legs and never overflow horizontally; the page must
 *    log no console errors and throw no exceptions.
 *  - Edge cases: eight legs in an extreme market, malformed uploads, stacked stress.
 *  - Engine resilience: a simulated engine crash mid-session (WebSocket interception)
 *    must fall back to browser pricing and recover; rapid scrubbing must settle on
 *    the exact C++ price.
 */

import { test, expect } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';
import { mulberry32 } from '../lib/quant/rng';

const tid = (id: string) => `[data-testid="${id}"]`;
const INSTRUMENTS = ['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'] as const;
const PRESETS = ['long-call', 'long-put', 'short-call', 'short-put', 'long-straddle', 'long-strangle',
                 'bull-call-spread', 'bear-put-spread', 'iron-condor'] as const;
const TABS = ['lab', 'mc', 'stress', 'risk', 'engine'] as const;
const SCENARIOS = ['gfc', 'covid', 'volspike', 'rates', 'meltup', 'custom'] as const;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function engineCall(S: number, K: number, r: number, sigma: number, T: number): number {
  const py = '/Library/Developer/CommandLineTools/usr/bin/python3';
  const dir = path.resolve(__dirname, '..', '..', 'python');
  const script = `import sys; sys.path.insert(0, r"${dir}"); import quantcore; print(repr(quantcore.bs_full(0, ${S}, ${K}, ${r}, ${sigma}, ${T})["price"]))`;
  return Number(execSync(`${py} -c '${script}'`).toString().trim());
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  return errors;
}

async function setRange(page: Page, id: string, value: number) {
  await page.locator(tid(id)).evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function expectSane(page: Page, log: string[]) {
  const s = await page.evaluate(() => {
    const text = document.body.innerText;
    const m = /NaN|undefined|Infinity/.exec(text);
    const tiles = ['price', 'delta', 'gamma', 'theta', 'vega', 'pnl']
      .map(id => [id, (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').trim()]);
    return {
      bad: m ? text.slice(Math.max(0, m.index - 100), m.index + 40) : null,
      empty: tiles.filter(([, v]) => !v).map(([id]) => id),
      signedZero: tiles.filter(([, v]) => /^[−-]\$?0(\.0+)?( sh)?$/.test(v)).map(([id, v]) => `${id} ${v}`),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      legs: document.querySelectorAll('[data-testid="leg-row"]').length,
    };
  });
  const ctx = `\nlast actions:\n  ${log.slice(-10).join('\n  ')}`;
  expect(s.bad, `rendered NaN/undefined/Infinity${ctx}`).toBeNull();
  expect(s.empty, `empty Greeks tile${ctx}`).toEqual([]);
  expect(s.signedZero, `signed zero in a Greeks tile${ctx}`).toEqual([]);
  expect(s.overflow, `horizontal overflow${ctx}`).toBeLessThanOrEqual(1);
  expect(s.legs, `leg count${ctx}`).toBeGreaterThanOrEqual(1);
  expect(s.legs, `leg count${ctx}`).toBeLessThanOrEqual(8);
}

async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator(tid('price'))).not.toBeEmpty({ timeout: 20_000 });
}

async function randomWalk(page: Page, seed: number, steps: number, errors: string[]) {
  const u = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(u() * xs.length)];
  const log: string[] = [];
  const legCount = () => page.locator(tid('leg-row')).count();
  const legIndex = async () => Math.floor(u() * (await legCount()));
  const ensureTab = async (t: string) => {
    const tab = page.locator(tid(`tab-${t}`));
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  };
  const clickIfEnabled = async (id: string) => {
    const el = page.locator(tid(id));
    if ((await el.count()) && (await el.isEnabled())) { await el.click(); return true; }
    return false;
  };
  const editCell = async (field: string, values: string[]) => {
    const i = await legIndex();
    const v = pick(values);
    const cell = page.locator(tid(`leg-${i}-${field}`));
    await cell.fill(v);
    await cell.press('Enter');
    return `leg ${i} ${field} = ${JSON.stringify(v)}`;
  };

  const actions: [string, number, () => Promise<string>][] = [
    ['instrument', 3, async () => { const s = pick(INSTRUMENTS); await page.locator(tid(`inst-${s}`)).click(); return s; }],
    ['preset', 4, async () => { const p = pick(PRESETS); await page.locator(tid(`preset-${p}`)).click(); return p; }],
    ['any ticker', 2, async () => {
      const sym = pick(['AMD', 'meta', 'BRK.B', 'X', 'f', '123', 'TOOLONGTICKER1']);
      const px = pick(['162.4', '$0.37', '25000', '1,234.5', '-3', 'abc', '']);
      await page.locator(tid('ticker-input')).fill(sym);
      await page.locator(tid('ticker-price')).fill(px);
      const ok = await clickIfEnabled('ticker-submit');
      return `${sym} @ ${JSON.stringify(px)} ${ok}`;
    }],
    ['add leg', 3, async () => String(await clickIfEnabled('add-leg'))],
    ['remove leg', 2, async () => { const i = await legIndex(); return `${i} ${await clickIfEnabled(`leg-${i}-remove`)}`; }],
    ['strike', 3, async () => {
      const spot = Number(await page.locator(tid('spot-display')).textContent());
      return editCell('strike', [String(Math.round(spot * (0.5 + u()))), String(+(spot * 1.03).toFixed(2)), '0', '-5', 'abc', '1e9', '']);
    }],
    ['qty', 2, () => editCell('qty', ['1', '3', '250', '0', '-3', '2.5', '99999', 'x'])],
    ['dte', 3, () => editCell('dte', ['1', '2', '30', '365', '1095', '0', '5000', 'x'])],
    ['premium', 3, () => editCell('premium', ['0', '0.01', '12.5', '1e6', '-1', ''])],
    ['type', 2, async () => { const i = await legIndex(); const t = pick(['call', 'put']); await page.locator(tid(`leg-${i}-type-${t}`)).click(); return `${i} ${t}`; }],
    ['side', 2, async () => { const i = await legIndex(); const s = pick(['buy', 'sell']); await page.locator(tid(`leg-${i}-side-${s}`)).click(); return `${i} ${s}`; }],
    ['spot', 3, async () => {
      const [lo, hi] = await page.locator(tid('spot-input')).evaluate(el => [Number((el as HTMLInputElement).min), Number((el as HTMLInputElement).max)]);
      const v = pick([lo, hi, lo + (hi - lo) * u()]);
      await setRange(page, 'spot-input', v); return String(v);
    }],
    ['vol', 3, async () => { const v = pick([0.01, 1.5, +(0.01 + 1.49 * u()).toFixed(3)]); await setRange(page, 'vol-input', v); return String(v); }],
    ['rate', 1, async () => { const v = pick([0, 0.15, +(0.15 * u()).toFixed(4)]); await setRange(page, 'rate-input', v); return String(v); }],
    ['dividend', 2, async () => { const v = pick([0, 0.08, +(0.08 * u()).toFixed(4)]); await setRange(page, 'q-input', v); return String(v); }],
    ['reset market', 1, async () => String(await clickIfEnabled('reset-market'))],
    ['chart mode', 2, async () => { const mode = pick(['pnl', 'delta', 'gamma', 'vega', 'theta']); await page.locator(tid(`chart-mode-${mode}`)).click(); return mode; }],
    ['chart keys', 1, async () => {
      await page.locator(`${tid('strategy-chart')} svg`).first().focus();
      for (const k of ['ArrowRight', 'ArrowRight', 'Home', 'End', 'ArrowLeft', 'Escape']) await page.keyboard.press(k);
      return 'arrows';
    }],
    ['tab', 3, async () => { const t = pick(TABS); await page.locator(tid(`tab-${t}`)).click(); return t; }],
    ['keyboard tab', 1, async () => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const k = String(1 + Math.floor(u() * 5)); await page.keyboard.press(k); return k;
    }],
    ['stress', 4, async () => {
      await ensureTab('stress');
      const sc = pick(SCENARIOS);
      await page.locator(tid(`scenario-${sc}`)).click();
      let detail = sc;
      if (sc === 'custom') {
        await setRange(page, 'custom-spot', Math.round(-50 + 100 * u()));
        await setRange(page, 'custom-vol', Math.round(-30 + 110 * u()));
        await setRange(page, 'custom-days', Math.round(90 * u()));
        detail += ' +sliders';
      }
      const r = u();
      if (r < 0.35) { await page.locator(tid('stress-apply')).click(); detail += ' apply'; }
      else if (r < 0.55 && await clickIfEnabled('stress-restore')) detail += ' restore';
      return detail;
    }],
    ['var', 2, async () => {
      await ensureTab('risk');
      await page.locator(tid(`var-conf-${pick(['0.9', '0.95', '0.99'])}`)).click();
      await page.locator(tid(`var-horizon-${pick(['1', '5', '10'])}`)).click();
      return 'conf/horizon';
    }],
    ['monte carlo', 2, async () => {
      await ensureTab('mc');
      const c = pick(['mc-visible-25', 'mc-visible-100', 'mc-replay', 'mc-reseed']);
      await page.locator(tid(c)).click(); return c;
    }],
    ['lab', 2, async () => {
      await ensureTab('lab');
      const c = pick(['lab-reseed', 'lab-antithetic-on', 'lab-antithetic-off']);
      await page.locator(tid(c)).click(); return c;
    }],
    ['upload sample', 1, async () => {
      await page.locator(tid('sample-load')).click();
      const apply = u() < 0.6;
      await page.locator(tid(apply ? 'upload-apply' : 'upload-discard')).click();
      return apply ? 'apply' : 'discard';
    }],
    ['upload garbage', 1, async () => {
      const bytes = Buffer.from(Array.from({ length: 2048 }, () => Math.floor(u() * 256)));
      await page.locator(tid('upload-input')).setInputFiles({ name: 'garbage.xlsx', mimeType: XLSX_MIME, buffer: bytes });
      await page.waitForTimeout(400);
      const discard = page.locator(tid('upload-discard'));
      if (await discard.count()) await discard.click();
      return 'random bytes as .xlsx';
    }],
    ['quick start', 1, async () => { const q = pick(['condor', 'covid', 'paths', 'var99']); await page.locator(tid(`quick-${q}`)).click(); return q; }],
    ['engine', 1, async () => {
      await ensureTab('engine');
      return String(await clickIfEnabled('engine-price-portfolio'));
    }],
  ];

  const total = actions.reduce((a, x) => a + x[1], 0);
  for (let i = 0; i < steps; i++) {
    let r = u() * total, chosen = actions[0];
    for (const a of actions) { r -= a[1]; if (r <= 0) { chosen = a; break; } }
    let detail = '';
    try {
      detail = await chosen[2]();
    } catch (err) {
      throw new Error(`step ${i} (${chosen[0]}) failed: ${err instanceof Error ? err.message : err}\n  ${log.slice(-10).join('\n  ')}`);
    }
    log.push(`${i}: ${chosen[0]} ${detail}`);
    await page.waitForTimeout(90);
    await expectSane(page, log);
    expect(errors, `console/page errors after step ${i}\n  ${log.slice(-10).join('\n  ')}`).toEqual([]);
  }

  // let workers and animations settle, then check every research tab renders its results
  for (const t of TABS) {
    await page.locator(tid(`tab-${t}`)).click();
    await page.waitForTimeout(t === 'engine' ? 300 : 2500);
    await expectSane(page, [...log, `final: ${t}`]);
  }
  await page.locator(tid('tab-lab')).click();
  await expect(page.locator(tid('lab-verdict'))).toBeVisible({ timeout: 20_000 });
  expect(errors, 'console/page errors').toEqual([]);
  return log;
}

test.describe('robustness: random interaction walks', () => {
  for (const seed of [101, 202, 303]) {
    test(`desktop walk, seed ${seed}`, async ({ page }) => {
      test.setTimeout(240_000);
      const errors = watchErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page);
      await randomWalk(page, seed, 80, errors);
    });
  }

  test('mobile walk (375 px), seed 404', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page);
    await randomWalk(page, 404, 60, errors);
  });
});

test.describe('robustness: edge cases', () => {
  test('eight legs in an extreme market render finite results on every tab', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await open(page);
    for (let i = 0; i < 7; i++) await page.locator(tid('add-leg')).click();
    await expect(page.locator(tid('leg-row'))).toHaveCount(8);
    await expect(page.locator(tid('add-leg'))).toBeDisabled();
    await page.locator(tid('leg-7-side-sell')).click();
    await page.locator(tid('leg-3-type-put')).click();
    for (const [field, i, v] of [['strike', 5, '5000'], ['dte', 2, '1'], ['premium', 1, '0'], ['qty', 6, '5000']] as const) {
      const cell = page.locator(tid(`leg-${i}-${field}`));
      await cell.fill(v);
      await cell.press('Enter');
    }
    await expect(page.locator(tid('leg-1-iv'))).toHaveText('IV —');
    await setRange(page, 'vol-input', 1.5);
    await setRange(page, 'rate-input', 0.15);
    await setRange(page, 'q-input', 0.08);
    const lo = await page.locator(tid('spot-input')).evaluate(el => Number((el as HTMLInputElement).min));
    await setRange(page, 'spot-input', lo);
    const log = ['8 legs, σ 150%, r 15%, q 8%, spot at minimum'];
    await expectSane(page, log);
    for (const t of TABS) {
      await page.locator(tid(`tab-${t}`)).click();
      await page.waitForTimeout(t === 'engine' ? 500 : 3000);
      await expectSane(page, [...log, t]);
    }
    await page.locator(tid('tab-engine')).click();
    await page.locator(tid('engine-price-portfolio')).click();
    await expect(page.locator(tid('engine-agreement'))).toBeVisible({ timeout: 10_000 });
    expect(Number(await page.locator(tid('engine-agreement')).getAttribute('data-value'))).toBeLessThan(1e-6);
    expect(errors).toEqual([]);
  });

  test('malformed uploads are reported without breaking the terminal', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    const garbage = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256));
    const wide = ['type,strike,dte,qty,premium',
      ...Array.from({ length: 60 }, (_, i) => [i % 3 ? 'call' : 'nonsense', 700 + i, i % 5 ? 30 : -4, i % 7 ? 1 : 0, i % 4 ? '' : 'abc'].join(','))].join('\n');
    const files = [
      { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('') },
      { name: 'header-only.csv', mimeType: 'text/csv', buffer: Buffer.from('type,strike,dte,qty\n') },
      { name: 'prose.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world\nthis is not a portfolio\n') },
      { name: 'garbage.xlsx', mimeType: XLSX_MIME, buffer: garbage },
      { name: 'garbage.xls', mimeType: 'application/vnd.ms-excel', buffer: garbage },
      { name: 'photo.png', mimeType: 'image/png', buffer: garbage },
      { name: 'wide.csv', mimeType: 'text/csv', buffer: Buffer.from(wide) },
    ];
    for (const f of files) {
      await page.locator(tid('upload-input')).setInputFiles(f);
      await expect(page.locator(`${tid('upload-error')}, ${tid('upload-preview')}`).first()).toBeVisible({ timeout: 10_000 });
      const apply = page.locator(tid('upload-apply'));
      if (await apply.count()) {
        const legs = await page.locator(`${tid('upload-row')}[data-ok="true"]`).count();
        if (legs === 0) await expect(apply).toBeDisabled();
      }
      await expectSane(page, [`upload ${f.name}`]);
      const discard = page.locator(tid('upload-discard'));
      if (await discard.count()) await discard.click();
    }
    expect(errors).toEqual([]);
  });

  test('stacked stress scenarios restore the original market and position', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await expect(page.locator(tid('ws-status'))).toHaveText('Connected', { timeout: 15_000 });
    await page.locator(tid('tab-stress')).click();
    await page.locator(tid('scenario-covid')).click();
    await page.locator(tid('stress-apply')).click();
    await expect(page.locator(tid('spot-display'))).toHaveText('529.54', { timeout: 5_000 });
    await page.locator(tid('scenario-custom')).click();
    await setRange(page, 'custom-days', 10);
    await page.locator(tid('stress-apply')).click();
    await expect(page.locator(tid('spot-display'))).toHaveText('450.11', { timeout: 5_000 });   // 529.536 × 0.85
    await page.locator(tid('stress-restore')).click();
    await expect(page.locator(tid('spot-display'))).toHaveText('756.48');
    await expect(page.locator(tid('legs-source'))).toHaveText('Preset · Long Call');
    await expect(page.locator(tid('leg-0-dte'))).toHaveValue('47');
    await expect(page.locator(tid('calc-source'))).toHaveAttribute('data-kind', 'engine-stream', { timeout: 10_000 });
    await expectSane(page, ['stacked stress']);
    expect(errors).toEqual([]);
  });
});

test.describe('robustness: engine resilience', () => {
  test('an engine crash mid-session falls back to the WebAssembly engine and recovers', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = watchErrors(page);
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket('ws://localhost:8765/ws', ws => { ws.connectToServer(); sockets.push(ws); });
    await open(page);
    await expect(page.locator(tid('ws-status'))).toHaveText('Connected', { timeout: 15_000 });
    await expect(page.locator(tid('calc-source'))).toHaveAttribute('data-kind', 'engine-stream', { timeout: 10_000 });

    for (const ws of sockets.splice(0)) await ws.close({ code: 1000, reason: 'simulated engine crash' });
    await expect(page.locator(tid('calc-source'))).toHaveAttribute('data-kind', 'wasm', { timeout: 5_000 });
    await expect(page.locator(tid('ws-status'))).not.toHaveText('Connected');
    await setRange(page, 'spot-input', 771);
    await expect(page.locator(tid('price'))).toHaveText('27.370');
    await expectSane(page, ['engine crashed, spot 771']);

    // the client retries after 2 s and resumes streaming from the C++ core
    await expect(page.locator(tid('ws-status'))).toHaveText('Connected', { timeout: 15_000 });
    await expect(page.locator(tid('calc-source'))).toHaveAttribute('data-kind', 'engine-stream', { timeout: 10_000 });
    const ref = engineCall(771, 755, 0.045, 0.138, 0.129);
    await expect.poll(async () => Number(await page.locator(tid('price')).getAttribute('data-value')), { timeout: 10_000 }).toBe(ref);
    expect(errors).toEqual([]);
  });

  test('an engine that never answers leaves an honest Offline state with a working Reconnect', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = watchErrors(page);
    let refuse = true;
    await page.routeWebSocket('ws://localhost:8765/ws', ws => {
      if (refuse) ws.close({ code: 1000, reason: 'engine unavailable' });
      else ws.connectToServer();
    });
    await open(page);
    await expect(page.locator(tid('ws-status'))).toHaveText('Offline', { timeout: 20_000 });
    await expect(page.locator(tid('calc-source'))).toHaveAttribute('data-kind', 'wasm');
    await expect(page.locator(tid('wasm-status'))).toHaveText('Ready');
    await page.waitForTimeout(8_000);                                   // both automatic retries are spent
    await expect(page.locator(tid('ws-status'))).toHaveText('Offline');
    await page.locator(tid('tab-engine')).click();
    await expect(page.locator(tid('engine-reconnect'))).toBeVisible();
    await expectSane(page, ['engine refused']);

    refuse = false;
    await page.locator(tid('engine-reconnect')).click();
    await expect(page.locator(tid('ws-status'))).toHaveText('Connected', { timeout: 10_000 });
    await expect(page.locator(tid('calc-source'))).toHaveAttribute('data-kind', 'engine-stream', { timeout: 10_000 });
    expect(errors).toEqual([]);
  });

  test('with the native engine unreachable, the C++ WebAssembly build prices the terminal', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = watchErrors(page);
    await page.routeWebSocket('ws://localhost:8765/ws', ws => ws.close({ code: 1000, reason: 'no native engine' }));
    await open(page);
    await expect(page.locator(tid('wasm-status'))).toHaveText('Ready', { timeout: 15_000 });
    await expect(page.locator(tid('calc-source'))).toHaveAttribute('data-kind', 'wasm', { timeout: 15_000 });
    await expect(page.locator(tid('calc-source'))).toHaveText('C++ · WebAssembly');
    const ref = engineCall(756.48, 755, 0.045, 0.138, 0.129);
    const shown = Number(await page.locator(tid('price')).getAttribute('data-value'));
    expect(Math.abs(shown - ref)).toBeLessThanOrEqual(1e-12 * ref);

    await page.locator(tid('tab-engine')).click();
    await expect(page.locator(tid('engine-wasm-status'))).toHaveText('Ready');
    await expect(page.locator(tid('wasm-build'))).toContainText('Emscripten');
    expect(Number(await page.locator(tid('wasm-agreement')).getAttribute('data-value'))).toBeLessThan(1e-12);
    await page.locator(tid('wasm-paths-1000000')).click();
    await page.locator(tid('wasm-run-mc')).click();
    const result = page.locator(tid('wasm-mc-result'));
    await expect(result).toBeVisible({ timeout: 30_000 });
    expect(Number(await result.getAttribute('data-z'))).toBeLessThan(4);
    await expectSane(page, ['native engine unreachable, WebAssembly engine']);
    expect(errors).toEqual([]);
  });

  test('rapid spot scrubbing on the C++ stream settles on the exact engine price', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await expect(page.locator(tid('ws-status'))).toHaveText('Connected', { timeout: 15_000 });
    await page.locator(tid('spot-input')).evaluate(async el => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      for (let i = 0; i < 400; i++) {
        set.call(el, String(650 + (i % 240) / 2));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (i % 25 === 0) await new Promise(r => setTimeout(r, 0));
      }
      set.call(el, '771');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const ref = engineCall(771, 755, 0.045, 0.138, 0.129);
    await expect.poll(async () => Number(await page.locator(tid('price')).getAttribute('data-value')), { timeout: 10_000 }).toBe(ref);
    await expect(page.locator(tid('calc-source'))).toHaveAttribute('data-kind', 'engine-stream');
    expect(errors).toEqual([]);
  });
});
