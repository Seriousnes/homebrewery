// An in-memory API for the accessibility specs (web/e2e/a11y), routed per page with a predicate
// (a `**/api/**` glob would also catch Vite's /src/api/*.ts modules). It answers what the app's
// pages ask for: the account, notices, the theme list (theme bundles answer 404, so the canvas
// uses the static theme files), brews for /edit, /share and /new (create, save with optimistic
// concurrency, delete, lock review), user lists and the vault. /share/* documents come from the
// API's share shell; without one, the app's index.html is served. No API server is needed.
import { gunzipSync } from 'node:zlib';
import type { Page, Route } from '@playwright/test';

export interface FakeAccount {
  id: string;
  handle: string;
  email: string;
  roles: string[];
}

export const ALICE: FakeAccount = { id: '0190a11y-0000-7000-8000-000000000001', handle: 'alice', email: 'alice@example.test', roles: [] };
export const ADMIN: FakeAccount = { id: '0190a11y-0000-7000-8000-000000000002', handle: 'root', email: 'root@example.test', roles: ['Admin'] };

export interface FakeLock {
  code: number;
  message: string;
  applied: string;
  reviewRequested: string | null;
}

export interface FakeBrew {
  editId: string;
  shareId: string;
  version: number;
  doc: unknown;
  style: string;
  snippets: unknown;
  title: string;
  theme: string;
  published: boolean;
  owner: string;
  lock: FakeLock | null;
  views: number;
  updatedAt: string;
}

export interface FakeNotice {
  id: string;
  dismissKey: string;
  title: string;
  body: string;
  startsAt: string;
  stopsAt: string;
  createdAt: string;
}

export interface FakeApi {
  /** The signed-in account (null: anonymous; /me answers 204). */
  me: FakeAccount | null;
  /** Who POST /api/auth/login signs in. */
  loginAs: FakeAccount;
  notices: FakeNotice[];
  brews: Map<string, FakeBrew>;
  /** 'METHOD /path status' per request. */
  log: string[];
  /** The next PUT of this editId answers 409 (another tab saved). */
  conflictNext: Set<string>;
  /** While true, every PUT answers 500 (a failing server). */
  failSaves: boolean;
  add(brew: Partial<FakeBrew> & { doc: unknown }): FakeBrew;
  saves(editId?: string): string[];
}

const TIME = '2026-09-01T12:00:00.000Z';

export const THEMES = {
  static: [
    { key: '5ePHB', name: '5e PHB', renderer: 'V3', baseTheme: 'Blank', baseSnippets: null, path: '5ePHB', style: '/themes/V3/5ePHB/style.css', scopedStyle: '/themes/V3/5ePHB/style.scoped.css', preview: null, texture: null, hasSnippets: true },
    { key: 'Blank', name: 'Blank', renderer: 'V3', baseTheme: null, baseSnippets: null, path: 'Blank', style: '/themes/V3/Blank/style.css', scopedStyle: '/themes/V3/Blank/style.scoped.css', preview: null, texture: null, hasSnippets: true },
  ],
  user: [],
};

/** A one-page document with one paragraph per text. */
export function docOf(...texts: string[]): object {
  return {
    type: 'doc',
    content: [{ type: 'page', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) }],
  };
}

function meta(brew: FakeBrew) {
  return { title: brew.title, description: '', tags: [], lang: 'en', theme: brew.theme, published: brew.published, thumbnailUrl: null };
}

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
    meta: meta(brew),
    authors: [{ handle: brew.owner, role: 'owner' }],
    role: 'owner',
    pageCount: 1,
    views: brew.views,
    lock: brew.lock,
    createdAt: TIME,
    updatedAt: brew.updatedAt,
  };
}

