// Where things live in the terminal now. The market controls and the volatility-surface controls are sheets
// hung under the strip (the surface also has a panel on Build); the Greeks tiles, the legs and the presets exist
// on Build only; Price, Simulate, Exotics, Stress, Risk and Engine each mount on first visit.
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export type Workspace = 'build' | 'lab' | 'mc' | 'exotics' | 'stress' | 'risk' | 'engine';

export async function goTab(page: Page, id: Workspace) {
  const tab = page.getByTestId(`tab-${id}`);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Opens the market sheet from the strip's ticker, runs `fn`, closes it. */
export async function withMarket<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  const sheet = page.getByTestId('market-sheet');
  if (!(await sheet.isVisible())) await page.getByTestId('strip-ticker').click();
  await expect(sheet).toBeVisible();
  const out = await fn();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  return out;
}

/** The smile and term-structure controls: in the rail on Build, in a sheet (key V) everywhere else. */
export async function withSurface<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  if (await page.getByTestId('panel-build').isVisible()) return fn();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());   // a bare key does nothing inside a field
  await page.keyboard.press('v');
  const sheet = page.getByTestId('surface-sheet');
  await expect(sheet).toBeVisible();
  const out = await fn();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  return out;
}
