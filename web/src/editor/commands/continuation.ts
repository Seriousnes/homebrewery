// Editing across page boundaries (plan §4.8, P4.7).
//
// A paragraph split by pagination is one paragraph to the author. Keyboard behaviour at the seam
// must match an unsplit paragraph. Pages are `isolating`, so these commands are the only way edits
// cross a page boundary.
//
// Backspace at the start of a continuation fragment
//   → delete the last character of the previous fragment (same as mid-paragraph).
// Delete at the end of a fragment whose next sibling is a continuation
//   → delete the first character of the continuation (a continuation left empty goes, when its
//     parent allows it: nothing is left after the seam).
// ArrowRight at the end of a fragment / ArrowLeft at the start of a continuation (reversed on
// right-to-left text; Shift extends)
//   → skip the seam: land one character past it, so one key press moves one character.
// Enter at a seam → ordinary paragraph split: the text after the seam becomes a paragraph of its
//   own (no continuation), and no empty paragraph is created. In a split list item the item is
//   split (splitListItem): the item after the seam is a new item of the same list.
// Backspace at the start of the first block of an AUTO page (no continuation)
//   → join the two pages, then run joinBackward. Pagination re-splits afterwards. A page that
//     carries objects or markers stays (after the block that received the join, or as a
//     placeholder). When there is nothing to join with (a table before), the block before is
//     selected instead, as selectNodeBackward does, and the pages stay apart.
// Delete at the end of the last block of a page followed by an AUTO page → the same, with
//   joinForward.
// Backspace at the start of a MANUAL page (Delete at the end of the page before it)
//   → the page becomes an auto page (removeSectionBreak): pagination pulls content back.
// Selecting across pages and deleting: default ProseMirror behaviour, then pagination settles.
// Deleting a split block's head (the node): the pagination plugin makes the fragment after it a
//   block of its own (fragments.ts clearOrphanedContinuations).
//
// Every command is one transaction in the undo history: one undo step per key press.
import { Extension } from '@tiptap/core';
import { joinBackward, joinForward } from '@tiptap/pm/commands';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { EditorState, NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Command, type Transaction } from '@tiptap/pm/state';
import { StepMap } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { JoinPagesStep, carriesPageData, fragmentChain, isAutoPage, pageAt, rejoinContinuations, restorePageAt } from '../pagination';
import { withChainsJoined } from './blockType';
import { atPageFlowEnd, atPageFlowStart, removeSectionBreak } from './sections';

// Characters ---------------------------------------------------------------------------------

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Length (UTF-16 units) of the first grapheme of `text` (surrogate pairs without Intl.Segmenter). */
export function firstGraphemeLength(text: string): number {
  if (!text) return 0;
  if (segmenter) {
    for (const s of segmenter.segment(text.slice(0, 64))) return s.segment.length;
  }
  const code = text.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff && text.length > 1 ? 2 : 1;
}

/** Length (UTF-16 units) of the last grapheme of `text`. */
export function lastGraphemeLength(text: string): number {
  if (!text) return 0;
  if (segmenter) {
    let last = '';
    for (const s of segmenter.segment(text.slice(-64))) last = s.segment;
    return last.length;
  }
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xdc00 && code <= 0xdfff && text.length > 1 ? 2 : 1;
}

/** The range of the character (grapheme, or inline atom) right before `pos` in its textblock. */
function charBefore(doc: PMNode, pos: number): [number, number] | null {
  const before = doc.resolve(pos).nodeBefore;
  if (!before) return null;
  return [pos - (before.isText ? lastGraphemeLength(before.text ?? '') : before.nodeSize), pos];
}

/** The range of the character right after `pos` in its textblock. */
function charAfter(doc: PMNode, pos: number): [number, number] | null {
  const after = doc.resolve(pos).nodeAfter;
  if (!after) return null;
  return [pos, pos + (after.isText ? firstGraphemeLength(after.text ?? '') : after.nodeSize)];
}

// Seams --------------------------------------------------------------------------------------

