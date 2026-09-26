// The caret's text block, for blocks that draw no line of their own when empty: definition terms
// and descriptions (upstream's inline <dt>/<dd>).
//
// canvas.css hides ProseMirror's trailing <br> in empty dt/dd, so they look like upstream
// (fidelity-findings.md item 2: `::Definition`). An item without a line box can't show or hold a
// caret, though, so:
// - the text block holding the caret of a focused editor gets the class hb-caret-block (a node
//   decoration) and keeps its line while it is edited (a read-only view or a blurred editor looks
//   exactly like upstream);
// - the first character typed into an empty dt/dd goes in through ProseMirror (Chromium would put
//   it at the same visual position in the term before an empty inline dd);
// - a click in an empty table cell puts the caret into that cell (a safety net: with the cell's
//   paragraph displayed as contents the browser looked for the nearest line box, in another cell).
// EditorCanvas includes this (editorNodeViews).
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

export const CARET_BLOCK_CLASS = 'hb-caret-block';

export const caretBlockKey = new PluginKey<boolean>('hbCaretBlock');

const DL_ITEMS = new Set(['definitionTerm', 'definitionDesc']);

/** Whether a text block draws no line when empty: a dt/dd. */
export function isLinelessWhenEmpty(block: PMNode): boolean {
  return DL_ITEMS.has(block.type.name);
}

/** The decoration set for a state: the caret's dt/dd, if any (when `focused`). */
export function caretBlockDecorations(state: EditorState, focused = true): DecorationSet {
  if (!focused) return DecorationSet.empty;
  const { $head, empty } = state.selection;
  if (!empty || $head.depth < 1 || !$head.parent.isTextblock) return DecorationSet.empty;
  const block = $head.parent;
  if (!isLinelessWhenEmpty(block)) return DecorationSet.empty;
  const from = $head.before();
  return DecorationSet.create(state.doc, [Decoration.node(from, from + block.nodeSize, { class: CARET_BLOCK_CLASS })]);
}

/** Records focus in the plugin state (no document change, no history). */
function setFocused(view: EditorView, focused: boolean): boolean {
  if (caretBlockKey.getState(view.state) !== focused) {
    view.dispatch(view.state.tr.setMeta(caretBlockKey, focused).setMeta('addToHistory', false));
  }
  return false;
}

/** The empty paragraph of the table cell a mouse press lands in, or null. */
function emptyCellParagraph(view: EditorView, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || !view.dom.contains(target)) return null;
  const cell = target.closest('td, th');
  if (!cell || !view.dom.contains(cell)) return null;
  const paragraph = cell.firstElementChild;
  if (!(paragraph instanceof HTMLElement) || paragraph.localName !== 'p' || cell.childElementCount !== 1) return null;
  const onlyBreak = paragraph.childNodes.length === 1 && (paragraph.firstChild as Element | null)?.localName === 'br';
  return onlyBreak ? paragraph : null;
}

export const CaretBlock = Extension.create({
  name: 'hbCaretBlock',
  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: caretBlockKey,
        state: {
          init: () => false,
          apply: (tr, focused) => (tr.getMeta(caretBlockKey) as boolean | undefined) ?? focused,
        },
        props: {
          decorations(state) {
            return caretBlockDecorations(state, caretBlockKey.getState(state) === true);
          },
          handleDOMEvents: {
            focus: (view) => setFocused(view, true),
            blur: (view) => setFocused(view, false),
          },
          // After a plain click (no drag, so cell selections by dragging are untouched): when the
          // click was in an empty cell but the browser put the caret elsewhere, move it there.
          handleClick(view, _pos, event) {
            if (event.button !== 0 || event.shiftKey || !view.editable) return false;
            const paragraph = emptyCellParagraph(view, event.target);
            if (!paragraph) return false;
            let pos: number;
            try {
              pos = view.posAtDOM(paragraph, 0);
            } catch {
              return false;
            }
            if (view.state.selection.empty && view.state.selection.from === pos) return false;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
            return true;
          },
          handleKeyPress(view, event) {
            if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.key.length !== 1) return false;
            const { $from, empty } = view.state.selection;
            if (!empty || !DL_ITEMS.has($from.parent.type.name) || $from.parent.content.size !== 0) return false;
            view.dispatch(view.state.tr.insertText(event.key).scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
