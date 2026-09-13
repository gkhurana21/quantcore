/**
 * QuantCore terminal — C++ engine integration (flow 10).
 *
 * Requires the local WebSocket server (Playwright starts server/ws_server.py).
 *  - canonical contract streams through subscribe/update, including a dividend yield
 *  - any other portfolio is priced by batch_bs_full, and agrees with the browser
 *  - the native Monte Carlo kernel converges to Black-Scholes
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

/** Call price straight from the C++ bindings (protocol v3 engine supports q). */
function engineCall(S: number, K: number, r: number, sigma: number, T: number, q: number): number {
  const py = '/Library/Developer/CommandLineTools/usr/bin/python3';
  const dir = path.resolve(__dirname, '..', '..', 'python');
  const script = `import sys; sys.path.insert(0, r"${dir}"); import quantcore; print(repr(quantcore.bs_full(0, ${S}, ${K}, ${r}, ${sigma}, ${T}, ${q})["price"]))`;
  return Number(execSync(`${py} -c '${script}'`).toString().trim());
}

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
  test('10a. calculation source follows the portfolio, including a dividend yield', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('calc-source')).toHaveAttribute('data-kind', 'engine-stream', { timeout: 10_000 });

    // a dividend yield on the canonical contract stays on the C++ stream and matches bs_full(q)
    await setRange(page, 'q-input', 0.02);
    const ref = engineCall(756.48, 755, 0.045, 0.138, 0.129, 0.02);
    await expect.poll(async () => Number(await page.getByTestId('price').getAttribute('data-value')),
                      { timeout: 10_000 }).toBe(ref);
    await expect(page.getByTestId('calc-source')).toHaveAttribute('data-kind', 'engine-stream');

    await page.getByTestId('preset-iron-condor').click();
    await expect(page.getByTestId('calc-source')).toHaveAttribute('data-kind', 'engine-batch', { timeout: 10_000 });
    console.log(`  stream with q = 2%: tile ${ref.toFixed(6)} == bs_full(q)`);
  });

  test('10b. engine portfolio pricing agrees with the browser models', async ({ page }) => {
    await open(page);
    await setRange(page, 'q-input', 0.015);
    await page.getByTestId('preset-iron-condor').click();
    await page.getByTestId('tab-engine').click();
    await page.getByTestId('engine-price-portfolio').click();
    const agreement = page.getByTestId('engine-agreement');
    await expect(agreement).toBeVisible({ timeout: 10_000 });
    const maxDiff = Number(await agreement.getAttribute('data-value'));
    // both sides use double-precision N(x); measured differences are ~1e-13
    expect(maxDiff).toBeLessThan(1e-9);
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
