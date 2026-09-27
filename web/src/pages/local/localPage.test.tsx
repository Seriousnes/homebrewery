import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { closeSignInPrompt } from '@/app/signInPromptStore';
import { ALICE, renderRoute } from '@/app/testing';
import {
  createLocalBrewLibrary,
  defaultLocalBrews,
  LOCAL_BREW_FORMAT,
  type LocalBrew,
  type LocalBrewSummary,
  localMeta,
  setDefaultLocalBrews,
} from '@/editor/local/localBrews';
import { memoryStore } from '@/editor/save/kvStore';
import { clearToasts, toastStore } from '@/ui';
import LocalBrewsPage from './index';

const brew = (id: string, title: string, updatedAt: number): LocalBrew => ({
  v: LOCAL_BREW_FORMAT,
  id,
  createdAt: updatedAt,
  updatedAt,
  docSchemaVersion: 1,
  doc: { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph' }] }, { type: 'page', content: [{ type: 'paragraph' }] }] },
  style: '',
  snippets: null,
  meta: localMeta({ title }),
});

async function seed(...brews: LocalBrew[]) {
  for (const b of brews) await defaultLocalBrews().save(b);
}

const items = () => screen.queryAllByTestId('local-brew-item');
const toastTitles = () => toastStore.getState().toasts.map((t) => t.title);

beforeEach(() => {
  setDefaultLocalBrews(createLocalBrewLibrary(Object.assign(memoryStore<LocalBrew>(), { persistent: () => true }), memoryStore<LocalBrewSummary>()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  closeSignInPrompt();
});

describe('Brews on this device', () => {
  it('lists the brews newest first, with Open links; signed out, it offers sign-in instead of Upload', async () => {
    mockApi(() => jsonResponse([]));
    await seed(brew('older', 'Older brew', 1_000), brew('newer', 'Newer brew', 2_000));
    renderRoute(<LocalBrewsPage />, { url: '/local', path: 'local', me: null });
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(items().map((li) => within(li).getByRole('link').textContent)).toEqual(['Newer brew', 'Older brew']);
    expect(within(items()[0]!).getByRole('link')).toHaveAttribute('href', '/local/newer');
    expect(items()[0]).toHaveTextContent('2 pages');
    expect(screen.queryByTestId('local-brew-upload')).toBeNull();
    expect(screen.queryByTestId('local-upload-all')).toBeNull();
    expect(screen.getByTestId('local-page-sign-in')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    mockApi(() => jsonResponse([]));
    renderRoute(<LocalBrewsPage />, { url: '/local', path: 'local', me: null });
    expect(await screen.findByTestId('local-empty')).toHaveTextContent('No brews on this device');
  });

  it('deletes a brew after confirming', async () => {
    mockApi(() => jsonResponse([]));
    await seed(brew('a', 'Doomed', 1_000));
    const { user } = renderRoute(<LocalBrewsPage />, { url: '/local', path: 'local', me: null });
    await user.click(await screen.findByRole('button', { name: 'Delete Doomed' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Doomed”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete brew' }));
    await waitFor(() => expect(items()).toHaveLength(0));
    expect(await defaultLocalBrews().get('a')).toBeNull();
  });

  it('signed in: uploads one brew, then all the rest; a failed upload stays on the device', async () => {
    let posts = 0;
    const api = mockApi((request) => {
      if (request.method !== 'POST') return jsonResponse([]);
      posts += 1;
      const title = (request.json as { meta: { title: string } }).meta.title;
      if (title === 'Stubborn') return problemResponse(500, { title: 'Server error' });
      return jsonResponse({ editId: `e${posts}`, shareId: `s${posts}`, version: 1, meta: { title } }, 201);
    });
    await seed(brew('one', 'First', 3_000), brew('two', 'Second', 2_000), brew('three', 'Stubborn', 1_000));
    const { user } = renderRoute(<LocalBrewsPage />, { url: '/local', path: 'local', me: ALICE });
    await user.click(await screen.findByRole('button', { name: 'Upload First to my account' }));
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(toastTitles()).toContain('Uploaded to your account');

    await user.click(screen.getByTestId('local-upload-all'));
    await waitFor(() => expect(toastTitles()).toContain('Uploaded 1 of 2'));
    expect(items().map((li) => within(li).getByRole('link').textContent)).toEqual(['Stubborn']);
    expect(api.requests.filter((r) => r.method === 'POST').map((r) => r.headers.get('Idempotency-Key'))).toHaveLength(3);
  });
});
