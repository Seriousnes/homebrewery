// Block commands (P5.7): insert and remove definition lists, spacers, column breaks and
// horizontal rules. Plain ProseMirror commands (state, dispatch?) → boolean, so the toolbar lane,
// keymaps and the BlockMenu can all run them; each is one transaction (one undo step).
//
//   runBlockCommand(editor, insertSpacer)          // or insertSpacer(state, dispatch)
//   canRun(editor, removeBlock('spacer'))           // dispatch-less check for menus
//
// Insertion (insertBlock) follows the cursor:
// - an empty paragraph: the block goes before it and the caret stays in the paragraph; a
//   definition list replaces the paragraph instead (the caret goes into its term),
// - the start of a text block: before it; the end: after it; the middle: the text block is split,
// - a node selection or gap cursor: after the node / at the gap,
// - where the block isn't allowed (e.g. before a list item's first paragraph): after the nearest
//   ancestor that allows it.
// After an atom (spacer, column break, rule) the caret goes to the next text block, and a new
// empty paragraph is added when there is none.
//
// Removal (removeBlock) acts on the node selection, the ancestor definition list, or the block
// right before/after the caret (caret at the start/end of a text block, or a gap cursor).
// Definition lists are unwrapped into paragraphs (their text stays); atoms are deleted.
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, type Node as PMNode, type NodeType, type ResolvedPos, type Schema } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type Command, type EditorState, type Transaction } from '@tiptap/pm/state';

// Column breaks: the toolbar lane's command (Shift-Mod-Enter), so the menu and the key agree.
export { insertColumnBreak } from '../../commands/blocks';

/** The block types P5.7 manages. */
export const BLOCK_TYPES = ['definitionList', 'spacer', 'columnBreak', 'horizontalRule'] as const;
export type BlockTypeName = (typeof BLOCK_TYPES)[number];

export const BLOCK_LABELS: Record<BlockTypeName, string> = {
  definitionList: 'Definition list',
  spacer: 'Spacer',
  columnBreak: 'Column break',
  horizontalRule: 'Horizontal rule',
};

/** Where a block was found or inserted. */
export interface BlockAt {
  pos: number;
  node: PMNode;
}

// ---------------------------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------------------------

