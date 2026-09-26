// EditorApp in jsdom with the theme loader mocked: what each mode composes (toolbars, panels,
// banners, dialogs), the shortcuts, and the read-only view. Layout, pagination, saving against
// the API and print output are covered by the Playwright flows (web/e2e/flows).
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, jsonResponse, mockApi } from '@/api/testing';
import { testQueryClient } from '@/app/testing';
import { uiStore } from '@/app/uiStore';
import { clearToasts, toastStore } from '@/ui';
import type { AppliedThemeStyles, ThemeChain } from '@/editor/canvas/themeLoader';
import { EditorApp, type EditorAppProps } from './EditorApp';
import { appBrewForNew, blankDoc, defaultMeta, type EditorAppBrew } from './editorAppModel';

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
  loader.loadThemeChain.mockImplementation((theme: string) => Promise.resolve(chainOf(theme)));
  loader.applyThemeStyles.mockImplementation(
    (): Promise<AppliedThemeStyles> => Promise.resolve({ slot: 's', links: [], sheets: [], failed: [], skippedCss: 0, dispose: vi.fn() }),
  );
  loader.waitForFonts.mockResolvedValue(true);
  mockApi((request) => {
    if (request.url.pathname === '/api/account/me') return emptyResponse(204);
    if (request.url.pathname === '/api/themes') return jsonResponse({ static: [], user: [] });
    return jsonResponse({ title: 'Not found', status: 404 }, 404);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  clearToasts();
});

const content = { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello brew' }] }] }] };

function brewOf(overrides: Partial<EditorAppBrew> = {}): EditorAppBrew {
  return { ...appBrewForNew(null), editId: 'edit1', shareId: 'share1', version: 3, role: 'owner', meta: defaultMeta({ title: 'My brew' }), ...overrides };
}

function renderApp(props: Partial<EditorAppProps> = {}): ReturnType<typeof render> {
  const element: ReactElement = (
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter>
        <EditorApp mode="edit" saving="server" content={content} brew={brewOf()} {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(element);
}

const editorRoot = () => document.querySelector<HTMLElement>('.hb-canvas .ProseMirror');

describe('EditorApp', () => {
  it('edit mode: the editing toolbar, the brew bar, panels, save status and the page heading', async () => {
    renderApp({ heading: (title) => `Editing ${title}` });
    expect(await screen.findByRole('toolbar', { name: 'Editing' })).toBeInTheDocument();
    const bar = screen.getByRole('toolbar', { name: 'Brew' });
    expect(within(bar).getByRole('button', { name: 'Outline' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(bar).getByRole('button', { name: 'Properties' })).toBeInTheDocument();
    expect(within(bar).getByRole('group', { name: 'Pages' })).toBeInTheDocument();
    expect(screen.getByTestId('save-status')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Editing My brew' })).toHaveAttribute('data-route-focus');
    expect(editorRoot()).toHaveAttribute('contenteditable', 'true');
    expect(editorRoot()).toHaveAttribute('aria-label', 'Brew pages');
    // Described by the keyboard hint (how to reach the toolbars and panels from the text; P8.2).
    expect(editorRoot()).toHaveAccessibleDescription(expect.stringContaining('Alt+F10 moves to the editing toolbar'));
    expect(editorRoot()).toHaveAttribute('aria-multiline', 'true');
    // The pages' scroll container is no Tab stop while editing (Firefox would make it one).
    await waitFor(() => expect(document.querySelector('[data-canvas-theme]')).toHaveAttribute('tabindex', '-1'));
    expect(screen.queryByRole('region', { name: 'Pages' })).not.toBeInTheDocument();
    // The inspector is open by default (UI store), next to the canvas.
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('editor-app')).toHaveAttribute('data-canvas-status', 'ready'));
  });

  it('panel toggles open their drawers and point at them while open', async () => {
    renderApp();
    const toggle = await screen.findByRole('button', { name: 'Outline' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'hb-outline-panel');
    expect(document.getElementById('hb-outline-panel')).not.toBeNull();
    expect(uiStore.getState().panels.outline.open).toBe(true);
    await userEvent.click(toggle);
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(document.getElementById('hb-outline-panel')).toBeNull();
  });

  it('opens the properties dialog on the brew', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Properties' }));
    const dialog = await screen.findByRole('dialog', { name: 'Properties' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('My brew');
  });

  it('a locked brew shows the lock banner', async () => {
    renderApp({ brew: brewOf({ lock: { code: 455, message: 'Fix the art credits.', applied: '2026-09-01T00:00:00Z', reviewRequested: null } }) });
    const banner = await screen.findByRole('region', { name: 'This brew is locked' });
    expect(banner).toHaveTextContent('Fix the art credits.');
    expect(within(banner).getByRole('button', { name: 'Request review' })).toBeInTheDocument();
  });

  it('Ctrl+P prints the canvas from anywhere on the page', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    renderApp();
    await screen.findByRole('toolbar', { name: 'Editing' });
    await waitFor(() => expect(editorRoot()).not.toBeNull());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  });

  it('never-saved pages show their note instead of the save status, and Ctrl+S explains', async () => {
    renderApp({ saving: 'none', brew: brewOf({ editId: null, shareId: null }), statusNote: <span>Not saved here</span> });
    expect(await screen.findByText('Not saved here')).toBeInTheDocument();
    expect(screen.queryByTestId('save-status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Properties' })).toBeNull();
    const event = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(toastStore.getState().toasts.map((t) => t.title)).toContain('This page is never saved');
  });

  it('view mode: read-only, no editing toolbar, zoom and page layout in the bar, a focusable viewport', async () => {
    renderApp({ mode: 'view', saving: 'none', brew: brewOf({ role: null, version: null }) });
    const bar = await screen.findByRole('toolbar', { name: 'Viewing' });
    expect(screen.queryByRole('toolbar', { name: 'Editing' })).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Style (brew CSS)' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    await waitFor(() => expect(editorRoot()).toHaveAttribute('contenteditable', 'false'));
    expect(editorRoot()).toHaveAttribute('aria-readonly', 'true');
    expect(editorRoot()).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('editor-keyboard-hint')).not.toBeInTheDocument();
    const viewport = await screen.findByRole('region', { name: 'Pages' });
    expect(viewport).toHaveAttribute('tabindex', '0');
    await userEvent.click(within(bar).getByRole('button', { name: 'Zoom in' }));
    expect(uiStore.getState().zoom).toBeGreaterThan(1);
  });

  it('autoFocus puts the caret in the editor unless the reader is elsewhere on the page', async () => {
    renderApp({ autoFocus: true, content: blankDoc() });
    await waitFor(() => expect(editorRoot()).toHaveFocus());
  });
});
