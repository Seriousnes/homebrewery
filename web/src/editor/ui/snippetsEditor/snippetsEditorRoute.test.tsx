// The Snippets panel inside the real editor page (/edit/:editId over the fake brew API): its
// toggle in the app bar, the Insert menu's "Brew Snippets" following every edit at once, the
// brew turning dirty, and the save request carrying the stored form. The same flow against the
// real API, in both browsers, is web/e2e/snippets-editor.
import { EditorView } from '@codemirror/view';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE } from '@/app/testing';
import { uiStore } from '@/app/uiStore';
import type { AppliedThemeStyles, ThemeChain } from '@/editor/canvas/themeLoader';
import { createBrewServer, fakeBrew, logOf, preloadAppPages, pressSaveKey, renderApp } from '@/pages/routeTesting';
import { clearToasts } from '@/ui';
import { snippetsPanelStore } from './snippetsPanelState';
import { SNIPPETS_REPORT_MS } from './useSnippetsEditor';

const loader = vi.hoisted(() => ({
  loadThemeChain: vi.fn(),
  applyThemeStyles: vi.fn(),
  waitForFonts: vi.fn(),
  disposeThemeSlot: vi.fn(),
}));
vi.mock('@/editor/canvas/themeLoader', () => loader);

const chainOf = (theme: string): ThemeChain => ({
  theme,
  source: 'static',
  name: theme,
  author: null,
  styles: [],
  // A user theme with snippets: listed read-only in the panel.
  snippets: [{ name: 'Shared theme', snippets: '\\snippet Banner\n# Banner\n' }],
});

beforeAll(() => {
  // jsdom has no layout: the Insert menu scrolls its active option into view.
  if (!('scrollIntoView' in Element.prototype)) Object.assign(Element.prototype, { scrollIntoView: () => undefined });
  // The lazy route modules, once (hook timeout): the test's waitFor never covers a first import.
  return preloadAppPages();
});

beforeEach(() => {
  uiStore.getState().resetUi();
  snippetsPanelStore.setOpen(false);
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

const appRoot = () => screen.getByTestId('editor-app');
/** Past the panel's report window (edits reach the page at most every SNIPPETS_REPORT_MS). */
const reported = () => act(() => new Promise((resolve) => setTimeout(resolve, SNIPPETS_REPORT_MS + 50)));

async function insertMenuPaths(user: ReturnType<typeof renderApp>['user']): Promise<string[]> {
  await user.click(screen.getByTestId('insert-menu'));
  const listbox = await screen.findByRole('listbox', { name: 'Snippets' });
  const paths = within(listbox)
    .getAllByRole('option')
    .map((o) => o.getAttribute('data-snippet') ?? '')
    .filter((p) => p.startsWith('Brew Snippets'));
  await user.keyboard('{Escape}');
  return paths;
}

describe('brew snippets in the editor page', () => {
  // One flow through the whole editor page: about 20 user steps at 200–450 ms each in jsdom (4.5 s
  // alone on a busy machine, up to 10 s in a full parallel run), so 15 s instead of the 5 s default.
  it('edits reach the Insert menu at once, mark the brew dirty and are saved', { timeout: 15_000 }, async () => {
    const server = createBrewServer({
      me: ALICE,
      brews: [fakeBrew('b1', { snippets: [{ name: 'Tavern note', gen: '{{note\nHi\n}}' }] })],
    });
    const { user } = renderApp({ url: '/edit/b1', me: ALICE });
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-canvas-status', 'ready'), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId('insert-menu')).toBeEnabled());
    expect(await insertMenuPaths(user)).toEqual(['Brew Snippets › Shared theme › Banner', 'Brew Snippets › Orig › Tavern note']);

    const toggle = screen.getByTestId('toggle-snippets');
    expect(within(screen.getByRole('group', { name: 'Panels' })).getByTestId('toggle-snippets')).toBe(toggle);
    await user.click(toggle);
    const panel = screen.getByRole('complementary', { name: 'Snippets' });
    expect(within(panel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Tavern note']);
    // The user theme's snippets are shown, read-only.
    expect(within(within(panel).getByTestId('theme-snippets')).getByText('Banner')).toBeInTheDocument();
    expect(appRoot()).toHaveAttribute('data-save-status', 'saved');

    await user.click(within(panel).getByRole('button', { name: 'New snippet' }));
    const name = within(panel).getByRole('textbox', { name: /^Name/ });
    // Pasted, not typed key by key: every keystroke re-renders the whole editor page in jsdom
    // (typing in the panel is SnippetsEditor.test.tsx's subject).
    await user.clear(name);
    await user.paste('Goblin');
    await user.click(within(panel).getByRole('combobox', { name: /^Group/ }));
    await user.paste('Monsters');
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-save-status', 'dirty'));
    // An empty snippet isn't listed (as upstream) …
    expect(await insertMenuPaths(user)).toEqual(['Brew Snippets › Shared theme › Banner', 'Brew Snippets › Orig › Tavern note']);
    // … a body makes it an entry.
    const body = EditorView.findFromDOM(within(panel).getByTestId('snippet-body').querySelector<HTMLElement>('.cm-editor')!)!;
    act(() => body.dispatch({ changes: { from: 0, insert: '{{monster\n## Goblin\n}}' } }));
    await reported();
    expect(await insertMenuPaths(user)).toEqual([
      'Brew Snippets › Shared theme › Banner',
      'Brew Snippets › Orig › Tavern note',
      'Brew Snippets › Monsters › Goblin',
    ]);

    pressSaveKey();
    await waitFor(() => expect(logOf(server, 'PUT', '/api/brews/b1')).toEqual(['200']));
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect((JSON.parse(put.body!) as { snippets: unknown }).snippets).toEqual([
      { name: 'Tavern note', gen: '{{note\nHi\n}}' },
      { group: 'Monsters', name: 'Goblin', gen: '{{monster\n## Goblin\n}}' },
    ]);
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-save-status', 'saved'));

    // Deleting it: gone from the menu at once.
    await user.click(within(panel).getByRole('button', { name: 'Delete' }));
    await reported();
    expect(await insertMenuPaths(user)).toEqual(['Brew Snippets › Shared theme › Banner', 'Brew Snippets › Orig › Tavern note']);
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-save-status', 'dirty'));
  });
});
