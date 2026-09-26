import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, jsonResponse, mockApi } from '@/api/testing';
import { RequireAuth } from './RequireAuth';
import { ADMIN_ROLE } from './roles';
import { ADMIN, ALICE, renderRoute } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RequireAuth', () => {
  it('shows a loading state, then the sign-in page for anonymous visitors', async () => {
    mockApi(() => emptyResponse(204));
    renderRoute(<RequireAuth>Secret</RequireAuth>);
    expect(screen.getByTestId('page-loading')).toHaveTextContent('Checking your sign-in');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in required' })).toBeInTheDocument();
    expect(screen.queryByText('Secret')).toBeNull();
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/register');
  });

  it('renders the page with the account once signed in', () => {
    renderRoute(<RequireAuth>{(account) => `Hello ${account.handle}`}</RequireAuth>, { me: ALICE });
    expect(screen.getByText('Hello alice')).toBeInTheDocument();
  });

  it('gives a 403 page when a role is missing', () => {
    renderRoute(<RequireAuth role={ADMIN_ROLE}>Admin area</RequireAuth>, { me: ALICE });
    expect(screen.getByRole('heading', { level: 1, name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByText('This page is only for administrators.')).toBeInTheDocument();
    expect(screen.queryByText('Admin area')).toBeNull();
  });

  it('admits the role', () => {
    renderRoute(<RequireAuth role={ADMIN_ROLE}>Admin area</RequireAuth>, { me: ADMIN });
    expect(screen.getByText('Admin area')).toBeInTheDocument();
  });

  it('offers a retry when the account check fails', async () => {
    let fail = true;
    mockApi(() => {
      if (fail) return Promise.reject(new TypeError('Failed to fetch'));
      return jsonResponse(ALICE);
    });
    const { user } = renderRoute(<RequireAuth>{(account) => `Hello ${account.handle}`}</RequireAuth>);
    expect(await screen.findByRole('heading', { level: 1, name: "Can't reach the server" })).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Hello alice')).toBeInTheDocument());
  });
});
