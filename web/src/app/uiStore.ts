// UI state that outlives a page (plan §9): canvas zoom and spread, and the editor's side panels.
// zustand + persist in localStorage under 'hb-ui' (versioned). Storage failures (private mode,
// quota, blocked storage, corrupt JSON) never throw: the store falls back to defaults in memory.
// Replaces upstream's HB_renderer_toolbarState, which is imported once when 'hb-ui' is absent.
// Compact screens (phones, COMPACT_MEDIA_QUERY): the side panels start closed and open one at a
// time, and what is opened there is not stored: the stored open/closed state stays the
// wide-screen preference, which comes back when the screen gets wider.
import { useStore } from 'zustand';
import { createJSONStorage, persist, type PersistStorage, type StateStorage } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

export type Spread = 'single' | 'facing' | 'flow';
export type PanelId = 'outline' | 'inspector' | 'style';

export interface PanelState {
  open: boolean;
  /** px: width of a side panel, height of a bottom one. */
  size: number;
}

export interface UiState {
  /** Canvas scale (1 = 100 %). */
  zoom: number;
  spread: Spread;
  /** Facing spread: the first page is a right-hand (recto) page. */
  startOnRight: boolean;
  pageShadows: boolean;
  panels: Record<PanelId, PanelState>;
  /** The inspector's selected tab id (the inspector lane defines the ids). */
  inspectorTab: string;
}

export interface UiActions {
  setZoom: (zoom: number) => void;
  /** Next level up in ZOOM_LEVELS. */
  zoomIn: () => void;
  /** Next level down in ZOOM_LEVELS. */
  zoomOut: () => void;
  setSpread: (spread: Spread) => void;
  setStartOnRight: (startOnRight: boolean) => void;
  setPageShadows: (pageShadows: boolean) => void;
  setPanelOpen: (panel: PanelId, open: boolean) => void;
  togglePanel: (panel: PanelId) => void;
  setPanelSize: (panel: PanelId, size: number) => void;
  setInspectorTab: (tab: string) => void;
  /** Back to DEFAULT_UI_STATE (persisted too). */
  resetUi: () => void;
}

export type UiStore = UiState & UiActions;

export const UI_STORAGE_KEY = 'hb-ui';
export const UI_STORAGE_VERSION = 1;
/** Upstream's key: {zoomLevel (percent), spread, startOnRight, pageShadows, …}. */
export const LEGACY_TOOLBAR_KEY = 'HB_renderer_toolbarState';

/** Upstream's zoom range was 10-300 %. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
export const ZOOM_LEVELS: readonly number[] = [0.1, 0.25, 0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const SPREADS: readonly Spread[] = ['single', 'facing', 'flow'];
export const PANEL_IDS: readonly PanelId[] = ['outline', 'inspector', 'style'];

/** Size limits per panel, px. */
export const PANEL_LIMITS: Readonly<Record<PanelId, { min: number; max: number }>> = {
  outline: { min: 160, max: 480 },
  inspector: { min: 240, max: 560 },
  style: { min: 240, max: 900 },
};

export const DEFAULT_UI_STATE: UiState = {
  zoom: 1,
  spread: 'single',
  startOnRight: true,
  pageShadows: true,
  panels: {
    outline: { open: false, size: 240 },
    inspector: { open: true, size: 300 },
    style: { open: false, size: 420 },
  },
  inspectorTab: 'node',
};

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return DEFAULT_UI_STATE.zoom;
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 1000) / 1000;
}

export function clampPanelSize(panel: PanelId, size: number): number {
  const { min, max } = PANEL_LIMITS[panel];
  if (!Number.isFinite(size)) return DEFAULT_UI_STATE.panels[panel].size;
  return Math.round(Math.min(max, Math.max(min, size)));
}

/** The next zoom level above (dir 1) or below (dir -1) `zoom`. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const current = clampZoom(zoom);
  const epsilon = 1e-6;
  const next = dir > 0 ? ZOOM_LEVELS.find((z) => z > current + epsilon) : [...ZOOM_LEVELS].reverse().find((z) => z < current - epsilon);
  return next ?? current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validated UI state from anything read back from storage: bad fields fall back to defaults. */
