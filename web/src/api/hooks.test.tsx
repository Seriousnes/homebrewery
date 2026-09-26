import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AdminBrewInfo,
  type ApiError,
  type BrewForEdit,
  brewQueries,
  queryKeys,
  useActiveNotifications,
  useAdminBrew,
  useAdminCreateNotification,
  useAdminDeleteNotification,
  useAdminDismissReview,
  useAdminLockBrew,
  useAdminLocks,
  useAdminNotification,
  useAdminNotifications,
  useAdminReviewQueue,
  useAdminStats,
  useAdminUnlockBrew,
  useAdminUpdateNotification,
  useAdminUsers,
  useBrewForEdit,
  useBrewForShare,
  useCloneBrew,
  useCreateBrew,
  useDeleteBrew,
  useLogin,
  useLogout,
  useMe,
  useRegister,
  useRequestLockReview,
  useSaveBrew,
  useSetHandle,
  useThemeBundle,
  useThemes,
  useUpstreamImport,
  useUserBrews,
  useVaultSearch,
} from './index';
import { emptyResponse, jsonResponse, mockApi, problemResponse, textResponse } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

const account = { id: '0190-u', handle: 'alice', email: 'a@x.test', roles: [] };

function brewForEdit(overrides: Partial<BrewForEdit> = {}): BrewForEdit {
  return {
    editId: 'edit123',
    shareId: 'share123',
    version: 3,
    docSchemaVersion: 1,
    doc: { type: 'doc', content: [] },
    style: '',
    snippets: null,
    sourceMarkdown: null,
    meta: { title: 'T', description: '', tags: [], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: null },
    authors: [{ handle: 'alice', role: 'owner' }],
    role: 'owner',
    pageCount: 1,
    views: 0,
    lock: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const adminBrew: AdminBrewInfo = {
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
  lock: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastViewedAt: null,
};

describe('account hooks', () => {
  it('useMe returns the account, or null on 204', async () => {
    const { wrapper } = setup();
    mockApi(() => jsonResponse(account));
    const signedIn = renderHook(() => useMe(), { wrapper });
    await waitFor(() => expect(signedIn.result.current.data).toEqual(account));

    const anon = setup();
    mockApi(() => emptyResponse(204));
    const anonymous = renderHook(() => useMe(), { wrapper: anon.wrapper });
    await waitFor(() => expect(anonymous.result.current.isSuccess).toBe(true));
    expect(anonymous.result.current.data).toBeNull();
  });

  it('useLogin posts ?useCookies=true (or session cookies) and refetches me', async () => {
    const { wrapper, client } = setup();
    client.setQueryData(queryKeys.account.me(), null);
    const mock = mockApi((req) => (req.path.startsWith('/api/auth/login') ? new Response(null, { status: 200 }) : jsonResponse(account)));
    const me = renderHook(() => useMe(), { wrapper });
    const login = renderHook(() => useLogin(), { wrapper });
    await act(() => login.result.current.mutateAsync({ email: 'a@x.test', password: 'pw' }));
    const post = mock.requests.find((r) => r.method === 'POST');
    expect(post?.path).toBe('/api/auth/login?useCookies=true');
    expect(post?.json).toEqual({ email: 'a@x.test', password: 'pw' });
    await waitFor(() => expect(me.result.current.data).toEqual(account));

    await act(() => login.result.current.mutateAsync({ email: 'a@x.test', password: 'pw', remember: false }));
    expect(mock.requests.filter((r) => r.method === 'POST').at(-1)?.path).toBe('/api/auth/login?useSessionCookies=true');
  });

  it('useLogin surfaces 401 as ApiError with the Identity reason and manual policy meta', async () => {
    const { wrapper, client } = setup();
    mockApi(() => problemResponse(401, { title: 'Unauthorized', detail: 'LockedOut' }));
    const login = renderHook(() => useLogin(), { wrapper });
    const error = (await act(() => login.result.current.mutateAsync({ email: 'a', password: 'b' }).catch((e: unknown) => e))) as ApiError;
    expect(error.status).toBe(401);
    const { loginFailure } = await import('./account');
    expect(loginFailure(error)).toBe('lockedOut');
    expect(loginFailure(new Error('x'))).toBeNull();
    expect(client.getMutationCache().getAll()[0]?.meta).toEqual({ errorPolicy: 'manual' });
  });

  it('useRegister posts the credentials', async () => {
    const { wrapper } = setup();
    const mock = mockApi(() => new Response(null, { status: 200 }));
    const register = renderHook(() => useRegister(), { wrapper });
    await act(() => register.result.current.mutateAsync({ email: 'n@x.test', password: 'Passw0rd!' }));
    expect(mock.last()).toMatchObject({ method: 'POST', path: '/api/auth/register', json: { email: 'n@x.test', password: 'Passw0rd!' } });
  });

  it('useLogout sets me to null and drops unused private caches, keeping a loaded editor brew', async () => {
    const { wrapper, client } = setup();
    client.setQueryData(queryKeys.account.me(), account);
    client.setQueryData(queryKeys.admin.stats(), { brews: 1, publishedBrews: 1, users: 1, lockedBrews: 0, pendingReviews: 0 });
    client.setQueryData(queryKeys.brews.edit('other'), brewForEdit({ editId: 'other' }));
    const mock = mockApi(() => emptyResponse(204));
    const logout = renderHook(() => useLogout(), { wrapper });
    await act(() => logout.result.current.mutateAsync());
    expect(mock.last()).toMatchObject({ method: 'POST', path: '/api/account/logout' });
    expect(client.getQueryData(queryKeys.account.me())).toBeNull();
    expect(client.getQueryData(queryKeys.admin.stats())).toBeUndefined();
    expect(client.getQueryData(queryKeys.brews.edit('other'))).toBeUndefined();
  });

  it('useSetHandle updates me from the response', async () => {
    const { wrapper, client } = setup();
    client.setQueryData(queryKeys.account.me(), account);
    const mock = mockApi(() => jsonResponse({ ...account, handle: 'al' }));
    const setHandle = renderHook(() => useSetHandle(), { wrapper });
    await act(() => setHandle.result.current.mutateAsync('al'));
    expect(mock.last()).toMatchObject({ method: 'PUT', path: '/api/account/handle', json: { handle: 'al' } });
    expect(client.getQueryData(queryKeys.account.me())).toMatchObject({ handle: 'al' });
  });
});

describe('brew hooks', () => {
  it('useBrewForEdit loads once and is dropped when unused', async () => {
    const { wrapper, client } = setup();
    const mock = mockApi(() => jsonResponse(brewForEdit()));
    const hook = renderHook(() => useBrewForEdit('edit123'), { wrapper });
    await waitFor(() => expect(hook.result.current.data?.editId).toBe('edit123'));
    expect(mock.last().path).toBe('/api/brews/edit/edit123');
    const query = client.getQueryCache().find({ queryKey: queryKeys.brews.edit('edit123') });
    expect(brewQueries.edit('edit123').staleTime).toBe(Infinity);
    expect(query?.options.gcTime).toBe(0);
    hook.unmount();
    await waitFor(() => expect(client.getQueryCache().find({ queryKey: queryKeys.brews.edit('edit123') })).toBeUndefined());
  });

  it('useBrewForEdit is disabled without an id', () => {
    const { wrapper } = setup();
    const mock = mockApi(() => jsonResponse(brewForEdit()));
    const hook = renderHook(() => useBrewForEdit(undefined), { wrapper });
    expect(hook.result.current.fetchStatus).toBe('idle');
    expect(mock.requests).toHaveLength(0);
  });

  it('useBrewForShare surfaces a 423 lock as ApiError with code', async () => {
    const { wrapper } = setup();
    mockApi(() => problemResponse(423, { title: 'Brew locked', detail: 'Under review', code: 455 }));
    const hook = renderHook(() => useBrewForShare('share123'), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.error).toMatchObject({ status: 423, code: 455, detail: 'Under review' });
  });

  it('useCreateBrew gzips a large body and seeds the edit cache', async () => {
    const { wrapper, client } = setup();
    const created = brewForEdit({ editId: 'newEdit' });
    const mock = mockApi(() => jsonResponse(created, 201));
    const create = renderHook(() => useCreateBrew(), { wrapper });
    const doc = { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(20_000) }] }] }] };
    await act(() => create.result.current.mutateAsync({ doc, meta: { title: 'Big' } }));
    const request = mock.last();
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/brews');
    expect(request.headers.get('Content-Encoding')).toBe('gzip');
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(request.rawBody!.length).toBeLessThan(2000);
    expect(request.json).toEqual({ doc, meta: { title: 'Big' } });
    expect(client.getQueryData(queryKeys.brews.edit('newEdit'))).toEqual(created);
  });

  it('useSaveBrew sends a small body uncompressed and patches the cached brew', async () => {
    const { wrapper, client } = setup();
    client.setQueryData(queryKeys.brews.edit('edit123'), brewForEdit());
    const saved = { version: 4, updatedAt: '2026-02-02T00:00:00Z', title: 'Heading', pageCount: 2, authors: [{ handle: 'alice', role: 'owner' as const }] };
    const mock = mockApi(() => jsonResponse(saved));
    const save = renderHook(() => useSaveBrew('edit123'), { wrapper });
    const doc = { type: 'doc', content: [] };
    await act(() => save.result.current.mutateAsync({ body: { baseVersion: 3, doc, style: '.page{}', meta: { title: '', thumbnailUrl: '' } } }));
    const request = mock.last();
    expect(request).toMatchObject({ method: 'PUT', path: '/api/brews/edit123' });
    expect(request.headers.get('Content-Encoding')).toBeNull();
    expect(request.json).toMatchObject({ baseVersion: 3 });
    const cached = client.getQueryData<BrewForEdit>(queryKeys.brews.edit('edit123'));
    expect(cached).toMatchObject({ version: 4, pageCount: 2, style: '.page{}', doc, updatedAt: saved.updatedAt });
    expect(cached?.meta).toMatchObject({ title: 'Heading', thumbnailUrl: null, theme: '5ePHB' });
  });

  it('useSaveBrew passes a 409 through with serverVersion, and gzip "always" when asked', async () => {
    const { wrapper } = setup();
    const mock = mockApi(() => jsonResponse({ serverVersion: 9 }, 409));
    const save = renderHook(() => useSaveBrew('edit123'), { wrapper });
    const error = (await act(() =>
      save.result.current.mutateAsync({ body: { baseVersion: 3, doc: {} }, options: { gzip: 'always' } }).catch((e: unknown) => e),
    )) as ApiError;
    expect(error.status).toBe(409);
    expect(error.serverVersion).toBe(9);
    expect(mock.last().headers.get('Content-Encoding')).toBe('gzip');
  });

  it('useDeleteBrew, useCloneBrew and useRequestLockReview call their routes and update the cache', async () => {
    const { wrapper, client } = setup();
    client.setQueryData(queryKeys.brews.edit('edit123'), brewForEdit());
    const lock = { code: 455, message: 'Fix it', applied: '2026-01-01T00:00:00Z', reviewRequested: '2026-01-02T00:00:00Z' };
    const mock = mockApi((req) => {
      if (req.path.endsWith('/lock/review')) return jsonResponse(lock);
      if (req.path.endsWith('/clone')) return jsonResponse(brewForEdit({ editId: 'copyEdit' }), 201);
      return jsonResponse({ brewDeleted: true });
    });

    const review = renderHook(() => useRequestLockReview(), { wrapper });
    await act(() => review.result.current.mutateAsync('edit123'));
    expect(mock.last()).toMatchObject({ method: 'POST', path: '/api/brews/edit123/lock/review' });
    expect(client.getQueryData<BrewForEdit>(queryKeys.brews.edit('edit123'))?.lock).toEqual(lock);

    const clone = renderHook(() => useCloneBrew(), { wrapper });
    await act(() => clone.result.current.mutateAsync('share123'));
    expect(mock.last()).toMatchObject({ method: 'POST', path: '/api/brews/share123/clone' });
    expect(client.getQueryData(queryKeys.brews.edit('copyEdit'))).toBeDefined();

    const del = renderHook(() => useDeleteBrew(), { wrapper });
    await act(() => del.result.current.mutateAsync('edit123'));
    expect(mock.last()).toMatchObject({ method: 'DELETE', path: '/api/brews/edit123' });
    expect(client.getQueryData(queryKeys.brews.edit('edit123'))).toBeUndefined();
  });

  it('runs caller callbacks after the hook’s own', async () => {
    const { wrapper, client } = setup();
    const order: string[] = [];
    mockApi(() => jsonResponse(brewForEdit({ editId: 'n1' }), 201));
    const create = renderHook(
      () =>
        useCreateBrew({
          meta: { errorTitle: 'Custom' },
          onSuccess: () => {
            order.push(client.getQueryData(queryKeys.brews.edit('n1')) ? 'caller-after-seed' : 'caller-before-seed');
          },
        }),
      { wrapper },
    );
    await act(() => create.result.current.mutateAsync({}));
    expect(order).toEqual(['caller-after-seed']);
    expect(client.getMutationCache().getAll()[0]?.meta).toEqual({ errorTitle: 'Custom' });
  });
});

