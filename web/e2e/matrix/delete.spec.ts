// §4.11 row 2 in the app's editor (/edit): deleting on page 1 of a 3-page section pulls the
// content back, and auto pages left empty disappear.
import { expect, expectClean, expectNoEmptyAutoPages, flowText, openEditor, pages, sectionDoc, select, settled, test, texts, watchErrors } from './helpers';

test('deleting on page 1 of a 3-page section pulls content back and removes the emptied auto pages', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: sectionDoc(2.3) });
  const before = await pages(page);
  expect(before.map((p) => p.kind)).toEqual(['manual', 'auto', 'auto']);
  const flow0 = await flowText(page);

  // 1. Paragraphs 2–5 of page 1 (block 0 is the h1), deleted with Backspace: one page less.
  const deleted = await page.evaluate(() => {
    const api = window.__hbPagination;
    return { from: api.blockPos(0, 2) + 1, to: api.blockPos(0, 6) - 1, texts: [2, 3, 4, 5].map((i) => api.texts()[0]![i]!) };
  });
  await select(page, deleted.from, deleted.to);
  await page.keyboard.press('Backspace');
  const firstDeletion = Date.now();
  await settled(page);
  const afterFirst = await pages(page);
  expect(afterFirst.map((p) => p.kind)).toEqual(['manual', 'auto']);
  // The four paragraphs became one empty one … which the flow text shows as an empty line.
  expect(await flowText(page)).toBe(flow0.replace(deleted.texts.join('\n'), ''));
  await expectNoEmptyAutoPages(page);
  await expectClean(page);
  // Pulled back: the first page is full again (less than two lines free at its end).
  expect(afterFirst[0]!.freeSpace!).toBeLessThan(60);

  // The history merges adjacent edits made less than 500 ms apart into one undo step (on a quiet
  // machine the two deletions were): let 600 ms pass since the first, so each deletion is its own
  // step, as for an author.
  await page.waitForTimeout(Math.max(0, 600 - (Date.now() - firstDeletion)));

  // 2. Everything from the second paragraph of page 1 to the middle of page 2, across the seam:
  //    the rest fits on page 1, so the last auto page goes too.
  const range = await page.evaluate(() => {
    const api = window.__hbPagination;
    const t = api.texts();
    const last = api.pages()[1]!.blocks.length - 1; // the last paragraph of the document
    return { from: api.blockPos(0, 1) + 1, to: api.blockPos(1, last) + 1, kept: t[1]![t[1]!.length - 1]! };
  });
  await select(page, range.from, range.to);
  await page.keyboard.press('Delete');
  await settled(page);
  const afterSecond = await pages(page);
  expect(afterSecond.map((p) => p.kind)).toEqual(['manual']);
  const t = await texts(page);
  expect(t[0]![0]).toBe('Chapter One');
  expect(t[0]!.join('')).toContain(range.kept);
  await expectClean(page, errors);

  // One undo step per deletion: undo brings back the second deletion's text and its page.
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page);
  expect((await pages(page)).map((p) => p.kind)).toEqual(['manual', 'auto']);
  await expectNoEmptyAutoPages(page);
  await expectClean(page, errors);
});
