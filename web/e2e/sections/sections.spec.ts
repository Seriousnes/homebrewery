// Section commands (P4.6) in the browser: Mod-Enter, the section columns setting (only that
// section reflows), Backspace at a section start, undo. /dev/sections, 5ePHB, both browsers.
import type { Page } from '@playwright/test';
import { doc, expect, h, load, p, page as pg, paragraphs, settled, test, useHarness, type PageReport } from '../pagination/harness';

test.use({ harnessVariant: 'sections' });

const pages = (page: Page) => page.evaluate(() => window.__hbPagination.pages());
const texts = (page: Page) => page.evaluate(() => window.__hbPagination.texts());

/** Page indexes per section (by the pid of its first page). */
function sectionsOf(list: PageReport[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let current = '';
  for (const p of list) {
    if (p.kind !== 'auto') current = p.pid ?? `#${p.index}`;
    out.set(current, [...(out.get(current) ?? []), p.index]);
  }
  return out;
}

test.beforeEach(async ({ page }) => {
  await useHarness(page, { sections: true });
});

test('Mod-Enter breaks the page at the cursor: a new section that content never flows back from; one undo step', { tag: '@smoke' }, async ({ page }) => {
  await load(page, doc(pg([h(1, 'Chapter'), ...paragraphs(4, 500)], { pid: 'section1', footer: 'Footer', pageNumber: true })));
  const before = await texts(page);
  expect(before).toHaveLength(1);
  // The cursor in the middle of the third paragraph.
  const word = await page.evaluate(() => {
    const api = window.__hbPagination;
    const third = api.texts()[0]![3]!;
    const word = third.split(' ').slice(12, 14).join(' ');
    api.select(api.posOf(word));
    return word;
  });
  await page.keyboard.press('Control+Enter');
  await settled(page);
  const after = await pages(page);
  expect(after).toHaveLength(2);
  expect(after[1]).toMatchObject({ kind: 'manual', columns: 2 });
  expect(after[1]!.pid).toMatch(/^[0-9a-z]{8}$/);
  const t = await texts(page);
  expect(t[1]![0]!.startsWith(word)).toBe(true);
  // Page 1 has room, but content never flows back across a section start.
  expect(after[0]!.freeSpace).toBeGreaterThan(200);
  // The new page keeps the section's footer and page number (PageView chrome).
  const chrome = await page.evaluate(() => {
    const second = document.querySelectorAll('.ProseMirror > .page')[1]!;
    return { footer: second.querySelector('.footnote')?.textContent ?? null, pageNumber: second.querySelector('.pageNumber') !== null };
  });
  expect(chrome).toEqual({ footer: 'Footer', pageNumber: true });
  // The caret is at the start of the new section.
  expect(await page.evaluate(() => window.__hbPagination.caretInBlock())).toMatchObject({ page: 1, offset: 0 });
  await page.keyboard.press('Control+z');
  await settled(page);
  expect(await texts(page)).toEqual(before);
});

test('changing a section to 1 column (toolbar) reflows only that section, starting at its first page', async ({ page }) => {
  await page.evaluate(async () => {
    window.__hbPagination.load('sections');
    await window.__hbPagination.settled(10_000);
  });
  const before = await pages(page);
  const beforeTexts = await texts(page);
  const sections = sectionsOf(before);
  const a = sections.get('sectionA')!;
  const b = sections.get('sectionB')!;
  const c = sections.get('sectionC')!;
  expect(a.length).toBeGreaterThan(1);
  expect(c.length).toBeGreaterThan(1);
  // Cursor in section C (its second page), then the toolbar's columns select.
  await page.evaluate((index) => {
    const api = window.__hbPagination;
    api.select(api.blockPos(index, 0) + 1);
    api.events();
  }, c[1]!);
  await page.getByTestId('section-columns').selectOption('1');
  await settled(page);
  const after = await pages(page);
  const afterSections = sectionsOf(after);
  const c2 = afterSections.get('sectionC')!;
  // (One full-width column holds about as much as two: the page count may stay.)
  const afterTexts = await texts(page);
  for (const i of c2) expect(after[i]!.columns).toBe(1);
  // Section C was laid out again: its page boundaries moved.
  expect(c2.map((i) => afterTexts[i])).not.toEqual(c.map((i) => beforeTexts[i]));
  // Sections A and B are untouched: same pages, same texts.
  for (const i of [...a, ...b]) {
    expect(after[i]).toEqual(before[i]);
    expect(afterTexts[i]).toEqual(beforeTexts[i]);
  }
  // Pagination started at section C's first page and never looked before it.
  const steps = (await page.evaluate(() => window.__hbPagination.events())).filter((e) => e.kind === 'step');
  expect(steps.length).toBeGreaterThan(0);
  expect(Math.min(...steps.map((s) => (s.kind === 'step' ? (s.page ?? Infinity) : Infinity)))).toBe(c[0]);
  expect(await page.evaluate(() => window.__hbPagination.overflowing())).toEqual([]);
  // The select shows the section's setting.
  await expect(page.getByTestId('section-columns')).toHaveValue('1');
});

test('Backspace at the start of a section removes the break (content pulls back); undo restores the section and its settings', async ({ page }) => {
  await load(
    page,
    doc(
      pg([h(1, 'One'), ...paragraphs(2, 400)], { pid: 'sectionA', columns: 2 }),
      pg([h(1, 'Two'), ...paragraphs(2, 400, 3)], { pid: 'sectionB', columns: 1, footer: 'Part Two' }),
    ),
  );
  const before = await pages(page);
  expect(before.map((p) => p.pid)).toEqual(['sectionA', 'sectionB']);
  await page.evaluate(() => window.__hbPagination.select(window.__hbPagination.blockPos(1, 0) + 1));
  await page.keyboard.press('Backspace');
  await settled(page);
  const merged = await pages(page);
  expect(merged).toHaveLength(1); // everything fits on page 1 now
  expect((await texts(page))[0]).toContain('Two');
  await page.keyboard.press('Control+z');
  await settled(page);
  const restored = await pages(page);
  expect(restored.map((p) => [p.pid, p.kind, p.columns])).toEqual([
    ['sectionA', 'manual', 2],
    ['sectionB', 'manual', 1],
  ]);
  const footer = await page.evaluate(() => document.querySelectorAll('.ProseMirror > .page')[1]!.querySelector('.footnote')?.textContent ?? null);
  expect(footer).toBe('Part Two');
});

test('Backspace in a blank page kept only for its page number object deletes it; undo brings it back', async ({ page }) => {
  // As an imported brew had it: a page number object (from <div class='pageNumber auto'>) on a blank
  // auto page at the end; pagination never deletes a page that carries objects.
  const objects = [{ id: 'o2-1', kind: 'text', text: '', style: '', classes: ['pageNumber', 'auto'] }];
  await load(page, doc(pg([h(1, 'One'), ...paragraphs(1, 200)], { pid: 'sectionA' }), pg([p('')], { pid: 'blankpg1', kind: 'auto', objects })));
  expect((await pages(page)).map((r) => r.pid)).toEqual(['sectionA', 'blankpg1']);
  await page.evaluate(() => window.__hbPagination.select(window.__hbPagination.blockPos(1, 0) + 1));
  await page.keyboard.press('Backspace');
  await settled(page);
  expect((await pages(page)).map((r) => r.pid)).toEqual(['sectionA']);
  await page.keyboard.press('Control+z');
  await settled(page);
  expect((await pages(page)).map((r) => [r.pid, r.kind])).toEqual([
    ['sectionA', 'manual'],
    ['blankpg1', 'auto'],
  ]);
});
