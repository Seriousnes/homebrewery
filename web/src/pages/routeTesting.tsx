// Vitest only (never import from app code): the app's real routes (web/src/app/routes.tsx) in a
// memory router, over a small in-memory brew API. For route-level tests of the editor, share and
// account flows. Mock the theme loader in the test file (vi.mock('@/editor/canvas/themeLoader')).
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSONContent } from '@tiptap/core';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { AccountInfo, BrewAuthorInfo, BrewForEdit, BrewForShare, BrewLockInfo, BrewMeta } from '@/api';
import { emptyResponse, jsonResponse, mockApi, problemResponse, type RecordedRequest } from '@/api/testing';
import { queryKeys } from '@/api';
import { routes } from '@/app/routes';
import { testQueryClient } from '@/app/testing';

// jsdom has no layout: ProseMirror measures the selection (scrollToSelection) after typing.
if (!('getClientRects' in Range.prototype)) {
  Object.assign(Range.prototype, {
    getClientRects: () => Object.assign([], { item: () => null }),
    getBoundingClientRect: () => new DOMRect(),
  });
}

export interface FakeBrew {
  editId: string;
  shareId: string;
  version: number;
  doc: JSONContent;
  style: string;
  snippets: unknown;
  meta: BrewMeta;
  authors: BrewAuthorInfo[];
  lock: BrewLockInfo | null;
  views: number;
}

export const pageDoc = (text: string): JSONContent => ({
  type: 'doc',
  content: [{ type: 'page', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] }],
});

export function fakeBrew(editId: string, overrides: Partial<FakeBrew> = {}): FakeBrew {
  return {
    editId,
    shareId: `share${editId}`,
    version: 3,
    doc: pageDoc('Old text'),
    style: '',
    snippets: null,
    meta: { title: 'Orig', description: '', tags: [], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: null },
    authors: [{ handle: 'alice', role: 'owner' }],
    lock: null,
    views: 0,
    ...overrides,
  };
}

/** Plain text of a document (paragraph texts joined with spaces). */
export function docText(doc: unknown): string {
  const out: string[] = [];
  const visit = (node: JSONContent) => {
    if (typeof node.text === 'string') out.push(node.text);
    node.content?.forEach(visit);
  };
  visit(doc as JSONContent);
  return out.join('');
}

export type Override = (request: RecordedRequest, server: BrewServer) => Response | Promise<Response> | undefined;

export interface BrewServer {
  /** The account the session cookie belongs to (null: no session). */
  me: AccountInfo | null;
  /** Who a POST /api/auth/login signs in. */
  loginAs: AccountInfo | null;
  brews: Map<string, FakeBrew>;
  requests: RecordedRequest[];
  /** 'METHOD /path status' per answered request, in order. */
  log: string[];
  /** Answers first when it returns a response. */
  override: Override | null;
  /** Milliseconds before answering a request (by 'METHOD /path' prefix match). */
  delays: Record<string, number>;
  nextId: number;
}

function shareView(brew: FakeBrew, me: AccountInfo | null): BrewForShare {
  const author = me !== null && brew.authors.some((a) => a.handle === me.handle && a.role !== 'invited');
  return {
    shareId: brew.shareId,
    editId: author ? brew.editId : null,
    docSchemaVersion: 1,
    doc: brew.doc,
    style: brew.style,
    meta: brew.meta,
    authors: brew.authors.filter((a) => a.role !== 'invited').map((a) => a.handle),
    pageCount: 1,
    views: brew.views,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  };
}

export function editView(brew: FakeBrew): BrewForEdit {
  return {
    editId: brew.editId,
    shareId: brew.shareId,
    version: brew.version,
    docSchemaVersion: 1,
    doc: brew.doc,
    style: brew.style,
    snippets: brew.snippets,
    sourceMarkdown: null,
    meta: brew.meta,
    authors: brew.authors,
    role: 'owner',
    pageCount: 1,
    views: brew.views,
    lock: brew.lock,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  };
}

