// The brew snippets editor in jsdom: the list and its keys, the fields and their errors, the
// CodeMirror body (edits, Mod-Z through the store, the size filter), user themes' snippets
// (read-only, copy), import/export of the text form, and the hook that ties it to a page's state.
// The Insert menu, saving and axe run in web/e2e/snippets-editor.
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { UiRoot } from '@/ui';
import { SnippetsEditor } from './SnippetsEditor';
import { SnippetsEditorStore } from './snippetsEditorStore';
import { createSnippetsPanelStore } from './snippetsPanelState';
import { SnippetsPanel, SnippetsToggle } from './SnippetsPanel';
import { SNIPPETS_REPORT_MS, useSnippetsEditor } from './useSnippetsEditor';
import { exportFileName } from './helpers';

beforeAll(() => {
  const proto = Range.prototype as Partial<Pick<Range, 'getClientRects' | 'getBoundingClientRect'>>;
  const empty = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
  proto.getClientRects ??= () => Object.assign([], { item: () => null });
  proto.getBoundingClientRect ??= () => empty;
});

const STORED = [
  { group: 'Tables', name: 'Loot', gen: '|a|b|' },
  { name: 'Tavern note', gen: '{{note\n##### The Pony\n}}' },
];

function setup(value: unknown = STORED, props: Partial<Parameters<typeof SnippetsEditor>[0]> = {}) {
  const onChange = vi.fn();
  // A clock that stands still: typing always merges, however slowly a loaded machine types.
  const store = new SnippetsEditorStore(value, { onChange, now: () => 0 });
  const user = userEvent.setup();
  render(
    <UiRoot colorScheme="light">
      <SnippetsEditor store={store} brewTitle="My Brew" {...props} />
    </UiRoot>,
  );
  return { store, onChange, user, last: () => onChange.mock.calls.at(-1)?.[0] as unknown };
}

function bodyView(): EditorView {
  const dom = screen.getByTestId('snippet-body').querySelector<HTMLElement>('.cm-editor')!;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('no CodeMirror view');
  return view;
}

