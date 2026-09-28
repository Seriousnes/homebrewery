// §4.11 row 1 in the app's editor (/edit): typing at the end of a full 2-column page. The last
// line moves to the next page before the frame is painted, and the caret follows it.
import type { FrameReport } from '../pagination/harness';
import { expect, expectClean, openEditor, pages, sectionDoc, test, texts, watchErrors } from './helpers';

test('typing at the end of a full 2-column page moves the last line before paint, and the caret follows', { tag: '@smoke' }, async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: sectionDoc(2.3) });
  const before = await pages(page);
  expect(before.length).toBe(3);
  expect(before[1]!.kind).toBe('auto');
  expect(before[1]!.blocks[0]).toMatch(/^paragraph\(cont\)/); // page 1 is full: its last paragraph continues
  await page.evaluate(() => {
    const api = window.__hbPagination;
    api.select(api.endOfPage(0));
    api.frameWatch();
  });

  let movedAt = -1;
  const typed = 'wonderful and strange';
  for (let k = 0; k < typed.length; k++) {
    await page.keyboard.type(typed[k]!);
    // One animation frame later (pagination's callback runs first in the frame), nothing overflows.
    const r = await page.evaluate(
      () =>
        new Promise<{ overflowing: number[]; page: number }>((resolve) =>
          requestAnimationFrame(() => resolve({ overflowing: window.__hbPagination.overflowing(), page: window.__hbPagination.selection().page })),
        ),
    );
    expect(r.overflowing, `after "${typed.slice(0, k + 1)}"`).toEqual([]);
    if (movedAt < 0 && r.page === 1) movedAt = k;
  }
  const report: FrameReport = await page.evaluate(() => window.__hbFrameWatch!());
  await testInfo.attach('frames.json', { body: JSON.stringify({ movedAt, ...report }, null, 2), contentType: 'application/json' });
  // Every painted frame was checked right before paint (after pagination): none showed an overflowing
  // page. Each keystroke's check above waited for a frame of its own (the watch toggles its probe in
  // every frame), so there were at least as many frames as keystrokes.
  expect(report.frames).toBeGreaterThanOrEqual(typed.length);
  expect(report.overflowFrames).toEqual([]);

  // The line moved to page 2, and the caret with it: in the model, in the DOM selection, on screen.
  expect(movedAt).toBeGreaterThanOrEqual(0);
  const caret = await page.evaluate(() => {
    const api = window.__hbPagination;
    const view = api.editor.view as unknown as { dom: HTMLElement; hasFocus(): boolean };
    const sel = window.getSelection()!;
    const pageEls = Array.from(view.dom.querySelectorAll(':scope > .page'));
    const focusPage = pageEls.findIndex((el) => el.contains(sel.focusNode));
    const rect = sel.getRangeAt(0).getClientRects()[0] ?? sel.getRangeAt(0).getBoundingClientRect();
    const box = pageEls[1]!.querySelector(':scope > div.columnWrapper')!.getBoundingClientRect();
    return {
      modelPage: api.selection().page,
      focusPage,
      hasFocus: view.hasFocus(),
      insidePage2: rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
      caretBlock: api.caretInBlock(),
    };
  });
  expect(caret).toMatchObject({ modelPage: 1, focusPage: 1, hasFocus: true, insidePage2: true });
  expect(caret.caretBlock!.text.slice(0, caret.caretBlock!.offset)).toMatch(/wonderful and strange$/);
  expect((await texts(page))[1]![0]).toContain('wonderful and strange');
  await expectClean(page, errors);
});
