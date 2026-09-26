// hbfmToDoc's layout-dependent lifting (plan §7, P6.2), which jsdom can't test: the probe lays
// the pages out with the real theme, and computed styles decide what becomes a marker, the
// footer, the page number or a page object. Runs /dev/import on S3 fixtures and checks the
// imported document (window.__hbImport).
import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { DOM_READY, test } from './helpers';

/**
 * /dev/import's result: the page load (goto resolves at DOMContentLoaded, DOM_READY), then the
 * import and its probe (a second or two for a multi-page fixture). As long as a navigation
 * (playwright.config.ts).
 */
const IMPORTED = { timeout: 10_000 };

interface PageObject {
  id: string;
  kind: 'image' | 'text';
  classes: string[];
  style: string;
  src?: string;
  text?: string;
}
interface PageNode {
  type: string;
  attrs: { markers: string[]; footer: string | null; pageNumber: boolean; objects: PageObject[]; kind: string };
  content?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}
interface Imported {
  doc: { content: PageNode[] };
  style: string;
  report: {
    positionedInFlow: Array<{ page: number; tag: string; classes: string[] }>;
    clippedPages: Array<{ page: number; estimatedPages: number }>;
    unknownClasses: Array<{ name: string }> | null;
    warnings: string[];
  };
}

