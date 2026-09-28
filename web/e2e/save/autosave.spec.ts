// P3.8 autosave, conflict dialog, drafts and local history in the browser (/dev/save), against
// an in-memory brew server routed per context (fakeServer.ts), so it runs without the API.
// autosave-api.spec.ts runs the main flows against a real API.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { pauseClock } from '../clock';
import { installFakeServer } from './fakeServer';
import {
  AUTOSAVE_DELAY_MS,
  conflictDialog,
  docOf,
  editorTexts,
  killTab,
  openSavePage,
  SAVE_TIMEOUT,
  waitForSavePage,
  seriousViolations,
  statusLabel,
  typeAt,
  waitForDraft,
} from './helpers';

/** /dev/save's autosave state, read in the page (a save that started shows at once: 'saving'). */
const saveState = (page: Page) =>
  page.evaluate(() => {
    const { status, baseVersion, unsaved } = window.__hbSave!.state();
    return { status, baseVersion, unsaved };
  });

test('autosaves 3 s after typing (not for pagination), and a reload shows the text', async ({ page, context }) => {
  // Two loads of /dev/save (about 7 s each in Firefox under load).
  test.setTimeout(30_000);
  // The autosave's delay on Playwright's fake clock (web/e2e/clock.ts).
  await page.clock.install();
  const server = await installFakeServer(context);
  const brew = server.add({ doc: docOf('Autosave start') });
  const frame = await openSavePage(page, brew.editId);
  // Pagination runs (every frame and timer of the next 3.5 s): nothing to save.
  await page.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  expect(await saveState(page)).toEqual({ status: 'saved', baseVersion: 1, unsaved: false });
  expect(server.saves()).toHaveLength(0);
  await expect(statusLabel(page)).toHaveText('Saved');

  await pauseClock(page);
  await typeAt(page, ' typed');
  await expect(statusLabel(page)).toHaveText('Unsaved changes');
  await page.clock.runFor(AUTOSAVE_DELAY_MS - 1);
  expect(await saveState(page)).toEqual({ status: 'dirty', baseVersion: 1, unsaved: true }); // not before 3 s
  await page.clock.runFor(1);
  expect(['saving', 'saved']).toContain((await saveState(page)).status); // at 3 s
  await page.clock.resume();
  await expect(frame).toHaveAttribute('data-base-version', '2', SAVE_TIMEOUT);
  await expect(statusLabel(page)).toHaveText('Saved');
  const [put] = server.saves(brew.editId);
  expect(put!.body).toMatchObject({ baseVersion: 1, style: '', docSchemaVersion: 1, meta: { title: 'Fake brew' } });
  expect(JSON.stringify(put!.body!.doc)).toContain('Autosave start typed');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSavePage(page);
  expect(await editorTexts(page)).toEqual(['Autosave start typed']);
  await expect(page.getByTestId('draft-offer')).toHaveCount(0);
});

test('Ctrl/Cmd+S saves at once; a hidden page saves at once, gzip-compressed', async ({ page, context }) => {
  const server = await installFakeServer(context);
  const brew = server.add({ doc: docOf('Shortcut') });
  const frame = await openSavePage(page, brew.editId);
  await typeAt(page, ' one');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(frame).toHaveAttribute('data-base-version', '2', { timeout: 2500 });
  await expect(page.getByTestId('save-status-live')).toHaveText(/^Saved at /);

  await typeAt(page, ' two');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(frame).toHaveAttribute('data-base-version', '3', { timeout: 2500 });
  expect(server.saves().at(-1)!.gzip).toBe(true);
});

test('a killed tab recovers its draft', async ({ page, context }) => {
  // Two loads of /dev/save (about 7 s each in Firefox under load) and the autosave after restoring.
  test.setTimeout(30_000);
  const server = await installFakeServer(context);
  const brew = server.add({ doc: docOf('Draft start') });
  await openSavePage(page, brew.editId);
  await typeAt(page, ' never saved');
  await waitForDraft(page, brew.editId, 'Draft start never saved');
  // Killed: nothing more reaches the server.
  server.failPuts = 'network';
  await killTab(page);
  expect(server.brews.get(brew.editId)!.version).toBe(1);
  server.failPuts = false;

  const next = await context.newPage();
  const frame = await openSavePage(next, brew.editId);
  expect(await editorTexts(next)).toEqual(['Draft start']);
  const banner = next.getByRole('region', { name: 'Unsaved changes found' });
  await expect(banner).toBeVisible();
  expect(await seriousViolations(next, '[data-testid="draft-offer"]')).toEqual([]);
  await banner.getByRole('button', { name: 'Restore unsaved changes' }).click();
  await expect(banner).toBeHidden();
  expect(await editorTexts(next)).toEqual(['Draft start never saved']);
  await expect(frame).toHaveAttribute('data-base-version', '2', SAVE_TIMEOUT);
  expect(JSON.stringify(server.brews.get(brew.editId)!.doc)).toContain('Draft start never saved');
  // Restoring was one undo step.
  await next.keyboard.press('ControlOrMeta+z');
  expect(await editorTexts(next)).toEqual(['Draft start']);
});

