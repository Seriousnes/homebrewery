// The table controls' state (T3), without React or DOM imports: the store the plugin (controls.ts)
// writes and the component (ui/tableMenu/TableControls.tsx) reads, and the per-view registry that
// menus reach the controls through (focus them, open the column width dialog).
import type { EditorView } from '@tiptap/pm/view';

export interface ActiveTable {
  /** Position of the table node. */
  pos: number;
  /** Its element (the table, HbTableView's dom). */
  element: HTMLElement;
}

export interface TableControlsState {
  table: ActiveTable | null;
  visible: boolean;
  /** Increments on every document or selection change (re-render, re-position). */
  version: number;
  /** Increments when focus should move into the controls (Shift+Alt+F10). */
  focusRequest: number;
  /** The column width dialog: the width when it opened; null = closed. */
  columnWidth: { width: number | null } | null;
}

export class TableControlsStore {
  private state: TableControlsState = { table: null, visible: false, version: 0, focusRequest: 0, columnWidth: null };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): TableControlsState => this.state;

  /** Updates the state; `notify: false` skips the listeners (nothing they show changed). */
  set(next: Partial<TableControlsState>, notify = true): void {
    this.state = { ...this.state, ...next };
    if (notify) for (const listener of [...this.listeners]) listener();
  }
}

/** What menus and keys can ask of an editor's table controls. */
export interface TableControlsHandle {
  refresh(): void;
  focusControls(): boolean;
  openColumnWidthDialog(): boolean;
}

const handles = new WeakMap<EditorView, TableControlsHandle>();

/** Registers (or with null, removes) the table controls of a view. */
export function registerTableControls(view: EditorView, handle: TableControlsHandle | null): void {
  if (handle) handles.set(view, handle);
  else handles.delete(view);
}

/** The table controls of an editor view (tests, menus). */
export const tableControlsOf = (view: EditorView): TableControlsHandle | undefined => handles.get(view);

/** Moves the focus to the table controls of `view` (the Shift+Alt+F10 shortcut in a table). */
export function focusTableControls(view: EditorView): boolean {
  return handles.get(view)?.focusControls() ?? false;
}

/** Opens the column width dialog of `view`'s table controls; false without them or outside a table. */
export function openColumnWidthDialog(view: EditorView): boolean {
  return handles.get(view)?.openColumnWidthDialog() ?? false;
}
