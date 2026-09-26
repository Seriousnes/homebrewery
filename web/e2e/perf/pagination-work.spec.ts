// The P8.1 pagination optimisations on the real layout (plan §4.10; the timings are perf.spec.ts):
//
//   - typing in the middle of a page checks that page only (not the page before it), and the
//     steps that only measure go out as one transaction, not one each
//   - a page with room takes exactly the lines that fit from a paragraph on the next page, so
//     nothing is pushed back
//   - offscreen pages skip rendering (content-visibility: auto), and a measurement of one gives
//     the same result as when it is on screen
import type { Page } from '@playwright/test';
import { expect, settled, test, useHarness } from '../pagination/harness';

const api = <T>(page: Page, fn: () => T) => page.evaluate(fn);

/**
 * Counts the transactions with pagination's meta from now on (read with paginationTransactions).
 * The listener goes on once per editor: the page, and so the editor, is shared by the tests of a
 * worker (useHarness).
 */
async function countPaginationTransactions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __paginateCount: number;
      __paginateCounting?: unknown;
      __hbPagination: { editor: { on(e: string, f: (p: { transaction: { getMeta(k: string): unknown } }) => void): void } };
    };
    w.__paginateCount = 0;
    if (w.__paginateCounting === w.__hbPagination.editor) return;
    w.__paginateCounting = w.__hbPagination.editor;
    w.__hbPagination.editor.on('transaction', ({ transaction }) => {
      if (transaction.getMeta('hbPaginate') !== undefined) w.__paginateCount += 1;
    });
  });
}
const paginationTransactions = (page: Page) => page.evaluate(() => (window as unknown as { __paginateCount: number }).__paginateCount);

test.describe('pagination work (P8.1)', () => {
  test('typing in the middle of a page checks that page only, with one pagination transaction per keystroke', async ({ page }) => {
    await useHarness(page, { doc: 'long30' });
    // The third block of page 10: past what page 9 could pull.
    const pos = await page.evaluate(() => window.__hbPagination.blockPos(10, 2) + 40);
    await page.evaluate((p) => window.__hbPagination.select(p), pos);
    await api(page, () => window.__hbPagination.events());
    await countPaginationTransactions(page);
    for (const ch of 'abc') {
      await page.keyboard.type(ch);
      await settled(page);
    }
    const steps = (await api(page, () => window.__hbPagination.events())).filter((e) => e.kind === 'step');
    expect(steps.length).toBeGreaterThanOrEqual(3);
    // Page 9 is never checked; each keystroke starts at page 10.
    expect(steps.every((s) => (s as { page: number }).page >= 10)).toBe(true);
    const settledOnly = steps.every((s) => (s as { action: string }).action === 'settled');
    // A keystroke that only needed its page measured sends one pagination transaction.
    if (settledOnly) expect(await paginationTransactions(page)).toBe(3);
    expect(await api(page, () => window.__hbPagination.overflowing())).toEqual([]);
  });

  test('a page with room takes exactly the lines that fit from the next page: nothing is pushed back', async ({ page }) => {
    await useHarness(page, { doc: 'long30' });
    // Delete the third paragraph of page 5: every page after it pulls back about a dozen lines.
    const [from, to] = await page.evaluate(() => [window.__hbPagination.blockPos(5, 2), window.__hbPagination.blockPos(5, 3)]);
    await api(page, () => window.__hbPagination.events());
    await page.evaluate(
      ([a, b]) => {
        const { editor } = window.__hbPagination as unknown as { editor: { view: { dispatch(tr: unknown): void }; state: { tr: { delete(a: number, b: number): unknown } } } };
        editor.view.dispatch(editor.state.tr.delete(a, b));
      },
      [from, to] as const,
    );
    await settled(page);
    const steps = (await api(page, () => window.__hbPagination.events())).filter((e) => e.kind === 'step') as { page: number; action: string }[];
    const pulls = steps.filter((s) => s.action === 'pull').length;
    const pushes = steps.filter((s) => s.action === 'push').length;
    expect(pulls).toBeGreaterThan(10); // the pages after page 5 pulled
    // Before P8.1 a paragraph that fit in part was pulled whole and the rest pushed back: a push
    // for nearly every pull. Now at most an occasional one (a line the estimate got wrong).
    expect(pushes).toBeLessThanOrEqual(Math.ceil(pulls / 10));
    expect(await api(page, () => window.__hbPagination.overflowing())).toEqual([]);
    // The result is a fixed point: checking every page again changes nothing.
    await page.evaluate(() => window.__hbPagination.repaginate(0));
    await settled(page);
    const again = (await api(page, () => window.__hbPagination.events())).filter((e) => e.kind === 'step') as { action: string }[];
    expect(again.filter((s) => s.action !== 'settled')).toEqual([]);
  });

  test('offscreen pages skip rendering where layout queries see them, and measuring one gives what it gives on screen', async ({ page, browserName }) => {
    await useHarness(page, { doc: 'long30' });
    // EditorCanvas asks the browser (canvas/offscreen.ts): Chromium brings skipped content up to
    // date for layout queries, Firefox answers with empty boxes, so its pages stay visible.
    const skip = (await page.locator('.hb-canvas').getAttribute('data-hb-offscreen')) === 'skip';
    expect(skip).toBe(browserName === 'chromium');
    const cv = await page.evaluate(() => getComputedStyle(document.querySelectorAll<HTMLElement>('.hb-canvas .page')[20]!).contentVisibility);
    expect(cv).toBe(skip ? 'auto' : 'visible');
    // At most the page pagination measured last and the one after it are marked to render.
    expect(await page.locator('.hb-canvas .page[data-hb-measuring]').count()).toBeLessThanOrEqual(2);
    const relative = (m: { box: { left: number; top: number }; overflow: boolean; columns: number; lastColumn: number; lastBottom: number; freeSpace: number } | null) =>
      m && { overflow: m.overflow, columns: m.columns, lastColumn: m.lastColumn, lastBottom: Math.round((m.lastBottom - m.box.top) * 10) / 10, freeSpace: Math.round(m.freeSpace * 10) / 10 };
    // Page 20 is far below the viewport: skipped.
    await page.evaluate(() => document.querySelector('.hb-canvas .page')!.scrollIntoView());
    const offscreen = relative(await page.evaluate(() => window.__hbPagination.measure(20)));
    const truthOff = await page.evaluate(() => window.__hbPagination.domTruth(20)?.overflow);
    await page.evaluate(() => document.querySelectorAll('.hb-canvas .page')[20]!.scrollIntoView());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const onscreen = relative(await page.evaluate(() => window.__hbPagination.measure(20)));
    expect(offscreen).not.toBeNull();
    expect(offscreen).toEqual(onscreen);
    expect(truthOff).toBe(false);
  });
});
