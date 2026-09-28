// P3.9 in real browsers: the outline and the page navigation toolbar on /dev/panels. Clicking a
// heading or a page scrolls the canvas to it at 50%, 100% and 200% zoom, and the current page
// follows scrolling (IntersectionObserver on the canvas viewport).
import { expect } from '@playwright/test';
import { axeViolations, expectCurrentPage, offsetInViewport, openPanels, test, transitionsDone, viewportBox } from './helpers';

// Scrolling a target to the top leaves this many px above it (scrollCanvas.ts).
const MARGIN = 16;

test('the outline lists pages and headings from the document, with upstream labels', async ({ page }) => {
  await openPanels(page);
  const outline = page.getByRole('navigation', { name: 'Outline' });
  const pages = outline.locator('[data-page]');
  await expect(pages).toHaveText([
    'Page 1 - Cover: The Wandering Inn',
    'Page 2 - Table of Contents',
    'Page 3',
    'Page 4',
    'Page 5',
    'Page 6 - Interior Cover Page',
    'Page 7',
    'Page 8',
    'Page 9 - Section: Part Two: Below',
    'Page 10',
    'Page 11',
    'Page 12 - Rear Cover Page',
  ]);
  const page3 = outline.locator('li').filter({ has: page.locator('[data-page="3"]') });
  await expect(page3.locator('[data-entry]')).toHaveText(['Introduction', 'Using This Book', 'Conventions', 'Dice']);
  // Nested h2 of the stat block is listed; the note's h3 isn't (upstream selector).
  const page4 = outline.locator('li').filter({ has: page.locator('[data-page="4"]') });
  await expect(page4.locator('[data-entry]')).toHaveText(['The Common Room', 'Innkeeper']);
  await expect(outline.locator('[data-entry="custom-anchor"]')).toHaveAttribute('data-depth', '7');
  await expect(page.getByTestId('page-total')).toContainText('/ 12');
  await expectCurrentPage(page, 1);
});

for (const zoom of [0.5, 1, 2]) {
  test(`clicking a page or a heading scrolls to it at ${zoom * 100}% zoom`, async ({ page }) => {
    await openPanels(page, { zoom });
    const outline = page.getByRole('navigation', { name: 'Outline' });

    await outline.locator('[data-page="7"]').click();
    await expect.poll(async () => (await offsetInViewport(page, 7)).top).toBeCloseTo(MARGIN, 0);
    await expectCurrentPage(page, 7);
    // Text reflowing inside the page (a late font swap, typing) doesn't move the page: scroll
    // anchoring holds the page, not the first line in view (canvas.css). The browser applies an
    // anchoring adjustment in the rendering update that lays the change out, before it delivers
    // the ResizeObserver notification for it, where scrollTop is read.
    const scrolled = await page.evaluate(async () => {
      const viewport = window.__hbPanels!.handle.viewport!;
      const block = viewport.querySelectorAll('.pages > .page')[6]!.querySelector<HTMLElement>('.columnWrapper > *')!;
      const before = viewport.scrollTop;
      block.style.paddingTop = '3px';
      const after = await new Promise<number>((resolve) => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve(viewport.scrollTop);
        });
        observer.observe(block, { box: 'border-box' });
      });
      block.style.paddingTop = '';
      return after - before;
    });
    expect(scrolled).toBe(0);

    // A heading in the middle of page 3: its top lands at the top of the viewport.
    await outline.locator('[data-entry="conventions"]').click();
    await expect.poll(async () => (await offsetInViewport(page, '#conventions')).top).toBeCloseTo(MARGIN, 0);
    // The caret moved to the heading (no focus change: the link keeps it).
    await expect(outline.locator('[data-entry="conventions"]')).toBeFocused();
    const caret = await page.evaluate(() => {
      const { $from } = window.__hbPanels!.editor.state.selection;
      return { type: $from.parent.type.name, text: $from.parent.textContent, offset: $from.parentOffset };
    });
    expect(caret).toEqual({ type: 'heading', text: 'Conventions', offset: 0 });

    // Back up to the cover (at small zooms the viewport can't scroll above 0: the page stays where it starts).
    await outline.locator('[data-page="1"]').click();
    await expect
      .poll(async () => {
        const top = (await offsetInViewport(page, 1)).top;
        const scrollTop = await page.evaluate(() => window.__hbPanels!.handle.viewport!.scrollTop);
        return Math.abs(top - MARGIN) < 1 || (scrollTop === 0 && top <= MARGIN + 0.5);
      })
      .toBe(true);
    await expectCurrentPage(page, 1);
  });
}

test('the current page follows scrolling', async ({ page }) => {
  await openPanels(page);
  await expectCurrentPage(page, 1);
  // Scroll so that page 5 fills most of the viewport.
  await page.evaluate(() => {
    const viewport = window.__hbPanels!.handle.viewport!;
    const target = viewport.querySelectorAll('.pages > .page')[4]!;
    viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 40;
  });
  await expectCurrentPage(page, 5);
  // Scrolling with the wheel over the canvas.
  const box = await viewportBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const start = await page.evaluate(() => window.__hbPanels!.handle.viewport!.scrollTop);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
  // Firefox scrolls wheel input smoothly, after mouse.wheel has returned, and the current page
  // follows it through the pages in between (IntersectionObserver, a frame later). Wait for the
  // scroll to stop (scrollTop below the start and unchanged for 10 frames, checked in the page),
  // then compare the current page with the page taking most of the viewport, both read in one frame.
  await page.waitForFunction(
    (from) => {
      const top = window.__hbPanels!.handle.viewport!.scrollTop;
      const w = window as unknown as { __hbScrollProbe?: { top: number; frames: number } };
      const probe = (w.__hbScrollProbe ??= { top: -1, frames: 0 });
      probe.frames = top > from && top === probe.top ? probe.frames + 1 : 0;
      probe.top = top;
      return probe.frames >= 10;
    },
    start,
    { polling: 'raf', timeout: 10_000 },
  );
  // The page shown as current is the one taking most of the viewport.
  const currentAndBest = () =>
    page.evaluate(() => {
      const viewport = window.__hbPanels!.handle.viewport!;
      const v = viewport.getBoundingClientRect();
      let bestIndex = 0;
      let bestShare = -1;
      viewport.querySelectorAll('.pages > .page').forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const share = Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top)) / r.height;
        if (share > bestShare + 0.02) {
          bestShare = share;
          bestIndex = i;
        }
      });
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Current page"]');
      return { shown: Number(input?.value), best: bestIndex + 1 };
    });
  await expect.poll(async () => (await currentAndBest()).shown).toBeGreaterThan(5);
  await expect.poll(async () => {
    const { shown, best } = await currentAndBest();
    return shown === best ? 'same' : `shown ${shown}, most visible ${best}`;
  }).toBe('same');
});

