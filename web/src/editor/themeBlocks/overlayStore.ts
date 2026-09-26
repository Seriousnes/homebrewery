// State of the theme-block label overlay (plan §6.4): which block the selection is in, whether
// the overlay shows, and requests to move focus into it. The plugin (overlay.ts) writes it, the
// React component (nodeviews/ThemeBlockView.tsx) reads it with useSyncExternalStore.

export interface ActiveThemeBlock {
  /** Position of the themeBlock node. */
  pos: number;
  /** Its element (div.block…, the NodeView's dom). */
  element: HTMLElement;
  classes: string[];
  label: string;
  frameable: boolean;
}

export interface ThemeBlockOverlayState {
  block: ActiveThemeBlock | null;
  visible: boolean;
  /** Increments on every document or selection change (re-position). */
  version: number;
  /** Increments when focus should move into the controls (Shift+Alt+F10). */
  focusRequest: number;
}

export type ThemeBlockOverlayListener = () => void;

export class ThemeBlockOverlayStore {
  private state: ThemeBlockOverlayState = { block: null, visible: false, version: 0, focusRequest: 0 };
  private readonly listeners = new Set<ThemeBlockOverlayListener>();

  readonly subscribe = (listener: ThemeBlockOverlayListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ThemeBlockOverlayState => this.state;

  /** Updates the state; `notify: false` skips the listeners (nothing they show changed). */
  set(next: Partial<ThemeBlockOverlayState>, notify = true): void {
    this.state = { ...this.state, ...next };
    if (notify) for (const listener of [...this.listeners]) listener();
  }
}

/** What the controls can do. */
export interface ThemeBlockOverlayActions {
  toggle(cls: 'wide' | 'frame'): void;
  /** Focus back to the editor (Escape). */
  returnFocus(): void;
  /** Focus entered or left the controls. */
  setFocused(focused: boolean): void;
}
