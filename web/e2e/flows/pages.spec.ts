// The app's editor pages against a real API (plan §9, §11 P7.1/P7.2, §12): views on /share,
// the sign-in prompt and error pages on /edit, the /new draft through a reload and the sign-in
// redirect, the 409 dialog with two tabs, locks, shortcuts and properties. See run-flows.mjs.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { pauseClock, runClockUntil } from '../clock';
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

/** Whether the editor is ready and pagination has nothing left to do. */
const paginationSettled = (page: Page) => page.evaluate(() => window.__hbEditorApp?.settled() === true);

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

/** Signed out on /new: types `text`; the brew is stored in this browser and the page moves to /local/:localId. Returns the id. */
async function signedOutLocalBrew(page: Page, text: string): Promise<string> {
  await openEditorPage(page, '/new');
  await expect(page.getByTestId('local-notice')).toBeVisible();
  await typeAt(page, text);
  await expect(page).toHaveURL(/\/local\/[\w-]+$/, SAVE_TIMEOUT);
  await expect(saveStatus(page)).toHaveText('Saved on this device', SAVE_TIMEOUT);
  await expect(page.getByTestId('save-status').getByRole('button', { name: 'Sign in to upload' })).toBeVisible();
  return new URL(page.url()).pathname.split('/').pop()!;
}

/** The caller's own brews (GET /api/users/{handle}/brews). */
async function ownBrews(request: APIRequestContext): Promise<{ editId: string; title: string }[]> {
  const me = (await (await request.get('/api/account/me')).json()) as { handle: string };
  const list = (await (await request.get(`/api/users/${me.handle}/brews`)).json()) as { items: { editId: string; title: string }[] };
  return list.items;
}

test('/new signed out: a brew kept in this browser (issue #4) survives a reload at /local/:localId and is listed on this device', async ({ page }) => {
  acceptLeaving(page);
  const localId = await signedOutLocalBrew(page, 'Kept on this device');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Kept on this device']);
  expect(await chromeViolations(page)).toEqual([]);
  await page.goto('/local', { waitUntil: 'domcontentloaded' });
  const item = page.locator(`[data-local-id="${localId}"]`);
  await expect(item).toBeVisible(LOAD_TIMEOUT);
  await expect(item.getByRole('link')).toHaveAttribute('href', `/local/${localId}`);
});

// No account needed for the PDF either. What the API makes of the HTML (and that it takes it
// from anyone) is PdfExportEndpointTests' and export/app.spec's: here the page's side, the brew's
// HTML sent and the answer saved as a download.
test('signed out, a brew kept in this browser downloads as PDF from the list on this device', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the download flow is the same in every engine');
  acceptLeaving(page);
  const localId = await signedOutLocalBrew(page, 'Printed from this device');
  const pdf = '%PDF-1.4\n%%EOF\n';
  const sent: string[] = [];
  await page.route('**/api/export/pdf', async (route) => {
    const request = route.request();
    const body = request.postDataBuffer() ?? Buffer.alloc(0);
    sent.push((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8'));
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from(pdf, 'latin1') });
  });
  await page.goto('/local', { waitUntil: 'domcontentloaded' });
  const item = page.locator(`[data-local-id="${localId}"]`);
  const [download] = await Promise.all([page.waitForEvent('download'), item.getByRole('button', { name: /^Download .* as PDF$/ }).click()]);
  expect(download.suggestedFilename()).toBe('Untitled brew.pdf');
  expect((await readFile(await download.path())).toString('latin1')).toBe(pdf);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('Printed from this device');
});

