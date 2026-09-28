// §4.11 row 12 in the app's editor (/edit): a web font that loads late. The brew's style uses a
// web font whose file is held back past the canvas's fonts gate (it gives up waiting after 10 s,
// on Playwright's fake clock here: web/e2e/clock.ts), so the pages are laid out with the fallback
// font first. When the font arrives (loadingdone) every page is checked again from page 0, the
// layout changes to fit the new metrics, and once it has settled nothing moves any more: no page is
// painted overflowing and the boundaries stay put.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { events, expect, expectClean, openEditor, pages, repaginationsOf, sectionDoc, settled, stepsOf, test, texts, watchErrors } from './helpers';

// A wide display face: its metrics differ a lot from the fallback serif, so the pages change.
const FONT = readFileSync(path.resolve(import.meta.dirname, '../../../themes/fonts/5e/Nodesto Caps Wide.woff2'));
const STYLE = `
@font-face { font-family: 'HbLateFont'; src: url('/e2e-late-font.woff2') format('woff2'); }
.page p { font-family: 'HbLateFont', serif; }
`;
/** The canvas's fonts gate (waitForFonts' default timeout, web/src/editor/canvas/themeLoader.ts). */
const FONTS_GATE_MS = 10_000;
/** Rendered frames watched once the layout has settled. */
const WATCHED_FRAMES = 30;

test('a web font that loads late: full repagination after loadingdone, and no jump once settled', async ({ page }) => {
  // One load of the editor (Firefox: up to 11 s beside other runs) and two full layouts.
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
  await page.clock.install();
  await openEditor(page, {
    doc: sectionDoc(3.3),
    style: STYLE,
    beforeReady: async () => {
      // The font's request: the canvas's fonts gate is waiting for it (the gate asks for the fonts
      // the pages use, then starts its timer, in one task). The gate gives up: now, on the clock.
      await expect.poll(() => requested, { message: 'the web font is requested' }).toBeGreaterThan(0);
      await page.clock.fastForward(FONTS_GATE_MS);
    },
  });

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

  // Settled: for the next WATCHED_FRAMES rendered frames nothing changes and no frame is painted
  // with a page overflowing. A probe's width animates on the document timeline (rendering, which
  // the fake clock doesn't hold), so a ResizeObserver runs in every frame, right before its paint.
  const frames = await page.evaluate(async (count) => {
    const api = window.__hbPagination;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0';
    document.body.append(probe);
    const animation = probe.animate([{ width: '1px' }, { width: '200px' }], { duration: 1000, iterations: Infinity, direction: 'alternate' });
    const report = { frames: 0, overflowFrames: [] as { frame: number; pages: number[] }[] };
    await new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        report.frames += 1;
        const overflowing = api.overflowing();
        if (overflowing.length) report.overflowFrames.push({ frame: report.frames, pages: overflowing });
        if (report.frames >= count) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(probe);
    });
    animation.cancel();
    probe.remove();
    return report;
  }, WATCHED_FRAMES);
  expect(frames.frames).toBe(WATCHED_FRAMES);
  expect(frames.overflowFrames).toEqual([]);
  expect(await texts(page)).toEqual(withFont);
  expect(stepsOf(await events(page)).filter((s) => s.action !== 'settled')).toEqual([]);
  await expectClean(page, errors);
});
