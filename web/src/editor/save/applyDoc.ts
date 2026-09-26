// Replacing the editor's document with another version (the server's sanitized document, "Load
// the saved version", a restored draft or snapshot) without resetting the editor.
//
// Only the range that differs is replaced (Fragment.findDiffStart / findDiffEnd, as
// prosemirror-view does for DOM changes), so the caret, the scroll position and the undo history
// of everything outside that range survive: prosemirror-history maps its events through the step
// like any other remote change. A new EditorState or setContent would drop the whole history.
import type { Editor, JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { SERVER_DOC_META } from './dirty';

export interface ReplaceDocumentOptions {
  /**
   * true: one undo step of its own (restoring a draft or snapshot, loading the saved version).
   * false: outside the history (the server's sanitized copy of what was just sent).
   */
  undoable: boolean;
  /** false marks the transaction SERVER_DOC_META, so autosave doesn't save it again. */
  dirty: boolean;
}

/** Position of the start of child `index` of `fragment` (content offset). */
function childOffset(fragment: Fragment, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += fragment.child(i).nodeSize;
  return pos;
}

/**
 * A transaction on `state` that turns its document into `next`, touching as little as possible;
 * null when they are equal. Tries the smallest differing range first, then whole top-level nodes
 * (pages: always a valid replacement), then the whole content.
 */
export function replaceDocTransaction(state: EditorState, next: PMNode): Transaction | null {
  const current = state.doc;
  const start = current.content.findDiffStart(next.content);
  if (start === null) return null;
  const end = current.content.findDiffEnd(next.content);
  if (end) {
    let { a: endA, b: endB } = end;
    // Both ends can point into a repeated run (e.g. "aa" → "aaa"); keep end ≥ start on both sides.
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    try {
      const tr = state.tr.replace(start, endA, next.slice(start, endB));
      if (tr.doc.eq(next)) return tr;
    } catch {
      // The slice didn't fit at those depths; fall through to whole pages.
    }
  }

  const a = current.content;
  const b = next.content;
  let first = 0;
  while (first < a.childCount && first < b.childCount && a.child(first).eq(b.child(first))) first++;
  let lastA = a.childCount;
  let lastB = b.childCount;
  while (lastA > first && lastB > first && a.child(lastA - 1).eq(b.child(lastB - 1))) {
    lastA--;
    lastB--;
  }
  try {
    const tr = state.tr.replaceWith(childOffset(a, first), childOffset(a, lastA), b.cut(childOffset(b, first), childOffset(b, lastB)));
    if (tr.doc.eq(next)) return tr;
  } catch {
    // fall through
  }
  return state.tr.replaceWith(0, a.size, b);
}

/** Parses and checks `json` against the editor's schema (throws RangeError when invalid). */
export function docFromJson(state: EditorState, json: JSONContent): PMNode {
  const node = state.schema.nodeFromJSON(json);
  node.check();
  return node;
}

/**
 * Makes the editor's document equal to `json` in one transaction. Returns false when it already
 * was (nothing dispatched). Throws when `json` doesn't fit the schema.
 */
export function replaceDocument(target: Editor | EditorView, json: JSONContent, options: ReplaceDocumentOptions): boolean {
  const view = 'view' in target ? target.view : target;
  const next = docFromJson(view.state, json);
  const tr = replaceDocTransaction(view.state, next);
  if (!tr) return false;
  if (options.undoable) closeHistory(tr);
  else tr.setMeta('addToHistory', false);
  if (!options.dirty) tr.setMeta(SERVER_DOC_META, true);
  view.dispatch(tr);
  return true;
}