async function twoTabsInConflict(page: Page, context: BrowserContext, { clock = false } = {}) {
  // Two tabs: two loads of /dev/save (about 7 s each in Firefox under load), then the resolution.
  test.setTimeout(30_000);
  // Playwright's fake clock (web/e2e/clock.ts), for both tabs: the context's.
  if (clock) await page.clock.install();
  const server = await installFakeServer(context);
  const brew = server.add({ doc: docOf('Shared') });
  const frameA = await openSavePage(page, brew.editId);
  const pageB = await context.newPage();
  const frameB = await openSavePage(pageB, brew.editId);
  // Type in the tab in front, as a person would: a background tab's timers and animation frames
  // are throttled (Firefox held tab A's autosave back for over 20 s). Each tab saves at once
  // (Ctrl+S): the autosave's delay is covered by the first test.
  await page.bringToFront();
  await typeAt(page, ' from A');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(frameA).toHaveAttribute('data-base-version', '2');
  await pageB.bringToFront();
  await typeAt(pageB, ' from B');
  expect(await editorTexts(pageB)).toEqual(['Shared from B']);
  await pageB.keyboard.press('ControlOrMeta+s');
  const dialog = conflictDialog(pageB);
  await expect(dialog).toBeVisible();
  expect(JSON.stringify(server.saves().at(-1)!.body!.doc)).toContain('Shared from B');
  expect(await editorTexts(pageB)).toEqual(['Shared from B']);
  return { server, brew, pageB, frameB, dialog };
}

test('409 via two tabs: the conflict dialog, then Overwrite with mine', async ({ page, context }) => {
  const { server, brew, pageB, frameB, dialog } = await twoTabsInConflict(page, context, { clock: true });
  await expect(statusLabel(pageB)).toHaveText('Conflict');
  expect(await seriousViolations(pageB, '[role="alertdialog"]')).toEqual([]);
  await expect(dialog.getByRole('button', { name: 'Save mine as a copy' })).toBeFocused();
  // Keyboard: Tab stays inside; Escape leaves the conflict open; Resolve… reopens it.
  for (let i = 0; i < 4; i++) await pageB.keyboard.press('Tab');
  expect(await pageB.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]')))).toBe(true);
  await pageB.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(statusLabel(pageB)).toHaveText('Conflict');
  // Autosave stopped: every timer of the next autosave delay and more starts no save of B's
  // unsaved text (a save that started shows in the state at once).
  await pageB.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  expect(await saveState(pageB)).toEqual({ status: 'conflict', baseVersion: 1, unsaved: true });
  expect(server.saves()).toHaveLength(2);
  await pageB.getByRole('button', { name: 'Resolve…' }).click();
  await expect(dialog).toBeVisible();

  expect(await editorTexts(pageB)).toEqual(['Shared from B']);
  await dialog.getByRole('button', { name: 'Overwrite with mine' }).click();
  await expect(dialog).toBeHidden();
  await expect(frameB).toHaveAttribute('data-base-version', '3');
  expect(server.saves().at(-1)!.body).toMatchObject({ baseVersion: 2 });
  const stored = JSON.stringify(server.brews.get(brew.editId)!.doc);
  expect(stored).toContain('Shared from B');
  expect(stored).not.toContain('from A');
});

test('409: Load the saved version (Undo brings mine back)', async ({ page, context }) => {
  const { pageB, frameB, dialog } = await twoTabsInConflict(page, context);
  await dialog.getByRole('button', { name: 'Load the saved version' }).click();
  await expect(dialog).toBeHidden();
  expect(await editorTexts(pageB)).toEqual(['Shared from A']);
  await expect(frameB).toHaveAttribute('data-base-version', '2');
  await expect(statusLabel(pageB)).toHaveText('Saved');
  await pageB.getByRole('button', { name: 'Local history' }).click();
  await expect(pageB.getByTestId('local-history-item').first()).toContainText('your unsaved version');
  await pageB.keyboard.press('Escape');
  await typeAt(pageB, ''); // focus the editor
  await pageB.keyboard.press('ControlOrMeta+z');
  expect(await editorTexts(pageB)).toEqual(['Shared from B']);
  await expect(statusLabel(pageB)).toHaveText('Unsaved changes');
});