export function sanitizeUiState(value: unknown): UiState {
  const input = isRecord(value) ? value : {};
  const panelsIn = isRecord(input.panels) ? input.panels : {};
  const panels = {} as Record<PanelId, PanelState>;
  for (const id of PANEL_IDS) {
    const raw = isRecord(panelsIn[id]) ? panelsIn[id] : {};
    const fallback = DEFAULT_UI_STATE.panels[id];
    panels[id] = {
      open: typeof raw.open === 'boolean' ? raw.open : fallback.open,
      size: typeof raw.size === 'number' ? clampPanelSize(id, raw.size) : fallback.size,
    };
  }
  return {
    zoom: typeof input.zoom === 'number' ? clampZoom(input.zoom) : DEFAULT_UI_STATE.zoom,
    spread: SPREADS.includes(input.spread as Spread) ? (input.spread as Spread) : DEFAULT_UI_STATE.spread,
    startOnRight: typeof input.startOnRight === 'boolean' ? input.startOnRight : DEFAULT_UI_STATE.startOnRight,
    pageShadows: typeof input.pageShadows === 'boolean' ? input.pageShadows : DEFAULT_UI_STATE.pageShadows,
    panels,
    inspectorTab:
      typeof input.inspectorTab === 'string' && input.inspectorTab.length > 0 && input.inspectorTab.length <= 64
        ? input.inspectorTab
        : DEFAULT_UI_STATE.inspectorTab,
  };
}

/** Upstream's HB_renderer_toolbarState as a partial UI state (zoomLevel is in percent). */
export function fromLegacyToolbarState(value: unknown): Partial<UiState> {
  if (!isRecord(value)) return {};
  const out: Partial<UiState> = {};
  if (typeof value.zoomLevel === 'number') out.zoom = clampZoom(value.zoomLevel / 100);
  if (SPREADS.includes(value.spread as Spread)) out.spread = value.spread as Spread;
  if (typeof value.startOnRight === 'boolean') out.startOnRight = value.startOnRight;
  if (typeof value.pageShadows === 'boolean') out.pageShadows = value.pageShadows;
  return out;
}

/** localStorage that never throws (every access can fail: disabled storage, quota, sandboxing). */
export function safeLocalStorage(): StateStorage {
  const storage = (): Storage | null => {
    try {
      return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      return null;
    }
  };
  return {
    getItem: (name) => {
      try {
        const own = storage()?.getItem(name) ?? null;
        if (own !== null || name !== UI_STORAGE_KEY) return own;
        // First run: carry over upstream's toolbar settings.
        const legacy = storage()?.getItem(LEGACY_TOOLBAR_KEY);
        if (!legacy) return null;
        const state = { ...DEFAULT_UI_STATE, ...fromLegacyToolbarState(JSON.parse(legacy)) };
        return JSON.stringify({ state, version: UI_STORAGE_VERSION });
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        storage()?.setItem(name, value);
      } catch {
        // Quota or blocked storage: keep going in memory.
      }
    },
    removeItem: (name) => {
      try {
        storage()?.removeItem(name);
      } catch {
        // Ignore.
      }
    },
  };
}

/** Parse failures of stored JSON become "nothing stored". */
function uiPersistStorage(base: StateStorage): PersistStorage<UiState> | undefined {
  const json = createJSONStorage<UiState>(() => base);
  if (!json) return undefined;
  return {
    getItem: (name) => {
      try {
        return json.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => json.setItem(name, value),
    removeItem: (name) => json.removeItem(name),
  };
}

function pickState(state: UiState): UiState {
  return {
    zoom: state.zoom,
    spread: state.spread,
    startOnRight: state.startOnRight,
    pageShadows: state.pageShadows,
    panels: state.panels,
    inspectorTab: state.inspectorTab,
  };
}

/** Screens this narrow get the compact panel behaviour (see the top of the file). */
export const COMPACT_MEDIA_QUERY = '(max-width: 720px)';

/** The part of a MediaQueryList the store uses. */
export interface CompactMedia {
  readonly matches: boolean;
  addEventListener?: (type: 'change', listener: (event: { matches: boolean }) => void) => void;
}

/** window.matchMedia(COMPACT_MEDIA_QUERY), or null where there is none (jsdom, old browsers). */
export function compactMediaQuery(): CompactMedia | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_MEDIA_QUERY) : null;
  } catch {
    return null;
  }
}

type PanelFlags = Record<PanelId, boolean>;

const openFlags = (panels: Record<PanelId, PanelState>): PanelFlags => ({
  outline: panels.outline.open,
  inspector: panels.inspector.open,
  style: panels.style.open,
});

