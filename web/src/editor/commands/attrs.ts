// Attribute edits for the inspector (P3.5, plan §6.2): every edit is validated first and, when
// valid, dispatched as ONE transaction that is its own undo step.
//
//   validate*          Pure checks for what an author types. They mirror the server
//                      (Homebrewery.Core DocInspector and CssPolicy) and the schema (SAFE_ATTR,
//                      RESERVED_CLASSES, normalizeStyle), so a valid edit never makes a save fail.
//   edit* / setAttribute / removeAttribute …
//                      ProseMirror-style commands `(state, dispatch?) → EditResult`: validation
//                      errors come back as `{ ok: false, error }` and nothing is dispatched.
//
// Rules shared with the other editor lanes:
// - Node attributes change through AttrSteps (tr.setNodeAttribute), never setNodeMarkup, so undo
//   survives pagination's join + split (review finding PG-2).
// - A block that pagination split is one block to the author: shared attributes (classes, style,
//   attributes) go to every fragment (fragmentChain), the id to the first fragment only (plan §3.4).
//   The pagination plugin's shareFragmentAttrs would copy them too; writing them here keeps the
//   commands correct in editors without pagination.
// - Section settings (SECTION_ATTRS) are written to the section's first (manual) page only. The
//   section sync (pagination/sections.ts, part of the Pagination extension) copies them to the
//   section's auto pages outside the undo history, so an edit and its undo are one step each.
//   Markers, page objects and page attributes belong to one page.
// - closeHistory: an inspector edit never merges into the typing before it.
import { closeHistory } from '@tiptap/pm/history';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { pageAt, sectionEndIndex, sectionStartIndex } from '../pagination/boundary';
import { setPageAttr } from '../objects/pageAttrStep';
import { fragmentChain } from '../pagination/fragments';
import { isAllowedAttribute, isAuthorClass, normalizeStyle, RESERVED_ATTRS, RESERVED_CLASSES, SAFE_ATTR } from '../schema/attrs';
import { normalizeMarkers, normalizePageObjects, SECTION_ATTRS, type PageAttrs, type PageObject } from '../schema/nodes/page';

// ─── Results ────────────────────────────────────────────────────────────────────────────────────

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };
/** The outcome of an edit command: invalid input (nothing dispatched), or whether the doc changed. */
export type EditResult = { ok: true; changed: boolean } | { ok: false; error: string };
export type Dispatch = (tr: Transaction) => void;

const valid = <T>(value: T): Validation<T> => ({ ok: true, value });
const invalid = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Meta on every transaction an inspector edit dispatches. */
export const INSPECTOR_META = 'hbInspector';

// ─── Limits (the server's) ──────────────────────────────────────────────────────────────────────

/** DocInspector.MaxClassLength. */
export const MAX_CLASS_LENGTH = 256;
/** CssPolicy.MaxLength. */
export const MAX_STYLE_LENGTH = 4096;
export const MAX_ID_LENGTH = 256;
export const MAX_FOOTER_LENGTH = 500;
export const MAX_ATTRIBUTE_VALUE_LENGTH = 4096;

const quote = (value: string, max = 40): string => `“${value.length > max ? `${value.slice(0, max - 1)}…` : value}”`;

// ─── Classes ────────────────────────────────────────────────────────────────────────────────────

