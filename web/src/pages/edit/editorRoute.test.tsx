// The editor route (/new and /edit/:editId) with the app's real routes over a fake brew API:
// which session the URL shows, where the page goes after a create or a copy, and what leaving,
// signing out or deleting does to saving.
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recentBrewsStore, recordRecentBrew } from '@/app/recentBrews';
import { ALICE } from '@/app/testing';
import { uiStore } from '@/app/uiStore';
import type { AppliedThemeStyles, ThemeChain } from '@/editor/canvas/themeLoader';
import { readDraftsFor } from '@/editor/save/drafts';
import { defaultDraftStore, defaultSnapshotHistory } from '@/editor/save/stores';
import { appEditor, createBrewServer, docText, fakeBrew, logOf, preloadAppPages, pressSaveKey, renderApp, typeInEditor } from '@/pages/routeTesting';
import { clearToasts } from '@/ui';

const loader = vi.hoisted(() => ({
  loadThemeChain: vi.fn(),
  applyThemeStyles: vi.fn(),
  waitForFonts: vi.fn(),
  disposeThemeSlot: vi.fn(),
}));
vi.mock('@/editor/canvas/themeLoader', () => loader);

const chainOf = (theme: string): ThemeChain => ({ theme, source: 'static', name: theme, author: null, styles: [], snippets: [] });

// The editor pages are lazy chunks: load them once, before the tests' waits start (hook timeout).
beforeAll(() => preloadAppPages());

async function clearDrafts() {
  const store = defaultDraftStore();
  await store.delMany((await store.entries()).map(([key]) => key));
}

async function clearSnapshots() {
  await Promise.all(['origA', 'keepB', 'newA', 'newB'].map((id) => defaultSnapshotHistory().clear(id)));
}

beforeEach(async () => {
  uiStore.getState().resetUi();
  localStorage.clear();
  sessionStorage.clear();
  await clearDrafts();
  await clearSnapshots();
  loader.loadThemeChain.mockImplementation((theme: string) => Promise.resolve(chainOf(theme)));
  loader.applyThemeStyles.mockImplementation(
    (): Promise<AppliedThemeStyles> => Promise.resolve({ slot: 's', links: [], sheets: [], failed: [], skippedCss: 0, dispose: vi.fn() }),
  );
  loader.waitForFonts.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  clearToasts();
});

const appRoot = () => screen.getByTestId('editor-app');
const waitForEditor = () => waitFor(() => expect(appEditor()).not.toBeNull(), { timeout: 3000 });
const settle = (ms = 150) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe('leaving /new before the autosave delay', () => {
  it.each(['/vault', '/new'])('saves the brew and stays on %s', async (target) => {
    const server = createBrewServer({ me: ALICE });
    server.delays['POST /api/brews'] = 50;
    const { router } = renderApp({ url: '/new', me: ALICE });
    await waitForEditor();
    typeInEditor('Hello');
    await act(() => router.navigate(target));
    // The unmount flush still creates the brew …
    await waitFor(() => expect(logOf(server, 'POST', '/api/brews')).toEqual(['201']));
    expect(docText(server.brews.get('newA')?.doc)).toBe('Hello');
    await settle();
    // … but the page the user chose stays.
    expect(router.state.location.pathname).toBe(target);
    expect(router.state.historyAction).not.toBe('REPLACE');
  });
});

describe('"Save mine as a copy", then back to the original', () => {
  it('the original URL opens the original again, as the server has it', async () => {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('origA')] });
    const { router, user } = renderApp({ url: '/edit/origA', me: ALICE });
    await waitForEditor();
    // Someone else saved meanwhile.
    Object.assign(server.brews.get('origA') ?? {}, { version: 4, doc: { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Theirs' }] }] }] } });
    typeInEditor(' mine');
    pressSaveKey();
    await user.click(await screen.findByTestId('conflict-copy'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/newA'));
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-edit-id', 'newA'));
    expect(docText(server.brews.get('newA')?.doc)).toBe('Old text mine');

    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/edit/origA');
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-edit-id', 'origA'));
    await waitForEditor();
    await waitFor(() => expect(docText(appEditor()?.getJSON())).toBe('Theirs'));
    typeInEditor(' more');
    pressSaveKey();
    await waitFor(() => expect(logOf(server, 'PUT', '/api/brews/origA')).toEqual(['409', '200']));
    expect(docText(server.brews.get('origA')?.doc)).toBe('Theirs more');
    expect(docText(server.brews.get('newA')?.doc)).toBe('Old text mine');
  });
});

async function signInThroughDialog(user: ReturnType<typeof renderApp>['user']) {
  const dialog = await screen.findByTestId('sign-in-prompt');
  // Pasted, not typed key by key: every keystroke re-renders the whole editor page in jsdom, and
  // typing into the dialog is SignInPrompt.test.tsx's subject, not this file's.
  await user.click(within(dialog).getByLabelText(/Email/));
  await user.paste('alice@example.test');
  await user.click(within(dialog).getByLabelText(/Password/));
  await user.paste('Secret1!');
  await user.click(within(dialog).getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(screen.queryByTestId('sign-in-prompt')).toBeNull());
}

describe('the session ends while editing', () => {
  it('signing in again as the same user saves the changes', async () => {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('origA')] });
    const { user } = renderApp({ url: '/edit/origA', me: ALICE });
    await waitForEditor();
    server.me = null; // the session cookie expired
    typeInEditor(' more');
    pressSaveKey();
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-save-status', 'signedOut'));
    await user.click(screen.getByRole('button', { name: 'Sign in to save' }));
    await signInThroughDialog(user);
    await waitFor(() => expect(logOf(server, 'PUT', '/api/brews/origA')).toEqual(['401', '200']));
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-save-status', 'saved'));
    expect(docText(server.brews.get('origA')?.doc)).toBe('Old text more');
    expect(screen.queryByRole('button', { name: 'Sign in to save' })).toBeNull();
  });
});

