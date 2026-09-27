// The brew snippets editor (plan §6.3) against a real API, in Chromium and Firefox: a snippet is
// created, edited and deleted in the Snippets panel, the Insert menu's "Brew Snippets" follows at
// once, inserting it works, and after a save and a reload it is still there. Also keyboard
// operation, undo, import/export of the "\snippet" text form, the size readout and axe.
//
//   FLOWS_API_PORT=5480 E2E_PORT=5380 FLOWS_API_DB=hb_e2e_snippets \
//     node e2e/flows/run-flows.mjs e2e/snippets-editor          (from web/)
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { appRoot, docOf, editorRoot, openEditorPage, privateApi, saveStatus, signUpApi, waitForEditor } from '../flows/helpers';

test.skip(!privateApi, 'Needs a private API: HB_API_URL (see the command at the top of this file)');

/**
 * Axe in legacy mode: axe.run in the page itself. The default mode finishes every analyze() in a new
 * blank page, which took seconds to minutes in Firefox (a11y lane). The
 * editor page has no iframes, so the results are the same.
 */
const axe = (page: Page) => new AxeBuilder({ page }).setLegacyMode(true);

interface StoredSnippet {
  group?: string;
  name: string;
  gen: string;
}

async function createBrew(page: Page, baseURL: string, title: string, snippets: StoredSnippet[] | null = null): Promise<string> {
  const res = await page.request.post('/api/brews', {
    data: { doc: docOf('First paragraph.'), meta: { title }, snippets },
    headers: { Origin: baseURL },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { editId: string }).editId;
}

async function storedSnippets(page: Page, editId: string): Promise<unknown> {
  const res = await page.request.get(`/api/brews/edit/${editId}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { snippets: unknown }).snippets;
}

const panel = (page: Page): Locator => page.getByRole('complementary', { name: 'Snippets' });
const options = (page: Page): Locator => panel(page).getByRole('option');

async function openPanel(page: Page): Promise<void> {
  const toggle = page.getByTestId('toggle-snippets');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(panel(page)).toBeVisible();
}

/**
 * The Insert menu's "Brew Snippets" entries (their paths), read with the menu open, then closed. After an edit, poll
 * it: the panel reports to the page at most every SNIPPETS_REPORT_MS (120 ms), and Chromium opens the menu sooner.
 */
async function brewSnippetPaths(page: Page): Promise<string[]> {
  await page.getByTestId('insert-menu').click();
  const listbox = page.getByRole('listbox', { name: 'Snippets', exact: true });
  await expect(listbox).toBeVisible();
  // The theme's snippet modules load on demand: wait for the menu's entries.
  await expect(listbox).not.toHaveAttribute('aria-busy', 'true');
  await expect(listbox.getByRole('option').first()).toBeVisible();
  const paths = await listbox.locator('[data-snippet^="Brew Snippets"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-snippet') ?? ''));
  await page.keyboard.press('Escape');
  await expect(listbox).toBeHidden();
  return paths;
}

/** Replaces the snippet body (CodeMirror) with `text`. */
async function setBody(page: Page, text: string): Promise<void> {
  const content = panel(page).getByTestId('snippet-body').locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

const bodyText = (page: Page): Promise<string> =>
  panel(page)
    .getByTestId('snippet-body')
    .locator('.cm-line')
    .evaluateAll((lines) => lines.map((l) => l.textContent ?? '').join('\n'));

test('create a snippet, insert it from the Insert menu, save, reload: it is still there', async ({ page, baseURL }) => {
  // Two loads of the editor (open, reload) and several Insert menu scans.
  test.setTimeout(30_000);
  await signUpApi(page.request, baseURL!);
  const editId = await createBrew(page, baseURL!, 'Snippet Brew');
  await openEditorPage(page, `/edit/${editId}`);
  expect(await brewSnippetPaths(page)).toEqual([]);

  await openPanel(page);
  await expect(panel(page).getByTestId('snippets-empty')).toBeVisible();
  await panel(page).getByRole('button', { name: 'New snippet' }).click();
  // The new snippet's name is selected: typing replaces it.
  const name = panel(page).getByTestId('snippet-name');
  await expect(name).toBeFocused();
  await page.keyboard.type('Goblin');
  await panel(page).getByTestId('snippet-group').fill('Monsters');
  // Empty snippets aren't offered (as upstream): the body makes it an entry.
  await expect(panel(page).getByTestId('snippet-body-warning')).toBeVisible();
  await setBody(page, '{{note\n## Goblin ambush\nThey hide in the reeds.\n}}');
  await expect(panel(page).getByTestId('snippet-body-warning')).toHaveCount(0);
  await expect(options(page)).toHaveText(['Goblin']);
  await expect(appRoot(page)).toHaveAttribute('data-save-status', /dirty|saving|saved/);

  // In the Insert menu at once, and inserting it works.
  await expect.poll(() => brewSnippetPaths(page)).toEqual(['Brew Snippets › Monsters › Goblin']);
  await page.getByTestId('insert-menu').click();
  await page.getByRole('combobox', { name: 'Search snippets' }).fill('goblin');
  await page.locator('[data-snippet="Brew Snippets › Monsters › Goblin"]').click();
  await expect(page.getByTestId('insert-menu-status')).toContainText('inserted');
  const note = editorRoot(page).locator('.note');
  await expect(note).toHaveCount(1);
  await expect(note.getByRole('heading', { name: 'Goblin ambush' })).toBeVisible();
  await expect(note).toContainText('They hide in the reeds.');
  // One undo step in the canvas.
  await editorRoot(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(note).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(note).toHaveCount(1);

  await page.keyboard.press('ControlOrMeta+s');
  await expect(saveStatus(page)).toHaveText('Saved'); // Ctrl+S saves at once
  expect(await storedSnippets(page, editId)).toEqual([{ group: 'Monsters', name: 'Goblin', gen: '{{note\n## Goblin ambush\nThey hide in the reeds.\n}}' }]);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  // The panel stays open (a per-viewer preference) and shows the saved snippet.
  await openPanel(page);
  await expect(options(page)).toHaveText(['Goblin']);
  await expect(panel(page).getByTestId('snippet-group')).toHaveValue('Monsters');
  expect(await bodyText(page)).toBe('{{note\n## Goblin ambush\nThey hide in the reeds.\n}}');
  expect(await brewSnippetPaths(page)).toEqual(['Brew Snippets › Monsters › Goblin']);
  // Untouched after loading: nothing to save.
  await expect(appRoot(page)).toHaveAttribute('data-save-status', 'saved');
});

test('edit and delete (keyboard, undo): the Insert menu follows, and the save survives a reload', async ({ page, baseURL }) => {
  // Two loads of the editor (open, reload) and several Insert menu scans.
  test.setTimeout(30_000);
  await signUpApi(page.request, baseURL!);
  const editId = await createBrew(page, baseURL!, 'Keyboard Brew', [
    { name: 'Tavern', gen: '{{note\nThe Pony\n}}' },
    { name: 'Loot', gen: '| d6 | Loot |\n|:--:|:--|\n| 1 | Coins |' },
    { group: 'Maps', name: 'Keep', gen: '## The keep' },
  ]);
  await openEditorPage(page, `/edit/${editId}`);
  expect(await brewSnippetPaths(page)).toEqual(['Brew Snippets › Keyboard Brew › Tavern', 'Brew Snippets › Keyboard Brew › Loot', 'Brew Snippets › Maps › Keep']);

  // Keyboard only: the toggle, then Tab into the panel's list.
  await page.getByTestId('toggle-snippets').focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  const first = options(page).first();
  await first.focus();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options(page).nth(1)).toBeFocused();
  await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  // Enter goes to the name: rename Loot.
  await page.keyboard.press('Enter');
  await expect(panel(page).getByTestId('snippet-name')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' table');
  await expect.poll(() => brewSnippetPaths(page)).toContain('Brew Snippets › Keyboard Brew › Loot table');

  // A duplicate name is an error on the field and counts in the status.
  await panel(page).getByTestId('snippet-name').fill('tavern');
  await expect(panel(page).getByTestId('snippet-name')).toHaveAttribute('aria-invalid', 'true');
  await expect(panel(page).getByTestId('snippets-status')).toContainText('2 need attention');
  await panel(page).getByTestId('snippet-name').press('ControlOrMeta+z');
  await expect(panel(page).getByTestId('snippet-name')).toHaveValue('Loot table');
  await expect(panel(page).getByTestId('snippets-status')).not.toContainText('attention');

  // Delete from the list, then undo it: back in the menu; delete again.
  await options(page).nth(1).focus();
  await page.keyboard.press('Delete');
  await expect(options(page)).toHaveText(['Tavern', 'Keep']);
  await expect(panel(page).getByTestId('snippets-notice')).toContainText('Deleted “Loot table”.');
  await expect.poll(() => brewSnippetPaths(page)).toEqual(['Brew Snippets › Keyboard Brew › Tavern', 'Brew Snippets › Maps › Keep']);
  await options(page).first().focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(options(page)).toHaveText(['Tavern', 'Loot table', 'Keep']);
  await panel(page).getByRole('button', { name: 'Redo snippet edit' }).click();
  await expect(options(page)).toHaveText(['Tavern', 'Keep']);

  // Edit a body: undo in the body editor is the snippet editor's. (One input here: whether real
  // keystrokes merge depends on their timing, MERGE_MS; the unit tests cover merging.)
  await options(page).first().click();
  const content = panel(page).getByTestId('snippet-body').locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\nInn');
  await expect.poll(() => bodyText(page)).toBe('{{note\nThe Pony\n}}\nInn');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => bodyText(page)).toBe('{{note\nThe Pony\n}}');
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(() => bodyText(page)).toBe('{{note\nThe Pony\n}}\nInn');

  await page.keyboard.press('ControlOrMeta+s');
  await expect(saveStatus(page)).toHaveText('Saved'); // Ctrl+S saves at once
  expect(await storedSnippets(page, editId)).toEqual([
    { name: 'Tavern', gen: '{{note\nThe Pony\n}}\nInn' },
    { group: 'Maps', name: 'Keep', gen: '## The keep' },
  ]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect(await brewSnippetPaths(page)).toEqual(['Brew Snippets › Keyboard Brew › Tavern', 'Brew Snippets › Maps › Keep']);
});

test('import and export the "\\snippet" text form; the size readout', async ({ page, baseURL, context, browserName }) => {
  await signUpApi(page.request, baseURL!);
  const editId = await createBrew(page, baseURL!, 'Text Brew', [{ name: 'Old', gen: 'old' }]);
  await openEditorPage(page, `/edit/${editId}`);
  await openPanel(page);
  await expect(panel(page).getByTestId('snippets-status')).toHaveText('1 snippet · 28 B of 2.0 MB');

  await panel(page).getByRole('button', { name: 'Import…' }).click();
  const importDialog = page.getByRole('dialog', { name: 'Import snippets' });
  await expect(importDialog.getByRole('textbox', { name: 'Snippet text' })).toBeFocused();
  await importDialog.getByRole('textbox', { name: 'Snippet text' }).fill('\\snippet Spells › Fireball\n#### Fireball\n\\snippet Banner\n# Welcome\n');
  await expect(importDialog.getByTestId('snippets-import-summary')).toHaveText('Found 2 snippets: Fireball, Banner.');
  await importDialog.getByRole('button', { name: 'Add 2 snippets' }).click();
  await expect(importDialog).toBeHidden();
  await expect(options(page)).toHaveText(['Old', 'Banner', 'Fireball']);
  await expect.poll(() => brewSnippetPaths(page)).toEqual(['Brew Snippets › Text Brew › Old', 'Brew Snippets › Text Brew › Banner', 'Brew Snippets › Spells › Fireball']);

  await panel(page).getByRole('button', { name: 'Export…' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export snippets' });
  await expect(exportDialog.getByRole('textbox', { name: 'Snippet text' })).toHaveValue(
    '\\snippet Old\nold\n\\snippet Spells › Fireball\n#### Fireball\n\\snippet Banner\n# Welcome\n',
  );
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('text-brew-snippets.txt');
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await exportDialog.getByRole('button', { name: 'Copy' }).click();
  await expect(exportDialog.getByTestId('snippets-export-status')).toHaveText(/Copied to the clipboard\.|The text is selected/);
  await exportDialog.getByRole('button', { name: 'Done' }).click();
  await expect(exportDialog).toBeHidden();
  // Focus returns to the Export button.
  await expect(panel(page).getByRole('button', { name: 'Export…' })).toBeFocused();

  await page.keyboard.press('ControlOrMeta+s');
  await expect(saveStatus(page)).toHaveText('Saved'); // Ctrl+S saves at once
  expect(await storedSnippets(page, editId)).toEqual([
    { name: 'Old', gen: 'old' },
    { group: 'Spells', name: 'Fireball', gen: '#### Fireball' },
    { name: 'Banner', gen: '# Welcome' },
  ]);
});

test('390 px: the panel starts closed, opens over the pages, one side panel at a time', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signUpApi(page.request, baseURL!);
  const editId = await createBrew(page, baseURL!, 'Phone Brew', [{ name: 'One', gen: 'one' }]);
  // Open on a wide screen before: a compact screen still starts closed.
  await page.addInitScript(() => localStorage.setItem('hb-snippets-panel', JSON.stringify({ open: true, size: 380 })));
  await openEditorPage(page, `/edit/${editId}`);
  const toggle = page.getByTestId('toggle-snippets');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('toggle-style').click();
  await expect(page.getByTestId('toggle-style')).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(panel(page)).toBeVisible();
  // The Style drawer closed.
  await expect(page.getByTestId('toggle-style')).toHaveAttribute('aria-expanded', 'false');
  const box = (await panel(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  await expect(options(page)).toHaveText(['One']);
  // Opening another panel closes it.
  await page.getByTestId('toggle-outline').click();
  await expect(panel(page)).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe: the Snippets panel, its errors and dialogs (${scheme})`, async ({ page, baseURL }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signUpApi(page.request, baseURL!);
    const editId = await createBrew(page, baseURL!, 'Axe Brew', [
      { name: 'One', gen: '{{note\nOne\n}}' },
      { group: 'G', name: 'Two', gen: '\\snippet inside' },
    ]);
    await openEditorPage(page, `/edit/${editId}`);
    await openPanel(page);
    const scan = async (what: string) => {
      const results = await axe(page).include('[data-testid="snippets-panel"]').include('[data-testid="editor-app-bar"]').analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
        what,
      ).toEqual([]);
    };
    await scan('list and fields');
    // A warning on the body, then a duplicate-name error.
    await options(page).nth(1).click();
    await expect(panel(page).getByTestId('snippet-body-warning')).toBeVisible();
    await panel(page).getByTestId('snippet-group').fill('');
    await panel(page).getByTestId('snippet-name').fill('one');
    await expect(panel(page).getByTestId('snippet-name')).toHaveAttribute('aria-invalid', 'true');
    await scan('errors');

    await panel(page).getByRole('button', { name: 'Import…' }).click();
    await expect(page.getByRole('dialog', { name: 'Import snippets' })).toBeVisible();
    const dialogScan = async (name: string) => {
      const results = await axe(page).include(`[role="dialog"]`).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), name).toEqual([]);
    };
    await dialogScan('import');
    await page.keyboard.press('Escape');
    await panel(page).getByRole('button', { name: 'Export…' }).click();
    await expect(page.getByRole('dialog', { name: 'Export snippets' })).toBeVisible();
    await dialogScan('export');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
