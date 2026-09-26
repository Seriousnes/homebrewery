import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo, BrewSummary, VaultPage } from '@/api';
import { emptyResponse, jsonResponse, mockApi, problemResponse, type RecordedRequest } from '@/api/testing';
import { ALICE, renderRoute } from '@/app/testing';
import { summary } from '@/ported/listPage/testing';
import { clearToasts } from '@/ui';
import VaultPageRoute from './index';

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

/** 25 published brews: "Dragon 01" … "Dragon 12" by alice, "Kobold 13" … "Kobold 25" by bob. */
const BREWS: BrewSummary[] = Array.from({ length: 25 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return summary(`share0000${n}`, {
    title: `${i < 12 ? 'Dragon' : 'Kobold'} ${n}`,
    authors: [i < 12 ? 'alice' : 'bob'],
    views: i * 10,
    createdAt: `2026-01-${n}T00:00:00Z`,
    updatedAt: `2026-02-${n}T00:00:00Z`,
  });
});

interface FakeVault {
  me?: AccountInfo | null;
  fail?: () => Response | null;
}

/** GET /api/vault over BREWS, applying q (a word of the title), author, sort, dir and paging like the API. */
function fakeVaultApi({ me = null, fail }: FakeVault = {}) {
  return mockApi((request: RecordedRequest) => {
    const { pathname, searchParams } = request.url;
    if (pathname === '/api/account/me') return me ? jsonResponse(me) : emptyResponse(204);
    if (pathname !== '/api/vault') return jsonResponse([]);
    const failure = fail?.();
    if (failure) return failure;
    const q = searchParams.get('q') ?? '';
    if (q.length > 256) return problemResponse(400, { title: 'One or more validation errors occurred.', errors: { q: ['must be at most 256 characters'] } });
    const author = searchParams.get('author') ?? '';
    const sort = searchParams.get('sort') ?? (q ? 'relevance' : 'updated');
    const dir = searchParams.get('dir') ?? (sort === 'title' ? 'asc' : 'desc');
    const page = Number(searchParams.get('page') ?? 1);
    const pageSize = Number(searchParams.get('pageSize') ?? 20);
    let items = BREWS.filter((b) => (!q || b.title.toLowerCase().split(' ').includes(q.toLowerCase())) && (!author || b.authors.includes(author)));
    const key = (b: BrewSummary) => (sort === 'title' ? b.title : sort === 'views' ? b.views : sort === 'created' ? b.createdAt : b.updatedAt);
    items = [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (dir === 'asc' ? 1 : -1));
    const body: VaultPage = { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, sort, dir };
    return jsonResponse(body);
  });
}

const vaultRequests = (api: ReturnType<typeof mockApi>) => api.requests.filter((r) => r.url.pathname === '/api/vault').map((r) => r.path);
const location = () => screen.getByTestId('location').textContent ?? '';
const shownTitles = () =>
  within(screen.getByTestId('vault-items'))
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.textContent);

function renderVault(url = '/vault', me: AccountInfo | null = null) {
  return renderRoute(<VaultPageRoute />, { url, path: 'vault', me });
}