/** A textblock fragment next to the cursor's across a page seam. */
interface Neighbour {
  /** position before the neighbouring fragment */
  pos: number;
  node: PMNode;
}

/** Position before the textblock `$pos` is in, or null. */
function textblockPos($pos: ResolvedPos): number | null {
  return $pos.depth >= 2 && $pos.parent.isTextblock ? $pos.before() : null;
}

/** The fragment before (dir -1) or after (dir 1) the textblock at `pos` across a seam, or null. */
function neighbourFragment(doc: PMNode, pos: number, dir: -1 | 1): Neighbour | null {
  const chain = fragmentChain(doc, pos);
  const k = chain.indexOf(pos);
  const other = k < 0 ? undefined : chain[k + dir];
  if (other === undefined) return null;
  const node = doc.nodeAt(other);
  return node && node.isTextblock ? { pos: other, node } : null;
}

/** The empty-selection cursor, when it sits at the start (dir -1) or end (dir 1) of a textblock that has a fragment on that side. */
function seamAt(state: EditorState, dir: -1 | 1): { $pos: ResolvedPos; own: number; other: Neighbour } | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $pos = sel.$head;
  const own = textblockPos($pos);
  if (own === null) return null;
  if (dir === -1 ? $pos.parentOffset !== 0 : $pos.parentOffset !== $pos.parent.content.size) return null;
  const other = neighbourFragment(state.doc, own, dir);
  return other ? { $pos, own, other } : null;
}

/** Content start and end of a textblock at `pos`. */
const contentStart = (n: Neighbour): number => n.pos + 1;
const contentEnd = (n: Neighbour): number => n.pos + n.node.nodeSize - 1;

/**
 * Backspace at the start of a continuation fragment: deletes the last character of the fragment
 * before the seam. The cursor stays at the seam.
 */
export const backspaceAtSeam: Command = (state, dispatch) => {
  const seam = seamAt(state, -1);
  if (!seam) return false;
  const range = charBefore(state.doc, contentEnd(seam.other));
  // An empty fragment before the seam (only while pagination catches up): nothing to delete.
  if (!range) return false;
  if (dispatch) {
    const tr = state.tr.delete(range[0], range[1]);
    // Typing goes on with the marks of the text before the seam, as after a Backspace in the
    // middle of a paragraph (review finding PGR-13).
    tr.setStoredMarks(tr.doc.resolve(range[0]).marks());
    dispatch(tr.scrollIntoView());
  }
  return true;
};

// Words ----------------------------------------------------------------------------------------

const wordSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

/** `text` in word segments ({ segment, isWordLike }); without Intl.Segmenter, runs of spaces and non-spaces. */
function wordSegments(text: string): { segment: string; word: boolean }[] {
  if (wordSegmenter) return [...wordSegmenter.segment(text)].map((s) => ({ segment: s.segment, word: s.isWordLike === true }));
  return (text.match(/\s+|\S+/g) ?? []).map((segment) => ({ segment, word: /\S/.test(segment) }));
}

/**
 * Length (UTF-16 units) of what a word delete backwards (Ctrl+Backspace, Alt+Backspace on macOS)
 * removes at the end of `text`: the spaces and punctuation before the cursor, then one word.
 */
export function wordLengthBefore(text: string): number {
  const segments = wordSegments(text);
  let k = segments.length - 1;
  let length = 0;
  while (k >= 0 && !segments[k]!.word) length += segments[k--]!.segment.length;
  if (k >= 0) length += segments[k]!.segment.length;
  return length;
}

/**
 * Length of what a word delete forwards removes at the start of `text`, as the browsers do it on
 * each platform: on Windows (Ctrl+Delete) to the start of the next word (the word and the spaces
 * after it); on macOS (Alt+Delete) and Linux (Ctrl+Delete) to the end of the next word (the spaces
 * before it and the word). Chromium and Firefox both follow the platform (Firefox:
 * layout.word_select.eat_space_to_next_word is on only on Windows).
 */
