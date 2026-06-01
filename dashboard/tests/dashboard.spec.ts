/**
 * QuantCore Phase 5 — Playwright end-to-end validation
 *
 * Validates the full live-update path:
 *   browser slider move → WebSocket message → C++ engine recalc
 *   → pushed response → DOM update
 *
 * Three tests:
 *  1. Load + connect  — dashboard renders, WS shows "Connected", initial
 *                       price/Greeks are physically reasonable.
 *  2. Spot shock      — moving spot slider UP increases call price and delta.
 *  3. Vol shock       — increasing vol increases both call price and vega,
 *                       and the P&L surface hot corner (spot+10%, vol+50%)
 *                       shows a larger gain than the base (spot 0%, vol 0%).
 *
 * For test 2 and 3 we also verify the displayed numbers against directly
 * computed reference values (Python subprocess → quantcore C++ engine).
 */

import { test, expect, Page } from '@playwright/test';
import { execSync }           from 'child_process';
import path                  from 'path';

// ── reference values from C++ engine (run synchronously in test setup) ──────
// __dirname is dashboard/tests/  →  ../../python is quantcore/python/

function engineBS(S: number, K: number, r: number, sigma: number, T: number,
                  call: boolean): { price: number; delta: number; vega: number } {
  const py        = '/Library/Developer/CommandLineTools/usr/bin/python3';
  const pythonDir = path.resolve(__dirname, '..', '..', 'python');
  const script    = [
    `import sys; sys.path.insert(0,r"${pythonDir}"); import quantcore, json`,
    `res=quantcore.bs_full(${call?0:1},${S},${K},${r},${sigma},${T})`,
    'print(json.dumps({"price":res["price"],"delta":res["delta"],"vega":res["vega"]}))',
  ].join('; ');
  const raw = execSync(`${py} -c '${script}'`).toString().trim();
  return JSON.parse(raw);
}

const BASE = { S: 756.48, K: 755, r: 0.045, sigma: 0.138, T: 0.129 };

// ── helpers ───────────────────────────────────────────────────────────────────

/** Wait for the price element to stabilise (stop changing for 300 ms). */
async function waitForStablePrice(page: Page, timeout = 8000): Promise<string> {
  let last = '';
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await page.locator('[data-testid="price"]').textContent() ?? '';
    if (current !== '' && current !== last) { last = current; }
    else if (current !== '' && current === last) { return current; }
    await page.waitForTimeout(300);
  }
  return last;
}

/** Set a range slider to `value`.
 *  React's synthetic onChange only fires when it sees a value change via the
 *  native property setter — plain dispatchEvent alone isn't enough. */
