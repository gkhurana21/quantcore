/**
 * Volatility smile across the engines. Requires the local engine
 * (Playwright starts server/ws_server.py): protocol v4 carries a volatility per
 * leg, so the native C++ batch, the WebAssembly build and the browser models must
 * agree leg by leg when every strike has a different volatility.
 */

import { test, expect } from '@playwright/test';

test('the native engine (protocol v5) prices the whole smile portfolio in the Pricing Lab cross-check', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });
  await page.getByTestId('preset-iron-condor').click();
  await page.getByTestId('smile-Equity index').click();
  await page.getByTestId('lab-row-mc200k').waitFor();
  await expect(page.getByTestId('lab-engine-backend')).toContainText('native engine', { timeout: 15_000 });
  await page.getByTestId('lab-engine-run').click();
  const row = page.getByTestId('lab-row-engine');
  await expect(row).toContainText('C++ native · 1M', { timeout: 30_000 });
  expect(Number(await row.getAttribute('data-z'))).toBeLessThan(4);
});

test('native engine (protocol v4) and WebAssembly price every strike at its smile volatility', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });
  await page.getByTestId('preset-iron-condor').click();
  await page.getByTestId('smile-Equity index').click();
  await expect(page.getByTestId('calc-source')).toHaveAttribute('data-kind', 'engine-batch', { timeout: 10_000 });

  await page.getByTestId('tab-engine').click();
  await page.getByTestId('engine-price-portfolio').click();
  const agreement = page.getByTestId('engine-agreement');
  await expect(agreement).toBeVisible({ timeout: 10_000 });
  // the wings are priced 3–4 vol points away from ATM, so a single-σ engine would miss by far more than this
  expect(Number(await agreement.getAttribute('data-value'))).toBeLessThan(1e-9);
  expect(Number(await page.getByTestId('wasm-agreement').getAttribute('data-value'))).toBeLessThan(1e-12);
});