export function wordLengthAfter(text: string, toWordEnd = deletesToWordEnd()): number {
  const segments = wordSegments(text);
  let k = 0;
  let length = 0;
  if (toWordEnd) {
    while (k < segments.length && !segments[k]!.word) length += segments[k++]!.segment.length;
    if (k < segments.length) length += segments[k]!.segment.length;
    return length;
  }
  if (k < segments.length && segments[k]!.word) length += segments[k++]!.segment.length;
  while (k < segments.length && !segments[k]!.word) length += segments[k++]!.segment.length;
  return length;
}

/** macOS, iOS and Linux (ChromeOS and Android report Linux too): a forward word delete stops at the end of the word. */
const deletesToWordEnd = (): boolean => typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)|Linux/.test(navigator.platform);

/** Stands for an inline leaf (atom, break) in a textblock's text: one character, as its size. */
const LEAF = String.fromCharCode(0xfffc);

/** The text of a textblock, leaves (inline atoms, breaks) as one character each (positions match). */
const blockText = (node: PMNode): string => node.textBetween(0, node.content.size, undefined, LEAF);

/**
 * A word delete at a seam (Ctrl/Alt+Backspace at the start of a continuation, Ctrl/Alt+Delete at
 * the end of a fragment followed by one): removes the word before or after the seam, as in an
 * unsplit paragraph (review finding PGR-7). Pages are isolating, so the browser's own word delete
 * stops there. Elsewhere false (native).
 */
export function deleteWordAtSeam(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const seam = seamAt(state, dir);
    if (!seam) return false;
    const other = seam.other;
    const text = blockText(other.node);
    const length = dir === -1 ? wordLengthBefore(text) : wordLengthAfter(text);
    if (length === 0) return false;
    if (dispatch) {
      const from = dir === -1 ? contentEnd(other) - length : contentStart(other);
      const tr = state.tr.delete(from, from + length);
      if (dir === -1) tr.setStoredMarks(tr.doc.resolve(from).marks());
      else removeIfEmpty(tr, other.pos);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Removes the (continuation) textblock at `pos` when a delete left it empty and its parent can do without it. */
function removeIfEmpty(tr: Transaction, pos: number): void {
  const node = tr.doc.nodeAt(pos);
  if (!node || node.content.size > 0) return;
  const $pos = tr.doc.resolve(pos);
  const index = $pos.index();
  if ($pos.parent.childCount > 1 && $pos.parent.canReplace(index, index + 1)) tr.delete(pos, pos + node.nodeSize);
}

/**
 * Delete at the end of a fragment followed by a continuation: deletes the continuation's first
 * character. A continuation left empty is removed when its parent can do without it.
 */
export const deleteAtSeam: Command = (state, dispatch) => {
  const seam = seamAt(state, 1);
  if (!seam) return false;
  const range = charAfter(state.doc, contentStart(seam.other));
  if (!range) return false;
  if (dispatch) {
    const tr = state.tr.delete(range[0], range[1]);
    removeIfEmpty(tr, seam.other.pos);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Whether the textblock at `pos` is laid out right to left. */
function isRtl(view: EditorView | undefined, pos: number): boolean {
  if (!view) return false;
  const el = view.nodeDOM(pos);
  if (!(el instanceof HTMLElement)) return false;
  return getComputedStyle(el).direction === 'rtl';
}

/**
 * ArrowLeft / ArrowRight (Shift: extend the selection) at a seam: the cursor skips the seam and
 * lands one character past it. `key` is the physical key; right-to-left text reverses it.
 */
export function arrowAcrossSeam(key: 'ArrowLeft' | 'ArrowRight', extend = false): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection)) return false;
    if (!extend && !sel.empty) return false; // a range collapses first (native)
    const $head = sel.$head;
    const own = textblockPos($head);
    if (own === null) return false;
    const forward = (key === 'ArrowRight') !== isRtl(view, own);
    if (forward ? $head.parentOffset !== $head.parent.content.size : $head.parentOffset !== 0) return false;
    const other = neighbourFragment(state.doc, own, forward ? 1 : -1);
    if (!other) return false;
    let target: number | null;
    if (other.node.content.size > 0) {
      target = forward ? charAfter(state.doc, contentStart(other))![1] : charBefore(state.doc, contentEnd(other))![0];
    } else {
      // An empty fragment (a list item's filler paragraph): the next text position past it.
      const found = Selection.findFrom(state.doc.resolve(forward ? other.pos + other.node.nodeSize : other.pos), forward ? 1 : -1, true);
      target = found ? found.head : null;
    }
    if (target === null) return false;
    if (dispatch) {
      const next = extend ? TextSelection.create(state.doc, sel.anchor, target) : TextSelection.create(state.doc, target);
      dispatch(state.tr.setSelection(next).scrollIntoView());
    }
    return true;
  };
}

