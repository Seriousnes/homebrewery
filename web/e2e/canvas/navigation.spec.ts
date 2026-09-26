// S1 go/no-go (a), (b), (e): caret movement across CSS columns and pages, drag selection across
// pages, click-to-caret under transform zoom. /dev/canvas, 5ePHB, the hand-built s1 document:
// page 1's split-para runs from the bottom of column 1 to the top of column 2; page1-last is the
// last paragraph of page 1 (column 2), page2-first the first of page 2.
import { expect, test, type Page } from '@playwright/test';
import {
  caret,
  centerInViewport,
  columnBoundary,
  coordsAt,
  lineOf,
  openCanvas,
  paragraphRange,
  press,
  setCaret,
  settle,
  wordBox,
} from './helpers';

test.use({ viewport: { width: 1400, height: 1300 } });

/** Presses `key` until the head is at `pos` (at most 3 times); returns the number of presses. */
async function pressUntil(page: Page, key: string, pos: number): Promise<number> {
  for (let n = 1; n <= 3; n++) {
    await press(page, key);
    if ((await caret(page)).head === pos) return n;
  }
  throw new Error(`${key} never reached ${pos} (at ${(await caret(page)).head})`);
}

/** Left edge of the line containing `pos` (the column's text start for an unindented line). */
async function lineLeft(page: Page, pos: number): Promise<number> {
  const line = await lineOf(page, pos);
  return (await coordsAt(page, line.from)).left;
}

