import { describe, expect, it } from 'vitest';
import { createUiStore } from '@/app/uiStore';
import { createSnippetsPanelStore, DEFAULT_SNIPPETS_PANEL, SNIPPETS_PANEL_LIMITS, SNIPPETS_PANEL_STORAGE_KEY } from './snippetsPanelState';

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function media(matches: boolean) {
  let listener: ((event: { matches: boolean }) => void) | null = null;
  return {
    matches,
    addEventListener: (_type: 'change', l: (event: { matches: boolean }) => void) => {
      listener = l;
    },
    change(next: boolean) {
      this.matches = next;
      listener?.({ matches: next });
    },
  };
}

describe('Snippets panel state', () => {
  it('stores the open state and width (clamped), and reads them back; bad data is ignored', () => {
    const storage = memory();
    const ui = createUiStore({ storage: memory(), compactMedia: null });
    const panel = createSnippetsPanelStore({ storage, compactMedia: null, ui });
    expect(panel.getState()).toEqual(DEFAULT_SNIPPETS_PANEL);
    panel.toggle();
    panel.setSize(5000);
    expect(panel.getState()).toEqual({ open: true, size: SNIPPETS_PANEL_LIMITS.max });
    expect(JSON.parse(storage.map.get(SNIPPETS_PANEL_STORAGE_KEY)!)).toEqual({ open: true, size: SNIPPETS_PANEL_LIMITS.max });
    expect(createSnippetsPanelStore({ storage, compactMedia: null, ui }).getState()).toEqual({ open: true, size: SNIPPETS_PANEL_LIMITS.max });
    for (const junk of ['{', '"x"', '{"open":"yes","size":"big"}']) {
      expect(createSnippetsPanelStore({ storage: memory({ [SNIPPETS_PANEL_STORAGE_KEY]: junk }), compactMedia: null, ui }).getState()).toEqual(DEFAULT_SNIPPETS_PANEL);
    }
    // Storage that throws: works in memory.
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const p = createSnippetsPanelStore({ storage: throwing, compactMedia: null, ui });
    p.setOpen(true);
    expect(p.getState().open).toBe(true);
  });

  it('compact screens: starts closed, one side panel at a time, nothing stored', () => {
    const storage = memory({ [SNIPPETS_PANEL_STORAGE_KEY]: JSON.stringify({ open: true, size: 400 }) });
    const compact = media(true);
    const ui = createUiStore({ storage: memory(), compactMedia: compact });
    const panel = createSnippetsPanelStore({ storage, compactMedia: compact, ui });
    expect(panel.getState().open).toBe(false);

    ui.getState().setPanelOpen('style', true);
    panel.setOpen(true);
    // Opening it closed the store's panel …
    expect(ui.getState().panels.style.open).toBe(false);
    expect(panel.getState().open).toBe(true);
    // … and opening one of those closes it.
    ui.getState().setPanelOpen('inspector', true);
    expect(panel.getState().open).toBe(false);
    panel.setOpen(true);
    panel.setOpen(false);
    // The wide-screen preference was not changed.
    expect(JSON.parse(storage.map.get(SNIPPETS_PANEL_STORAGE_KEY)!)).toMatchObject({ open: true });

    // Back to a wide screen: the preference again.
    compact.change(false);
    expect(panel.getState().open).toBe(true);
    compact.change(true);
    expect(panel.getState().open).toBe(false);
  });
});