const options = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('SnippetsEditor', () => {
  it('lists the snippets by Insert-menu submenu and edits the selected one', async () => {
    const { user, last } = setup();
    const list = screen.getByRole('listbox', { name: 'Brew snippets' });
    expect(within(list).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Tables', 'My Brew']);
    expect(options()).toEqual(['Loot', 'Tavern note']);
    expect(screen.getByRole('option', { name: 'Loot' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Loot');
    expect(bodyView().state.doc.toString()).toBe('|a|b|');

    await user.click(screen.getByRole('option', { name: 'Tavern note' }));
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Tavern note');
    expect(screen.getByRole('combobox', { name: /^Group/ })).toHaveValue('');
    expect(bodyView().state.doc.toString()).toBe('{{note\n##### The Pony\n}}');

    const name = screen.getByRole('textbox', { name: /^Name/ });
    await user.clear(name);
    await user.type(name, 'Inn');
    expect(last()).toEqual([STORED[0], { name: 'Inn', gen: STORED[1]!.gen }]);
    await user.type(screen.getByRole('combobox', { name: /^Group/ }), 'Places');
    expect(last()).toEqual([STORED[0], { group: 'Places', name: 'Inn', gen: STORED[1]!.gen }]);
    // It moved to its own submenu.
    expect(within(list).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Tables', 'Places']);
    expect(screen.getByTestId('snippets-status')).toHaveTextContent(/^2 snippets · \d+ B of 2\.0 MB$/);
  });

  it('shows errors on the fields and counts them', async () => {
    const { user } = setup();
    const name = screen.getByRole('textbox', { name: /^Name/ });
    await user.clear(name);
    await user.type(name, 'tavern NOTE');
    await user.clear(screen.getByRole('combobox', { name: /^Group/ }));
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(/Another snippet in “My Brew” has this name/);
    expect(screen.getByTestId('snippets-status')).toHaveTextContent('2 need attention');
    expect(screen.getAllByText('(needs attention)')).toHaveLength(2);
    await user.clear(name);
    expect(name).toHaveAccessibleDescription(/Give the snippet a name/);
    expect(screen.getByRole('option', { name: /Unnamed snippet/ })).toBeInTheDocument();
  });

  it('edits the body in CodeMirror; Mod-Z there undoes through the store', () => {
    const { store, last } = setup();
    const view = bodyView();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '\n|c|d|' } }));
    expect(last()).toEqual([{ ...STORED[0], gen: '|a|b|\n|c|d|' }, STORED[1]]);
    expect(store.getSnapshot().canUndo).toBe(true);
    // Mod-Z in the body: the store's undo (no history of CodeMirror's own).
    act(() => {
      runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }), 'editor');
    });
    expect(view.state.doc.toString()).toBe('|a|b|');
    expect(last()).toBe(STORED);
    act(() => {
      runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }), 'editor');
    });
    expect(view.state.doc.toString()).toBe('|a|b|\n|c|d|');
  });

  it('refuses body edits over the size limit', () => {
    const onChange = vi.fn();
    const store = new SnippetsEditorStore([{ name: 'A', gen: 'abc' }], { onChange, maxSize: 40 });
    render(<SnippetsEditor store={store} brewTitle="T" />);
    const view = bodyView();
    act(() => view.dispatch({ changes: { from: 3, insert: 'x'.repeat(50) } }));
    expect(view.state.doc.toString()).toBe('abc');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('snippets-notice')).toHaveTextContent('can’t take more than 2 MB');
  });

  it('adds, duplicates, moves and deletes with one undo step each (buttons and Ctrl+Z)', async () => {
    const { user, store } = setup();
    await user.click(screen.getByRole('button', { name: 'New snippet' }));
    // A new snippet after the selected one, in its group, its name selected for typing.
    await waitFor(() => expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveFocus());
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('New snippet');
    expect(options()).toEqual(['Loot', 'New snippet', 'Tavern note']);
    expect(screen.getByTestId('snippets-notice')).toHaveTextContent('Added “New snippet”.');

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(options()).toEqual(['Loot', 'New snippet', 'New snippet copy', 'Tavern note']);
    await user.click(screen.getByRole('button', { name: 'Move up' }));
    expect(options()).toEqual(['Loot', 'New snippet copy', 'New snippet', 'Tavern note']);
    // First in its group: Move up is unavailable.
    await user.click(screen.getByRole('option', { name: 'Loot' }));
    expect(screen.getByRole('button', { name: 'Move up' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(options()).toEqual(['New snippet copy', 'New snippet', 'Tavern note']);
    expect(screen.getByTestId('snippets-notice')).toHaveTextContent('Deleted “Loot”. Ctrl+Z undoes it.');

    // Ctrl+Z anywhere in the editor (here the list) undoes the snippet edits in turn.
    screen.getByRole('option', { name: 'New snippet copy' }).focus();
    await user.keyboard('{Control>}z{/Control}');
    expect(options()).toEqual(['Loot', 'New snippet copy', 'New snippet', 'Tavern note']);
    await user.keyboard('{Control>}z{/Control}{Control>}z{/Control}{Control>}z{/Control}');
    expect(options()).toEqual(['Loot', 'Tavern note']);
    expect(store.getSnapshot().canUndo).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Redo snippet edit' }));
    expect(options()).toEqual(['Loot', 'New snippet', 'Tavern note']);
    await user.click(screen.getByRole('button', { name: 'Undo snippet edit' }));
    expect(options()).toEqual(['Loot', 'Tavern note']);
    expect(screen.getByRole('button', { name: 'Undo snippet edit' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('Ctrl+Z in a name field undoes the snippet edit (not the input’s own history)', async () => {
    const { user } = setup();
    const name = screen.getByRole('textbox', { name: /^Name/ });
    await user.type(name, ' table');
    expect(name).toHaveValue('Loot table');
    await user.keyboard('{Control>}z{/Control}');
    expect(name).toHaveValue('Loot');
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(name).toHaveValue('Loot table');
  });

  it('is keyboard operable: arrows, Home/End, Enter to the name, Delete', async () => {
    const { user } = setup([
      { name: 'A', gen: 'a' },
      { name: 'B', gen: 'b' },
      { name: 'C', gen: 'c' },
    ]);
    const a = screen.getByRole('option', { name: 'A' });
    // One tab stop: the selected option.
    expect(a).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('option', { name: 'B' })).toHaveAttribute('tabindex', '-1');
    a.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('option', { name: 'B' })).toHaveFocus());
    expect(screen.getByRole('option', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    await waitFor(() => expect(screen.getByRole('option', { name: 'C' })).toHaveFocus());
    await user.keyboard('{Home}');
    await waitFor(() => expect(screen.getByRole('option', { name: 'A' })).toHaveFocus());
    // Hold the refocus the Delete defers to the next frame, so Enter runs before it.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    await user.keyboard('{Delete}');
    expect(options()).toEqual(['B', 'C']);
    await waitFor(() => expect(screen.getByRole('option', { name: 'B' })).toHaveFocus());
    await user.keyboard('{Enter}');
    raf.mockRestore();
    expect(frames.length).toBeGreaterThan(0);
    act(() => frames.forEach((cb) => cb(0)));
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveFocus();
  });

  it('with no snippets: an empty state and New snippet', async () => {
    const { user, last } = setup(null);
    expect(screen.getByTestId('snippets-empty')).toHaveTextContent('no snippets yet');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Export…' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'New snippet' }));
    expect(last()).toEqual([{ name: 'New snippet', gen: '' }]);
    expect(screen.getByTestId('snippet-body-warning')).toHaveTextContent('An empty snippet isn’t listed');
  });

  it("lists user themes' snippets read-only and copies one into the brew's", async () => {
    const { user, last } = setup(STORED, {
      themeSnippets: ['V3_5ePHB', { name: 'My Theme', snippets: '\\snippet Loot\nTheme loot\n\\snippet Banner\n# Hi\n' }],
    });
    const section = screen.getByTestId('theme-snippets');
    const theme = within(section).getByRole('group', { name: 'Theme My Theme' });
    expect(within(theme).getAllByTestId('theme-snippet').map((d) => d.querySelector('summary')!.textContent)).toEqual(['Loot', 'Banner']);
    // Not editable: no text fields in the section.
    expect(within(section).queryByRole('textbox')).toBeNull();
    await user.click(within(theme).getByText('Loot'));
    await user.click(within(theme).getAllByRole('button', { name: 'Copy to brew snippets' })[0]!);
    // Copied after the selected snippet, under the brew title's submenu (the Tables one's name is
    // in another submenu, so it stays "Loot").
    expect(last()).toEqual([STORED[0], { name: 'Loot', gen: 'Theme loot' }, STORED[1]]);
    expect(options()).toEqual(['Loot', 'Loot', 'Tavern note']);
    // Copied again: renamed to stay unique in its submenu.
    await user.click(within(theme).getAllByRole('button', { name: 'Copy to brew snippets' })[0]!);
    expect(options()).toEqual(['Loot', 'Loot', 'Loot 2', 'Tavern note']);
    expect(screen.getByTestId('snippets-notice')).toHaveTextContent('Copied “Loot” from My Theme');
  });

  it('read-only: nothing can be changed', async () => {
    const { user, onChange } = setup(STORED, { readOnly: true });
    expect(screen.getByRole('button', { name: 'New snippet' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(bodyView().state.readOnly).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('import and export', () => {
  it('imports pasted text after the snippets, then replaces them; one undo step each', async () => {
    const { user, store } = setup();
    await user.click(screen.getByRole('button', { name: 'Import…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import snippets' });
    const text = within(dialog).getByRole('textbox', { name: 'Snippet text' });
    expect(text).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Add snippets' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(text, { target: { value: 'intro\n\\snippet Maps › Keep\n## Keep\n\\snippet Cave\n## Cave\n' } });
    expect(within(dialog).getByTestId('snippets-import-summary')).toHaveTextContent(
      'Found 2 snippets: Keep, Cave. Text before the first \\snippet line is left out.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add 2 snippets' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(options()).toEqual(['Loot', 'Tavern note', 'Cave', 'Keep']);
    expect(store.getSnapshot().snippets.map((s) => [s.group, s.name])).toEqual([
      ['Tables', 'Loot'],
      ['', 'Tavern note'],
      ['Maps', 'Keep'],
      ['', 'Cave'],
    ]);
    expect(screen.getByTestId('snippets-notice')).toHaveTextContent('Imported 2 snippets.');

    await user.click(screen.getByRole('button', { name: 'Import…' }));
    const again = await screen.findByRole('dialog', { name: 'Import snippets' });
    fireEvent.change(within(again).getByRole('textbox', { name: 'Snippet text' }), { target: { value: '\\snippet Only\nx' } });
    await user.click(within(again).getByRole('button', { name: 'Replace all' }));
    expect(options()).toEqual(['Only']);
    act(() => void store.undo());
    expect(options()).toEqual(['Loot', 'Tavern note', 'Cave', 'Keep']);
  });

  it('reads a text file', async () => {
    const { user } = setup(null);
    await user.click(screen.getByRole('button', { name: 'Import…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import snippets' });
    const file = new File(['\\snippet From file\nbody\n'], 'snips.txt', { type: 'text/plain' });
    await user.upload(within(dialog).getByLabelText('Or open a text file'), file);
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Snippet text' })).toHaveValue('\\snippet From file\nbody\n'));
    await user.click(within(dialog).getByRole('button', { name: 'Add 1 snippet' }));
    expect(options()).toEqual(['From file']);
  });

  it('refuses an import that would pass the size limit', async () => {
    const store = new SnippetsEditorStore(null, { maxSize: 30 });
    const user = userEvent.setup();
    render(<SnippetsEditor store={store} brewTitle="T" />);
    await user.click(screen.getByRole('button', { name: 'Import…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import snippets' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Snippet text' }), { target: { value: `\\snippet Big\n${'x'.repeat(40)}` } });
    await user.click(within(dialog).getByRole('button', { name: 'Add 1 snippet' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('larger than 2 MB');
    expect(store.getSnapshot().snippets).toHaveLength(0);
  });

  it('exports the text form (groups before names), to copy', async () => {
    const { user } = setup([...STORED, { name: '', gen: 'unnamed' }]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export snippets' });
    const expected = '\\snippet Tables › Loot\n|a|b|\n\\snippet Tavern note\n{{note\n##### The Pony\n}}\n';
    expect(within(dialog).getByRole('textbox', { name: 'Snippet text' })).toHaveValue(expected);
    expect(within(dialog).getByTestId('snippets-export-status')).toHaveTextContent('1 snippet without a name is left out.');
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(within(dialog).getByTestId('snippets-export-status')).toHaveTextContent('Copied to the clipboard.');
    expect(exportFileName('The Pony’s Brew!')).toBe('the-ponys-brew-snippets.txt');
    expect(exportFileName('✓')).toBe('brew-snippets.txt');
  });
});

function PageHarness({ initial, panel }: { initial: unknown; panel: ReturnType<typeof createSnippetsPanelStore> }) {
  const [snippets, setSnippets] = useState<unknown>(initial);
  const store = useSnippetsEditor(snippets, setSnippets);
  return (
    <UiRoot colorScheme="light">
      <SnippetsToggle panel={panel} />
      <SnippetsPanel store={store} brewTitle="Brew" panel={panel} />
      <output data-testid="value">{JSON.stringify(snippets)}</output>
      <button type="button" onClick={() => setSnippets([{ name: 'Loaded', gen: 'l' }])}>
        load
      </button>
    </UiRoot>
  );
}

describe('SnippetsPanel and useSnippetsEditor', () => {
  it('opens from its toggle, reports edits to the page, and follows a loaded value', async () => {
    const storage = new Map<string, string>();
    const panel = createSnippetsPanelStore({
      storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
      compactMedia: null,
    });
    const user = userEvent.setup();
    render(<PageHarness initial={[{ name: 'A', gen: 'a' }]} panel={panel} />);
    const toggle = screen.getByRole('button', { name: 'Snippets' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('complementary', { name: 'Snippets' });
    expect(toggle).toHaveAttribute('aria-controls', region.id);
    expect(JSON.parse(storage.get('hb-snippets-panel')!)).toMatchObject({ open: true });

    await user.type(within(region).getByRole('textbox', { name: /^Name/ }), 'BC');
    // Reported at the end of the report window (the page doesn't re-render per keystroke).
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[{"name":"ABC","gen":"a"}]'));
    // The page's value is the store's own: the history stays.
    expect(within(region).getByRole('button', { name: 'Undo snippet edit' })).toHaveAttribute('aria-disabled', 'false');

    // The saved version loaded again: the list follows and the history starts over.
    await user.click(screen.getByRole('button', { name: 'load' }));
    expect(within(region).getByRole('textbox', { name: /^Name/ })).toHaveValue('Loaded');
    expect(within(region).getByRole('button', { name: 'Undo snippet edit' })).toHaveAttribute('aria-disabled', 'true');

    // Closing keeps the store (and its history) for the next opening.
    await user.click(within(region).getByRole('button', { name: 'Close snippets panel' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    await user.click(toggle);
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Loaded');
  });
});

describe('useSnippetsEditor reporting', () => {
  function Hook({ value, onChange, reportMs, grab }: { value: unknown; onChange: (v: unknown) => void; reportMs?: number; grab: (s: SnippetsEditorStore) => void }) {
    grab(useSnippetsEditor(value, onChange, reportMs));
    return null;
  }

  it('reports the latest value at most once per window, and what is pending on unmount', () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      let store!: SnippetsEditorStore;
      const view = render(<Hook value={null} onChange={onChange} grab={(s) => (store = s)} />);
      const key = store.add({ group: '', name: 'A', gen: 'a' })!;
      store.update(key, 'name', 'AB');
      store.update(key, 'name', 'ABC');
      expect(onChange).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(SNIPPETS_REPORT_MS));
      expect(onChange).toHaveBeenCalledTimes(1);
      // The same object as value() (what autosave reads): the store recognises it on sync.
      expect(onChange.mock.calls[0]![0]).toBe(store.value());
      expect(store.value()).toEqual([{ name: 'ABC', gen: 'a' }]);

      store.update(key, 'gen', 'x');
      view.unmount();
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange.mock.calls[1]![0]).toEqual([{ name: 'ABC', gen: 'x' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reportMs 0 reports every change at once', () => {
    const onChange = vi.fn();
    let store!: SnippetsEditorStore;
    render(<Hook value={null} onChange={onChange} reportMs={0} grab={(s) => (store = s)} />);
    store.add({ group: '', name: 'A', gen: 'a' });
    expect(onChange).toHaveBeenCalledWith([{ name: 'A', gen: 'a' }]);
  });
});