/** One class name as an author typed it (a leading dot is dropped). */
export function validateClassName(raw: string): Validation<string> {
  const name = raw.trim().replace(/^\./, '');
  if (name === '') return invalid('Enter a class name.');
  // The server's char.IsWhiteSpace also counts U+0085 (review finding UI-11).
  if (/[\s\u0085]/.test(name)) return invalid(`${quote(name)} contains a space: a class name is one word.`);
  if (name.length > MAX_CLASS_LENGTH) return invalid(`Class names can be at most ${MAX_CLASS_LENGTH} characters.`);
  if (name.startsWith('#')) return invalid(`${quote(name)} is an id: use the Id field.`);
  if (/[:;]/.test(name)) return invalid(`${quote(name)} looks like a style declaration: use the Style field.`);
  if (/[\0{}<>"'`\\=]/.test(name)) return invalid(`${quote(name)} is not a class name.`);
  if (RESERVED_CLASSES.has(name)) return invalid(`${quote(name)} is added by the editor itself.`);
  if (!isAuthorClass(name)) return invalid(`${quote(name)} is reserved for the editor.`);
  return valid(name);
}

/**
 * Class names from free text: separated by spaces, commas (upstream's {{monster,frame}}) or dots
 * (".monster.frame"). Duplicates are dropped. The first invalid name is the error.
 */
export function parseClassInput(text: string): Validation<string[]> {
  const tokens = text
    .split(/[\s,]+/)
    .flatMap((token) => (token.startsWith('#') ? [token] : token.split('.')))
    .filter((token) => token !== '');
  if (tokens.length === 0) return invalid('Enter a class name.');
  const names: string[] = [];
  for (const token of tokens) {
    const result = validateClassName(token);
    if (!result.ok) return result;
    if (!names.includes(result.value)) names.push(result.value);
  }
  return valid(names);
}

/** A whole class list (e.g. after removing one): every entry valid, no duplicates. */
export function validateClassList(list: readonly string[]): Validation<string[]> {
  const names: string[] = [];
  for (const entry of list) {
    const result = validateClassName(entry);
    if (!result.ok) return result;
    if (!names.includes(result.value)) names.push(result.value);
  }
  return valid(names);
}

// ─── Style ──────────────────────────────────────────────────────────────────────────────────────

// A port of the server's CssPolicy (Homebrewery.Core/Documents/CssPolicy.cs), so a style the
// inspector accepts never fails a save (review finding UI-11). .NET's \s also matches U+0085.

/** CssPolicy.ScriptScheme: a javascript: or vbscript: URL (not a path segment such as /javascript:1.png). */
const SCRIPT_SCHEME = String.raw`(?<![\w/.-])(?:javascript|vbscript)[\s\u0085]*:`;
/** CssPolicy.BadCss: IE's expression() and behavior, -moz-binding, javascript:/vbscript: URLs. */
const UNSAFE_CSS = new RegExp(String.raw`(?<![a-z0-9-])expression[\s\u0085]*\(|(?<![a-z0-9-])(?:-ms-)?behavior[\s\u0085]*:|-moz-binding|${SCRIPT_SCHEME}`, 'i');
const SCRIPT_URL = new RegExp(SCRIPT_SCHEME, 'i');

/**
 * CssPolicy.Tokens: the CSS text without comments, read the way CSS tokenizes it: a backslash
 * escapes the next character, a quote starts a string that ends at the same quote or an unescaped
 * newline, and a comment start inside a string is text. Without `keepStrings` the strings'
 * contents are dropped (the quotes stay).
 */
function cssTokens(css: string, keepStrings: boolean): string {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === '\\') {
      out += c;
      if (i + 1 < css.length) out += css[++i];
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else if (c === '"' || c === "'") {
      const start = i;
      for (i++; i < css.length && css[i] !== c && css[i] !== '\n' && css[i] !== '\r' && css[i] !== '\f'; i++) {
        if (css[i] === '\\') i++;
      }
      out += keepStrings ? css.slice(start, Math.min(i + 1, css.length)) : c + c;
    } else {
      out += c;
    }
  }
  return out;
}

/** CssPolicy.Unescape: escapes (\6a, \:) resolved, NFKC-normalized. */
function unescapeCss(css: string): string {
  return css
    .replace(/\\(?:([0-9a-fA-F]{1,6})[\s\u0085]?|([\s\S]))/g, (_, hex: string | undefined, char: string | undefined) => {
      if (hex === undefined) return char ?? '';
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
    })
    .normalize('NFKC');
}

/** CSS text with comments removed and escapes (\6a, \:) resolved, for matching only (CssPolicy.Decode). */
export function decodeCss(css: string): string {
  return unescapeCss(cssTokens(css, true));
}

/**
 * Whether a style string holds script-capable CSS the server refuses (CssPolicy.Check):
 * expression(), behavior and -moz-binding outside strings, javascript:/vbscript: anywhere.
 */
export function isUnsafeCss(css: string): boolean {
  const code = cssTokens(css, false);
  const text = cssTokens(css, true);
  return UNSAFE_CSS.test(code) || UNSAFE_CSS.test(unescapeCss(code)) || SCRIPT_URL.test(text) || SCRIPT_URL.test(unescapeCss(text));
}

/**
 * Splits a declaration list at top-level semicolons. Quotes, parentheses (url(a;b)) and escapes
 * are respected; comments are removed. Empty parts are dropped.
 */
export function splitDeclarations(css: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoteChar: string | null = null;
  let current = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === '\\') {
      current += css.slice(i, i + 2);
      i++;
      continue;
    }
    if (quoteChar) {
      if (c === quoteChar || c === '\n') quoteChar = null;
      current += c;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      current += ' ';
      continue;
    }
    if (c === ';' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    if (c === '"' || c === "'") quoteChar = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** The text outside quotes and comments (for structural checks such as braces). */
function codeOutsideStrings(css: string): string {
  return cssTokens(css, false);
}

const DECLARATION = /^(?:--[\w-]+|-?[A-Za-z_][\w-]*)\s*:/;

/**
 * An inline style as typed ("color: red; margin: 0") → the stored form (normalizeStyle: the
 * browser's cssText, e.g. "color: red; margin: 0px;"), or null for an empty style. Declarations the
 * browser drops (unknown properties, invalid values), selectors, braces and unsafe CSS are errors:
 * storing them would lose them on the next round trip or fail the save.
 */
export function validateStyle(input: string, doc: Document | undefined = globalThis.document): Validation<string | null> {
  const text = input.trim();
  if (text === '') return valid(null);
  if (text.length > MAX_STYLE_LENGTH) return invalid(`Styles can be at most ${MAX_STYLE_LENGTH} characters.`);
  if (/[{}]/.test(codeOutsideStrings(text))) {
    return invalid('Enter declarations only (property: value;), without selectors or braces.');
  }
  if (isUnsafeCss(text)) return invalid('Styles must not contain expression(), javascript:, vbscript:, behavior or -moz-binding.');
  const rejected: string[] = [];
  for (const declaration of splitDeclarations(text)) {
    if (!DECLARATION.test(declaration)) rejected.push(declaration);
    else if (doc && normalizeStyle(declaration, doc) === null) rejected.push(declaration);
  }
  if (rejected.length === 1) return invalid(`Not valid CSS: ${quote(rejected[0]!)}.`);
  if (rejected.length > 1) return invalid(`Not valid CSS: ${rejected.slice(0, 3).map((d) => quote(d)).join(', ')}${rejected.length > 3 ? ' …' : ''}.`);
  const normalized = normalizeStyle(text, doc);
  if (normalized === null) return invalid('Not valid CSS.');
  if (normalized.length > MAX_STYLE_LENGTH) return invalid(`Styles can be at most ${MAX_STYLE_LENGTH} characters.`);
  if (isUnsafeCss(normalized)) return invalid('Styles must not contain expression(), javascript:, vbscript:, behavior or -moz-binding.');
  return valid(normalized);
}

// ─── Ids ────────────────────────────────────────────────────────────────────────────────────────

/** Page DOM ids: p1, p2, … (PageIndexIds). Reserved for every n, so a growing brew never clashes. */
const PAGE_ID = /^p\d+$/;

/** Where each id is used: node ids (headings included) and span mark ids, by position. */
export function collectIds(doc: PMNode): Map<string, number[]> {
  const ids = new Map<string, number[]>();
  const add = (id: unknown, pos: number) => {
    if (typeof id !== 'string' || id === '') return;
    const list = ids.get(id);
    if (list) list.push(pos);
    else ids.set(id, [pos]);
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      for (const mark of node.marks) add(mark.attrs.id, pos);
      return false;
    }
    add(node.attrs.id, pos);
    return true;
  });
  return ids;
}

