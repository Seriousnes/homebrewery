// Keyboard editing inside definition lists (P5.7): without it, Enter in a term or description
// splits it into another item of the same kind and there is no way out of the list.
//
//   Enter in a non-empty term         → a description starts after it (text after the caret moves)
//   Enter in a non-empty description  → a term starts after it
//   Enter in an empty item            → leave the list: the item becomes a paragraph after it (or
//                                       between the two halves of the list)
//   Backspace at the start of the     → the item becomes a paragraph before the list
//   list's first item
//
// Shift-Enter keeps inserting a line break. Each key press is one transaction.
import { Extension } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Command } from '@tiptap/pm/state';

const ITEM_TYPES = new Set(['definitionTerm', 'definitionDesc']);

/** The caret's definition list item: depth of the item (its parent is the list). */
function itemDepth(state: Parameters<Command>[0]): number | null {
  const { $from, empty } = state.selection;
  if (!empty || !(state.selection instanceof TextSelection)) return null;
  const d = $from.depth;
  if (d < 2 || !ITEM_TYPES.has($from.parent.type.name) || $from.node(d - 1).type.name !== 'definitionList') return null;
  return d;
}

export const definitionListEnter: Command = (state, dispatch) => {
  const d = itemDepth(state);
  if (d === null) return false;
  const { $from } = state.selection;
  const item = $from.parent;
  const list = $from.node(d - 1);
  const listPos = $from.before(d - 1);
  const index = $from.index(d - 1);
  const { paragraph, definitionTerm, definitionDesc } = state.schema.nodes;
  if (!paragraph || !definitionTerm || !definitionDesc) return false;

  if (item.content.size === 0) {
    // Leave the list: [items before] paragraph [items after].
    if (!dispatch) return true;
    const before: PMNode[] = [];
    const after: PMNode[] = [];
    list.forEach((child, _offset, i) => {
      if (i < index) before.push(child);
      else if (i > index) after.push(child);
    });
    const parts: PMNode[] = [];
    if (before.length) parts.push(list.type.create(list.attrs, before));
    const paraAt = parts.reduce((size, n) => size + n.nodeSize, 0);
    parts.push(paragraph.create());
    // The id stays with the first half (review finding UI-10; as commands/blocks.ts afterAttrs).
    if (after.length) parts.push(list.type.create({ ...list.attrs, continuation: false, ...(before.length ? { id: null } : {}) }, after));
    const tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, Fragment.from(parts));
    tr.setSelection(TextSelection.create(tr.doc, listPos + paraAt + 1));
    dispatch(tr.scrollIntoView());
    return true;
  }

  const nextType = item.type === definitionTerm ? definitionDesc : definitionTerm;
  // At the end of an item followed by an empty item of the other kind (a new list's empty
  // description): go there instead of making another one.
  const next = index + 1 < list.childCount ? list.child(index + 1) : null;
  if ($from.parentOffset === item.content.size && next?.type === nextType && next.content.size === 0) {
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, $from.after(d) + 1)).scrollIntoView());
    return true;
  }
  if (dispatch) {
    const tr = state.tr.split($from.pos, 1, [{ type: nextType }]);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

export const definitionListBackspace: Command = (state, dispatch) => {
  const d = itemDepth(state);
  if (d === null) return false;
  const { $from } = state.selection;
  if ($from.parentOffset !== 0 || $from.index(d - 1) !== 0) return false;
  const { paragraph } = state.schema.nodes;
  if (!paragraph) return false;
  const list = $from.node(d - 1);
  const listPos = $from.before(d - 1);
  if (dispatch) {
    const para = paragraph.create(null, $from.parent.content);
    const rest: PMNode[] = [];
    list.forEach((child, _offset, i) => {
      if (i > 0) rest.push(child);
    });
    const parts = rest.length ? [para, list.type.create(list.attrs, rest)] : [para];
    const tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, Fragment.from(parts));
    tr.setSelection(TextSelection.create(tr.doc, listPos + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Enter and Backspace in definition lists (see the file header). */
export const DefinitionListKeys = Extension.create({
  name: 'hbDefinitionListKeys',
  // Before the default Enter (splitBlock) and Backspace (joinBackward).
  priority: 150,
  addKeyboardShortcuts() {
    return {
      Enter: () => definitionListEnter(this.editor.state, this.editor.view.dispatch),
      Backspace: () => definitionListBackspace(this.editor.state, this.editor.view.dispatch),
    };
  },
});
