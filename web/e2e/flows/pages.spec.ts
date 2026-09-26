// The app's editor pages against a real API (plan §9, §11 P7.1/P7.2, §12): views on /share,
// the sign-in prompt and error pages on /edit, the /new draft through a reload and the sign-in
// redirect, the 409 dialog with two tabs, locks, shortcuts and properties. See run-flows.mjs.
import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  adminEmail,
  appRoot,
  chromeViolations,
  createBrewApi,
  editorRoot,
  editorTexts,
  LOAD_TIMEOUT,
  nav,
  openEditorPage,
  PASSWORD,
  printCount,
  privateApi,
  registerOnly,
  SAVE_TIMEOUT,
  saveStatus,
  signInApi,
  signUpApi,
  storedBrew,
  stubPrint,
  typeAt,
  uniqueEmail,
  waitForDraft,
  waitForEditor,
  waitForNewDraft,
} from './helpers';

test.skip(!privateApi, 'Needs a private API: HB_API_URL=http://localhost:5429 (see e2e/flows/run-flows.mjs)');

/** Leaving a page whose changes can't be saved asks first (beforeunload): say yes. */
function acceptLeaving(page: Page): void {
  page.on('dialog', (dialog) => void dialog.accept());
}

test('share page: loads without an account, counts views, but not the authors’', { tag: '@smoke' }, async ({ page, browser, baseURL }) => {
  // Three share page loads (the author twice, a reader once).
  test.setTimeout(30_000);
  await signUpApi(page.request, baseURL!);
  const brew = await createBrewApi(page.request, baseURL!, 'Shared words', 'Shared brew');

  // The author: the brew, read-only, with a link to the editor; no view counted.
  await openEditorPage(page, `/share/${brew.shareId}`);
  await expect(editorRoot(page)).toContainText('Shared words');
  await expect(page.getByTestId('brew-title')).toHaveText('Shared brew');
  await expect(page).toHaveTitle('Shared brew - The Homebrewery');
  await expect(nav(page).getByTestId('nav-edit')).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect((await storedBrew(page.request, brew.editId)).views).toBe(0);

  // Anyone else, signed out: it loads, no edit link, and the view counts.
  const anonymous = await browser.newContext();
  try {
    const reader = await anonymous.newPage();
    await openEditorPage(reader, `/share/${brew.shareId}`);
    await expect(editorRoot(reader)).toContainText('Shared words');
    await expect(editorRoot(reader)).toHaveAttribute('contenteditable', 'false');
    await expect(nav(reader).getByTestId('nav-edit')).toHaveCount(0);
    await expect(nav(reader).getByTestId('nav-clone')).toHaveCount(0);
    expect((await storedBrew(page.request, brew.editId)).views).toBe(1);
  } finally {
    await anonymous.close();
  }
});

/** A brew of a new account (its own request context, closed again): its owner's email and the edit id. */
async function othersBrew(browser: Browser, baseURL: string): Promise<{ ownerEmail: string; brewEditId: string }> {
  const owner = await browser.newContext();
  try {
    const email = await signUpApi(owner.request, baseURL);
    return { ownerEmail: email, brewEditId: (await createBrewApi(owner.request, baseURL, 'Private words')).editId };
  } finally {
    await owner.close();
  }
}

