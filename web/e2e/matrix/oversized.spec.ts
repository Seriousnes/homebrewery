// §4.11 row 7 in the app's editor (/edit): a stat block taller than a column. Pagination moves it
// to the top of the next page (it is break-inside: avoid), flags that page oversized and moves
// nothing else; the warning shows in the app bar and on the page. A re-check changes nothing (no
// loop), and the "Allow splitting" fix from the warning clears it in one undoable step.
import { block, doc, events, expect, expectClean, filler, h, openEditor, p, pages, pg, settled, stepsOf, test, watchErrors } from './helpers';

const statBlockDoc = () =>
  doc(
    pg(
      [
        h(1, 'Bestiary'),
        p(filler(900, 0)),
        p(filler(700, 1)),
        block(['monster', 'frame'], [h(2, 'Ancient Dragon'), p(filler(4200, 1))]),
        p(filler(500, 2)),
        p(filler(500, 3)),
      ],
      { pid: 'bestiary' },
    ),
  );

test('a stat block taller than a column: its page is flagged oversized, nothing moves, the warning shows', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: statBlockDoc() });

  const report = await pages(page);
  const flagged = report.filter((r) => r.oversized).map((r) => r.index);
  expect(flagged).toEqual([1]);
  // The stat block moved whole to the top of page 2 (a theme block is never split) …
  expect(report[0]!.blocks.some((b) => b.startsWith('themeBlock'))).toBe(false);
  expect(report[1]!.blocks[0]).toMatch(/^themeBlock:Ancient Dragon/);
  expect(report[1]!.kind).toBe('auto');
  // … and it really is taller than a column: the page overflows (DOM truth), which is what the flag excuses.
  expect(await page.evaluate(() => window.__hbPagination.domTruth(1)!.overflow)).toBe(true);
  await expectClean(page); // overflowing() leaves flagged pages out; no loop guard, no errors

  // The warning: a badge on page 2 and "1 layout warning" in the app bar.
  const pageEls = page.locator('.hb-canvas .ProseMirror > .page');
  await expect(pageEls.nth(1)).toHaveClass(/\bhb-oversized\b/);
  await expect(pageEls.nth(1).locator('.hb-oversized-badge')).toBeVisible();
  await expect(pageEls.nth(0).locator('.hb-oversized-badge')).toHaveCount(0);
  const warnings = page.getByTestId('layout-warnings');
  await expect(warnings).toHaveText('1 layout warning');

  // Nothing moves: a full re-check keeps every page as it is, with no push or pull.
  const texts0 = await page.evaluate(() => window.__hbPagination.texts());
  await events(page);
  await page.evaluate(() => window.__hbPagination.repaginate(0));
  await settled(page);
  const actions = stepsOf(await events(page)).map((s) => s.action);
  expect(actions.length).toBeGreaterThan(0);
  expect(actions.filter((a) => a === 'push' || a === 'pull' || a === 'insert')).toEqual([]);
  expect(await page.evaluate(() => window.__hbPagination.texts())).toEqual(texts0);

  // The fix from the warning (keyboard): "Allow splitting" lets the block flow over the page's
  // two columns; the page is no longer oversized and the warning goes.
  await warnings.focus();
  await page.keyboard.press('Enter');
  const popover = page.getByTestId('layout-warnings-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByText(/Page 2:.*taller than a column/)).toBeVisible();
  await popover.getByRole('button', { name: /Allow splitting/ }).first().click();
  await settled(page);
  await expect(warnings).toBeHidden();
  expect((await pages(page)).filter((r) => r.oversized)).toEqual([]);
  await expect(pageEls.locator('.hb-oversized-badge')).toHaveCount(0);
  await expectClean(page);

  // One undo step brings the warning back.
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page);
  expect((await pages(page)).filter((r) => r.oversized).map((r) => r.index)).toEqual([1]);
  await expect(warnings).toHaveText('1 layout warning');
  await expectClean(page, errors);
});
