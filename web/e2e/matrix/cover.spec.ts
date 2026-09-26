// §4.11 row 9 in the app's editor (/edit): a cover page. The theme's `.page:has(.frontCover)`
// rule makes it one column, and measurement follows the computed column count: the cover page is
// filled in one column, its auto pages (no marker) in two. Making a page a cover from the Blocks
// menu, and back, re-lays the section out to match.
import type { Page } from '@playwright/test';
import { doc, expect, expectClean, filler, flowText, h, openEditor, p, pages, pg, settled, test, watchErrors } from './helpers';

const coverDoc = (markers: string[]) =>
  doc(pg([h(1, 'The Inn Between'), ...Array.from({ length: 12 }, (_, i) => p(filler(600, i)))], { pid: 'cover1', columns: null, markers }));

/** The computed column count of each page's flow, and where its text lines sit. */
function columnsInDom(page: Page) {
  return page.evaluate(() => {
    const api = window.__hbPagination;
    return api.pages().map((r) => {
      const truth = api.domTruth(r.index)!;
      const wrap = document.querySelectorAll('.hb-canvas .ProseMirror > .page')[r.index]!.querySelector(':scope > div.columnWrapper')!;
      const width = truth.box.right - truth.box.left;
      // Paragraph fragments wider than 60 % of the box: only a 1-column flow has them.
      const wide = Array.from(wrap.querySelectorAll(':scope > p'))
        .flatMap((el) => Array.from(el.getClientRects()))
        .filter((x) => x.width > 0.6 * width).length;
      return { computed: getComputedStyle(wrap).columnCount, measured: r.measuredColumns, wideFragments: wide };
    });
  });
}

/**
 * The most room a full page can leave: a pull needs two lines of the next paragraph (the widows
 * default), so up to two of its lines plus a paragraph gap can stay empty. From the page's last
 * paragraph (a cover page styles its text larger).
 */
function fullPageSlack(page: Page, index: number): Promise<number> {
  return page.evaluate((i) => {
    const wrap = document.querySelectorAll('.hb-canvas .ProseMirror > .page')[i]!.querySelector(':scope > div.columnWrapper')!;
    const paras = wrap.querySelectorAll(':scope > p');
    const cs = getComputedStyle(paras[paras.length - 1]!);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    return 2 * line + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }, index);
}

test('a front cover is laid out in one column, its auto pages in two', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: coverDoc(['frontCover']) });
  const report = await pages(page);
  expect(report.length).toBeGreaterThanOrEqual(2);
  const cols = await columnsInDom(page);
  expect(cols[0]).toMatchObject({ computed: '1', measured: 1 });
  expect(cols[0]!.wideFragments).toBeGreaterThan(0);
  for (const c of cols.slice(1)) {
    expect(c).toMatchObject({ computed: '2', measured: 2, wideFragments: 0 });
  }
  // The cover page is full (pagination filled one column, not two half-width ones).
  expect(report[0]!.freeSpace!).toBeLessThan(await fullPageSlack(page, 0));
  expect(report.slice(1).every((r) => r.kind === 'auto')).toBe(true);
  await expectClean(page, errors);
});

test('making the first page a cover from the Blocks menu re-lays it out in one column, and back', async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: coverDoc([]) });
  const plain = await pages(page);
  expect((await columnsInDom(page))[0]).toMatchObject({ computed: '2', measured: 2 });
  const plainTexts = await page.evaluate(() => window.__hbPagination.texts());
  const plainFlow = await flowText(page);

  // The caret on page 1, then Blocks › Page 1 › Front cover.
  await page.evaluate(() => window.__hbPagination.select(window.__hbPagination.blockPos(0, 1) + 1));
  const chooseCover = async (label: string) => {
    await page.getByTestId('block-menu').click();
    await page.getByRole('menuitemradio', { name: label }).click();
    await settled(page);
    // A cover page's theme rules use other fonts; the canvas repaginates when they arrive
    // (loadingdone), so wait for them and for that pass too.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await settled(page);
  };
  await chooseCover('Front cover');
  const cover = await pages(page);
  const cols = await columnsInDom(page);
  expect(cols[0]).toMatchObject({ computed: '1', measured: 1 });
  expect(cols[1]).toMatchObject({ computed: '2', measured: 2 });
  // A 1-column page of the same size holds a different share of the text: the seam moved.
  expect(await page.evaluate(() => window.__hbPagination.texts())).not.toEqual(plainTexts);
  expect(cover[0]!.freeSpace!).toBeLessThan(await fullPageSlack(page, 0));
  await expectClean(page);

  // Not a cover any more: two columns again, filled as before. (The seam may sit a line away from
  // the first load's: pulls back need room for two lines of a paragraph, the widows default, so a
  // one-line tail can stay on the next page; in Firefox it did.)
  await page.evaluate(() => window.__hbPagination.select(window.__hbPagination.blockPos(0, 1) + 1));
  await chooseCover('Not a cover page');
  expect((await columnsInDom(page))[0]).toMatchObject({ computed: '2', measured: 2 });
  const back = await pages(page);
  expect(back.length).toBe(plain.length);
  expect(back[0]!.freeSpace!).toBeLessThan(await fullPageSlack(page, 0));
  expect(await flowText(page)).toBe(plainFlow);
  await expectClean(page, errors);
});