test('409: Save mine as a copy (the page moves to the new brew)', async ({ page, context }) => {
  const { server, brew, pageB, frameB, dialog } = await twoTabsInConflict(page, context);
  await dialog.getByRole('button', { name: 'Save mine as a copy' }).click();
  await expect(dialog).toBeHidden();
  const copyId = await frameB.getAttribute('data-edit-id');
  expect(copyId).not.toBe(brew.editId);
  await expect(pageB).toHaveURL(new RegExp(`edit=${copyId}$`));
  expect(JSON.stringify(server.brews.get(copyId!)!.doc)).toContain('Shared from B');
  expect(JSON.stringify(server.brews.get(brew.editId)!.doc)).toContain('Shared from A');
  // Autosave carries on, on the copy.
  await typeAt(pageB, '!');
  await expect(frameB).toHaveAttribute('data-base-version', '2', SAVE_TIMEOUT);
  expect(server.saves(copyId!)).toHaveLength(1);
});

test('a new brew: the first save POSTs, the URL takes its editId, the editor stays', async ({ page, context }) => {
  // Two loads of /dev/save (about 7 s each in Firefox under load) and the autosave's 3 s delay.
  test.setTimeout(30_000);
  const server = await installFakeServer(context);
  const frame = await openSavePage(page, null);
  await expect(statusLabel(page)).toHaveText('Not saved yet');
  await typeAt(page, 'Brand new brew');
  await waitForDraft(page, 'new', 'Brand new brew');
  await expect(frame).not.toHaveAttribute('data-edit-id', '', SAVE_TIMEOUT);
  const editId = await frame.getAttribute('data-edit-id');
  await expect(page).toHaveURL(new RegExp(`/dev/save\\?edit=${editId}$`));
  expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  await typeAt(page, ', continued');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(frame).toHaveAttribute('data-base-version', '2');
  expect(server.saves(editId!)).toHaveLength(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSavePage(page);
  expect(await editorTexts(page)).toEqual(['Brand new brew, continued']);
});

test('401: "Sign in to save" keeps the draft; saving works again after signing in', async ({ page, context }) => {
  const server = await installFakeServer(context);
  const brew = server.add({ doc: docOf('Signed') });
  const frame = await openSavePage(page, brew.editId);
  server.signedIn = false;
  await typeAt(page, ' out');
  await expect(statusLabel(page)).toHaveText('Not saved', SAVE_TIMEOUT);
  const signIn = page.getByRole('button', { name: 'Sign in to save' });
  await expect(signIn).toBeVisible();
  await expect(page.getByTestId('save-status-live')).toContainText('Sign in to save');
  await waitForDraft(page, brew.editId, 'Signed out');
  expect(await seriousViolations(page, '[data-testid="save-status"]')).toEqual([]);
  server.signedIn = true;
  await page.keyboard.press('ControlOrMeta+s');
  await expect(frame).toHaveAttribute('data-base-version', '2', SAVE_TIMEOUT);
  await expect(statusLabel(page)).toHaveText('Saved');
});

test('offline: the draft is kept and Retry saves when the connection is back', async ({ page, context }) => {
  const server = await installFakeServer(context);
  const brew = server.add({ doc: docOf('Network') });
  const frame = await openSavePage(page, brew.editId);
  server.failPuts = 'network';
  await typeAt(page, ' down');
  await expect(statusLabel(page)).toHaveText('Offline', SAVE_TIMEOUT);
  await waitForDraft(page, brew.editId, 'Network down');
  server.failPuts = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(frame).toHaveAttribute('data-base-version', '2', SAVE_TIMEOUT);
  await expect(statusLabel(page)).toHaveText('Saved');
});

test('local history: restore an earlier saved version as one undo step', async ({ page, context }) => {
  const server = await installFakeServer(context);
  const brew = server.add({ doc: docOf('History') });
  const frame = await openSavePage(page, brew.editId);
  await typeAt(page, ' one');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(frame).toHaveAttribute('data-base-version', '2');
  await typeAt(page, ' two');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(frame).toHaveAttribute('data-base-version', '3');

  const opener = page.getByRole('button', { name: 'Local history' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Local history' });
  await expect(dialog.getByTestId('local-history-item')).toHaveCount(2);
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
  await dialog.getByRole('button', { name: /\(version 2\)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await editorTexts(page)).toEqual(['History one']);
  await page.getByRole('button', { name: 'Undo' }).click(); // the toast's action
  expect(await editorTexts(page)).toEqual(['History one two']);
  expect(server.brews.get(brew.editId)!.version).toBe(3);
});
