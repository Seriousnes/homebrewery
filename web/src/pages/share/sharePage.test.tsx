// The share page with the app's real routes over a fake brew API: what it shows (the brew, its
// view count, Edit or Clone) as the reader signs in and out, and that a visit after an edit shows
// the saved version.
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestSignIn } from '@/api';
import { ALICE } from '@/app/testing';
import { uiStore } from '@/app/uiStore';
import type { AppliedThemeStyles, ThemeChain } from '@/editor/canvas/themeLoader';
import { appEditor, createBrewServer, docText, fakeBrew, logOf, pressSaveKey, renderApp } from '@/pages/routeTesting';
import { clearToasts } from '@/ui';

const loader = vi.hoisted(() => ({
  loadThemeChain: vi.fn(),
  applyThemeStyles: vi.fn(),
  waitForFonts: vi.fn(),
  disposeThemeSlot: vi.fn(),
}));
vi.mock('@/editor/canvas/themeLoader', () => loader);

const chainOf = (theme: string): ThemeChain => ({ theme, source: 'static', name: theme, author: null, styles: [], snippets: [] });

beforeEach(() => {
  uiStore.getState().resetUi();
  localStorage.clear();
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

const nav = () => screen.getByRole('navigation', { name: 'Main' });
const waitForEditor = () => waitFor(() => expect(appEditor()).not.toBeNull());
const shareGets = (server: ReturnType<typeof createBrewServer>, shareId = 'shareorigA') => logOf(server, 'GET', `/api/brews/share/${shareId}`);

async function signInThroughDialog(user: ReturnType<typeof renderApp>['user']) {
  const dialog = await screen.findByTestId('sign-in-prompt');
  await user.type(within(dialog).getByLabelText(/Email/), 'alice@example.test');
  await user.type(within(dialog).getByLabelText(/Password/), 'Secret1!');
  await user.click(within(dialog).getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(screen.queryByTestId('sign-in-prompt')).toBeNull());
}

describe('share page', () => {
  it('a visit after editing the brew shows the saved version', async () => {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('origA')] });
    const { router } = renderApp({ url: '/share/shareorigA', me: ALICE });
    await waitForEditor();
    expect(docText(appEditor()?.getJSON())).toBe('Old text');

    await act(() => router.navigate('/edit/origA'));
    await waitFor(() => expect(screen.getByTestId('editor-app')).toHaveAttribute('data-mode', 'edit'));
    await waitForEditor();
    act(() => {
      appEditor()?.commands.setContent({ type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New text' }] }] }] });
    });
    pressSaveKey();
    await waitFor(() => expect(screen.getByTestId('editor-app')).toHaveAttribute('data-save-status', 'saved'));
    expect(docText(server.brews.get('origA')?.doc)).toBe('New text');

    await act(() => router.navigate('/share/shareorigA'));
    await waitFor(() => expect(screen.getByTestId('share-view')).toBeInTheDocument());
    await waitForEditor();
    await waitFor(() => expect(docText(appEditor()?.getJSON())).toBe('New text'));
    expect(shareGets(server)).toEqual(['200', '200']);
  });

  it('shows the view count', async () => {
    createBrewServer({ me: null, brews: [fakeBrew('origA', { views: 1233 })] });
    renderApp({ url: '/share/shareorigA', me: null });
    expect(await screen.findByTestId('share-views')).toHaveTextContent('1,234 views');
  });

  it('an author who signs in on the page gets the Edit link; the refetch counts no view', async () => {
    const server = createBrewServer({ me: null, brews: [fakeBrew('origA')] });
    server.loginAs = ALICE;
    const { user } = renderApp({ url: '/share/shareorigA', me: null });
    await waitForEditor();
    expect(within(nav()).queryByTestId('nav-edit')).toBeNull();
    act(() => requestSignIn(null));
    await signInThroughDialog(user);
    const edit = await within(nav()).findByTestId('nav-edit');
    expect(edit).toHaveAttribute('href', '/edit/origA');
    expect(within(nav()).queryByTestId('nav-clone')).toBeNull();
    expect(server.brews.get('origA')?.views).toBe(1);
  });

  it('another reader who signs in gets Clone, and no second view is counted', async () => {
    const server = createBrewServer({ me: null, brews: [fakeBrew('origA', { authors: [{ handle: 'bob', role: 'owner' }] })] });
    server.loginAs = ALICE;
    const { user } = renderApp({ url: '/share/shareorigA', me: null });
    await waitForEditor();
    act(() => requestSignIn(null));
    await signInThroughDialog(user);
    expect(await within(nav()).findByTestId('nav-clone')).toBeInTheDocument();
    expect(within(nav()).queryByTestId('nav-edit')).toBeNull();
    expect(shareGets(server)).toEqual(['200']);
    expect(server.brews.get('origA')?.views).toBe(1);
  });

  it('an author who signs out loses the Edit link, and no view is counted', async () => {
    const server = createBrewServer({ me: ALICE, brews: [fakeBrew('origA')] });
    const { user, queryClient } = renderApp({ url: '/share/shareorigA', me: ALICE });
    await waitForEditor();
    expect(await within(nav()).findByTestId('nav-edit')).toBeInTheDocument();
    await user.click(within(nav()).getByRole('button', { name: 'Account: alice' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await within(nav()).findByRole('link', { name: 'Sign in' });
    // The sign-out is over, with what it refetched: the logout mutation ends after that refresh.
    await waitFor(() => expect(queryClient.isMutating() + queryClient.isFetching()).toBe(0));
    expect(within(nav()).queryByTestId('nav-edit')).toBeNull();
    expect(within(nav()).queryByTestId('nav-clone')).toBeNull();
    expect(shareGets(server)).toEqual(['200']);
    expect(server.brews.get('origA')?.views).toBe(0);
  });
});
