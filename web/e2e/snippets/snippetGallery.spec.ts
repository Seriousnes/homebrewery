// The Insert snippet gallery (/dev/snippets, 5ePHB): the Insert button opens a dialog that
// previews the active snippet with the theme, rendered by the insertion pipeline itself, so what
// is inserted is what the preview showed (random generators included).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openSnippets, stubNetwork, waitSettled } from './helpers';

const trigger = (page: Page) => page.getByTestId('insert-menu');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Insert snippet' });
const search = (page: Page) => dialog(page).getByRole('combobox', { name: 'Search snippets' });
const preview = (page: Page) => page.getByTestId('insert-menu-dialog-preview');
const view = (page: Page) => page.getByTestId('insert-menu-dialog-preview-view');
/** The editor's pages (the preview's div.pages has no ProseMirror class). */
const editorPages = (page: Page) => page.locator('.hb-canvas .ProseMirror > .page');

async function showPreview(page: Page, query: string, name: string): Promise<void> {
  await search(page).fill(query);
  // The snippet's own name (a native snippet's accessible name goes on with its hint).
  const option = dialog(page).getByRole('option').filter({ has: page.getByText(name, { exact: true }) });
  await option.hover();
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page)).toHaveAttribute('data-state', 'ready');
  await expect(view(page).locator('[data-measured="true"]')).toHaveCount(1);
}

test.describe('Insert snippet gallery', () => {
  test.beforeEach(async ({ page }) => {
    await stubNetwork(page);
    await openSnippets(page);
  });

  test('previews the active snippet with the theme; the inserted snippet is the one previewed', async ({ page }) => {
    await editorPages(page).first().click();
    await trigger(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(search(page)).toBeFocused();
    await showPreview(page, 'monster stat block', 'Monster Stat Block');
    await expect(view(page)).toHaveAttribute('data-fit', 'content');
    const block = view(page).locator('.hb-canvas > .pages > .page > .columnWrapper > div.block.monster');
    await expect(block).toHaveCount(1);
    // Styled by the theme (the frame's parchment), as in the editor: compared after insertion.
    const look = (el: Element) => ({ text: (el as HTMLElement).innerText, font: getComputedStyle(el.querySelector('h2')!).fontFamily, bg: getComputedStyle(el).backgroundImage });
    const previewed = await block.evaluate(look);
    expect(previewed.bg).not.toBe('none');
    // Scaled down to fit, never up.
    const scale = Number(await view(page).getAttribute('data-scale'));
    expect(scale).toBeGreaterThan(0.3);
    expect(scale).toBeLessThanOrEqual(1);

    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('insert-menu-status')).toHaveText('Monster Stat Block inserted.');
    const inserted = editorPages(page).locator('div.block.monster');
    await expect(inserted).toHaveCount(1);
    // The generator rolls random stats: the insertion used the previewed roll, and looks the same.
    expect(await inserted.evaluate(look)).toEqual(previewed);
  });

  test('a page snippet previews its whole page; a native snippet previews the current page with the change', async ({ page }) => {
    await page.evaluate(() => {
      window.__hbSnippets!.reset({
        type: 'doc',
        content: [{ type: 'page', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Wandering Inn' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }] }],
      });
    });
    await waitSettled(page);
    await editorPages(page).getByText('Text', { exact: true }).click();
    await trigger(page).click();

    await showPreview(page, 'front cover', 'Front Cover Page');
    await expect(view(page)).toHaveAttribute('data-fit', 'page');
    await expect(view(page).locator('.page > .frontCover')).toHaveCount(1);
    await expect(preview(page)).toContainText('Inserts 1 page after this section.');

    await showPreview(page, 'footer from h1', 'Footer from H1');
    await expect(view(page).locator('.page > .footnote')).toHaveText('The Wandering Inn');
    await expect(view(page).locator('.page .columnWrapper')).toContainText('Text');
    // Only previewed: the brew has no footer yet.
    await expect(editorPages(page).locator('.footnote')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test('the preview adds no second editor root, page ids or Tab stops', async ({ page }) => {
    await trigger(page).click();
    await showPreview(page, 'table of contents', 'Table of Contents');
    await expect(page.locator('.ProseMirror')).toHaveCount(1);
    await expect(page.locator('#p1')).toHaveCount(1);
    await expect(view(page).locator('[id]')).toHaveCount(0);
    await expect(view(page).locator('a[href]:not([tabindex="-1"])')).toHaveCount(0);
  });

  test('has no serious accessibility violations with a preview shown', async ({ page }) => {
    await trigger(page).click();
    await showPreview(page, 'spell', 'Spell');
    const results = await new AxeBuilder({ page }).include('[data-testid="insert-menu-dialog"]').analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
  });
});
