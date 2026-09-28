// canvas.css: the multi-column structure of a page (plan §4.2, §3.2) and continued list items.
//
// Theme CSS makes .page a multi-column container and .columnWrapper a `column-span: all` child
// that inherits the page's column settings (Blank style.less:35-46). Firefox 155 hangs, then
// crashes the tab, laying out that nesting when a box the theme keeps whole (li, blockquote:
// break-inside: avoid) is taller than a column. Upstream has the same hang. canvas.css makes
// .page a flex container: column properties don't apply to it, but they still compute and
// inherit, so .columnWrapper is the only multi-column box and has the same settings.
//
// - structure: .page is not a multi-column box; the wrapper has the page's column settings.
// - tall content lays out in both browsers (the Firefox hang).
// - layout: reverting .page to display: block (upstream's structure) changes no geometry, for
//   the canvas documents in every theme and for paginated harness documents. Each case attaches
//   its geometry (layout-*.json), so runs before and after a canvas.css change can be diffed.
// - continued list items: no second marker; the empty filler paragraph takes no space.
import { expect, type ElementHandle, type Page, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { liOf, load, openHarness, p as hp, page as hpage, doc as hdoc, filler as hfiller, ul as hul } from '../pagination/harness';
import { openCanvas, switchDoc, test } from './helpers';

test.use({ viewport: { width: 1400, height: 1300 } });

/** Removes a <style> added with page.addStyleTag. */
const removeStyle = (style: ElementHandle<Node>) => style.evaluate((el) => (el as Element).remove());

/** Upstream's structure: .page is the multi-column box and .columnWrapper spans it. */
// Fully laid out (content-visibility: visible): the reference for our pages, which skip rendering
// offscreen (canvas.css, P8.1) and are brought up to date by the layout queries here.
const UPSTREAM_PAGE = '.hb-canvas .page, .hb-canvas[data-hb-offscreen] .page { display: block !important; content-visibility: visible !important; }';

interface Layouts {
  /** .page's display with canvas.css as is */
  display: string;
  ours: string[];
  /** with upstream's .page structure */
  upstream: string[];
}

/**
 * Runs in the browser, in one task: the layout as it is, then with `upstreamCss` added (and
 * removed again), so nothing asynchronous (a resize, a re-centring, a font swap) can land between
 * the two.
 *
 * A layout is every element's client rects and the position of every 23rd character, relative to
 * its page (pages relative to the pages root), rounded to 1/100 px. Left out, because they are
 * invisible: zero-height fragments of an element that has visible ones (Firefox reports an empty
 * fragment at a column end for some lists), and the position of empty absolutely positioned chrome
 * (0 × 0 marker spans such as span.frontCover, which the theme positions without offsets: their
 * static position follows text-align in a block container and is the content box's start in a
 * flex container).
 */
function layoutsInPage(upstreamCss: string): Layouts {
  const fingerprint = (): string[] => {
    const round = (v: number) => Math.round(v * 100) / 100;
    const out: string[] = [];
    const root = document.querySelector('.hb-canvas .pages')!.getBoundingClientRect();
    document.querySelectorAll<HTMLElement>('.hb-canvas .page').forEach((pg, i) => {
      const box = pg.getBoundingClientRect();
      const rel = (r: DOMRect) => [r.left - box.left, r.top - box.top, r.width, r.height].map(round).join(',');
      out.push(`page ${i} ${[box.left - root.left, box.top - root.top, box.width, box.height].map(round).join(',')}`);
      for (const el of Array.from(pg.querySelectorAll('*'))) {
        const name = `${el.tagName.toLowerCase()}${(el.getAttribute('class') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((c) => `.${c}`)
          .join('')}`;
        let rects = Array.from(el.getClientRects());
        if (rects.some((r) => r.height > 0)) rects = rects.filter((r) => r.height > 0);
        const empty = rects.every((r) => r.width === 0 && r.height === 0);
        if (empty && getComputedStyle(el).position === 'absolute') out.push(`${i} ${name} (empty, absolute)`);
        else out.push(`${i} ${name} ${rects.map(rel).join(' ')}`);
      }
      const walker = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        for (let k = 0; k < n.data.length; k += 23) {
          range.setStart(n, k);
          range.setEnd(n, k + 1);
          const r = range.getClientRects()[0];
          out.push(`${i} char ${r ? rel(r) : '-'}`);
        }
      }
    });
    return out;
  };
  const display = getComputedStyle(document.querySelector('.hb-canvas .page')!).display;
  const ours = fingerprint();
  const style = document.createElement('style');
  style.textContent = upstreamCss;
  document.head.append(style);
  const upstream = fingerprint();
  style.remove();
  return { display, ours, upstream };
}

