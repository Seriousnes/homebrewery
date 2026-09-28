// Repagination triggers (plan §4.7, P4.5) in the browser: each shows the pages the check starts
// (and ends) at. /dev/sections is EditorCanvas, which owns the theme and user CSS triggers (the
// user CSS debounce, on a fake clock: timing.spec.ts; the fonts one: web/e2e/matrix/lateFont.spec.ts,
// in the app's editor); pagination owns the image, section and parity ones. Both browsers. The page
// is shared by the tests of a worker (the harness's `test`): a test that changes the brew CSS puts
// it back.
import type { Page } from '@playwright/test';
import { doc, expect, h, imageParagraph, load, page as pg, paragraphs, settled, test, uncachedImage, useHarness, type HarnessEvent } from '../pagination/harness';

test.use({ harnessVariant: 'sections' });

const events = (page: Page) => page.evaluate(() => window.__hbPagination.events());
const steps = (list: HarnessEvent[]) => list.filter((e): e is Extract<HarnessEvent, { kind: 'step' }> => e.kind === 'step');
const repaginations = (list: HarnessEvent[]) => list.filter((e): e is Extract<HarnessEvent, { kind: 'repaginate' }> => e.kind === 'repaginate');

/** Polls the event log until `done` holds (the canvas triggers are debounced or asynchronous). */
async function collectUntil(page: Page, done: (log: HarnessEvent[]) => boolean, timeoutMs = 10_000): Promise<HarnessEvent[]> {
  const log: HarnessEvent[] = [];
  await expect
    .poll(
      async () => {
        log.push(...(await events(page)));
        return done(log);
      },
      { timeout: timeoutMs, message: 'the trigger is seen' },
    )
    .toBe(true);
  return log;
}

/** Puts the brew CSS back to none, and waits for its re-check. */
async function clearUserCss(page: Page): Promise<void> {
  await events(page);
  await page.evaluate(() => window.__hbPagination.setUserCss(''));
  await collectUntil(page, (l) => repaginations(l).some((r) => r.source === 'canvas' && r.reason === 'css'));
  await settled(page);
}

test.beforeEach(async ({ page }) => {
  await useHarness(page, { sections: true });
  await load(page, doc(pg([h(1, 'Chapter'), ...paragraphs(20, 600)], { pid: 'section1' })));
  await events(page); // start with an empty log
});

test('a theme change: re-check from page 0', async ({ page }) => {
  await page.evaluate(() => window.__hbPagination.setTheme('Blank'));
  const log = await collectUntil(page, (l) => repaginations(l).some((r) => r.source === 'canvas' && r.reason === 'theme'));
  expect(repaginations(log).find((r) => r.reason === 'theme')!.from).toBe(0);
  await expect(page.locator('[data-canvas-theme="Blank"][data-canvas-status="ready"]')).toBeVisible();
  await settled(page);
  expect(await page.evaluate(() => window.__hbPagination.overflowing())).toEqual([]);
});

test('an image that loads: its page is checked again (only its page)', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/assets/catwarrior.jpg*', async (route) => {
    await held;
    await route.continue();
  });
  await load(page, doc(pg([h(1, 'Chapter'), ...paragraphs(20, 600), imageParagraph({ src: uncachedImage(), style: 'width: 60%;' }), ...paragraphs(4, 600, 2)], { pid: 'section1' })), false);
  const waiting = await page.evaluate(async () => {
    const api = window.__hbPagination;
    const t0 = performance.now();
    while (performance.now() - t0 < 10_000 && !(api.state()!.dirtyFrom === null && api.state()!.waiting.length > 0)) await new Promise((r) => setTimeout(r, 20));
    return api.state()!.waiting;
  });
  expect(waiting).toHaveLength(1);
  await events(page);
  release();
  const log = await collectUntil(page, (l) => repaginations(l).some((r) => r.source === 'meta' && r.from === waiting[0]));
  const trigger = repaginations(log).find((r) => r.source === 'meta' && r.from === waiting[0])!;
  expect(trigger.to).toBe(waiting[0]);
  await settled(page);
  const after = [...log, ...(await events(page))];
  // The image's page is checked again (the objects lane's image view also records the image's
  // natural size, a document change that re-checks from the page before it).
  const checked = steps(after.slice(after.indexOf(trigger))).map((s) => s.page!);
  expect(checked).toContain(waiting[0]);
  expect(Math.min(...checked), `pages checked ${JSON.stringify(checked)} after ${JSON.stringify(repaginations(after))}`).toBeGreaterThanOrEqual(waiting[0]! - 1);
});

test('a section settings change: re-check from the section\'s first page', async ({ page }) => {
  await page.evaluate(async () => {
    window.__hbPagination.load('sections');
    await window.__hbPagination.settled(10_000);
    window.__hbPagination.events();
  });
  // Section C: its first page and the auto pages after it.
  const head = await page.evaluate(() => window.__hbPagination.pages().findIndex((p) => p.pid === 'sectionC'));
  expect(await page.evaluate((i) => window.__hbPagination.pages()[i + 1]?.kind, head)).toBe('auto');
  expect(head).toBeGreaterThan(0);
  await page.evaluate((i) => {
    const editor = window.__hbPagination.editor as unknown as { commands: { setSectionAttrs(attrs: unknown, page?: number): boolean } };
    editor.commands.setSectionAttrs({ footer: 'Changed' }, i + 1);
  }, head);
  await settled(page);
  const checked = steps(await events(page)).map((s) => s.page);
  expect(checked[0]).toBe(head);
  expect(Math.min(...checked.map((p) => p ?? Infinity))).toBe(head);
});

test('Journal pages have the same flow box on odd and even pages; brew CSS that sizes them differently makes page count changes re-check to the last page', async ({ page }) => {
  await page.evaluate(() => window.__hbPagination.setTheme('Journal'));
  await expect(page.locator('[data-canvas-theme="Journal"][data-canvas-status="ready"]')).toBeVisible();
  await load(
    page,
    doc(pg([h(1, 'One'), ...paragraphs(1, 300)], { pid: 'sectionA', columns: 1 }), pg([h(1, 'Two'), ...paragraphs(14, 600, 2)], { pid: 'sectionB', columns: 1 })),
  );
  expect(await page.evaluate(() => window.__hbPagination.parityMatters())).toBe(false);
  // Even pages get a much wider right margin.
  await page.evaluate(() => window.__hbPagination.setUserCss('.page:nth-of-type(2n) .columnWrapper { padding-right: 3cm; }'));
  await collectUntil(page, (l) => repaginations(l).some((r) => r.reason === 'css'));
  await settled(page);
  expect(await page.evaluate(() => window.__hbPagination.parityMatters())).toBe(true);
  const pagesBefore = await page.evaluate(() => window.__hbPagination.pages().length);
  await events(page);
  // Section A grows by a page: every page of section B swaps odd for even.
  await page.evaluate(() => {
    const api = window.__hbPagination;
    api.insertBlock(0, { type: 'paragraph', content: [{ type: 'text', text: 'Grow the first section by a page. '.repeat(160) }] });
  });
  await settled(page);
  const r = await page.evaluate(() => ({ pages: window.__hbPagination.pages().length, overflowing: window.__hbPagination.overflowing() }));
  const checked = steps(await events(page)).map((s) => s.page);
  expect(r.pages).toBeGreaterThan(pagesBefore);
  expect(checked).toContain(r.pages - 1); // continued to the last page
  expect(r.overflowing).toEqual([]);
  await clearUserCss(page);
});
