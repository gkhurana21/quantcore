/**
 * The first-visit intro band on Build. Every other spec pre-dismisses it (playwright.config.ts); this one starts
 * from a fresh browser and checks the band itself: shown on first visit, the examples work, dismissal sticks
 * across reloads, the band never shifts the page, and everything works with localStorage unavailable.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('price')).not.toBeEmpty({ timeout: 20_000 });
}

test.describe('intro band', () => {
  test('a first visit shows what this is, four examples and the shortcut hint', async ({ page }) => {
    await open(page);
    const band = page.getByTestId('intro-band');
    await expect(band).toBeVisible();
    await expect(band).toContainText('Options pricing and risk terminal');
    await expect(band).toContainText('WebAssembly');
    await expect(band.getByRole('button', { name: /Iron condor on NVDA/ })).toContainText('Price');
    await expect(band.getByRole('button', { name: /COVID-style crash/ })).toContainText('Stress');
    await expect(band.getByRole('button', { name: /200k-path Monte Carlo/ })).toContainText('Price');
    await expect(band.getByRole('button', { name: /99% VaR/ })).toContainText('Risk');
    await expect(band).toContainText('for shortcuts');
    await expect(band).toContainText('for everything');
    expect(await band.getByRole('button').count()).toBe(5);       // four examples and the close button
  });

  test('the examples run the same commands as the palette', async ({ page }) => {
    await open(page);
    await page.getByTestId('intro-quick-condor').click();
    await expect(page.getByTestId('tab-lab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('instrument-name')).toHaveText('NVIDIA Corp.');
    await expect(page.getByTestId('legs-source')).toContainText('Iron Condor');

    await page.getByTestId('tab-build').click();
    await page.getByTestId('intro-quick-covid').click();
    await expect(page.getByTestId('tab-stress')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId('tab-build').click();
    await page.getByTestId('intro-quick-var99').click();
    await expect(page.getByTestId('tab-risk')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('var-conf-0.99')).toHaveAttribute('aria-checked', 'true');
  });

  test('dismissing hides it for good: it stays gone after a reload, with no flash', async ({ page }) => {
    await open(page);
    await page.getByTestId('intro-dismiss').click();
    await expect(page.getByTestId('intro-band')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-intro'))).toBe('off');
    expect(await page.evaluate(() => localStorage.getItem('qc-intro-dismissed'))).toBe('1');

    await page.reload();
    // the boot script has set the attribute before first paint, so the band is hidden by CSS at once
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-intro'))).toBe('off');
    await expect(page.getByTestId('price')).not.toBeEmpty({ timeout: 20_000 });
    await expect(page.getByTestId('intro-band')).toHaveCount(0);
  });

  test('t brings it back on Build and clears the dismissal', async ({ page }) => {
    await open(page);
    await page.getByTestId('intro-dismiss').click();
    await page.getByTestId('tab-risk').click();
    await page.keyboard.press('t');
    await expect(page.getByTestId('tab-build')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('intro-band')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('qc-intro-dismissed'))).toBeNull();
    await page.reload();
    await expect(page.getByTestId('intro-band')).toBeVisible();
  });

  test('it adds no layout shift: a dismissed band takes no space, and the content does not move after load', async ({ page, context }) => {
    // a returning visitor: the band is in the HTML but hidden before paint, and the page below it starts at the same place
    await context.addInitScript(() => { try { localStorage.setItem('qc-intro-dismissed', '1'); } catch { /* */ } });
    await page.addInitScript(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver(list => {
        for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
          if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await open(page);
    await page.waitForTimeout(1500);
    const top = await page.getByTestId('panel-build').boundingBox();
    const band = await page.locator('[data-intro-band]').count();
    expect(band).toBe(0);                                  // React agrees with the attribute: nothing to measure
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls, 'cumulative layout shift').toBeLessThan(0.02);
    expect(top).not.toBeNull();
  });

  test('with localStorage unavailable the band still renders, dismisses for the visit, and nothing throws', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const deny = () => { throw new DOMException('denied', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', { get: deny, configurable: true });
    });
    await open(page);
    await expect(page.getByTestId('intro-band')).toBeVisible();
    await page.getByTestId('intro-dismiss').click();
    await expect(page.getByTestId('intro-band')).toHaveCount(0);
    await page.keyboard.press('t');
    await expect(page.getByTestId('intro-band')).toBeVisible();
    await page.keyboard.press('?');                                  // the single-key switch also survives blocked storage
    await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('on a phone it wraps without overflowing the screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page);
    const band = page.getByTestId('intro-band');
    await expect(band).toBeVisible();
    const box = await band.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
});
