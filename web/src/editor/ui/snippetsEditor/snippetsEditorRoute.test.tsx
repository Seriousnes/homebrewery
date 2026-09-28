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
/**
 * Past the panel's report of the last edit (edits reach the page at most every SNIPPETS_REPORT_MS):
 * the edit set that timer, so this later, longer one runs after it (timers run by due time).
 */
const reported = () => act(() => new Promise((resolve) => setTimeout(resolve, SNIPPETS_REPORT_MS + 1)));

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

const TAVERN = { name: 'Tavern note', gen: '{{note\nHi\n}}' };
const GOBLIN = { group: 'Monsters', name: 'Goblin', gen: '{{monster\n## Goblin\n}}' };
const MENU_BEFORE = ['Brew Snippets › Shared theme › Banner', 'Brew Snippets › Orig › Tavern note'];

/** /edit/b1 with these snippets, ready (the panel open with `panel`). */
async function openBrew(snippets: unknown[], { panel = false } = {}) {
  if (panel) snippetsPanelStore.setOpen(true);
  const server = createBrewServer({ me: ALICE, brews: [fakeBrew('b1', { snippets })] });
  const view = renderApp({ url: '/edit/b1', me: ALICE });
  await waitFor(() => expect(appRoot()).toHaveAttribute('data-canvas-status', 'ready'));
  await waitFor(() => expect(screen.getByTestId('insert-menu')).toBeEnabled());
  const snippetsPanel = () => screen.getByRole('complementary', { name: 'Snippets' });
  return { ...view, server, snippetsPanel };
}

/** A new snippet named Goblin in the group Monsters, without a body yet. */
async function addGoblin(user: ReturnType<typeof renderApp>['user'], panel: HTMLElement) {
  await user.click(within(panel).getByRole('button', { name: 'New snippet' }));
  const name = within(panel).getByRole('textbox', { name: /^Name/ });
  // Pasted, not typed key by key: every keystroke re-renders the whole editor page in jsdom
  // (typing in the panel is SnippetsEditor.test.tsx's subject).
  await user.clear(name);
  await user.paste('Goblin');
  await user.click(within(panel).getByRole('combobox', { name: /^Group/ }));
  await user.paste('Monsters');
}

/** Gives the selected snippet its body (the code editor's own change). */
function writeBody(panel: HTMLElement, text: string) {
  const body = EditorView.findFromDOM(within(panel).getByTestId('snippet-body').querySelector<HTMLElement>('.cm-editor')!)!;
  act(() => body.dispatch({ changes: { from: 0, insert: text } }));
}

// Short flows from prepared states: each through the whole editor page in jsdom, where every user
// step re-renders it.
describe('brew snippets in the editor page', () => {
  it('lists the brew’s and the user theme’s snippets in the Insert menu, and in the panel the app bar opens', async () => {
    const { user } = await openBrew([TAVERN]);
    expect(await insertMenuPaths(user)).toEqual(MENU_BEFORE);

    const toggle = screen.getByTestId('toggle-snippets');
    expect(within(screen.getByRole('group', { name: 'Panels' })).getByTestId('toggle-snippets')).toBe(toggle);
    await user.click(toggle);
    const panel = screen.getByRole('complementary', { name: 'Snippets' });
    expect(within(panel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Tavern note']);
    // The user theme's snippets are shown, read-only.
    expect(within(within(panel).getByTestId('theme-snippets')).getByText('Banner')).toBeInTheDocument();
    expect(appRoot()).toHaveAttribute('data-save-status', 'saved');
  });

  it('a new snippet marks the brew dirty, and reaches the Insert menu once it has a body', async () => {
    const { user, snippetsPanel } = await openBrew([TAVERN], { panel: true });
    await addGoblin(user, snippetsPanel());
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-save-status', 'dirty'));
    // An empty snippet isn't listed (as upstream) …
    expect(await insertMenuPaths(user)).toEqual(MENU_BEFORE);
    // … a body makes it an entry.
    writeBody(snippetsPanel(), GOBLIN.gen);
    await reported();
    expect(await insertMenuPaths(user)).toEqual([...MENU_BEFORE, 'Brew Snippets › Monsters › Goblin']);
  });

  it('saves the snippets in their stored form', async () => {
    const { user, server, snippetsPanel } = await openBrew([TAVERN], { panel: true });
    await addGoblin(user, snippetsPanel());
    writeBody(snippetsPanel(), GOBLIN.gen);
    await reported();
    pressSaveKey();
    await waitFor(() => expect(logOf(server, 'PUT', '/api/brews/b1')).toEqual(['200']));
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect((JSON.parse(put.body!) as { snippets: unknown }).snippets).toEqual([TAVERN, GOBLIN]);
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-save-status', 'saved'));
  });

  it('a deleted snippet is gone from the Insert menu at once, and the brew is dirty', async () => {
    const { user, snippetsPanel } = await openBrew([TAVERN, GOBLIN], { panel: true });
    expect(await insertMenuPaths(user)).toEqual([...MENU_BEFORE, 'Brew Snippets › Monsters › Goblin']);
    await user.click(within(snippetsPanel()).getByRole('option', { name: 'Goblin' }));
    await user.click(within(snippetsPanel()).getByRole('button', { name: 'Delete' }));
    await reported();
    expect(await insertMenuPaths(user)).toEqual(MENU_BEFORE);
    await waitFor(() => expect(appRoot()).toHaveAttribute('data-save-status', 'dirty'));
  });
});
