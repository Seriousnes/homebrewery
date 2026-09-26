// §4.11 row 13 in the app's editor (/edit): canvas zoom at 50 %, 100 % and 200 % gives the same
// page boundaries. The zoom is the toolbar's (UI store, kept across reloads); at each level the
// stored 20-page document is paginated from scratch on load, and a full re-check after switching
// the zoom changes nothing. One test per zoom level, so each loads the document twice (at 100 %,
// then reloaded at its zoom), not three times.
import type { Page } from '@playwright/test';
import { attachHarness, expect, expectClean, mixed20, openEditor, pages, settled, test, texts, waitForEditor, watchErrors } from './helpers';

async function chooseZoom(page: Page, label: string) {
  await page.getByTestId('zoom-menu').click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await expect(page.getByTestId('zoom-menu')).toHaveAccessibleName(`Zoom: ${label}`);
}

const scale = (page: Page) => page.evaluate(() => window.__hbPagination.measure(0)!.scale);

async function recheck(page: Page) {
  await page.evaluate(() => window.__hbPagination.repaginate(0));
  await settled(page);
}

async function reload(page: Page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  await attachHarness(page);
  await settled(page);
}

for (const [label, zoom] of [
  ['50%', 0.5],
  ['200%', 2],
] as const) {
  test(`zoom ${label}: the same page boundaries as at 100 %, switched and loaded`, { tag: zoom === 0.5 ? '@smoke' : [] }, async ({ page }) => {
    test.setTimeout(30_000); // two loads of the 20-page document in the app's editor (about 5 s each in Firefox)
    const errors = watchErrors(page);
    await openEditor(page, { doc: mixed20() });
    expect(await scale(page)).toBeCloseTo(1, 3);
    const base = await texts(page);
    expect(base.length).toBeGreaterThanOrEqual(18);
    await expectClean(page);

    // Switching the zoom: a full re-check at the new zoom keeps every boundary.
    await chooseZoom(page, label);
    await expect.poll(() => scale(page)).toBeCloseTo(zoom, 3);
    await recheck(page);
    expect(await texts(page), `after switching to ${label}`).toEqual(base);
    await expectClean(page);

    // Paginated from scratch at this zoom (the stored document has one page per section).
    await reload(page);
    expect(await scale(page)).toBeCloseTo(zoom, 3);
    expect(await texts(page), `loaded at ${label}`).toEqual(base);
    expect((await pages(page)).every((r) => r.overflow === false)).toBe(true);
    await expectClean(page);

    // And back to 100 %.
    await chooseZoom(page, '100%');
    await expect.poll(() => scale(page)).toBeCloseTo(1, 3);
    await recheck(page);
    expect(await texts(page)).toEqual(base);
    await expectClean(page, errors);
  });
}
