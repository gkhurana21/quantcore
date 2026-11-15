/**
 * Keyboard shortcuts in the real terminal. The mapping and the ignore rules are unit-tested in shortcuts.spec.ts;
 * these check the wiring: the sheet, the palette, workspace stepping, and that typing in a field never fires a key.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('price')).not.toBeEmpty({ timeout: 20_000 });
}

const selected = (page: Page, id: string) => expect(page.getByTestId(`tab-${id}`)).toHaveAttribute('aria-selected', 'true');

test.describe('keyboard shortcuts', () => {
  test('? opens the shortcuts sheet, which lists every shortcut, and Esc closes it', async ({ page }) => {
    await open(page);
    const dialog = page.getByTestId('shortcuts-dialog');
    await expect(dialog).toBeHidden();
    await page.keyboard.press('?');
    await expect(dialog).toBeVisible();
    for (const id of ['workspace', 'prev', 'next', 'palette-chord', 'palette', 'presets', 'shortcuts', 'market', 'surface',
                      'import', 'reset', 'draw', 'intro']) {
      await expect(page.getByTestId(`shortcut-${id}`), id).toBeVisible();
    }
    await expect(dialog.getByRole('switch', { name: /single-key shortcuts/i })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('] moves to Price, [ goes back to Build, and stepping wraps', async ({ page }) => {
    await open(page);
    await selected(page, 'build');
    await page.keyboard.press(']');
    await selected(page, 'lab');
    await page.keyboard.press('[');
    await selected(page, 'build');
    await page.keyboard.press('[');                       // Build wraps to Engine
    await selected(page, 'engine');
    await page.keyboard.press(']');
    await selected(page, 'build');
    await page.keyboard.press('3');
    await selected(page, 'mc');
  });

  test('/ and ⌘K / Ctrl+K open the command palette, and p opens it on the presets', async ({ page }) => {
    await open(page);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await page.keyboard.press('/');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await page.keyboard.press('p');
    await expect(palette).toBeVisible();
    await expect(page.getByLabel('Search the terminal')).toHaveValue('Presets');
    await expect(page.getByRole('option', { name: /Iron Condor/ }).first()).toBeVisible();
    await expect(page.getByRole('option', { name: /Iron Condor on NVDA/ })).toHaveCount(0);   // presets only, not the example
  });

  test('palette items that have a hotkey show it as a keycap, read from the shortcut table', async ({ page }) => {
    await open(page);
    await page.keyboard.press('/');
    const hint = (id: string) => page.getByTestId(id).locator('kbd');
    await expect(hint('cmd-import')).toHaveText('I');
    await expect(hint('cmd-market')).toHaveText('M');
    await expect(hint('cmd-surface')).toHaveText('V');
    await expect(hint('cmd-reset')).toHaveText('R');
    await expect(hint('cmd-draw')).toHaveText('N');
    await expect(hint('cmd-intro')).toHaveText('T');
    await expect(hint('cmd-shortcuts')).toHaveText('?');
  });

  test('m opens the market controls, v the surface, i the importer', async ({ page }) => {
    await open(page);
    await page.keyboard.press('m');
    await expect(page.getByTestId('market-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('market-sheet')).toBeHidden();

    await page.getByTestId('tab-lab').click();           // off Build, the surface has no panel, so v opens its sheet
    await page.keyboard.press('v');
    await expect(page.getByTestId('surface-sheet')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.keyboard.press('i');
    await expect(page.getByRole('dialog', { name: 'Import a portfolio' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Import a portfolio' })).toBeHidden();
  });

  test('r resets the market and shows an undo toast for 5 seconds; Undo brings the market back', async ({ page }) => {
    await open(page);
    const spot = page.getByTestId('spot-display');
    const before = await spot.textContent();
    await page.keyboard.press('m');
    await setRange(page, 'spot-input', 800);
    await expect(spot).toHaveText('800.00');
    await page.keyboard.press('Escape');

    await page.keyboard.press('r');
    await expect(spot).toHaveText(before!);
    const toast = page.getByTestId('toast');
    await expect(toast).toContainText('Market reset');
    await page.getByTestId('toast-undo').click();
    await expect(spot).toHaveText('800.00');
    await expect(toast).toBeHidden();

    await page.keyboard.press('r');
    await expect(toast).toBeVisible();
    const shown = Date.now();
    await expect(toast).toBeHidden({ timeout: 8_000 });
    expect(Date.now() - shown).toBeGreaterThan(3_500);
  });

  test('n draws again and t shows or hides the intro band', async ({ page }) => {
    await open(page);
    await page.keyboard.press('n');                      // no error, no navigation
    await selected(page, 'build');
    await page.keyboard.press('2');
    await selected(page, 'lab');
    await page.keyboard.press('t');                      // brings Build and the band back
    await selected(page, 'build');
    await expect(page.getByTestId('intro-band')).toBeVisible();
    await page.keyboard.press('t');
    await expect(page.getByTestId('intro-band')).toBeHidden();
  });

  test('typing r in the strike input does NOT reset the market, and typing a letter never fires a key', async ({ page }) => {
    await open(page);
    await page.keyboard.press('m');
    await setRange(page, 'spot-input', 800);
    await page.keyboard.press('Escape');
    const spot = page.getByTestId('spot-display');
    await expect(spot).toHaveText('800.00');

    const strike = page.getByTestId('leg-0-strike');
    await strike.click();
    await page.keyboard.type('rmvintp/[]?123');
    await expect(spot).toHaveText('800.00');             // not reset
    await selected(page, 'build');                       // not moved by [ ] or 1 2 3
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await expect(page.getByTestId('shortcuts-dialog')).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
    await expect(page.getByTestId('market-sheet')).toBeHidden();
  });

  test('no single key fires while the palette is open', async ({ page }) => {
    await open(page);
    await page.keyboard.press('/');
    await page.keyboard.type('r');                       // goes into the search box
    await expect(page.getByLabel('Search the terminal')).toHaveValue('r');
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await page.keyboard.press(']');                      // the sheet is open: workspace must not change
    await selected(page, 'build');
  });

  test('the single-key switch turns bare keys off, keeps ⌘K, and is remembered', async ({ page }) => {
    await open(page);
    await page.keyboard.press('?');
    await page.getByTestId('single-key-switch').click();
    await expect(page.getByTestId('single-key-switch')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-dialog')).toBeHidden();

    await page.keyboard.press(']');
    await selected(page, 'build');                       // ignored
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-dialog')).toBeHidden();
    await page.keyboard.press('Control+k');              // the chord still works
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();

    await page.reload();
    await expect(page.getByTestId('price')).not.toBeEmpty({ timeout: 20_000 });
    await page.keyboard.press(']');
    await selected(page, 'build');                       // still off after a reload

    await page.getByTestId('footer-shortcuts').click();  // the footer link reaches the sheet without a key
    await page.getByTestId('single-key-switch').click();
    await expect(page.getByTestId('single-key-switch')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-dialog')).toBeHidden();
    await page.keyboard.press(']');
    await selected(page, 'lab');
  });
});

async function setRange(page: Page, testid: string, v: number) {
  await page.locator(`[data-testid="${testid}"]`).evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, String(next));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
}
