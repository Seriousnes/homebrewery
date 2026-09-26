// Accounts against the real API (plan §8.6, §9): register → account → handle change → sign out
// → sign in; the sign-in prompts; site notices. Needs an API behind the Vite proxy:
//
//   Admin__Emails=shell-admin@e2e.test dotnet run --project src/Homebrewery.Api \
//     --artifacts-path <tmp> --no-launch-profile --urls http://localhost:5421
//   (env ASPNETCORE_ENVIRONMENT=Development; compose db up)
//   cd web && HB_API_URL=http://localhost:5421 E2E_PORT=5321 npx playwright test e2e/shell
//
// Without a private API (HB_API_URL, never the humans' :5080/:8080) or with none reachable, these
// tests are skipped (the stubbed shell.spec.ts still runs). The notices test also needs
// Admin__Emails as above, or it is skipped.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { allViolations, apiIsUp, PAGE_READY, PASSWORD, signedInApi, uniqueEmail } from './helpers';

const ADMIN_EMAIL = 'shell-admin@e2e.test';
const apiUrl = process.env.HB_API_URL ?? '';
const privateApi = /^https?:\/\/[^/]+:\d+/.test(apiUrl) && !/:(5080|8080)(\/|$)/.test(apiUrl);

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test.skip(!privateApi, 'Needs a private API behind the Vite proxy: HB_API_URL (see the top of this file).');

test.beforeEach(async ({ request }) => {
  test.skip(!(await apiIsUp(request)), 'No API behind the Vite proxy: start one and set HB_API_URL (see the top of this file).');
});

