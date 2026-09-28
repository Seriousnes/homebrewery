// SAVE-8 and SAVE-12 on the app's /new page against the real API (a private one: see
// run-with-api.mjs). The first POST /api/brews reaches the server, which stores the brew, but its
// answer is lost (page.route: route.fetch(), then route.abort()); autosave retries with the same
// Idempotency-Key and gets that brew back: exactly one brew. "New brew" while the /new page's
// unmount save is still creating its brew: the fresh /new waits and starts blank. A signed-in
// user's leftover 'new' draft is not offered to another user.
//
//   node e2e/save/run-with-api.mjs e2e/save/idempotent-create.spec.ts
//
// Without HB_API_URL these tests are skipped (src/editor/save/appRoutes.test.tsx covers the same
// flows over an in-memory API).
import { expect, test, type Page, type Route } from '@playwright/test';
import {
  editorTexts,
  nav,
  openEditorPage,
  privateApi,
  saveStatus,
  signInApi,
  signUpApi,
  storedBrew,
  typeAt,
  waitForDraft,
  waitForEditor,
  waitForNewDraft,
} from '../flows/helpers';
import { AUTOSAVE_DELAY_MS, FIRST_RETRY_MS, PAGE_READY, SAVE_TIMEOUT } from './helpers';

test.skip(!privateApi, 'Needs a private API: HB_API_URL=http://localhost:5425 (see run-with-api.mjs)');

// The autosave's delay and its retries run on Playwright's fake clock (web/e2e/clock.ts), installed
// before each test's first navigation: page.clock.runFor(AUTOSAVE_DELAY_MS) is the autosave, now.
test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

/** When the app's autosave retries a failed save (epoch ms, the page's clock), or null. */
const retryAt = (page: Page) => page.evaluate(() => (window.__hbEditorApp?.save() as { retryAt?: number | null } | null | undefined)?.retryAt ?? null);

interface SeenPost {
  key: string | null;
  status: number | null;
  editId: string | null;
  lost: boolean;
}

/**
 * Routes POST /api/brews through route.fetch(): `lose(n)` decides whether the n-th answer (0-based)
 * is dropped after the server handled the request, `hold` holds every answer back until it resolves.
 */
async function watchCreates(page: Page, { lose = () => false, hold }: { lose?: (n: number) => boolean; hold?: Promise<void> } = {}) {
  const posts: SeenPost[] = [];
  await page.route('**/api/brews', async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const n = posts.length;
    const seen: SeenPost = { key: await request.headerValue('idempotency-key'), status: null, editId: null, lost: lose(n) };
    posts.push(seen);
    const response = await route.fetch();
    seen.status = response.status();
    if (seen.status === 201) seen.editId = ((await response.json()) as { editId: string }).editId;
    if (seen.lost) return route.abort('failed'); // stored on the server; the answer never arrives
    await hold;
    return route.fulfill({ response });
  });
  return posts;
}

/** The signed-in user's brews (their own list). */
async function myBrews(page: Page): Promise<{ editId: string | null; title: string }[]> {
  const me = (await (await page.request.get('/api/account/me')).json()) as { handle: string };
  const res = await page.request.get(`/api/users/${encodeURIComponent(me.handle)}/brews`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { items: { editId: string | null; title: string }[] }).items;
}

async function clickNewBrew(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: 'New' }).click();
  await page.getByTestId('nav-new-panel').getByRole('link', { name: /^New brew/ }).click();
}

test('a /new POST whose answer is lost is sent again with the same key: exactly one brew', async ({ page, baseURL }) => {
  await signUpApi(page.request, baseURL!);
  const posts = await watchCreates(page, { lose: (n) => n === 0 });
  await openEditorPage(page, '/new');
  await typeAt(page, 'Lost answer');
  await page.clock.runFor(AUTOSAVE_DELAY_MS);
  // The answer is lost: the autosave waits for its first retry.
  await expect.poll(() => retryAt(page)).not.toBeNull();
  expect(posts).toHaveLength(1);
  await page.clock.runFor(FIRST_RETRY_MS);
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, SAVE_TIMEOUT);

  expect(posts).toHaveLength(2);
  const [lost, retry] = posts;
  expect(lost).toMatchObject({ status: 201, lost: true });
  expect(lost!.key).toMatch(/^[\w-]{16,}$/);
  expect(retry).toMatchObject({ key: lost!.key, status: 201, editId: lost!.editId, lost: false });
  await expect(page).toHaveURL(new RegExp(`/edit/${lost!.editId}$`));

  const brews = await myBrews(page);
  expect(brews.map((b) => b.editId)).toEqual([lost!.editId]);
  await expect(saveStatus(page)).toHaveText('Saved', SAVE_TIMEOUT);
  expect(JSON.stringify((await storedBrew(page.request, lost!.editId!)).doc)).toContain('Lost answer');
});

