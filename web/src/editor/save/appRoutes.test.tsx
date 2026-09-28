// Autosave on the app's real pages (/new, /edit/:editId, /local/:localId) over the fake brew API of
// web/src/pages/routeTesting.tsx: a signed-out visitor's new brew (a local brew, issue #4) and
// leaving a brew whose changes can't be saved (SAVE-2). Real timers, with the app's autosave timings scaled down (see
// DELAY below) so that a test with two save cycles stays well within the 5 s test timeout. What
// must not happen is checked on a fake clock (src/test/fakeClock.ts), run past the delay that would
// make it happen; where the autosave must not run on its own, its delay is out of reach (NEVER).
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, type AccountInfo } from '@/api';
import { jsonResponse } from '@/api/testing';
import { ALICE } from '@/app/testing';
import { uiStore } from '@/app/uiStore';
import type { AppliedThemeStyles, ThemeChain } from '@/editor/canvas/themeLoader';
import {
  appEditor,
  createBrewServer,
  docText,
  editView,
  fakeBrew,
  logOf,
  pageDoc,
  renderApp,
  typeInEditor,
  type BrewServer,
} from '@/pages/routeTesting';
import { createLocalBrewLibrary, defaultLocalBrews, type LocalBrew, type LocalBrewSummary, setDefaultLocalBrews } from '@/editor/local/localBrews';
import { LOCAL_SAVE_DELAY_MS } from '@/editor/local/useLocalSave';
import { advance, tickUntil } from '@/test/fakeClock';
import { clearToasts, toastStore } from '@/ui';
import { NEW_DRAFT_KEY, readDraft, type Draft } from './drafts';
import { resetNewBrewCreates } from './newBrewCreates';
import { defaultDraftStore } from './stores';
import { memoryStore } from './kvStore';
import { draftOf } from './testing';
import type * as UseAutosaveModule from './useAutosave';

// The autosave delay (3 s in the app) and the draft throttle (1 s) for every useAutosave here, read
// on every render (a test may change them for the pages it mounts next).
const timing = vi.hoisted(() => ({ delayMs: 500, draftThrottleMs: 150 }));
const DELAY = timing.delayMs;
/** An autosave delay no test reaches: the autosave doesn't run on its own. */
const NEVER = 3_600_000;
vi.mock('./useAutosave', async (importOriginal) => {
  const actual = await importOriginal<typeof UseAutosaveModule>();
  return { ...actual, useAutosave: (options: UseAutosaveModule.UseAutosaveOptions) => actual.useAutosave({ ...timing, ...options }) };
});

const loader = vi.hoisted(() => ({
  loadThemeChain: vi.fn(),
  applyThemeStyles: vi.fn(),
  waitForFonts: vi.fn(),
  disposeThemeSlot: vi.fn(),
}));
vi.mock('@/editor/canvas/themeLoader', () => loader);

const chainOf = (theme: string): ThemeChain => ({ theme, source: 'static', name: theme, author: null, styles: [], snippets: [] });

async function clearDrafts() {
  const store = defaultDraftStore();
  await store.delMany((await store.entries()).map(([key]) => key));
}

beforeEach(async () => {
  timing.delayMs = DELAY;
  uiStore.getState().resetUi();
  localStorage.clear();
  sessionStorage.clear();
  await clearDrafts();
  // A persistent local brew library, fresh for every test.
  setDefaultLocalBrews(createLocalBrewLibrary(Object.assign(memoryStore<LocalBrew>(), { persistent: () => true }), memoryStore<LocalBrewSummary>()));
  loader.loadThemeChain.mockImplementation((theme: string) => Promise.resolve(chainOf(theme)));
  loader.applyThemeStyles.mockImplementation(
    (): Promise<AppliedThemeStyles> => Promise.resolve({ slot: 's', links: [], sheets: [], failed: [], skippedCss: 0, dispose: vi.fn() }),
  );
  loader.waitForFonts.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  clearToasts();
  resetNewBrewCreates();
});

