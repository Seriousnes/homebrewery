// /import (P6.1, P6.3) with the conversion and the preview stubbed: the three sources, the report
// before saving (and its page counts once the preview settles), the create request, sign-in
// hand-offs, the per-tab session, and the error messages. The real conversion and preview run in
// e2e/import-ui.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/api';
import { jsonResponse, mockApi, problemResponse, type RecordedRequest, textResponse } from '@/api/testing';
import { closeSignInPrompt } from '@/app/signInPromptStore';
import { ALICE, renderRoute } from '@/app/testing';
import type { ImportReportData } from '@/editor/import/importReport';
import { DOC_SCHEMA_VERSION } from '@/editor/schema/version';
import type { ImportPreviewProps } from '@/editor/ui/importReport';
import { clearToasts } from '@/ui';
import type { ImportConversion } from './convert';
import { type ConvertFn, ImportPage } from './ImportPage';
import { IMPORT_SESSION_KEY } from './importSession';

const SHARE = 'abcdefghij12';

function fakeReport(overrides: Partial<ImportReportData> = {}): ImportReportData {
  return {
    pages: 1,
    theme: '5eDMG',
    clippedPages: [{ page: 1, estimatedPages: 2 }],
    variables: { mode: 'expand', definitions: [{ name: 'hp', page: 1, form: 'block' }], unresolved: [] },
    paginated: null,
    rawHtml: { count: 0, samples: [] },
    commentsDropped: 2,
    styleTagsLifted: 0,
    unknownClasses: [],
    sanitizer: { elements: {}, attributes: {} },
    transparentElements: {},
    lifted: { markers: 0, footers: 0, pageNumbers: 0, objects: 0 },
    positionedInFlow: [],
    lost: [],
    warnings: [],
    ...overrides,
  };
}

const docOf = (text: string): JSONContent => ({
  type: 'doc',
  content: [{ type: 'page', attrs: { kind: 'manual' }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }],
});

/** A conversion of `text`: its title is the text, so tests can tell conversions apart. */
function fakeConversion(text: string, overrides: Partial<ImportConversion> = {}): ImportConversion {
  return {
    result: { doc: docOf(text), style: '.glow { color: red }', meta: { title: text }, report: fakeReport(), html: '' },
    meta: { title: text, description: 'About it', tags: ['dungeon'], lang: 'fr', theme: '5eDMG' },
    snippets: [{ name: 'Trap', gen: '{{note\nPit\n}}' }],
    theme: '5eDMG',
    themeName: '5e DMG',
    notes: [],
    ...overrides,
  };
}

/** The document the stub preview "paginates" to: source page 1 now spans two pages. */
const PAGINATED: JSONContent = {
  type: 'doc',
  content: [
    { type: 'page', attrs: { kind: 'manual' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'laid out' }] }] },
    { type: 'page', attrs: { kind: 'auto' }, content: [{ type: 'paragraph' }] },
  ],
};

const preview = { settle: true as boolean, props: [] as ImportPreviewProps[] };

/**
 * Records its first props and, unless told otherwise, settles once with PAGINATED. Like the real
 * preview, it reads the latest onSettled from a ref (the page passes a new function every render).
 */
function StubPreview(props: ImportPreviewProps) {
  useState(() => preview.props.push(props));
  const onSettled = useRef(props.onSettled);
  useEffect(() => {
    onSettled.current = props.onSettled;
  });
  useEffect(() => {
    if (preview.settle) onSettled.current?.({ doc: PAGINATED as unknown as PMNode, json: () => PAGINATED });
  }, []);
  return <div data-testid="stub-preview" />;
}

interface Setup {
  convert?: ConvertFn;
  me?: typeof ALICE | null;
  /** Answers some requests (undefined: the default answer). */
  api?: (request: RecordedRequest) => Response | undefined;
}

function setup({ convert = vi.fn((text: string) => Promise.resolve(fakeConversion(text))), me = ALICE, api }: Setup = {}) {
  const server = mockApi((request) => {
    const handled = api?.(request);
    if (handled) return handled;
    if (request.method === 'POST' && request.url.pathname === '/api/brews') return jsonResponse({ editId: 'newEdit1', shareId: 'newShare1', version: 1 }, 201);
    return jsonResponse([]);
  });
  const prefetch = vi.fn();
  const view = renderRoute(<ImportPage convert={convert} Preview={StubPreview} prefetch={prefetch} />, {
    url: '/import',
    path: 'import',
    me,
    routes: [{ path: 'edit/:editId', element: <p>Editor page</p> }],
  });
  const posts = () => server.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/api/brews');
  return { ...view, server, posts, convert, prefetch };
}

beforeEach(() => {
  preview.settle = true;
  preview.props = [];
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  // The prompt's store is module state: an open dialog would trap the next test's focus.
  closeSignInPrompt();
});

