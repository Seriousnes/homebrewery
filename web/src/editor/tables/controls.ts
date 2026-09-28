// The table controls (T3): a floating toolbar anchored under the table that holds the selection
// (ui/tableMenu/TableControls.tsx), shown while the editor or the controls have focus. It adds and
// deletes rows and columns, merges and splits cells, toggles the header row, Wide and the other
// table classes, and deletes the table. Shift+Alt+F10 in a table moves the focus into it (outside
// a table the key stays the theme block's); Escape or Tab returns to the text.
//
// This plugin tracks the table and writes a small store; the React component reads it and places
// itself (so it follows scrolling, zoom and pagination moving the table). The controls get their
// own React root, created on first use (never during a dispatch) and unmounted after the editor is
// destroyed. The column width dialog lives in that root too (openColumnWidthDialog), so menus
// without their own (the context menu) can open it.
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TableControls as TableControlsView } from '../ui/tableMenu/TableControls';
import { selectedColumnWidth, tableContext } from './commands';
import { focusTableControls, registerTableControls, tableControlsOf, TableControlsStore, type ActiveTable, type TableControlsHandle } from './controlsStore';

export { focusTableControls, openColumnWidthDialog, tableControlsOf } from './controlsStore';

export const tableControlsKey = new PluginKey('hbTableControls');

/** Moves the focus to the table controls (ProseMirror key name; the theme block's key too). */
export const TABLE_CONTROLS_KEY = 'Shift-Alt-F10';

export class TableControlsController implements TableControlsHandle {
  readonly store = new TableControlsStore();
  readonly editor: Editor;
  private readonly view: EditorView;
  private root: Root | null = null;
  private controlsFocused = false;
  /** A menu of the controls is open (its list is in a portal, outside the controls). */
  private menuOpen = false;
  /** The editor had the focus when that menu opened (a pointer user): its actions return there. */
  private menuFromText = false;
  private destroyed = false;
  private mountScheduled = false;

  constructor(editor: Editor, view: EditorView) {
    this.editor = editor;
    this.view = view;
    registerTableControls(view, this);
    this.refresh();
  }

  /** Recomputes the active table and visibility from the view. */
  refresh(): void {
    if (this.destroyed || this.view.isDestroyed) return;
    const { view } = this;
    const ctx = tableContext(view.state);
    let table: ActiveTable | null = null;
    if (ctx) {
      let element: Node | null;
      try {
        element = view.nodeDOM(ctx.tablePos);
      } catch {
        element = null;
      }
      if (element instanceof HTMLElement) table = { pos: ctx.tablePos, element };
    }
    const focused = this.controlsFocused || this.menuOpen || view.hasFocus();
    const visible = view.editable && table !== null && focused && view.dom.isConnected;
    const prev = this.store.getSnapshot();
    // While hidden, the controls render nothing: no re-render on every keystroke.
    this.store.set({ table, visible, version: prev.version + 1 }, visible || prev.visible);
    if (visible) this.ensureMounted();
  }

  /** Focus entered or left the controls. */
  setFocused(focused: boolean): void {
    this.controlsFocused = focused;
    // Focus moving between the editor and the controls fires blur before focus: decide later.
    setTimeout(() => this.refresh(), 0);
  }

  setMenuOpen(open: boolean): void {
    if (open && !this.menuOpen) this.menuFromText = this.view.hasFocus();
    this.menuOpen = open;
    setTimeout(() => this.refresh(), 0);
  }

  /** After an action of a menu of the controls: back to the text when the menu was opened from there. */
  afterMenuAction(): void {
    if (this.menuFromText && !this.view.isDestroyed) this.view.focus();
  }

  /** Focus back to the text (Escape, Tab, the table deleted). */
  returnFocus(): void {
    this.controlsFocused = false;
    if (!this.view.isDestroyed) this.view.focus();
    this.refresh();
  }

  /** Moves focus into the controls (Shift+Alt+F10). Returns false when the selection is in no table. */
  focusControls(): boolean {
    if (!this.view.editable || tableContext(this.view.state) === null) return false;
    this.controlsFocused = true;
    this.refresh();
    this.store.set({ focusRequest: this.store.getSnapshot().focusRequest + 1 });
    return true;
  }

  /** Opens the column width dialog for the selected columns. */
  openColumnWidthDialog(): boolean {
    if (!this.view.editable || tableContext(this.view.state) === null) return false;
    this.store.set({ columnWidth: { width: selectedColumnWidth(this.view.state) } });
    this.ensureMounted();
    return true;
  }

  closeColumnWidthDialog(): void {
    this.store.set({ columnWidth: null });
  }

  private ensureMounted(): void {
    if (this.root || this.mountScheduled || typeof document === 'undefined') return;
    this.mountScheduled = true;
    queueMicrotask(() => {
      this.mountScheduled = false;
      if (this.destroyed || this.root) return;
      const container = document.createElement('div');
      container.setAttribute('data-hb-table-controls', '');
      this.root = createRoot(container);
      this.root.render(createElement(TableControlsView, { controller: this }));
    });
  }

  destroy(): void {
    this.destroyed = true;
    registerTableControls(this.view, null);
    this.store.set({ table: null, visible: false, columnWidth: null });
    const root = this.root;
    this.root = null;
    // Not synchronously: the editor may be destroyed while React commits.
    if (root) setTimeout(() => root.unmount(), 0);
  }
}

export function tableControlsPlugin(editor: Editor): Plugin {
  return new Plugin({
    key: tableControlsKey,
    view: (view) => {
      const controller = new TableControlsController(editor, view);
      return {
        update: () => controller.refresh(),
        destroy: () => controller.destroy(),
      };
    },
    props: {
      handleDOMEvents: {
        focus: (view) => {
          tableControlsOf(view)?.refresh();
          return false;
        },
        blur: (view) => {
          // Focus may be moving into the controls: decide after it lands.
          setTimeout(() => tableControlsOf(view)?.refresh(), 0);
          return false;
        },
      },
    },
  });
}

/**
 * The table controls. Its Shift+Alt+F10 runs before the theme block's (priority), and passes
 * outside a table.
 */
export const TableControls = Extension.create({
  name: 'hbTableControls',
  priority: 150,
  addProseMirrorPlugins() {
    return [tableControlsPlugin(this.editor)];
  },
  addKeyboardShortcuts() {
    return {
      [TABLE_CONTROLS_KEY]: ({ editor }) => focusTableControls(editor.view),
    };
  },
});
