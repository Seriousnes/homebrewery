// The admin pages (P7.4) end to end against a real API: only the Admin role gets them (anonymous
// visitors the sign-in page, other accounts a 403 page); totals; user lookup with every brew of
// the account; brew lookup by edit id; lock, review request, dismiss and unlock (each confirmed);
// notifications create/edit/delete with the live preview and the site banner. Axe on every page.
//
//   node e2e/admin/run-admin.mjs                  (from web/; private API :5473, Vite :5373)
//
// Skipped without a private API (HB_API_URL); the admin tests also need an Admin__Emails account:
// ADMIN_E2E_EMAIL (run-admin.mjs) or FLOWS_ADMIN_EMAIL (e2e/matrix/run-suite.mjs, e2e/flows/run-flows.mjs).
// The database is shared by parallel workers and both browsers: every test makes its own users,
// brews and notification keys, and finds its own rows among others'.
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Locator, type Page, type PlaywrightWorkerArgs, test } from '@playwright/test';

/** A page load, or a page's data after an action (admin pages have no editor: a few seconds). */
const LOAD = { timeout: 10_000 };
const PASSWORD = 'Passw0rd!';
const apiUrl = process.env.HB_API_URL ?? '';
/** A private API behind the Vite proxy (never the humans' :5080 or :8080). */
const privateApi = /^https?:\/\/[^/]+:\d+/.test(apiUrl) && !/:(5080|8080)(\/|$)/.test(apiUrl);
const ADMIN_EMAIL = process.env.ADMIN_E2E_EMAIL ?? process.env.FLOWS_ADMIN_EMAIL ?? '';

test.skip(!privateApi, 'Needs a private API: node e2e/admin/run-admin.mjs');

const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function register(request: APIRequestContext, baseURL: string, email: string): Promise<void> {
  // Parallel workers may register the admin account at once; the API answers 200 when it exists.
  for (let attempt = 0; ; attempt++) {
    const response = await request.post('/api/auth/register', {
      data: { email, password: PASSWORD },
      headers: { Origin: baseURL },
    });
    if (response.status() === 200 || attempt >= 2) {
      expect(response.status(), await response.text()).toBe(200);
      return;
    }
  }
}

async function signIn(request: APIRequestContext, baseURL: string, email: string): Promise<{ handle: string; roles: string[] }> {
  const login = await request.post('/api/auth/login?useCookies=true', {
    data: { email, password: PASSWORD },
    headers: { Origin: baseURL },
  });
  expect(login.status(), await login.text()).toBe(200);
  const me = await request.get('/api/account/me');
  expect(me.status()).toBe(200);
  return (await me.json()) as { handle: string; roles: string[] };
}

/** Signs the page's context in as the admin (skips the test when the API has no such admin). */
async function signInAdmin(page: Page, baseURL: string): Promise<void> {
  test.skip(!ADMIN_EMAIL, 'Needs ADMIN_E2E_EMAIL (an Admin__Emails account of the API); run-admin.mjs sets it');
  await register(page.request, baseURL, ADMIN_EMAIL);
  const me = await signIn(page.request, baseURL, ADMIN_EMAIL);
  test.skip(!me.roles.includes('Admin'), `${ADMIN_EMAIL} is not an admin of this API (Admin__Emails)`);
}

interface Author {
  request: APIRequestContext;
  handle: string;
  email: string;
  close: () => Promise<void>;
}

/** A new account with its own cookies (an API request context: no browser context needed). */
async function newAuthor(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string, prefix: string): Promise<Author> {
  const request = await playwright.request.newContext({ baseURL });
  const email = `${unique(prefix)}@e2e.test`;
  await register(request, baseURL, email);
  const me = await signIn(request, baseURL, email);
  return { request, handle: me.handle, email, close: () => request.dispose() };
}

interface Brew {
  editId: string;
  shareId: string;
}

