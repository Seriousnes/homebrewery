// P5.1: the Insert menu (/dev/snippets, 5ePHB). Grouped like upstream's snippet bar, searchable,
// keyboard operable (combobox + listbox), one undo step per insertion, page snippets as new
// manual pages, native footer, and no serious axe issues.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openSnippets, stubNetwork, waitSettled } from './helpers';

const trigger = (page: Page) => page.getByTestId('insert-menu');
const search = (page: Page) => page.getByRole('combobox', { name: 'Search snippets' });
const listbox = (page: Page) => page.getByRole('listbox', { name: 'Snippets' });
const editorRoot = (page: Page) => page.locator('.hb-canvas .ProseMirror');

const pageJson = (page: Page) =>
  page.evaluate(() =>
    (window.__hbSnippets!.editor.getJSON().content ?? []).map((p) => ({ attrs: p.attrs ?? {}, types: (p.content ?? []).map((b) => b.type) })),
  );

test.describe('Insert menu', () => {
  test.beforeEach(async ({ page }) => {
    await stubNetwork(page);
    await openSnippets(page);
  });

  test('lists the groups of the theme chain and filters by search', async ({ page }) => {
    await trigger(page).click();
    await expect(search(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    for (const group of ['Text Editor', 'License', 'Images', 'Tables', 'Fonts', 'PHB']) {
      await expect(listbox(page).getByRole('group', { name: group, exact: true })).toBeVisible();
    }
    await expect(listbox(page).getByRole('group', { name: 'License › Creative Commons › Text Declarations' })).toHaveCount(1);
    // Style-view groups belong to the Style drawer.
    await expect(listbox(page).getByRole('group', { name: 'Style Editor' })).toHaveCount(0);
    await expect(listbox(page).getByRole('group', { name: 'Print' })).toHaveCount(0);

    await search(page).fill('stat block');
    await expect(listbox(page).getByRole('option')).toHaveText(['Monster Stat Block (unframed)', 'Monster Stat Block', 'Wide Monster Stat Block']);
    await search(page).fill('zzz');
    await expect(listbox(page).getByRole('option')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'No snippets match.' })).toBeVisible();
  });

  test('keyboard: arrows move the active option, Enter inserts, focus returns to the editor', async ({ page }) => {
    await editorRoot(page).click();
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(search(page)).toBeFocused();
    await page.keyboard.type('stat block');
    const options = listbox(page).getByRole('option');
    await expect(options).toHaveCount(3);
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    const firstId = await options.first().getAttribute('id');
    await expect(search(page)).toHaveAttribute('aria-activedescendant', firstId!);
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp'); // wraps to the last
    await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ControlOrMeta+Home');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveText('Monster Stat Block');
    await page.keyboard.press('Enter');
    await expect(listbox(page)).toHaveCount(0);
    await expect(page.getByTestId('insert-menu-status')).toHaveText('Monster Stat Block inserted.');
    await expect(editorRoot(page)).toBeFocused();
    expect((await pageJson(page))[0]!.types).toEqual(['themeBlock', 'paragraph']);
    // The cursor waits on the line after the block: typing goes there.
    await page.keyboard.type('After');
    await expect(page.locator('.hb-canvas .page .columnWrapper > p', { hasText: 'After' })).toHaveCount(1);
  });

  test('user snippets are listed under Brew Snippets and insert through the same pipeline', async ({ page }) => {
    await editorRoot(page).click();
    await trigger(page).click();
    await expect(listbox(page).getByRole('group', { name: 'Brew Snippets › Snippets Dev' })).toBeVisible();
    await search(page).fill('tavern');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('insert-menu-status')).toHaveText('Tavern Note inserted.');
    await expect(page.locator('.hb-canvas .page div.block.note h5')).toHaveText('The Tavern');
  });

  test('Escape closes the menu and returns focus to the button', async ({ page }) => {
    await trigger(page).click();
    await expect(search(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(listbox(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('one undo step per insertion; pagination adds no history', { tag: '@smoke' }, async ({ page }) => {
    await editorRoot(page).click();
    const insert = async (query: string, name: string, status: string | RegExp) => {
      await trigger(page).click();
      await search(page).fill(query);
      await listbox(page).getByRole('option', { name, exact: true }).click();
      await expect(page.getByTestId('insert-menu-status')).toHaveText(status);
      await waitSettled(page);
    };
    await insert('spell', 'Spell', 'Spell inserted.');
    // A long multi-page snippet: new manual pages, and pagination adds auto pages after them.
    await insert('gnu general', 'GNU General Public License v3', /^GNU General Public License v3: inserted \d+ pages\.$/);
    const pages = await page.locator('.hb-canvas .ProseMirror > .page').count();
    expect(pages).toBeGreaterThan(4);
    await page.keyboard.press('ControlOrMeta+z');
    await waitSettled(page);
    expect((await pageJson(page)).length).toBe(1);
    await expect(page.locator('.hb-canvas .page h4').first()).toBeVisible(); // the spell is still there
    await page.keyboard.press('ControlOrMeta+z');
    await waitSettled(page);
    expect(await pageJson(page)).toEqual([{ attrs: expect.objectContaining({ kind: 'manual' }) as unknown, types: ['paragraph'] }]);
    expect(await page.evaluate(() => (window.__hbSnippets!.editor as unknown as { can(): { undo(): boolean } }).can().undo())).toBe(false);
  });

  test('page snippets become manual pages after the current section', async ({ page }) => {
    await page.evaluate(() => {
      const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
      window.__hbSnippets!.reset({ type: 'doc', content: [{ type: 'page', content: [para('First section')] }, { type: 'page', content: [para('Second section')] }] });
    });
    await waitSettled(page);
    await page.locator('.hb-canvas .page').getByText('First section').click();
    await trigger(page).click();
    await search(page).fill('front cover');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('insert-menu-status')).toHaveText('Front Cover Page: inserted 1 page.');
    await waitSettled(page);
    const pages = await pageJson(page);
    expect(pages.map((p) => p.attrs.kind)).toEqual(['manual', 'manual', 'manual']);
    expect(pages[1]!.attrs.markers).toEqual(['frontCover']);
    await expect(page.locator('.hb-canvas .ProseMirror > .page').nth(1)).toHaveClass(/page/);
    await expect(page.locator('.hb-canvas .ProseMirror > .page').nth(2)).toContainText('Second section');
    await page.keyboard.press('ControlOrMeta+z');
    await waitSettled(page);
    expect((await pageJson(page)).length).toBe(2);
  });

  test('Footer from H1 sets the section footer natively', async ({ page }) => {
    await page.evaluate(() => {
      window.__hbSnippets!.reset({
        type: 'doc',
        content: [{ type: 'page', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Wandering Inn' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }] }],
      });
    });
    await waitSettled(page);
    await page.locator('.hb-canvas .page').getByText('Text', { exact: true }).click();
    await trigger(page).click();
    await search(page).fill('footer from h1');
    await expect(listbox(page).getByRole('option')).toHaveCount(1);
    await expect(listbox(page).getByRole('option')).toContainText('Sets the section footer');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('insert-menu-status')).toHaveText('Footer from H1 applied.');
    expect((await pageJson(page))[0]!.attrs.footer).toBe('The Wandering Inn');
    await expect(page.locator('.hb-canvas .page span.footnote')).toHaveText('The Wandering Inn');
  });

  test('has no serious accessibility violations with the menu open', async ({ page }) => {
    await trigger(page).click();
    await search(page).fill('license');
    await expect(listbox(page).getByRole('option').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).setLegacyMode(true).include('[data-testid="insert-menu-dialog"]').include('[data-testid="insert-menu"]').analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
  });
});
