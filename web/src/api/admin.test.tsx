// The admin lane's additions to web/src/api/admin.ts (the other admin hooks are covered by
// hooks.test.tsx): the user-brews lookup and what is fetched again after a change.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminKeys,
  adminQueries,
  fetchAdminUserBrews,
  useAdminCreateNotification,
  useAdminDeleteNotification,
  useAdminLockBrew,
  useAdminUserBrews,
} from './admin';
import { queryKeys } from './keys';
import { emptyResponse, jsonResponse, mockApi, problemResponse } from './testing';
import type { AdminBrewInfo, NotificationInfo, UserBrewList } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

const list: UserBrewList = { handle: 'alice', own: true, items: [], total: 0 };
const note: NotificationInfo = {
  id: 'n1',
  dismissKey: 'k',
  title: 't',
  body: '',
  startsAt: '2026-09-25T10:00:00Z',
  stopsAt: '2026-10-01T10:00:00Z',
  createdAt: '2026-09-25T10:00:00Z',
};
const brew: AdminBrewInfo = {
  id: 'g',
  shareId: 'share123',
  editId: 'edit123',
  title: 'T',
  description: '',
  tags: [],
  lang: 'en',
  theme: '5ePHB',
  published: true,
  thumbnailUrl: null,
  pageCount: 1,
  views: 0,
  version: 1,
  docSchemaVersion: 1,
  authors: [],
  lock: { code: 455, editMessage: 'e', shareMessage: 's', applied: '2026-09-25T10:00:00Z', reviewRequested: null },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastViewedAt: null,
};

describe('admin user brews', () => {
  it('fetches an account’s brews by its normalized handle', async () => {
    const mock = mockApi(() => jsonResponse(list));
    await expect(fetchAdminUserBrews('  Alice ')).resolves.toEqual(list);
    expect(mock.last()).toMatchObject({ method: 'GET', path: '/api/admin/users/alice/brews' });
    expect(adminKeys.userBrews(' ALICE ')).toEqual(adminKeys.userBrews('alice'));
    expect(adminKeys.userBrews('alice').slice(0, 2)).toEqual([...adminKeys.userBrewLists]);
    expect(adminKeys.userBrewLists[0]).toBe(queryKeys.admin.all[0]);
  });

  it('waits for a handle, and reports a missing account as a 404', async () => {
    const { wrapper } = setup();
    const mock = mockApi(() => problemResponse(404, { title: 'User not found' }));
    const idle = renderHook(() => useAdminUserBrews(' '), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    const missing = renderHook(() => useAdminUserBrews('ghost'), { wrapper });
    await waitFor(() => expect(missing.result.current.isError).toBe(true));
    expect(missing.result.current.error?.status).toBe(404);
    expect(mock.requests.map((r) => r.path)).toEqual(['/api/admin/users/ghost/brews']);
  });
});

describe('after changes', () => {
  it('a lock change marks the user-brews lists stale and stores the returned brew', async () => {
    const { wrapper, client } = setup();
    client.setQueryData(adminKeys.userBrews('alice'), list);
    mockApi(() => jsonResponse(brew));
    const hook = renderHook(() => useAdminLockBrew(), { wrapper });
    await act(() => hook.result.current.mutateAsync({ shareId: 'share123', lock: { code: 455, editMessage: 'e', shareMessage: 's' } }));
    expect(client.getQueryState(adminKeys.userBrews('alice'))?.isInvalidated).toBe(true);
    expect(client.getQueryData(queryKeys.admin.brew('share123'))).toEqual(brew);
  });

  it('a notification change fetches the admin list again before it resolves, even with no page showing it', async () => {
    const { wrapper, client } = setup();
    client.setQueryData(queryKeys.admin.notification('old'), { ...note, id: 'old' });
    client.setQueryData(queryKeys.notifications.active(), []);
    let stored: NotificationInfo[] = [];
    const mock = mockApi((req) => {
      if (req.method === 'POST') {
        stored = [note];
        return jsonResponse(note, 201);
      }
      if (req.method === 'DELETE') {
        stored = [];
        return emptyResponse(204);
      }
      if (req.path === '/api/admin/notifications') return jsonResponse(stored);
      return jsonResponse([]);
    });
    // The list as a page loaded it earlier (that page is gone now: no observer).
    await client.fetchQuery(adminQueries.notifications());
    const hooks = renderHook(() => ({ create: useAdminCreateNotification(), remove: useAdminDeleteNotification() }), { wrapper });

    await act(() => hooks.result.current.create.mutateAsync({ dismissKey: 'k', title: 't', body: '', startsAt: null, stopsAt: note.stopsAt }));
    expect(client.getQueryData(queryKeys.admin.notificationList())).toEqual([note]);
    expect(client.getQueryData(queryKeys.admin.notification('n1'))).toEqual(note);
    // Other details only become stale (no request for them); the banner's list too (inactive here).
    expect(client.getQueryState(queryKeys.admin.notification('old'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.notifications.active())?.isInvalidated).toBe(true);
    expect(mock.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/admin/notifications',
      'POST /api/admin/notifications',
      'GET /api/admin/notifications',
    ]);

    await act(() => hooks.result.current.remove.mutateAsync('n1'));
    expect(client.getQueryData(queryKeys.admin.notificationList())).toEqual([]);
    expect(client.getQueryState(queryKeys.admin.notification('n1'))).toBeUndefined();
    expect(mock.requests.slice(3).map((r) => `${r.method} ${r.path}`)).toEqual(['DELETE /api/admin/notifications/n1', 'GET /api/admin/notifications']);
  });
});
