// The editor's own right-click menu (T4, web/src/editor/ui/contextMenu): opened by a right-click
// (the caret moves to the click, a selection it lands in is kept), Shift+F10 or the ContextMenu key
// (at the caret); Shift+right-click and the read-only share page keep the browser's menu. Items per
// context (text, table, theme block), one undo step per action, the focus back in the editor.
import type { Editor } from '@tiptap/core';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { richDoc, TEXTS } from '../a11y/docs';
import { editorRoot, LOAD_TIMEOUT, openEditor, waitForEditor } from '../a11y/helpers';

type Win = Window & { __hbEditorApp: { editor: Editor; settled(): boolean }; __hbContextMenus: boolean[] };

const menu = (page: Page): Locator => page.getByTestId('editor-context-menu');
const submenu = (page: Page, id: string): Locator => page.getByTestId(`editor-context-menu-${id}`);
const item = (list: Locator, id: string): Locator => list.locator(`[data-menu-item="${id}"]`);

/** Records whether each contextmenu event reached the window with its default (the browser's menu) prevented. */
async function recordContextMenus(page: Page) {
  await page.evaluate(() => {
    (window as unknown as Win).__hbContextMenus = [];
    window.addEventListener('contextmenu', (event) => (window as unknown as Win).__hbContextMenus.push(event.defaultPrevented));
  });
}

async function open(page: Page) {
  const opened = await openEditor(page, { doc: richDoc });
  await recordContextMenus(page);
  return opened;
}

const contextMenus = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbContextMenus);

/** Document position `offset` characters into the first occurrence of `text`. */
function posOf(page: Page, text: string, offset = 0) {
  return page.evaluate(
    ([t, o]) => {
      const { doc } = (window as unknown as Win).__hbEditorApp.editor.state;
      let pos = -1;
      doc.descendants((node, at) => {
        if (pos < 0 && node.isText && node.text!.includes(t)) pos = at + node.text!.indexOf(t) + o;
        return pos < 0;
      });
      if (pos < 0) throw new Error(`no text "${t}"`);
      return pos;
    },
    [text, offset] as const,
  );
}

/** Right-clicks the text `text`, `offset` characters in (at that caret position on screen). */
async function rightClickText(page: Page, text: string, offset = 1, shift = false) {
  const pos = await posOf(page, text, offset);
  // Into view first (and scrolled to rest): a click outside the viewport reaches nothing.
  await editorRoot(page).getByText(text).first().scrollIntoViewIfNeeded();
  const point = await page.evaluate((p) => {
    const c = (window as unknown as Win).__hbEditorApp.editor.view.coordsAtPos(p, 1);
    return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
  }, pos);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y, { button: 'right' });
  if (shift) await page.keyboard.up('Shift');
  return { pos, ...point };
}

/** The selection: positions, text and type ('text', 'node' …). */
function selection(page: Page) {
  return page.evaluate(() => {
    const { state } = (window as unknown as Win).__hbEditorApp.editor;
    const { from, to } = state.selection;
    return { from, to, text: state.doc.textBetween(from, to, '\n'), type: (state.selection.toJSON() as { type: string }).type };
  });
}

async function selectText(page: Page, text: string) {
  const from = await posOf(page, text);
  await page.evaluate(
    ([f, t]) => {
      const editor = (window as unknown as Win).__hbEditorApp.editor;
      editor.view.focus();
      editor.commands.setTextSelection({ from: f, to: t });
    },
    [from, from + text.length] as const,
  );
}

const editorFocused = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbEditorApp.editor.view.hasFocus());
const docJson = (page: Page) => page.evaluate(() => JSON.stringify((window as unknown as Win).__hbEditorApp.editor.getJSON()));
const settle = (page: Page) => page.waitForFunction(() => (window as unknown as Win).__hbEditorApp.settled(), undefined, LOAD_TIMEOUT);

