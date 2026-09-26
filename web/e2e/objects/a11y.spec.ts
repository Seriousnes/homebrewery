// Accessibility of the objects lane's UI on /dev/objects (axe, serious and critical): the object
// frame and toolbar, the block and table menus, the icon picker and the `:` suggestion list.
// E2E_PORT=5328 npx playwright test e2e/objects/a11y.spec.ts
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test, caretAfter, clickObject, frame, openObjects } from './helpers';

/**
 * Serious or critical violations inside the given parts of the page. Legacy mode runs axe in the
 * page itself: the default mode finishes every run in a new blank page, which costs seconds per
 * scan in Firefox (and under load sometimes never returned). /dev/objects has no iframes to miss.
 */
async function violations(page: Page, include: string[]): Promise<string[]> {
  let builder = new AxeBuilder({ page }).setLegacyMode(true);
  for (const selector of include) builder = builder.include(selector);
  const results = await builder.analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('the selected object (frame, handles, toolbar) and the toolbar menus', async ({ page }) => {
  await openObjects(page, { doc: 'objects' });
  await clickObject(page, 0, 'img1');
  await expect(frame(page)).toBeFocused();
  expect(await violations(page, ['[data-hb-object-layer]', '[data-testid="objects-toolbar"]'])).toEqual([]);

  await page.getByTestId('block-menu').click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await violations(page, ['[role="menu"]'])).toEqual([]);
  await page.keyboard.press('Escape');

  await page.getByTestId('table-menu').click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await violations(page, ['[role="menu"]'])).toEqual([]);
});

test('the icon picker and the `:` suggestion list', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  await caretAfter(page, 'Hello there');
  await page.getByTestId('insert-icon').click();
  const dialog = page.getByRole('dialog', { name: 'Insert icon' });
  await dialog.getByRole('combobox', { name: 'Search icons' }).fill('sword');
  await expect(dialog.getByRole('listbox', { name: 'Icons' }).getByRole('option').first()).toBeVisible();
  expect(await violations(page, ['[role="dialog"]'])).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await caretAfter(page, 'A second paragraph.');
  await page.keyboard.type(' :swo');
  await expect(page.getByTestId('icon-suggestions')).toBeVisible();
  expect(await violations(page, ['[data-testid="icon-suggestions"]'])).toEqual([]);
  // The editor element's own name is the canvas/shell's (TipTap's role=textbox has none yet):
  // only the attributes the list adds are checked there.
  expect((await violations(page, ['.hb-canvas .ProseMirror'])).filter((v) => !v.startsWith('aria-input-field-name'))).toEqual([]);
});