test.describe('S1 (a) arrow keys', () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
  });

  test('ArrowDown / ArrowUp move between the bottom of column 1 and the top of column 2', async ({ page }) => {
    const boundary = await columnBoundary(page, 'split-para');
    const lastLine = await lineOf(page, boundary.lastInColumn);
    const firstLine = await lineOf(page, boundary.firstInNext);
    const start = lastLine.from + Math.floor((lastLine.to - lastLine.from) / 2);

    await setCaret(page, start);
    const before = await caret(page);
    const col1Left = await lineLeft(page, start);
    await press(page, 'ArrowDown');
    const down = await caret(page);
    expect(down.head, 'caret on the first line of column 2').toBeGreaterThanOrEqual(firstLine.from);
    expect(down.head).toBeLessThanOrEqual(firstLine.to);
    const col2Left = await lineLeft(page, down.head);
    expect(col2Left - col1Left, 'column 2 is right of column 1').toBeGreaterThan(300);
    // Same horizontal offset inside the column (within about one character).
    expect(Math.abs(down.left - col2Left - (before.left - col1Left))).toBeLessThan(12);

    await press(page, 'ArrowUp');
    const up = await caret(page);
    expect(up.head, 'back on the last line of column 1').toBeGreaterThanOrEqual(lastLine.from);
    expect(up.head).toBeLessThanOrEqual(lastLine.to);
    expect(Math.abs(up.left - before.left)).toBeLessThan(12);
  });

  test('ArrowRight / ArrowLeft step over the column boundary one character at a time', async ({ page, browserName }) => {
    const boundary = await columnBoundary(page, 'split-para');
    // Firefox has two caret stops at every soft line wrap in pre-wrap text (end of the line, then
    // start of the next, same offset), inside a column as much as between columns.
    const wrapStops = browserName === 'firefox' ? 2 : 1;
    await setCaret(page, boundary.lastInColumn);
    await press(page, 'ArrowRight');
    expect((await caret(page)).head).toBe(boundary.firstInNext);
    expect(await pressUntil(page, 'ArrowRight', boundary.firstInNext + 1)).toBeLessThanOrEqual(wrapStops);
    const next = await caret(page);
    expect(next.left, 'caret drawn in column 2').toBeGreaterThan((await coordsAt(page, boundary.lastInColumn)).left);
    await press(page, 'ArrowLeft');
    expect((await caret(page)).head).toBe(boundary.firstInNext);
    expect(await pressUntil(page, 'ArrowLeft', boundary.lastInColumn)).toBeLessThanOrEqual(wrapStops);
  });

  test('ArrowDown / ArrowUp move between the last line of page 1 and the first line of page 2', { tag: '@smoke' }, async ({ page }) => {
    const last = await paragraphRange(page, 'page1-last');
    const first = await paragraphRange(page, 'page2-first');
    const lastLine = await lineOf(page, last.to);
    const start = lastLine.from + Math.floor((lastLine.to - lastLine.from) / 2);

    await setCaret(page, start);
    const before = await caret(page);
    expect(before.page).toBe(0);
    const p1Left = await lineLeft(page, start);
    await press(page, 'ArrowDown');
    const down = await caret(page);
    expect(down.page, 'caret on page 2').toBe(1);
    const firstLine = await lineOf(page, first.from);
    expect(down.head, 'on the first line of page 2').toBeGreaterThanOrEqual(firstLine.from);
    expect(down.head).toBeLessThanOrEqual(firstLine.to);
    const p2Left = await lineLeft(page, down.head);
    expect(Math.abs(down.left - p2Left - (before.left - p1Left))).toBeLessThan(12);

    await press(page, 'ArrowUp');
    const up = await caret(page);
    expect(up.page).toBe(0);
    const upLine = await lineOf(page, up.head);
    expect(upLine).toEqual(lastLine);
    expect(Math.abs(up.left - before.left)).toBeLessThan(12);
  });

  test('ArrowRight / ArrowLeft cross the page boundary', async ({ page }) => {
    const last = await paragraphRange(page, 'page1-last');
    const first = await paragraphRange(page, 'page2-first');
    await setCaret(page, last.to);
    await press(page, 'ArrowRight');
    const right = await caret(page);
    expect(right.head).toBe(first.from);
    expect(right.page).toBe(1);
    await press(page, 'ArrowLeft');
    const left = await caret(page);
    expect(left.head).toBe(last.to);
    expect(left.page).toBe(0);
  });

  test('repeated ArrowDown walks every line of column 1 into column 2; Shift extends across it', async ({ page }) => {
    const boundary = await columnBoundary(page, 'split-para');
    const split = await paragraphRange(page, 'split-para');
    const firstLine = await lineOf(page, boundary.firstInNext);
    // Three lines above the column's last line.
    let pos = boundary.lastInColumn;
    for (let i = 0; i < 3; i++) pos = (await lineOf(page, pos)).from - 1;
    await setCaret(page, pos);
    const heads: number[] = [];
    for (let i = 0; i < 4; i++) {
      await press(page, 'ArrowDown');
      heads.push((await caret(page)).head);
    }
    // Strictly forward, one line at a time, ending on column 2's first line.
    for (let i = 1; i < heads.length; i++) expect(heads[i]).toBeGreaterThan(heads[i - 1]!);
    expect(heads[3]).toBeGreaterThanOrEqual(firstLine.from);
    expect(heads[3]).toBeLessThanOrEqual(firstLine.to);

    await setCaret(page, heads[2]!);
    await press(page, 'Shift+ArrowDown');
    const extended = await caret(page);
    expect(extended.anchor).toBe(heads[2]);
    expect(extended.head).toBeGreaterThanOrEqual(firstLine.from);
    expect(extended.from).toBeGreaterThan(split.from);
    expect(extended.empty).toBe(false);
  });

  test('the caret steps through ligature candidates (canvas.css turns ligatures back on)', async ({ page }) => {
    // S1 measured the 5ePHB text fonts (BookInsanityRemake, MrEavesRemake, ScalySansRemake): no
    // pair of fi, fl, ff, ffi, ffl, Th, st, ct, ft, fj, tt changes width with ligatures on, so
    // they draw no standard ligatures. This checks "fl" char by char anyway and records the widths
    // (a theme font with ligatures would show a difference in the annotation).
    const word = await wordBox(page, 'split-para', 'flooded');
    const ligature = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.textContent = 'fl';
      document.querySelector('[data-testid="split-para"]')!.append(probe);
      const on = probe.getBoundingClientRect().width;
      probe.style.fontVariantLigatures = 'none';
      const off = probe.getBoundingClientRect().width;
      probe.remove();
      return { on, off, variant: getComputedStyle(document.querySelector('.hb-canvas .ProseMirror')!).fontVariantLigatures };
    });
    expect(ligature.variant).toBe('normal');
    test.info().annotations.push({ type: 'ligature', description: `"fl" ${ligature.on.toFixed(2)}px with ligatures, ${ligature.off.toFixed(2)}px without` });
    const xs = [];
    for (let pos = word.from; pos <= word.from + 3; pos++) xs.push((await coordsAt(page, pos)).left);
    for (let i = 1; i < xs.length; i++) expect(xs[i], 'caret positions inside the ligature are distinct').toBeGreaterThan(xs[i - 1]! + 0.5);
    await setCaret(page, word.from);
    for (let i = 1; i <= 3; i++) {
      await press(page, 'ArrowRight');
      expect((await caret(page)).head).toBe(word.from + i);
    }
  });
});