async function importFixture(page: Page, fixture: string): Promise<Imported> {
  await page.route('**/api/themes/*/bundle', (route) =>
    route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (route) => route.abort());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/dev/import?fixture=${encodeURIComponent(fixture)}`, DOM_READY);
  await expect(page.locator('[data-render-status]').first()).toHaveAttribute('data-render-status', 'ready', IMPORTED);
  expect(errors).toEqual([]);
  const imported = await page.evaluate(() => (window as unknown as { __hbImport?: unknown }).__hbImport);
  if (!imported) throw new Error('no import result');
  return imported as Imported;
}

test('front cover: marker, text and image objects lifted; the logo stays in the flow', { tag: '@smoke' }, async ({ page }) => {
  const { doc, report } = await importFixture(page, 'snippet-5ephb-phb-front-cover-page');
  const cover = doc.content[0]!;
  expect(cover.attrs.markers).toEqual(['frontCover']);
  // .banner and .footnote are positioned by `.page:has(.frontCover) …` rules: only the laid-out
  // probe (with the marker still in place) can see that.
  expect(cover.attrs.objects).toEqual([
    expect.objectContaining({ kind: 'text', classes: ['banner'], text: 'HOMEBREW' }),
    expect.objectContaining({ kind: 'text', classes: ['footnote'] }),
    expect.objectContaining({ kind: 'image', src: '/assets/the_departure.webp', style: expect.stringContaining('position: absolute') }),
  ]);
  expect(report.positionedInFlow).toEqual([expect.objectContaining({ page: 1, tag: 'span', classes: ['logo'] })]);
  // The logo (a positioned span around an image, alone on its line) is kept as a rawHtml block:
  // as a paragraph it would add an empty line above the title.
  expect(cover.content?.map((n) => n.type)).toEqual(['rawHtml', 'heading', 'heading', 'horizontalRule']);
  expect(String(cover.content?.[0]?.attrs?.html)).toMatch(/^<span class="inline-block logo"><img /);
  const logo = page.locator('.hb-canvas .page').first().locator('.columnWrapper span.logo');
  await expect(logo).toHaveCSS('position', 'absolute');
  // The chrome is rendered outside the flow, where the theme positions it.
  const banner = page.locator('.hb-canvas .page').first().locator(':scope > span.inline-block.banner');
  await expect(banner).toHaveText('HOMEBREW');
  await expect(banner).toHaveCSS('position', 'absolute');
});

test('welcome: footer, positioned image and manual page number; the artist credit stays in the flow', { tag: '@smoke' }, async ({ page }) => {
  const { doc, report, style } = await importFixture(page, 'welcome');
  const [first, second] = doc.content;
  expect(first!.attrs.footer).toBe('PART 1 | FANCINESS');
  expect(second!.attrs.footer).toBe('PART 2 | BORING STUFF');
  expect(first!.attrs.pageNumber).toBe(false); // {{pageNumber 1}} is a fixed number, not the counter
  expect(first!.attrs.objects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'image', src: '/assets/homebrewerymug.png' }),
      expect.objectContaining({ kind: 'text', classes: ['pageNumber'], text: '1' }),
    ]),
  );
  expect(report.positionedInFlow.map((p) => p.classes.join('.'))).toEqual(expect.arrayContaining(['artist']));
  expect(style).toContain('.page #example + table td');
  expect(report.warnings).toEqual([]);
  expect(report.unknownClasses?.map((c) => c.name)).toEqual(expect.arrayContaining(['pen', 'purple']));
});

/**
 * hbfmToDoc on arbitrary text through /dev/import's test API (window.__hbImportApi). `ms` is the
 * import alone, measured in the page (performance marks around the call): the page load before
 * it doesn't count, however slow the dev server is.
 */
async function importText(page: Page, text: string): Promise<Imported & { ms: number }> {
  await page.route('**/api/themes/*/bundle', (route) =>
    route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  await page.goto('/dev/import', DOM_READY);
  await page.waitForFunction(() => Boolean((window as unknown as { __hbImportApi?: unknown }).__hbImportApi), undefined, IMPORTED);
  return page.evaluate(async (t) => {
    const api = (window as unknown as { __hbImportApi: { hbfmToDoc: (text: string) => Promise<Imported> } }).__hbImportApi;
    performance.mark('hbfmToDoc-start');
    const { doc, style, report } = await api.hbfmToDoc(t);
    const ms = performance.measure('hbfmToDoc', 'hbfmToDoc-start').duration;
    return { doc, style, report, ms };
  }, text);
}

const para = (i: number) => `Paragraph ${i}: the caravan road bends east past the old mill, where the river runs fast and cold in spring.`;

test('a page whose text overflows its columns is reported as clipped', { tag: '@smoke' }, async ({ page }) => {
  const long = Array.from({ length: 90 }, (_, i) => para(i)).join('\n\n');
  const { report } = await importText(page, `${long}\n\\page\nShort page.`);
  expect(report.clippedPages).toHaveLength(1);
  expect(report.clippedPages[0]!.page).toBe(1);
  expect(report.clippedPages[0]!.estimatedPages).toBeGreaterThanOrEqual(2);
});

test('a .wide block taller than the page is reported as clipped (it overflows the bottom)', async ({ page }) => {
  const tall = Array.from({ length: 60 }, (_, i) => para(i)).join('\n\n');
  const { report } = await importText(page, `{{wide\n${tall}\n}}`);
  expect(report.clippedPages.map((c) => c.page)).toEqual([1]);
  expect(report.clippedPages[0]!.estimatedPages).toBeGreaterThanOrEqual(2);
});

test('images get their natural size: the probe waits for slow images, failed and lazy ones are not waited for', async ({ page }) => {
  const png = new PNG({ width: 30, height: 20 });
  png.data.fill(200);
  const body = PNG.sync.write(png);
  await page.route('**/e2e-slow.png', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ status: 200, contentType: 'image/png', body });
  });
  await page.route('**/e2e-missing.png', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/e2e-lazy.png', () => undefined); // never answers
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80"/></svg>').toString('base64');
  const { doc, report, ms } = await importText(
    page,
    [
      '![Slow](/e2e-slow.png) ![Missing](/e2e-missing.png)',
      '',
      `<img src="data:image/svg+xml;base64,${svg}"> <img src="/e2e-slow.png" width="10">`,
      '',
      '<img loading="lazy" src="/e2e-lazy.png">',
    ].join('\n'),
  );
  expect(ms).toBeLessThan(9_000); // the import didn't wait for the 10 s image timeout
  const sizes: unknown[] = [];
  type Json = { type?: string; attrs?: Record<string, unknown>; content?: Json[] };
  const walk = (n: Json) => {
    if (n.type === 'image' && n.attrs?.src !== '/e2e-lazy.png') sizes.push([String(n.attrs?.src).slice(0, 26), n.attrs?.width, n.attrs?.height]);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  expect(sizes).toEqual([
    ['/e2e-slow.png', 30, 20],
    ['/e2e-missing.png', null, null],
    ['data:image/svg+xml;base64,', 120, 80],
    ['/e2e-slow.png', 10, null], // the author's width stays
  ]);
  expect(report.warnings).toEqual([]);
});

// One fixture per test: each is a page load of its own.
for (const fixture of ['snippet-5ephb-tables-class-tables-full-caster-class-table', 'snippet-5ephb-phb-wide-monster-stat-block']) {
  test(`pages that fit are not reported as clipped (decorations and wide blocks included): ${fixture}`, { tag: fixture.includes('wide-monster') ? '@smoke' : [] }, async ({ page }) => {
    const { report } = await importFixture(page, fixture);
    expect(report.clippedPages, fixture).toEqual([]);
  });
}
