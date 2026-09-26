// P3.7 "every field saves": each field of the metadata dialog reports the right save payload
// through onChange. The API is stubbed (mockApi): GET /api/themes with static and user themes,
// DELETE /api/brews/{editId}, POST /api/brews/{editId}/lock/review. The real API is exercised by
// web/e2e/panels/metadata-api.spec.ts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type BrewLockInfo, type BrewMetaInput, type ThemeList } from '@/api';
import { emptyResponse, jsonResponse, type MockApi, mockApi, problemResponse } from '@/api/testing';
import type { MetadataBrew, MetadataChange, MetaDraft } from '@/ported/metadata/metaDraft';
import { MetadataDialog, type MetadataDialogProps } from './MetadataDialog';

const THEMES: ThemeList = {
  static: [
    { key: '5ePHB', name: '5e PHB', renderer: 'V3', baseTheme: 'Blank', baseSnippets: null, path: '5ePHB', style: '', scopedStyle: '', preview: null, texture: null, hasSnippets: true },
    { key: 'Blank', name: 'Blank', renderer: 'V3', baseTheme: null, baseSnippets: null, path: 'Blank', style: '', scopedStyle: '', preview: null, texture: null, hasSnippets: true },
  ],
  user: [
    { shareId: 'mineTheme001', name: 'My Parchment', author: 'alice', baseTheme: '5ePHB', thumbnailUrl: null, published: false, mine: true, updatedAt: '2026-09-01T00:00:00Z' },
    { shareId: 'shareBrew001', name: 'This brew', author: 'alice', baseTheme: '5ePHB', thumbnailUrl: null, published: true, mine: true, updatedAt: '2026-09-01T00:00:00Z' },
    { shareId: 'otherTheme01', name: 'Starry', author: 'dave', baseTheme: 'Blank', thumbnailUrl: null, published: true, mine: false, updatedAt: '2026-09-01T00:00:00Z' },
  ],
};

const EDIT_ID = 'editBrew0001';

function makeBrew(overrides: Partial<MetadataBrew> = {}): MetadataBrew {
  return {
    editId: EDIT_ID,
    shareId: 'shareBrew001',
    meta: { title: 'The Inn', description: 'An inn.', tags: ['dragons'], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: null },
    authors: [
      { handle: 'alice', role: 'owner' },
      { handle: 'bob', role: 'author' },
    ],
    role: 'owner',
    lock: null,
    ...overrides,
  };
}

/** The payload with nothing changed. */
const BASE: BrewMetaInput = { title: 'The Inn', description: 'An inn.', tags: ['dragons'], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: '' };

let api: MockApi;
let themesStatus = 200;

beforeEach(() => {
  themesStatus = 200;
  api = mockApi((req) => {
    if (req.method === 'GET' && req.path === '/api/themes') return themesStatus === 200 ? jsonResponse(THEMES) : problemResponse(themesStatus);
    if (req.method === 'DELETE' && req.path === `/api/brews/${EDIT_ID}`) return jsonResponse({ brewDeleted: true });
    if (req.method === 'POST' && req.path === `/api/brews/${EDIT_ID}/lock/review`) {
      const lock: BrewLockInfo = { code: 455, message: 'Copied text.', applied: '2026-09-01T12:00:00Z', reviewRequested: '2026-09-25T10:00:00Z' };
      return jsonResponse(lock);
    }
    return emptyResponse(404);
  });
});

afterEach(() => {
  api.restore();
});

function setup(props: Partial<MetadataDialogProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChange = vi.fn<(change: MetadataChange) => void>();
  const onDeleted = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  const result = render(
    <QueryClientProvider client={client}>
      <MetadataDialog open onOpenChange={onOpenChange} brew={makeBrew()} onChange={onChange} onDeleted={onDeleted} baseUrl="https://brew.example" {...props} />
    </QueryClientProvider>,
  );
  const last = (): MetadataChange => {
    const call = onChange.mock.calls.at(-1);
    if (!call) throw new Error('onChange was not called');
    return call[0];
  };
  return { ...result, client, onChange, onDeleted, onOpenChange, user, last };
}

