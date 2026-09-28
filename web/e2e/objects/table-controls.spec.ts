// T3 tables on /dev/objects: the insert-table size picker, the table controls under the table at
// the caret (add/delete rows and columns, header row, Wide spanning both columns, delete the
// table), their keyboard access, and their place through zoom and a table moved to another page.
// E2E_PORT=5328 pnpm exec playwright test e2e/objects/table-controls.spec.ts
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import { test, caretAfter, clickInText, openObjects, settle, undo } from './helpers';

const table = (page: Page) => page.locator('.hb-canvas .page table').first();
const controls = (page: Page) => page.getByTestId('table-controls');
const rowCount = (page: Page) => table(page).locator(':scope > tbody > tr').count();
const colCount = (page: Page) => table(page).locator(':scope > tbody > tr').first().locator(':scope > *').count();

/** The name of the node that holds the caret's text block (tableCell, tableHeader, …). */
const caretCell = (page: Page) =>
  page.evaluate(() => (window.__hbObjects!.editor.state as unknown as { selection: { $from: { node(d: number): { type: { name: string } } } } }).selection.$from.node(-1).type.name);

/**
 * Clicks into a cell and waits until ProseMirror has the caret there (it reads the DOM selection
 * after the click; a key pressed before would still see the old selection).
 */
async function clickInCell(page: Page, text: string): Promise<void> {
  await clickInText(page, table(page).getByText(text));
  await expect.poll(() => caretCell(page)).toBe('tableCell');
}

/** The controls sit right under (or, without room, above) the table and share its left edge. */
async function expectAnchored(page: Page, target: Locator): Promise<void> {
  await expect(controls(page)).toBeVisible();
  await expect
    .poll(async () => {
      const t = (await target.boundingBox())!;
      const c = (await controls(page).boundingBox())!;
      const under = Math.abs(c.y - (t.y + t.height) - 4) <= 2;
      const over = Math.abs(c.y + c.height - (t.y - 4)) <= 2;
      return (under || over) && Math.abs(c.x - t.x) <= 2;
    })
    .toBe(true);
}

