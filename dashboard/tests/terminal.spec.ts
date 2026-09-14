/**
 * QuantCore terminal — end-to-end flows.
 *
 *  1. Strategy preset (Iron Condor) → 4 legs, bounded max P/L, two break-evens
 *  2. Instrument switch (NVDA) → spot and pricing change
 *  3. Pricing Models Lab → BS / CRR / MC rows, convergence, verdict, SE shrinks with paths
 *  4. Monte Carlo view → animated paths, histogram, path-count control
 *  5. Strategy chart modes → P&L, Δ, Γ, Vega, Θ each redraw the curve
 *  6. CSV upload with aliased headers → preview with row errors → apply
 *  7. XLSX and XLS upload → apply
 *  8. Stress Lab → COVID-style crash, custom shock, apply to terminal and reset
 *  9. Risk / VaR → headline VaR, confidence and horizon scaling, Monte Carlo VaR
 *
 * The C++ engine path is covered by dashboard.spec.ts and engine.spec.ts.
 */

import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import * as XLSX from 'xlsx';

async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-testid="price"]')).not.toBeEmpty({ timeout: 15_000 });
}

const value = async (loc: Locator): Promise<number> => {
  const raw = await loc.getAttribute('data-value');
  return raw == null || raw === '' ? NaN : Number(raw);
};

async function setRange(page: Page, testid: string, v: number) {
  await page.locator(`[data-testid="${testid}"]`).evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, String(next));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
}