/**
 * Enter at a seam (the end of a fragment followed by a continuation, or the start of a
 * continuation): the text after the seam becomes a paragraph (in a list item: an item) of its
 * own. The cursor goes to its start.
 */
export const enterAtSeam: Command = (state, dispatch) => {
  const after = seamAt(state, 1);
  const before = after ? null : seamAt(state, -1);
  if (!after && !before) return false;
  const tail = after ? after.other.pos : before!.own;
  if (dispatch) {
    const tr = state.tr;
    const $tail = state.doc.resolve(tail);
    tr.setNodeAttribute(tail, 'continuation', false);
    // The first paragraph of a continued list item: the item is split, so the item after the
    // seam is a new item (the list itself still continues).
    const parent = $tail.parent;
    if (parent.type.name === 'listItem' && $tail.index() === 0 && parent.attrs.continuation === true) {
      tr.setNodeAttribute($tail.before(), 'continuation', false);
    }
    tr.setSelection(TextSelection.create(tr.doc, tail + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

// Page boundaries without a continuation ---------------------------------------------------------

/**
 * Joins page `index` into the page before it and re-joins the fragments at the seam (lists split
 * over the two pages become one again). A JoinPagesStep: its undo brings the page back (with its
 * pid and objects) wherever its first content is by then. False when the pages can't be joined.
 */
function joinPages(tr: Transaction, index: number): boolean {
  const b = pageAt(tr.doc, index)!;
  if (tr.maybeStep(new JoinPagesStep(b.pos, 1)).failed) return false;
  rejoinContinuations(tr, b.pos - 1);
  return true;
}

/**
 * Runs `commands` (the first that applies) on the document of `tr` with the cursor at `head`, and
 * adds its steps and selection to `tr`. False when none applied.
 */
function runOn(tr: Transaction, head: number, commands: Command[]): boolean {
  const temp = EditorState.create({ doc: tr.doc, selection: TextSelection.create(tr.doc, head) });
  for (const command of commands) {
    let result: Transaction | null = null;
    if (!command(temp, (t) => (result = t))) continue;
    const done = result as Transaction | null;
    if (!done) return false;
    for (const step of done.steps) tr.step(step);
    tr.setSelection(done.selection.map(tr.doc, StepMap.empty));
    return true;
  }
  return false;
}

/**
 * After a page `keep` was joined into the page before it: if it carried objects or markers, it
 * comes back after the page-level block holding the cursor (or as a placeholder page with an empty
 * paragraph), keeping its pid and attributes. A PageBreakStep (restorePageAt), not a plain split:
 * pagination soon moves that boundary (join + split), and the undo must still remove exactly this
 * page, or the page's objects would come back twice (review finding PGR-2).
 */
function restorePage(tr: Transaction, keep: PMNode): void {
  if (!carriesPageData(keep)) return;
  restorePageAt(tr, tr.selection.head, keep.attrs);
}

/**
 * Backspace at the start of a page's flow (not at a continuation): at a manual page the section
 * break goes (removeSectionBreak); at an auto page the pages are joined and joinBackward runs.
 */
export const backspaceAtPageStart: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || !atPageFlowStart(sel.$head)) return false;
  const index = sel.$head.index(0);
  if (index === 0) return false;
  const own = textblockPos(sel.$head);
  if (own !== null && state.doc.nodeAt(own)?.attrs.continuation === true) return false; // backspaceAtSeam's
  const page = pageAt(state.doc, index)!;
  if (!isAutoPage(page.node)) return removeSectionBreak(index)(state, dispatch);
  const tr = state.tr;
  if (joinPages(tr, index) && runOn(tr, tr.mapping.map(sel.head), [joinBackward])) {
    restorePage(tr, page.node);
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  }
  // Nothing to join with (a table, an atom): select the block before, as selectNodeBackward
  // does inside a page, without joining the pages.
  return selectAcross(state, dispatch, pageAt(state.doc, index - 1)!, -1);
};

/** Selects the last (dir -1) or first (dir 1) block of `page`, when it is selectable. */
function selectAcross(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, page: NonNullable<ReturnType<typeof pageAt>>, dir: -1 | 1): boolean {
  const block = dir === -1 ? page.node.lastChild : page.node.firstChild;
  if (!block || !NodeSelection.isSelectable(block)) return false;
  const pos = dir === -1 ? page.contentEnd - block.nodeSize : page.contentStart;
  if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView());
  return true;
}

/**
 * Delete at the end of a page's flow (not before a continuation): before a manual page the
 * section break goes; before an auto page the pages are joined and joinForward runs.
 */
export const deleteAtPageEnd: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || !atPageFlowEnd(sel.$head)) return false;
  const index = sel.$head.index(0);
  const next = pageAt(state.doc, index + 1);
  if (!next) return false;
  const own = textblockPos(sel.$head);
  if (own !== null && neighbourFragment(state.doc, own, 1)) return false; // deleteAtSeam's
  if (!isAutoPage(next.node)) return removeSectionBreak(index + 1)(state, dispatch);
  const tr = state.tr;
  if (joinPages(tr, index + 1) && runOn(tr, tr.mapping.map(sel.head), [joinForward])) {
    restorePage(tr, next.node);
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  }
  return selectAcross(state, dispatch, next, 1);
};