test('"New brew" while the unmount save creates the brew: the fresh /new waits, starts blank, and one brew holds the text', async ({
  page,
  baseURL,
}) => {
  // Two loads of /new.
  test.setTimeout(30_000);
  await signUpApi(page.request, baseURL!);
  // Every create's answer is held back until the test releases them.
  let release: () => void = () => {};
  const posts = await watchCreates(page, { hold: new Promise<void>((resolve) => (release = resolve)) });
  await openEditorPage(page, '/new');
  await typeAt(page, 'Race text');
  await waitForNewDraft(page, 'Race text');
  await clickNewBrew(page);

  // The fresh /new waits for that create (the unmount save's, or the autosave's had it gone out
  // already), whose answer is held back; once it has its answer, the page starts blank.
  await expect(page.getByTestId('page-loading')).toContainText('Saving your previous brew…', PAGE_READY);
  await expect.poll(() => posts.length).toBe(1);
  release();
  await expect(page.getByText('Your new brew was saved', { exact: true })).toBeVisible(SAVE_TIMEOUT);
  await expect.poll(() => editorTexts(page), PAGE_READY).toEqual(['']);
  await waitForEditor(page);
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByTestId('new-draft-notice')).toHaveCount(0);
  expect(posts).toHaveLength(1);
  const brews = await myBrews(page);
  expect(brews).toHaveLength(1);
  expect(JSON.stringify((await storedBrew(page.request, brews[0]!.editId!)).doc)).toContain('Race text');

  // The fresh page is a brew of its own.
  await typeAt(page, 'Second brew');
  await page.clock.runFor(AUTOSAVE_DELAY_MS);
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, SAVE_TIMEOUT);
  expect(posts).toHaveLength(2);
  expect(posts[1]!.key).not.toBe(posts[0]!.key);
  expect(await myBrews(page)).toHaveLength(2);
  expect(JSON.stringify((await storedBrew(page.request, posts[1]!.editId!)).doc)).not.toContain('Race text');
});

test('"New brew" while that create gets no answer: the fresh /new loads the draft and its create chain, still one brew', async ({
  page,
  baseURL,
}) => {
  // Two loads of /new, the autosave's 3 s delay and lost answers until the fresh page is up.
  test.setTimeout(30_000);
  await signUpApi(page.request, baseURL!);
  // Every answer is lost until the fresh page is up (whether autosave or the unmount save sent first).
  let losing = true;
  const posts = await watchCreates(page, { lose: () => losing });
  await openEditorPage(page, '/new');
  await typeAt(page, 'Race text');
  await waitForNewDraft(page, 'Race text');
  await clickNewBrew(page);

  await expect(page.getByTestId('new-draft-notice')).toBeVisible(PAGE_READY);
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Race text']);
  losing = false;
  await typeAt(page, ' and more');
  await page.clock.runFor(AUTOSAVE_DELAY_MS);
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, SAVE_TIMEOUT);

  const lost = posts.filter((p) => p.lost);
  const [first] = lost;
  const replay = posts.at(-1);
  expect(first).toMatchObject({ status: 201 });
  expect(lost.every((p) => p.key === first!.key && p.editId === first!.editId)).toBe(true);
  expect(replay).toMatchObject({ key: first!.key, status: 201, editId: first!.editId, lost: false });
  expect((await myBrews(page)).map((b) => b.editId)).toEqual([first!.editId]);
  await expect
    .poll(async () => JSON.stringify((await storedBrew(page.request, first!.editId!)).doc), SAVE_TIMEOUT)
    .toContain('Race text and more');
});

test("a signed-in user's leftover /new draft is not offered to another user, and comes back to its author", async ({ context, baseURL }) => {
  // Four loads of /new (two users, signed out, the author again), each with its draft checks.
  test.setTimeout(30_000);
  // The test's own context (no extra one: Firefox sometimes hung creating pages in extra contexts).
  const page = await context.newPage();
  const origin = { headers: { Origin: baseURL! } };
  const alice = await signUpApi(page.request, baseURL!);
  // Alice's create never gets out: the draft is all there is.
  await context.route('**/api/brews', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.fallback()));
  await openEditorPage(page, '/new');
  await typeAt(page, 'Alice only');
  await waitForNewDraft(page, 'Alice only');
  expect((await page.request.post('/api/account/logout', origin)).ok()).toBe(true);
  await page.close();

  // Bob, same browser: a blank /new, and Alice's draft stays stored.
  const bobPage = await context.newPage();
  await signUpApi(bobPage.request, baseURL!);
  await openEditorPage(bobPage, '/new');
  expect(await editorTexts(bobPage)).toEqual(['']);
  await expect(bobPage.getByTestId('new-draft-notice')).toHaveCount(0);
  await waitForDraft(bobPage, 'new', 'Alice only');
  // Nobody signed in: not offered either.
  expect((await bobPage.request.post('/api/account/logout', origin)).ok()).toBe(true);
  await openEditorPage(bobPage, '/new');
  expect(await editorTexts(bobPage)).toEqual(['']);
  await expect(bobPage.getByTestId('local-notice')).toBeVisible();
  await expect(bobPage.getByTestId('new-draft-notice')).toHaveCount(0);
  await bobPage.close();

  // Alice again: her draft is back.
  const alicePage = await context.newPage();
  await signInApi(alicePage.request, baseURL!, alice);
  await openEditorPage(alicePage, '/new');
  await expect(alicePage.getByTestId('new-draft-notice')).toBeVisible();
  expect(await editorTexts(alicePage)).toEqual(['Alice only']);
});