/**
 * An id as typed → the stored id, or null for none. `isOwn(pos)` tells positions that belong to
 * the element being edited (its fragments, or the text of a span) so its own id is no duplicate.
 */
export function validateId(input: string, doc: PMNode, isOwn: (pos: number) => boolean = () => false): Validation<string | null> {
  const id = input.trim().replace(/^#/, '');
  if (id === '') return valid(null);
  if (/\s/.test(id)) return invalid('An id can’t contain spaces.');
  if (id.length > MAX_ID_LENGTH) return invalid(`Ids can be at most ${MAX_ID_LENGTH} characters.`);
  if (PAGE_ID.test(id)) return invalid(`${quote(id)} is reserved: pages use the ids p1, p2, p3 …`);
  const users = (collectIds(doc).get(id) ?? []).filter((pos) => !isOwn(pos));
  if (users.length > 0) return invalid(`Another element already uses the id ${quote(id)}.`);
  return valid(id);
}

// ─── Attributes ─────────────────────────────────────────────────────────────────────────────────

/**
 * The name of an HTML attribute for the generic `attributes` map (plan §3.5): data-*, aria-*,
 * title, lang, dir or role (SAFE_ATTR), lower-cased as HTML stores it, and not one the editor or
 * the node itself renders.
 */
export function validateAttributeName(raw: string, type?: string): Validation<string> {
  const name = raw.trim().toLowerCase();
  if (name === '') return invalid('Enter an attribute name.');
  if (!SAFE_ATTR.test(name)) return invalid('Allowed names: data-…, aria-…, title, lang, dir and role.');
  if (RESERVED_ATTRS.has(name)) return invalid(`${quote(name)} is used by the editor itself.`);
  if (!isAllowedAttribute(name, type)) return invalid(`This element has its own ${quote(name)} setting.`);
  return valid(name);
}

export function validateAttributeValue(value: string): Validation<string> {
  if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) return invalid(`Values can be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters.`);
  if (value.includes('\0')) return invalid('The value contains a NUL character.');
  return valid(value);
}

