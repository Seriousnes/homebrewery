import { screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api';
import { emptyResponse, mockApi } from '@/api/testing';
import { renderRoute } from '@/app/testing';
import { ErrorPage } from './ErrorPage';
import { RouteErrorBoundary } from './RouteErrorBoundary';

afterEach(() => {
  vi.unstubAllGlobals();
});

const problem = (status: number, body: Record<string, unknown> = {}) => ApiError.fromResponse(new Response(null, { status }), { status, ...body });

describe('ErrorPage', () => {
  it('404: explains and links on', () => {
    renderRoute(<ErrorPage error={problem(404, { title: 'Brew not found' })} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Brew not found' })).toBeInTheDocument();
    expect(screen.getByText('Error 404')).toBeInTheDocument();
    const links = within(screen.getByRole('list', { name: 'Where to go next' })).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/', '/vault']);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('403: access denied with the server detail', () => {
    renderRoute(<ErrorPage error={problem(403, { detail: 'Only the authors can edit this brew.' })} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByText('Only the authors can edit this brew.')).toBeInTheDocument();
  });

  it('423: the lock message page', () => {
    renderRoute(<ErrorPage error={problem(423, { title: 'Brew locked', detail: 'Copied from a published book.', code: 455 })} />);
    expect(screen.getByRole('heading', { level: 1, name: 'This brew is locked' })).toBeInTheDocument();
    const reason = screen.getByRole('region', { name: 'Why it is locked' });
    expect(reason).toHaveTextContent('Copied from a published book.');
    expect(reason).toHaveTextContent('Lock code 455');
    expect(screen.getByText(/ask for a review/)).toBeInTheDocument();
  });

  it('401: the inline sign-in prompt', () => {
    mockApi(() => emptyResponse(204));
    renderRoute(<ErrorPage error={problem(401)} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in required' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('transient failures offer "Try again"', async () => {
    const onRetry = vi.fn();
    const { user } = renderRoute(<ErrorPage error={ApiError.network(new TypeError('Failed to fetch'))} onRetry={onRetry} />);
    expect(screen.getByRole('heading', { level: 1, name: "Can't reach the server" })).toBeInTheDocument();
    expect(screen.getByText('No connection')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a 404 does not offer a retry even when given one', () => {
    renderRoute(<ErrorPage error={problem(404)} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('RouteErrorBoundary', () => {
  function renderThrowing(error: unknown) {
    const Thrower = () => {
      throw error;
    };
    const router = createMemoryRouter([{ path: '/', element: <Thrower />, errorElement: <RouteErrorBoundary /> }]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<RouterProvider router={router} />);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a crashing page gets an error page with a reload', () => {
    renderThrowing(new Error('kaboom'));
    expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // Developer builds show the stack.
    expect(screen.getByText('Details')).toBeInTheDocument();
  });

  it('a page module that failed to load asks for a reload', () => {
    renderThrowing(new TypeError('Failed to fetch dynamically imported module: http://localhost/static/page.js'));
    expect(screen.getByRole('heading', { level: 1, name: 'This page could not be loaded' })).toBeInTheDocument();
  });

  it('a thrown ApiError renders its page', () => {
    renderThrowing(problem(403));
    expect(screen.getByRole('heading', { level: 1, name: 'Access denied' })).toBeInTheDocument();
  });
});
