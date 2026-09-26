// P3.8 against the real API: autosave → reload, a killed tab's draft, the 409 path with two
// tabs, a new brew's first save, and 401. Needs a private API (never the humans' :5080/:8080):
//
//   node e2e/save/run-with-api.mjs            (builds and starts one on :5425, runs these specs)
//
// or start it yourself and point Vite at it:
//
//   HB_API_URL=http://localhost:5425 E2E_PORT=5325 npx playwright test e2e/save
//
// Without HB_API_URL these tests are skipped; autosave.spec.ts covers the same flows against an
// in-memory server.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { conflictDialog, docOf, editorTexts, killTab, openSavePage, waitForSavePage, PASSWORD, SAVE_TIMEOUT, statusLabel, typeAt, waitForDraft } from './helpers';

const apiUrl = process.env.HB_API_URL ?? '';
const privateApi = /^https?:\/\/[^/]+:\d+/.test(apiUrl) && !/:(5080|8080)(\/|$)/.test(apiUrl);

test.skip(!privateApi, 'Needs a private API: HB_API_URL=http://localhost:5425 (see run-with-api.mjs)');

/** Registers and signs in a new user in the page's browser context (cookies are shared). */
async function signUp(page: Page, baseURL: string): Promise<string> {
  const email = `e2e-save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const headers = { Origin: baseURL };
  const registered = await page.request.post('/api/auth/register', { data: { email, password: PASSWORD }, headers });
  expect(registered.status(), await registered.text()).toBe(200);
  await signIn(page.request, baseURL, email);
  return email;
}

async function signIn(request: APIRequestContext, baseURL: string, email: string): Promise<void> {
  const login = await request.post('/api/auth/login?useCookies=true', { data: { email, password: PASSWORD }, headers: { Origin: baseURL } });
  expect(login.status(), await login.text()).toBe(200);
}

async function createBrew(page: Page, baseURL: string, text: string): Promise<{ editId: string; version: number }> {
  const res = await page.request.post('/api/brews', { data: { doc: docOf(text), meta: { title: 'Save e2e' } }, headers: { Origin: baseURL } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { editId: string; version: number };
}

async function storedBrew(request: APIRequestContext, editId: string): Promise<{ version: number; doc: unknown }> {
  const res = await request.get(`/api/brews/edit/${editId}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { version: number; doc: unknown };
}

test('type → autosave → reload shows the text', async ({ page, baseURL }) => {
  // Two loads of /dev/save (about 7 s each in Firefox under load) and the autosave's 3 s delay.
  test.setTimeout(30_000);
  await signUp(page, baseURL!);
  const brew = await createBrew(page, baseURL!, 'Real save');
  const frame = await openSavePage(page, brew.editId);
  await typeAt(page, ' persisted');
  await expect(frame).toHaveAttribute('data-base-version', String(brew.version + 1), SAVE_TIMEOUT);
  await expect(statusLabel(page)).toHaveText('Saved');
  expect(JSON.stringify((await storedBrew(page.request, brew.editId)).doc)).toContain('Real save persisted');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSavePage(page);
  expect(await editorTexts(page)).toEqual(['Real save persisted']);
  await expect(page.getByTestId('draft-offer')).toHaveCount(0);
});

