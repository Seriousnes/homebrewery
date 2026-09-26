// cut.ts (plan §4.4, P4.2) with the real theme CSS: one test per rule. Each test builds a page
// that overflows in a specific way (pagination off), checks chooseCut's position against the
// layout, then turns pagination on and checks the result.
import type { Page } from '@playwright/test';
import {
  block,
  columnBreak,
  dl,
  doc,
  expect,
  filler,
  h,
  imageParagraph,
  sizedImage,
  li,
  liOf,
  load,
  ol,
  p,
  page as pg,
  settled,
  test,
  ul,
  useHarness,
  type Cut,
  type Measure,
} from './harness';

async function grow(page: Page, column: number, fraction: number): Promise<Measure> {
  const m = await page.evaluate(([c, f]) => window.__hbPagination.grow(0, { column: c, fraction: f }), [column, fraction] as const);
  expect(m).not.toBeNull();
  return m!;
}

const append = (page: Page, json: Record<string, unknown>) => page.evaluate((j) => window.__hbPagination.insertBlock(0, j), json);
const measure = (page: Page) => page.evaluate(() => window.__hbPagination.measure(0)!);
const cut = (page: Page) => page.evaluate(() => window.__hbPagination.cut(0)!);

/** Turns pagination on and waits for the settle; returns the pages' texts. */
async function paginate(page: Page): Promise<string[][]> {
  return page.evaluate(async () => {
    const api = window.__hbPagination;
    api.setPaginate(true);
    await api.settled(10_000);
    return api.texts();
  });
}

async function expectSettledClean(page: Page) {
  const r = await page.evaluate(() => ({ overflowing: window.__hbPagination.overflowing(), stats: window.__hbPagination.state()!.stats }));
  expect(r.overflowing).toEqual([]);
  expect(r.stats.guardHits).toBe(0);
  expect(r.stats.errors).toBe(0);
}

const inside = (r: { left: number; bottom: number }, m: Measure) => r.left < m.box.right - m.eps && r.bottom <= m.box.bottom + m.eps;
const outside = (r: { left: number; bottom: number }, m: Measure) => !inside(r, m);