function forShare(brew: FakeBrew, reader: FakeAccount | null) {
  return {
    shareId: brew.shareId,
    editId: reader?.handle === brew.owner ? brew.editId : null,
    docSchemaVersion: 1,
    doc: brew.doc,
    style: brew.style,
    meta: meta(brew),
    authors: [brew.owner],
    pageCount: 1,
    views: brew.views,
    createdAt: TIME,
    updatedAt: brew.updatedAt,
  };
}

function summary(brew: FakeBrew, own: boolean) {
  return {
    shareId: brew.shareId,
    editId: own ? brew.editId : null,
    title: brew.title,
    description: '',
    tags: [],
    authors: [brew.owner],
    theme: brew.theme,
    lang: 'en',
    pageCount: 1,
    views: brew.views,
    published: brew.published,
    thumbnailUrl: null,
    createdAt: TIME,
    updatedAt: brew.updatedAt,
    lastViewedAt: null,
    role: own ? 'owner' : null,
    locked: brew.lock !== null,
  };
}

let counter = 0;
const newId = (prefix: string) => `${prefix}${(++counter).toString(36).padStart(3, '0')}${Math.random().toString(36).slice(2, 10)}`.slice(0, 12);

export async function installFakeApi(page: Page, options: { me?: FakeAccount | null; notices?: FakeNotice[] } = {}): Promise<FakeApi> {
  const api: FakeApi = {
    me: options.me === undefined ? ALICE : options.me,
    loginAs: ALICE,
    notices: options.notices ?? [],
    brews: new Map(),
    log: [],
    conflictNext: new Set(),
    failSaves: false,
    add(partial) {
      const editId = partial.editId ?? newId('e');
      const brew: FakeBrew = {
        editId,
        shareId: partial.shareId ?? newId('s'),
        version: partial.version ?? 1,
        doc: partial.doc,
        style: partial.style ?? '',
        snippets: partial.snippets ?? null,
        title: partial.title ?? 'Accessible brew',
        theme: partial.theme ?? '5ePHB',
        published: partial.published ?? true,
        owner: partial.owner ?? ALICE.handle,
        lock: partial.lock ?? null,
        views: partial.views ?? 3,
        updatedAt: partial.updatedAt ?? TIME,
      };
      api.brews.set(editId, brew);
      return brew;
    },
    saves(editId) {
      return api.log.filter((line) => line.startsWith('PUT ') && (!editId || line.includes(`/api/brews/${editId} `)));
    },
  };

  // /share/* documents come from the API (the share shell); without one, serve the app's index.html.
  await page.route(
    (url) => url.pathname.startsWith('/share/'),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch({ url: new URL('/', route.request().url()).href });
      return route.fulfill({ response });
    },
  );

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      let body: Record<string, unknown> | null = null;
      const raw = request.postDataBuffer();
      if (raw && raw.length) {
        const gzip = (request.headers()['content-encoding'] ?? '') === 'gzip';
        try {
          body = JSON.parse((gzip ? gunzipSync(raw) : raw).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      const reply = (status: number, value?: unknown, type = 'application/json') => {
        api.log.push(`${method} ${path} ${status}`);
        if (value === undefined) return route.fulfill({ status });
        return route.fulfill({ status, contentType: type, body: JSON.stringify(value) });
      };
      const problem = (status: number, title: string) => reply(status, { status, title }, 'application/problem+json');

      if (path === '/api/account/me') return api.me ? reply(200, api.me) : reply(204);
      if (path === '/api/account/logout') {
        api.me = null;
        return reply(204);
      }
      if (path === '/api/auth/login') {
        api.me = api.loginAs;
        return reply(200, {});
      }
      if (path === '/api/notifications/active') return reply(200, api.notices);
      if (path === '/api/themes') return reply(200, THEMES);
      if (path.startsWith('/api/themes/')) return problem(404, 'Theme not found'); // static theme files

      const userList = /^\/api\/users\/([^/]+)\/brews$/.exec(path);
      if (userList) {
        const handle = decodeURIComponent(userList[1]!);
        const own = api.me?.handle === handle;
        const items = [...api.brews.values()].filter((b) => b.owner === handle && (own || (b.published && !b.lock))).map((b) => summary(b, own));
        return reply(200, { handle, own, items, total: items.length });
      }
      if (path === '/api/vault') {
        const items = [...api.brews.values()].filter((b) => b.published && !b.lock).map((b) => summary(b, false));
        return reply(200, { items, total: items.length, page: 1, pageSize: 20, sort: 'updated', dir: 'desc' });
      }

      if (path.startsWith('/api/brews') && !api.me && method !== 'GET') return problem(401, 'Sign in required');

      const edit = /^\/api\/brews\/edit\/([^/]+)$/.exec(path);
      if (method === 'GET' && edit) {
        if (!api.me) return problem(401, 'Sign in required');
        const brew = api.brews.get(decodeURIComponent(edit[1]!));
        return brew ? reply(200, forEdit(brew)) : problem(404, 'Brew not found');
      }
      const share = /^\/api\/brews\/share\/([^/]+)$/.exec(path);
      if (method === 'GET' && share) {
        const brew = [...api.brews.values()].find((b) => b.shareId === decodeURIComponent(share[1]!));
        if (!brew) return problem(404, 'Brew not found');
        if (brew.lock) return reply(423, { status: 423, title: 'This brew is locked', detail: brew.lock.message, code: brew.lock.code }, 'application/problem+json');
        if (api.me?.handle !== brew.owner) brew.views += 1;
        return reply(200, forShare(brew, api.me));
      }
      const review = /^\/api\/brews\/([^/]+)\/lock\/review$/.exec(path);
      if (method === 'POST' && review) {
        const brew = api.brews.get(decodeURIComponent(review[1]!));
        if (!brew?.lock) return problem(409, 'Not locked');
        brew.lock = { ...brew.lock, reviewRequested: new Date().toISOString() };
        return reply(200, brew.lock);
      }
      const one = /^\/api\/brews\/([^/]+)$/.exec(path);
      if (method === 'PUT' && one) {
        const editId = decodeURIComponent(one[1]!);
        const brew = api.brews.get(editId);
        if (!brew) return problem(404, 'Brew not found');
        if (api.failSaves) return problem(500, 'Something went wrong');
        if (api.conflictNext.delete(editId)) {
          brew.version += 1;
          return reply(409, { serverVersion: brew.version });
        }
        if (body?.baseVersion !== brew.version) return reply(409, { serverVersion: brew.version });
        brew.version += 1;
        brew.doc = body.doc;
        brew.style = typeof body.style === 'string' ? body.style : brew.style;
        brew.snippets = body.snippets ?? brew.snippets;
        const m = body.meta as { title?: string | null; theme?: string | null } | null;
        if (m?.title) brew.title = m.title;
        if (m?.theme) brew.theme = m.theme;
        brew.updatedAt = new Date().toISOString();
        return reply(200, { version: brew.version, updatedAt: brew.updatedAt, title: brew.title, pageCount: 1, authors: [{ handle: brew.owner, role: 'owner' }] });
      }
      if (method === 'DELETE' && one) {
        const editId = decodeURIComponent(one[1]!);
        if (!api.brews.delete(editId)) return problem(404, 'Brew not found');
        return reply(200, { brewDeleted: true });
      }
      if (method === 'POST' && path === '/api/brews') {
        const m = body?.meta as { title?: string | null; theme?: string | null } | null;
        const brew = api.add({
          doc: body?.doc ?? docOf(''),
          style: typeof body?.style === 'string' ? body.style : '',
          snippets: body?.snippets ?? null,
          title: m?.title || 'Untitled brew',
          theme: m?.theme || '5ePHB',
          owner: api.me!.handle,
          published: false,
          views: 0,
        });
        return reply(201, forEdit(brew));
      }
      return problem(404, 'Not found');
    },
  );
  return api;
}
