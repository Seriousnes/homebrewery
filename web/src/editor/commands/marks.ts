// Inline commands behind the keymap and the toolbar (plan §6.1): the non-breaking space, the
// inlineBox spacer (widen / narrow), span marks with classes and links.
//
// Every command here is a plain ProseMirror command, (state, dispatch?) => boolean, that builds
// one transaction. Inside a TipTap chain, `chain.command(({ state, dispatch }) => cmd(state,
// dispatch))` works because the chainable state's `tr` is the chain's transaction. The keymap's
// runEditorCommand (keymap.ts) makes each user action exactly one undo step.
//
// Attribute changes on nodes use tr.setNodeAttribute (AttrStep), never setNodeMarkup, so undo
// survives pagination re-joining or re-splitting the block (implementation notes, PG-2).
import type { Mark, MarkType, Node as PMNode, NodeType } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type Command, type EditorState, type Transaction } from '@tiptap/pm/state';
import { isAuthorClass } from '../schema/attrs';
import { isSafeHref } from '../schema/html';

/**
 * Whether the selection's textblock is rich text: inline content that isn't code. A code block
 * (content text*, no marks) holds plain text only; inserting a spacer there would split it, and a
 * link or span mark would be dropped (review finding UI-7). The toolbar's inText reads this too.
 */
export function inRichText(state: EditorState): boolean {
  const parent = state.selection.$from.parent;
  return parent.inlineContent && !parent.type.spec.code;
}

/** Whether the selection's textblock can hold an inline node of `type`. */
const canHoldNode = (state: EditorState, type: NodeType): boolean =>
  inRichText(state) && state.selection.$from.parent.type.contentMatch.matchType(type) !== null;

/** Whether the selection's textblock allows mark `type`. */
const canHoldMark = (state: EditorState, type: MarkType): boolean => inRichText(state) && state.selection.$from.parent.type.allowsMarkType(type);

/** U+00A0, what upstream's `:>` produced. */
export const NBSP = ' ';

/** Mod-.: inserts a non-breaking space (replacing the selection). */
export const insertNbsp: Command = (state, dispatch) => {
  if (!state.selection.$from.parent.inlineContent) return false;
  dispatch?.(state.tr.insertText(NBSP).scrollIntoView());
  return true;
};

// ---------------------------------------------------------------------------------------------
// inlineBox spacers ({{width:10% }} upstream)

/** One Shift-Mod-. / Shift-Mod-, press changes a spacer's width by this many percent. */
export const SPACER_STEP = 10;
export const SPACER_MAX = 100;

const PERCENT_WIDTH = /(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)%\s*(?=;|$)/i;

/** The width in percent of a spacer style ("width: 20%;"), or null when it has none. */
export function spacerWidth(style: unknown): number | null {
  if (typeof style !== 'string') return null;
  const match = PERCENT_WIDTH.exec(style);
  return match ? Number(match[1]) : null;
}

/**
 * `style` with its width set to `percent`% (other declarations kept), normalized the way the
 * schema stores styles (cssText) when a DOM is available.
 */
export function withSpacerWidth(style: string | null, percent: number, doc: Document | undefined = globalThis.document): string {
  const value = `${percent}%`;
  if (doc) {
    const probe = doc.createElement('span');
    if (style) probe.setAttribute('style', style);
    probe.style.setProperty('width', value);
    return probe.style.cssText.trim();
  }
  const rest = (style ?? '').replace(/(?:^|;)\s*width\s*:[^;]*;?/i, ';').replace(/^\s*;\s*/, '').trim();
  return `${rest ? `${rest.replace(/;?\s*$/, ';')} ` : ''}width: ${value};`;
}

export interface SpacerHit {
  pos: number;
  node: PMNode;
  width: number;
}

const isSpacer = (node: PMNode | null | undefined): node is PMNode =>
  node?.type.name === 'inlineBox' && spacerWidth(node.attrs.style) !== null;