test('signed out, brews stay on this device; after signing in, the prompt uploads them only when asked', async ({ page, baseURL }) => {
  // Two brews, the sign-in round trip and the upload.
  test.setTimeout(30_000);
  acceptLeaving(page);
  // An account to sign in with later (registered elsewhere: this page stays signed out).
  const email = await registerOnly(page.request, baseURL!, uniqueEmail('flows-local'));
  await page.context().clearCookies();
  await signedOutLocalBrew(page, 'First local brew');
  await signedOutLocalBrew(page, 'Second local brew');

  // Sign in through the navbar's page (a redirect with returnTo), back to the brew.
  await nav(page).getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Flocal%2F/, LOAD_TIMEOUT);
  const form = page.getByTestId('login-form');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in' }).click();
  const prompt = page.getByRole('dialog', { name: 'You have 2 brews on this device' });
  await expect(prompt).toBeVisible(LOAD_TIMEOUT);
  expect(await ownBrews(page.request)).toEqual([]); // nothing went up by itself

  await prompt.getByRole('button', { name: 'Upload all' }).click();
  await expect(page.getByText('Uploaded 2 brews', { exact: true })).toBeVisible(SAVE_TIMEOUT);
  const uploaded = await ownBrews(page.request);
  expect(uploaded).toHaveLength(2);
  const docs = await Promise.all(uploaded.map(async (b) => JSON.stringify((await storedBrew(page.request, b.editId)).doc)));
  expect(docs.some((d) => d.includes('First local brew'))).toBe(true);
  expect(docs.some((d) => d.includes('Second local brew'))).toBe(true);
  await page.goto('/local', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('local-empty')).toBeVisible(LOAD_TIMEOUT);
});

test("a local brew's Upload (signed in) saves it to the account and opens it at /edit/:editId", async ({ page, baseURL }) => {
  test.setTimeout(30_000);
  acceptLeaving(page);
  const localId = await signedOutLocalBrew(page, 'Up it goes');
  await signUpApi(page.request, baseURL!);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  await page.getByTestId('local-upload').click();
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, SAVE_TIMEOUT);
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Up it goes']);
  await expect(saveStatus(page)).toHaveText('Saved', SAVE_TIMEOUT);
  const editId = new URL(page.url()).pathname.split('/').pop()!;
  expect(JSON.stringify((await storedBrew(page.request, editId)).doc)).toContain('Up it goes');
  await page.goto(`/local/${localId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('local-brew-missing')).toBeVisible(LOAD_TIMEOUT);
});

test('/new signed in: "Start over" discards a draft whose create never got through', async ({ page, baseURL }) => {
  // Three /new page loads (the draft, reloaded; after Start over, reloaded).
  test.setTimeout(30_000);
  acceptLeaving(page);
  await signUpApi(page.request, baseURL!);
  // The create never gets out: the draft stays a draft.
  await page.route((url) => url.pathname === '/api/brews', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.fallback()));
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

test('Mod-S saves at once', async ({ page, baseURL }) => {
  await signUpApi(page.request, baseURL!);
  const brew = await createBrewApi(page.request, baseURL!, 'Shortcuts');
  // The page's clock is paused while the test types and saves (e2e/clock.ts): the 3 s autosave
  // delay can't run out, so only Mod-S can save, however slow the machine.
  await page.clock.install();
  await openEditorPage(page, `/edit/${brew.editId}`);
  await expect.poll(() => paginationSettled(page)).toBe(true);
  await pauseClock(page);

  await typeAt(page, ' now');
  // Pagination settles (Mod-S waits for it), well before the autosave delay would run out.
  await runClockUntil(page, () => paginationSettled(page), 1000);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => JSON.stringify((await storedBrew(page.request, brew.editId)).doc), SAVE_TIMEOUT).toContain('Shortcuts now');
  await expect(saveStatus(page)).toHaveText('Saved');
  expect((await storedBrew(page.request, brew.editId)).version, 'one save').toBe(brew.version + 1);
});

test('Mod-P prints the pages; properties save the title', async ({ page, baseURL }) => {
  await signUpApi(page.request, baseURL!);
  const brew = await createBrewApi(page.request, baseURL!, 'Shortcuts');
  await page.clock.install(); // runs with real time until the properties' save (below)
  await openEditorPage(page, `/edit/${brew.editId}`);
  await stubPrint(page);
  await typeAt(page, ''); // the caret in the editor

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
  // The autosave delay needn't be waited out: pausing the clock jumps past it (e2e/clock.ts).
  await expect.poll(() => paginationSettled(page)).toBe(true);
  await pauseClock(page);
  await expect
    .poll(async () => (await storedBrew(page.request, brew.editId)).meta, SAVE_TIMEOUT)
    .toMatchObject({ title: 'Renamed by the flow', theme: 'Blank' });
  await page.clock.resume();
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