test.describe('chooseCut (5ePHB)', () => {
  test.beforeEach(async ({ page }) => {
    await useHarness(page, { paginate: false });
  });

  test('paragraph: the cut is the start of its first line outside the box', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 })), false);
    await grow(page, 1, 0.8);
    await append(page, p(filler(2400, 3)));
    const m = await measure(page);
    const c: Cut = await cut(page);
    expect(m.overflow).toBe(true);
    expect(c).toMatchObject({ rule: 'line', oversized: false });
    expect(c.at).toMatchObject({ depth: 2, parent: 'paragraph' });
    // The character at the cut is in the overflow column, at the start of its line (a word, never
    // a space); the one before it is still inside the box, unless it is a space hanging at the end
    // of the line before (coordsAtPos may place that one past the box's edge).
    expect(outside(c.at!.coords!, m)).toBe(true);
    expect(c.at!.after).not.toMatch(/^\s/);
    if (!c.at!.before.endsWith(' ')) expect(inside(c.at!.coordsBefore!, m)).toBe(true);
    const pitch = m.columnWidth + m.gap;
    expect(Math.abs(c.at!.coords!.left - (m.box.left + 2 * pitch))).toBeLessThan(1.5);

    const texts = await paginate(page);
    // The page ends where the cut was; the rest continues on the next page.
    expect(texts[0]![texts[0]!.length - 1]!.endsWith(c.at!.before)).toBe(true);
    expect(texts[1]![0]!.startsWith(c.at!.after)).toBe(true);
    expect((await page.evaluate(() => window.__hbPagination.pages()))[1]!.blocks[0]).toMatch(/^paragraph\(cont\)/);
    await expectSettledClean(page);
  });

  test('a paragraph that starts outside moves whole (column break before it)', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 })), false);
    await grow(page, 1, 0.3);
    await append(page, columnBreak());
    await append(page, p(filler(400, 2)));
    const c = await cut(page);
    expect(c).toMatchObject({ rule: 'block', oversized: false });
    expect(c.at!.depth).toBe(1);
    expect(c.at!.nodeAfter).toMatch(/^paragraph/);
    expect(c.at!.nodeBefore).toMatch(/^columnBreak/);
  });

  test('bullet list: the cut is before the first item outside', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 })), false);
    await grow(page, 1, 0.6);
    await append(page, ul(...Array.from({ length: 30 }, (_, i) => li(`Item ${i + 1}: ${filler(90, i)}`))));
    const m = await measure(page);
    const c = await cut(page);
    expect(c).toMatchObject({ rule: 'item', oversized: false });
    expect(c.at).toMatchObject({ depth: 2, parent: 'bulletList' });
    expect(c.at!.nodeAfter).toMatch(/^listItem/);
    expect(c.at!.afterRects!.some((r) => outside(r, m))).toBe(true);
    expect(c.at!.beforeRects!.every((r) => inside(r, m))).toBe(true);
    const texts = await paginate(page);
    expect(texts[1]![0]!.startsWith(c.at!.nodeAfter!.slice('listItem:'.length))).toBe(true);
    await expectSettledClean(page);
  });

  test('ordered list: the continuation starts at the right number', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 })), false);
    await grow(page, 1, 0.6);
    await append(page, ol(1, ...Array.from({ length: 30 }, (_, i) => li(`Step ${i + 1}: ${filler(90, i)}`))));
    const c = await cut(page);
    expect(c.rule).toBe('item');
    const texts = await paginate(page);
    const firstOnNext = texts[1]![0]!;
    const number = Number(/^Step (\d+):/.exec(firstOnNext)![1]);
    const start = await page.evaluate(() => document.querySelectorAll('.ProseMirror > .page')[1]!.querySelector('ol')!.getAttribute('start'));
    expect(Number(start)).toBe(number);
    expect(number).toBeGreaterThan(1);
    await expectSettledClean(page);
  });

  test('definition list: the cut is before the first group (dt + dd) outside', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 })), false);
    await grow(page, 1, 0.8);
    await append(page, dl(...Array.from({ length: 60 }, (_, i): [string, string] => [`Term ${i + 1}`, filler(50, i)])));
    const m = await measure(page);
    const c = await cut(page);
    expect(c).toMatchObject({ rule: 'group', oversized: false });
    expect(c.at).toMatchObject({ depth: 2, parent: 'definitionList' });
    expect(c.at!.nodeAfter).toMatch(/^definitionTerm/);
    // The group before the cut is inside the box (its dd's line fragments).
    expect(c.at!.beforeRects!.every((r) => inside(r, m))).toBe(true);
    const texts = await paginate(page);
    expect(texts[1]![0]).toMatch(/^Term \d+$/);
    await expectSettledClean(page);
  });

  test('keep-with-next: a heading right before the cut moves with the block after it', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 })), false);
    await grow(page, 1, 0.87);
    await append(page, h(3, 'Stranded Heading'));
    await append(page, block(['note'], [h(5, 'Note'), p(filler(700, 2))]));
    const m = await measure(page);
    expect(m.overflow).toBe(true);
    expect(m.first!.type).toBe('themeBlock');
    const c = await cut(page);
    expect(c).toMatchObject({ rule: 'keepWithNext', oversized: false });
    expect(c.at!.nodeAfter).toBe('heading:Stranded Heading');
    const texts = await paginate(page);
    expect(texts[1]![0]).toBe('Stranded Heading');
    await expectSettledClean(page);
  });

  test('keep-with-next: a heading on the last line moves with the paragraph after it', async ({ page }) => {
    await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 })), false);
    await grow(page, 1, 0.8);
    // Fill the last column line by line until only the heading and less than two lines fit.
    const room = await page.evaluate(() => {
      const api = window.__hbPagination;
      const lineHeight = 16.1; // 5ePHB body text
      for (let n = 0; n < 200; n++) {
        const m = api.measure(0)!;
        const free = m.columnFree[m.columns - 1]!;
        if (free < 30 + 1.6 * lineHeight) return free;
        api.insertBlock(0, { type: 'paragraph', content: [{ type: 'text', text: 'One line of text.' }] });
      }
      return -1;
    });
    expect(room).toBeGreaterThan(0);
    await append(page, h(3, 'Stranded Heading'));
    await append(page, p(filler(900, 4)));
    const c = await cut(page);
    // The heading fits, the paragraph can't start below it (two lines needed): both move.
    expect(c.at!.nodeAfter).toBe('heading:Stranded Heading');
    expect(['keepWithNext', 'block']).toContain(c.rule);
    const texts = await paginate(page);
    expect(texts[1]![0]).toBe('Stranded Heading');
    await expectSettledClean(page);
  });

  test('unsplittable blocks (theme block, table) move whole', async ({ page }) => {
    for (const unsplittable of [
      block(['note'], [h(5, 'Rumors'), p(filler(600, 1))]),
      {
        type: 'table',
        content: Array.from({ length: 24 }, (_, i) => ({
          type: 'tableRow',
          content: [String(i + 1), filler(40, i)].map((s) => ({ type: i === 0 ? 'tableHeader' : 'tableCell', content: [p(s)] })),
        })),
      },
    ]) {
      await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 })), false);
      await grow(page, 1, 0.8);
      await append(page, unsplittable);
      const m = await measure(page);
      expect(m.overflow).toBe(true);
      const c = await cut(page);
      expect(c).toMatchObject({ rule: 'block', oversized: false });
      expect(c.at!.depth).toBe(1);
      expect(c.at!.nodeAfter).toMatch(/^(themeBlock|table)/);
      await page.evaluate(() => window.__hbPagination.setPaginate(true));
      await settled(page);
      const pages = await page.evaluate(() => window.__hbPagination.pages());
      expect(pages[1]!.blocks[0]).toMatch(/^(themeBlock|table)/);
      await expectSettledClean(page);
      await page.evaluate(() => window.__hbPagination.setPaginate(false));
    }
  });

  test('a first block taller than a column: the page is flagged oversized, what follows moves on', async ({ page }) => {
    const tall = block(['monster', 'frame'], [h(2, 'Tarrasque'), p(filler(200))], 'height: 1200px');
    await load(page, doc(pg([tall, p('After the tall block.'), p(filler(300, 3))], { columns: 2 })), false);
    const c = await cut(page);
    expect(c).toMatchObject({ rule: 'oversized', oversized: true });
    expect(c.at!.nodeBefore).toMatch(/^themeBlock/);
    await paginate(page);
    const pages = await page.evaluate(() => window.__hbPagination.pages());
    expect(pages[0]).toMatchObject({ oversized: true, blocks: [expect.stringMatching(/^themeBlock/)] });
    expect(pages[1]!.blocks[0]).toBe('paragraph:After the tall block.');
    const stats = await page.evaluate(() => window.__hbPagination.state()!.stats);
    expect(stats).toMatchObject({ guardHits: 0, errors: 0 });
    // Nothing loops: repaginating changes nothing.
    const before = await page.evaluate(() => JSON.stringify(window.__hbPagination.docJSON()));
    await page.evaluate(async () => {
      window.__hbPagination.repaginate(0);
      await window.__hbPagination.settled(10_000);
    });
    expect(await page.evaluate(() => JSON.stringify(window.__hbPagination.docJSON()))).toBe(before);
    // A heading before the tall block stays with it (moving both would loop).
    await page.evaluate(() => window.__hbPagination.setPaginate(false));
    await load(page, doc(pg([h(2, 'Lead'), tall, p('After.')], { columns: 2 })), false);
    const withHeading = await cut(page);
    expect(withHeading).toMatchObject({ rule: 'oversized', oversized: true });
    expect(withHeading.at!.nodeAfter).toBe('paragraph:After.');
  });

  test('keep-with-next at the top of a page: a block that fits a fresh page moves on, nothing is oversized', async ({ page }) => {
    // A chapter heading (spanning both columns) and a note that fits a column but not the row
    // below the heading (finding PG-4). Size the note to the column: its margin-box height ends
    // 10 px above the bottom of an empty column.
    const probe = await page.evaluate((json) => {
      const api = window.__hbPagination;
      api.load(json);
      const wrap = document.querySelector<HTMLElement>('.ProseMirror > .page > .columnWrapper')!;
      const note = wrap.querySelector<HTMLElement>('.note')!;
      const m = api.measure(0)!;
      return { column: m.box.bottom - m.box.top, note: note.getBoundingClientRect().height, marginTop: parseFloat(getComputedStyle(note).marginTop) || 0 };
    }, doc(pg([block(['note'], [p('A tall note.')], 'height: 500px')], { columns: 2 })));
    const height = Math.floor(500 + probe.column - 10 - probe.marginTop - probe.note);
    await load(page, doc(pg([h(1, 'Chapter'), block(['note'], [p('A tall note.')], `height: ${height}px`), p('After the block.')], { columns: 2 })), false);
    const m = await measure(page);
    expect(m.overflow).toBe(true);
    expect(m.first!.type).toBe('themeBlock');
    const c = await cut(page);
    expect(c).toMatchObject({ oversized: false, rule: 'block' });
    expect(c.at!.nodeBefore).toBe('heading:Chapter');
    expect(c.at!.nodeAfter).toMatch(/^themeBlock/);
    await paginate(page);
    const pages = await page.evaluate(() => window.__hbPagination.pages());
    expect(pages[0]!.blocks).toEqual(['heading:Chapter']);
    expect(pages[1]!.blocks[0]).toMatch(/^themeBlock/);
    expect(pages.map((x) => x.oversized)).toEqual(pages.map(() => false));
    await expectSettledClean(page); // the note is whole on page 2 (DOM truth)
  });

  test('keep-with-next: a heading added on the last free line of a settled page moves to the next page', async ({ page }) => {
    // Page 2 (auto) starts with a note that doesn't fit on page 1 (finding PG-6).
    await load(
      page,
      doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2 }), pg([block(['note'], [h(5, 'Note'), p(filler(500, 2))])], { columns: 2, kind: 'auto' })),
      false,
    );
    await grow(page, 1, 0.8);
    const room = await page.evaluate(() => {
      const api = window.__hbPagination;
      for (let n = 0; n < 200; n++) {
        const m = api.measure(0)!;
        if (m.columnFree[m.columns - 1]! < 70) return m.columnFree[m.columns - 1]!;
        api.insertBlock(0, { type: 'paragraph', content: [{ type: 'text', text: 'One line of text.' }] });
      }
      return -1;
    });
    expect(room).toBeGreaterThan(0);
    await append(page, h(4, 'Stranded'));
    expect((await measure(page)).overflow).toBe(false); // the heading fits on the page's last lines
    await paginate(page);
    const pages = await page.evaluate(() => window.__hbPagination.pages());
    expect(pages[0]!.blocks[pages[0]!.blocks.length - 1]).not.toBe('heading:Stranded');
    expect(pages[1]!.blocks.slice(0, 2)).toEqual(['heading:Stranded', expect.stringMatching(/^themeBlock/)]);
    await expectSettledClean(page);
  });

  test('a floated image that does not fit is not pulled into the overflow column', async ({ page }) => {
    // Page 2 (auto) starts with a paragraph holding only a float taller than the room left on
    // page 1 (finding PG-1): pulling it back would push the image into the clipped column.
    await load(
      page,
      doc(
        pg([h(1, 'Title'), p(filler(300))], { columns: 2 }),
        pg([imageParagraph({ src: sizedImage(200, 420), width: 200, height: 420, style: 'float: right;' }), p('After the image.')], { columns: 2, kind: 'auto' }),
      ),
      false,
    );
    await grow(page, 1, 0.7);
    await paginate(page);
    const img = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.ProseMirror img:not(.ProseMirror-separator)')!;
      const pageEl = el.closest<HTMLElement>('.page')!;
      const index = Array.from(document.querySelectorAll('.ProseMirror > .page')).indexOf(pageEl);
      return { index, truth: window.__hbPagination.domTruth(index)! };
    });
    expect(img.index).toBe(1);
    expect(img.truth.overflow).toBe(false);
    expect((await page.evaluate(() => window.__hbPagination.texts())).flat()).toContain('After the image.');
    await expectSettledClean(page);
  });

  test('right-to-left page: the cut is the start of the first line in the overflow column, left of the box', async ({ page }) => {
    // Finding PG-8.
    await load(page, doc(pg([h(1, 'Title'), p(filler(300))], { columns: 2, style: 'direction: rtl;' })), false);
    await grow(page, 1, 0.8);
    await append(page, p(filler(2400, 3)));
    const m = await measure(page);
    const c = await cut(page);
    expect(m).toMatchObject({ overflow: true, rtl: true });
    expect(c).toMatchObject({ rule: 'line', oversized: false });
    expect(c.at).toMatchObject({ depth: 2, parent: 'paragraph' });
    expect(c.at!.coords!.right).toBeLessThanOrEqual(m.box.left + m.eps); // in the overflow column
    expect(c.at!.after).not.toMatch(/^\s/);
    // The line before is inside (a space hanging at its end may be placed past the box's edge).
    if (!c.at!.before.endsWith(' ')) expect(c.at!.coordsBefore!.right).toBeGreaterThan(m.box.left + m.eps);
    const texts = await paginate(page);
    expect(texts[0]![texts[0]!.length - 1]!.endsWith(c.at!.before)).toBe(true);
    expect(texts[1]![0]!.startsWith(c.at!.after)).toBe(true);
    await expectSettledClean(page);
  });

  test('a first list item taller than the page is cut inside (nested)', async ({ page }) => {
    // Firefox used to hang here (li { break-inside: avoid } in a .columnWrapper spanning the
    // multi-column .page); canvas.css makes .page a flex container (e2e/canvas/multicol.spec.ts).
    await load(page, doc(pg([ul(liOf(p(filler(9000))), li('second item')), p('after')], { columns: 2 })), false);
    const c = await cut(page);
    expect(c).toMatchObject({ rule: 'nested', oversized: false });
    expect(c.at).toMatchObject({ parent: 'paragraph', depth: 4 });
    await paginate(page);
    const pages = await page.evaluate(() => window.__hbPagination.pages());
    expect(pages[1]!.blocks[0]).toMatch(/^bulletList\(cont\)/);
    expect(pages.every((pg) => !pg.oversized)).toBe(true);
    await expectSettledClean(page);
  });
});
