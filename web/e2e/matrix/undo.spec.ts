// §4.11 row 3 in the app's editor (/edit): undo and redo after a split restore the text, and the
// pages settle to the same layout as before. Pagination's own transactions stay out of the
// history: one author action is one undo step.
import { expect, expectClean, openEditor, sectionDoc, select, settled, test, texts, watchErrors } from './helpers';

const ADDED = ' The wanderers argue until dawn about the price of a room, a meal and a stable for the mules, and nobody wins.';

test('undo and redo after a split restore the text and settle to the same layout', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: sectionDoc(2.3) });
  const l0 = await texts(page);
  expect(l0.length).toBe(3);

  // One input event (one transaction) at the end of the full page 1: its last paragraph splits
  // at a new line, and page 2 starts with more of it.
  await select(page, await page.evaluate(() => window.__hbPagination.endOfPage(0)));
  await page.keyboard.insertText(ADDED);
  await settled(page);
  const l1 = await texts(page);
  expect(l1).not.toEqual(l0);
  expect(l1[1]![0]!.length).toBeGreaterThan(l0[1]![0]!.length); // the continuation on page 2 grew
  expect(l1.flat().join('')).toContain(ADDED.trim());
  await expectClean(page);

  // Undo with the keyboard: the text and the layout of before.
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page);
  expect(await texts(page)).toEqual(l0);
  await expectClean(page);

  // Redo with the keyboard: the split layout again.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await settled(page);
  expect(await texts(page)).toEqual(l1);
  await expectClean(page);

  // The toolbar's Undo does the same, once (pagination added no history steps of its own).
  const undo = page.getByRole('button', { name: /^Undo/ }).first();
  await undo.click();
  await settled(page);
  expect(await texts(page)).toEqual(l0);
  await expect(undo).toBeDisabled();
  await expectClean(page, errors);
});