test.describe('right-click', () => {
  test('opens the menu at the pointer instead of the browser menu; the caret moves to the click; Escape returns to the editor', { tag: '@smoke' }, async ({ page }) => {
    await open(page);
    await selectText(page, TEXTS.title);
    const click = await rightClickText(page, 'speak of', 3);
    await expect(menu(page)).toBeVisible();
    expect(await contextMenus(page)).toEqual([true]);
    // Top-left at the pointer (there is room below and to the right).
    const at = (await menu(page).boundingBox())!;
    expect(Math.abs(at.x - click.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(at.y - click.y)).toBeLessThanOrEqual(1);
    await expect(menu(page)).toHaveAttribute('aria-label', 'Editing');
    await expect(menu(page)).toContainText('Shift+right-click');
    expect(await selection(page)).toMatchObject({ from: click.pos, to: click.pos });
    // Cut and Copy need a selection (disabled, skipped): the first enabled item, Paste, has the focus.
    await expect(item(menu(page), 'cut')).toHaveAttribute('aria-disabled', 'true');
    await expect(item(menu(page), 'copy')).toHaveAttribute('aria-disabled', 'true');
    await expect(item(menu(page), 'paste')).not.toHaveAttribute('aria-disabled');
    await expect(item(menu(page), 'paste')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    expect(await editorFocused(page)).toBe(true);
    expect(await selection(page)).toMatchObject({ from: click.pos, to: click.pos });
  });

  test('inside the selection keeps it; Format ▸ Bold is one undo step and the focus goes back', async ({ page }) => {
    await open(page);
    await selectText(page, 'never in the same place');
    const before = await docJson(page);
    await rightClickText(page, 'never in the same place', 6);
    await expect(menu(page)).toBeVisible();
    expect((await selection(page)).text).toBe('never in the same place');
    await expect(item(menu(page), 'cut')).not.toHaveAttribute('aria-disabled');
    await item(menu(page), 'format').focus();
    await page.keyboard.press('ArrowRight');
    await expect(item(submenu(page, 'format'), 'mark-bold')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toHaveCount(0);
    expect(await editorFocused(page)).toBe(true);
    await expect(editorRoot(page).locator('strong', { hasText: 'never in the same place' })).toHaveCount(1);
    await page.keyboard.press('ControlOrMeta+z');
    await settle(page);
    expect(await docJson(page)).toBe(before);
  });

  test('Shift+right-click keeps the browser menu', async ({ page }) => {
    await open(page);
    await rightClickText(page, 'speak of', 3, true);
    expect(await contextMenus(page)).toEqual([false]);
    await expect(menu(page)).toHaveCount(0);
  });

  test('the read-only share page keeps the browser menu', async ({ page }) => {
    const { brew } = await open(page);
    await page.goto(`/share/${brew.shareId}`, { waitUntil: 'domcontentloaded' });
    await waitForEditor(page);
    await recordContextMenus(page);
    await rightClickText(page, 'speak of', 3);
    expect(await contextMenus(page)).toEqual([false]);
    await expect(menu(page)).toHaveCount(0);
  });
});

test.describe('context', () => {
  test('in a table: the Table submenu adds a row (one undo step)', async ({ page }) => {
    await open(page);
    await rightClickText(page, TEXTS.cell, 1);
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('group', { name: 'Table' })).toHaveCount(1); // the block group
    const table = item(menu(page), 'table');
    await expect(table).not.toHaveAttribute('aria-disabled');
    await table.hover();
    await expect(submenu(page, 'table')).toBeVisible();
    await expect(table).toHaveAttribute('aria-expanded', 'true');
    const rows = editorRoot(page).locator('table tr');
    await expect(rows).toHaveCount(2);
    await item(submenu(page, 'table'), 'row-after').click();
    await expect(menu(page)).toHaveCount(0);
    await expect(rows).toHaveCount(3);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(rows).toHaveCount(2);
  });

  test('outside a table the Table submenu is disabled', async ({ page }) => {
    await open(page);
    await rightClickText(page, 'speak of', 3);
    await expect(item(menu(page), 'table')).toHaveAttribute('aria-disabled', 'true');
  });

  test('on a theme block: the block group is the theme block; Delete removes it whole, Ctrl+Z brings it back', async ({ page }) => {
    await open(page);
    const before = await docJson(page);
    await rightClickText(page, TEXTS.note, 4);
    await expect(menu(page).getByRole('group', { name: 'Theme block' })).toHaveCount(1);
    await expect(item(menu(page), 'block-unwrap')).not.toHaveAttribute('aria-disabled');
    await item(menu(page), 'block-delete').click();
    await expect(editorRoot(page).locator('.block.note')).toHaveCount(0);
    expect(await editorFocused(page)).toBe(true);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editorRoot(page).locator('.block.note')).toHaveCount(1);
    await settle(page);
    expect(await docJson(page)).toBe(before);
  });

  test('Properties… opens the inspector on the theme block', async ({ page }) => {
    await open(page);
    await rightClickText(page, TEXTS.note, 4);
    await item(menu(page), 'block-properties').click();
    await expect(page.getByTestId('inspector-panel')).toBeVisible();
    expect((await selection(page)).type).toBe('node');
    await expect(page.getByTestId('inspector')).toContainText('Theme block');
  });
});

test.describe('keyboard', () => {
  for (const key of ['Shift+F10', 'ContextMenu'] as const) {
    test(`${key} opens the menu at the caret without moving it; Escape returns to the editor`, async ({ page }) => {
      await open(page);
      await selectText(page, 'same place');
      const before = await selection(page);
      await page.keyboard.press(key);
      await expect(menu(page)).toBeVisible();
      await expect(item(menu(page), 'cut')).toBeFocused();
      const caret = await page.evaluate((to) => (window as unknown as Win).__hbEditorApp.editor.view.coordsAtPos(to), before.to);
      const at = (await menu(page).boundingBox())!;
      expect(Math.abs(at.x - caret.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(at.y - caret.bottom)).toBeLessThanOrEqual(2);
      expect(await selection(page)).toEqual(before);
      await page.keyboard.press('Escape');
      await expect(menu(page)).toHaveCount(0);
      expect(await editorFocused(page)).toBe(true);
      expect(await selection(page)).toEqual(before);
    });
  }

  test('Insert ▸ Page break from the keyboard adds a page (one undo step)', async ({ page }) => {
    await open(page);
    await selectText(page, 'Travellers');
    await page.keyboard.press('ArrowLeft');
    const pages = editorRoot(page).locator(':scope > .page');
    const count = await pages.count();
    await page.keyboard.press('Shift+F10');
    await item(menu(page), 'insert').focus();
    await page.keyboard.press('ArrowRight');
    await expect(item(submenu(page, 'insert'), 'insert-snippet')).toBeFocused();
    await item(submenu(page, 'insert'), 'insert-pageBreak').focus();
    await page.keyboard.press('Enter');
    await expect(pages).toHaveCount(count + 1);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(pages).toHaveCount(count);
  });

  test('ArrowLeft and Escape leave a submenu for its item', async ({ page }) => {
    await open(page);
    await selectText(page, 'Travellers');
    await page.keyboard.press('Shift+F10');
    const insert = item(menu(page), 'insert');
    await insert.focus();
    await page.keyboard.press('ArrowRight');
    await expect(submenu(page, 'insert')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(submenu(page, 'insert')).toHaveCount(0);
    await expect(insert).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(submenu(page, 'insert')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(submenu(page, 'insert')).toHaveCount(0);
    await expect(insert).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    expect(await editorFocused(page)).toBe(true);
  });
});

test.describe('clipboard', () => {
  test('Copy then Paste keeps the editor’s own formatting (span classes), as Ctrl+C / Ctrl+V; Paste as plain text drops it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    const spans = editorRoot(page).locator('span.inspector-demo');
    await expect(spans).toHaveCount(1);
    await selectText(page, 'set apart');
    await rightClickText(page, 'set apart', 3);
    await item(menu(page), 'copy').click();
    await expect(menu(page)).toHaveCount(0);
    await rightClickText(page, TEXTS.intro, 0);
    await item(menu(page), 'paste').click();
    await expect(spans).toHaveCount(2);
    await rightClickText(page, TEXTS.last, 0);
    await item(menu(page), 'pastePlain').click();
    await expect(editorRoot(page).locator('p', { hasText: TEXTS.last })).toContainText(`set apart${TEXTS.last}`);
    await expect(spans).toHaveCount(2);
  });

  test('a clipboard the browser won’t read: a toast explains the shortcut', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const refuse = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: refuse, readText: refuse, write: refuse } });
    });
    await rightClickText(page, 'speak of', 3);
    await item(menu(page), 'paste').click();
    // The visible toast list (the live region repeats the text for screen readers).
    const toasts = page.locator('[data-hb-portal-root] section');
    await expect(toasts.getByText('The browser didn’t allow reading the clipboard')).toBeVisible();
    await expect(toasts.getByText(/Press (Ctrl\+V|⌘V) to paste instead\./)).toBeVisible();
  });
});