test.describe('QuantCore terminal flows', () => {
  test('1. Iron Condor preset builds four legs with bounded payoff', async ({ page }) => {
    await open(page);
    await page.getByTestId('preset-iron-condor').click();
    await expect(page.getByTestId('leg-row')).toHaveCount(4);
    await expect(page.getByTestId('legs-source')).toContainText('Iron Condor');
    const maxProfit = await value(page.getByTestId('max-profit'));
    const maxLoss = await value(page.getByTestId('max-loss'));
    expect(maxProfit).toBeGreaterThan(0);
    expect(maxLoss).toBeLessThan(0);
    await expect(page.getByTestId('breakevens')).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('price')).toContainText('$');   // multi-leg tiles show $ aggregates
  });

  test('2. Switching instrument to NVDA reprices the position', async ({ page }) => {
    await open(page);
    const spyPrice = await value(page.getByTestId('price'));
    await page.getByTestId('inst-NVDA').click();
    await expect(page.getByTestId('spot-display')).toHaveText('142.35');
    await expect(page.getByTestId('instrument-name')).toHaveText('NVIDIA Corp.');
    await expect.poll(() => value(page.getByTestId('price'))).not.toBeCloseTo(spyPrice, 1);
    const delta = await value(page.getByTestId('delta'));
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(1);
    await expect(page.getByTestId('calc-source')).toBeVisible();
  });

  test('3. Pricing Models Lab compares BS, CRR and Monte Carlo honestly', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('tab-lab')).toHaveAttribute('aria-selected', 'true');
    for (const id of ['bs', 'crr', 'mc10k', 'mc50k', 'mc200k']) {
      await expect(page.getByTestId(`lab-row-${id}`)).toBeVisible({ timeout: 15_000 });
    }
    const bs = await value(page.getByTestId('lab-value-bs'));
    const crr = await value(page.getByTestId('lab-value-crr'));
    const tile = await value(page.getByTestId('price'));
    expect(bs).toBeCloseTo(tile * 1000, 0);                        // 10 contracts × 100 shares
    expect(Math.abs(crr - bs) / bs).toBeLessThan(0.005);

    const se10 = await value(page.getByTestId('lab-se-mc10k'));
    const se200 = await value(page.getByTestId('lab-se-mc200k'));
    expect(se200).toBeLessThan(se10);
    expect(se10 / se200).toBeGreaterThan(3);                       // √20 ≈ 4.47 expected
    const z = Number(await page.getByTestId('lab-z-mc200k').textContent());
    expect(z).toBeLessThan(3);
    await expect(page.getByTestId('lab-verdict')).toBeVisible();
    await expect(page.getByTestId('convergence-chart')).toHaveAttribute('data-points', '8');
    await expect(page.getByTestId('crr-chart').locator('path')).toHaveCount(2);   // even- and odd-step lattices
    console.log(`  BS ${bs.toFixed(2)}  CRR ${crr.toFixed(2)}  SE10k ${se10.toFixed(2)}  SE200k ${se200.toFixed(2)}  |z|200k ${z}`);
  });

  test('4. Monte Carlo view animates paths and a terminal histogram', async ({ page }) => {
    await open(page);
    await page.getByTestId('tab-mc').click();
    const chart = page.getByTestId('mc-paths-chart');
    await expect(chart).toHaveAttribute('data-count', '50', { timeout: 15_000 });
    await expect(chart.locator('[data-mc-path]')).toHaveCount(50);
    await expect(page.getByTestId('mc-hist').locator('[data-mc-bar]')).toHaveCount(40);
    await page.getByTestId('mc-visible-100').click();
    await expect(chart.locator('[data-mc-path]')).toHaveCount(100);
    const pItm = await value(page.getByTestId('mc-pitm'));
    expect(pItm).toBeGreaterThan(0.3);
    expect(pItm).toBeLessThan(0.7);
    await page.getByTestId('mc-replay').click();
    await expect(chart.locator('[data-mc-path]')).toHaveCount(100);
  });

  test('5. Strategy chart redraws for every mode', async ({ page }) => {
    await open(page);
    const chart = page.getByTestId('strategy-chart');
    const main = page.getByTestId('chart-main-path');
    let last = await main.getAttribute('d');
    for (const mode of ['delta', 'gamma', 'vega', 'theta', 'pnl']) {
      await page.getByTestId(`chart-mode-${mode}`).click();
      await expect(chart).toHaveAttribute('data-mode', mode);
      await expect.poll(() => main.getAttribute('d')).not.toBe(last);
      last = await main.getAttribute('d');
    }
    await expect(page.getByTestId('chart-expiry-path')).toBeVisible();
  });

  test('6. CSV with aliased headers previews row errors and applies', async ({ page }) => {
    await open(page);
    const csv = [
      'Underlying,Option Type,Action,Strike Price,DTE,Contracts,Fill Price',
      'SPY,Call,Buy,760,30,2,14.10',
      'SPY,P,Sell,740,30,(3),9.25',
      'SPY,put,buy,720,45,1,',
      'SPY,straddle,buy,700,30,1,5',
    ].join('\n');
    await page.getByTestId('upload-input').setInputFiles({ name: 'broker-export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByTestId('upload-preview')).toBeVisible();
    await expect(page.getByTestId('upload-row')).toHaveCount(4);
    await expect(page.locator('[data-testid="upload-row"][data-ok="false"]')).toHaveCount(1);
    await expect(page.getByTestId('upload-summary')).toContainText('3');
    await expect(page.getByTestId('upload-privacy')).toContainText('Processed locally in your browser');
    await page.getByTestId('upload-apply').click();
    await expect(page.getByTestId('leg-row')).toHaveCount(3);
    await expect(page.getByTestId('legs-source')).toContainText('broker-export.csv');
    await expect(page.getByTestId('leg-1-side-sell')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('leg-1-qty')).toHaveValue('3');
  });

  for (const [ext, bookType, mime] of [
    ['xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['xls', 'biff8', 'application/vnd.ms-excel'],
  ] as const) {
    test(`7. ${ext.toUpperCase()} workbook with dates imports and applies`, async ({ page }) => {
      await open(page);
      const expiry = new Date(Date.now() + 60 * 86_400_000);
      const ws = XLSX.utils.aoa_to_sheet([
        ['Ticker', 'Right', 'Side', 'Strike', 'Expiration', 'Qty', 'Avg Price'],
        ['SPY', 'C', 'Buy', 770, expiry, 4, 15.5],
        ['SPY', 'C', 'Sell', 800, expiry, 4, 6.2],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Positions');
      const buffer = Buffer.from(XLSX.write(wb, { bookType, type: 'buffer' }));
      await page.getByTestId('upload-input').setInputFiles({ name: `positions.${ext}`, mimeType: mime, buffer });
      await expect(page.getByTestId('upload-row')).toHaveCount(2, { timeout: 15_000 });
      await expect(page.locator('[data-testid="upload-row"][data-ok="true"]')).toHaveCount(2);
      await page.getByTestId('upload-apply').click();
      await expect(page.getByTestId('leg-row')).toHaveCount(2);
      await expect(page.getByTestId('leg-0-strike')).toHaveValue('770');
      await expect(page.getByTestId('leg-1-premium')).toHaveValue('6.20');
      const dte = Number(await page.getByTestId('leg-0-dte').inputValue());
      expect(Math.abs(dte - 60)).toBeLessThanOrEqual(1);
    });
  }

  test('8. Stress Lab: COVID-style crash, custom shock, apply and reset', async ({ page }) => {
    await open(page);
    const spot = Number(await page.getByTestId('spot-display').textContent());
    await page.getByTestId('tab-stress').click();
    await page.getByTestId('scenario-covid').click();
    await expect.poll(() => value(page.getByTestId('stress-spot-after'))).toBeCloseTo(spot * 0.7, 6);
    const pnl = await value(page.getByTestId('stress-pnl'));
    expect(pnl).toBeLessThan(0);                                   // long call loses in a crash
    const varBefore = await value(page.getByTestId('stress-var-before'));
    const varAfter = await value(page.getByTestId('stress-var-after'));
    expect(varAfter).not.toBeCloseTo(varBefore, 0);
    await expect(page.getByTestId('stress-leg-bar')).toHaveCount(1);
    await expect(page.getByTestId('stress-matrix').locator('tbody tr')).toHaveCount(6);

    await page.getByTestId('scenario-custom').click();
    await setRange(page, 'custom-spot', -20);
    await setRange(page, 'custom-vol', 30);
    await expect.poll(() => value(page.getByTestId('stress-spot-after'))).toBeCloseTo(spot * 0.8, 6);
    const volAfter = await value(page.getByTestId('stress-vol-after'));
    expect(volAfter).toBeCloseTo(0.138 + 0.30, 9);

    await page.getByTestId('stress-apply').click();
    await expect(page.getByTestId('spot-display')).toHaveText((spot * 0.8).toFixed(2), { timeout: 5_000 });
    await expect(page.getByTestId('legs-source')).toContainText('Stress');
    await page.getByTestId('stress-restore').click();
    await expect(page.getByTestId('spot-display')).toHaveText(spot.toFixed(2));
  });

  test('10. Any ticker can be priced from a manually entered price', async ({ page }) => {
    await open(page);
    await page.getByTestId('ticker-input').fill('amd');
    await page.getByTestId('ticker-price').fill('$162.40');
    await page.getByTestId('ticker-submit').click();
    await expect(page.getByTestId('instrument-name')).toHaveText('AMD · manual price');
    await expect(page.getByTestId('data-status')).toHaveText('Manual price');   // never labelled as a snapshot or live
    await expect(page.getByTestId('inst-AMD')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('spot-display')).toHaveText('162.40');
    await expect(page.getByTestId('vol-display')).toHaveText('30.0%');
    await expect(page.getByTestId('leg-0-strike')).toHaveValue('162.5');   // ATM on the 2.5 strike grid
    await page.getByTestId('preset-iron-condor').click();
    await expect(page.getByTestId('leg-row')).toHaveCount(4);
    await expect(page.getByTestId('breakevens')).toHaveAttribute('data-count', '2');

    // invalid prices are reported and not applied
    await page.getByTestId('ticker-input').fill('TSLA');
    await page.getByTestId('ticker-price').fill('-5');
    await page.getByTestId('ticker-submit').click();
    await expect(page.getByTestId('ticker-msg')).toContainText('positive number');
    await expect(page.getByTestId('instrument-name')).toHaveText('AMD · manual price');

    // switching away and back keeps the custom ticker available
    await page.getByTestId('inst-SPY').click();
    await expect(page.getByTestId('data-status')).toHaveText('Snapshot · indicative');
    await page.getByTestId('inst-AMD').click();
    await expect(page.getByTestId('spot-display')).toHaveText('162.40');
  });

  test('11. The top bar never clips a market value, from 1200 to 1920 px wide', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('wasm-status')).toHaveText('Ready', { timeout: 15_000 });
    for (const width of [1200, 1280, 1366, 1440, 1536, 1600, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const tape = await page.evaluate(() => {
        const el = document.querySelector('[aria-label="Current market"]') as HTMLElement;
        const right = el.getBoundingClientRect().right;
        const shown = [...el.children].filter(c => getComputedStyle(c).display !== 'none');
        return {
          overflow: el.scrollWidth - el.clientWidth,
          clipped: shown.filter(c => c.getBoundingClientRect().right > right + 0.5).map(c => c.textContent),
          shown: shown.map(c => c.textContent).join(' '),
        };
      });
      expect(tape.overflow, `${width}px: ${tape.shown}`).toBeLessThanOrEqual(0);
      expect(tape.clipped, `${width}px`).toEqual([]);
      expect(tape.shown, `${width}px`).toMatch(/SPY.*S.*σ.*P&L/);   // spot, vol and P&L always stay
    }
  });

  test('12. Volatility smile: equity skew reprices the wings, custom skew flips, flat restores', async ({ page }) => {
    await open(page);
    const premium = async (i: number) => Number(await page.getByTestId(`leg-${i}-premium`).inputValue());
    const chart = page.getByTestId('smile-chart');
    const vols = async () => Promise.all(['data-down', 'data-atm', 'data-up'].map(a => chart.getAttribute(a).then(Number)));

    await page.getByTestId('preset-iron-condor').click();
    const flatPut = await premium(0), flatCall = await premium(3);          // long 2-wing put and call
    expect(new Set(await vols()).size).toBe(1);                              // flat: one volatility

    await page.getByTestId('smile-Equity index').click();
    await expect(page.getByTestId('smile-Equity index')).toHaveAttribute('aria-checked', 'true');
    const [down, atm, up] = await vols();
    expect(down).toBeGreaterThan(atm);
    expect(up).toBeLessThan(atm);
    await page.getByTestId('preset-iron-condor').click();                    // rebuild at smile prices
    expect(await premium(0)).toBeGreaterThan(flatPut);
    expect(await premium(3)).toBeLessThan(flatCall);
    expect(Number(await page.getByTestId('leg-0-iv').getAttribute('data-value'))).toBeGreaterThan(0.138);

    // dragging the skew positive makes it a custom smile with upside strikes richer
    await page.getByTestId('smile-rho').evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, 0.6);
    await expect(page.getByTestId('smile-Custom')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('smile-rho-display')).toHaveText('0.60');
    const [down2, , up2] = await vols();
    expect(up2).toBeGreaterThan(down2);

    // the smile is a model choice: it survives an instrument switch, and Flat restores one volatility
    await page.getByTestId('inst-NVDA').click();
    await expect(page.getByTestId('smile-Custom')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('smile-Flat').click();
    await expect(page.getByTestId('smile-rho')).toHaveCount(0);
    expect(new Set(await vols()).size).toBe(1);
  });

  test('13. With a smile, the Monte Carlo histogram samples the smile-implied distribution', async ({ page }) => {
    await open(page);
    await page.getByTestId('preset-long-put').click();
    await page.getByTestId('smile-Equity index').click();
    await page.getByTestId('tab-mc').click();
    const hist = page.getByTestId('mc-hist');
    await expect(hist).toHaveAttribute('data-density', 'smile', { timeout: 20_000 });
    await expect(hist).toContainText('Smile-implied density');
    await expect(hist).toContainText('Lognormal at ATM σ');
    await expect(page.getByTestId('mc-pitm').locator('xpath=..')).toContainText('smile-implied');
    await page.getByTestId('smile-Flat').click();
    await expect(hist).toHaveAttribute('data-density', 'lognormal', { timeout: 20_000 });
    await expect(hist).not.toContainText('Smile-implied density');
  });

  test('14. With no native engine, the C++ cross-check prices the whole portfolio in WebAssembly', async ({ page }) => {
    await page.routeWebSocket('ws://localhost:8765/ws', ws => ws.close({ code: 1000, reason: 'no native engine' }));
    await open(page);
    await page.getByTestId('preset-iron-condor').click();
    await page.getByTestId('lab-row-mc200k').waitFor();
    await expect(page.getByTestId('lab-engine-backend')).toContainText('WebAssembly', { timeout: 15_000 });
    await page.getByTestId('lab-engine-run').click();
    const row = page.getByTestId('lab-row-engine');
    await expect(row).toContainText('C++ WebAssembly · 1M', { timeout: 30_000 });
    await expect(row).toContainText('whole portfolio');
    expect(Number(await row.getAttribute('data-z'))).toBeLessThan(4);
  });

  test('16. Local volatility: surface markets simulate Dupire paths, the local skew is steeper, and the Lab reprices the portfolio', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page);
    await page.getByTestId('preset-iron-condor').click();
    await page.getByTestId('smile-Equity index').click();
    await page.getByTestId('term-Upward').click();

    // Pricing Lab: the local-vol diffusion reprices the condor within its standard error
    await page.getByTestId('lab-row-mc200k').waitFor();
    await page.getByTestId('lab-localvol-run').click();
    const row = page.getByTestId('lab-row-localvol');
    await expect(row).toContainText('Local vol (Dupire) · 100k', { timeout: 60_000 });
    expect(Number(await row.getAttribute('data-z'))).toBeLessThan(4);

    await page.getByTestId('tab-mc').click();
    const model = page.getByTestId('mc-path-model');
    await expect(model).toHaveAttribute('data-model', 'local-vol', { timeout: 20_000 });
    await expect(page.getByTestId('mc-intro')).toContainText('Dupire');
    const lv = page.getByTestId('mc-localvol');
    const n = async (a: string) => Number(await lv.getAttribute(a));
    expect(await n('data-local-down') - await n('data-local-atm')).toBeGreaterThan(await n('data-implied-down') - await n('data-implied-atm'));

    // flat again: GBM paths and no local-vol card; the Lab's local-vol check disappears with the surface
    await page.getByTestId('smile-Flat').click();
    await page.getByTestId('term-Flat').click();
    await expect(model).toHaveAttribute('data-model', 'gbm', { timeout: 20_000 });
    await expect(lv).toHaveCount(0);
    await page.getByTestId('tab-lab').click();
    await expect(page.getByTestId('lab-localvol')).toHaveCount(0);
  });

  test('15. ATM term structure: each expiry reads its own ATM vol, σ stays the 30-day level, Flat restores', async ({ page }) => {
    await open(page);
    const chart = page.getByTestId('term-chart');
    const attr = async (a: string) => Number(await chart.getAttribute(a));
    const price = async () => Number(await page.getByTestId('price').textContent());

    // one long call moved out to a year
    const p47 = await price();
    const dte = page.getByTestId('leg-0-dte');
    await dte.fill('365');
    await dte.press('Enter');
    await expect.poll(price).not.toBe(p47);
    const flatYear = await price();
    expect(await attr('data-week')).toBe(await attr('data-year'));           // flat: one ATM volatility
    expect(await attr('data-last')).toBe(0.138);

    await page.getByTestId('term-Inverted').click();
    await expect(page.getByTestId('term-Inverted')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('builder-vol-model')).toContainText('ATM term structure');
    expect(await attr('data-month')).toBeCloseTo(0.138, 12);                  // σ is the 30-day ATM volatility
    expect(await attr('data-week')).toBeGreaterThan(0.138);
    expect(await attr('data-last')).toBeLessThan(0.138);                      // the one-year leg's ATM volatility
    await expect.poll(price).toBeLessThan(flatYear);

    await page.getByTestId('term-Upward').click();
    expect(await attr('data-week')).toBeLessThan(0.138);
    expect(await attr('data-last')).toBeGreaterThan(0.138);
    await expect.poll(price).toBeGreaterThan(flatYear);

    // a custom curve with no gap between the short end and the long run is flat again
    await page.getByTestId('term-Custom').click();
    await setRange(page, 'term-ratio', 1);
    await expect(page.getByTestId('term-ratio-display')).toHaveText('1.00×');
    await expect.poll(() => attr('data-last')).toBeCloseTo(0.138, 12);
    await expect.poll(price).toBeCloseTo(flatYear, 3);

    // a curve is a model choice: it survives an instrument switch, and Flat removes it
    await setRange(page, 'term-ratio', 2);
    await page.getByTestId('inst-NVDA').click();
    await expect(page.getByTestId('term-Custom')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('term-ratio-display')).toHaveText('2.00×');
    await page.getByTestId('term-Flat').click();
    await expect(page.getByTestId('term-ratio')).toHaveCount(0);
    expect(await attr('data-week')).toBe(await attr('data-year'));
  });

  test('9. Risk / VaR: headline, confidence and horizon scaling, Monte Carlo VaR', async ({ page }) => {
    await open(page);
    await page.keyboard.press('4');                                // keyboard shortcut → Risk tab
    await expect(page.getByTestId('tab-risk')).toHaveAttribute('aria-selected', 'true');
    const headline = await value(page.getByTestId('var-95'));
    expect(headline).toBeGreaterThan(0);
    const dn95 = await value(page.getByTestId('var-delta-normal'));
    expect(dn95).toBeCloseTo(headline, 6);

    await page.getByTestId('var-conf-0.99').click();
    await expect.poll(() => value(page.getByTestId('var-delta-normal'))).toBeGreaterThan(dn95);
    const dn99 = await value(page.getByTestId('var-delta-normal'));
    expect(dn99 / dn95).toBeCloseTo(2.3263478740 / 1.6448536270, 6);

    await page.getByTestId('var-horizon-10').click();
    await expect.poll(() => value(page.getByTestId('var-delta-normal'))).toBeGreaterThan(dn99);
    const dn99h10 = await value(page.getByTestId('var-delta-normal'));
    expect(dn99h10 / dn99).toBeCloseTo(Math.sqrt(10), 6);

    await expect.poll(() => value(page.getByTestId('var-mc')), { timeout: 15_000 }).toBeGreaterThan(0);
    const mc = await value(page.getByTestId('var-mc'));
    const es = await value(page.getByTestId('es-mc'));
    expect(es).toBeGreaterThanOrEqual(mc);
    expect(await value(page.getByTestId('var-95'))).toBeCloseTo(headline, 6);   // headline stays 1-day 95%
    await expect(page.getByTestId('var-hist')).toBeVisible();
  });
});
