import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrewLockInfo } from '@/api';
import { jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { testQueryClient } from '@/app/testing';
import { clearToasts, toastStore } from '@/ui';
import { LockBanner } from './LockBanner';

const lock: BrewLockInfo = { code: 455, message: 'Remove the copied text.', applied: '2026-09-01T12:00:00Z', reviewRequested: null };

function renderBanner(props: Partial<Parameters<typeof LockBanner>[0]> = {}) {
  const onLockChange = vi.fn();
  const notify = vi.fn();
  render(
    <QueryClientProvider client={testQueryClient(notify)}>
      <LockBanner lock={lock} editId="edit1" onLockChange={onLockChange} {...props} />
    </QueryClientProvider>,
  );
  return { onLockChange, notify };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('LockBanner', () => {
  it('shows the edit message and the lock code in a named region', () => {
    renderBanner();
    const region = screen.getByRole('region', { name: 'This brew is locked' });
    expect(region).toHaveTextContent('Remove the copied text.');
    expect(region).toHaveTextContent('Lock code 455');
  });

  it('requests a review and reports the updated lock', async () => {
    const updated = { ...lock, reviewRequested: '2026-09-03T08:00:00Z' };
    const api = mockApi(() => jsonResponse(updated));
    const { onLockChange } = renderBanner();
    await userEvent.click(screen.getByRole('button', { name: 'Request review' }));
    expect(api.last()).toMatchObject({ method: 'POST', path: '/api/brews/edit1/lock/review' });
    expect(onLockChange).toHaveBeenCalledWith(updated);
  });

  it('a failed request is reported by the error policy and changes nothing', async () => {
    mockApi(() => problemResponse(500, { title: 'Server error', status: 500 }));
    const { onLockChange, notify } = renderBanner();
    await userEvent.click(screen.getByRole('button', { name: 'Request review' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(onLockChange).not.toHaveBeenCalled();
  });

  it('the brew is no longer locked (409): the banner goes, and a toast says why', async () => {
    mockApi(() => problemResponse(409, { title: 'Brew not locked', detail: 'The brew has no moderation lock.' }));
    const { onLockChange, notify } = renderBanner();
    await userEvent.click(screen.getByRole('button', { name: 'Request review' }));
    await vi.waitFor(() => expect(onLockChange).toHaveBeenCalledWith(null));
    const toasts = toastStore.getState().toasts;
    expect(toasts.map((t) => t.title)).toContain('This brew is no longer locked');
    expect(toasts.map((t) => t.description)).toContain('The brew has no moderation lock.');
    expect(notify).not.toHaveBeenCalled();
  });

  it('a refused request (400) says why in the banner', async () => {
    mockApi(() => problemResponse(400, { title: 'Bad request', detail: 'The request was not valid.', errors: { editId: ['The edit id is not valid.'] } }));
    const { onLockChange } = renderBanner();
    await userEvent.click(screen.getByRole('button', { name: 'Request review' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't request a review.");
    expect(within(screen.getByRole('region', { name: 'This brew is locked' })).getByRole('alert')).toBe(alert);
    expect(onLockChange).not.toHaveBeenCalled();
  });

  it('once requested, shows when instead of the button; a brew never saved has no button', () => {
    renderBanner({ lock: { ...lock, reviewRequested: '2026-09-03T08:00:00Z' } });
    expect(screen.getByRole('status')).toHaveTextContent('Review requested');
    expect(screen.queryByRole('button', { name: 'Request review' })).toBeNull();
  });

  it('has no button before the first save', () => {
    renderBanner({ editId: null });
    expect(screen.queryByRole('button', { name: 'Request review' })).toBeNull();
  });
});
