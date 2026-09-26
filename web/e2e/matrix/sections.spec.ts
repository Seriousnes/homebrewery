// §4.11 row 8 in the app's editor (/edit): a 1-column section followed by a 2-column section.
// Content never crosses the manual page that starts the second section: section 1 grows and
// shrinks onto its own auto pages (in 1 column), section 2 keeps its first page and its 2 columns.
import type { Page } from '@playwright/test';
import { doc, expect, expectClean, filler, h, openEditor, p, pages, pg, select, settled, test, texts, watchErrors } from './helpers';

const ONE = 'one';
const TWO = 'two';
// Text markers show which section a paragraph came from.
const para = (section: string, i: number) => p(`[${section} ${i}] ${filler(680, i)}`);
const sectionsDoc = () =>
  doc(
    pg([h(1, 'Part One'), ...Array.from({ length: 10 }, (_, i) => para(ONE, i))], { pid: 'section1', columns: 1 }),
    pg([h(1, 'Part Two'), ...Array.from({ length: 6 }, (_, i) => para(TWO, i))], { pid: 'section2', columns: 2 }),
  );

interface Layout {
  second: number;
  pages: { kind: string; pid: string | null; columns: number | null; measuredColumns: number | null; sections: string[] }[];
}

async function layout(page: Page): Promise<Layout> {
  const report = await pages(page);
  const t = await texts(page);
  const second = report.findIndex((r) => r.pid === 'section2');
  return {
    second,
    pages: report.map((r, i) => ({
      kind: r.kind,
      pid: r.kind === 'manual' ? r.pid : null, // auto pages may get new pids after an undo
      columns: r.columns,
      measuredColumns: r.measuredColumns,
      sections: [...new Set(t[i]!.map((s) => /^\[(one|two) /.exec(s)?.[1]).filter((s): s is string => Boolean(s)))],
    })),
  };
}

/** Section 1 fills pages [0, second), all in 1 column; section 2 starts at its manual page, in 2 columns. */
function expectSeparate(l: Layout): void {
  expect(l.second).toBeGreaterThan(0);
  expect(l.pages[l.second]!).toMatchObject({ kind: 'manual', measuredColumns: 2 });
  l.pages.forEach((pg, i) => {
    const own = i < l.second ? ONE : TWO;
    expect(pg.sections.filter((s) => s !== own), `page ${i} holds text of the other section`).toEqual([]);
    if (i > 0 && i !== l.second) expect(pg.kind, `page ${i}`).toBe('auto');
    expect(pg.measuredColumns, `page ${i} columns`).toBe(i < l.second ? 1 : 2);
  });
}

test('a 1-column section followed by a 2-column section: content never crosses the manual page', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: sectionsDoc() });
  const l0 = await layout(page);
  const t0 = await texts(page);
  expectSeparate(l0);
  expect(l0.second).toBeGreaterThanOrEqual(2); // section 1 needs auto pages of its own
  // The page before section 2 isn't full: its free space is not filled from section 2.
  const report0 = await pages(page);
  expect(report0[l0.second - 1]!.freeSpace!).toBeGreaterThan(50);
  await expectClean(page);

  // 1. Delete most of section 1 (paragraphs 1–7, keyboard): its auto pages go, section 2 stays.
  const range = await page.evaluate(() => {
    const api = window.__hbPagination;
    return { from: api.posOf('[one 1]'), to: api.posOf('[one 8]') };
  });
  await select(page, range.from, range.to);
  await page.keyboard.press('Backspace');
  await settled(page);
  const l1 = await layout(page);
  expectSeparate(l1);
  expect(l1.second).toBeLessThan(l0.second);
  const t1 = await texts(page);
  expect(t1[l1.second]![0]).toBe('Part Two');
  // Room is left at the end of section 1 (more than a page's worth of text went), and section 2's
  // first paragraph was not pulled into it.
  expect((await pages(page))[l1.second - 1]!.freeSpace!).toBeGreaterThan(200);
  await expectClean(page);

  // 2. Type at the end of section 1 until it needs a new page: an auto page is added in
  //    section 1, before section 2's manual page.
  const end = await page.evaluate((i) => window.__hbPagination.endOfPage(i - 1), l1.second);
  await select(page, end);
  let l2 = l1;
  for (let k = 0; k < 12 && l2.second === l1.second; k++) {
    await page.keyboard.insertText(` ${filler(300, k)}`);
    await settled(page);
    l2 = await layout(page);
    expectSeparate(l2);
  }
  expect(l2.second).toBe(l1.second + 1);
  expect(l2.pages[l2.second - 1]!.kind).toBe('auto');
  await expectClean(page);

  // 3. Undo everything: back to the first layout.
  for (let k = 0; k < 30 && JSON.stringify(await texts(page)) !== JSON.stringify(t0); k++) {
    await page.keyboard.press('ControlOrMeta+z');
    await settled(page);
  }
  expect(await texts(page)).toEqual(t0);
  expect(await layout(page)).toEqual(l0);
  await expectClean(page, errors);
});