describe('list, theme, notification and import hooks', () => {
  it('call their routes', async () => {
    const { wrapper } = setup();
    const mock = mockApi((req) => {
      if (req.path.startsWith('/api/vault')) return jsonResponse({ items: [], total: 0, page: 2, pageSize: 20, sort: 'title', dir: 'asc' });
      if (req.path.startsWith('/api/users/')) return jsonResponse({ handle: 'bob', own: false, items: [], total: 0 });
      if (req.path === '/api/themes') return jsonResponse({ static: [], user: [] });
      if (req.path.startsWith('/api/themes/')) return jsonResponse({ theme: '5ePHB', name: '5e PHB', author: null, styles: [], snippets: [] });
      if (req.path === '/api/notifications/active') return jsonResponse([]);
      return textResponse('# Brew text');
    });

    const vault = renderHook(() => useVaultSearch({ q: ' dragon ', page: 2, sort: 'title', dir: 'asc' }), { wrapper });
    await waitFor(() => expect(vault.result.current.isSuccess).toBe(true));
    expect(mock.requests.some((r) => r.path === '/api/vault?q=dragon&page=2&sort=title&dir=asc')).toBe(true);

    const user = renderHook(() => useUserBrews(' Bob '), { wrapper });
    await waitFor(() => expect(user.result.current.isSuccess).toBe(true));
    expect(mock.requests.some((r) => r.path === '/api/users/bob/brews')).toBe(true);

    const themes = renderHook(() => useThemes(), { wrapper });
    const bundle = renderHook(() => useThemeBundle('5ePHB'), { wrapper });
    await waitFor(() => expect(themes.result.current.isSuccess && bundle.result.current.isSuccess).toBe(true));
    expect(mock.requests.some((r) => r.path === '/api/themes/5ePHB/bundle')).toBe(true);

    const notifications = renderHook(() => useActiveNotifications(), { wrapper });
    await waitFor(() => expect(notifications.result.current.data).toEqual([]));

    const upstream = renderHook(() => useUpstreamImport(), { wrapper });
    const text = await act(() => upstream.result.current.mutateAsync('abcDEF12345'));
    expect(text).toBe('# Brew text');
    expect(mock.last().path).toBe('/api/import/homebrewery/abcDEF12345');
  });

  it('keeps the previous vault page while the next loads', async () => {
    const { wrapper } = setup();
    let resolveSecond: (r: Response) => void = () => undefined;
    let calls = 0;
    mockApi(() => {
      calls++;
      if (calls === 1) return jsonResponse({ items: [], total: 30, page: 1, pageSize: 20, sort: 'updated', dir: 'desc' });
      return new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      });
    });
    const hook = renderHook(({ page }) => useVaultSearch({ page }), { wrapper, initialProps: { page: 1 } });
    await waitFor(() => expect(hook.result.current.data?.page).toBe(1));
    hook.rerender({ page: 2 });
    await waitFor(() => expect(hook.result.current.isPlaceholderData).toBe(true));
    expect(hook.result.current.data?.page).toBe(1);
    resolveSecond(jsonResponse({ items: [], total: 30, page: 2, pageSize: 20, sort: 'updated', dir: 'desc' }));
    await waitFor(() => expect(hook.result.current.data?.page).toBe(2));
  });
});