const waitForEditor = () => waitFor(() => expect(appEditor()).not.toBeNull());
/** Past every save delay here: the autosave's and the local brew's (LOCAL_SAVE_DELAY_MS). */
const PAST_SAVE_DELAYS = 2 * Math.max(DELAY, LOCAL_SAVE_DELAY_MS);
/** The 'new' draft, once written (the draft throttle's leading write). */
const newDraftWritten = (text: string) => waitFor(async () => expect(docText((await readDraft(defaultDraftStore(), NEW_DRAFT_KEY))?.doc)).toContain(text));
const conflictDialog = () => screen.queryByRole('alertdialog', { name: 'This brew was changed somewhere else' });
const leaveDialog = () => screen.findByRole('alertdialog', { name: 'Leave without saving?' });

describe('/new while nobody is signed in: a local brew (issue #4, APP-9)', () => {
  it('is stored in this browser on its first change (same editor, URL /local/:localId), sends nothing, and is uploaded only when the user chooses', async () => {
    const server = createBrewServer({ me: null });
    const { queryClient, router } = renderApp({ url: '/new', me: null });
    await waitForEditor();
    const editor = appEditor();
    typeInEditor('My secret draft');
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/local\/[\w-]+$/));
    const localId = router.state.location.pathname.split('/')[2]!;
    expect(appEditor()).toBe(editor); // the editor stayed mounted
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'));
    expect(docText((await defaultLocalBrews().get(localId))?.doc)).toContain('My secret draft');
    expect(await readDraft(defaultDraftStore(), NEW_DRAFT_KEY)).toBeNull();
    expect(logOf(server, 'POST', '/api/brews')).toEqual([]);
    // Saved on this device: leaving asks nothing.
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);

    // Signed in (the sign-in dialog, another tab): nothing is uploaded by itself, on a fake clock
    // run past every save delay; the user is asked.
    server.me = ALICE;
    vi.useFakeTimers();
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    const promptShown = () => screen.queryByRole('dialog', { name: 'You have 1 brew on this device' });
    await tickUntil(() => promptShown() !== null);
    await advance(PAST_SAVE_DELAYS);
    vi.useRealTimers();
    expect(logOf(server, 'POST', '/api/brews')).toEqual([]);
    const prompt = promptShown()!;
    act(() => {
      within(prompt).getByRole('button', { name: 'Upload all' }).click();
    });
    await waitFor(() => expect(logOf(server, 'POST', '/api/brews')).toEqual(['201']));
    expect(docText(server.brews.get('newA')?.doc)).toContain('My secret draft');
    await waitFor(async () => expect(await defaultLocalBrews().count()).toBe(0));
  });

  it('Upload all from the prompt stores and uploads what the open editor still had, and opens the cloud brew', async () => {
    const server = createBrewServer({ me: null });
    const { queryClient, router } = renderApp({ url: '/new', me: null });
    await waitForEditor();
    typeInEditor('First words');
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/local\//));
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveAttribute('data-status', 'saved'));
    // On a fake clock from the last edit on: its local save is still pending when the prompt
    // uploads, and the clock runs past it at the end.
    vi.useFakeTimers();
    typeInEditor(' and more');
    server.me = ALICE;
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    const prompt = () => screen.queryByRole('dialog', { name: 'You have 1 brew on this device' });
    await tickUntil(() => prompt() !== null);
    act(() => {
      within(prompt()!).getByRole('button', { name: 'Upload all' }).click();
    });
    await tickUntil(() => logOf(server, 'POST', '/api/brews').length > 0);
    expect(logOf(server, 'POST', '/api/brews')).toEqual(['201']);
    expect(docText(server.brews.get('newA')?.doc)).toContain('First words and more');
    await tickUntil(() => router.state.location.pathname === '/edit/newA');
    await advance(PAST_SAVE_DELAYS); // nothing is written back
    vi.useRealTimers();
    expect(await defaultLocalBrews().count()).toBe(0);
  });

  it('signing in right after typing (before the brew is stored) keeps it local and keeps the text', async () => {
    const server = createBrewServer({ me: null });
    const { queryClient, router } = renderApp({ url: '/new', me: null });
    await waitForEditor();
    typeInEditor('Typed just before signing in');
    server.me = ALICE;
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/local\//));
    expect(docText(appEditor()!.getJSON())).toContain('Typed just before signing in');
    expect(logOf(server, 'POST', '/api/brews')).toEqual([]);
  });

  it('signing in before typing anything turns the page into a signed-in /new', async () => {
    const server = createBrewServer({ me: null });
    const { queryClient, router } = renderApp({ url: '/new', me: null });
    await waitForEditor();
    server.me = ALICE;
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    await waitFor(() => expect(screen.getByTestId('editor-app')).not.toHaveAttribute('data-local-id'));
    await waitForEditor();
    typeInEditor('Straight to the cloud');
    await waitFor(() => expect(logOf(server, 'POST', '/api/brews')).toEqual(['201']));
    expect(router.state.location.pathname).toBe('/edit/newA');
    expect(await defaultLocalBrews().count()).toBe(0);
  });
});

