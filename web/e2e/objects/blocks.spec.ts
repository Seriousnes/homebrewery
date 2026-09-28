// P5.7 on /dev/objects: definition lists, spacers, column breaks and horizontal rules are
// inserted and removed from the BlockMenu (one undo step each); definition lists have Enter keys.
// Also the images of plan §6.6 (natural size, aspect ratio) and the fidelity rules in canvas.css
// for empty definition terms and float-only paragraphs.
// E2E_PORT=5328 pnpm exec playwright test e2e/objects/blocks.spec.ts
import { expect, type Page } from '@playwright/test';
import { test, blockMenu, caretAfter, openObjects, settle, undo } from './helpers';

const flow = (page: Page) => page.locator('.hb-canvas .pages > .page').first().locator('> .columnWrapper');

const cases = [
  { label: 'Definition list', selector: ':scope > dl', remove: 'Remove definition list (keep its text)' },
  { label: 'Spacer', selector: ':scope > div.blank', remove: 'Remove spacer' },
  { label: 'Column break', selector: ':scope > div.columnSplit', remove: 'Remove column break' },
  { label: 'Horizontal rule', selector: ':scope > hr', remove: 'Remove horizontal rule' },
] as const;

for (const c of cases) {
  test(`${c.label}: inserted and removed from the block menu, one undo step each`, async ({ page }) => {
    await openObjects(page, { doc: 'blank' });
    const block = flow(page).locator(c.selector);
    await expect(block).toHaveCount(0);
    await caretAfter(page, 'Hello there, adventurer.');
    await blockMenu(page, c.label);
    await expect(block).toHaveCount(1);
    await expect(page.locator('.hb-canvas .ProseMirror')).toBeFocused();
    if (c.label === 'Definition list') {
      // The paragraph became the term; the caret is at its end. Enter starts the description.
      await expect(block.locator('dt')).toHaveText('Hello there, adventurer.');
      await page.keyboard.press('Enter');
      await page.keyboard.type('A greeting.');
      await expect(block.locator('dd')).toHaveText('A greeting.');
    }
    await settle(page);
    // The caret is next to (or in) the block: the Remove item is offered.
    await blockMenu(page, c.remove);
    await expect(block).toHaveCount(0);
    if (c.label === 'Definition list') {
      await expect(flow(page).locator(':scope > p', { hasText: 'A greeting.' })).toHaveCount(1); // text kept
    }
    await undo(page);
    await expect(block).toHaveCount(1);
  });
}

test('an empty definition list replaces an empty paragraph; Enter in an empty item leaves the list', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  await caretAfter(page, 'A second paragraph.');
  await page.keyboard.press('Enter');
  await blockMenu(page, 'Definition list');
  const dl = flow(page).locator(':scope > dl').last();
  await page.keyboard.type('Speed');
  await page.keyboard.press('Enter');
  await page.keyboard.type('30 ft.');
  await page.keyboard.press('Enter'); // a new term
  await page.keyboard.press('Enter'); // empty: out of the list
  await page.keyboard.type('After');
  await expect(dl.locator('dt')).toHaveText(['Speed']);
  await expect(dl.locator('dd')).toHaveText(['30 ft.']);
  await expect(flow(page).locator(':scope > p').last()).toHaveText('After');
});

test('inline images store their natural size and keep their aspect ratio', async ({ page }) => {
  await openObjects(page, { doc: 'images' });
  const sizes = () =>
    page.evaluate(() => {
      type J = { type: string; attrs?: { width?: number | null; height?: number | null }; content?: J[] };
      const out: unknown[] = [];
      const walk = (n: J) => {
        if (n.type === 'image') out.push([n.attrs?.width ?? null, n.attrs?.height ?? null]);
        n.content?.forEach(walk);
      };
      walk(window.__hbObjects!.doc() as J);
      return out;
    });
  await expect.poll(sizes).toEqual([
    [200, 100],
    [120, 160],
    [200, 100],
  ]);
  const imgs = page.locator('.hb-canvas .page .columnWrapper img:not(.ProseMirror-separator)');
  await expect(imgs.nth(0)).toHaveAttribute('data-hb-natural', '');
  const boxes = await imgs.evaluateAll((els) => els.map((el) => [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)]));
  expect(boxes[0]).toEqual([200, 100]); // no author size: the natural size
  expect(boxes[1]).toEqual([60, 80]); // width 60px: proportional height
  expect(boxes[2]).toEqual([100, 50]); // height 50px only: proportional width
  // Recording sizes is not an undo step.
  expect(await undo(page)).toBe(false);
});

test('a paragraph that holds only a floated image takes no line (fidelity rule)', async ({ page }) => {
  await openObjects(page, { doc: 'images' });
  const floatPara = page.locator('.hb-canvas .page .columnWrapper > p').nth(1);
  await expect(floatPara.locator('img[style*="float"]')).toHaveCount(1);
  const height = await floatPara.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBe(0);
});

test('an empty definition term takes no line (fidelity rule)', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  // `::Definition` upstream: a list whose term is empty.
  const heights = await page.evaluate(() => {
    const editor = window.__hbObjects!.editor as unknown as {
      commands: { insertContentAt(pos: number, content: unknown): boolean };
      state: { doc: { content: { size: number } } };
    };
    editor.commands.insertContentAt(2, {
      type: 'definitionList',
      content: [{ type: 'definitionTerm' }, { type: 'definitionDesc', content: [{ type: 'text', text: 'Only a definition' }] }],
    });
    const dl = document.querySelector('.hb-canvas .page .columnWrapper > dl')!;
    const dd = dl.querySelector('dd')!;
    return { dl: dl.getBoundingClientRect().height, dd: dd.getBoundingClientRect().height, br: getComputedStyle(dl.querySelector('dt > br')!).display };
  });
  expect(heights.br).toBe('none');
  // One line (plus the generated break after the dd), not an extra blank line for the term.
  expect(heights.dl).toBeLessThan(heights.dd * 2.5);
});
