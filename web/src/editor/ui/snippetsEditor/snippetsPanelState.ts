// Open state and width of the Snippets panel, kept like the UI store's panels (web/src/app/uiStore.ts)
// without adding a panel id there: the width and the wide-screen open state persist in
// localStorage ('hb-snippets-panel'; per viewer, failures ignored). On compact screens
// (COMPACT_MEDIA_QUERY) it follows the UI store's rule of one side panel at a time: it starts
// closed, opening it closes the store's panels and opening one of those closes it, and what is
// opened there is not stored.
import { useSyncExternalStore } from 'react';
import { COMPACT_MEDIA_QUERY, type CompactMedia, compactMediaQuery, PANEL_IDS, uiStore, type UiStoreApi } from '@/app/uiStore';

export interface SnippetsPanelState {
  open: boolean;
  /** Width in px. */
  size: number;
}

export const SNIPPETS_PANEL_STORAGE_KEY = 'hb-snippets-panel';
/** Id of the panel element (the toggle's aria-controls while it is open). */
export const SNIPPETS_PANEL_ID = 'hb-snippets-panel';
export const SNIPPETS_PANEL_LIMITS = { min: 260, max: 900 } as const;
export const DEFAULT_SNIPPETS_PANEL: SnippetsPanelState = { open: false, size: 380 };
export { COMPACT_MEDIA_QUERY };

/** The storage the panel state uses (a subset of Storage). */
export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SnippetsPanelStoreApi {
  getState: () => SnippetsPanelState;
  subscribe: (listener: () => void) => () => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setSize: (size: number) => void;
}

export interface CreateSnippetsPanelStoreOptions {
  storage?: PanelStorage | null;
  compactMedia?: CompactMedia | null;
  ui?: UiStoreApi;
}

const clampSize = (size: number): number =>
  Number.isFinite(size) ? Math.round(Math.min(SNIPPETS_PANEL_LIMITS.max, Math.max(SNIPPETS_PANEL_LIMITS.min, size))) : DEFAULT_SNIPPETS_PANEL.size;

function defaultStorage(): PanelStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(storage: PanelStorage | null): SnippetsPanelState {
  try {
    const raw = JSON.parse(storage?.getItem(SNIPPETS_PANEL_STORAGE_KEY) ?? 'null') as unknown;
    if (raw === null || typeof raw !== 'object') return DEFAULT_SNIPPETS_PANEL;
    const { open, size } = raw as Record<string, unknown>;
    return {
      open: typeof open === 'boolean' ? open : DEFAULT_SNIPPETS_PANEL.open,
      size: typeof size === 'number' ? clampSize(size) : DEFAULT_SNIPPETS_PANEL.size,
    };
  } catch {
    return DEFAULT_SNIPPETS_PANEL;
  }
}

export function createSnippetsPanelStore({
  storage = defaultStorage(),
  compactMedia = compactMediaQuery(),
  ui = uiStore,
}: CreateSnippetsPanelStoreOptions = {}): SnippetsPanelStoreApi {
  let compact = compactMedia?.matches ?? false;
  const stored = read(storage);
  // The wide-screen preference (what is stored); compact screens don't change it.
  let preferred = stored.open;
  let state: SnippetsPanelState = { open: compact ? false : stored.open, size: stored.size };
  const listeners = new Set<() => void>();

  const save = () => {
    try {
      storage?.setItem(SNIPPETS_PANEL_STORAGE_KEY, JSON.stringify({ open: preferred, size: state.size }));
    } catch {
      // Quota or blocked storage: keep going in memory.
    }
  };
  const set = (next: SnippetsPanelState) => {
    if (next.open === state.open && next.size === state.size) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const anyUiPanelOpen = () => PANEL_IDS.some((id) => ui.getState().panels[id].open);

  const setOpen = (open: boolean) => {
    if (compact && open) {
      // One side panel at a time: close the store's first (its listener below then sees them closed).
      for (const id of PANEL_IDS) if (ui.getState().panels[id].open) ui.getState().setPanelOpen(id, false);
    }
    if (!compact) {
      preferred = open;
      save();
    }
    set({ ...state, open });
  };

  ui.subscribe(() => {
    if (compact && state.open && anyUiPanelOpen()) set({ ...state, open: false });
  });
  compactMedia?.addEventListener?.('change', (event) => {
    if (event.matches === compact) return;
    compact = event.matches;
    set({ ...state, open: compact ? false : preferred });
  });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOpen,
    toggle: () => setOpen(!state.open),
    setSize: (size) => {
      set({ ...state, size: clampSize(size) });
      save();
    },
  };
}

/** The app's Snippets panel state. */
export const snippetsPanelStore: SnippetsPanelStoreApi = createSnippetsPanelStore();

/** The panel state and its actions (the app's store by default). */
export function useSnippetsPanel(store: SnippetsPanelStoreApi = snippetsPanelStore): SnippetsPanelState & Omit<SnippetsPanelStoreApi, 'getState' | 'subscribe'> {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { ...state, setOpen: store.setOpen, toggle: store.toggle, setSize: store.setSize };
}
