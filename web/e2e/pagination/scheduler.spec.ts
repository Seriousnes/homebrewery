// plugin.ts scheduler (plan §4.7, P4.4) in the browser: the ready gate (fonts/theme), isSettled for
// autosave, transactions outside the undo history, an image's page waiting for the image. (No
// restructuring during IME composition: web/e2e/matrix/ime.spec.ts, in the app's editor.)
import { doc, expect, h, imageParagraph, load, page as pg, paragraphs, section, test, uncachedImage, useHarness } from './harness';

test.beforeEach(async ({ page }) => {
  await useHarness(page);
  await load(page, section(2.3));
});

test('waits for the ready gate (fonts, theme) before restructuring', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const api = window.__hbPagination;
    const view = api.editor.view;
    api.setPaginate(false); // the harness's isReady() is false now
    const steps0 = api.state()!.stats.steps;
    api.select(api.endOfPage(0));
    view.dispatch(view.state.tr.insertText(' An addition long enough to overflow the page by a few lines of text at least.'.repeat(3)));
    for (let k = 0; k < 10; k++) await new Promise((resolve) => requestAnimationFrame(resolve));
    const waiting = { steps: api.state()!.stats.steps - steps0, settled: api.isSettled(), overflowing: api.overflowing() };
    api.setPaginate(true);
    await api.settled(10_000);
    return { waiting, after: { overflowing: api.overflowing(), steps: api.state()!.stats.steps - steps0 } };
  });
  expect(r.waiting).toMatchObject({ steps: 0, settled: false });
  expect(r.waiting.overflowing).toContain(0);
  expect(r.after.steps).toBeGreaterThan(0);
  expect(r.after.overflowing).toEqual([]);
});

test('isSettled turns false on an edit and true once pages fit; pagination is not in the undo history', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const api = window.__hbPagination;
    const view = api.editor.view;
    const paginationTransactions: unknown[] = [];
    const editor = api.editor as unknown as { on(event: string, fn: (e: { transaction: { getMeta(k: string): unknown } }) => void): void };
    editor.on('transaction', ({ transaction }) => {
      if (transaction.getMeta('hbPaginate')) paginationTransactions.push(transaction.getMeta('addToHistory'));
    });
    const before = api.texts();
    api.select(api.endOfPage(0));
    view.dispatch(view.state.tr.insertText(' A sentence that pushes the last lines of the page onto the next one.'));
    const settledRightAfter = api.isSettled();
    const s = await api.settled(10_000);
    const afterEdit = api.texts();
    api.editor.commands.undo();
    await api.settled(10_000);
    return { settledRightAfter, frames: s.frames, paginationTransactions, same: JSON.stringify(api.texts()) === JSON.stringify(before), changed: JSON.stringify(afterEdit) !== JSON.stringify(before) };
  });
  expect(r.settledRightAfter).toBe(false);
  expect(r.frames).toBeGreaterThanOrEqual(1);
  expect(r.paginationTransactions.length).toBeGreaterThan(0);
  expect(r.paginationTransactions.every((v) => v === false)).toBe(true);
  expect(r.changed).toBe(true);
  expect(r.same).toBe(true); // one undo = the author's edit, not a pagination step
});

test('an unsized image far down the document: its page waits (not settled) until the image loads, without scrolling', async ({ page }) => {
  // Findings PG-5: images render loading=lazy and imported ones have no width/height, so an image
  // on a page far below the viewport was measured at 0 px and never repaired; and pagination
  // counted as settled while the page waited for it. The image's response is held back here, so
  // the wait is observable.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/assets/catwarrior.jpg*', async (route) => {
    await held;
    await route.continue();
  });
  await load(
    page,
    doc(pg([h(1, 'Chapter One'), ...paragraphs(40, 700), imageParagraph({ src: uncachedImage(), style: 'width: 100%;' }), ...paragraphs(6, 700, 3)], { pid: 'section1' })),
    false,
  );
  const during = await page.evaluate(async () => {
    const api = window.__hbPagination;
    // Wait for the pass to end with the image's page waiting.
    const t0 = performance.now();
    while (performance.now() - t0 < 10_000 && !(api.state()!.dirtyFrom === null && api.state()!.waiting.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const image = document.querySelector<HTMLImageElement>('.ProseMirror img:not(.ProseMirror-separator)')!;
    const pageOf = (el: Element) => Array.from(document.querySelectorAll('.ProseMirror > .page')).indexOf(el.closest('.page')!);
    return { waiting: api.state()!.waiting, settled: api.isSettled(), page: pageOf(image), complete: image.complete, steps: api.state()!.stats.steps };
  });
  expect(during.complete).toBe(false);
  expect(during.page).toBeGreaterThan(2); // far below the viewport
  expect(during.waiting).toContain(during.page);
  expect(during.settled).toBe(false); // autosave keeps waiting
  release();
  const r = await page.evaluate(async (stepsBefore) => {
    const api = window.__hbPagination;
    const image = () => document.querySelector<HTMLImageElement>('.ProseMirror img:not(.ProseMirror-separator)')!;
    const pageOf = (el: Element) => Array.from(document.querySelectorAll('.ProseMirror > .page')).indexOf(el.closest('.page')!);
    // Wait (without scrolling) until the image has loaded and pagination has been settled for a
    // while: a boundary move re-renders the image's paragraph, and the new img loads again.
    const t0 = performance.now();
    for (let stable = 0; stable < 5 && performance.now() - t0 < 10_000; ) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const img = image();
      const ready = (img.complete && img.naturalHeight > 0) || (img.hasAttribute('width') && img.hasAttribute('height'));
      stable = ready && api.isSettled() ? stable + 1 : 0;
    }
    const img = image();
    return {
      // Loaded, or sized from its stored natural size (the objects lane records it on the first load;
      // a re-rendered, lazy img far below the viewport may then not load again until scrolled to).
      loaded: (img.complete && img.naturalHeight > 0) || (img.hasAttribute('width') && img.hasAttribute('height')),
      height: img.getBoundingClientRect().height,
      page: pageOf(img),
      scrollY: window.scrollY,
      steps: api.state()!.stats.steps - stepsBefore,
      waiting: api.state()!.waiting,
      overflowing: api.overflowing(),
      settled: api.isSettled(),
    };
  }, during.steps);
  expect(r.scrollY).toBe(0);
  expect(r.loaded).toBe(true);
  expect(r.height).toBeGreaterThan(100);
  expect(r.steps).toBeGreaterThan(0); // its page was checked again after the load
  expect(r.waiting).toEqual([]);
  expect(r.overflowing).toEqual([]);
  expect(r.settled).toBe(true);
});