// Joins at a split paragraph's head ------------------------------------------------------------

/**
 * Whether joining the textblock at `pos` (the head of a split block) with the textblock `other`
 * right before or after it moves it into another structure (a list item, a heading, a quote), which
 * the fragments after the seam would not follow: they are not same-type siblings.
 */
function joinMovesHead(doc: PMNode, pos: number, other: number | null): boolean {
  if (fragmentChain(doc, pos).length < 2) return false;
  if (other === null) return true;
  const $a = doc.resolve(pos);
  const $b = doc.resolve(other);
  return !($a.depth === $b.depth && $a.sameParent($b) && doc.nodeAt(pos)!.type === doc.nodeAt(other)!.type);
}

/**
 * Backspace at the start of a paragraph that continues on the next page (not a seam, not a page
 * start), where joinBackward would move it into the block before it (a list item, a heading): the
 * whole paragraph joins, as in an unsplit paragraph, and the undo survives pagination
 * (blockType.ts withChainsJoined; review finding PGR-4).
 */
export const joinBackwardAtHead: Command = (state, dispatch, view) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || sel.$head.parentOffset !== 0) return false;
  const own = textblockPos(sel.$head);
  if (own === null) return false;
  const $own = state.doc.resolve(own);
  const before = $own.nodeBefore?.isTextblock ? own - $own.nodeBefore.nodeSize : null;
  if (!joinMovesHead(state.doc, own, before)) return false;
  return withChainsJoined(joinBackward)(state, dispatch, view);
};

/**
 * Delete at the end of a textblock whose next textblock (the one joinForward pulls in) is the head
 * of a split paragraph and would move into this block's structure: the whole paragraph joins
 * (joinBackwardAtHead's counterpart).
 */