/**
 * The spacer the widen/narrow keys act on: a selected inlineBox with a width in percent, else
 * the one right before the cursor, else the one right after it.
 */
export function spacerAt(state: EditorState): SpacerHit | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) {
    return isSpacer(sel.node) ? { pos: sel.from, node: sel.node, width: spacerWidth(sel.node.attrs.style)! } : null;
  }
  if (!sel.empty) return null;
  const $pos = sel.$from;
  const before = $pos.nodeBefore;
  if (isSpacer(before)) return { pos: $pos.pos - before.nodeSize, node: before, width: spacerWidth(before.attrs.style)! };
  const after = $pos.nodeAfter;
  if (isSpacer(after)) return { pos: $pos.pos, node: after, width: spacerWidth(after.attrs.style)! };
  return null;
}

/**
 * Shift-Mod-.: widens the spacer at the cursor by SPACER_STEP percent (at most 100), or inserts a
 * new SPACER_STEP% spacer (replacing the selection) with the cursor after it, so pressing again
 * widens it.
 */
export const widenSpacer: Command = (state, dispatch) => {
  const hit = spacerAt(state);
  if (hit) {
    const width = Math.min(hit.width + SPACER_STEP, SPACER_MAX);
    if (width === hit.width) return false;
    dispatch?.(state.tr.setNodeAttribute(hit.pos, 'style', withSpacerWidth(hit.node.attrs.style as string | null, width)));
    return true;
  }
  const type = state.schema.nodes.inlineBox;
  if (!type || !canHoldNode(state, type)) return false;
  if (dispatch) {
    const node = type.create({ style: withSpacerWidth(null, SPACER_STEP) });
    const tr = state.tr.replaceSelectionWith(node, false);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Shift-Mod-,: narrows the spacer at the cursor by SPACER_STEP percent; at 0 it is removed.
 * false when there is no spacer at the cursor.
 */
export const narrowSpacer: Command = (state, dispatch) => {
  const hit = spacerAt(state);
  if (!hit) return false;
  if (dispatch) {
    const width = hit.width - SPACER_STEP;
    const tr = state.tr;
    if (width > 0) tr.setNodeAttribute(hit.pos, 'style', withSpacerWidth(hit.node.attrs.style as string | null, width));
    else tr.delete(hit.pos, hit.pos + hit.node.nodeSize);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

// ---------------------------------------------------------------------------------------------
// span marks ({{class text}} upstream)

/** Splits typed class input ("note, wide  frame") into tokens. */
export function parseClassInput(input: string): string[] {
  return input.split(/[\s,]+/).filter(Boolean);
}

/** DocInspector.MaxClassLength: the server drops longer class names. */
const MAX_CLASS_LENGTH = 256;

/**
 * Why `name` can't be an author class, or null when it can. As the server's class check
 * (DocInspector.IsClassToken): no whitespace (with .NET's U+0085), no NUL, at most 256 characters.
 */
export function classProblem(name: string): string | null {
  if (!name || /[\s\u0085]/.test(name)) return 'Class names cannot contain spaces';
  if (name.length > MAX_CLASS_LENGTH) return `Class names can be at most ${MAX_CLASS_LENGTH} characters`;
  if (name.includes('\0')) return 'Class names cannot contain a NUL character';
  if (!isAuthorClass(name)) return `“${name}” is reserved by the editor`;
  return null;
}

/** Unique, valid author classes in input order. */
export function cleanClassList(classes: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of classes) if (classProblem(c) === null && !out.includes(c)) out.push(c);
  return out;
}

export interface MarkTarget {
  mark: Mark;
  from: number;
  to: number;
}

/** Span marks of a node's mark set, outermost first (ProseMirror orders same-rank marks by addition). */
const spansOf = (marks: readonly Mark[], type: MarkType): Mark[] => marks.filter((m) => m.type === type);

/**
 * The span mark the selection edits: with an empty selection, the innermost span at the cursor
 * (its whole range); with a range, the innermost span whose range is exactly the selection.
 * null means the selection gets a new span.
 */
export function spanTarget(state: EditorState): MarkTarget | null {
  const type = state.schema.marks.span;
  if (!type) return null;
  const { $from, from, to, empty } = state.selection;
  if (!$from.parent.inlineContent) return null;
  const candidates = empty ? spansOf(state.storedMarks ?? $from.marks(), type) : spansAtRangeStart(state, from, type);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const mark = candidates[i]!;
    const range = markRange(state, from, mark);
    if (!range) {
      // A stored span that no text carries yet: an empty target at the cursor.
      if (empty && state.storedMarks?.includes(mark)) return { mark, from, to: from };
      continue;
    }
    if (empty || (range.from === from && range.to === to)) return { mark, ...range };
  }
  return null;
}

function spansAtRangeStart(state: EditorState, from: number, type: MarkType): Mark[] {
  const node = state.doc.nodeAt(from);
  return node?.isInline ? spansOf(node.marks, type) : [];
}

/**
 * The run of inline nodes carrying `mark` (same type and attributes) that contains `pos`, or
 * ends at it (a cursor right after the run), within `pos`'s textblock.
 */
function markRange(state: EditorState, pos: number, mark: Mark): { from: number; to: number } | null {
  const $pos = state.doc.resolve(pos);
  const kids: { from: number; to: number; has: boolean }[] = [];
  let offset = $pos.start();
  $pos.parent.forEach((child) => {
    kids.push({ from: offset, to: offset + child.nodeSize, has: mark.isInSet(child.marks) });
    offset += child.nodeSize;
  });
  let index = kids.findIndex((k) => k.has && k.from <= pos && pos < k.to);
  if (index < 0) index = kids.findIndex((k) => k.has && k.to === pos);
  if (index < 0) return null;
  let first = index;
  let last = index;
  while (first > 0 && kids[first - 1]!.has) first--;
  while (last < kids.length - 1 && kids[last + 1]!.has) last++;
  return { from: kids[first]!.from, to: kids[last]!.to };
}

/**
 * Replaces `oldMark` by `newMark` (or removes it when null) over [from, to], keeping the nesting
 * order of the other span marks: on each inline node the spans are rebuilt in their order.
 */
function replaceSpan(tr: Transaction, from: number, to: number, type: MarkType, oldMark: Mark, newMark: Mark | null): void {
  const segments: { from: number; to: number; spans: Mark[] }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    const spans = spansOf(node.marks, type);
    const index = spans.findIndex((m) => m.eq(oldMark));
    if (index < 0) return false;
    const next = [...spans];
    if (newMark) next[index] = newMark;
    else next.splice(index, 1);
    segments.push({ from: Math.max(pos, from), to: Math.min(pos + node.nodeSize, to), spans: next });
    return false;
  });
  for (const segment of segments) {
    tr.removeMark(segment.from, segment.to, type);
    for (const span of segment.spans) tr.addMark(segment.from, segment.to, span);
  }
}

