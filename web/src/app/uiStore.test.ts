import { afterEach, describe, expect, it } from 'vitest';
import type { StateStorage } from 'zustand/middleware';
import {
  clampPanelSize,
  clampZoom,
  createUiStore,
  DEFAULT_UI_STATE,
  fromLegacyToolbarState,
  LEGACY_TOOLBAR_KEY,
  PANEL_LIMITS,
  safeLocalStorage,
  sanitizeUiState,
  stepZoom,
  UI_STORAGE_KEY,
  UI_STORAGE_VERSION,
  uiStore,
} from './uiStore';

function memoryStorage(initial: Record<string, string> = {}): StateStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (name) => data[name] ?? null,
    setItem: (name, value) => {
      data[name] = value;
    },
    removeItem: (name) => {
      delete data[name];
    },
  };
}

afterEach(() => {
  localStorage.clear();
});

describe('uiStore state and actions', () => {
  it('starts from the defaults', () => {
    const store = createUiStore({ storage: memoryStorage() });
    const { zoom, spread, startOnRight, pageShadows, panels, inspectorTab } = store.getState();
    expect({ zoom, spread, startOnRight, pageShadows, panels, inspectorTab }).toEqual(DEFAULT_UI_STATE);
  });

  it('clamps zoom and steps through the zoom levels', () => {
    const store = createUiStore({ storage: memoryStorage() });
    store.getState().setZoom(10);
    expect(store.getState().zoom).toBe(3);
    store.getState().setZoom(-1);
    expect(store.getState().zoom).toBe(1);
    store.getState().setZoom(Number.NaN);
    expect(store.getState().zoom).toBe(1);
    store.getState().zoomIn();
    expect(store.getState().zoom).toBe(1.1);
    store.getState().setZoom(1.3);
    store.getState().zoomOut();
    expect(store.getState().zoom).toBe(1.25);
    store.getState().setZoom(3);
    store.getState().zoomIn();
    expect(store.getState().zoom).toBe(3);
    store.getState().setZoom(0.1);
    store.getState().zoomOut();
    expect(store.getState().zoom).toBe(0.1);
  });

  it('sets spread, flags, panels and the inspector tab', () => {
    const store = createUiStore({ storage: memoryStorage() });
    const s = () => store.getState();
    s().setSpread('facing');
    s().setSpread('bogus' as 'single');
    expect(s().spread).toBe('single');
    s().setSpread('flow');
    expect(s().spread).toBe('flow');
    s().setStartOnRight(false);
    s().setPageShadows(false);
    expect([s().startOnRight, s().pageShadows]).toEqual([false, false]);
    s().togglePanel('outline');
    expect(s().panels.outline.open).toBe(true);
    s().setPanelOpen('inspector', false);
    expect(s().panels.inspector.open).toBe(false);
    s().setPanelSize('style', 99999);
    expect(s().panels.style.size).toBe(PANEL_LIMITS.style.max);
    s().setPanelSize('outline', 10);
    expect(s().panels.outline.size).toBe(PANEL_LIMITS.outline.min);
    s().setInspectorTab('page');
    expect(s().inspectorTab).toBe('page');
    s().resetUi();
    expect(s().panels).toEqual(DEFAULT_UI_STATE.panels);
    expect(s().spread).toBe('single');
  });
});

describe('uiStore persistence', () => {
  it('persists under hb-ui with a version, and restores it', () => {
    const storage = memoryStorage();
    const store = createUiStore({ storage });
    store.getState().setZoom(1.5);
    store.getState().setPanelSize('inspector', 333);
    const saved = JSON.parse(storage.data[UI_STORAGE_KEY]!) as { state: Record<string, unknown>; version: number };
    expect(saved.version).toBe(UI_STORAGE_VERSION);
    expect(saved.state).toMatchObject({ zoom: 1.5, panels: { inspector: { open: true, size: 333 } } });
    expect(saved.state).not.toHaveProperty('setZoom');

    const again = createUiStore({ storage });
    expect(again.getState().zoom).toBe(1.5);
    expect(again.getState().panels.inspector.size).toBe(333);
  });

  it('ignores corrupt JSON and invalid fields', () => {
    const corrupt = createUiStore({ storage: memoryStorage({ [UI_STORAGE_KEY]: '{not json' }) });
    expect(corrupt.getState().zoom).toBe(1);

    const invalid = createUiStore({
      storage: memoryStorage({
        [UI_STORAGE_KEY]: JSON.stringify({
          version: UI_STORAGE_VERSION,
          state: { zoom: 'big', spread: 'diagonal', startOnRight: 'yes', panels: { outline: { open: true, size: 5000 }, bogus: {} }, inspectorTab: 42 },
        }),
      }),
    });
    const s = invalid.getState();
    expect(s.zoom).toBe(1);
    expect(s.spread).toBe('single');
    expect(s.startOnRight).toBe(true);
    expect(s.panels.outline).toEqual({ open: true, size: PANEL_LIMITS.outline.max });
    expect(s.panels.inspector).toEqual(DEFAULT_UI_STATE.panels.inspector);
    expect(s.inspectorTab).toBe('node');
  });

  it('migrates other versions by keeping what validates', () => {
    const store = createUiStore({
      storage: memoryStorage({ [UI_STORAGE_KEY]: JSON.stringify({ version: 0, state: { zoom: 2, spread: 'facing', extra: true } }) }),
    });
    expect(store.getState().zoom).toBe(2);
    expect(store.getState().spread).toBe('facing');
  });

  it('keeps working when every storage call throws', () => {
    const throwing: StateStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('nope');
      },
    };
    // safeLocalStorage is the layer that swallows these; emulate a broken localStorage through it.
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => throwing });
    try {
      const store = createUiStore({ storage: safeLocalStorage() });
      expect(() => store.getState().setZoom(2)).not.toThrow();
      expect(store.getState().zoom).toBe(2);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('keeps working when localStorage itself cannot be accessed', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      const store = createUiStore();
      store.getState().togglePanel('outline');
      expect(store.getState().panels.outline.open).toBe(true);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('imports upstream HB_renderer_toolbarState once, when hb-ui is absent', () => {
    localStorage.setItem(LEGACY_TOOLBAR_KEY, JSON.stringify({ zoomLevel: 150, spread: 'facing', startOnRight: false, pageShadows: false, rowGap: 5 }));
    const store = createUiStore();
    expect(store.getState()).toMatchObject({ zoom: 1.5, spread: 'facing', startOnRight: false, pageShadows: false });
    store.getState().setZoom(0.5);
    expect(JSON.parse(localStorage.getItem(UI_STORAGE_KEY)!)).toMatchObject({ state: { zoom: 0.5 } });
    // hb-ui now exists, so the legacy value no longer applies.
    expect(createUiStore().getState().zoom).toBe(0.5);
    expect(localStorage.getItem(LEGACY_TOOLBAR_KEY)).not.toBeNull();
  });

  it('the app singleton is a persisted store', () => {
    expect(uiStore.persist.getOptions().name).toBe(UI_STORAGE_KEY);
  });
});

