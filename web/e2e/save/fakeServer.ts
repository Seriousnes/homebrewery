// An in-memory stand-in for the brew endpoints (plan §8.3, §8.4), routed per browser context so
// two tabs share it: optimistic concurrency (409 with serverVersion), gzip request bodies, 401
// when signed out. The save specs run against it when no private API is available; the
// real-API spec (autosave-api.spec.ts) covers the same flows end to end. It also answers the
// few other calls of the app's editor pages (theme list, notices), for recovery.spec.ts.
import { gunzipSync } from 'node:zlib';
import type { BrowserContext, Route } from '@playwright/test';

export interface FakeBrew {
  editId: string;
  shareId: string;
  version: number;
  doc: unknown;
  style: string;
  snippets: unknown;
  title: string;
  updatedAt: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  gzip: boolean;
  body: Record<string, unknown> | null;
}

export interface FakeServer {
  brews: Map<string, FakeBrew>;
  calls: RecordedCall[];
  /** Signed-in session (false: every brew endpoint answers 401, /me 204). */
  signedIn: boolean;
  /** How PUTs fail: false (they don't), 'network' (connection error) or an HTTP status. */
  failPuts: false | 'network' | number;
  add(brew: Partial<FakeBrew> & { doc: unknown }): FakeBrew;
  saves(editId?: string): RecordedCall[];
}

let counter = 0;

function forEdit(brew: FakeBrew) {
  return {
    editId: brew.editId,
    shareId: brew.shareId,
    version: brew.version,
    docSchemaVersion: 1,
    doc: brew.doc,
    style: brew.style,
    snippets: brew.snippets,
    sourceMarkdown: null,
    meta: { title: brew.title, description: '', tags: [], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: null },
    authors: [{ handle: 'tester', role: 'owner' }],
    role: 'owner',
    pageCount: 1,
    views: 0,
    lock: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: brew.updatedAt,
  };
}

const json = (route: Route, status: number, body: unknown, type = 'application/json') =>
  route.fulfill({ status, contentType: type, body: JSON.stringify(body) });

const problem = (route: Route, status: number, title: string) => json(route, status, { status, title }, 'application/problem+json');

export async function installFakeServer(context: BrowserContext): Promise<FakeServer> {
  const server: FakeServer = {
    brews: new Map(),
    calls: [],
    signedIn: true,
    failPuts: false,
    add(partial) {
      const id = partial.editId ?? `fake-${++counter}-${Date.now().toString(36)}`;
      const brew: FakeBrew = {
        editId: id,
        shareId: partial.shareId ?? `share-${id}`,
        version: partial.version ?? 1,
        doc: partial.doc,
        style: partial.style ?? '',
        snippets: partial.snippets ?? null,
        title: partial.title ?? 'Fake brew',
        updatedAt: new Date().toISOString(),
      };
      server.brews.set(id, brew);
      return brew;
    },
    saves(editId) {
      return server.calls.filter((c) => c.method === 'PUT' && (!editId || c.path === `/api/brews/${editId}`));
    },
  };

  // A predicate, not '**/api/**': that glob also matches Vite's /src/api/*.ts modules.
  await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const gzip = (request.headers()['content-encoding'] ?? '') === 'gzip';
    let body: Record<string, unknown> | null = null;
    const raw = request.postDataBuffer();
    if (raw && raw.length) body = JSON.parse((gzip ? gunzipSync(raw) : raw).toString('utf8')) as Record<string, unknown>;
    server.calls.push({ method, path, gzip, body });

    if (path.startsWith('/api/themes/')) return problem(route, 404, 'Theme not found'); // static theme fallback
    // What the app's own pages (/edit, /new; recovery.spec.ts) ask for besides brews.
    if (path === '/api/themes') return json(route, 200, { static: [], user: [] });
    if (path === '/api/notifications/active') return json(route, 200, []);
    if (path === '/api/account/me') {
      return server.signedIn
        ? json(route, 200, { id: '00000000-0000-7000-8000-000000000001', handle: 'tester', email: 'tester@example.com', roles: [] })
        : route.fulfill({ status: 204 });
    }
    if (!server.signedIn && path.startsWith('/api/brews')) return problem(route, 401, 'Sign in required');

    const edit = /^\/api\/brews\/edit\/([^/]+)$/.exec(path);
    if (method === 'GET' && edit) {
      const brew = server.brews.get(decodeURIComponent(edit[1]!));
      return brew ? json(route, 200, forEdit(brew)) : problem(route, 404, 'Brew not found');
    }

    const save = /^\/api\/brews\/([^/]+)$/.exec(path);
    if (method === 'PUT' && save) {
      if (server.failPuts === 'network') return route.abort('failed');
      if (typeof server.failPuts === 'number') return problem(route, server.failPuts, 'Failed');
      const brew = server.brews.get(decodeURIComponent(save[1]!));
      if (!brew) return problem(route, 404, 'Brew not found');
      if (body?.baseVersion !== brew.version) return json(route, 409, { serverVersion: brew.version });
      brew.version += 1;
      brew.doc = body.doc;
      brew.style = typeof body.style === 'string' ? body.style : '';
      brew.snippets = body.snippets ?? null;
      const meta = body.meta as { title?: string | null } | null;
      if (meta?.title) brew.title = meta.title;
      brew.updatedAt = new Date().toISOString();
      return json(route, 200, { version: brew.version, updatedAt: brew.updatedAt, title: brew.title, pageCount: 1, authors: [{ handle: 'tester', role: 'owner' }] });
    }

    if (method === 'POST' && path === '/api/brews') {
      const meta = body?.meta as { title?: string | null } | null;
      const brew = server.add({ doc: body?.doc, style: typeof body?.style === 'string' ? body.style : '', snippets: body?.snippets ?? null, title: meta?.title || 'Untitled' });
      return json(route, 201, forEdit(brew));
    }

    return problem(route, 404, 'Not found');
  });

  return server;
}
