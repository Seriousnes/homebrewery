// T5 "Edit source" in the app (EditorApp over the fake API): the dialog opens from its shortcut and
// the app bar, shows the scope's HTML, applies as one undo step, reports parse problems first and
// asks before discarding edits. The source model itself is covered by Vitest (web/src/editor/source).
import { expect, type Locator, type Page, test } from '@playwright/test';
import { richDoc, TEXTS } from '../a11y/docs';
import { caretIn, editorRoot, openEditor } from '../a11y/helpers';

const dialogOf = (page: Page): Locator => page.getByRole('dialog', { name: 'Edit source' });
const code = (dialog: Locator): Locator => dialog.locator('.cm-content');

/** Replaces the whole source (insertText: one input, so CodeMirror's tag auto-closing stays out of it). */
async function replaceSource(page: Page, dialog: Locator, text: string) {
  await code(dialog).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

test('the shortcut opens the block at the caret; Apply is one undo step', async ({ page }) => {
  await openEditor(page, { doc: richDoc });
  await caretIn(page, TEXTS.intro);
  await page.keyboard.press('ControlOrMeta+Alt+u');
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(code(dialog)).toBeFocused();
  await expect(code(dialog)).toHaveText(`<p>${TEXTS.intro}</p>`);
  await expect(dialog.getByRole('radio', { name: 'Selection' })).toBeChecked();

  await replaceSource(page, dialog, '<p>An <strong>edited</strong> intro.</p>\n<p class="lead">And a second paragraph.</p>');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(dialog).toBeHidden();
  const root = editorRoot(page);
  await expect(root.locator('p strong', { hasText: 'edited' })).toBeVisible();
  await expect(root.locator('p.lead')).toHaveText('And a second paragraph.');
  await expect(root).not.toContainText(TEXTS.intro);

  await editorRoot(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(root).toContainText(TEXTS.intro);
  await expect(root.locator('p.lead')).toHaveCount(0);
});

test('the app bar opens it; the whole brew shows one div.page per section; Cancel without edits just closes', async ({ page }) => {
  await openEditor(page, { doc: richDoc });
  await caretIn(page, TEXTS.cell);
  await page.getByTestId('open-source').click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // The caret is in a table cell: the selection scope is the whole table.
  await expect(code(dialog)).toContainText('<table>');
  await dialog.getByRole('radio', { name: 'Whole brew' }).check();
  await expect(code(dialog)).toContainText('<div class="page hb-cols-2"');
  await expect(code(dialog).locator('.cm-line', { hasText: /^<div class="page/ })).toHaveCount(3);
  await expect(code(dialog)).not.toContainText('data-pid');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('parse problems are listed first; Apply anyway applies what can be kept', async ({ page }) => {
  await openEditor(page, { doc: richDoc });
  await caretIn(page, TEXTS.intro);
  await page.getByTestId('open-source').click();
  const dialog = dialogOf(page);
  await replaceSource(page, dialog, '<p onclick="alert(1)">Kept text</p><aside class="note">An aside</aside>');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  const report = dialog.getByTestId('source-report');
  await expect(report).toContainText('The attribute onclick is not allowed and was removed.');
  await expect(report).toContainText('<aside> has no block equivalent');
  await expect(editorRoot(page)).toContainText(TEXTS.intro);
  await dialog.getByRole('button', { name: 'Apply anyway' }).click();
  await expect(dialog).toBeHidden();
  await expect(editorRoot(page)).toContainText('Kept text');
  await expect(editorRoot(page).locator('aside.note')).toHaveText('An aside');
});

test('Escape (and the close button) with edits asks before discarding them', async ({ page }) => {
  await openEditor(page, { doc: richDoc });
  await caretIn(page, TEXTS.intro);
  await page.getByTestId('open-source').click();
  const dialog = dialogOf(page);
  await replaceSource(page, dialog, '<p>Throw this away</p>');
  // Outside the code: there, Escape first closes CodeMirror's own popups (completion, search).
  await dialog.getByRole('radio', { name: 'Selection' }).focus();
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('alertdialog', { name: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
  await expect(editorRoot(page)).toContainText(TEXTS.intro);
  await expect(editorRoot(page)).not.toContainText('Throw this away');
});

test('a section edit adds a section: pagination lays it out as a new manual page', async ({ page }) => {
  await openEditor(page, { doc: richDoc });
  await caretIn(page, TEXTS.last);
  await page.getByTestId('open-source').click();
  const dialog = dialogOf(page);
  await dialog.getByRole('radio', { name: 'Section' }).check();
  await expect(code(dialog)).toContainText(TEXTS.last);
  await code(dialog).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n<div class="page"><h2>Appendix</h2><p>New section.</p></div>');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  const pages = page.locator('.hb-canvas .ProseMirror > .page');
  await expect(pages).toHaveCount(4);
  await expect(pages.nth(3).locator('h2')).toHaveText('Appendix');
});
