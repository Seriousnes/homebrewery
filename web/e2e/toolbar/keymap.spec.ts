// HbKeymap (plan §6.1, P3.4): every shortcut, in Chromium and Firefox, on the paginated canvas at
// /dev/toolbar. Each editing shortcut is one undo step (one Mod-Z restores the document exactly).
import { expect, test } from '@playwright/test';
import {
  blockOf,
  docJson,
  editorHasFocus,
  lastKey,
  markTypes,
  marksAt,
  openToolbar,
  pageCount,
  pagesRoot,
  pageTexts,
  pressUndoable,
  requests,
  select,
  settle,
  undoDepth,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await openToolbar(page);
});

test.describe('marks', () => {
  for (const [keys, mark] of [
    ['ControlOrMeta+b', 'bold'],
    ['ControlOrMeta+i', 'italic'],
    ['ControlOrMeta+u', 'underline'],
    ['ControlOrMeta+Shift+Equal', 'superscript'],
    ['ControlOrMeta+Equal', 'subscript'],
  ] as const) {
    test(`${keys} toggles ${mark}`, { tag: mark === 'bold' ? '@smoke' : [] }, async ({ page }) => {
      await select(page, 'pours cider');
      await pressUndoable(page, keys, async () => expect(await markTypes(page, 'pours cider')).toEqual([mark]));
      await page.keyboard.press(keys);
      expect(await markTypes(page, 'pours cider')).toEqual([mark]);
      expect((await lastKey(page))?.prevented).toBe(true); // no browser zoom, view-source, …
      await page.keyboard.press(keys);
      expect(await markTypes(page, 'pours cider')).toEqual([]);
    });
  }

  test('Mod-. inserts a non-breaking space', async ({ page }) => {
    await select(page, 'Guests may', 6);
    await pressUndoable(page, 'ControlOrMeta+Period', async () => {
      expect(await blockOf(page, 'Guests')).toMatchObject({ type: 'paragraph' });
      expect((await pageTexts(page))[0]).toContain('Guests  may');
    });
  });

  test('Shift-Mod-. widens and Shift-Mod-, narrows an inline spacer', async ({ page }) => {
    await select(page, 'Guests may', 6);
    const spacer = pagesRoot(page).locator('span.inline-block').first();
    await pressUndoable(page, 'ControlOrMeta+Shift+Period', async () => {
      await expect(spacer).toHaveAttribute('style', /width: 10%/);
    });
    await page.keyboard.press('ControlOrMeta+Shift+Period');
    await page.keyboard.press('ControlOrMeta+Shift+Period');
    await expect(spacer).toHaveAttribute('style', /width: 20%/);
    await pressUndoable(page, 'ControlOrMeta+Shift+Comma', async () => {
      await expect(spacer).toHaveAttribute('style', /width: 10%/);
    });
    await page.keyboard.press('ControlOrMeta+Shift+Comma');
    await page.keyboard.press('ControlOrMeta+Shift+Comma');
    await expect(pagesRoot(page).locator('span.inline-block')).toHaveCount(0);
  });

  test('Mod-/ does nothing (no comments)', async ({ page }) => {
    await select(page, 'pours cider');
    const before = await docJson(page);
    await page.keyboard.press('ControlOrMeta+Slash');
    await settle(page);
    expect(await docJson(page)).toEqual(before);
  });
});

