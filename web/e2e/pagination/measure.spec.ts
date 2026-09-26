// measure.ts (plan §4.3, P4.1) with the real theme CSS: overflow and free space in 1 and 2
// columns, with a .wide block, under a cover marker, and at 50 %, 100 % and 200 % zoom.
// Pagination is off in these tests: the page is measured as built.
import type { Page } from '@playwright/test';
import { block, doc, expect, filler, h, imageParagraph, load, p, page as pg, paragraphs, sizedImage, test, useHarness, type Measure } from './harness';

/**
 * The flow of page `i` read straight from the DOM (independent of measure.ts): the wrapper's
 * content box, and the fragments of its children in order.
 */
function domTruth(page: Page, i: number) {
  return page.evaluate((index) => {
    const pageEl = document.querySelectorAll<HTMLElement>('.ProseMirror > .page')[index]!;
    const wrap = pageEl.querySelector<HTMLElement>(':scope > .columnWrapper')!;
    const r = wrap.getBoundingClientRect();
    const cs = getComputedStyle(wrap);
    const scale = r.width / wrap.offsetWidth;
    const pad = (v: string) => (parseFloat(v) || 0) * scale;
    const box = {
      left: r.left + pad(cs.paddingLeft),
      top: r.top + pad(cs.paddingTop),
      right: r.right - pad(cs.paddingRight),
      bottom: r.bottom - pad(cs.paddingBottom),
    };
    const fragments = Array.from(wrap.children).flatMap((el, child) => {
      const ecs = getComputedStyle(el);
      return Array.from(el.getClientRects())
        .filter((x) => x.height > 0.5)
        .map((x) => ({
          child,
          left: x.left,
          top: x.top,
          right: x.right,
          bottom: x.bottom,
          spans: ecs.columnSpan === 'all',
          marginBottom: (parseFloat(ecs.marginBottom) || 0) * scale,
        }));
    });
    // Top of the last row of columns: below the last column-spanning block (5ePHB's h1 spans).
    const spanners = fragments.filter((f) => f.spans);
    const last = spanners[spanners.length - 1];
    const rowTop = last ? last.bottom + last.marginBottom : box.top;
    // Column pitch (width + gap) from a fragment in the second column, if any.
    const second = fragments.find((f) => !f.spans && f.left > box.left + 20 && f.left < box.right - 0.5);
    return { box, fragments, rowTop, pitch: second ? second.left - box.left : null, columnCount: cs.columnCount };
  }, i);
}

const near = (actual: number, expected: number, tolerance = 1) => expect(Math.abs(actual - expected), `${actual} ≈ ${expected}`).toBeLessThanOrEqual(tolerance);

async function grow(page: Page, until: { column: number; fraction: number }): Promise<Measure> {
  const m = await page.evaluate((u) => window.__hbPagination.grow(0, u), until);
  expect(m).not.toBeNull();
  return m!;
}

