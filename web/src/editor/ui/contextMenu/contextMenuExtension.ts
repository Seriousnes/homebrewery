// HbContextMenu: the editor's own right-click menu (issue: the browser's menu offered nothing for
// the document). This extension decides when the menu opens and where; ContextMenuHost (React)
// listens with onContextMenuRequest and renders it.
//
//   right-click            opens the menu at the pointer. Outside the selection the caret moves to
//                          the click first (an atom, e.g. an image or a spacer, is node-selected);
//                          inside the selection it stays, so Cut/Copy/Format act on it.
//   ContextMenu key,       open it at the caret.
//   Shift+F10
//   Shift+right-click      the browser's own menu (spell-check suggestions, "Inspect" …).
//
// The browser's menu also stays for a read-only editor, for form fields and CodeMirror editors
// inside the canvas (node views with their own text editing), for touch long-presses (the
// platform's selection handles and paste bubble), and when no host listens.
import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, type Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface ContextMenuRequest {
  /** Where to open the menu, in viewport coordinates (clientX / clientY). */
  x: number;
  y: number;
  origin: 'pointer' | 'keyboard';
}

/** Return true when the request was handled (the browser's menu is then suppressed). */
export type ContextMenuListener = (request: ContextMenuRequest) => boolean;

export interface HbContextMenuStorage {
  listeners: Set<ContextMenuListener>;
}

declare module '@tiptap/core' {
  interface Storage {
    hbContextMenu: HbContextMenuStorage;
  }
}

export const contextMenuKey = new PluginKey('hbContextMenu');

function storageOf(editor: Editor): HbContextMenuStorage | undefined {
  if (editor.isDestroyed) return undefined;
  return (editor.storage as Partial<Record<'hbContextMenu', HbContextMenuStorage>>).hbContextMenu;
}

/** Listens to the editor's context menu requests (newest listener first). Returns the unsubscribe. */
export function onContextMenuRequest(editor: Editor, listener: ContextMenuListener): () => void {
  const storage = storageOf(editor);
  if (!storage) return () => {};
  storage.listeners.add(listener);
  return () => storage.listeners.delete(listener);
}

function emit(storage: HbContextMenuStorage, request: ContextMenuRequest): boolean {
  for (const listener of [...storage.listeners].reverse()) if (listener(request)) return true;
  return false;
}

/** Elements inside the canvas that keep the browser's menu: they edit text of their own. */
const NATIVE_MENU_TARGETS = 'input, textarea, select, .cm-editor, [data-native-contextmenu]';

/** Whether the menu may replace the browser's for this event (see the top of the file). */
export function interceptsContextMenu(view: EditorView, storage: HbContextMenuStorage, event: MouseEvent | KeyboardEvent): boolean {
  if (!view.editable || storage.listeners.size === 0 || event.defaultPrevented) return false;
  if (event instanceof MouseEvent && event.shiftKey) return false;
  if ('pointerType' in event && (event as PointerEvent).pointerType === 'touch') return false;
  const target = event.target;
  if (target instanceof Element && target !== view.dom && target.closest(NATIVE_MENU_TARGETS) && view.dom.contains(target)) return false;
  return true;
}

/** ContextMenu key, or Shift+F10 (no other modifier). */
export function isContextMenuKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  return (event.key === 'ContextMenu' && !event.shiftKey) || (event.key === 'F10' && event.shiftKey);
}

/**
 * The selection a right-click at document position `pos` (`inside`: the node it is in, as
 * posAtCoords reports it) leads to: null to keep the current one (the click is inside it), else a
 * caret there, or the atom under the pointer node-selected.
 */
export function selectionForContextClick(selection: Selection, pos: number, inside: number): Selection | null {
  const doc = selection.$from.doc;
  if (selection instanceof NodeSelection) {
    if (inside === selection.from || (pos >= selection.from && pos <= selection.to && !selection.empty)) return null;
  } else if (!selection.empty && pos >= selection.from && pos <= selection.to) {
    return null;
  }
  if (inside >= 0) {
    const node = doc.nodeAt(inside);
    if (node?.isAtom && NodeSelection.isSelectable(node)) return NodeSelection.create(doc, inside);
  }
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const next = TextSelection.near(doc.resolve(clamped));
  return next.eq(selection) ? null : next;
}

/** Moves the selection to the pointer (see selectionForContextClick). */
function selectAtPointer(view: EditorView, event: MouseEvent): void {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return;
  const next = selectionForContextClick(view.state.selection, hit.pos, hit.inside);
  if (next) view.dispatch(view.state.tr.setSelection(next).setMeta('pointer', true));
}

/** The caret's point on screen, for a menu opened from the keyboard. */
export function caretPoint(view: EditorView): { x: number; y: number } {
  const { selection } = view.state;
  try {
    if (selection instanceof NodeSelection) {
      const dom = view.nodeDOM(selection.from);
      if (dom instanceof Element) {
        const rect = dom.getBoundingClientRect();
        return { x: rect.left, y: rect.bottom };
      }
    }
    const coords = view.coordsAtPos(selection.head);
    return { x: coords.left, y: coords.bottom };
  } catch {
    const rect = view.dom.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }
}

export const HbContextMenu = Extension.create<Record<string, never>, HbContextMenuStorage>({
  name: 'hbContextMenu',

  addStorage() {
    return { listeners: new Set<ContextMenuListener>() };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: contextMenuKey,
        props: {
          handleDOMEvents: {
            // The secondary button: no native caret move or PM mouse handling; the caret moves
            // here, deterministically (contextmenu follows on mousedown or on mouseup by platform).
            mousedown: (view, event) => {
              if (event.button !== 2 || !interceptsContextMenu(view, storage, event)) return false;
              selectAtPointer(view, event);
              event.preventDefault();
              return true;
            },
            contextmenu: (view, event) => {
              if (!interceptsContextMenu(view, storage, event)) return false;
              // A keyboard-made contextmenu (the key reached the page without a keydown we saw)
              // has no pointer position: open at the caret. (macOS Ctrl+click reports button 0.)
              const keyboard = event.button !== 2 && !event.ctrlKey;
              if (!keyboard) selectAtPointer(view, event);
              const at = keyboard ? caretPoint(view) : { x: event.clientX, y: event.clientY };
              if (!emit(storage, { ...at, origin: keyboard ? 'keyboard' : 'pointer' })) return false;
              event.preventDefault();
              return true;
            },
          },
          handleKeyDown: (view, event) => {
            if (!isContextMenuKey(event) || !interceptsContextMenu(view, storage, event)) return false;
            return emit(storage, { ...caretPoint(view), origin: 'keyboard' });
          },
        },
      }),
    ];
  },
});
