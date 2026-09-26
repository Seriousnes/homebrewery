import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecordedRequest } from '@/api/testing';
import { emptyResponse, jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { ALICE, renderRoute } from '@/app/testing';
import LoginPage from './LoginPage';
import RegisterPage from './RegisterPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fake Identity backend: one account, cookie state in a variable. */
function fakeAuth(options: { existing?: boolean; twoFactor?: boolean; registerErrors?: Record<string, string[]> } = {}) {
  let signedIn = false;
  const accounts = new Map<string, string>(options.existing ? [['alice@example.test', 'Passw0rd!']] : []);
  return mockApi((request: RecordedRequest) => {
    const body = request.json as { email?: string; password?: string; twoFactorCode?: string } | undefined;
    switch (request.url.pathname) {
      case '/api/account/me':
        return signedIn ? jsonResponse(ALICE) : emptyResponse(204);
      case '/api/auth/register':
        if (options.registerErrors) return problemResponse(400, { title: 'One or more validation errors occurred.', errors: options.registerErrors });
        if (body?.email && !accounts.has(body.email)) accounts.set(body.email, body.password ?? '');
        return emptyResponse(200);
      case '/api/auth/login':
        if (!body?.email || accounts.get(body.email) !== body.password) return problemResponse(401, { title: 'Unauthorized', detail: 'Failed' });
        if (options.twoFactor && body.twoFactorCode !== '123456') {
          return problemResponse(401, { title: 'Unauthorized', detail: body.twoFactorCode ? 'Failed' : 'RequiresTwoFactor' });
        }
        signedIn = true;
        return emptyResponse(200);
      default:
        return jsonResponse([]);
    }
  });
}

const location = () => screen.getByTestId('location').textContent;

describe('LoginPage', () => {
  it('validates the fields before asking the server', async () => {
    const api = fakeAuth({ existing: true });
    const { user } = renderRoute(<LoginPage />, { url: '/login' });
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText(/Email/)).toHaveAccessibleDescription('Enter your email address.');
    expect(screen.getByLabelText(/Password/)).toHaveAccessibleDescription('Enter your password.');
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(screen.getByLabelText(/Email/)).toHaveFocus());
    expect(api.requests.filter((r) => r.path.startsWith('/api/auth'))).toHaveLength(0);
  });

  it('signs in and goes to returnTo', async () => {
    const api = fakeAuth({ existing: true });
    const { user } = renderRoute(<LoginPage />, { url: '/login?returnTo=%2Fedit%2Fabc', routes: [{ path: '/edit/:id', element: <p>Editor</p> }] });
    await user.type(await screen.findByLabelText(/Email/), '  alice@example.test ');
    await user.type(screen.getByLabelText(/Password/), 'Passw0rd!');
    await user.click(screen.getByRole('checkbox', { name: 'Keep me signed in' }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(location()).toBe('/edit/abc'));
    const login = api.requests.find((r) => r.url.pathname === '/api/auth/login');
    expect(login?.path).toBe('/api/auth/login?useSessionCookies=true');
    expect(login?.json).toEqual({ email: 'alice@example.test', password: 'Passw0rd!' });
  });

  it('reports wrong credentials and focuses the password', async () => {
    fakeAuth({ existing: true });
    const { user } = renderRoute(<LoginPage />, { url: '/login' });
    await user.type(await screen.findByLabelText(/Email/), 'alice@example.test');
    await user.type(screen.getByLabelText(/Password/), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is not correct.');
    await waitFor(() => expect(screen.getByLabelText(/Password/)).toHaveFocus());
  });

  it('asks for a two-factor code when the account needs one', async () => {
    fakeAuth({ existing: true, twoFactor: true });
    const { user } = renderRoute(<LoginPage />, { url: '/login', routes: [{ path: '/', element: <p>Home</p> }] });
    await user.type(await screen.findByLabelText(/Email/), 'alice@example.test');
    await user.type(screen.getByLabelText(/Password/), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText(/Authentication code/);
    await waitFor(() => expect(code).toHaveFocus());
    await user.type(code, '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The code is not correct.');
    await user.clear(code);
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(location()).toBe('/'));
  });

  it('sends a signed-in visitor on, and links to registration with the returnTo', async () => {
    fakeAuth();
    renderRoute(<LoginPage />, { url: '/login?returnTo=%2Fvault', routes: [{ path: '/vault', element: <p>Vault</p> }] });
    expect(await screen.findByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/register?returnTo=%2Fvault');

    vi.unstubAllGlobals();
    fakeAuth();
    renderRoute(<LoginPage />, { url: '/login?returnTo=%2Fvault', me: ALICE, routes: [{ path: '/vault', element: <p>Vault</p> }] });
    await waitFor(() => expect(screen.getAllByTestId('location').at(-1)?.textContent).toBe('/vault'));
  });

  it('ignores an unsafe returnTo', async () => {
    fakeAuth({ existing: true });
    const { user } = renderRoute(<LoginPage />, { url: '/login?returnTo=https%3A%2F%2Fevil.example', routes: [{ path: '/', element: <p>Home</p> }] });
    await user.type(await screen.findByLabelText(/Email/), 'alice@example.test');
    await user.type(screen.getByLabelText(/Password/), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(location()).toBe('/'));
  });
});

describe('RegisterPage', () => {
  it('checks that the passwords match', async () => {
    const api = fakeAuth();
    const { user } = renderRoute(<RegisterPage />, { url: '/register' });
    await user.type(await screen.findByLabelText(/Email/), 'new@example.test');
    await user.type(screen.getByLabelText(/^Password/), 'Passw0rd!');
    await user.type(screen.getByLabelText(/Confirm password/), 'Passw0rd?');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByLabelText(/Confirm password/)).toHaveAccessibleDescription("The passwords don't match.");
    await waitFor(() => expect(screen.getByLabelText(/Confirm password/)).toHaveFocus());
    expect(api.requests.filter((r) => r.url.pathname === '/api/auth/register')).toHaveLength(0);
  });

  it('creates the account, signs in and opens /account with a welcome', async () => {
    const api = fakeAuth();
    const { user } = renderRoute(<RegisterPage />, { url: '/register?returnTo=%2Fedit%2Fabc', routes: [{ path: '/account', element: <p>Account</p> }] });
    await user.type(await screen.findByLabelText(/Email/), 'alice@example.test');
    await user.type(screen.getByLabelText(/^Password/), 'Passw0rd!');
    await user.type(screen.getByLabelText(/Confirm password/), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(location()).toBe('/account'));
    expect(JSON.parse(screen.getByTestId('location').dataset.state ?? 'null')).toEqual({ welcome: true, returnTo: '/edit/abc' });
    expect(api.requests.map((r) => r.url.pathname)).toEqual(expect.arrayContaining(['/api/auth/register', '/api/auth/login']));
  });

  it('shows Identity validation errors on the fields', async () => {
    fakeAuth({
      registerErrors: {
        PasswordTooShort: ['Passwords must be at least 6 characters.'],
        InvalidEmail: ["Email 'x' is invalid."],
      },
    });
    const { user } = renderRoute(<RegisterPage />, { url: '/register' });
    await user.type(await screen.findByLabelText(/Email/), 'x');
    await user.type(screen.getByLabelText(/^Password/), 'a');
    await user.type(screen.getByLabelText(/Confirm password/), 'a');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(screen.getByLabelText(/Email/)).toHaveAccessibleDescription("Email 'x' is invalid."));
    expect(screen.getByLabelText(/^Password/)).toHaveAccessibleDescription(expect.stringContaining('Passwords must be at least 6 characters.'));
    await waitFor(() => expect(screen.getByLabelText(/Email/)).toHaveFocus());
  });

  it('an email that already has an account: suggests signing in', async () => {
    fakeAuth({ existing: true });
    const { user } = renderRoute(<RegisterPage />, { url: '/register?returnTo=%2Fvault' });
    await user.type(await screen.findByLabelText(/Email/), 'alice@example.test');
    await user.type(screen.getByLabelText(/^Password/), 'Different1!');
    await user.type(screen.getByLabelText(/Confirm password/), 'Different1!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/If you already have an account, sign in instead/);
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/login?returnTo=%2Fvault');
  });
});
