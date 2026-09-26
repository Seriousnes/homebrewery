// P5.4: the live table of contents (/dev/snippets?doc=toc, 5ePHB). "Done when": page numbers
// update after pagination settles; --TOC: exclude is respected. Also: upstream's markup (so the
// dot leaders apply), skip/reset counting, links move to the heading, and insertion from the
// Insert menu.
import { expect, test, type Page } from '@playwright/test';
import { openSnippets, stubNetwork, waitSettled } from './helpers';

const tocRows = (page: Page) => page.evaluate(() => window.__hbSnippets!.tocRows()[0] ?? []);
const rowSummary = async (page: Page) => (await tocRows(page)).map(([text, number]) => `${text} ${number}`);

/** Adds `n` filler paragraphs at the end of page `index` (one transaction, one undo step). */
async function growPage(page: Page, index: number, n: number): Promise<void> {
  await page.evaluate(
    ([i, count]) => {
      const editor = window.__hbSnippets!.editor as unknown as {
        state: { doc: { child(i: number): { nodeSize: number } } };
        commands: { insertContentAt(pos: number, content: unknown): boolean };
      };
      let pos = 0;
      for (let k = 0; k <= i; k++) pos += editor.state.doc.child(k).nodeSize;
      const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'Filler text that makes the page overflow onto a new one. '.repeat(6) }] };
      editor.commands.insertContentAt(pos - 1, Array.from({ length: count }, () => paragraph));
    },
    [index, n] as const,
  );
}

test.describe('live table of contents', () => {
  test.beforeEach(async ({ page }) => {
    await stubNetwork(page);
  });

  test("lists the headings with page numbers and the theme's exclusions", async ({ page }) => {
    await openSnippets(page, { doc: 'toc' });
    // Chapter One's stat block heading (.monster: --TOC exclude), the h4 (Blank: h4 exclude) and
    // the skipCounting page's heading are left out; the Appendix page restarts at 1.
    expect(await rowSummary(page)).toEqual(['Introduction 1', 'Chapter One 2', 'The Inn 2', 'Chapter Two 3', 'Deep Section 3', 'Appendix 1']);
    const toc = page.locator('.hb-canvas div.block.toc');
    await expect(toc).toHaveClass(/\bwide\b/);
    await expect(toc).toHaveAttribute('contenteditable', 'false');
    // Upstream's markup: ul › li › h3/h4 › a › span + span, and the theme's dot leaders.
    await expect(toc.locator(':scope > ul > li > h3 > a > span.inline-block + span.inline-block')).toHaveCount(4);
    await expect(toc.locator(':scope > ul > li > ul > li > h4 > a > span + span')).toHaveCount(2);
    const leader = await toc.locator('li > h4 > a > span:first-child').first().evaluate((span) => getComputedStyle(span, '::after').borderBottomStyle);
    expect(leader).toBe('dotted');
    // Links point at the heading ids.
    expect((await tocRows(page)).map((r) => r[2])).toEqual(['#introduction', '#chapter-one', '#the-inn', '#chapter-two', '#deep-section', '#appendix']);
  });

  test('page numbers follow pagination once it settles; undo brings them back', { tag: '@smoke' }, async ({ page }) => {
    await openSnippets(page, { doc: 'toc' });
    expect(await rowSummary(page)).toEqual(['Introduction 1', 'Chapter One 2', 'The Inn 2', 'Chapter Two 3', 'Deep Section 3', 'Appendix 1']);
    // Page 1 overflows onto auto pages: every later page number moves by as many.
    await growPage(page, 0, 18);
    await waitSettled(page);
    const added = (await page.locator('.hb-canvas .ProseMirror > .page').count()) - 5;
    expect(added).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => rowSummary(page))
      .toEqual(['Introduction 1', `Chapter One ${2 + added}`, `The Inn ${2 + added}`, `Chapter Two ${3 + added}`, `Deep Section ${3 + added}`, 'Appendix 1']);
    // The toc itself says so: its entries are the pages the headings are on now.
    const onPage = await page
      .locator('.hb-canvas .ProseMirror > .page')
      .evaluateAll((pages) => pages.findIndex((p) => [...p.querySelectorAll(':scope > .columnWrapper > h1')].some((h) => h.textContent === 'Chapter Two')));
    expect(onPage).toBe(3 + added); // its page number is one less: the Interlude page doesn't count
    await page.locator('.hb-canvas .ProseMirror').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await waitSettled(page);
    await expect.poll(() => rowSummary(page)).toEqual(['Introduction 1', 'Chapter One 2', 'The Inn 2', 'Chapter Two 3', 'Deep Section 3', 'Appendix 1']);
  });

  test('--TOC from the brew CSS: exclude and include', async ({ page }) => {
    await openSnippets(page, { doc: 'toc' });
    const applied = await page.evaluate(() => window.__hbSnippets!.cssApplied());
    await page.evaluate(() => window.__hbSnippets!.setUserCss('.page h2 { --TOC: exclude; } .page h4 { --TOC: include; }'));
    await expect.poll(() => page.evaluate(() => window.__hbSnippets!.cssApplied())).toBeGreaterThan(applied);
    await waitSettled(page);
    await expect.poll(() => rowSummary(page)).toEqual(['Introduction 1', 'Chapter One 2', 'Minor Detail 2', 'Chapter Two 3', 'Deep Section 3', 'Appendix 1']);
  });

  test('a link moves the cursor to its heading', async ({ page }) => {
    await openSnippets(page, { doc: 'toc' });
    await page.locator('.hb-canvas div.block.toc a', { hasText: 'Chapter Two' }).click();
    const heading = page.locator('.hb-canvas .page h1', { hasText: 'Chapter Two' });
    await expect(heading).toBeInViewport();
    expect(await page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('h1')?.textContent)).toBe('Chapter Two');
    await expect(page.locator('.hb-canvas .ProseMirror')).toBeFocused();
  });

  test('the Insert menu adds a live toc (one undo step)', async ({ page }) => {
    await openSnippets(page, { doc: 'blocks' });
    await page.locator('.hb-canvas .page').getByText('Bestiary', { exact: true }).click();
    await page.keyboard.press('Home');
    await page.getByTestId('insert-menu').click();
    await page.getByRole('combobox', { name: 'Search snippets' }).fill('table of contents');
    await expect(page.getByRole('option', { name: /^Table of Contents/ })).toHaveCount(1);
    await page.keyboard.press('Enter');
    const toc = page.locator('.hb-canvas div.block.toc');
    await expect(toc).toHaveCount(1);
    await waitSettled(page);
    // Bestiary (h1) is listed; Goblin (.monster) and A Note (h5) are not.
    await expect.poll(() => rowSummary(page)).toEqual(['Bestiary 1']);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(toc).toHaveCount(0);
  });
});