// ─── Section settings ───────────────────────────────────────────────────────────────────────────

export type SectionAttr = (typeof SECTION_ATTRS)[number];
export type SectionSettings = Pick<PageAttrs, SectionAttr>;
export type ColumnsSetting = PageAttrs['columns'];

/** Footer text as typed → the stored footer (null when empty). One line; surrounding spaces trimmed. */
export function validateFooter(input: string): Validation<string | null> {
  const footer = input.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (footer === '') return valid(null);
  if (footer.length > MAX_FOOTER_LENGTH) return invalid(`Footers can be at most ${MAX_FOOTER_LENGTH} characters.`);
  return valid(footer);
}

export function validateColumns(value: unknown): Validation<ColumnsSetting> {
  if (value === null || value === 1 || value === 2) return valid(value);
  return invalid('Columns must be 1, 2 or the theme’s default.');
}

/** The pages of the section that page `index` belongs to: its manual page and the auto pages after it. */
export function sectionRange(doc: PMNode, index: number): { start: number; end: number } {
  return { start: sectionStartIndex(doc, index), end: sectionEndIndex(doc, index) };
}

/** The section settings of page `index` (those of its section's manual page). */
export function sectionSettings(doc: PMNode, index: number): SectionSettings {
  const attrs = doc.child(sectionRange(doc, index).start).attrs as PageAttrs;
  return { columns: attrs.columns, pageNumber: attrs.pageNumber, footer: attrs.footer, classes: attrs.classes, style: attrs.style };
}

// ─── Markers ────────────────────────────────────────────────────────────────────────────────────

export const COVER_MARKERS = ['frontCover', 'insideCover', 'partCover', 'backCover'] as const;
export type CoverMarker = (typeof COVER_MARKERS)[number];
export const COUNTING_MARKERS = ['skipCounting', 'resetCounting'] as const;
export type CountingMarker = (typeof COUNTING_MARKERS)[number];

const isCover = (marker: string): marker is CoverMarker => (COVER_MARKERS as readonly string[]).includes(marker);

/** The page's cover type (the first cover marker), or null. */
export function coverOf(markers: readonly string[]): CoverMarker | null {
  return markers.find(isCover) ?? null;
}

/** `markers` with exactly one cover type (or none); other markers keep their order. */
export function withCover(markers: readonly string[], cover: CoverMarker | null): string[] {
  const rest = markers.filter((m) => !isCover(m));
  return cover ? [cover, ...rest] : rest;
}

/** `markers` with `marker` switched on or off. */
export function withMarker(markers: readonly string[], marker: string, on: boolean): string[] {
  const rest = markers.filter((m) => m !== marker);
  return on ? [...rest, marker] : rest;
}

