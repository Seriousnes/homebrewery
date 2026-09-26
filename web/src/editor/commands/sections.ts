// Section commands (plan §4.1, §6.1, P4.6).
//
// A section starts at a manual page and runs over the auto pages pagination creates after it.
// Its settings (SECTION_ATTRS: columns, pageNumber, footer, classes, style) live on its first
// page; the section sync (pagination/sections.ts, part of the Pagination extension) copies them
// to the auto pages, outside the undo history.
//
//   insertPageBreak      Mod-Enter: a manual page break at the cursor. The page is split there
//                        and the new page starts a section with the same settings. At a page
//                        boundary no page is split: the auto page after it becomes the section
//                        start. At the end of a section, or at the start of a manual page, a new
//                        page with an empty paragraph is added (a blank page).
//   removeSectionBreak   Backspace at the start of a manual page (commands/continuation.ts): the
//                        page becomes an auto page of the section before it, and pagination pulls
//                        its content back.
//   setSectionAttrs      the inspector: settings of the section at the cursor (or of a page).
//
// Every command is one transaction in the history (one undo step). Commands that change which
// page starts a section write that page's settings themselves, in the history, so an undo gives
// the section its own settings back (the sync alone would have overwritten them). They change
// page structure with PageBreakStep (pagination/pageSteps.ts), whose undo and redo find their
// place again after pagination has joined or split the pages involved.
import { Extension } from '@tiptap/core';
import type { Attrs, Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Selection, type Command, type EditorState, type Transaction } from '@tiptap/pm/state';
import { canSplit } from '@tiptap/pm/transform';
import { PageBreakStep, autoPageAttrs, isAutoPage, normalizeCut, pageAt, pageIndexAt, sameSectionValue, secondPartAttrs, sectionStartIndex } from '../pagination';
import { SECTION_ATTRS, type PageAttrs } from '../schema/nodes/page';

/** Section settings (the page attributes SECTION_ATTRS names). */
export type SectionSettings = Partial<Pick<PageAttrs, (typeof SECTION_ATTRS)[number]>>;

export const SECTION_SETTINGS: readonly (keyof SectionSettings)[] = SECTION_ATTRS;

