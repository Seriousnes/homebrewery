// §4.11 row 12 in the app's editor (/edit): a web font that loads late. The brew's style uses a
// web font whose file is held back past the canvas's fonts gate (10 s), so the pages are laid
// out with the fallback font first. When the font arrives (loadingdone) every page is checked
// again from page 0, the layout changes to fit the new metrics, and once it has settled nothing
// moves any more: no page is painted overflowing and the boundaries stay put.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FrameReport } from '../pagination/harness';
import { events, expect, expectClean, openEditor, pages, repaginationsOf, sectionDoc, settled, stepsOf, test, texts, watchErrors } from './helpers';

// A wide display face: its metrics differ a lot from the fallback serif, so the pages change.
const FONT = readFileSync(path.resolve(import.meta.dirname, '../../../themes/fonts/5e/Nodesto Caps Wide.woff2'));
const STYLE = `
@font-face { font-family: 'HbLateFont'; src: url('/e2e-late-font.woff2') format('woff2'); }
.page p { font-family: 'HbLateFont', serif; }
`;

test('a web font that loads late: full repagination after loadingdone, and no jump once settled', async ({ page }) => {
  // The canvas's fonts gate holds the first layout for 10 s while the font is held back: that wait
  // is what the test is about. The load and the test's own work come on top of it.
  test.setTimeout(30_000);
  const errors = watchErrors(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let requested = 0;
  await page.route('**/e2e-late-font.woff2', async (route) => {
    requested += 1;
    await held;
    await route.fulfill({ status: 200, contentType: 'font/woff2', body: FONT });
  });
  await openEditor(page, { doc: sectionDoc(3.3), style: STYLE, readyTimeout: 20_000 });
  expect(requested).toBeGreaterThan(0);

  // Laid out with the fallback font while the web font is still loading.
  const fallback = await page.evaluate(() => ({
    status: [...document.fonts].find((f) => f.family.replace(/["']/g, '') === 'HbLateFont')?.status ?? null,
    texts: window.__hbPagination.texts(),
  }));
  expect(fallback.status).toBe('loading');
  await expectClean(page);
  await events(page);

  // The font arrives: the canvas asks for a re-check from page 0, every page is checked.
  release();
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'HbLateFont' && f.status === 'loaded'));
  const log: Awaited<ReturnType<typeof events>> = [];
  await expect
    .poll(async () => {
      log.push(...(await events(page)));
      return repaginationsOf(log).some((r) => r.from === 0);
    })
    .toBe(true);
  await settled(page);
  log.push(...(await events(page)));
  const trigger = repaginationsOf(log).find((r) => r.from === 0)!;
  const checked = stepsOf(log.slice(log.indexOf(trigger))).map((s) => s.page);
  const report = await pages(page);
  expect(checked[0]).toBe(0);
  expect(new Set(checked).size).toBeGreaterThanOrEqual(report.length);
  const withFont = await texts(page);
  expect(withFont).not.toEqual(fallback.texts); // the new metrics moved the boundaries
  await expectClean(page, errors);

  // Settled: for the next half second nothing changes and no painted frame overflows (checked
  // right before each paint).
  await page.evaluate(() => {
    window.__hbPagination.frameWatch();
  });
  await page.waitForTimeout(500);
  const frames: FrameReport = await page.evaluate(() => window.__hbFrameWatch!());
  expect(frames.frames).toBeGreaterThan(5);
  expect(frames.overflowFrames).toEqual([]);
  expect(await texts(page)).toEqual(withFont);
  expect(stepsOf(await events(page)).filter((s) => s.action !== 'settled')).toEqual([]);
  await expectClean(page, errors);
});