// ─── Transactions ───────────────────────────────────────────────────────────────────────────────

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Sets one declared attribute of the node at `pos` with an AttrStep (on a page: setPageAttr, whose
 * step on an auto page keeps its undo through pagination's boundary moves). false when it already
 * had the value.
 */
export function writeNodeAttr(tr: Transaction, pos: number, key: string, value: unknown): boolean {
  const node = tr.doc.nodeAt(pos);
  if (!node || node.isText || !(key in (node.type.spec.attrs ?? {}))) return false;
  if (sameValue(node.attrs[key], value)) return false;
  if (node.type.name === 'page') setPageAttr(tr, pos, key, value);
  else tr.setNodeAttribute(pos, key, value);
  return true;
}

/** Attributes that belong to the first fragment of a split block only (plan §3.4). */
const HEAD_ONLY = new Set(['id', 'customId']);

/**
 * Sets attributes on the node at `pos`: shared ones on every fragment of a block split by
 * pagination, `id`/`customId` on the first fragment. Returns whether anything changed.
 */
export function setNodeAttrs(tr: Transaction, pos: number, attrs: Record<string, unknown>): boolean {
  const chain = fragmentChain(tr.doc, pos);
  let changed = false;
  for (const [key, value] of Object.entries(attrs)) {
    for (const at of HEAD_ONLY.has(key) ? chain.slice(0, 1) : chain) changed = writeNodeAttr(tr, at, key, value) || changed;
  }
  return changed;
}

/** A span mark and the range it covers. */
export interface MarkRange {
  from: number;
  to: number;
  mark: Mark;
}

/**
 * The range around `pos` covered by `mark` (compared by type and attributes) inside one textblock:
 * the text nodes touching `pos` that carry it, extended while their neighbours do.
 */
export function markRangeAt(doc: PMNode, pos: number, mark: Mark): MarkRange | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.inlineContent) return null;
  const start = $pos.start();
  const offsets: { from: number; to: number; has: boolean }[] = [];
  parent.forEach((child, offset) => {
    offsets.push({ from: start + offset, to: start + offset + child.nodeSize, has: mark.isInSet(child.marks) });
  });
  // The child that contains pos (or ends at it, for a caret after the mark's last character).
  let index = offsets.findIndex((o) => o.has && o.from <= pos && pos < o.to);
  if (index < 0) index = offsets.findIndex((o) => o.has && o.to === pos);
  if (index < 0) index = offsets.findIndex((o) => o.has && o.from === pos);
  if (index < 0) return null;
  let first = index;
  let last = index;
  while (first > 0 && offsets[first - 1]!.has) first--;
  while (last < offsets.length - 1 && offsets[last + 1]!.has) last++;
  return { from: offsets[first]!.from, to: offsets[last]!.to, mark };
}

/**
 * Replaces a span mark's attributes over its range (RemoveMarkStep + AddMarkStep). Note: with
 * nested spans of equal type, the replaced span becomes the innermost one of the set.
 */
export function setMarkAttrs(tr: Transaction, range: MarkRange, attrs: Record<string, unknown>): MarkRange | null {
  const next = range.mark.type.create({ ...range.mark.attrs, ...attrs });
  if (next.eq(range.mark)) return null;
  tr.removeMark(range.from, range.to, range.mark);
  tr.addMark(range.from, range.to, next);
  return { ...range, mark: next };
}

/**
 * Writes section settings to the first (manual) page of page `index`'s section. The section sync
 * copies them to the auto pages.
 */
export function writeSectionAttrs(tr: Transaction, index: number, attrs: Partial<SectionSettings>): boolean {
  const page = pageAt(tr.doc, sectionStartIndex(tr.doc, index));
  if (!page) return false;
  let changed = false;
  for (const [key, value] of Object.entries(attrs)) {
    if ((SECTION_ATTRS as readonly string[]).includes(key)) changed = writeNodeAttr(tr, page.pos, key, value) || changed;
  }
  return changed;
}

/**
 * Runs `build` on a new transaction and dispatches it as its own undo step when it changed the
 * document. Returns whether it did (or would, without `dispatch`).
 */