describe('admin hooks', () => {
  it('query their routes (useAdminUsers waits for text)', async () => {
    const { wrapper } = setup();
    const mock = mockApi((req) => {
      if (req.path === '/api/admin/stats') return jsonResponse({ brews: 1, publishedBrews: 0, users: 1, lockedBrews: 0, pendingReviews: 0 });
      if (req.path.startsWith('/api/admin/users')) return jsonResponse([]);
      if (req.path.startsWith('/api/admin/brews/')) return jsonResponse(adminBrew);
      if (req.path.startsWith('/api/admin/locks')) return jsonResponse([]);
      if (req.path === '/api/admin/notifications') return jsonResponse([]);
      return jsonResponse({ id: 'n1', dismissKey: 'k', title: 't', body: '', startsAt: '', stopsAt: '', createdAt: '' });
    });
    const idle = renderHook(() => useAdminUsers('  '), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');

    const hooks = renderHook(
      () => [
        useAdminStats(),
        useAdminUsers(' ali '),
        useAdminBrew('share123'),
        useAdminLocks(),
        useAdminReviewQueue(),
        useAdminNotifications(),
        useAdminNotification('n1'),
      ],
      { wrapper },
    );
    await waitFor(() => expect(hooks.result.current.every((q) => q.isSuccess)).toBe(true));
    const paths = mock.requests.map((r) => r.path).sort();
    expect(paths).toEqual(
      [
        '/api/admin/brews/share123',
        '/api/admin/locks',
        '/api/admin/locks/review-queue',
        '/api/admin/notifications',
        '/api/admin/notifications/n1',
        '/api/admin/stats',
        '/api/admin/users?q=ali',
      ].sort(),
    );
  });

  it('mutations call their routes and invalidate lock lists', async () => {
    const { wrapper, client } = setup();
    client.setQueryData(queryKeys.admin.locks(), []);
    const note = { id: 'n1', dismissKey: 'k', title: 't', body: '', startsAt: '', stopsAt: '', createdAt: '' };
    const mock = mockApi((req) => {
      if (req.path.startsWith('/api/admin/brews/')) return jsonResponse({ ...adminBrew, lock: null });
      if (req.method === 'DELETE') return emptyResponse(204);
      return jsonResponse(note, req.method === 'POST' ? 201 : 200);
    });
    const hooks = renderHook(
      () => ({
        lock: useAdminLockBrew(),
        unlock: useAdminUnlockBrew(),
        dismiss: useAdminDismissReview(),
        create: useAdminCreateNotification(),
        update: useAdminUpdateNotification(),
        remove: useAdminDeleteNotification(),
      }),
      { wrapper },
    );
    const input = { dismissKey: 'k', title: 't', body: '', startsAt: null, stopsAt: '2027-01-01T00:00:00Z' };
    await act(() => hooks.result.current.lock.mutateAsync({ shareId: 'share123', lock: { code: 455, editMessage: 'e', shareMessage: 's' } }));
    expect(mock.last()).toMatchObject({ method: 'PUT', path: '/api/admin/brews/share123/lock', json: { code: 455 } });
    expect(client.getQueryState(queryKeys.admin.locks())?.isInvalidated).toBe(true);
    await act(() => hooks.result.current.unlock.mutateAsync('share123'));
    expect(mock.last()).toMatchObject({ method: 'DELETE', path: '/api/admin/brews/share123/lock' });
    await act(() => hooks.result.current.dismiss.mutateAsync('share123'));
    expect(mock.last()).toMatchObject({ method: 'DELETE', path: '/api/admin/brews/share123/lock/review' });
    await act(() => hooks.result.current.create.mutateAsync(input));
    expect(mock.last()).toMatchObject({ method: 'POST', path: '/api/admin/notifications', json: input });
    await act(() => hooks.result.current.update.mutateAsync({ id: 'n1', input }));
    expect(mock.last()).toMatchObject({ method: 'PUT', path: '/api/admin/notifications/n1' });
    await act(() => hooks.result.current.remove.mutateAsync('n1'));
    expect(mock.last()).toMatchObject({ method: 'DELETE', path: '/api/admin/notifications/n1' });
  });

  it('useAdminBrew leaves a 404 to the caller', async () => {
    const { wrapper, client } = setup();
    mockApi(() => problemResponse(404, { title: 'Brew not found' }));
    const hook = renderHook(() => useAdminBrew('nope'), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(client.getQueryCache().find({ queryKey: queryKeys.admin.brew('nope') })?.meta).toEqual({ errorPolicy: 'manual' });
  });
});