const brewText = () => screen.getByLabelText('Brew text');

describe('ImportPage', () => {
  it('pasted text: shows the report before saving, then creates the brew and opens it', async () => {
    const { user, router, posts, convert, prefetch } = setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Import a brew' })).toBeInTheDocument();
    await user.type(brewText(), '# Hello');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    expect(convert).toHaveBeenCalledWith('# Hello');

    // The report, with the page counts from the settled preview.
    const report = await screen.findByTestId('import-report');
    // The stub preview settles in an effect after the report first shows: wait for its page counts.
    await waitFor(() => expect(report).toHaveAttribute('data-layout', 'done'));
    expect(screen.getByTestId('import-report-pages-count')).toHaveTextContent('2');
    expect(screen.getByTestId('import-report-clipped-count')).toHaveTextContent('1');
    expect(within(screen.getByTestId('import-report-clipped')).getByText('Page 1: now 2 pages')).toBeInTheDocument();
    expect(screen.getByTestId('import-report-variables-count')).toHaveTextContent('1');
    expect(screen.getByTestId('import-report-comments-count')).toHaveTextContent('2');
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: '2. Check the import' })).toHaveFocus());
    expect(screen.getByTestId('import-meta-title')).toHaveTextContent('# Hello');
    expect(screen.getByTestId('import-meta-theme')).toHaveTextContent('5e DMG');
    expect(screen.getByTestId('import-meta-pages')).toHaveTextContent('2');
    expect(screen.getByTestId('import-meta-tags')).toHaveTextContent('dungeon');
    expect(screen.getByTestId('import-status')).toHaveTextContent('Converted. 2 pages;');
    await waitFor(() => expect(prefetch).toHaveBeenCalledTimes(1));
    // The preview gets the brew's theme, CSS and language.
    expect(preview.props[0]).toMatchObject({ theme: '5eDMG', style: '.glow { color: red }', lang: 'fr', doc: docOf('# Hello') });
    expect(posts()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Create brew' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/newEdit1'));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.json).toEqual({
      doc: PAGINATED,
      style: '.glow { color: red }',
      snippets: [{ name: 'Trap', gen: '{{note\nPit\n}}' }],
      meta: { title: '# Hello', description: 'About it', tags: ['dungeon'], lang: 'fr', theme: '5eDMG' },
      sourceMarkdown: '# Hello',
      docSchemaVersion: DOC_SCHEMA_VERSION,
    });
    expect(sessionStorage.getItem(IMPORT_SESSION_KEY)).toBeNull();
  });

  it('a session write still pending when the brew is created does not bring the session back', async () => {
    let openEditor!: () => void;
    const editorLoaded = new Promise<void>((resolve) => (openEditor = resolve));
    const server = mockApi((request) =>
      request.method === 'POST' && request.url.pathname === '/api/brews' ? jsonResponse({ editId: 'newEdit1', shareId: 'newShare1', version: 1 }, 201) : jsonResponse([]),
    );
    const { user, router } = renderRoute(<ImportPage convert={(t) => Promise.resolve(fakeConversion(t))} Preview={StubPreview} prefetch={vi.fn()} />, {
      url: '/import',
      path: 'import',
      me: ALICE,
      // The editor route is still loading after the create: the import page stays mounted meanwhile.
      routes: [
        {
          path: 'edit/:editId',
          lazy: async () => {
            await editorLoaded;
            return { Component: () => <p>Editor page</p> };
          },
        },
      ],
    });
    await user.type(brewText(), '# Hello');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    await waitFor(() => expect(screen.getByTestId('import-report')).toHaveAttribute('data-layout', 'done'));
    // Create right away, within the page's delayed session write (300 ms after the conversion changed it).
    await user.click(screen.getByRole('button', { name: 'Create brew' }));
    await waitFor(() => expect(server.requests.some((r) => r.method === 'POST')).toBe(true));
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(sessionStorage.getItem(IMPORT_SESSION_KEY)).toBeNull();
    openEditor();
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/newEdit1'));
    expect(sessionStorage.getItem(IMPORT_SESSION_KEY)).toBeNull();
  });

  it('before the preview has settled, says the layout is running and creates the converted document', async () => {
    preview.settle = false;
    const { user, router, posts } = setup();
    await user.type(brewText(), 'Plain');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    const report = await screen.findByTestId('import-report');
    expect(report).toHaveAttribute('data-layout', 'pending');
    expect(screen.getByTestId('import-report-pages')).toHaveTextContent('Laying out the pages…');
    expect(screen.getByText('Page 1: about 2 pages (laying out…)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create brew' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/newEdit1'));
    expect((posts()[0]!.json as { doc: unknown }).doc).toEqual(docOf('Plain'));
  });

  it('a preview that fails to load says the page counts are unavailable', async () => {
    preview.settle = false;
    function FailingPreview(props: ImportPreviewProps) {
      const onStatusChange = useRef(props.onStatusChange);
      useEffect(() => {
        onStatusChange.current?.({ state: 'error', message: 'offline' } as Parameters<NonNullable<ImportPreviewProps['onStatusChange']>>[0]);
      }, []);
      return null;
    }
    mockApi(() => jsonResponse([]));
    const { user } = renderRoute(<ImportPage convert={(t) => Promise.resolve(fakeConversion(t))} Preview={FailingPreview} prefetch={vi.fn()} />, {
      url: '/import',
      path: 'import',
      me: ALICE,
    });
    await user.type(brewText(), 'Text');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    await waitFor(() => expect(screen.getByTestId('import-report')).toHaveAttribute('data-layout', 'unavailable'));
    expect(screen.getByTestId('import-report-pages')).toHaveTextContent('1 page in the source.');
  });

  it('refuses an empty paste', async () => {
    const { user, convert } = setup();
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    expect(screen.getByTestId('import-paste-error')).toHaveTextContent('Paste the brew’s text first.');
    expect(brewText()).toHaveFocus();
    expect(convert).not.toHaveBeenCalled();
    await user.type(brewText(), 'x');
    expect(screen.queryByTestId('import-paste-error')).not.toBeInTheDocument();
  });

  it('a newer conversion wins over one still running', async () => {
    let finishFirst: (c: ImportConversion) => void = () => {};
    const convert = vi.fn((text: string) =>
      text === 'First' ? new Promise<ImportConversion>((resolve) => (finishFirst = resolve)) : Promise.resolve(fakeConversion(text)),
    );
    const { user } = setup({ convert });
    await user.type(brewText(), 'First');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    expect(await screen.findByTestId('import-converting')).toBeInTheDocument();
    // While the paste converts, a file is chosen: its conversion is the one shown.
    await user.click(screen.getByRole('tab', { name: 'Upload a file' }));
    await user.upload(screen.getByLabelText('Brew file'), new File(['Second'], 'second.txt', { type: 'text/plain' }));
    expect(await screen.findByTestId('import-meta-title')).toHaveTextContent('Second');
    // The first conversion finishes late (its promise callbacks run inside the act).
    await act(async () => {
      finishFirst(fakeConversion('First'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('import-meta-title')).toHaveTextContent('Second');
    expect(screen.getByTestId('import-source')).toHaveTextContent('From the file second.txt');
  });

  it('explains a legacy-renderer brew, and Start over clears the page', async () => {
    const convert = vi.fn(() => Promise.reject(Object.assign(new Error('legacy'), { code: 'legacy-renderer' })));
    const { user } = setup({ convert });
    await user.type(brewText(), 'Old brew');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    const problem = await screen.findByTestId('import-convert-error');
    expect(problem).toHaveTextContent('This brew uses the legacy renderer');
    expect(problem).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('import-create')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.queryByTestId('import-check')).not.toBeInTheDocument();
    expect(brewText()).toHaveValue('');
    await waitFor(() => expect(brewText()).toHaveFocus());
  });

  it('an uploaded file is read and converted; other files are refused', async () => {
    const { user, convert } = setup();
    await user.click(screen.getByRole('tab', { name: 'Upload a file' }));
    const input = screen.getByLabelText('Brew file');
    await user.upload(input, new File(['# From a file'], 'brew.md', { type: 'text/markdown' }));
    await waitFor(() => expect(convert).toHaveBeenCalledWith('# From a file'));
    expect(await screen.findByTestId('import-source')).toHaveTextContent('From the file brew.md');

    // The picker's accept filter hides other files; a drop or "All files" still gets them here.
    fireEvent.change(input, { target: { files: [new File(['x'], 'map.png', { type: 'image/png' })] } });
    expect(await screen.findByTestId('import-file-error')).toHaveTextContent('Choose a .txt or .md file');
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('a share link is downloaded through the API, then converted', async () => {
    const { user, convert, server } = setup({
      api: (r) => (r.url.pathname === `/api/import/homebrewery/${SHARE}` ? textResponse('# From upstream') : undefined),
    });
    await user.click(screen.getByRole('tab', { name: 'Homebrewery link' }));
    await user.type(screen.getByLabelText('Share link or share id'), `https://homebrewery.naturalcrit.com/share/${SHARE}`);
    await user.click(screen.getByRole('button', { name: 'Download and preview' }));
    await waitFor(() => expect(convert).toHaveBeenCalledWith('# From upstream'));
    expect(server.requests.some((r) => r.method === 'GET' && r.url.pathname === `/api/import/homebrewery/${SHARE}`)).toBe(true);
    const source = await screen.findByTestId('import-source');
    expect(source).toHaveTextContent(`the Homebrewery brew ${SHARE}`);
    expect(within(source).getByRole('link', { name: /open it on the Homebrewery/ })).toHaveAttribute('href', `https://homebrewery.naturalcrit.com/share/${SHARE}`);
  });

  it('maps the proxy’s refusals to messages, and refuses bad links without a request', async () => {
    const { user, convert, server } = setup({
      api: (r) =>
        r.url.pathname.startsWith('/api/import/homebrewery/') ? problemResponse(502, { title: 'Download from the Homebrewery failed', upstreamStatus: 455 }) : undefined,
    });
    await user.click(screen.getByRole('tab', { name: 'Homebrewery link' }));
    const field = screen.getByLabelText('Share link or share id');
    await user.type(field, SHARE);
    await user.click(screen.getByRole('button', { name: 'Download and preview' }));
    expect(await screen.findByTestId('import-link-error')).toHaveTextContent('code 455, which means the brew is locked');
    expect(convert).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, 'https://homebrewery.naturalcrit.com/edit/abcdefghijkl');
    const before = server.requests.length;
    await user.click(screen.getByRole('button', { name: 'Download and preview' }));
    expect(screen.getByTestId('import-link-error')).toHaveTextContent('That is an edit link');
    expect(server.requests.length).toBe(before);
  });

  it('anonymous: "Create" asks to sign in, and the create goes on once signed in', async () => {
    const { user, router, posts, queryClient } = setup({ me: null });
    await user.type(brewText(), 'Later');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    expect(await screen.findByTestId('import-sign-in-note')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in and create the brew' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
    expect(posts()).toEqual([]);
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/newEdit1'));
    expect(posts()).toHaveLength(1);
  });

  it('anonymous: "Sign in and download" asks to sign in, then downloads', async () => {
    const { user, convert, queryClient } = setup({
      me: null,
      api: (r) => (r.url.pathname === `/api/import/homebrewery/${SHARE}` ? textResponse('# Linked') : undefined),
    });
    await user.click(screen.getByRole('tab', { name: 'Homebrewery link' }));
    expect(screen.getByTestId('import-link-sign-in-note')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Share link or share id'), SHARE);
    await user.click(screen.getByRole('button', { name: 'Sign in and download' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
    expect(convert).not.toHaveBeenCalled();
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    await waitFor(() => expect(convert).toHaveBeenCalledWith('# Linked'));
  });

  it('a create refused with 401 asks to sign in and tries again after', async () => {
    let signedIn = false;
    const { user, router, posts, queryClient } = setup({
      api: (r) => (r.method === 'POST' && r.url.pathname === '/api/brews' && !signedIn ? problemResponse(401, { title: 'Unauthorized' }) : undefined),
    });
    await user.type(brewText(), 'Expired');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    await user.click(await screen.findByRole('button', { name: 'Create brew' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    // The 401 ended the session (the query client's policy); signing in again resumes the create.
    signedIn = true;
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), null);
    });
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/newEdit1'));
    expect(posts()).toHaveLength(2);
  });

  it('shows why the server refused the brew', async () => {
    const { user, router } = setup({
      api: (r) =>
        r.method === 'POST' && r.url.pathname === '/api/brews'
          ? problemResponse(400, { title: 'One or more validation errors occurred.', errors: { 'meta.title': ['Too long.'] } })
          : undefined,
    });
    await user.type(brewText(), 'Bad');
    await user.click(screen.getByRole('button', { name: 'Preview the import' }));
    await user.click(await screen.findByRole('button', { name: 'Create brew' }));
    expect(await screen.findByTestId('import-create-error')).toHaveTextContent('The server refused the brew. meta.title: Too long.');
    expect(router.state.location.pathname).toBe('/import');
  });

  it('keeps the text for the tab, and converts a loaded text again after a reload', async () => {
    const first = setup();
    await first.user.type(brewText(), 'Kept text');
    await first.user.click(screen.getByRole('button', { name: 'Preview the import' }));
    await screen.findByTestId('import-report');
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem(IMPORT_SESSION_KEY) ?? '{}')).toMatchObject({ paste: 'Kept text', loaded: { kind: 'paste', samePaste: true } }));
    first.unmount();

    const second = setup();
    expect(brewText()).toHaveValue('Kept text');
    await waitFor(() => expect(second.convert).toHaveBeenCalledWith('Kept text'));
    expect(second.convert).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('import-report')).toBeInTheDocument();
    // Restored, not started by the visitor: the focus stays where it was.
    expect(screen.getByRole('heading', { level: 2, name: '2. Check the import' })).not.toHaveFocus();
  });
});