export function applyEdit(state: EditorState, dispatch: Dispatch | undefined, build: (tr: Transaction) => boolean): boolean {
  const tr = state.tr;
  if (!build(tr) || !tr.docChanged) return false;
  dispatch?.(closeHistory(tr).setMeta(INSPECTOR_META, true));
  return true;
}

const done = (changed: boolean): EditResult => ({ ok: true, changed });

// ─── Edit targets ───────────────────────────────────────────────────────────────────────────────

/** What an edit applies to: a node (by position) or a span mark over a range. */
export type EditTarget = { kind: 'node'; pos: number } | { kind: 'mark'; from: number; to: number; mark: Mark };

/** The generic attributes (classes, style, id, attributes) of a target as stored. */
export interface GenericValues {
  classes: string[];
  style: string | null;
  id: string | null;
  attributes: Record<string, string>;
}

function targetNode(state: EditorState, target: EditTarget): PMNode | null {
  if (target.kind !== 'node') return null;
  const node = state.doc.nodeAt(target.pos);
  return node && !node.isText ? node : null;
}

/** The target's stored generic values (the id of a split block is its first fragment's). */
export function genericValues(state: EditorState, target: EditTarget): GenericValues | null {
  const attrs = target.kind === 'mark' ? target.mark.attrs : targetNode(state, target)?.attrs;
  if (!attrs || !('classes' in attrs)) return null;
  let id = attrs.id as string | null;
  if (target.kind === 'node') {
    const head = fragmentChain(state.doc, target.pos)[0]!;
    if (head !== target.pos) id = (state.doc.nodeAt(head)?.attrs.id as string | null | undefined) ?? null;
  }
  return {
    classes: Array.isArray(attrs.classes) ? (attrs.classes as string[]) : [],
    style: typeof attrs.style === 'string' ? attrs.style : null,
    id: typeof id === 'string' && id !== '' ? id : null,
    attributes: attrs.attributes && typeof attrs.attributes === 'object' ? (attrs.attributes as Record<string, string>) : {},
  };
}

/** The target's type name ('span' for span marks), for per-type attribute rules. */
export function targetType(state: EditorState, target: EditTarget): string | null {
  return target.kind === 'mark' ? target.mark.type.name : (targetNode(state, target)?.type.name ?? null);
}

function checkTarget(state: EditorState, target: EditTarget): { ok: false; error: string } | null {
  if (target.kind === 'mark') {
    const range = markRangeAt(state.doc, target.from, target.mark);
    return range && range.from === target.from && range.to === target.to ? null : invalid('The span is no longer there.');
  }
  const node = targetNode(state, target);
  return node && 'classes' in node.attrs ? null : invalid('This element has no classes, style, id or attributes.');
}

function writeGeneric(state: EditorState, dispatch: Dispatch | undefined, target: EditTarget, attrs: Record<string, unknown>): EditResult {
  const problem = checkTarget(state, target);
  if (problem) return problem;
  return done(
    applyEdit(state, dispatch, (tr) =>
      target.kind === 'mark' ? setMarkAttrs(tr, target, attrs) !== null : setNodeAttrs(tr, target.pos, attrs),
    ),
  );
}

// ─── Generic edits ──────────────────────────────────────────────────────────────────────────────

/** Replaces the target's classes. */
export function editClasses(state: EditorState, dispatch: Dispatch | undefined, target: EditTarget, classes: readonly string[]): EditResult {
  const result = validateClassList(classes);
  if (!result.ok) return result;
  return writeGeneric(state, dispatch, target, { classes: result.value });
}

/** Adds the classes in `input` (free text, see parseClassInput). Adding only existing ones is an error. */
export function addClasses(state: EditorState, dispatch: Dispatch | undefined, target: EditTarget, input: string): EditResult {
  const parsed = parseClassInput(input);
  if (!parsed.ok) return parsed;
  const current = genericValues(state, target)?.classes ?? [];
  const added = parsed.value.filter((c) => !current.includes(c));
  if (added.length === 0) {
    return invalid(parsed.value.length === 1 ? `${quote(parsed.value[0]!)} is already applied.` : 'These classes are already applied.');
  }
  return editClasses(state, dispatch, target, [...current, ...added]);
}

