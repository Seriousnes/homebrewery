// §4.11 row 4 in the app's editor (/edit): editing the first half of a paragraph split across
// pages. The fragments re-join and re-split at the new line: text leaves the head → the tail
// flows back; text added to the head → its last lines move on. The seam is always at a line start.
import type { Page } from '@playwright/test';
import { expect, expectClean, openEditor, sectionDoc, select, settled, test, texts, watchErrors } from './helpers';

/** The split paragraph: its head (last block of page 1) and tail (first block of page 2). */
async function split(page: Page) {
  return page.evaluate(() => {
    const api = window.__hbPagination;
    const report = api.pages();
    const t = api.texts();
    const last = report[0]!.blocks.length - 1;
    // The head's last line: it ends at the bottom of the last column (the seam is a line start).
    // The head's fragments are line boxes (coordsAtPos would give the glyph box, which leaves out
    // the half-leading), so the bottom of its last fragment (in the last column) is the bottom of its last line.
    const view = api.editor.view as unknown as { nodeDOM(pos: number): Node | null };
    const headStart = api.blockPos(0, last) + 1;
    const headEl = view.nodeDOM(headStart - 1) as Element;
    const box = api.domTruth(0)!.box;
    const fragments = Array.from(headEl.getClientRects()).filter((r) => r.height > 0.5);
    const lastBottom = fragments[fragments.length - 1]!.bottom;
    return {
      head: t[0]![t[0]!.length - 1]!,
      tail: t[1]![0]!,
      tailIsContinuation: report[1]!.blocks[0]!.startsWith('paragraph(cont)'),
      headStart,
      freeBelowHead: box.bottom - lastBottom,
      lineHeight: parseFloat(getComputedStyle(headEl).lineHeight),
    };
  });
}

function expectLineSeam(s: Awaited<ReturnType<typeof split>>): void {
  expect(s.head).toMatch(/\s$/);
  expect(s.tail).toMatch(/^\S/);
  expect(s.freeBelowHead).toBeGreaterThanOrEqual(-0.5);
  expect(s.freeBelowHead).toBeLessThan(2 * s.lineHeight);
}

test('editing the first half of a split paragraph re-joins and re-splits it at the new line', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: sectionDoc(2.3) });
  const s0 = await split(page);
  expect(s0.tailIsContinuation).toBe(true);
  const whole = s0.head + s0.tail;

  // 1. Delete the head's first 120 characters with Backspace: the tail flows back onto page 1.
  await select(page, s0.headStart, s0.headStart + 120);
  await page.keyboard.press('Backspace');
  await settled(page);
  const s1 = await split(page);
  expect(s1.head + s1.tail).toBe(whole.slice(120));
  expect(s1.tail.length).toBeLessThan(s0.tail.length);
  expect(s1.tailIsContinuation).toBe(true);
  // The new seam is at a line start (a soft wrap: the head keeps the space, the tail starts a
  // word), and the head fills its column: less than two lines are left below it (orphans and
  // widows of 2 can hold one line back).
  expectLineSeam(s1);
  await expectClean(page);

  // 2. Type a sentence at the head's start: its last lines move on, the tail grows.
  const added = 'At the crossroads a signpost points four ways, and every arm of it reads Home. ';
  await select(page, s1.headStart);
  await page.keyboard.insertText(added);
  await settled(page);
  const s2 = await split(page);
  expect(s2.head + s2.tail).toBe(added + whole.slice(120));
  expect(s2.tail.length).toBeGreaterThan(s1.tail.length);
  expect(s2.tailIsContinuation).toBe(true);
  expectLineSeam(s2);
  await expectClean(page, errors);

  // The whole document outside the edited paragraph is untouched.
  const t = await texts(page);
  expect(t[0]![0]).toBe('Chapter One');
});
