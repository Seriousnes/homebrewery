import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo, BrewSummary, UserBrewList } from '@/api';
import { emptyResponse, jsonResponse, mockApi, problemResponse, type RecordedRequest } from '@/api/testing';
import { ALICE, renderRoute } from '@/app/testing';
import { LIST_PREFS_KEY, resetListPrefsStoreForTests } from '@/ported/listPage/listPrefs';
import { summary } from '@/ported/listPage/testing';
import { clearToasts, toastStore } from '@/ui';
import UserPage from './index';

const BOB: AccountInfo = { id: '0190-bob', handle: 'bob', email: 'bob@example.test', roles: [] };

beforeEach(() => {
  localStorage.clear();
  resetListPrefsStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const toastTitles = () => toastStore.getState().toasts.map((t) => t.title);

interface FakeOptions {
  me?: AccountInfo | null;
  own?: BrewSummary[];
  status?: number;
  total?: number;
}

/** alice's list: the full list for alice, the published part for anyone else. */
function fakeUserApi({ me = null, own = [], status, total }: FakeOptions = {}) {
  let items = [...own];
  const api = mockApi((request: RecordedRequest) => {
    const { pathname } = request.url;
    if (pathname === '/api/account/me') return me ? jsonResponse(me) : emptyResponse(204);
    if (pathname === '/api/users/alice/brews') {
      if (status) return problemResponse(status, { title: status === 404 ? 'User not found' : 'Server error' });
      const mine = me?.handle === 'alice';
      const visible = mine ? items : items.filter((b) => b.published && !b.locked && b.role !== 'invited').map((b) => ({ ...b, editId: null, role: null }));
      const list: UserBrewList = { handle: 'alice', own: mine, items: visible, total: total ?? visible.length };
      return jsonResponse(list);
    }
    const del = /^\/api\/brews\/([^/]+)$/.exec(pathname);
    if (del && request.method === 'DELETE') {
      const brew = items.find((b) => b.editId === del[1]);
      items = items.filter((b) => b !== brew);
      return jsonResponse({ brewDeleted: (brew?.authors.length ?? 1) <= 1 });
    }
    const clone = /^\/api\/brews\/([^/]+)\/clone$/.exec(pathname);
    if (clone && request.method === 'POST') return jsonResponse({ editId: 'copy123456', shareId: 'copyshare1' }, 201);
    const edit = /^\/api\/brews\/edit\/([^/]+)$/.exec(pathname);
    if (edit) {
      const brew = items.find((b) => b.editId === edit[1])!;
      return jsonResponse({
        editId: brew.editId,
        shareId: brew.shareId,
        version: 3,
        docSchemaVersion: 1,
        doc: { type: 'doc', content: [] },
        style: '',
        snippets: null,
        meta: { title: brew.title },
        authors: [{ handle: 'alice', role: 'owner' }],
        createdAt: brew.createdAt,
        updatedAt: brew.updatedAt,
        sourceMarkdown: null,
      });
    }
    return jsonResponse([]);
  });
  return api;
}

const aliceBrews = [
  summary('pubA000001', { title: 'Alpha', editId: 'editA00001', role: 'owner', views: 10, tags: ['dungeon'] }),
  summary('pubB000001', { title: 'Beta', editId: 'editB00001', role: 'owner', views: 50, authors: ['alice', 'carol'], tags: ['dungeon', 'type:Adventure'] }),
  summary('draft00001', { title: 'Gamma draft', editId: 'editC00001', role: 'owner', published: false }),
  summary('invite0001', { title: 'Delta invite', editId: 'editD00001', role: 'invited', authors: ['carol'] }),
  summary('locked0001', { title: 'Epsilon locked', editId: 'editE00001', role: 'owner', locked: true }),
];

function renderUserPage(url = '/user/alice', me: AccountInfo | null = null) {
  return renderRoute(<UserPage />, {
    url,
    path: 'user/:handle',
    me,
    routes: [{ path: 'edit/:editId', element: <p>Editor stub</p> }],
  });
}

const location = () => screen.getByTestId('location').textContent ?? '';
const titles = (group: string) =>
  within(screen.getByTestId(`list-group-${group}`))
    .queryAllByRole('heading', { level: 3 })
    .map((h) => h.textContent);

describe('/user/:handle', () => {
  it("shows other people only the published, unlocked brews, without the owner's actions", async () => {
    const api = fakeUserApi({ own: aliceBrews });
    renderUserPage();
    await screen.findByTestId('list-page');
    expect(screen.getByRole('heading', { level: 1, name: 'alice’s brews' })).toBeInTheDocument();
    expect(document.title).toBe('alice’s brews - The Homebrewery');
    expect(titles('published')).toEqual(['Alpha', 'Beta']);
    expect(screen.queryByTestId('list-group-unpublished')).toBeNull();
    expect(screen.queryByTestId('list-group-invited')).toBeNull();
    expect(screen.queryByTestId('brew-edit')).toBeNull();
    expect(screen.queryByTestId('brew-remove')).toBeNull();
    // Signed out: no Clone; Copy link for everyone.
    expect(screen.queryByTestId('brew-clone')).toBeNull();
    expect(screen.getAllByTestId('brew-copy-link')).toHaveLength(2);
    expect(api.requests.some((r) => r.path === '/api/users/alice/brews')).toBe(true);
  });

  it('shows the owner every group with Edit, Download and Delete / Remove / Decline', async () => {
    fakeUserApi({ me: ALICE, own: aliceBrews });
    renderUserPage('/user/alice', ALICE);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your brews' })).toBeInTheDocument();
    expect(titles('published')).toEqual(['Alpha', 'Beta', 'Epsilon locked']);
    expect(titles('unpublished')).toEqual(['Gamma draft']);
    expect(titles('invited')).toEqual(['Delta invite']);
    expect(screen.getByRole('link', { name: 'Edit Alpha' })).toHaveAttribute('href', '/edit/editA00001');
    expect(screen.getByRole('button', { name: 'Delete Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Beta' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline Delta invite' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Gamma draft' })).toBeInTheDocument();
    // A locked brew can't be cloned; the others can.
    const locked = screen.getByRole('article', { name: 'Epsilon locked' });
    expect(within(locked).getByTestId('brew-locked')).toBeInTheDocument();
    expect(within(locked).queryByTestId('brew-clone')).toBeNull();
    expect(screen.getByRole('button', { name: 'Clone Alpha' })).toBeInTheDocument();
  });

  it('reads the sort and filters from the URL and writes changes back (replace), remembering the sort', async () => {
    fakeUserApi({ me: ALICE, own: aliceBrews });
    const { user, router } = renderUserPage('/user/alice?sort=views&dir=asc&tag=dungeon', ALICE);
    await screen.findByRole('heading', { level: 1, name: 'Your brews' });
    const bar = screen.getByRole('group', { name: 'Sort by' });
    expect(within(bar).getByRole('button', { name: /^Views/ })).toHaveAttribute('aria-pressed', 'true');
    expect(titles('published')).toEqual(['Alpha', 'Beta']);
    expect(titles('unpublished')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Remove the tag filter dungeon' })).toBeInTheDocument();
    const historyLength = router.state.historyAction;

    await user.click(within(bar).getByRole('button', { name: /^Views/ }));
    expect(titles('published')).toEqual(['Beta', 'Alpha']);
    await waitFor(() => expect(location()).toBe('/user/alice?sort=views&dir=desc&tag=dungeon'));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(historyLength).toBe('POP');
    expect(JSON.parse(localStorage.getItem(LIST_PREFS_KEY) ?? '{}')).toMatchObject({ sort: 'views', dir: 'desc' });

    await user.type(screen.getByRole('searchbox', { name: 'Filter' }), 'bet');
    await waitFor(() => expect(location()).toBe('/user/alice?sort=views&dir=desc&filter=bet&tag=dungeon'));
    expect(titles('published')).toEqual(['Beta']);
    expect(screen.getByRole('searchbox', { name: 'Filter' })).toHaveValue('bet');
  });

  it('follows a URL change made elsewhere (a link to the same page without filters)', async () => {
    fakeUserApi({ me: ALICE, own: aliceBrews });
    const { router } = renderUserPage('/user/alice?filter=gamma', ALICE);
    await screen.findByRole('heading', { level: 1, name: 'Your brews' });
    expect(screen.getByRole('searchbox', { name: 'Filter' })).toHaveValue('gamma');
    expect(titles('published')).toEqual([]);
    await router.navigate('/user/alice');
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Filter' })).toHaveValue(''));
    expect(titles('published')).toEqual(['Alpha', 'Beta', 'Epsilon locked']);
  });

  it('uses the remembered sort when the URL has none', async () => {
    localStorage.setItem(LIST_PREFS_KEY, JSON.stringify({ sort: 'views', dir: 'desc', collapsed: ['unpublished'] }));
    resetListPrefsStoreForTests();
    fakeUserApi({ me: ALICE, own: aliceBrews });
    const { user } = renderUserPage('/user/alice', ALICE);
    await screen.findByRole('heading', { level: 1, name: 'Your brews' });
    expect(titles('published')).toEqual(['Beta', 'Alpha', 'Epsilon locked']);
    const toggle = screen.getByRole('button', { name: /^Your unpublished brews/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(JSON.parse(localStorage.getItem(LIST_PREFS_KEY) ?? '{}')).toMatchObject({ collapsed: [] });
  });

  it('deletes a brew after confirming, drops it from the list and moves focus to the next brew', async () => {
    const api = fakeUserApi({ me: ALICE, own: aliceBrews });
    const { user } = renderUserPage('/user/alice', ALICE);
    await user.click(await screen.findByRole('button', { name: 'Delete Alpha' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Alpha”?' });
    expect(dialog).toHaveTextContent("You are its only author, so the brew is deleted for good and its share link stops working. This can't be undone.");
    // Danger dialogs focus Cancel first.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Delete brew' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual(['/api/brews/editA00001']);
    await waitFor(() => expect(titles('published')).toEqual(['Beta', 'Epsilon locked']));
    expect(toastTitles()).toContain('“Alpha” was deleted.');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Beta' })).toHaveFocus());
  });

  it('cancelling the dialog deletes nothing', async () => {
    const api = fakeUserApi({ me: ALICE, own: aliceBrews });
    const { user } = renderUserPage('/user/alice', ALICE);
    const remove = await screen.findByRole('button', { name: 'Remove Beta' });
    await user.click(remove);
    const dialog = screen.getByRole('alertdialog', { name: 'Remove “Beta” from your brews?' });
    expect(dialog).toHaveTextContent('You stop being one of its authors and the next author becomes its owner.');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(titles('published')).toEqual(['Alpha', 'Beta', 'Epsilon locked']);
    expect(remove).toHaveFocus();
  });

  it('declines an invitation', async () => {
    const api = fakeUserApi({ me: ALICE, own: aliceBrews });
    const { user } = renderUserPage('/user/alice', ALICE);
    await user.click(await screen.findByRole('button', { name: 'Decline Delta invite' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Decline the invitation to “Delta invite”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Decline invitation' }));
    await waitFor(() => expect(screen.queryByTestId('list-group-invited')).toBeNull());
    expect(api.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual(['/api/brews/editD00001']);
    expect(toastTitles()).toContain('You declined the invitation to “Delta invite”.');
  });

  it("clones someone else's brew and opens the copy", async () => {
    const api = fakeUserApi({ me: BOB, own: aliceBrews });
    const { user } = renderUserPage('/user/alice', BOB);
    await user.click(await screen.findByRole('button', { name: 'Clone Beta' }));
    await waitFor(() => expect(location()).toBe('/edit/copy123456'));
    expect(api.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/brews/pubB000001/clone']);
    expect(screen.getByText('Editor stub')).toBeInTheDocument();
  });

  it('copies the share link', async () => {
    fakeUserApi({ own: aliceBrews });
    const { user } = renderUserPage();
    await user.click(await screen.findByRole('button', { name: 'Copy link to Alpha' }));
    await waitFor(() => expect(toastTitles()).toContain('Share link copied'));
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/share/pubA000001`);
  });

  it('downloads an own brew as a JSON file', async () => {
    const api = fakeUserApi({ me: ALICE, own: aliceBrews });
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:test';
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    try {
      const { user } = renderUserPage('/user/alice', ALICE);
      await user.click(await screen.findByRole('button', { name: 'Download Gamma draft' }));
      await waitFor(() => expect(clicked).toEqual(['Gamma draft.json']));
      expect(api.requests.some((r) => r.path === '/api/brews/edit/editC00001')).toBe(true);
      const file = JSON.parse(await blobs[0]!.text()) as { format: string; shareId: string; doc: unknown };
      expect(file).toMatchObject({ format: 'homebrewery-brew', shareId: 'draft00001', doc: { type: 'doc' } });
    } finally {
      click.mockRestore();
    }
  });

  it('says when the list is capped and welcomes an owner without brews', async () => {
    fakeUserApi({ own: aliceBrews.slice(0, 2), total: 1500 });
    const { unmount } = renderUserPage();
    expect(await screen.findByTestId('list-capped')).toHaveTextContent('Only the 2 brews updated most recently are listed here, of 1,500.');
    unmount();

    fakeUserApi({ me: ALICE, own: [] });
    renderUserPage('/user/alice', ALICE);
    const welcome = await screen.findByTestId('list-no-brews');
    expect(within(welcome).getByRole('link', { name: 'Create a brew' })).toHaveAttribute('href', '/new');
    expect(within(welcome).getByRole('link', { name: 'Import a brew' })).toHaveAttribute('href', '/import');
  });

  it('shows the not-found page for an unknown handle and a retry for other failures', async () => {
    fakeUserApi({ status: 404 });
    const { unmount } = renderUserPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'User not found' })).toBeInTheDocument();
    expect(screen.getByText(/No one has the handle “alice”/)).toBeInTheDocument();
    unmount();

    fakeUserApi({ status: 500 });
    renderUserPage();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