async function createBrew(author: Author, baseURL: string, title: string, published = false): Promise<Brew> {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'page',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: `${title} text` }],
          },
        ],
      },
    ],
  };
  const response = await author.request.post('/api/brews', {
    data: { doc, meta: { title, published } },
    headers: { Origin: baseURL },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Brew;
}

/**
 * Axe violations (all impacts) as readable strings. Legacy mode runs axe in the page itself: the
 * default mode finishes in a new blank page, and in Firefox under load that newPage (or the evaluate
 * on it) hung until the test timed out (the lists lane found the same). The admin pages have no
 * iframes, which is all the default mode adds.
 */
async function violations(page: Page, impacts: 'all' | 'serious' = 'all'): Promise<string[]> {
  const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  return results.violations
    .filter((v) => impacts === 'all' || v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact ?? 'unknown'}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const heading1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
const adminNav = (page: Page) => page.getByRole('navigation', { name: 'Admin sections' });
const confirmDialog = (page: Page) => page.getByRole('alertdialog');

/** Confirms the open alertdialog with its action button, and waits for it to close. */
async function confirmWith(page: Page, action: string): Promise<void> {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toBeHidden(LOAD);
}

const shareStatus = async (request: APIRequestContext, shareId: string) => (await request.get(`/api/brews/share/${shareId}`)).status();

/**
 * page.goto in two steps (commit, then DOMContentLoaded). Firefox under load sometimes stalled
 * here for minutes after the document committed (seen with Playwright 1.63.0 while other suites ran
 * on the machine); every test therefore loads the app once and navigates inside it afterwards.
 */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit', ...LOAD });
  await page.waitForLoadState('domcontentloaded', LOAD);
}

/** Signs in with the sign-in form shown in place of the page. */
async function signInWithForm(page: Page, email: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Sign in' });
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in' }).click();
}

// One page load: anonymous → another account signs in with the form in place → 403 → it signs out
// from the navbar → the admin signs in with the form → the page.
test('anonymous visitors get the sign-in page and other accounts a 403 page; an admin signs in on it', async ({
  page,
  playwright,
  baseURL,
}) => {
  const other = await newAuthor(playwright, baseURL!, 'admin-e2e-user');
  try {
    expect((await other.request.get('/api/admin/stats')).status()).toBe(403);
  } finally {
    await other.close();
  }
  if (ADMIN_EMAIL) {
    const adminApi = await playwright.request.newContext({ baseURL });
    try {
      await register(adminApi, baseURL!, ADMIN_EMAIL);
    } finally {
      await adminApi.dispose();
    }
  }

  await open(page, '/admin/locks');
  await expect(heading1(page, 'Sign in required')).toBeVisible(LOAD);
  await expect(adminNav(page)).toHaveCount(0);
  expect(await violations(page)).toEqual([]);

  await signInWithForm(page, other.email);
  await expect(heading1(page, 'Access denied')).toBeVisible(LOAD);
  await expect(page.getByText('This page is only for administrators.')).toBeVisible();
  await expect(adminNav(page)).toHaveCount(0);
  expect(await violations(page)).toEqual([]);

  const main = page.getByRole('navigation', { name: 'Main' });
  await main.getByRole('button', { name: `Account: ${other.handle}` }).click();
  // The account panel is a popover in the portal layer, outside the navigation element.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(heading1(page, 'Sign in required')).toBeVisible(LOAD);

  test.skip(!ADMIN_EMAIL, 'Needs ADMIN_E2E_EMAIL (an Admin__Emails account of the API); run-admin.mjs sets it');
  await signInWithForm(page, ADMIN_EMAIL);
  await expect(heading1(page, 'Locks')).toBeVisible(LOAD);
  await expect(adminNav(page).getByRole('link', { name: /^Locks/ })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/\/admin\/locks$/);
});

test('the overview shows the site totals and leads to the tools', async ({ page, baseURL }) => {
  await signInAdmin(page, baseURL!);
  await open(page, '/admin');
  await expect(heading1(page, 'Admin')).toBeVisible(LOAD);
  await expect(page).toHaveTitle('Admin - The Homebrewery');
  const stats = page.getByTestId('admin-stats');
  await expect(stats).toBeVisible(LOAD);
  for (const key of ['brews', 'publishedBrews', 'users', 'lockedBrews', 'pendingReviews']) {
    await expect(page.getByTestId(`admin-stat-${key}-value`)).toHaveText(/^\d[\d,.\s]*$/);
  }
  const users = Number((await page.getByTestId('admin-stat-users-value').textContent())!.replace(/\D/g, ''));
  expect(users).toBeGreaterThanOrEqual(1);
  expect(await violations(page)).toEqual([]);

  // Keyboard: a section link by Enter.
  await adminNav(page).getByRole('link', { name: 'Users', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(heading1(page, 'Users')).toBeVisible(LOAD);
  await expect(page).toHaveURL(/\/admin\/users$/);

  // Dark scheme too (the UI kit follows prefers-color-scheme live).
  await page.emulateMedia({ colorScheme: 'dark' });
  await adminNav(page).getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('admin-stats')).toBeVisible(LOAD);
  expect(await violations(page)).toEqual([]);
});

test('user lookup: search, the account, and every brew it has', async ({ page, playwright, baseURL }) => {
  await signInAdmin(page, baseURL!);
  const author = await newAuthor(playwright, baseURL!, 'admin-e2e-author');
  try {
    const hidden = await createBrew(author, baseURL!, `Hidden ${unique('b')}`, false);
    const shown = await createBrew(author, baseURL!, `Shown ${unique('b')}`, true);

    await open(page, '/admin/users');
    await expect(heading1(page, 'Users')).toBeVisible(LOAD);
    const search = page.getByRole('searchbox', {
      name: 'Handle, email or user id',
    });
    await search.fill(author.email.toUpperCase());
    await search.press('Enter');
    await expect(page).toHaveURL(/\/admin\/users\?q=/);
    await expect(page.getByTestId('admin-user-count')).toHaveText(/^1 account matches/, LOAD);
    const row = page.getByTestId('admin-user-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(author.email);
    await expect(row.getByRole('cell').nth(2)).toHaveText('2');
    expect(await violations(page)).toEqual([]);

    await row.getByRole('link', { name: author.handle }).click();
    await expect(heading1(page, `User ${author.handle}`)).toBeVisible(LOAD);
    const details = page.getByTestId('admin-user-details');
    await expect(details).toContainText(author.email);
    await expect(details).toContainText('Brews');
    const brews = page.getByTestId('admin-user-brew-row');
    await expect(brews).toHaveCount(2, LOAD);
    const hiddenRow = brews.filter({ hasText: 'Hidden' });
    await expect(hiddenRow).toContainText('Unpublished');
    await expect(hiddenRow).toContainText('owner');
    await expect(brews.filter({ hasText: 'Shown' })).toContainText('Published');
    await expect(brews.filter({ hasText: 'Shown' }).getByRole('link', { name: shown.shareId })).toHaveAttribute(
      'href',
      `/share/${shown.shareId}`,
    );
    expect(await violations(page)).toEqual([]);

    // The title opens the brew lookup with its details.
    await hiddenRow.getByRole('link', { name: /^Hidden/ }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/brews/${hidden.shareId}$`));
    await expect(page.getByTestId('admin-brew-edit-id')).toHaveText(hidden.editId, LOAD);
    await expect(page.getByTestId('admin-brew-authors')).toHaveText(`${author.handle} (owner)`);
  } finally {
    await author.close();
  }
});

test('lock tools: lock with the default code, review request, dismiss and unlock', async ({ page, playwright, baseURL }) => {
  await signInAdmin(page, baseURL!);
  const author = await newAuthor(playwright, baseURL!, 'admin-e2e-locked');
  try {
    const title = `Lockable ${unique('b')}`;
    const brew = await createBrew(author, baseURL!, title, true);
    expect(await shareStatus(page.request, brew.shareId)).toBe(200);

    // Look it up by its edit id.
    await open(page, '/admin/brews');
    await expect(heading1(page, 'Brews')).toBeVisible(LOAD);
    await page.getByRole('searchbox', { name: 'Share id, edit id or internal id' }).fill(brew.editId);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByTestId('admin-brew-share-id')).toHaveText(brew.shareId, LOAD);
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    await expect(page.getByTestId('admin-lock-none')).toBeVisible();

    // The form: upstream's code 455 and default public message; the private one is required.
    const form = page.getByTestId('admin-lock-form');
    await expect(form.getByLabel(/^Lock code/)).toHaveValue('455');
    await expect(form.getByLabel(/^Message to readers/)).toHaveValue('This Brew has been locked.');
    await form.getByRole('button', { name: 'Lock brew' }).click();
    await expect(form.getByLabel(/^Message to the authors/)).toBeFocused();
    await expect(confirmDialog(page)).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    // By keyboard: type the message, submit with Enter on the button, confirm in the dialog.
    await page.keyboard.type('Please remove the copied rules text.');
    await form.getByRole('button', { name: 'Lock brew' }).focus();
    await page.keyboard.press('Enter');
    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Lock this brew?' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await violations(page, 'serious')).toEqual([]);
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Lock brew' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden(LOAD);

    await expect(page.getByTestId('admin-lock-code')).toHaveText('455 Generic lock');
    await expect(page.getByTestId('admin-lock-edit-message')).toHaveText('Please remove the copied rules text.');
    await expect(page.getByTestId('admin-lock-share-message')).toHaveText('This Brew has been locked.');
    await expect(page.getByTestId('admin-brew-locked')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Lock', exact: true })).toBeFocused();
    const blocked = await page.request.get(`/api/brews/share/${brew.shareId}`);
    expect(blocked.status()).toBe(423);
    expect(await blocked.json()).toMatchObject({
      code: 455,
      detail: 'This Brew has been locked.',
    });
    expect(await violations(page)).toEqual([]);

    // The author asks for a review; the review queue lists the brew.
    const review = await author.request.post(`/api/brews/${brew.editId}/lock/review`, { headers: { Origin: baseURL! } });
    expect(review.status(), await review.text()).toBe(200);
    await adminNav(page)
      .getByRole('link', { name: /^Locks/ })
      .click();
    await expect(heading1(page, 'Locks')).toBeVisible(LOAD);
    const queueRow = page.getByTestId('admin-review-queue').locator(`[data-share-id="${brew.shareId}"]`);
    const lockedRow = page.getByTestId('admin-locked-brews').locator(`[data-share-id="${brew.shareId}"]`);
    await expect(queueRow).toBeVisible(LOAD);
    await expect(queueRow).toContainText(author.handle);
    await expect(queueRow).toContainText('Requested');
    await expect(lockedRow).toBeVisible();
    await expect(
      adminNav(page).getByRole('link', {
        name: /^Locks, \d+ awaiting review$/,
      }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);

    // Dismiss the request (cancelled once first): it leaves the queue, the brew stays locked.
    await queueRow.getByRole('button', { name: `Dismiss request for ${title}` }).click();
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog(page)).toBeHidden();
    await expect(queueRow.getByRole('button', { name: `Dismiss request for ${title}` })).toBeFocused();
    await queueRow.getByRole('button', { name: `Dismiss request for ${title}` }).click();
    await confirmWith(page, 'Dismiss request');
    await expect(queueRow).toHaveCount(0, LOAD);
    await expect(lockedRow).toBeVisible();
    await expect(lockedRow).toContainText('Not requested');
    await expect(page.getByRole('heading', { level: 2, name: /^Review queue/ })).toBeFocused();
    expect(await shareStatus(page.request, brew.shareId)).toBe(423);

    // Unlock from the locked list: the share page opens again.
    await lockedRow.getByRole('button', { name: `Unlock ${title}` }).click();
    await confirmWith(page, 'Unlock');
    await expect(lockedRow).toHaveCount(0, LOAD);
    await expect(page.getByRole('heading', { level: 2, name: /^Locked brews/ })).toBeFocused();
    expect(await shareStatus(page.request, brew.shareId)).toBe(200);

    // The brew's own page agrees (fetched again, not from before the unlock).
    await adminNav(page).getByRole('link', { name: 'Brews', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Share id, edit id or internal id' }).fill(brew.shareId);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('admin-brew-share-id')).toHaveText(brew.shareId, LOAD);
    await expect(page.getByTestId('admin-lock-none')).toBeVisible(LOAD);
  } finally {
    await author.close();
  }
});

test.describe('dark scheme', () => {
  // The scheme as a context option (not emulateMedia right before the navigation).
  test.use({ colorScheme: 'dark' });

  test('lock tools on the brew page: relock replaces the lock and clears the review; unlock there', async ({
    page,
    playwright,
    baseURL,
  }) => {
    await signInAdmin(page, baseURL!);
    const author = await newAuthor(playwright, baseURL!, 'admin-e2e-relock');
    try {
      const brew = await createBrew(author, baseURL!, `Relock ${unique('b')}`);
      const locked = await page.request.put(`/api/admin/brews/${brew.shareId}/lock`, {
        data: {
          code: 456,
          editMessage: 'Credit the artist.',
          shareMessage: 'Locked for now.',
        },
        headers: { Origin: baseURL! },
      });
      expect(locked.status(), await locked.text()).toBe(200);
      expect(
        (
          await author.request.post(`/api/brews/${brew.editId}/lock/review`, {
            headers: { Origin: baseURL! },
          })
        ).status(),
      ).toBe(200);

      await open(page, `/admin/brews/${brew.editId}`);
      await expect(page.getByTestId('admin-lock-code')).toHaveText('456 Copyright issues', LOAD);
      await expect(page.getByTestId('admin-lock-review')).toContainText('Requested');
      expect(await violations(page)).toEqual([]);

      const form = page.getByTestId('admin-lock-form');
      await expect(form.getByLabel(/^Lock code/)).toHaveValue('456');
      await form.getByText('Suggested codes').click();
      await form.getByRole('button', { name: '463 Plagiarism' }).click();
      await expect(form.getByLabel(/^Lock code/)).toHaveValue('463');
      await form.getByRole('button', { name: 'Update lock' }).click();
      await confirmWith(page, 'Update lock');
      await expect(page.getByTestId('admin-lock-code')).toHaveText('463 Plagiarism');
      await expect(page.getByTestId('admin-lock-review')).toHaveText('Not requested');
      await expect(page.getByTestId('admin-dismiss-review')).toHaveCount(0);

      await page.getByTestId('admin-unlock').click();
      await confirmWith(page, 'Unlock');
      await expect(page.getByTestId('admin-lock-none')).toBeVisible();
      await expect(form.getByLabel(/^Lock code/)).toHaveValue('455');
      expect(await shareStatus(page.request, brew.shareId)).not.toBe(423);
    } finally {
      await author.close();
    }
  });
});

test('notifications: create with a live preview, edit, show in the banner, delete', async ({ page, baseURL }) => {
  await signInAdmin(page, baseURL!);
  const key = unique('admin-e2e-notice');
  const title = `Notice ${key}`;
  const row = (p: Page): Locator => p.locator(`[data-testid="admin-notification-row"][data-dismiss-key="${key}"]`);
  let createdId: string | null = null;
  try {
    await open(page, '/admin/notifications');
    await expect(heading1(page, 'Notifications')).toBeVisible(LOAD);
    await page.getByRole('link', { name: 'New notification' }).click();
    await expect(heading1(page, 'New notification')).toBeVisible(LOAD);

    // The preview follows the form. It starts tomorrow, so nobody sees it while it is edited.
    const preview = page.getByTestId('admin-notification-preview');
    await expect(preview.getByTestId('admin-preview-title')).toHaveText('The title goes here');
    await page.getByLabel(/^Dismiss key/).fill(key);
    await page.getByLabel(/^Title/).fill(title);
    await page.getByLabel(/^Message/).fill('Saving pauses tonight.\nBack by midnight.');
    await expect(preview.getByTestId('admin-preview-title')).toHaveText(title);
    await expect(preview.getByTestId('admin-preview-body')).toHaveText('Saving pauses tonight.\nBack by midnight.', { useInnerText: true });
    const start = await page.getByLabel(/^Start time/).inputValue();
    const tomorrow = new Date(Date.parse(`${start}:00`) + 86_400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    await page.getByLabel(/^Start time/).fill(local(tomorrow));
    await expect(page.getByTestId('admin-preview-when')).toContainText('Scheduled.');
    // An end before the start is refused before sending.
    await page.getByLabel(/^End time/).fill(local(new Date(tomorrow.getTime() - 3_600_000)));
    await page.getByRole('button', { name: 'Create notification' }).click();
    await expect(page.getByLabel(/^End time/)).toBeFocused();
    await expect(page.getByText('The end must be after the start.')).toBeVisible();
    await page.getByLabel(/^End time/).fill(local(new Date(tomorrow.getTime() + 2 * 86_400_000)));
    expect(await violations(page)).toEqual([]);

    const created = page.waitForResponse((r) => r.url().endsWith('/api/admin/notifications') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create notification' }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    createdId = ((await response.json()) as { id: string }).id;
    await expect(page).toHaveURL(/\/admin\/notifications$/, LOAD);
    await expect(row(page)).toContainText('Scheduled');
    expect(await violations(page)).toEqual([]);

    // A second notification with the same key is refused on the key field.
    await page.getByRole('link', { name: 'New notification' }).click();
    await expect(heading1(page, 'New notification')).toBeVisible(LOAD);
    await page.getByLabel(/^Dismiss key/).fill(key);
    await page.getByLabel(/^Title/).fill('Duplicate');
    await page.getByRole('button', { name: 'Create notification' }).click();
    await expect(page.getByLabel(/^Dismiss key/)).toBeFocused(LOAD);
    await expect(page.getByLabel(/^Dismiss key/)).toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('link', { name: 'Cancel' }).click();

    // Edit: start now (empty start). It shows in the site banner.
    await row(page)
      .getByRole('link', { name: `Edit ${title}` })
      .click();
    await expect(heading1(page, 'Edit notification')).toBeVisible(LOAD);
    await expect(page.getByLabel(/^Title/)).toHaveValue(title);
    await page.getByLabel(/^Start time/).fill('');
    await expect(page.getByTestId('admin-preview-when')).toContainText('Showing now.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page).toHaveURL(/\/admin\/notifications$/, LOAD);
    await expect(row(page)).toContainText('Showing now');
    const banner = page.getByRole('region', { name: 'Site notices' });
    await expect(banner.getByText(title)).toBeVisible(LOAD);
    expect(await violations(page)).toEqual([]);

    // Delete (confirmed): gone from the list and from the banner (the site notices are fetched again).
    await row(page)
      .getByRole('button', { name: `Delete ${title}` })
      .click();
    await expect(confirmDialog(page)).toContainText(key);
    expect(await violations(page, 'serious')).toEqual([]);
    await confirmWith(page, 'Delete');
    await expect(row(page)).toHaveCount(0, LOAD);
    createdId = null;
    await expect(banner.getByText(title)).toHaveCount(0, LOAD);
  } finally {
    // Never leave a notice behind for the other tests' pages.
    if (createdId)
      await page.request.delete(`/api/admin/notifications/${createdId}`, {
        headers: { Origin: baseURL! },
      });
  }
});