/** First position inside `node` (inserted at `pos`) where a text cursor fits, or null. */
function firstTextPos(doc: PMNode, pos: number): number | null {
  const node = doc.nodeAt(pos);
  if (!node) return null;
  let found: number | null = null;
  node.descendants((child, offset) => {
    if (found !== null) return false;
    if (child.isTextblock) {
      found = pos + 1 + offset + 1;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Depth and index at which `type` can be inserted around `$pos` (a position between blocks, at
 * depth `depth`), walking up to the nearest ancestor that allows it. `after` picks the side of
 * the ancestor it walks out of.
 */
function insertionPoint($pos: ResolvedPos, depth: number, index: number, type: NodeType, after: boolean): number | null {
  for (let d = depth; d >= 0; d--) {
    const parent = $pos.node(d);
    const i = d === depth ? index : after ? $pos.indexAfter(d) : $pos.index(d);
    if (parent.canReplaceWith(i, i, type)) {
      // Position of child index i inside parent (at depth d).
      let pos = d === 0 ? 0 : $pos.start(d);
      for (let k = 0; k < i; k++) pos += parent.child(k).nodeSize;
      return pos;
    }
  }
  return null;
}

/** Puts the caret after an inserted atom: next text block, or a new empty paragraph. */
function caretAfter(tr: Transaction, afterPos: number, schema: Schema): void {
  const $after = tr.doc.resolve(afterPos);
  const next = $after.nodeAfter;
  if (next?.isTextblock) {
    tr.setSelection(TextSelection.create(tr.doc, afterPos + 1));
    return;
  }
  if (next) {
    // A list, table or atom follows: the nearest text position after the block.
    tr.setSelection(TextSelection.near($after, 1));
    return;
  }
  const paragraph = schema.nodes.paragraph;
  if (paragraph && $after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) {
    tr.insert(afterPos, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, afterPos + 1));
    return;
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos)));
}

/**
 * Inserts a block node at the selection (see the file header). `make` builds the node from the
 * schema (and may use the text block the caret is in, e.g. to convert it).
 */
export function insertBlock(make: (schema: Schema) => PMNode | null): Command {
  return (state, dispatch) => {
    const node = make(state.schema);
    if (!node) return false;
    // Always its own undo step (not merged with typing just before it).
    const tr = closeHistory(state.tr);
    if (!tr.selection.empty && !(tr.selection instanceof NodeSelection)) tr.deleteSelection();
    const sel = tr.selection;
    let at: number | null;
    let keepCaret = false; // caret stays where it is (in the empty paragraph after the block)

    if (sel instanceof NodeSelection) {
      const $to = tr.doc.resolve(sel.to);
      at = insertionPoint($to, $to.depth, $to.index(), node.type, true);
    } else {
      const $pos = sel.$from;
      if (!$pos.parent.isTextblock) {
        // Gap cursor (between blocks).
        at = insertionPoint($pos, $pos.depth, $pos.index(), node.type, true);
      } else {
        const d = $pos.depth;
        const textblock = $pos.parent;
        const indexInParent = $pos.index(d - 1);
        if (textblock.content.size === 0) {
          if (node.isAtom) {
            at = insertionPoint($pos, d - 1, indexInParent, node.type, false);
            keepCaret = at === $pos.before(d);
          } else {
            // A container (definition list) takes the empty paragraph's place.
            const parent = $pos.node(d - 1);
            if (parent.canReplaceWith(indexInParent, indexInParent + 1, node.type)) {
              tr.replaceWith($pos.before(d), $pos.after(d), node);
              const inside = firstTextPos(tr.doc, $pos.before(d));
              tr.setSelection(inside !== null ? TextSelection.create(tr.doc, inside) : NodeSelection.create(tr.doc, $pos.before(d)));
              dispatch?.(tr.scrollIntoView());
              return true;
            }
            at = insertionPoint($pos, d - 1, indexInParent, node.type, true);
          }
        } else if ($pos.parentOffset === 0) {
          at = insertionPoint($pos, d - 1, indexInParent, node.type, false);
        } else if ($pos.parentOffset === textblock.content.size) {
          at = insertionPoint($pos, d - 1, indexInParent + 1, node.type, true);
        } else {
          // Middle of a text block: split it, then insert between the halves.
          const parent = $pos.node(d - 1);
          if (parent.canReplaceWith(indexInParent + 1, indexInParent + 1, node.type)) {
            tr.split($pos.pos);
            at = tr.mapping.map($pos.pos, -1) + 1; // after the first half
          } else {
            at = insertionPoint($pos, d - 1, indexInParent + 1, node.type, true);
          }
        }
      }
    }
    if (at === null) return false;
    if (!dispatch) return true;
    tr.insert(at, node);
    if (keepCaret) {
      // The caret's paragraph moved down by the inserted node.
    } else if (node.isAtom && !sel.$from.parent.isTextblock) {
      // From a node selection or a gap cursor: the new node is selected.
      tr.setSelection(NodeSelection.create(tr.doc, at));
    } else if (node.isAtom) {
      caretAfter(tr, at + node.nodeSize, state.schema);
    } else {
      const inside = firstTextPos(tr.doc, at);
      if (inside !== null) tr.setSelection(TextSelection.create(tr.doc, inside));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

const atom = (name: BlockTypeName) => (schema: Schema) => schema.nodes[name]?.create() ?? null;

export const insertSpacer: Command = insertBlock(atom('spacer'));
export const insertHorizontalRule: Command = insertBlock(atom('horizontalRule'));

/** A definition list with one empty term and one empty description. */
export function emptyDefinitionList(schema: Schema, term?: Fragment): PMNode | null {
  const { definitionList, definitionTerm, definitionDesc } = schema.nodes;
  if (!definitionList || !definitionTerm || !definitionDesc) return null;
  return definitionList.create(null, [definitionTerm.create(null, term), definitionDesc.create()]);
}

/**
 * Inserts a definition list. In a non-empty paragraph it converts the paragraph instead: text
 * before `::` becomes the term and the rest the description (upstream's `Term :: Definition`);
 * without `::` the whole paragraph becomes the term. One undo step either way.
 */
export const insertDefinitionList: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const paragraph = $from.parent;
  if (empty && paragraph.type.name === 'paragraph' && paragraph.content.size > 0 && $from.depth >= 2) {
    const { definitionList, definitionTerm, definitionDesc } = state.schema.nodes;
    if (!definitionList || !definitionTerm || !definitionDesc) return false;
    const d = $from.depth;
    const parent = $from.node(d - 1);
    const index = $from.index(d - 1);
    if (!parent.canReplaceWith(index, index + 1, definitionList)) return insertBlock((s) => emptyDefinitionList(s))(state, dispatch);
    let term = paragraph.content;
    let desc = Fragment.empty;
    // One character per inline leaf (icons, images, breaks), so text offsets are content offsets.
    const text = paragraph.textBetween(0, paragraph.content.size, undefined, '\uFFFC');
    const split = text.indexOf('::');
    if (split >= 0) {
      term = paragraph.content.cut(0, split);
      desc = paragraph.content.cut(split + 2);
      term = trimFragment(term);
      desc = trimFragment(desc);
    }
    if (dispatch) {
      const dl = definitionList.create(null, [definitionTerm.create(null, term), definitionDesc.create(null, desc)]);
      const tr = closeHistory(state.tr).replaceWith($from.before(d), $from.after(d), dl);
      // Caret: end of the description when there is one, else end of the term.
      const dlPos = $from.before(d);
      const termNode = dl.child(0);
      const caret = desc.size > 0 ? dlPos + 1 + termNode.nodeSize + 1 + dl.child(1).content.size : dlPos + 2 + termNode.content.size;
      tr.setSelection(TextSelection.create(tr.doc, caret));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }
  return insertBlock((s) => emptyDefinitionList(s))(state, dispatch);
};

/** A fragment without leading/trailing whitespace in its first/last text nodes. */
function trimFragment(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((n) => nodes.push(n));
  const first = nodes[0];
  if (first?.isText) {
    const t = first.text!.replace(/^\s+/, '');
    if (t) nodes[0] = first.type.schema.text(t, first.marks);
    else nodes.shift();
  }
  const last = nodes[nodes.length - 1];
  if (last?.isText) {
    const t = last.text!.replace(/\s+$/, '');
    if (t) nodes[nodes.length - 1] = last.type.schema.text(t, last.marks);
    else nodes.pop();
  }
  return Fragment.from(nodes);
}

// ---------------------------------------------------------------------------------------------
// Finding and removing
// ---------------------------------------------------------------------------------------------

/** The block of type `name` the selection refers to (see the file header), or null. */
export function findBlock(state: EditorState, name: BlockTypeName): BlockAt | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) {
    return sel.node.type.name === name ? { pos: sel.from, node: sel.node } : null;
  }
  const { $from } = sel;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === name) return { pos: $from.before(d), node: n };
  }
  if (!sel.empty) return null;
  // Gap cursor: the nodes on either side.
  if (!$from.parent.isTextblock) {
    const before = $from.nodeBefore;
    if (before?.type.name === name) return { pos: $from.pos - before.nodeSize, node: before };
    const after = $from.nodeAfter;
    if (after?.type.name === name) return { pos: $from.pos, node: after };
    return null;
  }
  // Caret at the start / end of a text block: the sibling block before / after it.
  const d = $from.depth;
  if ($from.parentOffset === 0) {
    const index = $from.index(d - 1);
    const parent = $from.node(d - 1);
    if (index > 0) {
      const prev = parent.child(index - 1);
      if (prev.type.name === name) return { pos: $from.before(d) - prev.nodeSize, node: prev };
    }
  }
  if ($from.parentOffset === $from.parent.content.size) {
    const index = $from.index(d - 1);
    const parent = $from.node(d - 1);
    if (index + 1 < parent.childCount) {
      const next = parent.child(index + 1);
      if (next.type.name === name) return { pos: $from.after(d), node: next };
    }
  }
  return null;
}

