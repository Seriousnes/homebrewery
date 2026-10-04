// The Columns menu (web/src/editor/ui/columns): the toolbar's Layout group and the context menu's
// Columns submenu switch the section at the cursor, or every page, between one and two columns
// (page.attrs.columns → .page.hb-cols-N). The canvas reflows, one undo step, and the setting
// survives a save and a reload. The menus' entries and commands: unit tests (columnsMenu.test.ts,
// columns.test.ts).
import AxeBuilder from '@axe-core/playwright';
import type { Editor } from '@tiptap/core';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { richDoc, TEXTS } from '../a11y/docs';
import { editorRoot, LOAD_TIMEOUT, openEditor, waitForEditor } from '../a11y/helpers';

type Win = Window & { __hbEditorApp: { editor: Editor; settled(): boolean } };

const pages = (page: Page): Locator => editorRoot(page).locator(':scope > .page');
const settle = (page: Page) => page.waitForFunction(() => (window as unknown as Win).__hbEditorApp.settled(), undefined, LOAD_TIMEOUT);
const editorFocused = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbEditorApp.editor.view.hasFocus());

/** Each page's computed column count (what the reader sees). */
const renderedColumns = (page: Page) =>
  pages(page).evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector(':scope > .columnWrapper')!).columnCount));

/** Puts the caret in `text` and focuses the editor. */
async function caretIn(page: Page, text: string) {
  await page.evaluate((t) => {
    const editor = (window as unknown as Win).__hbEditorApp.editor;
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (pos < 0 && node.isText && node.text!.includes(t)) pos = at + node.text!.indexOf(t) + 1;
      return pos < 0;
    });
    editor.view.focus();
    editor.commands.setTextSelection(pos);
  }, text);
}

test('the toolbar Columns menu switches the section at the cursor; one undo step; no axe violations', async ({ page }) => {
  await openEditor(page, { doc: richDoc });
  // richDoc: page 1 has two columns set; pages 2 and 3 are sections of their own on the theme's default (5ePHB: two).
  expect(await renderedColumns(page)).toEqual(['2', '2', '2']);
  await caretIn(page, TEXTS.last);
  await page.getByRole('button', { name: 'Columns: theme default' }).click();
  const menu = page.getByRole('menu', { name: 'Columns' });
  await expect(menu.getByRole('group', { name: 'This section (page 3)' })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Theme default (2 columns)' })).toHaveAttribute('aria-checked', 'true');
  const axe = await new AxeBuilder({ page }).setLegacyMode(true).include('[role="menu"]').analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  await menu.getByRole('menuitemradio', { name: '1 column' }).click();
  await expect(menu).toHaveCount(0);
  expect(await editorFocused(page)).toBe(true);
  await expect(pages(page).nth(2)).toHaveClass(/\bhb-cols-1\b/);
  expect(await renderedColumns(page)).toEqual(['2', '2', '1']);
  await expect(page.getByRole('button', { name: 'Columns: 1 column' })).toHaveText('1 column');

  await page.keyboard.press('ControlOrMeta+z');
  await settle(page);
  expect(await renderedColumns(page)).toEqual(['2', '2', '2']);
  await expect(page.getByRole('button', { name: 'Columns: theme default' })).toBeVisible();
});

test('the context menu sets one column on every page; the setting survives a save and a reload', async ({ page }) => {
  const { api, brew } = await openEditor(page, { doc: richDoc });
  await caretIn(page, TEXTS.intro);
  await page.keyboard.press('Shift+F10');
  const contextMenu = page.getByTestId('editor-context-menu');
  await expect(contextMenu).toBeVisible();
  await contextMenu.locator('[data-menu-item="columns"]').focus();
  await page.keyboard.press('ArrowRight');
  const submenu = page.getByTestId('editor-context-menu-columns');
  await expect(submenu.getByRole('menuitemradio', { name: '2 columns' })).toHaveAttribute('aria-checked', 'true');
  await submenu.getByRole('menuitem', { name: '1 column on every page' }).click();
  await expect(contextMenu).toHaveCount(0);
  await settle(page);
  expect(new Set(await renderedColumns(page))).toEqual(new Set(['1']));

  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => api.saves(brew.editId).length).toBeGreaterThan(0);
  const saved = api.brews.get(brew.editId)!.doc as { content: { attrs: { columns: unknown } }[] };
  expect(new Set(saved.content.map((p) => p.attrs.columns))).toEqual(new Set([1]));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect(new Set(await renderedColumns(page))).toEqual(new Set(['1']));
  await expect(pages(page).first()).toHaveClass(/\bhb-cols-1\b/);
});