const withOpen = (panels: Record<PanelId, PanelState>, flags: PanelFlags): Record<PanelId, PanelState> => ({
  outline: { ...panels.outline, open: flags.outline },
  inspector: { ...panels.inspector, open: flags.inspector },
  style: { ...panels.style, open: flags.style },
});

const NONE_OPEN: PanelFlags = { outline: false, inspector: false, style: false };

export interface CreateUiStoreOptions {
  /** Default: safeLocalStorage(). */
  storage?: StateStorage;
  /** Default UI_STORAGE_KEY. */
  name?: string;
  /** The compact-screen query (default compactMediaQuery(); null: never compact). */
  compactMedia?: CompactMedia | null;
}

/** A UI store (the app uses the `uiStore` singleton; tests make their own). */
export function createUiStore({ storage = safeLocalStorage(), name = UI_STORAGE_KEY, compactMedia = compactMediaQuery() }: CreateUiStoreOptions = {}) {
  let compact = compactMedia?.matches ?? false;
  // The open/closed state to store: the wide-screen preference (compact screens don't change it).
  let preferred = openFlags(DEFAULT_UI_STATE.panels);
  const shown = (panels: Record<PanelId, PanelState>) => withOpen(panels, compact ? NONE_OPEN : preferred);

  const store = createStore<UiStore>()(
    persist(
      (set) => {
        const setPanel = (panel: PanelId, patch: Partial<PanelState>) =>
          set((state) => ({ panels: { ...state.panels, [panel]: { ...state.panels[panel], ...patch } } }));
        const setOpen = (panel: PanelId, open: (current: boolean) => boolean) =>
          set((state) => {
            const next = open(state.panels[panel].open);
            // Compact: one side panel at a time, and nothing is stored.
            const flags = compact ? { ...NONE_OPEN, [panel]: next } : { ...openFlags(state.panels), [panel]: next };
            if (!compact) preferred = flags;
            return { panels: withOpen(state.panels, flags) };
          });
        return {
          ...DEFAULT_UI_STATE,
          panels: shown(DEFAULT_UI_STATE.panels),
          setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
          zoomIn: () => set((state) => ({ zoom: stepZoom(state.zoom, 1) })),
          zoomOut: () => set((state) => ({ zoom: stepZoom(state.zoom, -1) })),
          setSpread: (spread) => set({ spread: SPREADS.includes(spread) ? spread : DEFAULT_UI_STATE.spread }),
          setStartOnRight: (startOnRight) => set({ startOnRight }),
          setPageShadows: (pageShadows) => set({ pageShadows }),
          setPanelOpen: (panel, open) => setOpen(panel, () => open),
          togglePanel: (panel) => setOpen(panel, (open) => !open),
          setPanelSize: (panel, size) => setPanel(panel, { size: clampPanelSize(panel, size) }),
          setInspectorTab: (tab) => set({ inspectorTab: tab }),
          resetUi: () => {
            preferred = openFlags(DEFAULT_UI_STATE.panels);
            set({ ...pickState(DEFAULT_UI_STATE), panels: shown(DEFAULT_UI_STATE.panels) });
          },
        };
      },
      {
        name,
        version: UI_STORAGE_VERSION,
        storage: uiPersistStorage(storage),
        partialize: (state) => ({ ...pickState(state), panels: withOpen(state.panels, preferred) }),
        // Older (or future-unknown) shapes: keep whatever still validates.
        migrate: (persisted) => sanitizeUiState(persisted),
        merge: (persisted, current) => {
          const stored = sanitizeUiState(persisted);
          preferred = openFlags(stored.panels);
          return { ...current, ...stored, panels: shown(stored.panels) };
        },
      },
    ),
  );

  // The screen crossed the breakpoint (a rotation, a resized window).
  compactMedia?.addEventListener?.('change', (event) => {
    if (event.matches === compact) return;
    compact = event.matches;
    store.setState((state) => ({ panels: shown(state.panels) }));
  });
  return store;
}

export type UiStoreApi = ReturnType<typeof createUiStore>;

/** The app's UI store. */
export const uiStore: UiStoreApi = createUiStore();

/** Select from the UI store, e.g. `const zoom = useUiStore((s) => s.zoom)`. */
export function useUiStore<T>(selector: (state: UiStore) => T): T {
  return useStore(uiStore, selector);
}
