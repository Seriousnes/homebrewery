// EditorToolbar (plan §6.2, P3.4) at /dev/toolbar, in Chromium and Firefox: axe, roving focus,
// pointer use without losing the editor's focus, block type menu by keyboard, zoom and page
// layout from the UI store, breaks, and no re-render for pagination.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { blockOf, editorHasFocus, markTypes, openToolbar, pageCount, pagesRoot, pageTexts, select, settle, toolbarRenders, waitForToolbarPage } from './helpers';

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Editing' });

/** Axe results for the app chrome (the brew's own content is the author's, not the app's). */
async function violations(page: Page, include: string[]): Promise<string[]> {
  // Legacy mode: axe.run in the page. The default mode finishes in a new blank page, which took seconds to
  // minutes in Firefox (a11y lane); the toolbar page has no iframes.
  let builder = new AxeBuilder({ page }).setLegacyMode(true);
  for (const selector of include) builder = builder.include(selector);
  const results = await builder.analyze();
  return results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test.describe('axe', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`toolbar, block menu, class picker and link dialog have no violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openToolbar(page);
      await select(page, 'Old Brannoc');
      expect(await violations(page, ['[data-testid="editor-toolbar"]'])).toEqual([]);

      await page.getByTestId('block-type').click();
      await expect(page.getByRole('menu', { name: 'Block type' })).toBeVisible();
      expect(await violations(page, ['[data-testid="editor-toolbar"]', '[role="menu"]'])).toEqual([]);
      await page.keyboard.press('Escape');

      await select(page, 'Old Brannoc');
      await page.keyboard.press('ControlOrMeta+m');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('dialog').getByRole('combobox').press('ArrowDown');
      expect(await violations(page, ['[role="dialog"]'])).toEqual([]);
      await page.keyboard.press('Escape');

      await select(page, 'Old Brannoc');
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByRole('textbox', { name: 'Address' }).fill('javascript:x');
      await page.getByRole('textbox', { name: 'Address' }).press('Enter'); // with the error shown
      await expect(page.getByRole('textbox', { name: 'Address' })).toHaveAttribute('aria-invalid', 'true');
      expect(await violations(page, ['[role="dialog"]'])).toEqual([]);
    });
  }
});

test.describe('keyboard', () => {
  test('one tab stop with roving focus; Home, End and arrows; disabled items are skipped', async ({ page }) => {
    await openToolbar(page);
    await select(page, 'Guests may', 2);
    await page.keyboard.press('Alt+F10');
    // Undo and Redo are disabled on a fresh document: the first item is the block type menu.
    await expect(page.getByTestId('block-type')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'Bold' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('spread-menu')).toBeFocused(); // wraps to the last item
    await page.keyboard.press('Home');
    await expect(page.getByTestId('block-type')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('spread-menu')).toBeFocused();
    const tabStops = await toolbar(page).locator('[tabindex="0"]').count();
    expect(tabStops).toBe(1);
    // Buttons work from the keyboard; the focus stays in the toolbar.
    await select(page, 'Guests may');
    await page.keyboard.press('Alt+F10');
    await page.keyboard.press('ArrowRight'); // the tab stop is still on the last used item
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'Bold' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await markTypes(page, 'Guests may')).toEqual(['bold']);
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Bold' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect.poll(() => editorHasFocus(page)).toBe(true);
  });

  test('the block type menu works from the keyboard and returns to the editor', async ({ page }) => {
    await openToolbar(page);
    await select(page, 'Guests may', 2);
    await page.keyboard.press('Alt+F10');
    await expect(page.getByTestId('block-type')).toHaveAccessibleName('Block type: Paragraph');
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'Block type' });
    await expect(menu.getByRole('menuitemradio', { name: /Paragraph/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    expect(await blockOf(page, 'Guests may')).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    await expect.poll(() => editorHasFocus(page)).toBe(true);
    await expect(page.getByTestId('block-type')).toHaveAccessibleName('Block type: Heading 2');
  });
});

test.describe('pointer', () => {
  test('buttons keep the focus and the selection in the editor and show the state', async ({ page }) => {
    await openToolbar(page);
    await select(page, 'Guests may');
    await page.getByRole('button', { name: 'Italic' }).click();
    await page.getByRole('button', { name: 'Underline' }).click();
    expect(await markTypes(page, 'Guests may')).toEqual(['italic', 'underline']);
    expect(await editorHasFocus(page)).toBe(true);
    await expect(page.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await markTypes(page, 'Guests may')).toEqual(['italic']);
    await page.getByRole('button', { name: 'Redo' }).click();
    expect(await markTypes(page, 'Guests may')).toEqual(['italic', 'underline']);
    // Alignment and lists.
    await page.getByRole('button', { name: 'Center' }).click();
    await expect(pagesRoot(page).locator('p[align="Center"]', { hasText: 'Guests may' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Center' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Numbered list' }).click();
    expect((await blockOf(page, 'Guests may')).ancestors).toEqual(['listItem', 'orderedList']);
    await expect(page.getByRole('button', { name: 'Numbered list' })).toHaveAttribute('aria-pressed', 'true');
    // The heading has no alignment.
    await select(page, 'The Wandering Inn', 2);
    await expect(page.getByRole('button', { name: 'Center' })).toBeDisabled();
    await expect(page.getByTestId('block-type')).toHaveAccessibleName('Block type: Heading 1');
  });

  test('page break, column break, the Insert slot and the class menu', async ({ page }) => {
    await openToolbar(page);
    const pages = await pageCount(page);
    await select(page, 'Guests may', 0);
    await page.getByRole('button', { name: 'Column break' }).click();
    await expect(pagesRoot(page).locator('div.columnSplit')).toHaveCount(1);
    await page.getByRole('button', { name: 'Page break' }).click();
    await settle(page);
    expect(await pageCount(page)).toBe(pages + 1);
    expect((await pageTexts(page))[1]!.startsWith('Guests may')).toBe(true);
    await page.getByTestId('dev-insert-menu').click();
    await page.getByRole('menuitem', { name: 'Horizontal rule' }).click();
    await expect(pagesRoot(page).locator('hr')).toHaveCount(1);
    await select(page, 'Old Brannoc');
    await page.getByTestId('classes-menu').click();
    await page.getByRole('menuitem', { name: /Span with classes/ }).click();
    await expect(page.getByRole('dialog', { name: 'Style the selection with classes' })).toBeVisible();
  });

  test('zoom and page layout drive the canvas through the UI store', async ({ page }) => {
    await openToolbar(page);
    const canvas = page.locator('.hb-canvas');
    await expect(canvas).toHaveAttribute('data-zoom', '1');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(canvas).toHaveAttribute('data-zoom', '1.1');
    await page.getByRole('button', { name: 'Zoom: 110%' }).click();
    await page.getByRole('menuitemradio', { name: '50%', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-zoom', '0.5');
    await page.getByRole('button', { name: 'Page layout: Single pages' }).click();
    await page.getByRole('menuitemradio', { name: 'Facing pages' }).click();
    await expect(canvas).toHaveAttribute('data-spread', 'facing');
    // Persisted (hb-ui) across a reload.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForToolbarPage(page);
    await expect(page.locator('.hb-canvas')).toHaveAttribute('data-zoom', '0.5');
    await expect(page.getByRole('button', { name: 'Page layout: Facing pages' })).toBeVisible();
  });
});

test('pagination and typing that changes nothing it shows do not re-render the toolbar', async ({ page }) => {
  await openToolbar(page, { doc: 'long' });
  expect(await pageCount(page)).toBeGreaterThan(2);
  await select(page, 'Part0 sentence 2', 5);
  await page.keyboard.type('x'); // enables Undo: one render
  await settle(page);
  const before = await toolbarRenders(page);
  // Typing on page 1 pushes every later page boundary (pagination transactions).
  await page.keyboard.type('more words at the top of the section ');
  await settle(page);
  await page.evaluate(() => (window as unknown as { __hbToolbar: { handle: { repaginate(n: number): void } } }).__hbToolbar.handle.repaginate(0));
  await settle(page);
  expect(await toolbarRenders(page)).toBe(before);
  await page.keyboard.press('ControlOrMeta+b');
  await expect.poll(() => toolbarRenders(page)).toBeGreaterThan(before);
});