for (const theme of ['5ePHB', 'Blank']) {
  test.describe(`measurePage (${theme})`, () => {
    test.beforeEach(async ({ page }) => {
      await useHarness(page, { theme, paginate: false });
    });

    test('2 columns: free space in column 1, then column 2, then overflow in the overflow column', async ({ page }) => {
      await load(page, doc(pg([h(1, 'Title'), p(filler(200))], { columns: 2 })), false);

      const a = await grow(page, { column: 0, fraction: 0.5 });
      let t = await domTruth(page, 0);
      expect(a).toMatchObject({ overflow: false, columns: 2, lastColumn: 0 });
      expect(t.columnCount).toBe('2');
      near(a.box.left, t.box.left);
      near(a.box.right, t.box.right);
      near(a.box.bottom, t.box.bottom);
      const lastA = t.fragments[t.fragments.length - 1]!;
      near(a.lastBottom, lastA.bottom);
      // Room below the flow in column 1, plus all of column 2 (below the spanning h1 in 5ePHB).
      near(a.rowTop, t.rowTop);
      near(a.freeSpace, t.box.bottom - lastA.bottom + (t.box.bottom - t.rowTop));
      near(a.columnFree[0]!, t.box.bottom - lastA.bottom);
      near(a.columnFree[1]!, t.box.bottom - t.rowTop);

      const b = await grow(page, { column: 1, fraction: 0.5 });
      t = await domTruth(page, 0);
      const lastB = t.fragments[t.fragments.length - 1]!;
      expect(b).toMatchObject({ overflow: false, lastColumn: 1 });
      expect(lastB.left).toBeGreaterThan(t.box.left + (t.box.right - t.box.left) / 2); // really in column 2
      expect(b.columnFree[0]).toBe(0);
      near(b.freeSpace, t.box.bottom - lastB.bottom);

      const c = await grow(page, { column: 2, fraction: 0 });
      t = await domTruth(page, 0);
      expect(c.overflow).toBe(true);
      expect(c.freeSpace).toBe(0);
      const outside = t.fragments.find((f) => f.left >= t.box.right - 0.5)!;
      expect(outside).toBeDefined();
      expect(c.first!.index).toBe(outside.child);
      near(c.first!.rect.left, outside.left);
      // The overflow column is the third column: two column pitches right of the box's left edge.
      expect(t.pitch).not.toBeNull();
      near(c.first!.rect.left, t.box.left + 2 * t.pitch!, 1.5);
    });

    test('1 column: free space below the flow, overflow to the right', async ({ page }) => {
      await load(page, doc(pg([h(1, 'Title'), p(filler(200))], { columns: 1 })), false);
      const a = await grow(page, { column: 0, fraction: 0.6 });
      const t = await domTruth(page, 0);
      const last = t.fragments[t.fragments.length - 1]!;
      expect(a).toMatchObject({ overflow: false, columns: 1, lastColumn: 0 });
      expect(t.columnCount).toBe('1');
      near(a.freeSpace, t.box.bottom - last.bottom);
      const b = await grow(page, { column: 1, fraction: 0 });
      expect(b.overflow).toBe(true);
      expect(b.first!.rect.left).toBeGreaterThanOrEqual(b.box.right - 0.5);
    });

    test('free space is real: a block of exactly that height fits, a taller one overflows', async ({ page }) => {
      for (const columns of [1, 2]) {
        await load(page, doc(pg([h(1, 'Title'), p(filler(200))], { columns })), false);
        const m = await grow(page, { column: columns - 1, fraction: 0.55 });
        expect(m.lastColumn).toBe(columns - 1);
        const room = m.columnFree[columns - 1]! - m.lastMarginBottom;
        const probe = (height: number) =>
          page.evaluate((hgt) => {
            const api = window.__hbPagination;
            // An unbreakable block (break-inside: avoid) of a given height at the end of the flow.
            api.insertBlock(0, { type: 'paragraph', attrs: { style: `height: ${hgt}px; margin: 0; padding: 0; break-inside: avoid; text-indent: 0` } });
            return api.measure(0)!.overflow;
          }, height);
        // insertBlock is outside the history, so reload the grown document between probes.
        const json = await page.evaluate(() => window.__hbPagination.docJSON());
        expect(await probe(Math.floor(room) - 2), `${columns} col: fits`).toBe(false);
        await load(page, json, false);
        expect(await probe(Math.ceil(room) + 2), `${columns} col: overflows`).toBe(true);
        await load(page, json, false);
      }
    });
  });
}

