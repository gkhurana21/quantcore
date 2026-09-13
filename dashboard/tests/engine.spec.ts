/**
 * QuantCore terminal — C++ engine integration (flow 10).
 *
 * Requires the local WebSocket server (Playwright starts server/ws_server.py).
 *  - canonical contract streams through subscribe/update
 *  - any other q = 0 portfolio is priced by batch_bs_full, and agrees with the browser
 *  - q ≠ 0 falls back to the browser and says why
 *  - the native Monte Carlo kernel converges to Black-Scholes
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });
}

async function setRange(page: Page, testid: string, v: number) {
  await page.locator(`[data-testid="${testid}"]`).evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, String(next));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
}

test.describe('C++ engine integration', () => {
  test('10a. calculation source follows the portfolio: stream → batch → browser', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('calc-source')).toHaveAttribute('data-kind', 'engine-stream', { timeout: 10_000 });

    await page.getByTestId('preset-iron-condor').click();
    await expect(page.getByTestId('calc-source')).toHaveAttribute('data-kind', 'engine-batch', { timeout: 10_000 });

    await setRange(page, 'q-input', 0.02);
    await expect(page.getByTestId('calc-source')).toHaveAttribute('data-kind', 'browser');
    await expect(page.getByTestId('calc-source').locator('..')).toContainText('no dividend yield');

    await setRange(page, 'q-input', 0);
    await expect(page.getByTestId('calc-source')).toHaveAttribute('data-kind', 'engine-batch', { timeout: 10_000 });
  });

  test('10b. engine portfolio pricing agrees with the browser models', async ({ page }) => {
    await open(page);
    await page.getByTestId('preset-iron-condor').click();
    await page.getByTestId('tab-engine').click();
    await page.getByTestId('engine-price-portfolio').click();
    const agreement = page.getByTestId('engine-agreement');
    await expect(agreement).toBeVisible({ timeout: 10_000 });
    const maxDiff = Number(await agreement.getAttribute('data-value'));
    // A&S normal CDF error bound 7.5e-8, scaled by spot and strike (~1e-4 in price)
    expect(maxDiff).toBeLessThan(2e-4);
    await expect(page.getByTestId('engine-diagram')).toHaveAttribute('data-connected', 'true');
    console.log(`  max |engine − browser| across 4 legs × 5 Greeks: ${maxDiff.toExponential(2)}`);
  });

  test('10c. native Monte Carlo converges to Black-Scholes', async ({ page }) => {
    await open(page);
    await page.getByTestId('tab-engine').click();
    await page.getByTestId('engine-run-mc').click();
    const result = page.getByTestId('engine-mc-result');
    await expect(result).toBeVisible({ timeout: 60_000 });
    const z = Number(await result.getAttribute('data-z'));
    expect(z).toBeLessThan(3);
    await expect(page.getByTestId('engine-rtt')).not.toHaveText('—', { timeout: 10_000 });
    console.log(`  ${(await result.textContent())?.replace(/\s+/g, ' ')}`);
  });
});
