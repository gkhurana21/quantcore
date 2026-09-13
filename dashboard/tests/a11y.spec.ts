/**
 * Accessibility audit with axe-core (WCAG 2.1 A and AA rules) across the terminal
 * and every research tab. Serious and critical violations fail the test; all
 * violations are printed so minor issues stay visible.
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('accessibility (axe-core, WCAG 2.1 A/AA)', () => {
  test('terminal and every research tab have no serious or critical violations', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await expect(page.getByTestId('price')).not.toBeEmpty({ timeout: 15_000 });

    const serious: string[] = [];
    const all: string[] = [];
    for (const tab of ['lab', 'mc', 'stress', 'risk', 'engine']) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.waitForTimeout(2500);                 // worker results and draw-in animations settle
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      for (const v of results.violations) {
        const line = `[${tab}] ${v.id} (${v.impact}) ${v.help} — ${v.nodes.length} node(s): ` +
          v.nodes.slice(0, 4).map(n => n.target.join(' ')).join(' | ');
        all.push(line);
        if (v.impact === 'serious' || v.impact === 'critical') serious.push(line);
      }
    }
    console.log(all.length ? all.join('\n') : '  axe: no violations on any tab');
    expect(serious).toEqual([]);
  });
});