/** A copy of the section settings of `page`. */
export function sectionSettings(page: PMNode): Required<SectionSettings> {
  const out: Record<string, unknown> = {};
  for (const key of SECTION_ATTRS) {
    const value = page.attrs[key] as unknown;
    out[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  return out as Required<SectionSettings>;
}

/** Whether `value` is a valid value for section setting `key` (schema types, manifest enums). */
export function isValidSectionValue(key: string, value: unknown): boolean {
  switch (key) {
    case 'columns':
      return value === null || value === 1 || value === 2;
    case 'pageNumber':
      return typeof value === 'boolean';
    case 'footer':
    case 'style':
      return value === null || typeof value === 'string';
    case 'classes':
      return Array.isArray(value) && value.every((c) => typeof c === 'string');
    default:
      return false;
  }
}

/** The page index the selection's head is on. */
export const selectionPageIndex = (state: EditorState): number => pageIndexAt(state.doc, state.selection.head);

/** Index of the first page of the section at the cursor, or of page `pageIndex`. */
export function sectionStartAt(state: EditorState, pageIndex?: number): number {
  return sectionStartIndex(state.doc, pageIndex ?? selectionPageIndex(state));
}

/**
 * Sets the settings of the section the cursor is in (or of page `pageIndex`'s section) on the
 * section's first page; the sync copies them to its auto pages. Unknown keys and invalid values
 * make the command fail (nothing changes). One undo step.
 */
export function setSectionAttrs(attrs: SectionSettings, pageIndex?: number): Command {
  return (state, dispatch) => {
    const entries = Object.entries(attrs);
    if (entries.length === 0 || entries.some(([key, value]) => !isValidSectionValue(key, value))) return false;
    if (pageIndex !== undefined && (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= state.doc.childCount)) return false;
    const head = pageAt(state.doc, sectionStartAt(state, pageIndex))!;
    if (dispatch) {
      const tr = state.tr;
      for (const [key, value] of entries) {
        if (!sameSectionValue(head.node.attrs[key], value)) tr.setNodeAttribute(head.pos, key, Array.isArray(value) ? [...value] : value);
      }
      if (tr.docChanged) dispatch(tr);
    }
    return true;
  };
}

/** Whether `$pos` is at the very start of its page's flow (first position of the first block). */
export function atPageFlowStart($pos: ResolvedPos): boolean {
  if ($pos.depth < 1) return false;
  if ($pos.depth > 1 && $pos.parentOffset !== 0) return false;
  for (let d = 1; d < $pos.depth; d++) if ($pos.index(d) !== 0) return false;
  return $pos.depth > 1 || $pos.index(1) === 0;
}

/** Whether `$pos` is at the very end of its page's flow (last position of the last block). */
export function atPageFlowEnd($pos: ResolvedPos): boolean {
  if ($pos.depth < 1) return false;
  if ($pos.depth > 1 && $pos.parentOffset !== $pos.parent.content.size) return false;
  for (let d = 1; d < $pos.depth; d++) if ($pos.index(d) !== $pos.node(d).childCount - 1) return false;
  return $pos.depth > 1 || $pos.index(1) === $pos.node(1).childCount;
}

/**
 * Makes auto page `index` the first page of a section (its settings stay: they are its section's).
 * The blocks it starts with are no longer continuations (content never flows across a section
 * start). Returns false when the page isn't an auto page.
 */
export function makeSectionStart(tr: Transaction, index: number): boolean {
  const page = pageAt(tr.doc, index);
  if (!page || index === 0 || !isAutoPage(page.node)) return false;
  if (tr.maybeStep(new PageBreakStep(page.contentStart, { ...page.node.attrs, kind: 'manual' })).failed) return false;
  for (let node = page.node.firstChild, pos = page.contentStart; node && !node.isText && node.attrs.continuation === true; node = node.firstChild, pos += 1) {
    tr.setNodeAttribute(pos, 'continuation', false);
  }
  return true;
}

/** Attributes of a new manual page that starts a section with the settings of `src`'s section. */
function manualPageAttrs(src: Attrs): Attrs {
  return { ...autoPageAttrs(src), kind: 'manual' };
}

/** Node types a page break may split through (textblocks, lists, quotes, theme blocks). */
const SPLITTABLE = new Set(['paragraph', 'heading', 'codeBlock', 'listItem', 'bulletList', 'orderedList', 'blockquote', 'themeBlock', 'definitionList', 'definitionTerm', 'definitionDesc']);

/**
 * Where a page break at `pos` goes: `pos` lifted out of nodes a break can't split (tables, raw
 * HTML…: after the outermost of them) and off the edges of nodes (the start of a paragraph is the
 * position before it).
 */
function breakPoint(doc: PMNode, pos: number): number {
  let $pos = doc.resolve(pos);
  for (let d = 2; d <= $pos.depth; d++) {
    if (!SPLITTABLE.has($pos.node(d).type.name)) {
      $pos = doc.resolve($pos.after(d));
      break;
    }
  }
  return normalizeCut(doc, $pos.pos);
}

/**
 * Mod-Enter: a manual page break at the cursor (a selection is deleted first). See the top of
 * this file. The cursor ends at the start of the new section. Fails in code blocks (Mod-Enter
 * leaves them there) and without a position in a page.
 */
export const insertPageBreak: Command = (state, dispatch) => {
  if (state.selection.$from.parent.type.spec.code) return false;
  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  if (tr.selection.$from.depth < 1) return false;
  const cut = breakPoint(tr.doc, tr.selection.from);
  const $cut = tr.doc.resolve(cut);
  const index = $cut.index(0);
  const page = pageAt(tr.doc, index)!;
  const next = pageAt(tr.doc, index + 1);
  const schema = tr.doc.type.schema;
  const toStart = (pageIndex: number) => {
    const target = pageAt(tr.doc, pageIndex)!;
    tr.setSelection(Selection.near(tr.doc.resolve(target.contentStart)));
  };

  if (cut <= page.contentStart) {
    if (isAutoPage(page.node)) {
      // The break falls on the page boundary: this page starts the section.
      if (!makeSectionStart(tr, index)) return false;
    } else {
      // Start of a section: a blank page before the content (it keeps the page's markers and
      // objects: a cover stays a cover); the content moves to a new page.
      tr.insert(page.contentStart, schema.nodes.paragraph!.create());
      tr.split(page.contentStart + 2, 1, [{ type: page.node.type, attrs: manualPageAttrs(page.node.attrs) }]);
      toStart(index + 1);
    }
  } else if (cut >= page.contentEnd) {
    if (next && isAutoPage(next.node)) {
      // The break falls on the page boundary (a seam: a split paragraph becomes two).
      if (!makeSectionStart(tr, index + 1)) return false;
    } else {
      // End of a section (or the document): a new page with an empty paragraph.
      tr.insert(page.pos + page.node.nodeSize, schema.nodes.page!.create(manualPageAttrs(page.node.attrs), schema.nodes.paragraph!.create()));
    }
    toStart(index + 1);
  } else {
    const attrs = manualPageAttrs(page.node.attrs);
    const inner: { type: PMNode['type']; attrs: Attrs }[] = [];
    for (let d = 2; d <= $cut.depth; d++) inner.push({ type: $cut.node(d).type, attrs: secondPartAttrs($cut.node(d), $cut.index(d)) });
    // canSplit refuses isolating nodes (the page): check the levels inside it. A page with blocks
    // on both sides of the cut is always valid. When the inner levels can't split (a list item
    // would start with a nested list), the break goes before the page-level block instead.
    let at = cut;
    if ($cut.depth > 1 && !canSplit(tr.doc, cut, $cut.depth - 1, inner)) {
      at = $cut.before(2);
      if (at <= page.contentStart) return false;
    }
    if (tr.maybeStep(new PageBreakStep(at, attrs)).failed) return false;
    toStart(index + 1);
  }
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Removes the section break at manual page `pageIndex` (default: the cursor's page): it becomes
 * an auto page of the section before it, with that section's settings. Pagination then pulls its
 * content onto the page before it, and may merge the page away. Fails for the first page and for
 * auto pages.
 *
 * The change is a PageBreakStep, not attribute steps: an attribute step on a page that pagination
 * later joins is dropped from the history, so undo couldn't bring the section back. The step's
 * undo re-creates the page wherever its first content is by then.
 */
export function removeSectionBreak(pageIndex?: number): Command {
  return (state, dispatch) => {
    const index = pageIndex ?? selectionPageIndex(state);
    const page = pageAt(state.doc, index);
    if (!page || index === 0 || isAutoPage(page.node)) return false;
    const head = pageAt(state.doc, sectionStartIndex(state.doc, index - 1))!;
    const tr = state.tr;
    if (tr.maybeStep(new PageBreakStep(page.contentStart, { ...page.node.attrs, ...sectionSettings(head.node), kind: 'auto' })).failed) return false;
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    hbSections: {
      /** A manual page break at the cursor (Mod-Enter): the new page starts a section. */
      insertPageBreak: () => ReturnType;
      /** Settings of the section at the cursor, or of page `pageIndex`'s section. */
      setSectionAttrs: (attrs: SectionSettings, pageIndex?: number) => ReturnType;
      /** The manual page at the cursor (or page `pageIndex`) joins the section before it. */
      removeSectionBreak: (pageIndex?: number) => ReturnType;
    };
  }
}

/**
 * Section commands and Mod-Enter. Priority above TipTap's core keymap (whose Mod-Enter leaves a
 * code block; insertPageBreak leaves code blocks to it).
 */
export const Sections = Extension.create({
  name: 'hbSections',
  priority: 1100,

  addCommands() {
    return {
      insertPageBreak:
        () =>
        ({ state, dispatch }) =>
          insertPageBreak(state, dispatch),
      setSectionAttrs:
        (attrs, pageIndex) =>
        ({ state, dispatch }) =>
          setSectionAttrs(attrs, pageIndex)(state, dispatch),
      removeSectionBreak:
        (pageIndex) =>
        ({ state, dispatch }) =>
          removeSectionBreak(pageIndex)(state, dispatch),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => insertPageBreak(this.editor.state, this.editor.view.dispatch),
    };
  },
});
