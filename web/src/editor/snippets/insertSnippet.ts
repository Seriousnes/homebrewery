// Inserting a markdown snippet (plan §6.3). Theme generators and user snippets return
// Homebrewery markdown; it goes through the importer (hbfmToDoc: the import lane's safe HBFM
// renderer without marked-variables, DOMPurify, markMultilineDefinitionLists, lifting of
// markers, footers, page numbers and positioned objects, then the schema's parse rules), so a
// snippet becomes exactly what importing its text would give (the S3 fixtures).
//
// - A snippet with a `\page` line becomes new MANUAL pages after the current section (a blank
//   current page is replaced instead: an empty flow and nothing of its own, no objects, markers,
//   id or attributes). Pages left blank by the split are dropped.
// - Any other snippet is inserted at the selection: a single plain paragraph merges into the
//   current one, blocks replace an empty paragraph or are inserted around the selection. What
//   the importer lifted to page attributes goes to the current page (markers, objects) or its
//   section (footer, page number). The cursor ends after the snippet, as upstream's did: when
//   the snippet ends with a block container (theme block, table, toc) and nothing follows the
//   empty paragraph it went into, that paragraph stays after it for the cursor; when text
//   follows, the cursor goes to its start.
// Either way the change is one transaction: one undo step, history closed before it.
import { selectionToInsertionEnd, type Editor, type JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { Slice, type Fragment, type Node as PMNode, type ResolvedPos, type Schema } from '@tiptap/pm/model';
import { Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Probe } from '../canvas/probe';
import type { LoadThemeChainOptions } from '../canvas/themeLoader';
import { hbfmToDoc } from '../import/hbfmToDoc';
import { setPageAttr } from '../objects/pageAttrStep';
import { isAutoPage, pageIndexAt } from '../pagination/boundary';
import { addPageMarkers, hasEmptyFlow, isBlankPage, isReplaceablePage, pagePos, sectionBounds, setSectionAttrs } from './sections';

/** Matches a `\page` line (upstream's page split). */
export const PAGE_LINE = /^\\page\b/m;

export type ProbeFactory = (theme: string, css: string, lang: string) => Promise<Probe>;

export interface SnippetToDocOptions {
  /** The brew's theme: the importer lays the snippet out with it to find page objects. */
  theme: string;
  /** The brew's language for the layout probe (a snippet has no metadata; default 'en'). */
  lang?: string;
  /** Probe factory (a cached probe, or mountInlineProbe in jsdom). */
  probe?: ProbeFactory;
  themeOptions?: LoadThemeChainOptions;
  /** Fonts wait before lifting (ms). */
  fontsTimeoutMs?: number;
}

export interface SnippetDoc {
  /** One page per `\page` chunk. */
  pages: JSONContent[];
  /** CSS the snippet carried (```css block, <style> tags): for the brew's style. */
  style: string;
  /** Whether the snippet has `\page` lines (insert as pages). */
  pageSnippet: boolean;
}

/** Converts snippet markdown with the importer. Needs a DOM (a probe). */
export async function snippetToDoc(markdown: string, options: SnippetToDocOptions): Promise<SnippetDoc> {
  const result = await hbfmToDoc(markdown, {
    theme: options.theme,
    ...(options.probe ? { probe: (theme: string, css: string, lang: string) => options.probe!(theme, css, options.lang ?? lang) } : {}),
    ...(options.themeOptions ? { themeOptions: options.themeOptions } : {}),
    ...(options.fontsTimeoutMs !== undefined ? { fontsTimeoutMs: options.fontsTimeoutMs } : {}),
  });
  return { pages: result.doc.content ?? [], style: result.style, pageSnippet: PAGE_LINE.test(markdown) };
}

// ---------------------------------------------------------------------------------------------
// Transactions (pure ProseMirror; unit-tested without a layout)
// ---------------------------------------------------------------------------------------------

const PARAGRAPH_DEFAULTS: Record<string, unknown> = { align: null, continuation: false, classes: [], style: null, id: null, attributes: {} };

/** A paragraph whose attributes are all defaults (its text can merge into another paragraph). */
function isPlainParagraph(node: PMNode): boolean {
  if (node.type.name !== 'paragraph') return false;
  return Object.entries(node.attrs).every(([k, v]) => !(k in PARAGRAPH_DEFAULTS) || JSON.stringify(PARAGRAPH_DEFAULTS[k]) === JSON.stringify(v));
}

/** A collapsed selection at the head when the selection spans pages. */
function collapseAcrossPages(tr: Transaction): void {
  const { $from, $to } = tr.selection;
  if ($from.index(0) !== $to.index(0)) tr.setSelection(Selection.near(tr.selection.$head));
}

/**
 * Inserts block content at the selection (see the file comment). Returns whether the document
 * changed. The selection ends after the inserted content.
 */
export function insertFragment(tr: Transaction, fragment: Fragment): boolean {
  if (fragment.size === 0) return false;
  collapseAcrossPages(tr);
  const before = tr.steps.length;
  const { $from, empty } = tr.selection;
  const first = fragment.firstChild;
  const inTextblock = $from.parent.inlineContent && !$from.parent.type.spec.code;
  if (fragment.childCount === 1 && first && isPlainParagraph(first) && inTextblock) {
    // One plain paragraph: its inline content goes into the current textblock.
    tr.replaceSelection(new Slice(fragment, 1, 1));
  } else if (empty && $from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth >= 2) {
    const container = $from.node($from.depth - 1);
    const last = fragment.lastChild;
    if (last && !last.isTextblock && $from.index($from.depth - 1) === container.childCount - 1) {
      // The blocks end with a container (theme block, table, toc) and nothing follows: the empty
      // paragraph stays after them and keeps the cursor (upstream's cursor ended on the line
      // after the inserted text), so the next snippet doesn't land inside this one.
      tr.insert($from.before(), fragment);
      return true;
    }
    // An empty paragraph (or heading) is replaced by the blocks.
    tr.replaceWith($from.before(), $from.after(), fragment);
  } else {
    tr.replaceSelection(new Slice(fragment, 0, 0));
  }
  if (tr.steps.length === before) {
    // Nothing fitted here (e.g. a table inside a table cell): after the page's top-level block.
    const $pos = tr.selection.$from;
    if ($pos.depth < 2) return false;
    tr.insert($pos.after(2), fragment);
  }
  if (tr.steps.length === before) return false;
  placeCursorAfterInsertion(tr);
  return true;
}

/** prosemirror-gapcursor's GapCursor.valid (public in the code, missing from its typings). */
const gapCursorValid = (GapCursor as unknown as { valid?: ($pos: ResolvedPos) => boolean }).valid;

/**
 * The cursor after inserted content, as upstream's cursor ended after the inserted text: after a
 * block container (theme block, table, toc) it goes after the container, not into its last
 * paragraph, so the next snippet doesn't land inside the one before: the start of the paragraph
 * that follows, or a gap cursor where ProseMirror allows one. Otherwise the end of the content.
 */
function placeCursorAfterInsertion(tr: Transaction): void {
  const map = tr.steps[tr.steps.length - 1]!.getMap();
  let end = -1;
  map.forEach((_oldStart, _oldEnd, _newStart, newEnd) => {
    end = Math.max(end, newEnd);
  });
  if (end < 0) {
    selectionToInsertionEnd(tr, tr.steps.length - 1, -1);
    return;
  }
  const $end = tr.doc.resolve(end);
  const before = $end.nodeBefore;
  if (before && before.isBlock && !before.isTextblock) {
    const after = $end.nodeAfter;
    if (after?.isTextblock) {
      tr.setSelection(TextSelection.create(tr.doc, end + 1));
      return;
    }
    if (gapCursorValid?.($end)) {
      tr.setSelection(new GapCursor($end));
      return;
    }
  }
  selectionToInsertionEnd(tr, tr.steps.length - 1, -1);
}

/** Unique object ids for objects added to a page that already has some. */
function withUniqueIds(existing: readonly { id?: unknown }[], added: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const used = new Set(existing.map((o) => String(o.id)));
  let n = existing.length;
  return added.map((object) => {
    let id = typeof object.id === 'string' && !used.has(object.id) ? object.id : '';
    while (!id || used.has(id)) id = `o${++n}`;
    used.add(id);
    return { ...object, id };
  });
}

/**
 * Applies what the importer lifted from a one-page snippet to the page holding the selection:
 * markers and objects to that page, footer and page number to its section.
 */
export function mergeLiftedPageAttrs(tr: Transaction, snippetPage: PMNode): boolean {
  const index = pageIndexAt(tr.doc, tr.selection.from);
  const a = snippetPage.attrs as { markers?: string[]; objects?: Record<string, unknown>[]; footer?: string | null; pageNumber?: boolean };
  let changed = false;
  if (a.markers?.length) changed = addPageMarkers(tr, index, a.markers) || changed;
  if (a.objects?.length) {
    const page = tr.doc.child(index);
    const current = (page.attrs.objects as Record<string, unknown>[] | undefined) ?? [];
    setPageAttr(tr, pagePos(tr.doc, index), 'objects', [...current, ...withUniqueIds(current, a.objects)]);
    changed = true;
  }
  const section: Record<string, unknown> = {};
  if (a.footer) section.footer = a.footer;
  if (a.pageNumber) section.pageNumber = true;
  if (Object.keys(section).length) changed = setSectionAttrs(tr, index, section) || changed;
  return changed;
}

/** The transaction that inserts a one-page snippet at the selection, or null if it adds nothing. */
export function insertBlocksTr(state: EditorState, snippetPage: PMNode): Transaction | null {
  const tr = state.tr;
  collapseAcrossPages(tr);
  let changed = mergeLiftedPageAttrs(tr, snippetPage);
  if (!hasEmptyFlow(snippetPage)) changed = insertFragment(tr, snippetPage.content) || changed;
  if (!changed) return null;
  return closeHistory(tr).scrollIntoView();
}

/** Section settings a blank page being replaced passes on to the first inserted page. */
const CARRIED: ReadonlyArray<[name: string, isDefault: (v: unknown) => boolean]> = [
  ['columns', (v) => v === null || v === undefined],
  ['pageNumber', (v) => !v],
  ['footer', (v) => !v],
  ['classes', (v) => !Array.isArray(v) || v.length === 0],
  ['style', (v) => !v],
];

/**
 * The transaction that inserts snippet pages as manual pages after the current section, or in
 * place of the current page when it is blank (isReplaceablePage: an empty flow, no objects,
 * markers, id or attributes) and no auto page follows it (its section settings carry over to the
 * first inserted page where the snippet sets none). Blank pages at
 * the start of `pages` are dropped, and so are blank pages at the end, except one when nothing
 * follows the inserted pages: a snippet ending with `\page` ("the text goes on after this, on a
 * new page", like the covers) then leaves that page for the cursor, as upstream did. Otherwise
 * the cursor goes to the first inserted page. Null when nothing is left.
 */
export function insertPagesTr(state: EditorState, pages: readonly PMNode[]): { tr: Transaction; count: number } | null {
  const schema: Schema = state.schema;
  let list = pages.filter((p) => p.type === schema.nodes.page);
  let trailingBlank: PMNode | null = null;
  while (list.length && isBlankPage(list[list.length - 1]!)) {
    trailingBlank = list[list.length - 1]!;
    list = list.slice(0, -1);
  }
  while (list.length && isBlankPage(list[0]!)) list = list.slice(1);
  if (!list.length) return null;
  list = list.map((p) => p.type.create({ ...p.attrs, kind: 'manual', pid: null }, p.content, p.marks));
  const contentPages = list.length;

  const tr = state.tr;
  // The head's page (with everything selected, the head is after the last page: that page).
  const index = pageIndexAt(tr.doc, tr.selection.head);
  const { last } = sectionBounds(tr.doc, index);
  const current = tr.doc.child(index);
  const start = pagePos(tr.doc, index);
  const atEnd = last === tr.doc.childCount - 1;
  const keepBlank = trailingBlank !== null && atEnd;
  if (keepBlank) list.push(trailingBlank!.type.create({ ...trailingBlank!.attrs, kind: 'manual', pid: null }, trailingBlank!.content));
  let insertAt: number;
  if (last === index && !isAutoPage(current) && isReplaceablePage(current)) {
    const firstPage = list[0]!;
    const attrs: Record<string, unknown> = { ...firstPage.attrs };
    for (const [name, isDefault] of CARRIED) if (isDefault(attrs[name]) && !isDefault(current.attrs[name])) attrs[name] = current.attrs[name];
    list[0] = firstPage.type.create(attrs, firstPage.content, firstPage.marks);
    tr.replaceWith(start, start + current.nodeSize, list);
    insertAt = start;
  } else {
    insertAt = pagePos(tr.doc, last) + tr.doc.child(last).nodeSize;
    tr.insert(insertAt, list);
  }
  const cursorPage = pageIndexAtPos(tr.doc, insertAt + 1) + (keepBlank ? contentPages : 0);
  tr.setSelection(Selection.near(tr.doc.resolve(pagePos(tr.doc, cursorPage) + 1), 1));
  return { tr: closeHistory(tr).scrollIntoView(), count: list.length };
}

/** Index of the page containing `pos`. */
const pageIndexAtPos = (doc: PMNode, pos: number): number => doc.resolve(Math.min(pos, doc.content.size)).index(0);

// ---------------------------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------------------------

export interface InsertSnippetResult {
  kind: 'blocks' | 'pages' | 'nothing';
  /** Pages inserted (kind 'pages'). */
  pages: number;
  /** CSS the snippet carried; the caller adds it to the brew's style. */
  style: string;
}

/** Builds nodes from importer JSON, dropping pages the schema rejects. */
export function pagesFromJson(schema: Schema, pages: readonly JSONContent[]): PMNode[] {
  const out: PMNode[] = [];
  for (const json of pages) {
    try {
      const node = schema.nodeFromJSON(json);
      node.check();
      out.push(node);
    } catch {
      // A page the schema can't hold: skipped (the importer's JSON is schema-shaped already).
    }
  }
  return out;
}

/** Applies a converted snippet to the editor in one transaction. */
export function applySnippetDoc(editor: Editor, snippet: SnippetDoc): InsertSnippetResult {
  if (editor.isDestroyed) return { kind: 'nothing', pages: 0, style: snippet.style };
  const pages = pagesFromJson(editor.schema, snippet.pages);
  const state = editor.state;
  if (snippet.pageSnippet || pages.length > 1) {
    const inserted = insertPagesTr(state, pages);
    if (!inserted) return { kind: 'nothing', pages: 0, style: snippet.style };
    editor.view.dispatch(inserted.tr);
    return { kind: 'pages', pages: inserted.count, style: snippet.style };
  }
  const page = pages[0];
  const tr = page ? insertBlocksTr(state, page) : null;
  if (!tr) return { kind: 'nothing', pages: 0, style: snippet.style };
  editor.view.dispatch(tr);
  return { kind: 'blocks', pages: 0, style: snippet.style };
}

/** Converts and inserts snippet markdown (async: the importer lays it out first). */
export async function insertSnippet(editor: Editor, markdown: string, options: SnippetToDocOptions): Promise<InsertSnippetResult> {
  const snippet = await snippetToDoc(markdown, options);
  return applySnippetDoc(editor, snippet);
}

/** TextSelection at the start of page `index` (e.g. after a page break). */
export function selectPageStart(tr: Transaction, index: number): Transaction {
  return tr.setSelection(TextSelection.near(tr.doc.resolve(pagePos(tr.doc, index) + 1), 1));
}
