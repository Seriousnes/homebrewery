// §4.11 row 10 in the app's editor (/edit): a .wide block in the middle of a 2-column page.
// Overflow is detected in the row of columns below the spanner (the text after it fills both
// columns there, and what doesn't fit moves on); when text above it grows so that the spanner
// itself no longer fits, it moves to the next page whole.
import type { Page } from '@playwright/test';
import { block, doc, expect, expectClean, filler, h, openEditor, p, pages, pg, select, settled, test, watchErrors } from './helpers';

const WIDE = 'A table of rumours';
const wideDoc = () =>
  doc(
    pg(
      [
        h(1, 'Chapter One'),
        ...Array.from({ length: 3 }, (_, i) => p(filler(600, i))),
        block(['wide'], [h(4, WIDE), p(filler(700, 4))]),
        ...Array.from({ length: 8 }, (_, i) => p(filler(600, i + 5))),
      ],
      { pid: 'section1' },
    ),
  );

/** Where the wide block is, and the flow of its page read from the DOM. */
function wideState(page: Page) {
  return page.evaluate((title) => {
    const api = window.__hbPagination;
    const report = api.pages();
    const index = report.findIndex((r) => r.blocks.some((b) => b.startsWith(`themeBlock:${title}`)));
    const k = report[index]!.blocks.findIndex((b) => b.startsWith(`themeBlock:${title}`));
    const view = api.editor.view as unknown as { nodeDOM(pos: number): Node | null };
    const el = view.nodeDOM(api.blockPos(index, k)) as HTMLElement;
    const rects = Array.from(el.getClientRects()).filter((r) => r.height > 0.5);
    const box = api.domTruth(index)!.box;
    const wrap = el.parentElement!;
    // Blocks after the spanner, and which side of the page's middle each fragment starts on.
    const after = Array.from(wrap.children).slice(k + 1);
    const middle = (box.left + box.right) / 2;
    const sides = after.flatMap((b) => Array.from(b.getClientRects()).filter((r) => r.height > 0.5).map((r) => (r.left < middle ? 'left' : 'right')));
    const belowSpanner = after.every((b) => Array.from(b.getClientRects()).every((r) => r.height <= 0.5 || r.top >= rects[0]!.bottom - 0.5));
    return {
      page: index,
      index: k,
      fragments: rects.length,
      spans: Math.abs(rects[0]!.width - (box.right - box.left)) < 1,
      continued: report[index]!.blocks[k]!.startsWith('themeBlock(cont)'),
      sides: [...new Set(sides)],
      belowSpanner,
      overflow: report[index]!.overflow,
      measure: api.measure(index),
    };
  }, WIDE);
}

test('a .wide block mid-page: overflow is found below the spanner, and the block moves whole when it no longer fits', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: wideDoc() });
  const s0 = await wideState(page);
  expect(s0.page).toBe(0);
  expect(s0.index).toBe(4);
  expect(s0.fragments).toBe(1); // one box, the width of the page
  expect(s0.spans).toBe(true);
  // Below the spanner the text fills both columns of the row, then moves on to page 2.
  expect(s0.belowSpanner).toBe(true);
  expect(s0.sides).toEqual(['left', 'right']);
  expect(s0.measure!.overflow).toBe(false);
  expect(s0.measure!.rowTop).toBeGreaterThan(s0.measure!.box.top + 100); // the last row starts below the spanner
  const report0 = await pages(page);
  expect(report0.length).toBeGreaterThanOrEqual(2);
  expect(report0[0]!.freeSpace!).toBeLessThan(60);
  await expectClean(page);

  // Text above the spanner grows (typed in the first paragraph) until the spanner no longer
  // fits on page 1: it moves to page 2 as a whole, never split.
  await select(page, await page.evaluate(() => window.__hbPagination.blockPos(0, 2) - 1));
  let s = s0;
  for (let k = 0; k < 60 && s.page === 0; k++) {
    await page.keyboard.insertText(` ${filler(120, k)}`);
    await settled(page);
    s = await wideState(page);
    expect(s.fragments, `step ${k}`).toBe(1);
    expect(s.continued).toBe(false);
    await expectClean(page);
  }
  expect(s.page).toBe(1);
  expect(s.index).toBe(0); // the top of page 2
  expect(s.spans).toBe(true);
  // Page 1 keeps only the text that was above it.
  const report1 = await pages(page);
  expect(report1[0]!.blocks.some((b) => b.startsWith('themeBlock'))).toBe(false);
  await expectClean(page, errors);
});