export function removeClass(state: EditorState, dispatch: Dispatch | undefined, target: EditTarget, name: string): EditResult {
  const current = genericValues(state, target)?.classes ?? [];
  if (!current.includes(name)) return done(false);
  return writeGeneric(state, dispatch, target, { classes: current.filter((c) => c !== name) });
}

/** Sets the target's inline style from what the author typed (validateStyle). */
export function editStyle(state: EditorState, dispatch: Dispatch | undefined, target: EditTarget, input: string, doc?: Document): EditResult {
  const result = validateStyle(input, doc);
  if (!result.ok) return result;
  return writeGeneric(state, dispatch, target, { style: result.value });
}

/**
 * Sets the target's id (validateId: unique, no spaces, not p{n}). A heading's id becomes the
 * author's own (customId); clearing it hands the id back to the heading-id plugin, which gives the
 * heading its generated slug again.
 */
export function editId(state: EditorState, dispatch: Dispatch | undefined, target: EditTarget, input: string): EditResult {
  const problem = checkTarget(state, target);
  if (problem) return problem;
  const own =
    target.kind === 'mark'
      ? (pos: number) => pos >= target.from && pos < target.to
      : ((chain: number[]) => (pos: number) => chain.includes(pos))(fragmentChain(state.doc, target.pos));
  const result = validateId(input, state.doc, own);
  if (!result.ok) return result;
  const node = targetNode(state, target);
  if (node?.type.name === 'heading') {
    const current = genericValues(state, target)?.id ?? null;
    // Typing the id the heading already has (generated or not) keeps it as it is.
    if (result.value === current) return done(false);
    return writeGeneric(state, dispatch, target, result.value === null ? { id: null, customId: false } : { id: result.value, customId: true });
  }
  return writeGeneric(state, dispatch, target, { id: result.value });
}

/**
 * Sets attribute `name` to `value`. With `previousName` (a rename), that attribute is replaced in
 * place; otherwise a name that is already set is an error.
 */
export function setAttribute(
  state: EditorState,
  dispatch: Dispatch | undefined,
  target: EditTarget,
  name: string,
  value: string,
  previousName?: string,
): EditResult {
  const problem = checkTarget(state, target);
  if (problem) return problem;
  const checked = validateAttributeName(name, targetType(state, target) ?? undefined);
  if (!checked.ok) return checked;
  const checkedValue = validateAttributeValue(value);
  if (!checkedValue.ok) return checkedValue;
  const current = genericValues(state, target)?.attributes ?? {};
  const key = checked.value;
  if (previousName === undefined && key in current) return invalid(`${quote(key)} is already set: change its value below.`);
  if (previousName !== undefined && previousName !== key && key in current) return invalid(`${quote(key)} is already set.`);
  const next: Record<string, string> = {};
  let placed = false;
  for (const [k, v] of Object.entries(current)) {
    if (k === previousName || k === key) {
      if (!placed) next[key] = checkedValue.value;
      placed = true;
    } else next[k] = v;
  }
  if (!placed) next[key] = checkedValue.value;
  return writeGeneric(state, dispatch, target, { attributes: next });
}

export function removeAttribute(state: EditorState, dispatch: Dispatch | undefined, target: EditTarget, name: string): EditResult {
  const current = genericValues(state, target)?.attributes ?? {};
  if (!(name in current)) return done(false);
  const next = Object.fromEntries(Object.entries(current).filter(([k]) => k !== name));
  return writeGeneric(state, dispatch, target, { attributes: next });
}

// ─── Page edits ─────────────────────────────────────────────────────────────────────────────────

/** Section settings as the inspector edits them: footer and style as typed, classes as a list. */
export interface SectionEdit {
  columns?: ColumnsSetting;
  pageNumber?: boolean;
  /** Typed text; empty removes the footer. */
  footer?: string;
  classes?: readonly string[];
  /** Typed declarations; empty removes the style. */
  style?: string;
}

/**
 * Changes the section settings of page `index`'s section (plan §6.2): written to its first page
 * (the section sync copies them to the auto pages), one undo step. Pagination re-checks from the
 * page before the section's first page (changedPages).
 */