describe('signing out from the navbar while editing', () => {
  it('saves the pending changes first, then closes the brew', async () => {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('origA')] });
    const { user } = renderApp({ url: '/edit/origA', me: ALICE });
    await waitForEditor();
    typeInEditor(' more');
    await user.click(screen.getByRole('button', { name: 'Account: alice' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(server.log.filter((l) => l.startsWith('POST /api/account/logout'))).toHaveLength(1));
    // The last changes reached the server before the session ended.
    expect(server.log.filter((l) => l.startsWith('PUT ') || l.startsWith('POST /api/account/logout'))).toEqual([
      'PUT /api/brews/origA 200',
      'POST /api/account/logout 200',
    ]);
    expect(docText(server.brews.get('origA')?.doc)).toBe('Old text more');
    // The private brew and its local history are no longer on the page: it loads again as the
    // signed-out visitor it now is (the sign-in form).
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in required' })).toBeInTheDocument();
    expect(screen.queryByTestId('editor-app')).toBeNull();
    expect(screen.queryByTestId('open-local-history')).toBeNull();
    expect(appEditor()).toBeNull();
  });
});

describe('Local history', () => {
  it('restoring a snapshot does not send its author list again', async () => {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('origA')] });
    // A snapshot of the save that changed the author list (the owner invited "friend" then).
    await defaultSnapshotHistory().update({
      brewKey: 'origA',
      title: 'Orig',
      version: 2,
      docSchemaVersion: 1,
      doc: { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Snapshot text' }] }] }] },
      style: '',
      snippets: null,
      meta: { title: 'Orig', authors: ['alice', 'friend'] },
    });
    const { user } = renderApp({ url: '/edit/origA', me: ALICE });
    await waitForEditor();
    await user.click(screen.getByTestId('open-local-history'));
    const dialog = await screen.findByTestId('local-history');
    await user.click(await within(dialog).findByRole('button', { name: /^Restore/ }));
    await waitFor(() => expect(docText(appEditor()?.getJSON())).toBe('Snapshot text'));
    pressSaveKey();
    await waitFor(() => expect(logOf(server, 'PUT', '/api/brews/origA')).toEqual(['200']));
    const put = server.requests.find((r) => r.method === 'PUT');
    const meta = (put?.json as { meta?: Record<string, unknown> | null }).meta;
    expect(meta?.title).toBe('Orig');
    expect(meta?.authors ?? null).toBeNull();
  });
});

describe('deleting the brew', () => {
  it('forgets it on this device: recent brews, its draft and its local history', async () => {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('origA'), fakeBrew('keepB')] });
    recordRecentBrew('view', { id: 'shareorigA', title: 'Orig' });
    recordRecentBrew('edit', { id: 'keepB', title: 'Keep' });
    const doc = { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Snap' }] }] }] };
    await defaultSnapshotHistory().update({ brewKey: 'origA', title: 'Orig', version: 3, docSchemaVersion: 1, doc, style: '', snippets: null, meta: null });
    await defaultSnapshotHistory().update({ brewKey: 'keepB', title: 'Keep', version: 3, docSchemaVersion: 1, doc, style: '', snippets: null, meta: null });
    const { router, user } = renderApp({ url: '/edit/origA', me: ALICE });
    await waitForEditor();
    await waitFor(() => expect(recentBrewsStore.get().edit.map((b) => b.id)).toContain('origA'));
    typeInEditor(' unsaved'); // leaves a draft
    await settle(300);
    await waitFor(async () => expect(await readDraftsFor(defaultDraftStore(), 'origA')).toHaveLength(1));
    await user.click(screen.getByTestId('open-properties'));
    await user.click(await screen.findByTestId('delete-brew'));
    await user.click(await screen.findByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/user/alice'));
    expect(logOf(server, 'DELETE', '/api/brews/origA')).toEqual(['200']);
    await settle();
    expect(recentBrewsStore.get().edit.map((b) => b.id)).toEqual(['keepB']);
    expect(recentBrewsStore.get().view.map((b) => b.id)).toEqual([]);
    expect(await readDraftsFor(defaultDraftStore(), 'origA')).toEqual([]);
    expect(await defaultSnapshotHistory().list('origA')).toEqual([]);
    expect(await defaultSnapshotHistory().list('keepB')).toHaveLength(1);
  });
});
