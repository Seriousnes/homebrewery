import { configure, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, jsonResponse, mockApi } from '@/api/testing';
import { App } from '@/app/App';

// Every test lazy-loads a page module. Load them once up front (hook timeout), so no test's findBy
// waits for a first import; the lazy routes still resolve through the same import() calls.
configure({ asyncUtilTimeout: 3000 });
beforeAll(async () => {
  await Promise.all([
    import('@/pages/home'),
    import('@/pages/edit'),
    import('@/pages/share'),
    import('@/pages/user'),
    import('@/pages/vault'),
    import('@/pages/import'),
    import('@/pages/admin'),
    import('@/pages/account/AccountPage'),
    import('@/pages/auth/LoginPage'),
    import('@/pages/auth/RegisterPage'),
  ]);
});

beforeEach(() => {
  mockApi((request) => {
    if (request.url.pathname === '/api/account/me') return emptyResponse(204);
    if (request.url.pathname === '/api/notifications/active') return jsonResponse([]);
    return jsonResponse({ title: 'Not found' }, 404);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('App', () => {
  it('renders the shell and the home page on /', async () => {
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'The Homebrewery' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'The Homebrewery' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(document.title).toBe('The Homebrewery');
  });

  it('renders the not-found page for unknown routes', async () => {
    window.history.pushState({}, '', '/no-such-page');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('Error 404')).toBeInTheDocument();
    expect(document.title).toBe('Page not found - The Homebrewery');
  });

  it.each([
    ['/new', 'New brew'],
    // The mocked API has no such brew: the editor pages show their 404 page.
    ['/edit/abc123', 'Not found'],
    ['/share/abc123', 'Not found'],
    ['/user/someone', 'User not found'],
    ['/vault', 'Vault'],
    ['/import', 'Import a brew'],
    // Signed out (the mocked API): the admin module's RequireAuth shows the sign-in page (P7.4).
    ['/admin', 'Sign in required'],
    ['/admin/locks', 'Sign in required'],
    ['/login', 'Sign in'],
    ['/register', 'Create an account'],
  ])('lazy-loads the page module for %s', async (path, heading) => {
    window.history.pushState({}, '', path);
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('shows the sign-in page in place of /account when signed out', async () => {
    window.history.pushState({}, '', '/account');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in required' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });
});
