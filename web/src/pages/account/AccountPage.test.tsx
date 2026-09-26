import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '@/api';
import { emptyResponse, jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { ADMIN, ALICE, renderRoute } from '@/app/testing';
import { clearToasts } from '@/ui';
import AccountPage from './AccountPage';

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const RULES = "A handle is 3 to 32 characters: lower-case letters a-z, digits, '-' and '_'.";

function fakeAccountApi(start: AccountInfo = ALICE) {
  let account: AccountInfo | null = start;
  const taken = new Set(['bob']);
  return mockApi((request) => {
    if (request.url.pathname === '/api/account/me') return account ? jsonResponse(account) : emptyResponse(204);
    if (request.url.pathname === '/api/account/logout') {
      account = null;
      return emptyResponse(204);
    }
    if (request.url.pathname === '/api/account/handle') {
      const handle = String((request.json as { handle: string }).handle).trim().toLowerCase();
      if (!/^[a-z0-9_-]{3,32}$/.test(handle)) return problemResponse(400, { title: 'One or more validation errors occurred.', errors: { handle: [RULES] } });
      if (taken.has(handle)) return problemResponse(409, { title: 'Handle taken', detail: `The handle '${handle}' is already in use.` });
      if (!account) return problemResponse(401, { title: 'Unauthorized' });
      account = { ...account, handle };
      return jsonResponse(account);
    }
    if (request.url.pathname.startsWith('/api/users/')) return jsonResponse({ handle: account?.handle, own: true, items: [], total: 3 });
    return jsonResponse([]);
  });
}

describe('AccountPage', () => {
  it('shows the account and links to the brews', async () => {
    fakeAccountApi();
    renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    expect(screen.getByTestId('account-email')).toHaveTextContent('alice@example.test');
    expect(screen.getByTestId('account-handle')).toHaveTextContent('alice');
    expect(screen.getByRole('link', { name: 'Your brews' })).toHaveAttribute('href', '/user/alice');
    expect(screen.queryByRole('link', { name: 'Admin pages' })).toBeNull();
    expect(screen.getByLabelText(/Public handle/)).toHaveValue('alice');
    await waitFor(() => expect(screen.getByTestId('account-brew-count')).toHaveTextContent('3'));
  });

  it('admins get a link to the admin pages', () => {
    fakeAccountApi(ADMIN);
    renderRoute(<AccountPage />, { url: '/account', me: ADMIN });
    expect(screen.getByRole('link', { name: 'Admin pages' })).toHaveAttribute('href', '/admin');
  });

  it("shows the API's validation and conflict messages on the handle field", async () => {
    const api = fakeAccountApi();
    const { user } = renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    const input = screen.getByLabelText(/Public handle/);

    await user.clear(input);
    await user.type(input, 'No Spaces!');
    await user.click(screen.getByRole('button', { name: 'Save handle' }));
    await waitFor(() => expect(input).toHaveAccessibleDescription(expect.stringContaining(RULES)));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
    expect(api.last().json).toEqual({ handle: 'No Spaces!' });

    await user.clear(input);
    await user.type(input, 'Bob');
    await user.click(screen.getByRole('button', { name: 'Save handle' }));
    await waitFor(() => expect(input).toHaveAccessibleDescription(expect.stringContaining("The handle 'bob' is already in use.")));
  });

  it('changes the handle and says so', async () => {
    fakeAccountApi();
    const { user } = renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    const input = screen.getByLabelText(/Public handle/);
    await user.clear(input);
    await user.type(input, 'Alice-The-Bold');
    await user.click(screen.getByRole('button', { name: 'Save handle' }));
    await waitFor(() => expect(screen.getByTestId('account-handle')).toHaveTextContent('alice-the-bold'));
    expect(input).toHaveValue('alice-the-bold');
    expect(screen.getByTestId('handle-status')).toHaveTextContent('Your handle is now alice-the-bold.');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('link', { name: 'Your brews' })).toHaveAttribute('href', '/user/alice-the-bold');
  });

  it('asks for a handle instead of sending an empty one, and notices an unchanged one', async () => {
    const api = fakeAccountApi();
    const { user } = renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    const input = screen.getByLabelText(/Public handle/);
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Save handle' }));
    expect(input).toHaveAccessibleDescription(expect.stringContaining('Enter a handle.'));
    await user.type(input, ' ALICE ');
    await user.click(screen.getByRole('button', { name: 'Save handle' }));
    expect(screen.getByTestId('handle-status')).toHaveTextContent('Your handle is already alice.');
    expect(api.requests.filter((r) => r.url.pathname === '/api/account/handle')).toHaveLength(0);
  });

  it('shows no welcome on an ordinary visit', () => {
    fakeAccountApi();
    renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    expect(screen.queryByTestId('account-welcome')).toBeNull();
  });

  it('signs out: the page turns into the sign-in prompt', async () => {
    fakeAccountApi();
    const { user } = renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in required' })).toBeInTheDocument();
    expect(within(screen.getByTestId('sign-in-required')).getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
    // No dialog on top of the inline form.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('AccountPage welcome', () => {
  it('shows the welcome with a continue link from the router state', async () => {
    fakeAccountApi();
    const { router } = renderRoute(<AccountPage />, { url: '/elsewhere', me: ALICE });
    await router.navigate('/account', { state: { welcome: true, returnTo: '/edit/abc' } });
    const welcome = await screen.findByTestId('account-welcome');
    expect(welcome).toHaveTextContent('Your account is ready.');
    expect(within(welcome).getByRole('link', { name: 'Continue where you were' })).toHaveAttribute('href', '/edit/abc');
  });
});

describe('AccountPage: change the password', () => {
  /** POST /api/auth/manage/info as Identity answers it; the current password is 'Old-pass1'. */
  function passwordApi() {
    let password = 'Old-pass1';
    return mockApi((request) => {
      const path = request.url.pathname;
      if (path === '/api/account/me') return jsonResponse(ALICE);
      if (path.startsWith('/api/users/')) return jsonResponse({ handle: 'alice', own: true, items: [], total: 0 });
      if (path === '/api/auth/manage/info' && request.method === 'POST') {
        const body = request.json as { oldPassword?: string; newPassword?: string };
        if (!body.oldPassword) return problemResponse(400, { title: 'One or more validation errors occurred.', errors: { OldPasswordRequired: ['The old password is required to set a new password.'] } });
        if (body.oldPassword !== password) return problemResponse(400, { title: 'One or more validation errors occurred.', errors: { PasswordMismatch: ['Incorrect password.'] } });
        if ((body.newPassword ?? '').length < 6) {
          return problemResponse(400, {
            title: 'One or more validation errors occurred.',
            errors: { PasswordTooShort: ['Passwords must be at least 6 characters.'], PasswordRequiresDigit: ["Passwords must have at least one digit ('0'-'9')."] },
          });
        }
        password = body.newPassword ?? '';
        return jsonResponse({ email: ALICE.email, isEmailConfirmed: false });
      }
      if (path === '/api/auth/login') return emptyResponse(200);
      return jsonResponse([]);
    });
  }

  const form = () => screen.getByRole('form', { name: 'Change your password' });

  async function fill(user: ReturnType<typeof renderRoute>['user'], current: string, next: string, confirm = next) {
    if (current) await user.type(within(form()).getByLabelText(/^Current password/), current);
    if (next) await user.type(within(form()).getByLabelText(/^New password/), next);
    if (confirm) await user.type(within(form()).getByLabelText(/^Confirm new password/), confirm);
    await user.click(within(form()).getByRole('button', { name: 'Change password' }));
  }

  it('changes it, keeps this session signed in, and says so', async () => {
    const api = passwordApi();
    const { user } = renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    await fill(user, 'Old-pass1', 'New-pass2');
    expect(await within(form()).findByRole('status')).toHaveTextContent('Your password was changed.');
    const change = api.requests.find((r) => r.url.pathname === '/api/auth/manage/info');
    expect(change?.method).toBe('POST');
    expect(change?.json).toEqual({ oldPassword: 'Old-pass1', newPassword: 'New-pass2' });
    // Changing the password renews the account's security stamp; signing in again with the new
    // password keeps this session from ending at the next stamp check.
    const login = api.requests.find((r) => r.url.pathname === '/api/auth/login');
    expect(login?.json).toEqual({ email: 'alice@example.test', password: 'New-pass2' });
    for (const field of [/^Current password/, /^New password/, /^Confirm new password/]) expect(within(form()).getByLabelText(field)).toHaveValue('');
  });

  it('a wrong current password is said on that field', async () => {
    passwordApi();
    const { user } = renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    await fill(user, 'nope', 'New-pass2');
    const current = within(form()).getByLabelText(/^Current password/);
    await waitFor(() => expect(current).toHaveAccessibleDescription('The current password is not correct.'));
    expect(current).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(current).toHaveFocus());
  });

  it("the password rules the API names are said on the new password's field", async () => {
    passwordApi();
    const { user } = renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    await fill(user, 'Old-pass1', 'abc');
    const next = within(form()).getByLabelText(/^New password/);
    await waitFor(() => expect(next).toHaveAttribute('aria-invalid', 'true'));
    expect(next).toHaveAccessibleDescription(expect.stringContaining('Passwords must be at least 6 characters.'));
    expect(next).toHaveAccessibleDescription(expect.stringContaining("Passwords must have at least one digit ('0'-'9')."));
  });

  it('checks the fields before asking the API', async () => {
    const api = passwordApi();
    const { user } = renderRoute(<AccountPage />, { url: '/account', me: ALICE });
    await fill(user, '', 'New-pass2', 'New-pass3');
    expect(within(form()).getByLabelText(/^Current password/)).toHaveAccessibleDescription('Enter your current password.');
    expect(within(form()).getByLabelText(/^Confirm new password/)).toHaveAccessibleDescription("The passwords don't match.");
    expect(api.requests.some((r) => r.url.pathname === '/api/auth/manage/info')).toBe(false);
  });
});