test.describe('class picker and link dialog', () => {
  test('Mod-M applies a span with a theme class (one undo step), focus returns to the editor', async ({ page }) => {
    await select(page, 'pours cider');
    const before = await docJson(page);
    await page.keyboard.press('ControlOrMeta+m');
    const dialog = page.getByRole('dialog', { name: 'Style the selection with classes' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox', { name: 'Add a class' });
    await expect(input).toBeFocused();
    // The suggestions come from the theme's stylesheets.
    await input.fill('wid');
    await expect(dialog.getByRole('option', { name: /^wide/ })).toBeVisible();
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(dialog.getByRole('listitem').filter({ hasText: 'wide' })).toBeVisible();
    await input.press('Enter');
    await expect(dialog).toBeHidden();
    await expect.poll(() => editorHasFocus(page)).toBe(true);
    await expect(pagesRoot(page).locator('span.inline-block.wide')).toHaveText('pours cider');
    expect(await undoDepth(page)).toBe(1);
    await page.keyboard.press('ControlOrMeta+z');
    await settle(page);
    expect(await docJson(page)).toEqual(before);
  });

  test('Mod-M on a span edits it; Escape cancels', async ({ page }) => {
    await select(page, 'pours cider');
    await page.keyboard.press('ControlOrMeta+m');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').fill('big ');
    await dialog.getByRole('combobox').press('Enter');
    await expect(dialog).toBeHidden();
    await select(page, 'pours cider', 3);
    await page.keyboard.press('ControlOrMeta+m');
    await expect(page.getByRole('dialog', { name: 'Edit the span’s classes' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+m');
    await page.getByRole('button', { name: 'Remove span' }).click();
    expect(await markTypes(page, 'pours cider')).toEqual([]);
  });

  test('Shift-Mod-M wraps the paragraph in a theme block', async ({ page }) => {
    await select(page, 'Guests may', 2);
    const before = await docJson(page);
    await page.keyboard.press('ControlOrMeta+Shift+m');
    const dialog = page.getByRole('dialog', { name: 'Wrap in a theme block' });
    await dialog.getByRole('combobox').fill('descriptive');
    await dialog.getByRole('button', { name: 'Wrap' }).click();
    await expect(pagesRoot(page).locator('div.block.descriptive')).toContainText('Guests may rent a room');
    expect((await blockOf(page, 'Guests may')).ancestors[0]).toBe('themeBlock');
    await page.keyboard.press('ControlOrMeta+z');
    await settle(page);
    expect(await docJson(page)).toEqual(before);
  });

  test('Mod-K links the selection', async ({ page }) => {
    await select(page, 'Old Brannoc');
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: 'Add a link' });
    await dialog.getByRole('textbox', { name: 'Address' }).fill('javascript:alert(1)');
    await dialog.getByRole('textbox', { name: 'Address' }).press('Enter');
    await expect(dialog.getByText(/Use an http, https or mailto address/)).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Address' }).fill('example.com/inn');
    await dialog.getByRole('textbox', { name: 'Address' }).press('Enter');
    await expect(dialog).toBeHidden();
    await expect(pagesRoot(page).locator('a[href="https://example.com/inn"]')).toHaveText('Old Brannoc');
    expect((await marksAt(page, 'Old Brannoc')).map((m) => m.type).sort()).toEqual(['bold', 'link']);
    expect(await undoDepth(page)).toBe(1);
  });
});

test.describe('blocks', () => {
  test('Mod-L and Shift-Mod-L toggle bullet and numbered lists', async ({ page }) => {
    await select(page, 'Guests may', 2);
    await pressUndoable(page, 'ControlOrMeta+l', async () => expect((await blockOf(page, 'Guests may')).ancestors.slice(0, 2)).toEqual(['listItem', 'bulletList']));
    await pressUndoable(page, 'ControlOrMeta+Shift+l', async () => expect((await blockOf(page, 'Guests may')).ancestors.slice(0, 2)).toEqual(['listItem', 'orderedList']));
  });

  test('Shift-Mod-1…6 set heading levels and toggle back', async ({ page }) => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      await select(page, 'Guests may', 2);
      await pressUndoable(page, `ControlOrMeta+Shift+Digit${level}`, async () => {
        expect(await blockOf(page, 'Guests may')).toMatchObject({ type: 'heading', attrs: { level } });
        await expect(pagesRoot(page).locator(`h${level}`, { hasText: 'Guests may' })).toBeVisible();
      });
    }
    await page.keyboard.press('ControlOrMeta+Shift+Digit2');
    await page.keyboard.press('ControlOrMeta+Shift+Digit2');
    expect((await blockOf(page, 'Guests may')).type).toBe('paragraph');
  });

  test('Mod-Enter starts a new page (a section)', async ({ page }) => {
    const pages = await pageCount(page);
    await select(page, 'Guests may', 0);
    await pressUndoable(page, 'ControlOrMeta+Enter', async () => {
      await settle(page);
      expect(await pageCount(page)).toBe(pages + 1);
      const texts = await pageTexts(page);
      expect(texts[1]!.startsWith('Guests may')).toBe(true);
      await expect(pagesRoot(page).locator('.page').nth(1)).toHaveAttribute('data-kind', 'manual');
    });
    expect(await pageCount(page)).toBe(pages);
  });

  test('Shift-Mod-Enter inserts a column break', async ({ page }) => {
    await select(page, 'Guests may', 0);
    await pressUndoable(page, 'ControlOrMeta+Shift+Enter', async () => {
      await expect(pagesRoot(page).locator('div.columnSplit')).toHaveCount(1);
    });
    await expect(pagesRoot(page).locator('div.columnSplit')).toHaveCount(0);
  });

  test('Tab and Shift-Tab sink and lift list items; outside a list Tab is left to the browser', async ({ page }) => {
    await select(page, 'Second rumor', 3);
    await pressUndoable(page, 'Tab', async () => expect((await blockOf(page, 'Second rumor')).ancestors).toEqual(['listItem', 'bulletList', 'listItem', 'bulletList']));
    await page.keyboard.press('Tab');
    await pressUndoable(page, 'Shift+Tab', async () => expect((await blockOf(page, 'Second rumor')).ancestors).toEqual(['listItem', 'bulletList']));
    // Outside a list the editor doesn't consume Tab: the browser moves the focus on (no trap).
    await select(page, 'Guests may', 2);
    const before = await docJson(page);
    await page.keyboard.press('Tab');
    expect(await lastKey(page)).toEqual({ key: 'Tab', prevented: false });
    expect(await docJson(page)).toEqual(before);
  });
});

test.describe('history', () => {
  test('Mod-Z, Shift-Mod-Z and Mod-Y; quick actions are separate undo steps', { tag: '@smoke' }, async ({ page }) => {
    await select(page, 'pours cider');
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.press('ControlOrMeta+i');
    await page.keyboard.press('ControlOrMeta+u');
    expect(await undoDepth(page)).toBe(3);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await markTypes(page, 'pours cider')).toEqual(['bold', 'italic']);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await markTypes(page, 'pours cider')).toEqual(['bold', 'italic', 'underline']);
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+y');
    expect(await markTypes(page, 'pours cider')).toEqual(['bold', 'italic', 'underline']);
  });

  test('typing right after a command is its own undo step', async ({ page }) => {
    await select(page, 'Guests may', 2);
    await page.keyboard.press('ControlOrMeta+Shift+Digit3');
    await page.keyboard.type('XY');
    await page.keyboard.press('ControlOrMeta+z');
    await settle(page);
    expect(await blockOf(page, 'Guests may')).toMatchObject({ type: 'heading', attrs: { level: 3 } });
    expect((await pageTexts(page))[0]).not.toContain('XY');
  });
});

test.describe('save, print and toolbar focus', () => {
  test('Mod-S asks to save and never opens the browser dialog; Mod-P asks to print', { tag: '@smoke' }, async ({ page }) => {
    await select(page, 'Guests may', 2);
    await page.keyboard.press('ControlOrMeta+s');
    expect((await lastKey(page))?.prevented).toBe(true);
    await expect(page.getByTestId('save-status')).toHaveText('Saved (1)');
    await page.keyboard.press('ControlOrMeta+p');
    expect((await lastKey(page))?.prevented).toBe(true);
    expect(await requests(page)).toEqual(['save', 'print']);
    await expect(page.getByTestId('requests')).toHaveText('save 1 · print 1');
  });

  test('Alt+F10 focuses the toolbar; Escape returns to the editor at the same place', async ({ page }) => {
    await select(page, 'Guests may', 2);
    await page.keyboard.press('Alt+F10');
    const toolbar = page.getByRole('toolbar', { name: 'Editing' });
    await expect.poll(() => toolbar.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => editorHasFocus(page)).toBe(true);
    await page.keyboard.type('Z');
    expect((await pageTexts(page))[0]).toContain('GuZests may');
  });
});