describe('/vault', () => {
  it('lists the most recently updated published brews without a search', async () => {
    const api = fakeVaultApi();
    renderVault();
    expect(screen.getByRole('heading', { level: 1, name: 'Vault' })).toBeInTheDocument();
    expect(screen.getByRole('search', { name: 'Vault search' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('25 brews found. Page 1 of 2.'));
    expect(vaultRequests(api)).toEqual(['/api/vault?pageSize=20']);
    expect(shownTitles()[0]).toBe('Kobold 25');
    expect(shownTitles()).toHaveLength(20);
    const sort = screen.getByRole('group', { name: 'Sort by' });
    expect(within(sort).getByRole('button', { name: /^Updated/ })).toHaveAttribute('aria-pressed', 'true');
    // Relevance needs a search.
    expect(within(sort).queryByRole('button', { name: /^Relevance/ })).toBeNull();
    // Nobody signed in: Copy link only (the vault never has edit ids).
    expect(screen.queryByTestId('brew-clone')).toBeNull();
    expect(screen.queryByTestId('brew-edit')).toBeNull();
    expect(screen.getAllByTestId('brew-copy-link')).toHaveLength(20);
  });

  it('searches with the form and keeps the search in the URL', async () => {
    const api = fakeVaultApi();
    const { user } = renderVault();
    await screen.findByTestId('vault-items');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Results per page' }), '10');
    await user.type(screen.getByRole('textbox', { name: /^Author/ }), 'Alice');
    // Enter in a text field submits the form.
    await user.type(screen.getByRole('searchbox', { name: /^Search/ }), 'dragon{Enter}');
    await waitFor(() => expect(location()).toBe('/vault?q=dragon&author=Alice&pageSize=10'));
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('12 brews found. Page 1 of 2.'));
    expect(vaultRequests(api).at(-1)).toBe('/api/vault?q=dragon&author=alice&pageSize=10');
    const sort = screen.getByRole('group', { name: 'Sort by' });
    expect(within(sort).getByRole('button', { name: /^Relevance/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('vault-clear')).toBeInTheDocument();
  });

  it('sorts with the sort bar (first click: its default direction; again: reversed) and starts at page 1', async () => {
    fakeVaultApi();
    const { user } = renderVault('/vault?page=2');
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('Page 2 of 2.'));
    const sort = screen.getByRole('group', { name: 'Sort by' });
    await user.click(within(sort).getByRole('button', { name: /^Title/ }));
    await waitFor(() => expect(location()).toBe('/vault?sort=title&dir=asc'));
    await waitFor(() => expect(shownTitles()[0]).toBe('Dragon 01'));
    await user.click(within(sort).getByRole('button', { name: /^Title/ }));
    await waitFor(() => expect(location()).toBe('/vault?sort=title&dir=desc'));
    await waitFor(() => expect(shownTitles()[0]).toBe('Kobold 25'));
    expect(within(sort).getByRole('button', { name: /^Title/ })).toHaveTextContent('Z to A');
  });

  it('pages with links (each page is a URL), focusing the results; Back returns', async () => {
    const api = fakeVaultApi();
    const { user, router } = renderVault('/vault?pageSize=10');
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('25 brews found. Page 1 of 3.'));
    const pages = screen.getByRole('navigation', { name: 'Result pages' });
    expect(within(pages).getByText('1').closest('[aria-current="page"]')).not.toBeNull();
    expect(within(pages).queryByTestId('vault-previous')).toBeNull();
    const two = within(pages).getByRole('link', { name: 'Page 2' });
    expect(two).toHaveAttribute('href', '/vault?page=2&pageSize=10');
    await user.click(within(pages).getByRole('link', { name: 'Next page' }));
    await waitFor(() => expect(location()).toBe('/vault?page=2&pageSize=10'));
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('Page 2 of 3.'));
    expect(vaultRequests(api).at(-1)).toBe('/api/vault?page=2&pageSize=10');
    expect(screen.getByRole('heading', { level: 2, name: 'Results' })).toHaveFocus();
    await user.click(screen.getByRole('link', { name: 'Page 3' }));
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('Page 3 of 3.'));
    expect(shownTitles()).toHaveLength(5);
    expect(screen.queryByTestId('vault-next')).toBeNull();
    await router.navigate(-1);
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('Page 2 of 3.'));
  });

  it("reads upstream's vault links", async () => {
    const api = fakeVaultApi();
    renderVault('/vault?title=kobold&count=40&sort=createdAt&dir=asc&v3=true&legacy=true');
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('13 brews found.'));
    expect(vaultRequests(api)).toEqual(['/api/vault?q=kobold&pageSize=40&sort=created&dir=asc']);
    expect(screen.getByRole('searchbox', { name: /^Search/ })).toHaveValue('kobold');
    expect(shownTitles()[0]).toBe('Kobold 13');
  });

  it('the form follows the URL (Back, a new link)', async () => {
    fakeVaultApi();
    const { router } = renderVault('/vault?q=dragon');
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('12 brews found.'));
    await router.navigate('/vault?q=kobold&author=bob');
    await waitFor(() => expect(screen.getByRole('searchbox', { name: /^Search/ })).toHaveValue('kobold'));
    expect(screen.getByRole('textbox', { name: /^Author/ })).toHaveValue('bob');
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('13 brews found.'));
  });

  it('says when nothing matches, and when the page is past the end', async () => {
    fakeVaultApi();
    const { unmount } = renderVault('/vault?q=owlbear');
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('No brews found.'));
    expect(screen.getByTestId('vault-empty')).toHaveTextContent('No published brew matches.');
    expect(screen.queryByRole('navigation', { name: 'Result pages' })).toBeNull();
    unmount();

    renderVault('/vault?page=9');
    await waitFor(() => expect(screen.getByTestId('vault-empty')).toHaveTextContent('There is nothing on page 9; the results end on page 2.'));
    expect(screen.getByRole('link', { name: 'Page 2' })).toHaveAttribute('href', '/vault?page=2');
    expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/vault?page=2');
  });

  it("shows the API's message for a bad search on the search field", async () => {
    fakeVaultApi();
    renderVault(`/vault?q=${'x'.repeat(300)}`);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Fix the search above and try again.'));
    const input = screen.getByRole('searchbox', { name: /^Search/ });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(expect.stringContaining('The search must be at most 256 characters.'));
    expect(screen.getByTestId('vault-status')).toHaveTextContent('Check the search.');
  });

  it('shows other failures in place with Try again', async () => {
    let failing = true;
    fakeVaultApi({ fail: () => (failing ? problemResponse(503, { title: 'Service Unavailable' }) : null) });
    const { user } = renderVault();
    const alert = await screen.findByRole('alert');
    expect(screen.getByTestId('vault-status')).toHaveTextContent("Couldn't search the vault.");
    failing = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('vault-status')).toHaveTextContent('25 brews found.'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers Clone to signed-in readers', async () => {
    fakeVaultApi({ me: ALICE });
    renderVault('/vault?q=dragon', ALICE);
    await screen.findByTestId('vault-items');
    expect(screen.getByRole('button', { name: 'Clone Dragon 12' })).toBeInTheDocument();
  });

  it('Clear resets the search, the author and the sort', async () => {
    fakeVaultApi();
    const { user } = renderVault('/vault?q=dragon&author=alice&sort=title&pageSize=10');
    await screen.findByTestId('vault-items');
    await user.click(screen.getByTestId('vault-clear'));
    await waitFor(() => expect(location()).toBe('/vault?pageSize=10'));
    expect(screen.getByRole('searchbox', { name: /^Search/ })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^Author/ })).toHaveValue('');
  });
});