test('/edit: signed out shows the sign-in prompt, then the brew', async ({ page, browser, baseURL }) => {
  const { ownerEmail, brewEditId } = await othersBrew(browser, baseURL!);

  // Anonymous: the sign-in form in place of the editor.
  await page.goto(`/edit/${brewEditId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in required' })).toBeVisible(LOAD_TIMEOUT);
  const form = page.getByTestId('sign-in-required');
  await form.getByLabel('Email').fill(ownerEmail);
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in' }).click();
  // Signed in, the brew loads in the editor.
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Private words']);
  await expect(page.getByRole('heading', { level: 1, name: /^Editing / })).toBeAttached();
});

test('/edit and /share: someone else gets 403, unknown ids 404', async ({ page: stranger, browser, baseURL }) => {
  const { brewEditId } = await othersBrew(browser, baseURL!);
  await signUpApi(stranger.request, baseURL!);
  await stranger.goto(`/edit/${brewEditId}`, { waitUntil: 'domcontentloaded' });
  await expect(stranger.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible(LOAD_TIMEOUT);
  await expect(stranger.getByText('Error 403')).toBeVisible();
  await stranger.goto('/edit/doesNotExist1', { waitUntil: 'domcontentloaded' });
  await expect(stranger.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible(LOAD_TIMEOUT);
  await stranger.goto('/share/doesNotExist1', { waitUntil: 'domcontentloaded' });
  await expect(stranger.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible(LOAD_TIMEOUT);
});

/** Signed out on /new: types `text` and waits for its draft; the save is refused ("Sign in to save"). */
async function signedOutDraft(page: Page, text: string): Promise<void> {
  await openEditorPage(page, '/new');
  await expect(page.getByTestId('new-sign-in-notice')).toBeVisible();
  await typeAt(page, text);
  await waitForNewDraft(page, text);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'signedOut', SAVE_TIMEOUT);
  await expect(page.getByTestId('save-status').getByRole('button', { name: 'Sign in to save' })).toBeVisible();
}

test('/new: signed out, the draft survives a reload', async ({ page }) => {
  acceptLeaving(page);
  await signedOutDraft(page, 'Draft before signing in');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Draft before signing in']);
  await expect(page.getByTestId('new-draft-notice')).toBeVisible();
  expect(await chromeViolations(page)).toEqual([]);
});

test('/new: the draft survives the sign-in redirect, the first save creates the brew, and /new starts blank again', async ({ page, baseURL }) => {
  // Three page loads (/new, the saved brew reloaded, /new again) and the sign-in round trip.
  test.setTimeout(30_000);
  acceptLeaving(page);
  // An account to sign in with later (registered elsewhere: this page stays signed out).
  const email = await registerOnly(page.request, baseURL!, uniqueEmail('flows-new'));
  await page.context().clearCookies();
  await signedOutDraft(page, 'Draft before signing in');

  // Sign in through the navbar's page (a redirect with returnTo), back to /new.
  await nav(page).getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fnew$/, LOAD_TIMEOUT);
  const form = page.getByTestId('login-form');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/new$/, LOAD_TIMEOUT);
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Draft before signing in']);

  // Signed in: the draft is saved at once (a POST) and the page moves to its editor.
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, SAVE_TIMEOUT);
  await expect(saveStatus(page)).toHaveText('Saved', SAVE_TIMEOUT);
  const editId = new URL(page.url()).pathname.split('/').pop()!;
  expect(JSON.stringify((await storedBrew(page.request, editId)).doc)).toContain('Draft before signing in');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Draft before signing in']);

  // The 'new' draft is gone: /new starts blank again.
  await openEditorPage(page, '/new');
  expect(await editorTexts(page)).toEqual(['']);
  await expect(page.getByTestId('new-draft-notice')).toHaveCount(0);
});

test('/new: a draft left from another visit is shown, and becomes a brew only when edited', async ({ page, baseURL }) => {
  // Two /new page loads, and a wait past the autosave delay.
  test.setTimeout(30_000);
  acceptLeaving(page);
  await openEditorPage(page, '/new');
  await typeAt(page, 'An old draft');
  await waitForNewDraft(page, 'An old draft');
  // Later, signed in, in another tab (no sign-in hand-off from this visit).
  await signUpApi(page.request, baseURL!);
  const later = await page.context().newPage();
  await page.close({ runBeforeUnload: false });
  await openEditorPage(later, '/new');
  expect(await editorTexts(later)).toEqual(['An old draft']);
  await expect(later.getByTestId('new-draft-notice')).toContainText('It is saved as a new brew when you edit it.');
  await expect(later.getByTestId('new-sign-in-notice')).toHaveCount(0);
  await later.waitForTimeout(3500); // past the autosave delay (3 s): nothing was created
  await expect(later).toHaveURL(/\/new$/);
  await expect(saveStatus(later)).toHaveText('Not saved yet');
  await typeAt(later, ', kept');
  await expect(later).toHaveURL(/\/edit\/[\w-]+$/, SAVE_TIMEOUT);
  await expect(saveStatus(later)).toHaveText('Saved', SAVE_TIMEOUT);
  const editId = new URL(later.url()).pathname.split('/').pop()!;
  expect(JSON.stringify((await storedBrew(later.request, editId)).doc)).toContain('An old draft, kept');
});

test('/new: "Start over" discards the draft', async ({ page }) => {
  // Three /new page loads (the draft, reloaded; after Start over, reloaded).
  test.setTimeout(30_000);
  acceptLeaving(page);
  await openEditorPage(page, '/new');
  await typeAt(page, 'A draft to throw away');
  await waitForNewDraft(page, 'A draft to throw away');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['A draft to throw away']);

  await page.getByTestId('new-start-over').click();
  const confirm = page.getByRole('alertdialog', { name: 'Start over?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Discard the draft' }).click();
  // A fresh /new mounts: no draft notice, an empty page.
  await expect(page.getByTestId('new-draft-notice')).toHaveCount(0, LOAD_TIMEOUT);
  await waitForEditor(page);
  await expect.poll(() => editorTexts(page), SAVE_TIMEOUT).toEqual(['']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['']);
});

test('/edit: changes a closed tab never saved are offered again, and restoring saves them', async ({ page, baseURL }) => {
  // Two editor page loads (the tab that closes, the next one) and a save.
  test.setTimeout(30_000);
  await signUpApi(page.request, baseURL!);
  const brew = await createBrewApi(page.request, baseURL!, 'Before the crash');
  await openEditorPage(page, `/edit/${brew.editId}`);
  // The tab dies before any save gets out: saves fail, then fetch is cut (a keepalive request sent
  // while the page closes would bypass the routes).
  await page.route((url) => url.pathname.startsWith('/api/brews/'), (route) => (route.request().method() === 'PUT' ? route.abort('failed') : route.fallback()));
  await typeAt(page, ' and after');
  await waitForDraft(page, brew.editId, 'Before the crash and after');
  await page.evaluate(() => {
    window.fetch = () => Promise.reject(new Error('The tab is gone'));
  });
  const context = page.context();
  await page.close();
  expect((await storedBrew(context.request, brew.editId)).version).toBe(brew.version);

  const next = await context.newPage();
  await openEditorPage(next, `/edit/${brew.editId}`);
  expect(await editorTexts(next)).toEqual(['Before the crash']);
  const banner = next.getByRole('region', { name: 'Unsaved changes found' });
  await expect(banner).toBeVisible();
  expect(await chromeViolations(next)).toEqual([]);
  await banner.getByRole('button', { name: 'Restore unsaved changes' }).click();
  expect(await editorTexts(next)).toEqual(['Before the crash and after']);
  await expect(banner).toHaveCount(0);
  await expect
    .poll(async () => JSON.stringify((await storedBrew(context.request, brew.editId)).doc), SAVE_TIMEOUT)
    .toContain('Before the crash and after');
});

test('409: two tabs editing the same brew get the conflict dialog', { tag: '@smoke' }, async ({ page, baseURL }) => {
  // Two editor page loads (the tabs) and two saves.
  test.setTimeout(30_000);
  await signUpApi(page.request, baseURL!);
  const brew = await createBrewApi(page.request, baseURL!, 'Two tabs');
  await openEditorPage(page, `/edit/${brew.editId}`);
  const pageB = await page.context().newPage();
  await openEditorPage(pageB, `/edit/${brew.editId}`);

  // Background tabs' timers are throttled: type in the tab in front.
  await page.bringToFront();
  await typeAt(page, ' A');
  await expect(saveStatus(page)).toHaveText('Saved', SAVE_TIMEOUT);
  await expect.poll(async () => (await storedBrew(page.request, brew.editId)).version, SAVE_TIMEOUT).toBe(brew.version + 1);

  await pageB.bringToFront();
  await typeAt(pageB, ' B');
  const dialog = pageB.getByTestId('conflict-dialog');
  await expect(dialog).toBeVisible(SAVE_TIMEOUT);
  await expect(dialog).toHaveAttribute('role', 'alertdialog');
  await expect(saveStatus(pageB)).toHaveText('Conflict');
  expect(await chromeViolations(pageB)).toEqual([]);
  // "Load the saved version" brings tab A's text into tab B.
  await dialog.getByTestId('conflict-load').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => editorTexts(pageB)).toEqual(['Two tabs A']);
  await pageB.close();
});

test('Mod-S saves at once, Mod-P prints the pages; properties save the title', async ({ page, baseURL }) => {
  await signUpApi(page.request, baseURL!);
  const brew = await createBrewApi(page.request, baseURL!, 'Shortcuts');
  await openEditorPage(page, `/edit/${brew.editId}`);
  await stubPrint(page);

  await typeAt(page, ' now');
  await page.keyboard.press('ControlOrMeta+s');
  // Well before the 3 s autosave delay.
  await expect.poll(async () => JSON.stringify((await storedBrew(page.request, brew.editId)).doc), { timeout: 2500, intervals: [100] }).toContain('Shortcuts now');
  await expect(saveStatus(page)).toHaveText('Saved');

  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(() => printCount(page)).toBe(1);
  // The toolbar's Print button.
  await page.getByTestId('print').click();
  await expect.poll(() => printCount(page)).toBe(2);

  // Properties: a new title is saved and shown in the navbar.
  await page.getByTestId('open-properties').click();
  const dialog = page.getByRole('dialog', { name: 'Properties' });
  await expect(dialog).toBeVisible();
  const title = dialog.getByLabel('Title');
  await title.fill('Renamed by the flow');
  await title.blur();
  // Another theme restyles the canvas at once.
  const theme = dialog.getByRole('combobox', { name: 'Theme' });
  await theme.focus();
  await theme.press('ArrowDown');
  await page.getByRole('listbox', { name: 'Theme' }).locator('[role="option"][data-value="Blank"]').click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('brew-title')).toHaveText('Renamed by the flow');
  await expect(page.locator('[data-canvas-theme="Blank"][data-canvas-status="ready"]')).toBeVisible(LOAD_TIMEOUT);
  await expect
    .poll(async () => (await storedBrew(page.request, brew.editId)).meta, SAVE_TIMEOUT)
    .toMatchObject({ title: 'Renamed by the flow', theme: 'Blank' });
  await expect(page).toHaveTitle('Renamed by the flow - The Homebrewery');
});

test('a locked brew: the editor shows the lock and asks for a review; the share page shows the lock page', async ({ page, browser, baseURL }) => {
  test.skip(!adminEmail, 'Needs FLOWS_ADMIN_EMAIL (an Admin__Emails account of the API; run-flows.mjs sets both)');
  await signUpApi(page.request, baseURL!);
  const brew = await createBrewApi(page.request, baseURL!, 'Locked words');

  const adminContext = await browser.newContext();
  try {
    const admin = adminContext.request;
    const registered = await admin.post('/api/auth/register', { data: { email: adminEmail, password: PASSWORD }, headers: { Origin: baseURL! } });
    expect(registered.status()).toBe(200);
    await signInApi(admin, baseURL!, adminEmail);
    const locked = await admin.put(`/api/admin/brews/${brew.shareId}/lock`, {
      data: { code: 455, editMessage: 'Please remove the copied text.', shareMessage: 'This brew is under review.' },
      headers: { Origin: baseURL! },
    });
    expect(locked.status(), await locked.text()).toBe(200);

    // The share page is the lock page, for readers and authors alike.
    const reader = await adminContext.newPage();
    await reader.goto(`/share/${brew.shareId}`, { waitUntil: 'domcontentloaded' });
    await expect(reader.getByRole('heading', { level: 1, name: 'This brew is locked' })).toBeVisible(LOAD_TIMEOUT);
    await expect(reader.getByText('This brew is under review.')).toBeVisible();
    await expect(reader.getByText('Lock code 455')).toBeVisible();
  } finally {
    await adminContext.close();
  }

  // The editor: the lock banner with the edit message; ask for a review.
  await openEditorPage(page, `/edit/${brew.editId}`);
  const banner = page.getByTestId('lock-banner');
  await expect(banner).toBeVisible();
  await expect(banner.getByTestId('lock-message')).toHaveText('Please remove the copied text.');
  expect(await chromeViolations(page)).toEqual([]);
  await banner.getByRole('button', { name: 'Request review' }).click();
  await expect(banner.getByTestId('lock-review-requested')).toBeVisible(SAVE_TIMEOUT);
  // Saving still works while locked.
  await typeAt(page, ' fixed');
  await expect(saveStatus(page)).toHaveText('Saved', SAVE_TIMEOUT);
  await expect(appRoot(page)).toHaveAttribute('data-save-status', 'saved');
});