export const joinForwardBeforeHead: Command = (state, dispatch, view) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || sel.$head.parentOffset !== sel.$head.parent.content.size) return false;
  const own = textblockPos(sel.$head);
  if (own === null) return false;
  const found = Selection.findFrom(state.doc.resolve(own + sel.$head.parent.nodeSize), 1, true);
  const next = found && found.$head.index(0) === sel.$head.index(0) ? textblockPos(found.$head) : null;
  if (next === null || !joinMovesHead(state.doc, next, own)) return false;
  return withChainsJoined(joinForward, () => [next])(state, dispatch, view);
};

// Typing at a continuation's start ----------------------------------------------------------------

/**
 * handleTextInput: text typed in a continuation fragment while the text before the cursor there is
 * one word at most. The start of a continuation is the middle of a paragraph to the author, so the
 * markdown input rules that match at a textblock's start ('# ', '- ', '1. ', '> ', '```', '---')
 * must not fire there (review finding PGR-9): the text is inserted directly, ahead of the input
 * rules. At the very start, with no stored marks, it takes the marks of the text before the seam,
 * as in an unsplit paragraph (PGR-13: after ArrowLeft or a click there too). False elsewhere.
 */
export function continuationTextInput(view: EditorView, from: number, to: number, text: string): boolean {
  const { state } = view;
  if (view.composing) return false;
  const $from = state.doc.resolve(from);
  const parent = $from.parent;
  if (!parent.isTextblock || parent.attrs.continuation !== true || !$from.sameParent(state.doc.resolve(to))) return false;
  const before = parent.textBetween(0, $from.parentOffset, undefined, LEAF);
  // Every block-start rule needs at most one word and one space (e.g. "  1. ", "```js ").
  if (!/^\s*\S*\s?$/.test(before + text)) return false;
  const tr = state.tr;
  if ($from.parentOffset === 0 && !state.storedMarks) {
    const other = neighbourFragment(state.doc, $from.before(), -1);
    if (other && other.node.content.size > 0) tr.setStoredMarks(state.doc.resolve(contentEnd(other)).marks());
  }
  view.dispatch(tr.insertText(text, from, to).scrollIntoView());
  return true;
}

// Keymap -------------------------------------------------------------------------------------

/**
 * Seam editing keys (plan §4.8). Priority above TipTap's core keymap and the list item keymap
 * (Enter); ColumnNavigation (ArrowUp/ArrowDown) doesn't overlap.
 */
export const SeamEditing = Extension.create({
  name: 'hbSeamEditing',
  priority: 1100,

  addKeyboardShortcuts() {
    const run = (command: Command) => () => command(this.editor.state, this.editor.view.dispatch, this.editor.view);
    const backspace = run(
      (state, dispatch, view) => backspaceAtSeam(state, dispatch, view) || backspaceAtPageStart(state, dispatch, view) || joinBackwardAtHead(state, dispatch, view),
    );
    const del = run((state, dispatch, view) => deleteAtSeam(state, dispatch, view) || deleteAtPageEnd(state, dispatch, view) || joinForwardBeforeHead(state, dispatch, view));
    const wordBack = run(deleteWordAtSeam(-1));
    const wordForward = run(deleteWordAtSeam(1));
    return {
      Backspace: backspace,
      'Shift-Backspace': backspace,
      Delete: del,
      'Mod-Backspace': wordBack,
      'Alt-Backspace': wordBack,
      'Mod-Delete': wordForward,
      'Alt-Delete': wordForward,
      ArrowLeft: run(arrowAcrossSeam('ArrowLeft')),
      ArrowRight: run(arrowAcrossSeam('ArrowRight')),
      'Shift-ArrowLeft': run(arrowAcrossSeam('ArrowLeft', true)),
      'Shift-ArrowRight': run(arrowAcrossSeam('ArrowRight', true)),
      Enter: run(enterAtSeam),
    };
  },

  // Ahead of the input rules of the lower-priority node extensions (heading, lists, quote, code).
  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey('hbContinuationInput'), props: { handleTextInput: continuationTextInput } })];
  },
});
