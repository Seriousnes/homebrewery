// P5.5 icons on /dev/objects: the picker searches all four icon fonts and inserts the chosen
// icon; `:` autocomplete lists matches while typing and inserts one; a typed `:name:` converts.
// E2E_PORT=5328 pnpm exec playwright test e2e/objects/icons.spec.ts
import { expect, type Page } from '@playwright/test';
import { test, caretAfter, openObjects, undo } from './helpers';

const icons = (page: Page) => page.locator('.hb-canvas .page .columnWrapper i');

/** The icon font's glyph is drawn: ::before has content and the element uses the icon font. */
const glyphDrawn = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const before = getComputedStyle(el, '::before');
    return { content: before.content, font: getComputedStyle(el).fontFamily, width: el.getBoundingClientRect().width };
  });

test('the picker searches every icon font and inserts the chosen icon at the caret', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  await caretAfter(page, 'Hello there');
  await page.getByTestId('insert-icon').click();
  const dialog = page.getByRole('dialog', { name: 'Insert icon' });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole('combobox', { name: 'Search icons' });
  await expect(search).toBeFocused();

  const results = dialog.getByRole('listbox', { name: 'Icons' }).getByRole('option');
  for (const [set, query] of [
    ['Dice', 'd20'],
    ['Elderberry Inn', 'spell'],
    ['Game Icons', 'dragon'],
    ['Font Awesome', 'dragon'],
  ] as const) {
    await dialog.getByLabel('Icon font').selectOption({ label: set });
    await search.fill(query);
    await expect(results.first()).toBeVisible();
    expect(await results.count(), `${set}: ${query}`).toBeGreaterThan(0);
    // Previews use the theme's icon font CSS.
    const drawn = await results.first().locator('i').evaluate((el) => getComputedStyle(el, '::before').content);
    expect(drawn, `${set} glyph`).not.toBe('none');
  }

  // Arrow keys move the active option (aria-activedescendant); Enter inserts it.
  await dialog.getByLabel('Icon font').selectOption({ label: 'Game Icons' });
  await search.fill('dragon');
  const first = await search.getAttribute('aria-activedescendant');
  await search.press('ArrowDown');
  const second = await search.getAttribute('aria-activedescendant');
  expect(second).not.toBe(first);
  const chosen = await page.locator(`[id="${second}"]`).getAttribute('data-icon');
  await search.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(icons(page)).toHaveCount(1);
  const glyph = chosen!.replace(/^gi_/, '').replace(/_/g, '-');
  await expect(icons(page).first()).toHaveClass(new RegExp(`\\bgi\\b.*\\b${glyph}\\b`));
  const drawn = await glyphDrawn(page, '.hb-canvas .page .columnWrapper i');
  expect(drawn.content).not.toBe('none');
  expect(drawn.width).toBeGreaterThan(4);
  // One undo step.
  await undo(page);
  await expect(icons(page)).toHaveCount(0);
});

test('`:` autocomplete lists icons while typing and inserts the chosen one', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  await caretAfter(page, 'A second paragraph.');
  await page.keyboard.type(' Roll :d2');
  const list = page.getByTestId('icon-suggestions');
  await expect(list).toBeVisible();
  const editor = page.locator('.hb-canvas .ProseMirror');
  await expect(editor).toHaveAttribute('aria-autocomplete', 'list');
  await expect(editor).toHaveAttribute('aria-controls', (await list.getAttribute('id'))!);
  await page.keyboard.type('0');
  await expect(list.getByRole('option').first()).toBeVisible();
  const active0 = await editor.getAttribute('aria-activedescendant');
  await page.keyboard.press('ArrowDown');
  const active1 = await editor.getAttribute('aria-activedescendant');
  expect(active1).not.toBe(active0);
  await expect(list.locator(`[aria-selected="true"]`)).toHaveAttribute('id', active1!);
  const chosen = await list.locator('[aria-selected="true"]').getAttribute('data-icon');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(editor).not.toHaveAttribute('aria-activedescendant', /./);
  await expect(icons(page)).toHaveCount(1);
  const text = await page.evaluate(() => window.__hbObjects!.editor.state.doc.textContent);
  expect(text).toContain('A second paragraph. Roll ');
  expect(text).not.toContain(':d20');
  expect(chosen).toMatch(/^df_/);
  // Typing continues after the icon.
  await page.keyboard.type(' twice');
  expect(await page.evaluate(() => window.__hbObjects!.editor.state.doc.textContent)).toContain('Roll  twice');

  // Escape closes the list without inserting.
  await page.keyboard.type(' :dra');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(icons(page)).toHaveCount(1);
});

test('typing a whole `:name:` inserts the icon at once, and clicking an option works too', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  await caretAfter(page, 'Hello there, adventurer.');
  await page.keyboard.type(' :df_d12_2:');
  await expect(icons(page)).toHaveCount(1);
  await expect(icons(page).first()).toHaveClass('df d12-2');
  await page.keyboard.type(' :gi_drag');
  const list = page.getByTestId('icon-suggestions');
  await list.getByRole('option').first().click();
  await expect(icons(page)).toHaveCount(2);
  await expect(page.locator('.hb-canvas .ProseMirror')).toBeFocused();
});
