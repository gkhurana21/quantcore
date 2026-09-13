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
