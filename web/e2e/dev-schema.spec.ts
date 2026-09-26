// /dev/schema (P3.1): the canvas DOM shape and the layout assumption pagination depends on
// (plan §4.2): content that doesn't fit on a page forms extra columns to the right of the
// .columnWrapper content box.
import { expect, test, type Page } from '@playwright/test';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface OverflowMeasure {
  page: Rect;
  box: Rect;
  columnCount: string;
  columnFill: string;
  columnGap: string;
  contentVisibility: string;
  pageOverflow: string;
  rects: Rect[];
  columnsUsed: number;
  firstOutside: Rect | null;
  fontFamily: string;
  fontsStatus: string;
}

async function openDevPage(page: Page): Promise<void> {
  // No API in this run: answer the bundle endpoint like an API without it, so themeLoader takes
  // its static fallback (/themes/themes.json) deterministically and the Vite proxy stays quiet.
  await page.route('**/api/themes/*/bundle', (route) =>
    route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  await page.goto('/dev/schema');
  // Theme CSS and fonts applied: a few seconds after the load (a cold Firefox takes the longest).
  await expect(page.locator('[data-theme-status="ready"]')).toBeVisible({ timeout: 10_000 });
}

function measure(page: Page, testId: string): Promise<OverflowMeasure> {
  return page.evaluate((id) => {
    const EPS = 0.5;
    const plain = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    const para = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const wrap = para?.closest<HTMLElement>('.columnWrapper');
    const pageEl = wrap?.closest<HTMLElement>('.page');
    if (!para || !wrap || !pageEl) throw new Error(`missing ${id}`);
    // Content box of .columnWrapper, padding excluded (measure.ts, plan §4.3).
    const r = wrap.getBoundingClientRect();
    const cs = getComputedStyle(wrap);
    const px = (v: string) => parseFloat(v) || 0;
    const box = new DOMRect(
      r.left + px(cs.paddingLeft),
      r.top + px(cs.paddingTop),
      r.width - px(cs.paddingLeft) - px(cs.paddingRight),
      r.height - px(cs.paddingTop) - px(cs.paddingBottom),
    );
    const rects = Array.from(para.getClientRects());
    const lefts = new Set(rects.map((x) => Math.round(x.left)));
    const outside = rects.find((x) => x.left >= box.right - EPS) ?? null;
    const pcs = getComputedStyle(pageEl);
    return {
      page: plain(pageEl.getBoundingClientRect()),
      box: plain(box),
      columnCount: cs.columnCount,
      columnFill: cs.columnFill,
      columnGap: cs.columnGap,
      contentVisibility: pcs.contentVisibility,
      pageOverflow: pcs.overflowX,
      rects: rects.map(plain),
      columnsUsed: lefts.size,
      firstOutside: outside ? plain(outside) : null,
      fontFamily: getComputedStyle(para).fontFamily,
      fontsStatus: document.fonts.status,
    };
  }, testId);
}

test.describe('/dev/schema', () => {
  test('DOM is .hb-canvas > .ProseMirror.pages > .page > .columnWrapper', async ({ page }) => {
    await openDevPage(page);
    const shape = await page.evaluate(() => {
      const root = document.querySelector('.hb-canvas > .ProseMirror');
      if (!root) throw new Error('no .hb-canvas > .ProseMirror');
      const pages = Array.from(root.children);
      const number = (p: Element) => p.querySelector(':scope > .pageNumber');
      return {
        rootClasses: Array.from(root.classList),
        children: pages.map((p) => `${p.tagName.toLowerCase()}.${p.classList[0] ?? ''}#${p.id}`),
        wrappers: pages.map((p) => p.querySelectorAll(':scope > .columnWrapper').length),
        flowInWrapper: pages.map((p) => p.querySelector(':scope > .columnWrapper > h1, :scope > .columnWrapper > h2') !== null),
        chrome: pages.map((p) => Array.from(p.querySelectorAll(':scope > :not(.columnWrapper)')).map((c) => c.className)),
        // .page:nth-child(even) mirrors the page number (5ePHB): only pages are children.
        numberLeft: pages.map((p) => Math.round((number(p)?.getBoundingClientRect().left ?? 0) - p.getBoundingClientRect().left)),
        size: pages.map((p) => [Math.round(p.getBoundingClientRect().width), Math.round(p.getBoundingClientRect().height)]),
      };
    });
    expect(shape.rootClasses).toEqual(expect.arrayContaining(['ProseMirror', 'pages']));
    expect(shape.children).toEqual(['div.page#p1', 'div.page#p2', 'div.page#p3']);
    expect(shape.wrappers).toEqual([1, 1, 1]);
    expect(shape.flowInWrapper).toEqual([true, true, true]);
    expect(shape.chrome[0]).toEqual(['inline-block footnote', 'inline-block pageNumber auto']);
    expect(shape.numberLeft[1]).toBeLessThan(shape.numberLeft[0]!); // even page: number on the left
    expect(shape.size).toEqual([
      [816, 1056],
      [816, 1056],
      [816, 1056],
    ]); // 215.9mm × 279.4mm (Letter) from the theme
  });

  for (const [testId, columns] of [
    ['overflow-2col', 2],
    ['overflow-1col', 1],
  ] as const) {
    test(`overflow of a ${columns}-column page forms a column right of the content box (§4.2)`, async ({ page }, testInfo) => {
      await openDevPage(page);
      const m = await measure(page, testId);
      const report = {
        testId,
        browser: testInfo.project.name,
        page: m.page,
        contentBox: m.box,
        columnCount: m.columnCount,
        columnFill: m.columnFill,
        columnGap: m.columnGap,
        fragments: m.rects.map((r) => ({ left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) })),
        firstOutside: m.firstOutside,
        fontFamily: m.fontFamily,
        fontsStatus: m.fontsStatus,
      };
      console.log(`[dev-schema] ${JSON.stringify(report)}`);
      await testInfo.attach(`${testId}.json`, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });

      expect(m.contentVisibility).toBe('visible'); // canvas.css overrides the theme's auto
      expect(m.pageOverflow).toBe('clip');
      expect(m.columnCount).toBe(String(columns));
      expect(m.columnFill).toBe('auto');
      expect(m.fontFamily).toContain('BookInsanityRemake'); // the theme applied
      // The wrapper is exactly the page's content box (padding excluded).
      expect(m.box.height).toBeGreaterThan(900);
      expect(m.box.bottom).toBeLessThanOrEqual(m.page.bottom);
      // One fragment per column; the first overflow fragment starts right of the content box,
      // at the top (it is the next column), and the ones inside stay within the box.
      expect(m.columnsUsed).toBeGreaterThan(columns);
      expect(m.firstOutside).not.toBeNull();
      expect(m.firstOutside!.left).toBeGreaterThanOrEqual(m.box.right - 0.5);
      expect(Math.abs(m.firstOutside!.top - m.box.top)).toBeLessThan(2);
      for (const r of m.rects.filter((x) => x.left < m.box.right - 0.5)) {
        expect(r.bottom).toBeLessThanOrEqual(m.box.bottom + 0.5);
        expect(r.left).toBeGreaterThanOrEqual(m.box.left - 0.5);
      }
    });
  }
});