describe('leaving a brew whose changes are not saved (SAVE-2)', () => {
  async function inConflict() {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('b1', { doc: pageDoc('Base') })] });
    const app = renderApp({ url: '/edit/b1', me: ALICE });
    await waitForEditor();
    // Another tab saved first.
    const stored = server.brews.get('b1')!;
    stored.version = 4;
    stored.doc = pageDoc('Base theirs');
    typeInEditor(' my important paragraph');
    await waitFor(() => expect(conflictDialog()).not.toBeNull());
    await app.user.keyboard('{Escape}');
    expect(conflictDialog()).toBeNull();
    return { server, ...app };
  }

  it('asks first; "Stay" stays, "Leave anyway" leaves, and the next visit offers the changes as a conflict', async () => {
    const { router, user } = await inConflict();
    await act(() => router.navigate('/vault'));
    let dialog = await leaveDialog();
    expect(router.state.location.pathname).toBe('/edit/b1');
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog', { name: 'Leave without saving?' })).toBeNull();
    expect(router.state.location.pathname).toBe('/edit/b1');

    await act(() => router.navigate('/vault'));
    dialog = await leaveDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Leave anyway' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/vault'));
    await waitFor(() => expect(appEditor()).toBeNull());

    await act(() => router.navigate('/edit/b1'));
    await waitForEditor();
    const banner = await screen.findByRole('region', { name: 'Unsaved changes found' });
    expect(banner).toHaveAttribute('data-kind', 'conflict');
    await user.click(within(banner).getByTestId('draft-restore'));
    expect(docText(appEditor()!.getJSON())).toContain('my important paragraph');
    expect(conflictDialog()).not.toBeNull();
  });

  it('"Save mine as a copy" keeps the changes on the server, then goes on', async () => {
    const { server, router, user } = await inConflict();
    await act(() => router.navigate('/vault'));
    const dialog = await leaveDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Save mine as a copy' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/vault'));
    expect(logOf(server, 'POST', '/api/brews')).toEqual(['201']);
    expect(docText(server.brews.get('newA')?.doc)).toContain('my important paragraph');
    expect(docText(server.brews.get('b1')?.doc)).toBe('Base theirs');
  });

  it('saved changes leave without asking', async () => {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('b1', { doc: pageDoc('Base') })] });
    const { router } = renderApp({ url: '/edit/b1', me: ALICE });
    await waitForEditor();
    typeInEditor(' fine');
    await act(() => router.navigate('/vault'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/vault'));
    await waitFor(() => expect(logOf(server, 'PUT', '/api/brews/b1')).toEqual(['200']));
  });
});

const BOB: AccountInfo = { id: '0190-bob', handle: 'bob', email: 'bob@example.test', roles: [] };

/** A stored 'new' draft (a new brew's). */
async function storeNewDraft(overrides: Partial<Draft>): Promise<Draft> {
  const base = { key: NEW_DRAFT_KEY, editId: null, baseVersion: null, doc: pageDoc('Leftover words'), updatedAt: Date.now() - 60_000 };
  const draft = draftOf({ ...base, ...overrides });
  await defaultDraftStore().set(NEW_DRAFT_KEY, draft);
  return draft;
}

const posts = (server: BrewServer) => server.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/api/brews');

/**
 * POST /api/brews honours Idempotency-Key like the real API (SAVE-8): a key seen before answers
 * with its brew. `lose` = the first n creates are stored but their answer is lost (a network error).
 */