async function register(page: Page, email: string, returnTo?: string) {
  await page.goto(returnTo ? `/register?returnTo=${encodeURIComponent(returnTo)}` : '/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function signIn(scope: Locator, email: string) {
  await scope.getByLabel('Email').fill(email);
  await scope.getByLabel('Password').fill(PASSWORD);
  await scope.getByRole('button', { name: 'Sign in' }).click();
}

test('register → account shows the handle → change it → sign out → sign in again', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const email = uniqueEmail('shell');
  const localPart = email.split('@')[0] ?? '';

  // Another account owns a handle, so it can't be taken.
  const other = await signedInApi(playwright, baseURL ?? '', uniqueEmail('shell-other'));
  const takenHandle = `taken-${Date.now().toString(36)}`;
  expect((await other.put('/api/account/handle', { data: { handle: takenHandle } })).status()).toBe(200);
  await other.dispose();

  // Register: signed in at once, on /account with the default handle and a welcome.
  await register(page, email, '/vault');
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId('account-welcome')).toContainText('Your account is ready.');
  await expect(page.getByTestId('account-email')).toHaveText(email);
  const handle = page.getByTestId('account-handle');
  await expect(handle).toHaveText(localPart);
  await expect(page.getByTestId('account-brew-count')).toHaveText('0');
  await expect(nav(page).getByRole('button', { name: `Account: ${localPart}` })).toBeVisible();
  await expect(page.getByTestId('account-welcome').getByRole('link', { name: 'Continue where you were' })).toHaveAttribute('href', '/vault');
  // Axe on a real account page (shell.spec.ts scans every shell page and the dialog, stubbed).
  expect(await allViolations(page)).toEqual([]);

  // The API's validation message shows on the field.
  const input = page.getByLabel('Public handle');
  await input.fill('No Spaces!');
  await page.getByRole('button', { name: 'Save handle' }).click();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAccessibleDescription(/A handle is 3 to 32 characters/);
  await expect(input).toBeFocused();

  // A taken handle: the API's 409 detail.
  await input.fill(takenHandle.toUpperCase());
  await page.getByRole('button', { name: 'Save handle' }).click();
  await expect(input).toHaveAccessibleDescription(new RegExp(`The handle '${takenHandle}' is already in use`));

  // A free one.
  const newHandle = `e2e-${Date.now().toString(36)}`;
  await input.fill(newHandle);
  await page.getByRole('button', { name: 'Save handle' }).click();
  await expect(page.getByTestId('handle-status')).toContainText(`Your handle is now ${newHandle}.`);
  await expect(handle).toHaveText(newHandle);
  await expect(input).not.toHaveAttribute('aria-invalid');
  await expect(nav(page).getByRole('button', { name: `Account: ${newHandle}` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Your brews' })).toHaveAttribute('href', `/user/${newHandle}`);

  // Sign out from the navbar: the "Sign in" link takes focus; /account asks to sign in.
  await nav(page).getByRole('button', { name: `Account: ${newHandle}` }).click();
  await page.getByRole('group', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
  const signInLink = nav(page).getByRole('link', { name: 'Sign in' });
  await expect(signInLink).toBeFocused();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in required' })).toBeVisible();
  await expect(page.locator('[data-toast-id]').filter({ hasText: "You're signed out." })).toBeVisible();
  expect((await page.request.get('/api/account/me')).status()).toBe(204);

  // Sign in on the page itself.
  await signIn(page.getByTestId('sign-in-required'), email);
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  await expect(handle).toHaveText(newHandle);

  // Sign out from the account page, then sign in through /login with a returnTo.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in required' })).toBeVisible();
  await page.goto('/login?returnTo=%2Faccount');
  await signIn(page.getByTestId('login-form'), email);
  await expect(page).toHaveURL(/\/account$/);
  await expect(handle).toHaveText(newHandle);
});

test('change the password on /account: the API checks it; this session stays signed in', async ({ page, playwright, baseURL }) => {
  const email = uniqueEmail('shell-password');
  const api = await signedInApi(playwright, baseURL ?? '', email);
  await api.dispose();
  await page.goto('/login?returnTo=%2Faccount');
  await signIn(page.getByTestId('login-form'), email);
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

  const form = page.getByRole('form', { name: 'Change your password' });
  const current = form.getByLabel(/^Current password/);
  const next = form.getByLabel(/^New password/);
  const confirm = form.getByLabel(/^Confirm new password/);
  const NEW_PASSWORD = 'Changed-passw0rd';

  // Identity's answers: a wrong current password, then its password rules.
  await current.fill('Wrong-passw0rd');
  await next.fill(NEW_PASSWORD);
  await confirm.fill(NEW_PASSWORD);
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(current).toHaveAccessibleDescription('The current password is not correct.');
  await expect(current).toBeFocused();
  await current.fill(PASSWORD);
  await next.fill('short');
  await confirm.fill('short');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(next).toHaveAttribute('aria-invalid', 'true');
  await expect(next).toHaveAccessibleDescription(/at least 6 characters/);

  await next.fill(NEW_PASSWORD);
  await confirm.fill(NEW_PASSWORD);
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByRole('status')).toHaveText('Your password was changed.');
  await expect(current).toHaveValue('');
  expect(await allViolations(page)).toEqual([]);
  // Still signed in (the page signed in again with the new password).
  expect((await page.request.get('/api/account/me')).status()).toBe(200);

  // The old password no longer works; the new one does.
  const old = await playwright.request.newContext({ baseURL: baseURL ?? '', extraHTTPHeaders: { Origin: baseURL ?? '' } });
  expect((await old.post('/api/auth/login?useCookies=true', { data: { email, password: PASSWORD } })).status()).toBe(401);
  expect((await old.post('/api/auth/login?useCookies=true', { data: { email, password: NEW_PASSWORD } })).status()).toBe(200);
  await old.dispose();
});

test('wrong password and an existing email get clear messages', async ({ page, playwright, baseURL }) => {
  const email = uniqueEmail('shell-existing');
  const api = await signedInApi(playwright, baseURL ?? '', email);
  await api.dispose();

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('Wrong-passw0rd');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('The email or password is not correct.');
  await expect(page.getByLabel('Password')).toBeFocused();

  // Registering the same email again with another password: the API answers 200 (no account
  // enumeration), the sign-in that follows fails, and the form suggests signing in.
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill('Other-passw0rd');
  await page.getByLabel('Confirm password').fill('Other-passw0rd');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('If you already have an account, sign in instead.');
});

test('protected pages while signed out: the sign-in prompt', async ({ page, playwright, baseURL }) => {
  const email = uniqueEmail('shell-prompt');
  const api = await signedInApi(playwright, baseURL ?? '', email);
  await api.dispose();

  // A page that needs an account shows the sign-in form in place.
  await page.goto('/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in required' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A request that gets 401 opens the sign-in dialog; signing in there retries the request.
  await page.goto('/dev/shell', { waitUntil: 'domcontentloaded' });
  // The dev pages load every harness (editor code included): about 7 s in Firefox under load.
  await expect(page.getByTestId('me')).toHaveText('nobody', PAGE_READY);
  await page.getByTestId('load-protected').click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Your session may have ended.');
  await expect(dialog.getByLabel('Email')).toBeFocused();
  await signIn(dialog, email);
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-toast-id]').filter({ hasText: 'Signed in as ' })).toBeVisible();
  await expect(page.getByTestId('me')).not.toHaveText('nobody');
  // Refetched as a signed-in (non-admin) user: now 403.
  await expect(page.getByTestId('protected-status')).toHaveText(/^error 403/);
});

test('site notices from the API show and stay dismissed', async ({ page, playwright, baseURL }) => {
  const admin = await signedInApi(playwright, baseURL ?? '', ADMIN_EMAIL);
  const probe = await admin.get('/api/admin/stats');
  test.skip(probe.status() === 403, `Start the API with Admin__Emails=${ADMIN_EMAIL} to run this test.`);
  expect(probe.status()).toBe(200);

  const key = `shell-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const title = `E2E notice ${key}`;
  const created = await admin.post('/api/admin/notifications', {
    data: {
      dismissKey: key,
      title,
      body: 'Shown by the app shell e2e test.\nIt is deleted when the test ends.',
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      stopsAt: new Date(Date.now() + 3 * 60_000).toISOString(),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  try {
    await page.goto('/vault');
    const notice = page.getByRole('region', { name: 'Site notices' }).getByRole('listitem').filter({ hasText: title });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Shown by the app shell e2e test.');
    await notice.getByRole('button', { name: `Dismiss notice: ${title}` }).click();
    await expect(notice).toBeHidden();
    // After the reload's notices request has its answer, the notice is still hidden.
    const notices = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/notifications/active');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Vault' })).toBeVisible();
    await notices;
    await expect(page.getByText(title)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('hb-dismissed-notices'))).toContain(key);
  } finally {
    await admin.delete(`/api/admin/notifications/${id}`);
    await admin.dispose();
  }
});