/** A media query list the test drives (the compact breakpoint). */
function fakeMedia(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  return {
    matches,
    addEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    set(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

const storedPanels = (storage: { data: Record<string, string> }) =>
  (JSON.parse(storage.data[UI_STORAGE_KEY] ?? '{}') as { state?: { panels?: Record<string, { open: boolean }> } }).state?.panels;

describe('uiStore on compact screens (phones)', () => {
  it('side panels start closed there, without changing the stored preference', () => {
    const storage = memoryStorage({
      [UI_STORAGE_KEY]: JSON.stringify({ state: { ...DEFAULT_UI_STATE, zoom: 1.5 }, version: UI_STORAGE_VERSION }),
    });
    const store = createUiStore({ storage, compactMedia: fakeMedia(true) });
    const { panels, zoom } = store.getState();
    expect([panels.outline.open, panels.inspector.open, panels.style.open]).toEqual([false, false, false]);
    expect(zoom).toBe(1.5);
    // Other settings are still saved; the panels' open state is the wide-screen preference.
    store.getState().setZoom(2);
    store.getState().togglePanel('outline');
    expect(store.getState().panels.outline.open).toBe(true);
    expect(storedPanels(storage)?.inspector?.open).toBe(true);
    expect(storedPanels(storage)?.outline?.open).toBe(false);
  });

  it('one side panel at a time', () => {
    const store = createUiStore({ storage: memoryStorage(), compactMedia: fakeMedia(true) });
    store.getState().togglePanel('outline');
    store.getState().setPanelOpen('style', true);
    const { panels } = store.getState();
    expect([panels.outline.open, panels.style.open, panels.inspector.open]).toEqual([false, true, false]);
  });

  it('follows the screen: narrower closes the panels, wider brings the preference back', () => {
    const media = fakeMedia(false);
    const storage = memoryStorage();
    const store = createUiStore({ storage, compactMedia: media });
    expect(store.getState().panels.inspector.open).toBe(true);
    store.getState().setPanelOpen('outline', true);
    media.set(true);
    expect(store.getState().panels.inspector.open).toBe(false);
    expect(store.getState().panels.outline.open).toBe(false);
    store.getState().togglePanel('style');
    media.set(false);
    const { panels } = store.getState();
    expect([panels.outline.open, panels.inspector.open, panels.style.open]).toEqual([true, true, false]);
    expect(storedPanels(storage)?.outline?.open).toBe(true);
  });

  it('wide screens keep several panels open and store every change', () => {
    const storage = memoryStorage();
    const store = createUiStore({ storage, compactMedia: fakeMedia(false) });
    store.getState().setPanelOpen('outline', true);
    store.getState().setPanelOpen('style', true);
    const { panels } = store.getState();
    expect([panels.outline.open, panels.inspector.open, panels.style.open]).toEqual([true, true, true]);
    expect(storedPanels(storage)?.style?.open).toBe(true);
  });
});

describe('helpers', () => {
  it('clampZoom, clampPanelSize, stepZoom', () => {
    expect(clampZoom(0.05)).toBe(0.1);
    expect(clampZoom(1.23456)).toBe(1.235);
    expect(clampPanelSize('inspector', Number.POSITIVE_INFINITY)).toBe(DEFAULT_UI_STATE.panels.inspector.size);
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
  });

  it('fromLegacyToolbarState and sanitizeUiState tolerate junk', () => {
    expect(fromLegacyToolbarState(null)).toEqual({});
    expect(fromLegacyToolbarState({ zoomLevel: 5000, spread: 'x' })).toEqual({ zoom: 3 });
    expect(sanitizeUiState('nope')).toEqual(DEFAULT_UI_STATE);
  });
});
