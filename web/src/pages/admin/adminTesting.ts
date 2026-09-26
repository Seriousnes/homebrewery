// Vitest only (never import from app code): an in-memory /api/admin/* for the admin page tests,
// following the API's documented behaviour (docs/implementation-notes.md, admin routes).
import type {
  AccountInfo,
  AdminBrewInfo,
  AdminStats,
  AdminUserInfo,
  LockedBrewInfo,
  LockRequest,
  NotificationInfo,
  NotificationInput,
  UserBrewList,
} from '@/api';
import { emptyResponse, jsonResponse, type MockApi, mockApi, problemResponse, type RecordedRequest } from '@/api/testing';

export interface AdminServer {
  me: AccountInfo | null;
  users: AdminUserInfo[];
  brews: AdminBrewInfo[];
  notifications: NotificationInfo[];
  /** Per path ('GET /api/admin/stats'): answer with this instead (e.g. a 500). */
  override: Map<string, () => Response>;
  api: MockApi;
  /** 'METHOD /path status' per request. */
  log: string[];
  now: () => string;
}

const T0 = Date.parse('2026-09-20T10:00:00Z');

export function adminBrew(shareId: string, overrides: Partial<AdminBrewInfo> = {}): AdminBrewInfo {
  return {
    id: `0190-${shareId}`,
    shareId,
    editId: `edit-${shareId}`,
    title: `Brew ${shareId}`,
    description: '',
    tags: [],
    lang: 'en',
    theme: '5ePHB',
    published: true,
    thumbnailUrl: null,
    pageCount: 2,
    views: 12,
    version: 3,
    docSchemaVersion: 1,
    authors: [{ handle: 'alice', role: 'owner' }],
    lock: null,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0 + 3_600_000).toISOString(),
    lastViewedAt: null,
    ...overrides,
  };
}

export function adminUser(handle: string, overrides: Partial<AdminUserInfo> = {}): AdminUserInfo {
  return { id: `0190-user-${handle}`, handle, email: `${handle}@example.test`, emailConfirmed: true, roles: [], brewCount: 0, lockoutEnd: null, ...overrides };
}

export function notification(id: string, overrides: Partial<NotificationInfo> = {}): NotificationInfo {
  return {
    id,
    dismissKey: `key-${id}`,
    title: `Notice ${id}`,
    body: '',
    startsAt: new Date(Date.now() - 86_400_000).toISOString(),
    stopsAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    ...overrides,
  };
}

function lockedInfo(brew: AdminBrewInfo): LockedBrewInfo {
  return { shareId: brew.shareId, editId: brew.editId, title: brew.title, authors: brew.authors.map((a) => a.handle), lock: brew.lock! };
}

const validation = (errors: Record<string, string[]>) => problemResponse(400, { title: 'One or more validation errors occurred.', errors });

