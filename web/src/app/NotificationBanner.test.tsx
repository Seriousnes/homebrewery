import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationInfo } from '@/api';
import { jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { NotificationBanner } from './NotificationBanner';
import { NOTICE_DISMISSALS_KEY, noticeDismissalsStore } from './noticeDismissals';
import { renderRoute } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
  noticeDismissalsStore.reset();
  window.localStorage.clear();
});

function notice(key: string, title: string, body = ''): NotificationInfo {
  return {
    id: `id-${key}`,
    dismissKey: key,
    title,
    body,
    startsAt: '2026-01-01T00:00:00Z',
    stopsAt: '2099-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('NotificationBanner', () => {
  it('shows active notices as plain text and dismisses them for good', async () => {
    const api = mockApi(() =>
      jsonResponse([notice('maint', 'Maintenance tonight', 'The site will be down\nfor an hour. <b>not bold</b>'), notice('themes', 'New themes')]),
    );
    const focusAfterLast = vi.fn();
    const { user } = renderRoute(<NotificationBanner focusAfterLast={focusAfterLast} />);
    const region = await screen.findByRole('region', { name: 'Site notices' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Maintenance tonight');
    expect(items[0]).toHaveTextContent('<b>not bold</b>');
    expect(region.querySelector('b')).toBeNull();
    expect(api.last().path).toBe('/api/notifications/active');

    await user.click(within(region).getByRole('button', { name: 'Dismiss notice: Maintenance tonight' }));
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem(NOTICE_DISMISSALS_KEY) ?? '[]')).toEqual(['maint']);
    // Focus moves to the remaining notice's Dismiss button.
    expect(within(region).getByRole('button', { name: 'Dismiss notice: New themes' })).toHaveFocus();

    await user.click(within(region).getByRole('button', { name: 'Dismiss notice: New themes' }));
    expect(screen.queryByRole('region', { name: 'Site notices' })).toBeNull();
    expect(focusAfterLast).toHaveBeenCalledTimes(1);
  });

  it('hides notices dismissed earlier in this browser', async () => {
    window.localStorage.setItem(NOTICE_DISMISSALS_KEY, JSON.stringify(['maint']));
    mockApi(() => jsonResponse([notice('maint', 'Maintenance tonight'), notice('themes', 'New themes')]));
    renderRoute(<NotificationBanner />);
    const region = await screen.findByRole('region', { name: 'Site notices' });
    expect(within(region).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['New themes']);
  });

  it('renders nothing without notices, or when the request fails (no toast)', async () => {
    const notify = vi.fn();
    const api = mockApi(() => problemResponse(500, { title: 'Server error' }));
    const { testQueryClient } = await import('./testing');
    renderRoute(<NotificationBanner />, { client: testQueryClient(notify) });
    await waitFor(() => expect(api.requests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('region', { name: 'Site notices' })).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