test.describe('measurePage with a .wide block (5ePHB)', () => {
  test.beforeEach(async ({ page }) => {
    await useHarness(page, { paginate: false });
  });

  test('free space and overflow are measured in the row below the spanner', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(900)), block(['wide'], [p(filler(300, 3))]), p(filler(150, 5))], { columns: 2 })), false);
    const a = await page.evaluate(() => window.__hbPagination.measure(0)!);
    let t = await domTruth(page, 0);
    const wide = t.fragments.filter((f) => f.spans && f.child === 2)[0]!; // the .wide block (the h1 spans too)
    expect(wide).toBeDefined();
    const last = t.fragments[t.fragments.length - 1]!;
    expect(a.overflow).toBe(false);
    // The last row starts below the spanner, its margin included …
    near(a.rowTop, t.rowTop);
    near(t.rowTop, wide.bottom + wide.marginBottom);
    // … the flow after it is in column 1 of that row, column 2 of the row is empty.
    expect(a.lastColumn).toBe(0);
    near(a.columnFree[0]!, t.box.bottom - last.bottom);
    near(a.columnFree[1]!, t.box.bottom - a.rowTop);

    const b = await grow(page, { column: 2, fraction: 0 });
    t = await domTruth(page, 0);
    expect(b.overflow).toBe(true);
    // The overflow column belongs to the row below the spanner.
    expect(b.first!.rect.left).toBeGreaterThanOrEqual(b.box.right - 0.5);
    expect(b.first!.rect.top).toBeGreaterThanOrEqual(wide.bottom - 0.5);
    expect(b.first!.index).toBeGreaterThan(2);
    expect(b.first!.index).toBe(t.fragments.find((f) => f.left >= t.box.right - 0.5)!.child);
  });

  test('a spanner that no longer fits overflows below the box and moves whole', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(200))], { columns: 2 })), false);
    await grow(page, { column: 1, fraction: 0.7 });
    await page.evaluate(() =>
      window.__hbPagination.insertBlock(0, {
        type: 'themeBlock',
        attrs: { classes: ['wide'], style: 'height: 400px' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A wide block' }] }],
      }),
    );
    const m = await page.evaluate(() => window.__hbPagination.measure(0)!);
    expect(m.overflow).toBe(true);
    expect(m.first!.type).toBe('themeBlock');
    expect(m.first!.rect.bottom).toBeGreaterThan(m.box.bottom);
    const cut = await page.evaluate(() => window.__hbPagination.cut(0)!);
    expect(cut).toMatchObject({ rule: 'block', oversized: false });
    expect(cut.at!.nodeAfter).toMatch(/^themeBlock/);
  });

  test('a cover page follows the theme: .page:has(.frontCover) is one column', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Cover'), p(filler(1500))], { columns: null, markers: ['frontCover'] })), false);
    const m = await page.evaluate(() => window.__hbPagination.measure(0)!);
    const t = await domTruth(page, 0);
    expect(t.columnCount).toBe('1');
    expect(m.columns).toBe(1);
  });
});

/** The first image of page `i` against the content box of its wrapper, read from the DOM. */
function imageTruth(page: Page, i: number) {
  return page.evaluate((index) => {
    const pageEl = document.querySelectorAll<HTMLElement>('.ProseMirror > .page')[index]!;
    const wrap = pageEl.querySelector<HTMLElement>(':scope > .columnWrapper')!;
    const img = wrap.querySelector('img:not(.ProseMirror-separator)')!;
    const r = wrap.getBoundingClientRect();
    const cs = getComputedStyle(wrap);
    const box = { left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight), bottom: r.bottom - parseFloat(cs.paddingBottom) };
    const x = img.getBoundingClientRect();
    return {
      float: getComputedStyle(img).float,
      rect: { left: x.left, right: x.right, top: x.top, bottom: x.bottom },
      box,
      outside: x.left >= box.right - 0.5 || x.bottom > box.bottom + 0.5,
    };
  }, i);
}

// A float that doesn't fit is pushed into the overflow column on its own, while the paragraph
// holding it keeps its line box inside: measurePage must see the float (finding PG-1).
for (const [theme, label, attrs] of [
  ['5ePHB', 'float: right', { style: 'float: right;' }],
  ['Blank', '.wrapLeft', { classes: ['wrapLeft'] }],
  ['Blank', '.wrapRight', { classes: ['wrapRight'] }],
] as const) {
  test(`a float pushed out of the box is overflow (${theme}, ${label})`, async ({ page }) => {
    await useHarness(page, { theme, paginate: false });
    await load(page, doc(pg([h(1, 'Title'), p(filler(200))], { columns: 2 })), false);
    await grow(page, { column: 1, fraction: 0.75 });
    await page.evaluate((json) => window.__hbPagination.insertBlock(0, json), imageParagraph({ src: sizedImage(200, 420), width: 200, height: 420, ...attrs }));
    const img = await imageTruth(page, 0);
    expect(img.float).not.toBe('none');
    expect(img.outside, `image ${JSON.stringify(img.rect)} vs box ${JSON.stringify(img.box)}`).toBe(true); // DOM truth
    const m = await page.evaluate(() => window.__hbPagination.measure(0)!);
    const blocks = (await page.evaluate(() => window.__hbPagination.pages()))[0]!.blocks.length;
    expect(m.overflow).toBe(true);
    expect(m.first).toMatchObject({ index: blocks - 1, type: 'paragraph' });
    expect(m.freeSpace).toBe(0);
    expect((await page.evaluate(() => window.__hbPagination.domTruth(0)!)).overflow).toBe(true);
  });
}