describe('MetadataDialog: every field reports its save payload', () => {
  it('title', async () => {
    const { user, last } = setup();
    const title = screen.getByRole('textbox', { name: 'Title' });
    expect(title).toHaveFocus();
    await user.clear(title);
    await user.type(title, 'New title');
    expect(last()).toEqual(expect.objectContaining({ field: 'title', meta: { ...BASE, title: 'New title' } }));
    expect(last().draft.title).toBe('New title');
  });

  it('title over 100 characters is not reported and shows the upstream message', async () => {
    const { user, onChange } = setup();
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    onChange.mockClear();
    await user.click(title);
    await user.paste('x'.repeat(101));
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByText('Max title length of 100 characters')).toBeInTheDocument();
    expect(title).toHaveAttribute('aria-invalid', 'true');
    await user.type(title, '{Backspace}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Max title length of 100 characters')).toBeNull();
  });

  it('description', async () => {
    const { user, last } = setup();
    const description = screen.getByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.type(description, 'Rooms and rumours');
    expect(last()).toEqual(expect.objectContaining({ field: 'description', meta: { ...BASE, description: 'Rooms and rumours' } }));
    expect(description).toHaveAccessibleDescription('17 / 500 characters');
  });

  it('thumbnail, with a preview; an invalid URL is not reported', async () => {
    const { user, last, onChange } = setup();
    const thumbnail = screen.getByRole('textbox', { name: 'Thumbnail' });
    await user.click(thumbnail);
    await user.paste('https://i.example/t.png');
    expect(last()).toEqual(expect.objectContaining({ field: 'thumbnailUrl', meta: { ...BASE, thumbnailUrl: 'https://i.example/t.png' } }));
    expect(screen.getByRole('img', { name: 'Thumbnail preview' })).toHaveAttribute('src', 'https://i.example/t.png');
    await user.click(screen.getByRole('button', { name: 'Hide thumbnail preview' }));
    expect(screen.queryByRole('img', { name: 'Thumbnail preview' })).toBeNull();

    onChange.mockClear();
    await user.clear(thumbnail);
    expect(last().meta.thumbnailUrl).toBe(''); // cleared: '' removes the stored thumbnail
    onChange.mockClear();
    await user.type(thumbnail, 'ftp://x');
    expect(onChange).not.toHaveBeenCalled();
    thumbnail.blur();
    expect(await screen.findByText('Must be a valid URL')).toBeInTheDocument();
  });

  it('tags: add, normalize, remove', async () => {
    const { user, last } = setup();
    const tags = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(tags, 'system:dnd{Enter}');
    expect(last()).toEqual(expect.objectContaining({ field: 'tags', meta: { ...BASE, tags: ['dragons', 'system:D&D'] } }));
    await user.click(screen.getByRole('button', { name: 'Remove tag dragons' }));
    expect(last().meta.tags).toEqual(['system:D&D']);
  });

  it('tags: a curated suggestion', async () => {
    const { user, last } = setup();
    const tags = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(tags, 'system:D&D 5');
    const option = screen.getAllByRole('option').find((o) => o.dataset.value === 'system:D&D 5e');
    expect(option).toBeDefined();
    await user.click(option!);
    expect(last().meta.tags).toEqual(['dragons', 'system:D&D 5e']);
  });

  it('language: pick from the list or type a code', async () => {
    const { user, last, onChange } = setup();
    const lang = screen.getByRole('combobox', { name: 'Language' });
    await user.clear(lang);
    await user.type(lang, 'de');
    const deOption = screen.getAllByRole('option').find((o) => o.dataset.value === 'de');
    await user.click(deOption!);
    expect(last()).toEqual(expect.objectContaining({ field: 'lang', meta: { ...BASE, lang: 'de' } }));
    await user.clear(lang);
    await user.type(lang, 'pt-BR');
    expect(last().meta.lang).toBe('pt-BR');
    onChange.mockClear();
    await user.type(lang, '-x');
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByText('Invalid language code.')).toBeInTheDocument();
  });

  it('theme: the list has static themes and the user themes from the API, grouped', async () => {
    const { user, last } = setup();
    const theme = screen.getByRole('combobox', { name: 'Theme' });
    await waitFor(() => expect(theme).toHaveValue('5e PHB'));
    expect(api.requests.some((r) => r.method === 'GET' && r.path === '/api/themes')).toBe(true);
    await user.click(screen.getAllByRole('button', { name: 'Show options' }).at(-1)!);
    const list = screen.getByRole('listbox', { name: 'Theme' });
    const groups = within(list).getAllByRole('group');
    expect(groups.map((g) => g.textContent?.split(/(?=5e PHB|Blank|My Parchment|Starry)/)[0])).toEqual(['Built-in themes', 'My themes', 'Shared themes']);
    expect(within(within(list).getByRole('group', { name: 'My themes' })).getAllByRole('option').map((o) => o.dataset.value)).toEqual(['mineTheme001']);
    expect(within(within(list).getByRole('group', { name: 'Shared themes' })).getByRole('option')).toHaveTextContent('Starryby dave');
    // A brew can't be its own theme.
    expect(within(list).queryByText('This brew')).toBeNull();
    await user.click(within(list).getByText('My Parchment'));
    expect(last()).toEqual(expect.objectContaining({ field: 'theme', meta: { ...BASE, theme: 'mineTheme001' } }));
    expect(theme).toHaveValue('My Parchment (alice)');
  });

  it('theme: a pasted share URL or id; anything else shows the upstream message', async () => {
    const { user, last, onChange } = setup();
    const theme = screen.getByRole('combobox', { name: 'Theme' });
    await waitFor(() => expect(theme).toHaveValue('5e PHB'));
    await user.clear(theme);
    await user.paste('https://brew.example/share/pastedTheme1');
    await user.keyboard('{Enter}');
    expect(last().meta.theme).toBe('pastedTheme1');
    expect(theme).toHaveValue('pastedTheme1');
    onChange.mockClear();
    await user.clear(theme);
    await user.paste('not a theme');
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Must be a valid Share URL or a 12-character ID.')).toBeInTheDocument();
    await user.clear(theme);
    await user.type(theme, 'blank');
    await user.tab();
    expect(last().meta.theme).toBe('Blank');
  });

  it('theme: when the list fails, it says so and Retry loads it again', async () => {
    themesStatus = 500;
    const { user } = setup();
    expect(await screen.findByText(/Couldn't load the theme list/)).toBeInTheDocument();
    themesStatus = 200;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('5e PHB'));
  });

  it('published', async () => {
    const { user, last } = setup();
    await user.click(screen.getByRole('switch', { name: 'Published' }));
    expect(last()).toEqual(expect.objectContaining({ field: 'published', meta: { ...BASE, published: true } }));
  });

  it('authors: the owner invites and removes; the payload lists every handle in order', async () => {
    const { user, last } = setup();
    const invite = screen.getByRole('combobox', { name: 'Invited authors' });
    await user.type(invite, ' Carol {Enter}');
    expect(last()).toEqual(
      expect.objectContaining({
        field: 'authors',
        meta: { ...BASE, authors: ['alice', 'bob', 'carol'] },
      }),
    );
    expect(last().draft.authors.at(-1)).toEqual({ handle: 'carol', role: 'invited' });
    // Already listed / malformed.
    await user.type(invite, 'bob{Enter}');
    expect(invite).toHaveAccessibleDescription(/already on the author list/);
    await user.clear(invite);
    await user.type(invite, 'x{Enter}');
    expect(invite).toHaveAccessibleDescription(/3 to 32/);

    await user.click(screen.getByRole('button', { name: 'Remove author bob' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Remove bob as an author?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove author' }));
    expect(last().meta.authors).toEqual(['alice', 'carol']);
    // The owner can't be removed.
    expect(screen.queryByRole('button', { name: 'Remove author alice' })).toBeNull();
  });

  it('authors: others see the lists read-only and never send them', async () => {
    const { user, last } = setup({ brew: makeBrew({ role: 'author', authors: [{ handle: 'alice', role: 'owner' }, { handle: 'bob', role: 'author' }, { handle: 'carol', role: 'invited' }] }) });
    expect(screen.queryByRole('combobox', { name: 'Invited authors' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove author/ })).toBeNull();
    expect(screen.getByRole('list', { name: 'Invited authors' })).toHaveTextContent('carol');
    expect(screen.getByRole('link', { name: 'alice' })).toHaveAttribute('href', '/user/alice');
    await user.click(screen.getByRole('switch', { name: 'Published' }));
    expect(last().meta).not.toHaveProperty('authors');
  });

  it('delete: confirm, DELETE /api/brews/{editId}, then onDeleted', async () => {
    const { user, onDeleted } = setup({ brew: makeBrew({ authors: [{ handle: 'alice', role: 'owner' }] }) });
    await user.click(screen.getByRole('button', { name: 'Delete brew' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Delete this brew?' });
    // Danger: Cancel has focus first.
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ brewDeleted: true }, EDIT_ID));
    expect(api.requests.some((r) => r.method === 'DELETE' && r.path === `/api/brews/${EDIT_ID}`)).toBe(true);
  });

  it('delete: with other authors it removes the caller only', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove from my brews' }));
    expect(screen.getByRole('alertdialog', { name: 'Remove this brew from your collection?' })).toBeInTheDocument();
  });

  it('delete is hidden for a brew that was never saved', () => {
    setup({ brew: makeBrew({ editId: null, role: null }) });
    expect(screen.queryByRole('button', { name: /Delete brew|Remove from my brews/ })).toBeNull();
  });

  it('lock: shows the reason and requests a review', async () => {
    const onLockChange = vi.fn();
    const { user } = setup({ brew: makeBrew({ lock: { code: 455, message: 'Copied text.', applied: '2026-09-01T12:00:00Z', reviewRequested: null } }), onLockChange });
    const lock = screen.getByRole('region', { name: 'This brew is locked' });
    expect(lock).toHaveTextContent('Copied text.');
    expect(lock).toHaveTextContent('code 455');
    await user.click(within(lock).getByRole('button', { name: 'Request review' }));
    expect(await within(lock).findByTestId('review-requested')).toHaveTextContent('Review requested on');
    expect(onLockChange).toHaveBeenCalledWith(expect.objectContaining({ reviewRequested: '2026-09-25T10:00:00Z' }));
    expect(api.requests.some((r) => r.method === 'POST' && r.path === `/api/brews/${EDIT_ID}/lock/review`)).toBe(true);
  });

  it('server validation errors show on their fields until the field is edited', async () => {
    const serverError = ApiError.fromResponse(new Response(null, { status: 400 }), {
      title: 'One or more validation errors occurred.',
      errors: { 'meta.title': ['must be at most 100 characters'], 'meta.authors': ["No user has the handle 'zed'."], 'meta.x': ['Something else.'] },
    });
    const { user } = setup({ serverError });
    const title = screen.getByRole('textbox', { name: 'Title' });
    expect(title).toHaveAccessibleDescription(/must be at most 100 characters/);
    expect(screen.getByRole('combobox', { name: 'Invited authors' })).toHaveAccessibleDescription(/No user has the handle 'zed'/);
    expect(screen.getByRole('alert')).toHaveTextContent('Something else.');
    await user.type(title, '!');
    expect(title).not.toHaveAccessibleDescription(/must be at most/);
    // Other fields keep theirs.
    expect(screen.getByRole('combobox', { name: 'Invited authors' })).toHaveAccessibleDescription(/No user has the handle 'zed'/);
  });

  it('starts from the given draft on every open', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      const [open, setOpen] = useState(true);
      const [draft, setDraft] = useState<MetaDraft | undefined>(undefined);
      return (
        <QueryClientProvider client={client}>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <MetadataDialog open={open} onOpenChange={setOpen} brew={makeBrew()} {...(draft ? { draft } : {})} onChange={(c) => setDraft(c.draft)} />
        </QueryClientProvider>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('textbox', { name: 'Title' }), ' II');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('The Inn II');
  });
});