test('a killed tab recovers its draft', { tag: '@smoke' }, async ({ page, context, baseURL }) => {
  // Two loads of /dev/save (about 7 s each in Firefox under load) and the autosave after restoring.
  test.setTimeout(30_000);
  await signUp(page, baseURL!);
  const brew = await createBrew(page, baseURL!, 'Before the crash');
  await openSavePage(page, brew.editId);
  // The tab dies before anything reaches the server: no save gets out of it.
  await page.route((url) => url.pathname.startsWith('/api/brews/'), (route) =>
    route.request().method() === 'PUT' ? route.abort('failed') : route.fallback(),
  );
  await typeAt(page, ' and after');
  await waitForDraft(page, brew.editId, 'Before the crash and after');
  await killTab(page);
  expect((await storedBrew(context.request, brew.editId)).version).toBe(brew.version);

  const next = await context.newPage();
  const frame = await openSavePage(next, brew.editId);
  const banner = next.getByRole('region', { name: 'Unsaved changes found' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Restore unsaved changes' }).click();
  expect(await editorTexts(next)).toEqual(['Before the crash and after']);
  await expect(frame).toHaveAttribute('data-base-version', String(brew.version + 1), SAVE_TIMEOUT);
  expect(JSON.stringify((await storedBrew(next.request, brew.editId)).doc)).toContain('Before the crash and after');
});

test('closing the tab right after typing saves at once (keepalive on pagehide)', async ({ page, context, baseURL, browserName }) => {
  // Firefox issues the keepalive PUT from pagehide too (seen by instrumenting fetch), but in
  // Playwright's Firefox it never reaches the server once the page is closed. The draft covers it.
  test.skip(browserName === 'firefox', "Playwright's Firefox drops keepalive requests of a closed page");
  await signUp(page, baseURL!);
  const brew = await createBrew(page, baseURL!, 'Closing');
  await openSavePage(page, brew.editId);
  await typeAt(page, ' soon');
  await page.close(); // well within the 3 s autosave delay
  await expect
    .poll(async () => JSON.stringify((await storedBrew(context.request, brew.editId)).doc))
    .toContain('Closing soon');
});

async function conflictInTwoTabs(page: Page, baseURL: string) {
  // Two tabs: two loads of /dev/save (about 7 s each in Firefox under load), then the resolution.
  test.setTimeout(30_000);
  await signUp(page, baseURL);
  const brew = await createBrew(page, baseURL, 'Two tabs');
  const frameA = await openSavePage(page, brew.editId);
  const pageB = await page.context().newPage();
  const frameB = await openSavePage(pageB, brew.editId);
  // Type in the tab in front: a background tab's timers and frames are throttled. Each tab saves at
  // once (Ctrl+S): the autosave's delay is covered by the first test.
  await page.bringToFront();
  await typeAt(page, ' A');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(frameA).toHaveAttribute('data-base-version', String(brew.version + 1));
  await pageB.bringToFront();
  await typeAt(pageB, ' B');
  await pageB.keyboard.press('ControlOrMeta+s');
  const dialog = conflictDialog(pageB);
  await expect(dialog).toBeVisible();
  return { brew, pageB, frameB, dialog };
}

test('409 via two tabs: Overwrite with mine', async ({ page, baseURL }) => {
  const { brew, pageB, frameB, dialog } = await conflictInTwoTabs(page, baseURL!);
  await expect(statusLabel(pageB)).toHaveText('Conflict');
  await dialog.getByRole('button', { name: 'Overwrite with mine' }).click();
  await expect(dialog).toBeHidden();
  await expect(frameB).toHaveAttribute('data-base-version', String(brew.version + 2));
  const stored = JSON.stringify((await storedBrew(pageB.request, brew.editId)).doc);
  expect(stored).toContain('Two tabs B');
  expect(stored).not.toContain('Two tabs A');
});

test('409 via two tabs: Load the saved version, and Save mine as a copy', async ({ page, baseURL }) => {
  const { brew, pageB, frameB, dialog } = await conflictInTwoTabs(page, baseURL!);
  await dialog.getByRole('button', { name: 'Load the saved version' }).click();
  await expect(dialog).toBeHidden();
  expect(await editorTexts(pageB)).toEqual(['Two tabs A']);
  await expect(frameB).toHaveAttribute('data-base-version', String(brew.version + 1));

  // A second conflict, resolved by keeping both.
  await page.bringToFront();
  await typeAt(page, ' again');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('dev-save')).toHaveAttribute('data-base-version', String(brew.version + 2));
  await pageB.bringToFront();
  await typeAt(pageB, ' mine');
  await pageB.keyboard.press('ControlOrMeta+s');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save mine as a copy' }).click();
  await expect(dialog).toBeHidden();
  await expect(frameB).not.toHaveAttribute('data-edit-id', brew.editId);
  const copyId = (await frameB.getAttribute('data-edit-id'))!;
  await expect(pageB).toHaveURL(new RegExp(`edit=${copyId}$`));
  expect(JSON.stringify((await storedBrew(pageB.request, copyId)).doc)).toContain('Two tabs A mine');
  expect(JSON.stringify((await storedBrew(pageB.request, brew.editId)).doc)).toContain('Two tabs A again');
});

test('a new brew: the first save POSTs and a reload opens it', { tag: '@smoke' }, async ({ page, baseURL }) => {
  // Two loads of /dev/save (about 7 s each in Firefox under load) and the autosave's 3 s delay.
  test.setTimeout(30_000);
  await signUp(page, baseURL!);
  const frame = await openSavePage(page, null);
  await typeAt(page, 'Created by autosave');
  await expect(frame).not.toHaveAttribute('data-edit-id', '', SAVE_TIMEOUT);
  const editId = (await frame.getAttribute('data-edit-id'))!;
  await expect(page).toHaveURL(new RegExp(`edit=${editId}$`));
  expect(JSON.stringify((await storedBrew(page.request, editId)).doc)).toContain('Created by autosave');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSavePage(page);
  expect(await editorTexts(page)).toEqual(['Created by autosave']);
});

test('401: signed out → "Sign in to save" with the draft kept; Ctrl+S after signing in saves', async ({ page, context, baseURL }) => {
  const email = await signUp(page, baseURL!);
  const brew = await createBrew(page, baseURL!, 'Session');
  const frame = await openSavePage(page, brew.editId);
  await context.clearCookies();
  await typeAt(page, ' expired');
  await expect(statusLabel(page)).toHaveText('Not saved', SAVE_TIMEOUT);
  await expect(page.getByRole('button', { name: 'Sign in to save' })).toBeVisible();
  await waitForDraft(page, brew.editId, 'Session expired');
  await signIn(page.request, baseURL!, email);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(frame).toHaveAttribute('data-base-version', String(brew.version + 1), SAVE_TIMEOUT);
  expect(JSON.stringify((await storedBrew(page.request, brew.editId)).doc)).toContain('Session expired');
});
