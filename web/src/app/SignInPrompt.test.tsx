import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, requestSignIn } from '@/api';
import { emptyResponse, jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { SignInRequired } from '@/pages/auth/SignInRequired';
import { advance } from '@/test/fakeClock';
import { clearToasts, toastStore } from '@/ui';
import { SIGN_IN_PROMPT_DELAY_MS, signInPromptStore } from './signInPromptStore';
import { ALICE, renderRoute } from './testing';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  signInPromptStore.reset();
  clearToasts();
});

const dialog = () => screen.findByRole('dialog', { name: 'Sign in' });

describe('SignInPrompt', () => {
  it('opens on a sign-in request, signs in, closes and says who is signed in', async () => {
    let signedIn = false;
    const api = mockApi((request) => {
      if (request.path.startsWith('/api/auth/login')) {
        signedIn = true;
        return emptyResponse(200);
      }
      if (request.path === '/api/account/me') return signedIn ? jsonResponse(ALICE) : emptyResponse(204);
      return jsonResponse([]);
    });
    const { user } = renderRoute(<p>Page</p>, { me: null });
    requestSignIn(ApiError.fromResponse(new Response(null, { status: 401 }), { title: 'Unauthorized' }));
    const prompt = await dialog();
    expect(prompt).toHaveAccessibleDescription(/session may have ended/);
    // The dialog focuses its first field.
    const email = within(prompt).getByLabelText(/Email/);
    await waitFor(() => expect(email).toHaveFocus());
    await user.type(email, 'alice@example.test');
    await user.type(within(prompt).getByLabelText(/Password/), 'Passw0rd!');
    await user.click(within(prompt).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull());
    expect(toastStore.getState().toasts.map((t) => t.title)).toContain('Signed in as alice.');
    const login = api.requests.find((r) => r.path.startsWith('/api/auth/login'));
    expect(login?.path).toBe('/api/auth/login?useCookies=true');
    expect(login?.json).toEqual({ email: 'alice@example.test', password: 'Passw0rd!' });
  });

  it('a request without an error (a "Sign in" button) asks to sign in, not about a session that ended', async () => {
    renderRoute(<p>Page</p>, { me: null });
    requestSignIn(null);
    const prompt = await dialog();
    expect(prompt).toHaveAccessibleDescription('Sign in to your Homebrewery account.');
  });

  it('shows the login error in the dialog', async () => {
    mockApi((request) => (request.path.startsWith('/api/auth/login') ? problemResponse(401, { title: 'Unauthorized', detail: 'Failed' }) : emptyResponse(204)));
    const { user } = renderRoute(<p>Page</p>, { me: null });
    requestSignIn();
    const prompt = await dialog();
    await user.type(within(prompt).getByLabelText(/Email/), 'alice@example.test');
    await user.type(within(prompt).getByLabelText(/Password/), 'wrong');
    await user.click(within(prompt).getByRole('button', { name: 'Sign in' }));
    expect(await within(prompt).findByRole('alert')).toHaveTextContent('The email or password is not correct.');
    await waitFor(() => expect(within(prompt).getByLabelText(/Password/)).toHaveFocus());
  });

  it('closes on Escape and can open again', async () => {
    const { user } = renderRoute(<p>Page</p>, { me: null });
    requestSignIn();
    await dialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull());
    requestSignIn();
    expect(await dialog()).toBeInTheDocument();
  });

  it('"Create one" goes to /register with a returnTo and closes', async () => {
    const { user } = renderRoute(<p>Page</p>, { url: '/edit/abc', me: null, routes: [{ path: '/register', element: <p>Register</p> }] });
    requestSignIn();
    const prompt = await dialog();
    await user.click(within(prompt).getByRole('link', { name: 'Create one' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/register?returnTo=%2Fedit%2Fabc');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull());
  });

  // The request on a fake clock, run well past the dialog's delay.
  it('stays closed on the sign-in pages', async () => {
    renderRoute(<p>Login page</p>, { url: '/login', me: null });
    vi.useFakeTimers();
    act(() => requestSignIn());
    await advance(10 * SIGN_IN_PROMPT_DELAY_MS);
    expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull();
  });

  it('stays closed while an inline sign-in form is on the page', async () => {
    mockApi(() => emptyResponse(204));
    renderRoute(<SignInRequired />, { me: null });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in required' })).toBeInTheDocument();
    vi.useFakeTimers();
    act(() => requestSignIn());
    await advance(10 * SIGN_IN_PROMPT_DELAY_MS);
    expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull();
  });

  it('opens after its delay (what the two above run past)', async () => {
    renderRoute(<p>Page</p>, { me: null });
    vi.useFakeTimers();
    act(() => requestSignIn());
    await advance(SIGN_IN_PROMPT_DELAY_MS - 1);
    expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull();
    await advance(1);
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('a 401 from any query clears `me` and prompts (through the app query client)', async () => {
    mockApi((request) => (request.path === '/api/admin/stats' ? problemResponse(401, { title: 'Unauthorized' }) : emptyResponse(204)));
    const { queryClient } = renderRoute(<p>Page</p>, { me: ALICE });
    await queryClient.fetchQuery({ queryKey: ['probe'], queryFn: async () => {
      const { fetchAdminStats } = await import('@/api');
      return fetchAdminStats();
    } }).catch(() => undefined);
    expect(await dialog()).toBeInTheDocument();
    expect(queryClient.getQueryData(['account', 'me'])).toBeNull();
  });
});