/** Removes the block of type `name` that findBlock finds (one undo step). */
export function removeBlock(name: BlockTypeName): Command {
  return (state, dispatch) => {
    const found = findBlock(state, name);
    if (!found) return false;
    const { pos, node } = found;
    const $pos = state.doc.resolve(pos);
    const parent = $pos.parent;
    const index = $pos.index();
    if (name === 'definitionList') {
      const paragraph = state.schema.nodes.paragraph;
      if (!paragraph) return false;
      const paragraphs: PMNode[] = [];
      node.forEach((item) => paragraphs.push(paragraph.create(null, item.content)));
      if (!parent.canReplace(index, index + 1, Fragment.from(paragraphs))) return false;
      if (dispatch) {
        const tr = closeHistory(state.tr).replaceWith(pos, pos + node.nodeSize, paragraphs);
        const sel = state.selection;
        // Keep the caret at the same character when it was inside the list: every item became a
        // paragraph of the same size, only the list's opening token is gone (review finding UI-6).
        if (sel.from > pos && sel.to < pos + node.nodeSize) {
          const newSize = paragraphs.reduce((size, p) => size + p.nodeSize, 0);
          const at = (n: number) => Math.max(pos + 1, Math.min(n - 1, pos + newSize - 1));
          tr.setSelection(TextSelection.create(tr.doc, at(sel.anchor), at(sel.head)));
        }
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    // Atoms: delete. A block container must keep at least one child.
    if (parent.childCount === 1) {
      const filler = parent.type.contentMatch.defaultType?.createAndFill();
      if (!filler) return false;
      if (dispatch) {
        const tr = closeHistory(state.tr).replaceWith(pos, pos + node.nodeSize, filler);
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    if (!parent.canReplace(index, index + 1)) return false;
    if (dispatch) {
      const tr = closeHistory(state.tr).delete(pos, pos + node.nodeSize);
      const sel = state.selection;
      if (sel instanceof NodeSelection || !sel.$from.parent.isTextblock) {
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), 1));
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// Running from React
// ---------------------------------------------------------------------------------------------

/** Runs a command on the editor's view and returns focus to the text. */
export function runBlockCommand(editor: Editor, command: Command): boolean {
  if (editor.isDestroyed) return false;
  const done = command(editor.state, editor.view.dispatch, editor.view);
  editor.view.focus();
  return done;
}

/** Whether the command applies (no dispatch). */
export function canRun(editor: Editor, command: Command): boolean {
  return !editor.isDestroyed && command(editor.state);
}