/** Largest difference between the numbers of two fingerprint lines; Infinity when they differ otherwise. */
function lineDelta(a: string, b: string): number {
  if (a === b) return 0;
  const ta = a.split(/[ ,]/);
  const tb = b.split(/[ ,]/);
  if (ta.length !== tb.length) return Infinity;
  let max = 0;
  for (let k = 0; k < ta.length; k++) {
    if (ta[k] === tb[k]) continue;
    const [x, y] = [Number(ta[k]), Number(tb[k])];
    if (Number.isNaN(x) || Number.isNaN(y)) return Infinity;
    max = Math.max(max, Math.abs(x - y));
  }
  return max;
}

/** The largest difference and the first lines that differ by more than `tolerance` px. */
function differences(a: string[], b: string[], tolerance = 0, max = 8): { delta: number; lines: string[] } {
  const lines: string[] = [];
  let delta = 0;
  if (a.length !== b.length) lines.push(`length ${a.length} vs ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = lineDelta(a[i]!, b[i]!);
    delta = Math.max(delta, d);
    if (d > tolerance && lines.length < max) lines.push(`#${i}: ${a[i]} ≠ ${b[i]}`);
  }
  return { delta, lines };
}

/**
 * Chromium (the reference) lays both structures out identically. Firefox rounds column heights
 * slightly differently when the multi-column box spans another one: a fragmented block can end
 * up to about 0.2 px apart, which shifts what follows on that page by the same amount.
 */
const TOLERANCE: Record<string, number> = { chromium: 0, firefox: 0.5 };

