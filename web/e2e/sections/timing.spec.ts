// The canvas's timed behaviour on /dev/sections, in the page's own time (Playwright's fake clock,
// web/e2e/clock.ts): the user CSS repagination's 300 ms debounce (plan §4.7, P4.5) and the layout
// status's delay (P4.8). Each test opens a page of its own, with the clock installed before the
// navigation (the other /dev/sections specs share one page per worker, without a fake clock).
// Both browsers.
import { expect, test, type Page } from '@playwright/test';
import { pauseClock } from '../clock';
import { doc, h, load, openHarness, page as pg, paragraphs, settled, type HarnessEvent } from '../pagination/harness';

const events = (page: Page) => page.evaluate(() => window.__hbPagination.events());
const steps = (list: HarnessEvent[]) => list.filter((e): e is Extract<HarnessEvent, { kind: 'step' }> => e.kind === 'step');
const cssRepaginations = (list: HarnessEvent[]) =>
  list.filter((e): e is Extract<HarnessEvent, { kind: 'repaginate' }> => e.kind === 'repaginate' && e.source === 'canvas' && e.reason === 'css');

test.beforeEach(async ({ page }) => {
  // A page load of its own (Firefox: about 5 s, up to 11 s beside other Firefox runs) on top of the
  // test's work.
  test.setTimeout(30_000);
  await page.clock.install();
});

test('user CSS changes (debounced 300 ms): one re-check from page 0, and the pages follow the new style', async ({ page }) => {
  await openHarness(page, { sections: true });
  await load(page, doc(pg([h(1, 'Chapter'), ...paragraphs(20, 600)], { pid: 'section1' })));
  const before = await page.evaluate(() => window.__hbPagination.pages().length);
  await pauseClock(page);
  await events(page); // start with an empty log

  // Two edits 100 ms apart (setUserCss renders synchronously: each edit's time is the paused clock's).
  await page.evaluate(() => window.__hbPagination.setUserCss('.page p { font-size: 11px; }'));
  await page.clock.runFor(100);
  await page.evaluate(() => window.__hbPagination.setUserCss('.page p { font-size: 17px; line-height: 1.5; }'));
  await page.clock.runFor(299);
  // The second edit's style is applied (after its 150 ms debounce) and the canvas is ready again,
  // which is when it schedules the repagination: 300 ms after that edit, 1 ms from now.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const storage = (window.__hbPagination.editor as unknown as { storage: { hbCanvas: { ready: boolean } } }).storage.hbCanvas;
        const applied = document.adoptedStyleSheets.some((sheet) => Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('17px')));
        return { applied, ready: storage.ready };
      }),
    )
    .toEqual({ applied: true, ready: true });
  const log = await events(page);
  expect(cssRepaginations(log)).toEqual([]); // not before 300 ms
  await page.clock.runFor(1);
  log.push(...(await events(page)));
  const css = cssRepaginations(log);
  expect(css).toHaveLength(1); // two edits, one repagination
  expect(css[0]!.from).toBe(0);

  await page.clock.resume();
  await settled(page);
  log.push(...(await events(page)));
  expect(cssRepaginations(log)).toHaveLength(1); // every timer of both edits has run: no second one
  expect(steps(log.slice(log.indexOf(css[0]!)))[0]!.page).toBe(0);
  const after = await page.evaluate(() => ({ pages: window.__hbPagination.pages().length, overflowing: window.__hbPagination.overflowing() }));
  expect(after.pages).toBeGreaterThan(before); // bigger text, more pages
  expect(after.overflowing).toEqual([]);
});

test('"Laying out pages…" shows during a long pass only, and goes when it ends', async ({ page }) => {
  await openHarness(page, { sections: true, busyDelay: 30 });
  await page.evaluate(() => {
    const status = document.querySelector('[data-testid="layout-status-text"]')!;
    const seen: string[] = [];
    (window as unknown as { __statusSeen: string[] }).__statusSeen = seen;
    new MutationObserver(() => seen.push(status.textContent ?? '')).observe(status, { childList: true, subtree: true, characterData: true });
  });
  // A 30-page load: a pass of many frames (an 8 ms budget each), far longer than the 30 ms delay.
  await page.evaluate(async () => {
    window.__hbPagination.load('long30');
    await window.__hbPagination.settled(10_000);
  });
  await expect(page.getByTestId('layout-status-text')).toHaveText('');
  const seen = await page.evaluate(() => (window as unknown as { __statusSeen: string[] }).__statusSeen);
  expect(seen.some((t) => t.includes('Laying out pages…'))).toBe(true);

  // A small edit settles within the delay: nothing shows. On the paused clock the pass runs in the
  // first frame after the keystroke (16 ms at most; its budget is clock time, which stands still
  // within the frame) and the delay's timer, 30 ms after the keystroke, finds it done.
  await pauseClock(page);
  await page.evaluate(() => {
    (window as unknown as { __statusSeen: string[] }).__statusSeen.length = 0;
    const api = window.__hbPagination;
    api.select(api.posOf('Travelers'));
  });
  await page.keyboard.type('x');
  await page.clock.runFor(100);
  const r = await page.evaluate(() => ({
    dirtyFrom: window.__hbPagination.state()!.dirtyFrom,
    busy: document.querySelector('[data-testid="layout-status-text"]')!.getAttribute('data-busy'),
    seen: (window as unknown as { __statusSeen: string[] }).__statusSeen,
  }));
  expect(r.dirtyFrom).toBeNull(); // settled
  expect(r.busy).toBe('false');
  expect(r.seen.some((t) => t.includes('Laying out'))).toBe(false);
  expect(await page.evaluate(() => window.__hbPagination.texts().flat().some((t) => t.includes('Travelersx') || t.includes('xTravelers')))).toBe(true);
});