test('previous, next and jump to a page', async ({ page }) => {
  await openPanels(page);
  const next = page.getByRole('button', { name: 'Next page' });
  const prev = page.getByRole('button', { name: 'Previous page' });
  const input = page.getByRole('textbox', { name: 'Current page' });
  await expect(prev).toHaveAttribute('aria-disabled', 'true');

  await next.click();
  await expectCurrentPage(page, 2);
  await expect.poll(async () => (await offsetInViewport(page, 2)).top).toBeCloseTo(MARGIN, 0);
  await next.click();
  await expectCurrentPage(page, 3);
  await prev.click();
  await expectCurrentPage(page, 2);

  await input.click();
  await input.fill('9');
  await input.press('Enter');
  await expectCurrentPage(page, 9);
  await expect.poll(async () => (await offsetInViewport(page, 9)).top).toBeCloseTo(MARGIN, 0);

  // Out of range is clamped to the last page, which can't scroll to the top but is current.
  await input.fill('99');
  await input.press('Enter');
  await expectCurrentPage(page, 12);
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled keeps focus on the button.
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(next).toBeFocused();
  await expectCurrentPage(page, 12);
});

test('facing pages: previous and next move by spreads', async ({ page }) => {
  await openPanels(page, { spread: 'facing', zoom: 0.5 });
  const next = page.getByRole('button', { name: 'Next page' });
  await page.getByRole('textbox', { name: 'Current page' }).fill('4');
  await page.getByRole('textbox', { name: 'Current page' }).press('Enter');
  // Page 1 sits alone on the right, so spreads are 2-3, 4-5, 6-7 …
  await expectCurrentPage(page, 4);
  await next.click();
  await expectCurrentPage(page, 6);
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expectCurrentPage(page, 4);
  const [left, right] = [await offsetInViewport(page, 4), await offsetInViewport(page, 5)];
  expect(Math.abs(left.top - right.top)).toBeLessThan(1);
});

test('keyboard: the toolbar and the outline are operable without a pointer', async ({ page }) => {
  await openPanels(page);
  const input = page.getByRole('textbox', { name: 'Current page' });
  await input.focus();
  await page.keyboard.press('ArrowDown');
  await expectCurrentPage(page, 2);
  await page.keyboard.press('ArrowUp');
  await expectCurrentPage(page, 1);
  // Right at the end of the text moves on to Next (the box is not a dead end in the toolbar).
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Next page' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expectCurrentPage(page, 2);
  // Left from Next, then Left at the start of the text, reaches Previous.
  await page.keyboard.press('ArrowLeft');
  await expect(input).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expectCurrentPage(page, 1);

  const link = page.getByRole('navigation', { name: 'Outline' }).locator('[data-page="10"]');
  await link.focus();
  await page.keyboard.press('Enter');
  await expectCurrentPage(page, 10);
  await expect(link).toBeFocused();
});

test('the outline follows edits and pagination', { tag: '@smoke' }, async ({ page }) => {
  await openPanels(page);
  await page.evaluate(() => {
    const editor = window.__hbPanels!.editor;
    // A new heading at the end of page 10.
    const doc = editor.state.doc;
    let end = 0;
    doc.forEach((pageNode, pos, index) => {
      if (index === 9) end = pos + pageNode.nodeSize - 1;
    });
    editor.chain().insertContentAt(end, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Added Later' }] }).run();
  });
  const entry = page.getByRole('navigation', { name: 'Outline' }).locator('[data-entry="added-later"]');
  await expect(entry).toHaveText('Added Later');
  await entry.click();
  await expect.poll(async () => (await offsetInViewport(page, '#added-later')).top).toBeCloseTo(MARGIN, 0);
});

test('outline panel: close, reopen, and resize with the keyboard', async ({ page }) => {
  await openPanels(page);
  const panel = page.getByRole('complementary', { name: 'Outline' });
  await expect(panel).toBeVisible();
  const before = (await panel.boundingBox())?.width ?? 0;
  await page.getByRole('separator', { name: 'Resize outline' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(before);
  await page.getByRole('button', { name: 'Close outline' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('toggle-outline')).toBeFocused();
  await page.getByTestId('toggle-outline').click();
  await expect(panel).toBeVisible();
});

test('axe: panels, toolbar and canvas chrome', async ({ page }) => {
  await openPanels(page);
  expect(await axeViolations(page)).toEqual([]);
  await page.emulateMedia({ colorScheme: 'dark' });
  // Let the colour transitions finish before measuring contrast.
  await transitionsDone(page);
  expect(await axeViolations(page)).toEqual([]);
});