export function createAdminServer(seed: Partial<Pick<AdminServer, 'me' | 'users' | 'brews' | 'notifications'>> = {}): AdminServer {
  let clock = Date.parse('2026-09-25T12:00:00Z');
  const server: AdminServer = {
    me: seed.me === undefined ? null : seed.me,
    users: seed.users ?? [],
    brews: seed.brews ?? [],
    notifications: seed.notifications ?? [],
    override: new Map(),
    api: undefined as unknown as MockApi,
    log: [],
    now: () => new Date((clock += 1000)).toISOString(),
  };

  const findBrew = (id: string) => server.brews.find((b) => b.shareId === id) ?? server.brews.find((b) => b.editId === id || b.id === id);
  const replace = (brew: AdminBrewInfo) => {
    server.brews = server.brews.map((b) => (b.shareId === brew.shareId ? brew : b));
    return brew;
  };
  const stats = (): AdminStats => ({
    brews: server.brews.length,
    publishedBrews: server.brews.filter((b) => b.published).length,
    users: server.users.length,
    lockedBrews: server.brews.filter((b) => b.lock).length,
    pendingReviews: server.brews.filter((b) => b.lock?.reviewRequested).length,
  });
  const userBrews = (handle: string): UserBrewList => {
    const items = server.brews
      .filter((b) => b.authors.some((a) => a.handle === handle))
      .map((b) => ({
        shareId: b.shareId,
        editId: b.editId,
        title: b.title,
        description: b.description,
        tags: b.tags,
        authors: b.authors.map((a) => a.handle),
        theme: b.theme,
        lang: b.lang,
        pageCount: b.pageCount,
        views: b.views,
        published: b.published,
        thumbnailUrl: b.thumbnailUrl,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        lastViewedAt: b.lastViewedAt,
        role: b.authors.find((a) => a.handle === handle)!.role,
        locked: b.lock != null,
      }));
    return { handle, own: true, items, total: items.length };
  };
  const notificationInput = (input: NotificationInput, id: string | null): Response | NotificationInfo => {
    const errors: Record<string, string[]> = {};
    if (!input.dismissKey?.trim()) errors.dismissKey = ['is required'];
    if (!input.title?.trim()) errors.title = ['is required'];
    if (!input.stopsAt) errors.stopsAt = ['is required'];
    const startsAt = input.startsAt ?? server.now();
    if (input.stopsAt && Date.parse(input.stopsAt) <= Date.parse(startsAt)) errors.stopsAt = ['must be after startsAt'];
    if (Object.keys(errors).length) return validation(errors);
    if (server.notifications.some((n) => n.dismissKey === input.dismissKey && n.id !== id)) {
      return problemResponse(409, { title: 'Dismiss key taken', detail: `Another notification uses the dismiss key '${input.dismissKey}'.` });
    }
    const existing = id ? server.notifications.find((n) => n.id === id) : undefined;
    return {
      id: id ?? `n${server.notifications.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
      dismissKey: input.dismissKey!,
      title: input.title!,
      body: input.body ?? '',
      startsAt,
      stopsAt: input.stopsAt!,
      createdAt: existing?.createdAt ?? server.now(),
    };
  };

  const answer = (req: RecordedRequest): Response => {
    const path = req.url.pathname;
    const key = `${req.method} ${path}`;
    const override = server.override.get(key);
    if (override) return override();
    if (path === '/api/account/me') return server.me ? jsonResponse(server.me) : emptyResponse(204);
    if (path === '/api/notifications/active') return jsonResponse([]);
    if (!path.startsWith('/api/admin/')) return problemResponse(404, { title: 'Not found' });
    if (!server.me) return problemResponse(401, { title: 'Unauthorized' });
    if (!server.me.roles.includes('Admin')) return problemResponse(403, { title: 'Forbidden' });

    let m: RegExpExecArray | null;
    if (key === 'GET /api/admin/stats') return jsonResponse(stats());
    if (key === 'GET /api/admin/users') {
      const q = (req.url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (!q) return validation({ q: ['is required'] });
      return jsonResponse(server.users.filter((u) => u.handle.includes(q) || u.email?.toLowerCase().includes(q) || u.id === q));
    }
    if ((m = /^\/api\/admin\/users\/([^/]+)\/brews$/.exec(path)) && req.method === 'GET') {
      const handle = decodeURIComponent(m[1]!);
      if (!server.users.some((u) => u.handle === handle)) return problemResponse(404, { title: 'User not found' });
      return jsonResponse(userBrews(handle));
    }
    if ((m = /^\/api\/admin\/brews\/([^/]+)\/lock\/review$/.exec(path)) && req.method === 'DELETE') {
      const brew = findBrew(decodeURIComponent(m[1]!));
      if (!brew) return problemResponse(404, { title: 'Brew not found' });
      if (!brew.lock) return problemResponse(409, { title: 'Brew not locked' });
      return jsonResponse(replace({ ...brew, lock: { ...brew.lock, reviewRequested: null } }));
    }
    if ((m = /^\/api\/admin\/brews\/([^/]+)\/lock$/.exec(path))) {
      const brew = server.brews.find((b) => b.shareId === decodeURIComponent(m![1]!));
      if (!brew) return problemResponse(404, { title: 'Brew not found' });
      if (req.method === 'DELETE') return jsonResponse(replace({ ...brew, lock: null }));
      if (req.method === 'PUT') {
        const body = req.json as LockRequest;
        const errors: Record<string, string[]> = {};
        if (body.code == null || body.code < 100 || body.code > 999) errors.code = ['must be between 100 and 999'];
        if (!body.editMessage?.trim()) errors.editMessage = ['is required'];
        if (!body.shareMessage?.trim()) errors.shareMessage = ['is required'];
        if (Object.keys(errors).length) return validation(errors);
        return jsonResponse(
          replace({ ...brew, lock: { code: body.code!, editMessage: body.editMessage!, shareMessage: body.shareMessage!, applied: server.now(), reviewRequested: null } }),
        );
      }
    }
    if ((m = /^\/api\/admin\/brews\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const brew = findBrew(decodeURIComponent(m[1]!));
      return brew ? jsonResponse(brew) : problemResponse(404, { title: 'Brew not found' });
    }
    if (key === 'GET /api/admin/locks') {
      return jsonResponse(
        server.brews
          .filter((b) => b.lock)
          .sort((a, b) => Date.parse(b.lock!.applied) - Date.parse(a.lock!.applied))
          .map(lockedInfo),
      );
    }
    if (key === 'GET /api/admin/locks/review-queue') {
      return jsonResponse(
        server.brews
          .filter((b) => b.lock?.reviewRequested)
          .sort((a, b) => Date.parse(a.lock!.reviewRequested!) - Date.parse(b.lock!.reviewRequested!))
          .map(lockedInfo),
      );
    }
    if (path === '/api/admin/notifications') {
      if (req.method === 'GET') return jsonResponse([...server.notifications].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt)));
      if (req.method === 'POST') {
        const result = notificationInput(req.json as NotificationInput, null);
        if (result instanceof Response) return result;
        server.notifications = [...server.notifications, result];
        return jsonResponse(result, 201, { Location: `/api/admin/notifications/${result.id}` });
      }
    }
    if ((m = /^\/api\/admin\/notifications\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]!);
      const existing = server.notifications.find((n) => n.id === id);
      if (!existing) return problemResponse(404, { title: 'Notification not found' });
      if (req.method === 'GET') return jsonResponse(existing);
      if (req.method === 'DELETE') {
        server.notifications = server.notifications.filter((n) => n.id !== id);
        return emptyResponse(204);
      }
      if (req.method === 'PUT') {
        const result = notificationInput(req.json as NotificationInput, id);
        if (result instanceof Response) return result;
        server.notifications = server.notifications.map((n) => (n.id === id ? result : n));
        return jsonResponse(result);
      }
    }
    return problemResponse(404, { title: 'Not found' });
  };

  server.api = mockApi((req) => {
    const response = answer(req);
    server.log.push(`${req.method} ${req.url.pathname} ${response.status}`);
    return response;
  });
  return server;
}

/** The server's log lines for one method and path prefix. */
export const requestsTo = (server: AdminServer, method: string, prefix: string): string[] =>
  server.log.filter((line) => line.startsWith(`${method} ${prefix}`));