export function editSection(state: EditorState, dispatch: Dispatch | undefined, index: number, edit: SectionEdit, doc?: Document): EditResult {
  if (!pageAt(state.doc, index)) return invalid('That page is no longer there.');
  const attrs: Partial<SectionSettings> = {};
  if (edit.columns !== undefined) {
    const result = validateColumns(edit.columns);
    if (!result.ok) return result;
    attrs.columns = result.value;
  }
  if (edit.pageNumber !== undefined) {
    if (typeof edit.pageNumber !== 'boolean') return invalid('Page number must be on or off.');
    attrs.pageNumber = edit.pageNumber;
  }
  if (edit.footer !== undefined) {
    const result = validateFooter(edit.footer);
    if (!result.ok) return result;
    attrs.footer = result.value;
  }
  if (edit.classes !== undefined) {
    const result = validateClassList(edit.classes);
    if (!result.ok) return result;
    attrs.classes = result.value;
  }
  if (edit.style !== undefined) {
    const result = validateStyle(edit.style, doc);
    if (!result.ok) return result;
    attrs.style = result.value;
  }
  return done(applyEdit(state, dispatch, (tr) => writeSectionAttrs(tr, index, attrs)));
}

/** Adds the classes in `input` to the section of page `index`. */
export function addSectionClasses(state: EditorState, dispatch: Dispatch | undefined, index: number, input: string): EditResult {
  if (!pageAt(state.doc, index)) return invalid('That page is no longer there.');
  const parsed = parseClassInput(input);
  if (!parsed.ok) return parsed;
  const current = sectionSettings(state.doc, index).classes;
  const added = parsed.value.filter((c) => !current.includes(c));
  if (added.length === 0) {
    return invalid(parsed.value.length === 1 ? `${quote(parsed.value[0]!)} is already applied.` : 'These classes are already applied.');
  }
  return editSection(state, dispatch, index, { classes: [...current, ...added] });
}

/** Sets the markers of page `index` (never inherited by other pages). */
export function editMarkers(state: EditorState, dispatch: Dispatch | undefined, index: number, markers: readonly string[]): EditResult {
  const page = pageAt(state.doc, index);
  if (!page) return invalid('That page is no longer there.');
  for (const marker of markers) {
    const result = validateClassName(marker);
    if (!result.ok) return result;
  }
  const next = normalizeMarkers(markers);
  return done(applyEdit(state, dispatch, (tr) => writeNodeAttr(tr, page.pos, 'markers', next)));
}

/** Changes the classes and/or style of page object `id` on page `index`. */
export function editPageObject(
  state: EditorState,
  dispatch: Dispatch | undefined,
  index: number,
  id: string,
  edit: { classes?: readonly string[]; style?: string },
  doc?: Document,
): EditResult {
  const page = pageAt(state.doc, index);
  if (!page) return invalid('That page is no longer there.');
  const objects = normalizePageObjects(page.node.attrs.objects);
  const at = objects.findIndex((o) => o.id === id);
  if (at < 0) return invalid('That object is no longer on this page.');
  const next: PageObject = { ...objects[at]! };
  if (edit.classes !== undefined) {
    const result = validateClassList(edit.classes);
    if (!result.ok) return result;
    next.classes = result.value;
  }
  if (edit.style !== undefined) {
    const result = validateStyle(edit.style, doc);
    if (!result.ok) return result;
    next.style = result.value ?? '';
  }
  const list = objects.map((o, i) => (i === at ? next : o));
  return done(applyEdit(state, dispatch, (tr) => writeNodeAttr(tr, page.pos, 'objects', list)));
}

/** Adds the classes in `input` to page object `id`. */
export function addPageObjectClasses(state: EditorState, dispatch: Dispatch | undefined, index: number, id: string, input: string): EditResult {
  const page = pageAt(state.doc, index);
  const object = page ? normalizePageObjects(page.node.attrs.objects).find((o) => o.id === id) : undefined;
  if (!object) return invalid('That object is no longer on this page.');
  const parsed = parseClassInput(input);
  if (!parsed.ok) return parsed;
  const added = parsed.value.filter((c) => !object.classes.includes(c));
  if (added.length === 0) {
    return invalid(parsed.value.length === 1 ? `${quote(parsed.value[0]!)} is already applied.` : 'These classes are already applied.');
  }
  return editPageObject(state, dispatch, index, id, { classes: [...object.classes, ...added] });
}