async function saveLayout(testInfo: TestInfo, name: string, data: unknown): Promise<void> {
  const path = testInfo.outputPath(`layout-${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 1));
  await testInfo.attach(`layout-${name}.json`, { path, contentType: 'application/json' });
}

function layouts(page: Page): Promise<Layouts> {
  return page.evaluate(layoutsInPage, UPSTREAM_PAGE);
}

function expectUpstreamLayout(l: Layouts, testInfo: TestInfo, name: string): void {
  expect(l.ours.length).toBeGreaterThan(20);
  expect(l.display).toBe('flex');
  const d = differences(l.ours, l.upstream, TOLERANCE[testInfo.project.name] ?? 0);
  console.log(`[multicol-layout] ${testInfo.project.name} ${name}: ${l.ours.length} entries, max delta ${d.delta} px`);
  expect(d.lines).toEqual([]);
}

interface ColumnReport {
  pageDisplay: string;
  pageColumns: string;
  wrapper: { count: string; width: string; gap: string; fill: string; span: string };
  /** wrapper width − page content width */
  widthDelta: number;
  /** wrapper height − page content height */
  heightDelta: number;
}

function columnReport(page: Page): Promise<ColumnReport[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.hb-canvas .page'), (pg) => {
      const pcs = getComputedStyle(pg);
      const wrapper = pg.querySelector<HTMLElement>(':scope > .columnWrapper')!;
      const wcs = getComputedStyle(wrapper);
      const content = (a: string, b: string, size: number) => size - parseFloat(a) - parseFloat(b);
      return {
        pageDisplay: pcs.display,
        pageColumns: `${pcs.columnCount} ${pcs.columnWidth} ${pcs.columnGap}`,
        wrapper: { count: wcs.columnCount, width: wcs.columnWidth, gap: wcs.columnGap, fill: wcs.columnFill, span: wcs.columnSpan },
        widthDelta: wrapper.offsetWidth - content(pcs.paddingLeft, pcs.paddingRight, pg.clientWidth),
        heightDelta: wrapper.offsetHeight - content(pcs.paddingTop, pcs.paddingBottom, pg.clientHeight),
      };
    }),
  );
}

test.describe('page structure (canvas.css)', () => {
  test('.page is a flex container; .columnWrapper is the only multi-column box, with the page’s column settings', async ({ page }) => {
    await openCanvas(page, { doc: 'chrome' });
    const pages = await columnReport(page);
    expect(pages.length).toBe(5);
    for (const pg of pages) {
      expect(pg.pageDisplay).toBe('flex');
      // Inherited from the page (Blank: .columnWrapper { columns: inherit; column-gap: inherit }).
      expect(`${pg.wrapper.count} ${pg.wrapper.width} ${pg.wrapper.gap}`).toBe(pg.pageColumns);
      expect(pg.wrapper.fill).toBe('auto');
      // The wrapper fills the page's content box, as the spanning wrapper did.
      expect(Math.abs(pg.widthDelta)).toBeLessThan(0.5);
      expect(Math.abs(pg.heightDelta)).toBeLessThan(0.5);
    }
    // 5ePHB: `.page:has(.frontCover) { columns: 1 }` still switches the cover to one column.
    expect(pages[0]!.wrapper.count).toBe('1');
    expect(pages[1]!.wrapper.count).toBe('2');
    expect(pages[1]!.wrapper.width).not.toBe('auto'); // 5ePHB's column-width: 8cm is inherited too

    // Section setting hb-cols-1 (page.attrs.columns = 1) reaches the wrapper.
    await page.evaluate(() => {
      const editor = window.__editor!;
      const pos = editor.state.doc.child(0).nodeSize; // page 2
      editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'columns', 1));
    });
    const after = await columnReport(page);
    expect(after[1]!.wrapper.count).toBe('1');
    expect(after[2]!.wrapper.count).toBe('2');
  });

  for (const theme of ['5ePHB', 'Blank']) {
    test(`boxes kept whole that are taller than a column lay out (${theme}; Firefox used to hang)`, async ({ page }) => {
      await openCanvas(page, { doc: 'tall', theme });
      const report = await page.evaluate(() =>
        ['tall-li', 'tall-nested-li', 'tall-quote', 'tall-ol-li'].map((id) => {
          const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
          const wrapper = el.closest<HTMLElement>('.columnWrapper')!;
          const w = wrapper.getBoundingClientRect();
          const text = el.querySelector('p')!.firstChild as Text;
          const range = document.createRange();
          range.setStart(text, text.length - 1);
          range.setEnd(text, text.length);
          const last = range.getBoundingClientRect();
          return {
            id,
            breakInside: getComputedStyle(el).breakInside,
            columns: getComputedStyle(wrapper).columnCount,
            // The box is taller than a column: its end is in a later column than its start.
            endsRightOfFirstColumn: last.left > w.left + w.width / 4,
          };
        }),
      );
      for (const r of report) {
        expect(r, r.id).toMatchObject({ columns: '2', endsRightOfFirstColumn: true });
        // The theme's rule still applies to list items: canvas.css changed the structure, not
        // break-inside. (Blank's own Firefox rule, style.less:686-693, sets blockquote and table
        // to break-inside: auto there.)
        if (r.id !== 'tall-quote') expect(r.breakInside, r.id).toBe('avoid');
      }
    });
  }
});

test.describe('layout matches upstream’s page structure', () => {
  // The canvas documents have nothing taller than a column, so upstream's structure lays them out
  // in Firefox too.
  for (const theme of ['5ePHB', 'Blank', '5eDMG', 'Journal', 'UnearthedArcana']) {
    test(`canvas documents s1, chrome, continued (${theme})`, async ({ page }, testInfo) => {
      const docs: Record<string, Layouts> = {};
      // One page load: the page's doc menu shows the other documents.
      await openCanvas(page, { doc: 's1', theme });
      docs.s1 = await layouts(page);
      for (const doc of ['chrome', 'continued'] as const) {
        await switchDoc(page, doc);
        docs[doc] = await layouts(page);
      }
      await saveLayout(testInfo, `canvas-${theme}`, Object.fromEntries(Object.entries(docs).map(([k, l]) => [k, l.ours])));
      for (const [doc, l] of Object.entries(docs)) expectUpstreamLayout(l, testInfo, `${doc} ${theme}`);
    });
  }

  // Paginated documents (pagination settled, then off). None has a box kept whole that is taller
  // than a column, so upstream's structure doesn't hang Firefox on them either.
  for (const theme of ['5ePHB', 'Blank']) {
    for (const doc of ['sample', 'fill', 'mixed20', 'long30']) {
      test(`paginated harness document ${doc} (${theme})`, async ({ page }, testInfo) => {
        await openHarness(page, { theme, doc });
        await page.evaluate(() => window.__hbPagination.setPaginate(false));
        const texts = await page.evaluate(() => window.__hbPagination.texts());
        const l = await layouts(page);
        await saveLayout(testInfo, `harness-${doc}-${theme}`, { texts, geometry: l.ours });
        expectUpstreamLayout(l, testInfo, `harness ${doc} ${theme}`);
      });
    }
  }
});

test.describe('continued list items (canvas.css)', () => {
  for (const theme of ['5ePHB', 'Blank']) {
    test(`no second marker; the empty filler paragraph takes no space (${theme})`, async ({ page }) => {
      await openCanvas(page, { doc: 'continued', theme });
      const r = await page.evaluate(() => {
        const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
        const rect = (el: Element) => el.getBoundingClientRect();
        const marker = (el: Element) => getComputedStyle(el, '::marker').content;
        const contOl = q('cont-ol-li');
        const next = q('next-ol-li');
        const filler = q('cont-filler-li');
        const fillerP = filler.querySelector<HTMLElement>(':scope > p')!;
        const fillerList = filler.querySelector<HTMLElement>(':scope > ul')!;
        const whole = q('whole-li');
        const wholeP = whole.querySelector<HTMLElement>(':scope > p')!;
        const wholeList = whole.querySelector<HTMLElement>(':scope > ul')!;
        const text = q('cont-text-li');
        const textP = text.querySelector<HTMLElement>(':scope > p')!;
        return {
          markers: { contOl: marker(contOl), next: marker(next), filler: marker(filler), whole: marker(whole), text: marker(text) },
          // list-item display keeps the counter going: the next item is still number 3.
          displays: [contOl, next, filler].map((el) => getComputedStyle(el).display),
          fillerClass: fillerP.className,
          fillerHeight: rect(fillerP).height,
          fillerDisplay: getComputedStyle(fillerP).display,
          // The nested list sits as far below the item's top as below the paragraph of a whole item.
          fillerGap: rect(fillerList).top - rect(filler).top,
          wholeGap: rect(wholeList).top - rect(wholeP).bottom,
          textHeight: rect(textP).height,
          textDisplay: getComputedStyle(textP).display,
          lineHeight: parseFloat(getComputedStyle(textP).lineHeight) || 0,
        };
      });
      expect(r.markers).toEqual({ contOl: 'none', next: 'normal', filler: 'none', whole: 'normal', text: 'none' });
      expect(r.displays).toEqual(['list-item', 'list-item', 'list-item']);
      expect(r.fillerClass).toBe('hb-continued');
      expect(r.fillerHeight).toBe(0);
      expect(r.fillerDisplay).toBe('flow-root');
      expect(Math.abs(r.fillerGap - r.wholeGap)).toBeLessThan(0.5);
      // A continued item whose first paragraph has text keeps it.
      expect(r.textDisplay).toBe('block');
      expect(r.textHeight).toBeGreaterThan(5);
    });
  }

  test('the marker area of a continued item is empty (pixels)', async ({ page }) => {
    await openCanvas(page, { doc: 'continued', theme: 'Blank' });
    const li = page.getByTestId('cont-ol-li');
    const box = (await li.boundingBox())!;
    const clip = { x: box.x - 40, y: box.y, width: 40, height: 20 };
    const hidden = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    const forced = await page.addStyleTag({ content: '.hb-canvas .page li.hb-continued::marker { content: normal !important; }' });
    const shown = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    await removeStyle(forced);
    const none = await page.addStyleTag({ content: '.hb-canvas .page li.hb-continued { list-style-type: none !important; }' });
    const reference = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    await removeStyle(none);
    expect(shown.equals(hidden)).toBe(false); // there is a marker to hide …
    expect(hidden.equals(reference)).toBe(true); // … and nothing is drawn in its place
  });

  test('pagination output: a nested list pushed to the next page starts without filler line or marker; settles', async ({ page }) => {
    await openHarness(page, { theme: '5ePHB', paginate: false });
    // A nested list of 40 short items: the cut falls between nested items ('nested' rule), so the
    // outer item continues on the next page with a filler paragraph before its nested list.
    const nested = hul(...Array.from({ length: 40 }, (_, k) => liOf(hp(hfiller(150, k)))));
    await load(page, hdoc(hpage([hp(hfiller(3000)), hul(liOf(hp('Short item.'), nested)), hp('After the list.')])), false);
    const r = await page.evaluate(async () => {
      const api = window.__hbPagination;
      api.setPaginate(true);
      await api.settled();
      const fillers = Array.from(document.querySelectorAll<HTMLElement>('.page li.hb-continued > p.hb-continued:first-child')).filter(
        (el) => el.textContent === '',
      );
      const before = JSON.stringify(api.docJSON());
      api.repaginate(0);
      await api.settled();
      return {
        pages: api.pages().length,
        fillers: fillers.map((el) => ({
          height: el.getBoundingClientRect().height,
          marker: getComputedStyle(el.parentElement!, '::marker').content,
        })),
        stable: JSON.stringify(api.docJSON()) === before,
        overflowing: api.overflowing(),
        stats: api.state()!.stats,
      };
    });
    expect(r.pages).toBeGreaterThanOrEqual(3);
    expect(r.fillers.length).toBeGreaterThanOrEqual(1);
    for (const f of r.fillers) expect(f).toEqual({ height: 0, marker: 'none' });
    expect(r.stable).toBe(true); // no pull/push oscillation: a repagination changes nothing
    expect(r.overflowing).toEqual([]);
    expect(r.stats).toMatchObject({ guardHits: 0, errors: 0 });
  });
});