/**
 * Mod-M / the class picker: applies a span with `classes`. When the selection targets an existing
 * span (spanTarget), its classes are replaced (style, id and attributes kept); otherwise a new
 * span is added over the selection (spans nest). With an empty selection and no span at the
 * cursor, the span becomes a stored mark for the text typed next.
 */
export function applySpan(classes: readonly string[]): Command {
  return (state, dispatch) => {
    const type = state.schema.marks.span;
    if (!type) return false;
    const clean = cleanClassList(classes);
    const target = spanTarget(state);
    const { empty } = state.selection;
    if (!canHoldMark(state, type)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const mark = type.create({ ...target?.mark.attrs, classes: clean });
    if (target && target.from === target.to) {
      // A span only in the stored marks (nothing typed yet): swap it.
      tr.removeStoredMark(target.mark).addStoredMark(mark);
    } else if (target) {
      replaceSpan(tr, target.from, target.to, type, target.mark, mark);
    } else if (empty) {
      tr.addStoredMark(mark);
    } else {
      for (const range of state.selection.ranges) tr.addMark(range.$from.pos, range.$to.pos, mark);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Removes the span the selection targets (spanTarget); false when there is none. */
export const removeSpan: Command = (state, dispatch) => {
  const type = state.schema.marks.span;
  const target = spanTarget(state);
  if (!type || !target) return false;
  if (dispatch) {
    const tr = state.tr;
    if (target.from !== target.to) replaceSpan(tr, target.from, target.to, type, target.mark, null);
    if (state.selection.empty) tr.removeStoredMark(target.mark);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

// ---------------------------------------------------------------------------------------------
// links

export interface LinkTarget {
  href: string;
  from: number;
  to: number;
}

/** The link at the cursor (its whole range), or the link covering the whole selection. */
export function linkTarget(state: EditorState): LinkTarget | null {
  const type = state.schema.marks.link;
  if (!type) return null;
  const { $from, from, to, empty } = state.selection;
  if (!$from.parent.inlineContent) return null;
  const mark = empty ? type.isInSet(state.storedMarks ?? $from.marks()) : type.isInSet(state.doc.nodeAt(from)?.marks ?? []);
  if (!mark) return null;
  const range = markRange(state, from, mark);
  if (!range) return null;
  if (!empty && (range.from > from || range.to < to)) return null;
  return { href: String(mark.attrs.href ?? ''), from: range.from, to: range.to };
}

/**
 * Adds https:// to what looks like a bare domain ("example.com/x"), so it isn't stored as a
 * relative link. Everything else is returned trimmed.
 */
export function normalizeHref(input: string): string {
  const href = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[/#?.]/.test(href)) return href;
  if (/^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(href)) return `https://${href}`;
  return href;
}

/** Why `href` can't be a link target, or null. Mirrors the schema/server URL policy (isSafeHref). */
export function hrefProblem(href: string): string | null {
  if (!href.trim()) return 'Enter an address';
  if (!isSafeHref(href.trim())) return 'Use an http, https or mailto address, a relative path or a #anchor';
  return null;
}

/**
 * Mod-K / the link dialog: sets the link at the cursor (its whole range) or over the selection to
 * `href`. With an empty selection outside a link, inserts `text` (default: the address) as a link
 * and leaves the cursor after it, unlinked. false for an unsafe address.
 */
export function applyLink(href: string, text?: string): Command {
  return (state, dispatch) => {
    const type = state.schema.marks.link;
    if (!type || hrefProblem(href) !== null) return false;
    const clean = href.trim();
    const { from, empty } = state.selection;
    if (!canHoldMark(state, type)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const mark = type.create({ href: clean });
    const target = linkTarget(state);
    if (target && empty) {
      tr.removeMark(target.from, target.to, type).addMark(target.from, target.to, mark);
    } else if (empty) {
      const label = text?.trim() || clean;
      tr.insertText(label, from);
      tr.addMark(from, from + label.length, mark);
      tr.setSelection(TextSelection.create(tr.doc, from + label.length));
      tr.removeStoredMark(type);
    } else {
      for (const range of state.selection.ranges) {
        tr.removeMark(range.$from.pos, range.$to.pos, type).addMark(range.$from.pos, range.$to.pos, mark);
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Removes the link at the cursor (its whole range) or in the selection. */
export const removeLink: Command = (state, dispatch) => {
  const type = state.schema.marks.link;
  if (!type) return false;
  const target = linkTarget(state);
  const { from, to, empty } = state.selection;
  if (!target && (empty || !state.doc.rangeHasMark(from, to, type))) return false;
  if (dispatch) {
    const tr = state.tr;
    if (target) tr.removeMark(target.from, target.to, type);
    else tr.removeMark(from, to, type);
    tr.removeStoredMark(type);
    dispatch(tr.scrollIntoView());
  }
  return true;
};
