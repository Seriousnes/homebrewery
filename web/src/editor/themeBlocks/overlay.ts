// The plugin behind the theme-block label (plan §6.4): tracks the theme block around the
// selection, shows the controls (nodeviews/ThemeBlockView.tsx) while the editor or the controls
// have focus, and applies the toggles. The controls get their own React root, created on first
// use (never during a dispatch) and unmounted after the editor is destroyed.
import type { EditorView } from '@tiptap/pm/view';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeBlockControls } from '../nodeviews/ThemeBlockView';
import { activeThemeBlockPos, blockClasses, toggleThemeBlockClassTr } from './commands';
import { canFrame, themeBlockLabel } from './labels';
import { ThemeBlockOverlayStore, type ActiveThemeBlock, type ThemeBlockOverlayActions } from './overlayStore';

export const themeBlockOverlayKey = new PluginKey('hbThemeBlockOverlay');

const controllers = new WeakMap<EditorView, ThemeBlockOverlay>();

export class ThemeBlockOverlay {
  readonly store = new ThemeBlockOverlayStore();
  private readonly view: EditorView;
  private root: Root | null = null;
  private container: HTMLElement | null = null;
  private controlsFocused = false;
  private destroyed = false;
  private mountScheduled = false;

  constructor(view: EditorView) {
    this.view = view;
    controllers.set(view, this);
    this.refresh();
  }

  readonly actions: ThemeBlockOverlayActions = {
    toggle: (cls) => {
      const pos = this.store.getSnapshot().block?.pos;
      if (pos === undefined || this.view.isDestroyed) return;
      const tr = toggleThemeBlockClassTr(this.view.state, pos, cls);
      if (tr) this.view.dispatch(tr);
    },
    returnFocus: () => {
      this.controlsFocused = false;
      if (!this.view.isDestroyed) this.view.focus();
      this.refresh();
    },
    setFocused: (focused) => {
      this.controlsFocused = focused;
      // Focus moving between the editor and the controls fires blur before focus: decide later.
      setTimeout(() => this.refresh(), 0);
    },
  };

  /** Recomputes the active block and visibility from the view. */
  refresh(): void {
    if (this.destroyed || this.view.isDestroyed) return;
    const { view } = this;
    const pos = activeThemeBlockPos(view.state);
    let block: ActiveThemeBlock | null = null;
    if (pos !== null) {
      const node = view.state.doc.nodeAt(pos);
      let element: Node | null;
      try {
        element = view.nodeDOM(pos);
      } catch {
        element = null;
      }
      if (node && element instanceof HTMLElement) {
        const classes = blockClasses(node);
        block = { pos, element, classes, label: themeBlockLabel(classes), frameable: canFrame(classes) };
      }
    }
    const focused = this.controlsFocused || view.hasFocus();
    const visible = view.editable && block !== null && focused && view.dom.isConnected;
    const prev = this.store.getSnapshot();
    // While hidden, the controls render nothing: no re-render on every keystroke.
    this.store.set({ block, visible, version: prev.version + 1 }, visible || prev.visible);
    if (visible) this.ensureMounted();
  }

  /** Moves focus into the controls (Shift+Alt+F10). Returns false when no block is active. */
  focusControls(): boolean {
    if (this.store.getSnapshot().block === null) return false;
    this.controlsFocused = true;
    this.refresh();
    this.store.set({ focusRequest: this.store.getSnapshot().focusRequest + 1 });
    return true;
  }

  private ensureMounted(): void {
    if (this.root || this.mountScheduled || typeof document === 'undefined') return;
    this.mountScheduled = true;
    queueMicrotask(() => {
      this.mountScheduled = false;
      if (this.destroyed || this.root) return;
      this.container = document.createElement('div');
      this.container.setAttribute('data-hb-theme-block-overlay', '');
      this.root = createRoot(this.container);
      this.root.render(createElement(ThemeBlockControls, { store: this.store, actions: this.actions }));
    });
  }

  destroy(): void {
    this.destroyed = true;
    controllers.delete(this.view);
    this.store.set({ block: null, visible: false });
    const root = this.root;
    this.root = null;
    // Not synchronously: the editor may be destroyed while React commits.
    if (root) setTimeout(() => root.unmount(), 0);
  }
}

/** The overlay of an editor view (tests, dev pages). */
export const themeBlockOverlayOf = (view: EditorView): ThemeBlockOverlay | undefined => controllers.get(view);

/** Moves focus to the theme-block controls of `view` (the Shift+Alt+F10 shortcut). */
export function focusThemeBlockControls(view: EditorView): boolean {
  return controllers.get(view)?.focusControls() ?? false;
}

export function themeBlockOverlayPlugin(): Plugin {
  return new Plugin({
    key: themeBlockOverlayKey,
    view: (view) => {
      const overlay = new ThemeBlockOverlay(view);
      return {
        update: () => overlay.refresh(),
        destroy: () => overlay.destroy(),
      };
    },
    props: {
      handleDOMEvents: {
        focus: (view) => {
          controllers.get(view)?.refresh();
          return false;
        },
        blur: (view) => {
          // Focus may be moving into the controls: decide after it lands.
          setTimeout(() => controllers.get(view)?.refresh(), 0);
          return false;
        },
      },
    },
  });
}