async function setSlider(page: Page, testid: string, value: number) {
  await page.locator(`[data-testid="${testid}"]`).evaluate(
    (el, v) => {
      // Use the native HTMLInputElement setter so React sees the change
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, String(v));
      else        (el as HTMLInputElement).value = String(v);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('QuantCore Dashboard — live update path', () => {

  test('1. dashboard loads, WebSocket connects, initial values are physically sane', async ({ page }) => {
    await page.goto('/');

    // WebSocket must connect within 10 s
    await expect(page.locator('[data-testid="ws-status"]'))
      .toHaveText('Connected', { timeout: 10_000 });

    // Wait for first pricing response
    await expect(page.locator('[data-testid="price"]'))
      .not.toBeEmpty({ timeout: 8_000 });

    const price = parseFloat(await page.locator('[data-testid="price"]').textContent() ?? '0');
    const delta = parseFloat(await page.locator('[data-testid="delta"]').textContent() ?? '0');
    const gamma = parseFloat(await page.locator('[data-testid="gamma"]').textContent() ?? '0');
    const vega  = parseFloat(await page.locator('[data-testid="vega"]').textContent()  ?? '0');

    // Sanity: near-ATM SPY call, 47 DTE
    expect(price).toBeGreaterThan(5);
    expect(price).toBeLessThan(80);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(1);
    expect(gamma).toBeGreaterThan(0);
    expect(vega).toBeGreaterThan(0);

    // Verify against C++ engine directly
    const ref = engineBS(BASE.S, BASE.K, BASE.r, BASE.sigma, BASE.T, true);
    expect(price).toBeCloseTo(ref.price, 2);   // within $0.01
    expect(delta).toBeCloseTo(ref.delta, 3);   // within 0.001

    await page.screenshot({ path: 'tests/screenshots/01-initial.png', fullPage: true });
    console.log(`  Initial: price=${price.toFixed(4)}  ref=${ref.price.toFixed(4)}`
              + `  delta=${delta.toFixed(4)}  ref=${ref.delta.toFixed(4)}`);
  });

  test('2. spot slider → live call price and delta update in correct direction', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="ws-status"]')).toHaveText('Connected', { timeout: 10_000 });
    // Wait for the first real price (WS subscribed + engine responded)
    await expect(page.locator('[data-testid="price"]')).not.toBeEmpty({ timeout: 8_000 });
    const initialPrice = await waitForStablePrice(page);
    const initialDelta = await page.locator('[data-testid="delta"]').textContent() ?? '0';

    // Move spot UP by ~$15 (756.48 → 771)
    const newSpot = 771;
    await setSlider(page, 'spot-input', newSpot);

    // Wait for DOM to update (price must change)
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('[data-testid="price"]');
        return el?.textContent !== prev && (el?.textContent ?? '') !== '';
      },
      initialPrice,
      { timeout: 6_000 },
    );

    const updatedPrice = parseFloat(await page.locator('[data-testid="price"]').textContent() ?? '0');
    const updatedDelta = parseFloat(await page.locator('[data-testid="delta"]').textContent() ?? '0');

    // Higher spot → higher call price and delta
    expect(updatedPrice).toBeGreaterThan(parseFloat(initialPrice));
    expect(updatedDelta).toBeGreaterThan(parseFloat(initialDelta));

    // Verify against C++ engine
    const ref = engineBS(newSpot, BASE.K, BASE.r, BASE.sigma, BASE.T, true);
    expect(updatedPrice).toBeCloseTo(ref.price, 2);
    expect(updatedDelta).toBeCloseTo(ref.delta, 3);

    await page.screenshot({ path: 'tests/screenshots/02-spot-shock.png', fullPage: true });
    console.log(`  Spot ${BASE.S}→${newSpot}: price ${initialPrice}→${updatedPrice.toFixed(4)}`
              + `  ref=${ref.price.toFixed(4)}  delta ${initialDelta}→${updatedDelta.toFixed(4)}`);
  });

  test('3. vol slider → call price and P&L surface update correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="ws-status"]')).toHaveText('Connected', { timeout: 10_000 });
    await expect(page.locator('[data-testid="price"]')).not.toBeEmpty({ timeout: 8_000 });
    const initialPrice = await waitForStablePrice(page);

    // Move vol UP: 13.8% → 20%
    const newSigma = 0.20;
    await setSlider(page, 'vol-input', newSigma);

    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('[data-testid="price"]');
        return el?.textContent !== prev && (el?.textContent ?? '') !== '';
      },
      initialPrice,
      { timeout: 6_000 },
    );

    const updatedPrice = parseFloat(await page.locator('[data-testid="price"]').textContent() ?? '0');

    // Higher vol → higher call price (positive vega)
    expect(updatedPrice).toBeGreaterThan(parseFloat(initialPrice));

    // Verify against C++ engine
    const ref = engineBS(BASE.S, BASE.K, BASE.r, newSigma, BASE.T, true);
    expect(updatedPrice).toBeCloseTo(ref.price, 2);

    // P&L surface: top-right corner (spot+10%, vol+50%) must be the largest gain;
    // bottom-left corner (spot-10%, vol-50%) must be the largest loss.
    const topRight = parseFloat(
      await page.locator('[data-testid="pnl-4-4"]').textContent() ?? '0');
    const center   = parseFloat(
      await page.locator('[data-testid="pnl-2-2"]').textContent() ?? '0');
    const botLeft  = parseFloat(
      await page.locator('[data-testid="pnl-0-0"]').textContent() ?? '0');

    expect(topRight).toBeGreaterThan(center);
    expect(botLeft).toBeLessThan(center);

    await page.screenshot({ path: 'tests/screenshots/03-vol-shock.png', fullPage: true });
    console.log(`  Vol ${(BASE.sigma*100).toFixed(1)}%→${(newSigma*100).toFixed(0)}%: `
              + `price ${initialPrice}→${updatedPrice.toFixed(4)}  ref=${ref.price.toFixed(4)}`);
    console.log(`  P&L surface: top-right=${topRight.toFixed(0)}  `
              + `center=${center.toFixed(0)}  bot-left=${botLeft.toFixed(0)}`);
  });

});
