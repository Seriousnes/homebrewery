// §4.11 row 6 in the app's editor (/edit): a heading on the last line of a page moves to the next
// page with the paragraph after it (keep-with-next). Text typed above the heading pushes it down
// a line at a time; at no step is a heading left at the bottom of a page whose text continues
// on the next one, and when the heading moves it leaves room it would have fitted in.
import { doc, expect, expectClean, expectNoStrandedHeadings, filler, h, openEditor, p, pages, pg, select, settled, test, watchErrors } from './helpers';

const HEADING = 'The Sunken Stair';

/** Page 1 filled to near its end, then a heading and a long paragraph that runs onto page 2. */
const headingDoc = () =>
  doc(
    pg(
      [h(1, 'Chapter One'), ...Array.from({ length: 7 }, (_, i) => p(filler(640, i))), h(3, HEADING), p(filler(1400, 3)), p(filler(600, 5))],
      { pid: 'section1' },
    ),
  );

test('a heading on the last line of a page moves with the paragraph after it', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: headingDoc() });
  const where = () =>
    page.evaluate((title) => {
      const api = window.__hbPagination;
      const report = api.pages();
      const pageIndex = report.findIndex((r) => r.blocks.some((b) => b === `heading:${title}`));
      const blocks = report[pageIndex]!.blocks;
      const k = blocks.indexOf(`heading:${title}`);
      const view = api.editor.view as unknown as { nodeDOM(pos: number): Node | null };
      const el = view.nodeDOM(api.blockPos(pageIndex, k)) as HTMLElement;
      return {
        page: pageIndex,
        last: k === blocks.length - 1,
        next: blocks[k + 1] ?? null,
        first: k === 0,
        height: el.getBoundingClientRect().height,
        freeBefore: pageIndex > 0 ? report[pageIndex - 1]!.freeSpace! : null,
      };
    }, HEADING);

  const start = await where();
  expect(start.page).toBe(0); // it starts on page 1, with its paragraph after it
  expect(start.next).toMatch(/^paragraph/);
  await expectNoStrandedHeadings(page);

  // Type above the heading, about half a line at a time, until the heading has moved.
  await select(page, await page.evaluate(() => window.__hbPagination.blockPos(0, 2) - 1)); // end of the first paragraph
  let moved: Awaited<ReturnType<typeof where>> | null = null;
  for (let k = 0; k < 80 && !moved; k++) {
    await page.keyboard.insertText(` ${filler(30, k)}`);
    await settled(page);
    await expectNoStrandedHeadings(page);
    const now = await where();
    expect(now.last, `step ${k}: the heading is the last block of its page`).toBe(false);
    if (now.page === 1) moved = now;
    if (k % 10 === 0) await expectClean(page);
  }
  expect(moved, 'the heading moved to page 2').not.toBeNull();
  // It moved to the top of page 2, followed by its paragraph …
  expect(moved!.first).toBe(true);
  expect(moved!.next).toMatch(/^paragraph/);
  // … while there was still room for it on page 1: it moved to stay with its text, not because
  // it didn't fit.
  expect(moved!.freeBefore!).toBeGreaterThan(moved!.height);
  await expectClean(page, errors);

  // Undo the last insertion: the heading goes back to page 1, where its paragraph starts too.
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page);
  const back = await where();
  expect(back.page).toBe(0);
  expect(back.last).toBe(false);
  await expectNoStrandedHeadings(page);
  const report = await pages(page);
  expect(report.length).toBeGreaterThanOrEqual(2);
  await expectClean(page, errors);
});