async function answer(request: RecordedRequest, server: BrewServer): Promise<Response> {
  const own = await server.override?.(request, server);
  if (own) return own;
  const { method } = request;
  const path = request.url.pathname;
  const body = (request.json ?? {}) as Record<string, unknown>;
  if (path === '/api/account/me') return server.me ? jsonResponse(server.me) : emptyResponse(204);
  if (path === '/api/account/logout' && method === 'POST') {
    if (!server.me) return problemResponse(401, { title: 'Unauthorized' });
    server.me = null;
    return emptyResponse(200);
  }
  if (path === '/api/auth/login' && method === 'POST') {
    server.me = server.loginAs;
    return emptyResponse(200);
  }
  if (path === '/api/themes') return jsonResponse({ static: [], user: [] });
  if (path === '/api/notifications/active') return jsonResponse([]);
  if (path.startsWith('/api/users/')) return jsonResponse({ handle: path.split('/')[3] ?? '', own: false, items: [], total: 0 });

  const share = /^\/api\/brews\/share\/([\w-]+)$/.exec(path);
  if (share) {
    const brew = [...server.brews.values()].find((b) => b.shareId === share[1]);
    if (!brew) return problemResponse(404, { title: 'Brew not found' });
    const author = server.me !== null && brew.authors.some((a) => a.handle === server.me?.handle);
    if (!author) brew.views++;
    return jsonResponse(shareView(brew, server.me));
  }
  const edit = /^\/api\/brews\/edit\/([\w-]+)$/.exec(path);
  if (edit) {
    if (!server.me) return problemResponse(401, { title: 'Unauthorized' });
    const brew = server.brews.get(edit[1] ?? '');
    return brew ? jsonResponse(editView(brew)) : problemResponse(404, { title: 'Brew not found' });
  }
  if (path === '/api/brews' && method === 'POST') {
    if (!server.me) return problemResponse(401, { title: 'Unauthorized' });
    const id = `new${String.fromCharCode(65 + server.nextId++)}`;
    const meta = (body.meta ?? {}) as Partial<BrewMeta>;
    const brew = fakeBrew(id, {
      version: 1,
      doc: body.doc as JSONContent,
      style: (body.style as string) ?? '',
      meta: { ...fakeBrew(id).meta, title: meta.title ?? '' },
      authors: [{ handle: server.me.handle, role: 'owner' }],
    });
    server.brews.set(id, brew);
    return jsonResponse(editView(brew), 201);
  }
  const one = /^\/api\/brews\/([\w-]+)$/.exec(path);
  if (one && method === 'PUT') {
    if (!server.me) return problemResponse(401, { title: 'Unauthorized' });
    const brew = server.brews.get(one[1] ?? '');
    if (!brew) return problemResponse(404, { title: 'Brew not found' });
    if (body.baseVersion !== brew.version) return jsonResponse({ serverVersion: brew.version }, 409);
    brew.version++;
    brew.doc = body.doc as JSONContent;
    brew.style = (body.style as string) ?? brew.style;
    const meta = body.meta as (Partial<BrewMeta> & { authors?: string[] | null }) | null;
    if (meta?.title != null) brew.meta = { ...brew.meta, title: meta.title };
    return jsonResponse({ version: brew.version, updatedAt: '2026-09-02T00:00:00Z', title: brew.meta.title, pageCount: 1, authors: brew.authors });
  }
  if (one && method === 'DELETE') {
    if (!server.me) return problemResponse(401, { title: 'Unauthorized' });
    server.brews.delete(one[1] ?? '');
    return jsonResponse({ brewDeleted: true });
  }
  return problemResponse(404, { title: 'Not found' });
}

/** The fake API behind global fetch (mockApi). Restore with vi.unstubAllGlobals(). */
export function createBrewServer({ me = null, brews = [] }: { me?: AccountInfo | null; brews?: FakeBrew[] } = {}): BrewServer {
  const server: BrewServer = {
    me,
    loginAs: me,
    brews: new Map(brews.map((b) => [b.editId, b])),
    requests: [],
    log: [],
    override: null,
    delays: {},
    nextId: 0,
  };
  const api = mockApi(async (request) => {
    const key = `${request.method} ${request.url.pathname}`;
    const delay = Object.entries(server.delays).find(([prefix]) => key.startsWith(prefix))?.[1];
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const response = await answer(request, server);
    server.log.push(`${key} ${response.status}`);
    return response;
  });
  server.requests = api.requests;
  return server;
}

/** Requests matching 'METHOD /path' (exact path) in the server log, with their statuses. */
export const logOf = (server: BrewServer, method: string, path: string): string[] =>
  server.log.filter((line) => line.startsWith(`${method} ${path} `)).map((line) => line.slice(method.length + path.length + 2));

/** The app (routes, query client, sign-in dialog) at `url`, with `me` cached when given. */
export function renderApp({ url, me }: { url: string; me?: AccountInfo | null }) {
  const queryClient = testQueryClient();
  if (me !== undefined) queryClient.setQueryData(queryKeys.account.me(), me);
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient, user };
}

/**
 * Loads the lazy editor pages and the EditorApp chunk up front. Call it in beforeAll with a long
 * timeout: in a full, parallel run the first import took longer than a test's waits.
 */
export async function preloadAppPages(): Promise<void> {
  await Promise.all([import('@/editor/EditorApp/EditorApp'), import('@/pages/edit'), import('@/pages/share'), import('@/pages/user'), import('@/pages/vault')]);
}

/** The editor of the page (dev API; null until one is ready). */
export const appEditor = () => window.__hbEditorApp?.editor ?? null;

/** Type at the end of the document's first paragraph. */
export function typeInEditor(text: string): void {
  const editor = appEditor();
  if (!editor) throw new Error('No editor');
  act(() => {
    let end = 0;
    editor.state.doc.descendants((node, pos) => {
      if (end === 0 && node.type.name === 'paragraph') end = pos + node.nodeSize - 1;
      return end === 0;
    });
    editor.chain().setTextSelection(end).insertContent(text).run();
  });
}

export function pressSaveKey(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }));
  });
}