test('the size picker inserts a 4 × 5 table with a header row; the controls appear under it', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  await caretAfter(page, 'Hello there, adventurer.');
  await page.getByTestId('table-menu').click();
  const picker = page.getByRole('dialog', { name: 'Insert table' });
  await expect(picker.getByRole('gridcell', { name: '3 by 3' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(picker.getByTestId('table-size-label')).toHaveText('4 × 5 table');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(table(page).locator('tr')).toHaveCount(4);
  expect(await colCount(page)).toBe(5);
  await expect(table(page).locator('tr.hb-header-row')).toHaveCount(1);
  expect(await caretCell(page)).toBe('tableHeader');
  await expectAnchored(page, table(page));
  // One undo step takes the whole table away.
  await undo(page);
  await expect(page.locator('.hb-canvas .page table')).toHaveCount(0);
});

test('the controls add and delete rows and columns, one undo step each, the caret staying in the table', async ({ page }) => {
  await openObjects(page, { doc: 'tables' });
  await clickInCell(page, 'The stew is alive.');
  await expectAnchored(page, table(page));
  const bar = controls(page);
  await bar.getByRole('button', { name: 'Add row below' }).click();
  expect(await rowCount(page)).toBe(5);
  await bar.getByRole('button', { name: 'Add row above' }).click();
  expect(await rowCount(page)).toBe(6);
  await bar.getByRole('button', { name: 'Add column right' }).click();
  expect(await colCount(page)).toBe(3);
  await bar.getByRole('button', { name: 'Add column left' }).click();
  expect(await colCount(page)).toBe(4);
  await bar.getByRole('button', { name: 'Delete column' }).click();
  expect(await colCount(page)).toBe(3);
  await bar.getByRole('button', { name: 'Delete row' }).click();
  expect(await rowCount(page)).toBe(5);
  expect(await caretCell(page)).toBe('tableCell');
  await expect(page.locator('.hb-canvas .ProseMirror')).toBeFocused();
  await expectAnchored(page, table(page));
  await undo(page);
  expect(await rowCount(page)).toBe(6);
  await undo(page);
  expect(await colCount(page)).toBe(4);
});

test('Wide makes the table span both columns (canvas), Header row toggles th', async ({ page }) => {
  await openObjects(page, { doc: 'tables' });
  await clickInCell(page, 'The cellar hums at night.');
  const wrapper = page.locator('.hb-canvas .page .columnWrapper').first();
  const narrow = (await table(page).boundingBox())!.width;
  const wrapperWidth = (await wrapper.boundingBox())!.width;
  expect(narrow).toBeLessThan(wrapperWidth * 0.6);
  await controls(page).getByTestId('table-wide').click();
  await expect(table(page)).toHaveClass(/\bwide\b/);
  await expect(controls(page).getByTestId('table-wide')).toHaveAttribute('aria-pressed', 'true');
  const style = await table(page).evaluate((el) => ({ span: getComputedStyle(el).columnSpan, display: getComputedStyle(el).display }));
  expect(style).toEqual({ span: 'all', display: 'table' });
  const wide = (await table(page).boundingBox())!.width;
  expect(wide).toBeGreaterThan(wrapperWidth * 0.95);
  await settle(page);
  await expectAnchored(page, table(page));

  await controls(page).getByTestId('table-header-row').click();
  await expect(table(page).locator('tr').nth(1).locator('th')).toHaveCount(2);
  await expect(table(page).locator('tr.hb-header-row')).toHaveCount(2);
});

test('Delete table removes it and puts the caret in the text after it', async ({ page }) => {
  await openObjects(page, { doc: 'tables' });
  await clickInCell(page, 'The keeper was a king.');
  await controls(page).getByRole('button', { name: 'Delete table' }).click();
  await expect(page.locator('.hb-canvas .page table')).toHaveCount(0);
  await expect(controls(page)).toBeHidden();
  await page.keyboard.type('X');
  await expect(page.locator('.hb-canvas .page p').filter({ hasText: 'XAfter the table.' })).toHaveCount(1);
});

test('keyboard: Shift+Alt+F10 enters the controls, arrows move, Enter acts, Escape returns to the text', async ({ page }) => {
  await openObjects(page, { doc: 'tables' });
  await clickInCell(page, 'The stew is alive.');
  await page.keyboard.press('Shift+Alt+F10');
  await expect(controls(page).getByRole('button', { name: 'Add row above' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(controls(page).getByRole('button', { name: 'Add row below' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await rowCount(page)).toBe(5);
  await expect(controls(page).getByRole('button', { name: 'Add row below' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.hb-canvas .ProseMirror')).toBeFocused();
  expect(await caretCell(page)).toBe('tableCell');
  await expect(controls(page)).toBeVisible();
});

test('the controls follow the table through zoom and to the next page', async ({ page }) => {
  await openObjects(page, { doc: 'tables', zoom: '0.5' });
  await clickInCell(page, 'The stew is alive.');
  await expectAnchored(page, table(page));
  // Text before the table pushes it onto page 2 (the caret stays in it).
  await page.evaluate(() => {
    const editor = window.__hbObjects!.editor as unknown as {
      state: { doc: { child(i: number): { child(j: number): { nodeSize: number } } } };
      commands: { insertContentAt(pos: number, content: unknown, options: { updateSelection: boolean }): boolean };
    };
    const filler = 'Travelers speak of an inn that is never in the same place twice. The common room smells of cedar, pipe smoke and rain that never falls outside. ';
    const paragraphs = Array.from({ length: 40 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: filler }] }));
    editor.commands.insertContentAt(1, paragraphs, { updateSelection: false });
  });
  await settle(page);
  const pageOfTable = await table(page).evaluate((el) => Array.from(el.closest('.pages')!.children).indexOf(el.closest('.page')!));
  expect(pageOfTable).toBeGreaterThan(0);
  expect(await caretCell(page)).toBe('tableCell');
  await page.evaluate(() => window.__hbObjects!.editor.view.focus());
  await table(page).scrollIntoViewIfNeeded();
  await expectAnchored(page, table(page));
  await controls(page).getByRole('button', { name: 'Add row below' }).click();
  expect(await rowCount(page)).toBe(5);
  await settle(page);
  await expectAnchored(page, table(page));
});

test('accessibility: the table controls and the size picker (axe, serious and critical)', async ({ page }) => {
  const violations = async (include: string) => {
    const results = await new AxeBuilder({ page }).setLegacyMode(true).include(include).analyze();
    return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  };
  await openObjects(page, { doc: 'tables' });
  await clickInCell(page, 'The stew is alive.');
  await expect(controls(page)).toBeVisible();
  expect(await violations('[data-testid="table-controls"]')).toEqual([]);
  await controls(page).getByTestId('table-more').click();
  await expect(page.getByRole('menu', { name: 'Table options' })).toBeVisible();
  expect(await violations('[role="menu"]')).toEqual([]);
  await page.keyboard.press('Escape');

  await caretAfter(page, 'After the table.');
  await page.getByTestId('table-menu').click();
  await expect(page.getByRole('dialog', { name: 'Insert table' })).toBeVisible();
  expect(await violations('[role="dialog"]')).toEqual([]);
});