// Right-to-left pages (user CSS direction: rtl): overflow columns lie to the left of the box
// (finding PG-8).
test.describe('measurePage on a right-to-left page (5ePHB)', () => {
  test.beforeEach(async ({ page }) => {
    await useHarness(page, { paginate: false });
  });

  test('overflow is detected left of the box, in 1 and 2 columns', async ({ page }) => {
    for (const columns of [1, 2]) {
      await load(page, doc(pg([h(1, 'Title'), ...paragraphs(columns === 1 ? 10 : 14, 700)], { columns, style: 'direction: rtl;' })), false);
      const t = await domTruth(page, 0);
      const leftOfBox = t.fragments.filter((f) => f.right <= t.box.left + 0.5);
      expect(leftOfBox.length, `${columns} col: fragments left of the box`).toBeGreaterThan(0);
      expect(t.fragments.filter((f) => f.left >= t.box.right - 0.5)).toEqual([]);
      const m = await page.evaluate(() => window.__hbPagination.measure(0)!);
      expect(m).toMatchObject({ overflow: true, rtl: true, columns, freeSpace: 0 });
      expect(m.first!.index).toBe(leftOfBox[0]!.child);
      expect(m.first!.rect.right).toBeLessThanOrEqual(m.box.left + m.eps);
    }
  });

  test('columns count from the right: free space in the right column, then the left one', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(200))], { columns: 2, style: 'direction: rtl;' })), false);
    const a = await grow(page, { column: 0, fraction: 0.5 });
    let t = await domTruth(page, 0);
    const lastA = t.fragments[t.fragments.length - 1]!;
    expect(a).toMatchObject({ overflow: false, lastColumn: 0, rtl: true });
    expect(lastA.left).toBeGreaterThan((t.box.left + t.box.right) / 2); // the first column is the right one
    near(a.columnFree[0]!, t.box.bottom - lastA.bottom);
    near(a.columnFree[1]!, t.box.bottom - t.rowTop);
    const b = await grow(page, { column: 1, fraction: 0.5 });
    t = await domTruth(page, 0);
    const lastB = t.fragments[t.fragments.length - 1]!;
    expect(b).toMatchObject({ overflow: false, lastColumn: 1 });
    expect(lastB.right).toBeLessThan((t.box.left + t.box.right) / 2);
    near(b.freeSpace, t.box.bottom - lastB.bottom);
  });
});

test.describe('measurePage under canvas zoom', () => {
  test('50 %, 100 % and 200 %: same result in CSS pixels', async ({ page }) => {
    // One page: the document is loaded again at each zoom (setZoom renders the canvas at the new
    // zoom synchronously).
    await useHarness(page, { paginate: false });
    const results: { zoom: number; m: Measure }[] = [];
    for (const zoom of [0.5, 1, 2]) {
      await page.evaluate((z) => window.__hbPagination.setZoom(z), zoom);
      await load(page, doc(pg([h(1, 'Title'), p(filler(2600)), block(['note'], [h(5, 'Note'), p(filler(200, 2))]), p(filler(4000, 4))], { columns: 2 })), false);
      const m = await page.evaluate(() => window.__hbPagination.measure(0)!);
      results.push({ zoom, m });
    }
    const base = results.find((r) => r.zoom === 1)!.m;
    for (const { zoom, m } of results) {
      near(m.scale, zoom, 0.001);
      near(m.box.height / m.scale, base.box.height, 0.5);
      near(m.freeSpace / m.scale, base.freeSpace, 0.5);
      expect(m.overflow).toBe(base.overflow);
      expect(m.first?.index ?? null).toBe(base.first?.index ?? null);
      expect(m.lastColumn).toBe(base.lastColumn);
    }
    // The cut is the same document position at every zoom.
    const cuts: (number | null)[] = [];
    for (const zoom of [0.5, 1, 2]) {
      await page.evaluate((z) => window.__hbPagination.setZoom(z), zoom);
      cuts.push(await page.evaluate(() => window.__hbPagination.cut(0)?.pos ?? null));
    }
    expect(new Set(cuts).size).toBe(1);
    expect(cuts[0]).not.toBeNull();
  });
});