function idempotentCreates(server: BrewServer, { lose = 0 }: { lose?: number } = {}) {
  const keys = new Map<string, string>();
  server.override = (request, s) => {
    if (request.method !== 'POST' || request.url.pathname !== '/api/brews' || !s.me) return undefined;
    const key = request.headers.get('Idempotency-Key');
    const known = key ? keys.get(key) : undefined;
    if (known) return jsonResponse(editView(s.brews.get(known)!), 201);
    const id = `new${String.fromCharCode(65 + s.nextId)}`;
    if (key) keys.set(key, id);
    if (lose > 0) {
      lose--;
      s.nextId++;
      const body = request.json as { doc: never };
      s.brews.set(id, fakeBrew(id, { version: 1, doc: body.doc, authors: [{ handle: s.me.handle, role: 'owner' }] }));
      throw new TypeError('Failed to fetch');
    }
    return undefined; // the fake server creates it (the id above)
  };
  return keys;
}

describe("the 'new' draft belongs to its author (SAVE-12)", () => {
  it("another user's draft is not offered: /new starts blank and the draft stays stored", async () => {
    await storeNewDraft({ ownerId: ALICE.id });
    createBrewServer({ me: BOB });
    renderApp({ url: '/new', me: BOB });
    await waitForEditor();
    expect(docText(appEditor()!.getJSON())).not.toContain('Leftover words');
    expect(screen.queryByTestId('new-draft-notice')).toBeNull();
    expect((await readDraft(defaultDraftStore(), NEW_DRAFT_KEY))?.ownerId).toBe(ALICE.id);
  });

  it("an anonymous visitor doesn't get a signed-in author's draft; the author signing in on the page gets it back", async () => {
    await storeNewDraft({ ownerId: ALICE.id });
    const server = createBrewServer({ me: null });
    const { queryClient } = renderApp({ url: '/new', me: null });
    await waitForEditor();
    expect(docText(appEditor()!.getJSON())).not.toContain('Leftover words');
    expect(screen.queryByTestId('new-draft-notice')).toBeNull();

    // On a fake clock from the sign-in on, run past every save delay.
    server.me = ALICE;
    vi.useFakeTimers();
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    await tickUntil(() => docText(appEditor()?.getJSON()).includes('Leftover words') && screen.queryByTestId('new-draft-notice') !== null);
    expect(screen.getByTestId('new-draft-notice')).toHaveTextContent('saved as a new brew when you edit it');
    await advance(PAST_SAVE_DELAYS);
    vi.useRealTimers();
    expect(logOf(server, 'POST', '/api/brews')).toEqual([]); // an earlier draft waits for an edit
  });

  it("an anonymous visitor's draft from before local brews becomes a local brew, opened at /local/:localId, and is not uploaded at sign-in", async () => {
    const draft = await storeNewDraft({ ownerId: null });
    const server = createBrewServer({ me: null });
    const { queryClient, router } = renderApp({ url: '/new', me: null });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/draft-${draft.updatedAt.toString(36)}`));
    await waitForEditor();
    expect(docText(appEditor()!.getJSON())).toContain('Leftover words');
    expect(await readDraft(defaultDraftStore(), NEW_DRAFT_KEY)).toBeNull();
    // On a fake clock from the sign-in on, run past every save delay.
    server.me = BOB;
    vi.useFakeTimers();
    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), BOB);
    });
    await tickUntil(() => screen.queryByRole('dialog', { name: 'You have 1 brew on this device' }) !== null);
    await advance(PAST_SAVE_DELAYS);
    vi.useRealTimers();
    expect(logOf(server, 'POST', '/api/brews')).toEqual([]);
  });
});

describe('"New brew" while the /new page\'s unmount save is creating its brew (SAVE-8)', () => {
  it('the fresh /new waits for that create and starts blank; one brew is created', async () => {
    const server = createBrewServer({ me: ALICE });
    // The first create is held (still creating while the fresh /new renders) until that page says
    // it waits for it.
    let releaseCreate!: () => void;
    const held = new Promise<void>((resolve) => (releaseCreate = resolve));
    server.override = async (request) => {
      if (request.method === 'POST' && request.url.pathname === '/api/brews') await held;
      return undefined;
    };
    timing.delayMs = NEVER; // the first page's autosave doesn't run: its unmount save creates
    const { router } = renderApp({ url: '/new', me: ALICE });
    await waitForEditor();
    typeInEditor('Race text');
    await newDraftWritten('Race text');
    timing.delayMs = DELAY; // the pages mounted from here on autosave
    await act(() => router.navigate('/new')); // "New brew": a fresh session; the old one's unmount save POSTs
    expect(await screen.findByText('Saving your previous brew…')).toBeInTheDocument();
    expect(logOf(server, 'POST', '/api/brews')).toEqual([]);
    releaseCreate();
    await waitFor(() => expect(logOf(server, 'POST', '/api/brews')).toEqual(['201']));
    // The create signal: the page says where the text went (Recent brews), and starts blank.
    await waitFor(() => expect(toastStore.getState().toasts.map((t) => t.title)).toContain('Your new brew was saved'));
    await waitForEditor();
    expect(docText(appEditor()!.getJSON())).not.toContain('Race text');
    expect(screen.queryByTestId('new-draft-notice')).toBeNull();
    expect(docText(server.brews.get('newA')?.doc)).toContain('Race text');
    typeInEditor('Second brew');
    await waitFor(() => expect(logOf(server, 'POST', '/api/brews')).toEqual(['201', '201']));
    expect(docText(server.brews.get('newB')?.doc)).not.toContain('Race text');
    expect(server.brews.size).toBe(2);
  });

  it('when that create gets no answer, the fresh /new loads the draft and continues its create chain: still one brew', async () => {
    const server = createBrewServer({ me: ALICE });
    idempotentCreates(server, { lose: 1 }); // stored, but the answer is lost
    timing.delayMs = NEVER; // the first page's autosave doesn't run: its unmount save creates
    const { router } = renderApp({ url: '/new', me: ALICE });
    await waitForEditor();
    typeInEditor('Race text');
    await newDraftWritten('Race text');
    timing.delayMs = DELAY; // the pages mounted from here on autosave
    await act(() => router.navigate('/new'));
    await waitForEditor();
    await waitFor(() => expect(docText(appEditor()?.getJSON())).toContain('Race text'));
    expect(await screen.findByTestId('new-draft-notice')).toBeInTheDocument();
    const draft = await readDraft(defaultDraftStore(), NEW_DRAFT_KEY);
    expect(draft?.createKey).toMatch(/^[\w-]{16,}$/);
    expect(draft?.ownerId).toBe(ALICE.id);

    typeInEditor(' and more');
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/newA'));
    const [lost, replay] = posts(server);
    expect(replay?.headers.get('Idempotency-Key')).toBe(lost?.headers.get('Idempotency-Key'));
    expect(replay?.json).toEqual(lost?.json); // the lost request, again
    await waitFor(() => expect(docText(server.brews.get('newA')?.doc)).toContain('Race text and more'));
    expect(server.brews.size).toBe(1);
  });
});

describe("a reload continues the 'new' draft's create chain (SAVE-8)", () => {
  it('the POST whose answer was lost goes again with its key, then the page is PUT', async () => {
    const pending = { doc: pageDoc('Sent once'), style: '', snippets: null, meta: null };
    await storeNewDraft({ ownerId: ALICE.id, createKey: 'chain-key-1', pending, doc: pageDoc('Sent once, then more') });
    const server = createBrewServer({ me: ALICE });
    const keys = idempotentCreates(server);
    const { router } = renderApp({ url: '/new', me: ALICE });
    await waitForEditor();
    typeInEditor('!');
    await waitFor(() => expect(router.state.location.pathname).toBe('/edit/newA'));
    expect(posts(server)[0]?.headers.get('Idempotency-Key')).toBe('chain-key-1');
    expect(docText((posts(server)[0]?.json as { doc: unknown }).doc)).toBe('Sent once');
    expect(keys.get('chain-key-1')).toBe('newA');
    await waitFor(() => expect(docText(server.brews.get('newA')?.doc)).toBe('Sent once, then more!'));
  });
});
