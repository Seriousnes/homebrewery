// P5.6 tables on /dev/objects: header rows styled like upstream's <thead> by the theme's own
// rules (hb-header-row + the selector rewrite), the class table snippet imported and edited
// without losing spans, and the TableMenu (insert, merge/split, widths, header rows, classes).
// E2E_PORT=5328 pnpm exec playwright test e2e/objects/tables.spec.ts
import { expect, type Page } from '@playwright/test';
import { test, caretAfter, clickInText, openObjects, settle, tableMenu, undo } from './helpers';

const table = (page: Page) => page.locator('.hb-canvas .page table').first();

/** Cell spans of the first table: "colspan x rowspan" for every cell with a span. */
const spans = (page: Page) =>
  table(page).evaluate((t) =>
    Array.from(t.querySelectorAll('th, td'))
      .filter((c) => c.hasAttribute('colspan') || c.hasAttribute('rowspan'))
      .map((c) => `${(c.textContent ?? "").trim()}:${c.getAttribute('colspan') ?? 1}x${c.getAttribute('rowspan') ?? 1}`),
  );

/** Columns per row, counting spans (rowspans carried down): all equal in a consistent table. */
const rowWidths = (page: Page) =>
  table(page).evaluate((t) => {
    const rows = Array.from(t.querySelectorAll(':scope > tbody > tr'));
    const carry: number[] = [];
    return rows.map((row, r) => {
      let width = carry[r] ?? 0;
      for (const cell of Array.from(row.children)) {
        const cs = Number(cell.getAttribute('colspan') ?? 1);
        const rs = Number(cell.getAttribute('rowspan') ?? 1);
        width += cs;
        for (let k = 1; k < rs; k++) carry[r + k] = (carry[r + k] ?? 0) + cs;
      }
      return width;
    });
  });

test('header rows look like upstream <thead> rows (5ePHB): bold, bottom-aligned, not striped', async ({ page }) => {
  await openObjects(page, { doc: 'tables' });
  const header = table(page).locator('tr').nth(0);
  const firstBody = table(page).locator('tr').nth(1);
  const secondBody = table(page).locator('tr').nth(2);
  await expect(header).toHaveClass(/hb-header-row/);
  const style = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.hb-canvas .page table tr'));
    const cs = (el: Element) => getComputedStyle(el);
    return {
      headerDisplay: cs(rows[0]!).display,
      headerWeight: cs(rows[0]!.querySelector('th')!).fontWeight,
      headerAlign: cs(rows[0]!.querySelector('th')!).verticalAlign,
      headerBg: cs(rows[0]!).backgroundColor,
      body1Bg: cs(rows[1]!).backgroundColor,
      body2Bg: cs(rows[2]!).backgroundColor,
      accent: getComputedStyle(document.querySelector('.hb-canvas')!).getPropertyValue('--HB_Color_Accent').trim(),
    };
  });
  expect(style.headerDisplay).toBe('table-row');
  expect(style.headerWeight).toBe('800');
  expect(style.headerAlign).toBe('bottom');
  expect(style.headerBg).toBe('rgba(0, 0, 0, 0)');
  // tbody tr:nth-child(odd): the first *body* row is striped, as in upstream's own <tbody>.
  expect(style.body1Bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(style.body2Bg).toBe('rgba(0, 0, 0, 0)');
  expect(firstBody).toBeTruthy();
  expect(secondBody).toBeTruthy();
});

test('the full caster class table imports and edits without losing its spans', async ({ page }) => {
  await openObjects(page, { fixture: 'snippet-5ephb-tables-class-tables-full-caster-class-table' });
  await expect(table(page).locator('tr.hb-header-row')).toHaveCount(2);
  const imported = await spans(page);
  expect(imported.filter((s) => s.endsWith(':9x1'))).toHaveLength(1);
  expect(imported.filter((s) => s.endsWith(':1x2'))).toHaveLength(4);
  const width = (await rowWidths(page))[0]!;
  expect(new Set(await rowWidths(page))).toEqual(new Set([width]));
  await expect(page.locator('.hb-canvas .page div.block.classTable.frame.decoration.wide > table')).toHaveCount(1);

  // Add a row and a column in the body, delete the column again.
  await clickInText(page, table(page).locator('tr').nth(3).locator('td').nth(2));
  await tableMenu(page, 'Add row below');
  await tableMenu(page, 'Add column right');
  expect(new Set(await rowWidths(page))).toEqual(new Set([width + 1]));
  expect((await spans(page)).filter((s) => s.endsWith(':10x1'))).toHaveLength(0); // the column is outside the spell slots
  // The new column (right of Features) goes again.
  await clickInText(page, table(page).locator('tr').nth(3).locator('td').nth(3));
  await tableMenu(page, 'Delete column');
  expect(new Set(await rowWidths(page))).toEqual(new Set([width]));
  expect(await spans(page)).toEqual(imported);

  // A column inside the "Spell Slots" span grows the span.
  await clickInText(page, table(page).locator('tr').nth(3).locator('td').nth(6));
  await tableMenu(page, 'Add column right');
  expect((await spans(page)).filter((s) => s.endsWith(':10x1'))).toHaveLength(1);
  await undo(page);
  expect(await spans(page)).toEqual(imported);

  // Table style: decoration off, then back on (one undo step).
  await tableMenu(page, 'Decoration', 'menuitemcheckbox');
  await expect(page.locator('.hb-canvas .page div.block.classTable.decoration')).toHaveCount(0);
  await undo(page);
  await expect(page.locator('.hb-canvas .page div.block.classTable.decoration')).toHaveCount(1);
  await settle(page);
});

test('the TableMenu inserts a table, merges and splits cells, sets widths and header rows', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  await caretAfter(page, 'Hello there, adventurer.');
  await tableMenu(page, 'Insert table');
  await expect(table(page).locator('tr')).toHaveCount(3);
  await expect(table(page).locator('tr.hb-header-row')).toHaveCount(1);

  // Merge two cells of the second row (shift-click makes a cell selection).
  const row = table(page).locator('tr').nth(1);
  await clickInText(page, row.locator('td').nth(0));
  // ProseMirror re-syncs the DOM selection 20 ms after it gets focus: wait for the caret to be
  // in the body cell before extending the selection from it.
  await expect.poll(() => page.evaluate(() => (window.__hbObjects!.editor.state as unknown as { selection: { $from: { node(d: number): { type: { name: string } } } } }).selection.$from.node(-1).type.name)).toBe('tableCell');
  await row.locator('td').nth(1).click({ modifiers: ['Shift'] });
  await tableMenu(page, 'Merge cells');
  await expect(row.locator('td[colspan="2"]')).toHaveCount(1);
  await clickInText(page, row.locator('td[colspan="2"]'));
  await tableMenu(page, 'Split cell');
  await expect(row.locator('td')).toHaveCount(3);

  // Column width.
  await clickInText(page, row.locator('td').nth(0));
  await tableMenu(page, /^Column width/);
  await page.getByTestId('column-width-input').fill('150');
  await page.getByTestId('column-width-apply').click();
  await expect(table(page).locator(':scope > colgroup > col').first()).toHaveAttribute('style', /width: 150px/);
  const cellWidth = await row.locator('td').nth(0).evaluate((el) => el.getBoundingClientRect().width);
  expect(cellWidth).toBeGreaterThan(140);

  // Make the second row a header row too: now two header rows.
  await clickInText(page, row.locator('td').nth(1));
  await tableMenu(page, 'Header row', 'menuitemcheckbox');
  await expect(table(page).locator('tr.hb-header-row')).toHaveCount(2);
  await expect(row.locator('th')).toHaveCount(3);
});
