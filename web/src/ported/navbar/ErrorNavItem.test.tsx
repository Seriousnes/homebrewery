import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, onSignInRequired } from '@/api';
import { renderRoute } from '@/app/testing';
import { ErrorNavItem } from './ErrorNavItem';

const http = (status: number, body: Record<string, unknown> = {}) => ApiError.fromResponse(new Response(null, { status }), { status, ...body });

afterEach(() => {
  vi.useRealTimers();
});

describe('ErrorNavItem', () => {
  it('opens a panel with the message; Try again and Dismiss close it', async () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const { user } = renderRoute(<ErrorNavItem error={http(503)} onRetry={onRetry} onDismiss={onDismiss} />);
    const trigger = screen.getByRole('button', { name: /Oops!.*problem saving/ });
    await user.click(trigger);
    const panel = screen.getByRole('group', { name: 'Problem saving' });
    expect(within(panel).getByText(/server had a problem/)).toBeInTheDocument();
    const report = within(panel).getByRole('link', { name: /Report the issue/ });
    expect(report.getAttribute('href')).toContain(encodeURIComponent('Status: 503'));
    await user.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('group', { name: 'Problem saving' })).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('401: "Sign in" asks the app for its sign-in prompt', async () => {
    const listener = vi.fn();
    const unsubscribe = onSignInRequired(listener);
    const { user } = renderRoute(<ErrorNavItem error={http(401)} onDismiss={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Oops!/ }));
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(listener).toHaveBeenCalledWith({ error: null });
    unsubscribe();
  });

  it('409: offers a reload, no retry', async () => {
    const reload = vi.fn();
    // oxlint-disable-next-line typescript/no-misused-spread -- jsdom's Location properties are its own, so they copy
    vi.stubGlobal('location', { ...window.location, reload });
    const { user } = renderRoute(<ErrorNavItem error={http(409, { serverVersion: 3 })} onRetry={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Oops!/ }));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Reload the page' }));
    });
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('uses a custom label', () => {
    renderRoute(<ErrorNavItem error={http(423, { detail: 'Locked for review.' })} label="Save failed" />);
    expect(screen.getByRole('button', { name: /^Save failed/ })).toHaveTextContent('Save failed');
  });
});