test.describe('S1 (b) drag selection across pages', () => {
  for (const zoom of [1, 0.5]) {
    test(`mouse drag from page 1 into page 2 selects across the page boundary (zoom ${zoom})`, async ({ page }) => {
      await openCanvas(page, { zoom });
      const startWord = await wordBox(page, 'page1-last', 'longest');
      const endWord = await wordBox(page, 'page2-first', 'corridors');
      await centerInViewport(page, (startWord.top + endWord.bottom) / 2);
      const a = await wordBox(page, 'page1-last', 'longest');
      const b = await wordBox(page, 'page2-first', 'corridors');
      // An editor that already has focus, as when an author selects text while writing.
      // (ProseMirror re-syncs the DOM selection 20 ms after the editor gains focus; a synthetic
      // drag that starts sooner than that can lose its anchor. See the S1 report.)
      await setCaret(page, a.from);
      await page.waitForTimeout(100);
      // Start just inside the word's left edge. (Chromium drops a synthetic drag that starts within
      // about a pixel of a glyph's midpoint, on any contenteditable; see the S1 report.)
      const [ax, ay] = [a.left + 0.3, (a.top + a.bottom) / 2];
      const [bx, by] = [b.right - 1, (b.top + b.bottom) / 2];
      await page.mouse.move(ax, ay);
      await page.mouse.down();
      // 60 Hz pointer: ~16 ms between moves.
      for (let i = 1; i <= 20; i++) {
        await page.mouse.move(ax + ((bx - ax) * i) / 20, ay + ((by - ay) * i) / 20);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      await settle(page);
      const sel = await caret(page);
      const selected = await page.evaluate(() => {
        const { state } = window.__editor!;
        const { from, to } = state.selection;
        return {
          fromPage: state.doc.resolve(from).index(0),
          toPage: state.doc.resolve(to).index(0),
          text: state.doc.textBetween(from, to, '\n'),
        };
      });
      expect(selected.fromPage).toBe(0);
      expect(selected.toPage).toBe(1);
      expect(Math.abs(sel.from - a.from)).toBeLessThanOrEqual(1);
      expect(Math.abs(sel.to - b.to)).toBeLessThanOrEqual(1);
      expect(selected.text.startsWith('longest')).toBe(true);
      expect(selected.text.endsWith('corridors')).toBe(true);
      // The selection is painted: the DOM selection spans both pages too.
      const domSpansPages = await page.evaluate(() => {
        const s = document.getSelection();
        if (!s || s.rangeCount === 0) return false;
        const r = s.getRangeAt(0);
        const pageOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('.page')?.id;
        return pageOf(r.startContainer) === 'p1' && pageOf(r.endContainer) === 'p2';
      });
      expect(domSpansPages).toBe(true);
    });
  }
});

test.describe('S1 (e) click-to-caret under zoom', () => {
  const targets = [
    { para: 'dropcap', word: 'corridors' },
    { para: 'split-para', word: 'remember', nth: -1 }, // the paragraph's part in column 2
    { para: 'page1-last', word: 'cellar' },
    { para: 'after-break', word: 'white' },
  ] as const;

  for (const zoom of [0.5, 1, 2]) {
    test(`clicking a word puts the caret inside it at ${zoom * 100}%`, async ({ page }) => {
      await openCanvas(page, { zoom });
      const scale = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLElement>('.hb-canvas')!;
        return canvas.getBoundingClientRect().width / canvas.offsetWidth;
      });
      expect(scale).toBeCloseTo(zoom, 3);
      for (const target of targets) {
        const first = await wordBox(page, target.para, target.word, 'nth' in target ? target.nth : 0);
        await centerInViewport(page, (first.top + first.bottom) / 2, (first.left + first.right) / 2);
        const box = await wordBox(page, target.para, target.word, 'nth' in target ? target.nth : 0);
        const x = box.left + (box.right - box.left) * 0.45;
        const y = (box.top + box.bottom) / 2;
        await page.mouse.click(x, y);
        await settle(page);
        const c = await caret(page);
        expect(c.empty, `${target.word}: collapsed caret`).toBe(true);
        expect(c.head, `${target.word}: caret inside the word`).toBeGreaterThanOrEqual(box.from);
        expect(c.head).toBeLessThanOrEqual(box.to);
        // The caret is drawn where the click was: same line, within about one character.
        expect(y).toBeGreaterThanOrEqual(c.top - 1);
        expect(y).toBeLessThanOrEqual(c.bottom + 1);
        expect(Math.abs(c.left - x)).toBeLessThan(10 * zoom + 2);
      }
    });
  }
});
