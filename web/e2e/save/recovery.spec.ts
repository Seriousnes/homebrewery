// Recovery paths of autosave on the app's own editor pages (/edit/:editId, /new), over the
// in-memory brew server (fakeServer.ts), so this runs anywhere:
//   - a save that conflicts after the editor is gone is offered back as a conflict, never as a
//     plain restore that would silently overwrite the other version (SAVE-1);
//   - leaving a conflict through an in-app link asks first, and the changes come back (SAVE-2);
//   - a browser that refuses IndexedDB keeps /new's draft in memory across in-app navigation and
//     says so (SAVE-11);
//   - idbStore itself, every call, in a real browser (the unit tests have no IndexedDB).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { editorTexts, openEditorPage, typeAt, waitForEditor } from '../flows/helpers';
import { installFakeServer, type FakeBrew, type FakeServer } from './fakeServer';
import { docOf, idbDrafts, openSavePage, PAGE_READY, SAVE_TIMEOUT } from './helpers';

const conflictDialog = (page: Page) => page.getByRole('alertdialog', { name: 'This brew was changed somewhere else' });
const leaveDialog = (page: Page) => page.getByRole('alertdialog', { name: 'Leave without saving?' });
const storedText = (server: FakeServer, brew: FakeBrew) => JSON.stringify(server.brews.get(brew.editId)!.doc);

/**
 * Tab A has the brew open at v1; another tab then saves " theirs" as v2 and closes. Tab A is in
 * front again, still on v1.
 */
async function otherTabSaved(page: Page, context: BrowserContext) {
  // Three loads of the editor (two tabs, then the brew again after leaving it) and an autosave.
  test.setTimeout(30_000);
  const server = await installFakeServer(context);
  const brew = server.add({ doc: docOf('Base') });
  await openEditorPage(page, `/edit/${brew.editId}`);
  const other = await context.newPage();
  await openEditorPage(other, `/edit/${brew.editId}`);
  await typeAt(other, ' theirs');
  await other.keyboard.press('ControlOrMeta+s'); // saves at once (the autosave's delay is not under test here)
  await expect.poll(() => server.brews.get(brew.editId)!.version).toBe(2);
  // Saved: the tab deletes its draft, after the draft write its first keystroke queued. Closed any
  // sooner, that delete would never run and its stale draft would stay.
  await expect.poll(async () => (await idbDrafts(other, brew.editId)).length).toBe(0);
  await other.close();
  await page.bringToFront();
  return { server, brew };
}

test('a save that conflicts after the editor is gone comes back as a conflict, not a plain restore (SAVE-1)', async ({ page, context }) => {
  const { server, brew } = await otherTabSaved(page, context);
  // Typed, then left through an in-app link before the autosave delay: the unmount save gets 409
  // (or dies with the navigation) after the editor is gone.
  await typeAt(page, ' mine');
  await page.getByTestId('nav-vault').click();
  await expect(page).toHaveURL(/\/vault$/, PAGE_READY);
  // The draft once the unmount save has its answer: the 409 marks it a conflict (an unknown
  // outcome would keep pendingVersion 2, but only together with what that save sent).
  await expect
    .poll(async () => (await idbDrafts(page, brew.editId)).filter((d) => d.conflict || d.pendingVersion != null).length, SAVE_TIMEOUT)
    .toBe(1);
  const drafts = await idbDrafts(page, brew.editId);
  expect(drafts).toHaveLength(1);
  const draft = drafts[0]!;
  expect(draft.baseVersion).toBe(1);
  if (draft.pendingVersion === 2) expect(JSON.stringify(draft)).toContain('"pending":{');
  else expect(draft).toMatchObject({ pendingVersion: null, conflict: true });

  await openEditorPage(page, `/edit/${brew.editId}`);
  expect(await editorTexts(page)).toEqual(['Base theirs']);
  const banner = page.getByRole('region', { name: 'Unsaved changes found' });
  await expect(banner).toHaveAttribute('data-kind', 'conflict');
  await banner.getByTestId('draft-restore').click();
  // Restoring asks which version to keep; nothing is saved over theirs meanwhile.
  await expect(conflictDialog(page)).toBeVisible();
  expect(await editorTexts(page)).toEqual(['Base mine']);
  await page.waitForTimeout(3500);
  expect(storedText(server, brew)).toContain('Base theirs');
  expect(server.brews.get(brew.editId)!.version).toBe(2);
});

test('leaving a conflict through an in-app link asks first, and the changes come back (SAVE-2)', async ({ page, context }) => {
  const { server, brew } = await otherTabSaved(page, context);
  await typeAt(page, ' my important paragraph');
  await expect(conflictDialog(page)).toBeVisible(SAVE_TIMEOUT);
  await page.keyboard.press('Escape');
  await expect(conflictDialog(page)).toBeHidden();

  await page.getByTestId('nav-vault').click();
  const dialog = leaveDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Stay' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/edit/${brew.editId}$`));

  await page.getByTestId('nav-vault').click();
  await dialog.getByRole('button', { name: 'Leave anyway' }).click();
  await expect(page).toHaveURL(/\/vault$/, PAGE_READY);

  await openEditorPage(page, `/edit/${brew.editId}`);
  const banner = page.getByRole('region', { name: 'Unsaved changes found' });
  await expect(banner).toHaveAttribute('data-kind', 'conflict');
  await banner.getByTestId('draft-restore').click();
  await expect(conflictDialog(page)).toBeVisible();
  expect(await editorTexts(page)).toEqual(['Base my important paragraph']);
  // The author chooses: a copy keeps both.
  await conflictDialog(page).getByRole('button', { name: 'Save mine as a copy' }).click();
  await expect(conflictDialog(page)).toBeHidden();
  await expect(page).not.toHaveURL(new RegExp(`/edit/${brew.editId}$`), SAVE_TIMEOUT);
  const copy = [...server.brews.values()].find((b) => b.editId !== brew.editId)!;
  expect(JSON.stringify(copy.doc)).toContain('my important paragraph');
  expect(storedText(server, brew)).toContain('Base theirs');
});

test('a browser that refuses IndexedDB keeps /new in memory across in-app navigation, and says so (SAVE-11)', async ({ page, context }) => {
  const server = await installFakeServer(context);
  server.signedIn = false;
  // Firefox with site data blocked: indexedDB.open throws.
  await page.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, 'open', {
      configurable: true,
      value: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });
  await openEditorPage(page, '/new');
  await expect(page.getByTestId('drafts-not-kept')).toBeVisible();
  await typeAt(page, 'Kept for this visit');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(/\/register/, PAGE_READY);
  await page.goBack();
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Kept for this visit']);
  await expect(page.getByTestId('drafts-not-kept')).toBeVisible();
  // Nobody is signed in: nothing was sent (APP-9).
  expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
});

test('idbStore: every call round-trips through IndexedDB', async ({ page, context }) => {
  await installFakeServer(context);
  await openSavePage(page, null);
  const result = await page.evaluate(() => window.__hbSave!.idbRoundTrip());
  expect(result).toEqual({ one: { n: 1 }, many: [{ n: 1 }, { n: 2 }, undefined], left: [['c', { n: 3 }]] });
});
