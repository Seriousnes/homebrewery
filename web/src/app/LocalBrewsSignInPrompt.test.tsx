import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/api';
import { jsonResponse, mockApi } from '@/api/testing';
import { createLocalBrewLibrary, type LocalBrew, type LocalBrewSummary, setDefaultLocalBrews } from '@/editor/local/localBrews';
import { memoryStore } from '@/editor/save/kvStore';
import { clearToasts, toastStore } from '@/ui';
import { LocalBrewsSignInPrompt } from './LocalBrewsSignInPrompt';
import { ALICE, renderRoute } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  setDefaultLocalBrews(null);
});

describe('LocalBrewsSignInPrompt', () => {
  it('opens after a sign-in with local brews; a storage error on Upload all is reported and nothing is sent', async () => {
    const api = mockApi(() => jsonResponse([]));
    const library = createLocalBrewLibrary(memoryStore<LocalBrew>(), memoryStore<LocalBrewSummary>());
    setDefaultLocalBrews({ ...library, count: () => Promise.resolve(2), list: () => Promise.reject(new Error('IndexedDB went away.')) });
    const { queryClient, user } = renderRoute(<LocalBrewsSignInPrompt />, { me: null });

    act(() => {
      queryClient.setQueryData(queryKeys.account.me(), ALICE);
    });
    const prompt = await screen.findByRole('dialog', { name: 'You have 2 brews on this device' });
    await user.click(screen.getByTestId('local-prompt-upload-all'));

    await waitFor(() => expect(toastStore.getState().toasts.map((t) => t.title)).toContain('Couldn’t read the brews on this device'));
    expect(prompt).toBeInTheDocument(); // still open, to try again
    expect(screen.getByTestId('local-prompt-upload-all')).not.toHaveAttribute('aria-busy', 'true');
    expect(api.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('does not open for a page loaded already signed in', () => {
    mockApi(() => jsonResponse([]));
    const count = vi.fn(() => Promise.resolve(3));
    setDefaultLocalBrews({ ...createLocalBrewLibrary(memoryStore<LocalBrew>(), memoryStore<LocalBrewSummary>()), count });
    renderRoute(<LocalBrewsSignInPrompt />, { me: ALICE });
    // The prompt opens only on what count() answers, and it never asks (render ran the effects).
    expect(count).not.toHaveBeenCalled();
    expect(screen.queryByTestId('local-brews-prompt')).toBeNull();
  });
});
