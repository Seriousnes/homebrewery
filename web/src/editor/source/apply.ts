// Applying edited source: one transaction (one undo step) that replaces exactly the scope.
//
// Targets are indices in the merged view (flow.ts): a section index and flow items, never
// positions. Pagination only moves auto-page boundaries, which the merged view doesn't see, so a
// target taken when the dialog opened still names the same content when it applies.
//
// Only what changed is replaced. Sections are compared first (unchanged ones at both ends are
// left alone; the rest are paired in order, extra ones added or removed); within a paired section
// the flow is compared item by item, and only the range from the first to the last changed item
// is replaced, the fragments of split blocks included:
//
//   page F  [ … prefix | new blocks ]         the new blocks go where the first changed item began
//   pages between                             removed (a page with objects or markers is kept as a
//                                             placeholder, as pagination keeps it: plan §4.9)
//   page L  [ suffix … ]                      keeps the rest of its flow
//
// Pagination then settles the pages (join + split, outside the undo history). The replaced range
// is narrowed to the differing part (Fragment.findDiffStart/End), so typing a word in a
// 100-page brew changes a word.
import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { carriesPageData } from '../pagination/boundary';
import { SOURCE_PAGE_ATTRS, sameBlock, samePageAttrs, sameValue, sectionIndexOfPage, sectionsOf, type Section } from './flow';
import { type ParsedBlocks, type ParsedSection, type ParsedSections, rawHtmlOf } from './parse';
import { SourcePrinter } from './serialize';

export type SourceScope = 'selection' | 'section' | 'brew';

/** What the source edits, in the merged view. */
export type SourceTarget =
  | { scope: 'selection'; section: number; start: number; end: number }
  | { scope: 'section' | 'brew'; first: number; end: number };

/** The target of `scope` for the editor state (its selection). */
export function targetFor(state: EditorState, scope: SourceScope, sections: readonly Section[] = sectionsOf(state.doc)): SourceTarget {
  if (scope === 'brew') return { scope, first: 0, end: sections.length };
  const { from, to, empty } = state.selection;
  const pageIndex = Math.min(state.doc.resolve(Math.min(from, state.doc.content.size)).index(0), state.doc.childCount - 1);
  const s = sectionIndexOfPage(sections, pageIndex);
  if (scope === 'section') return { scope, first: s, end: s + 1 };
  const items = sections[s]!.items;
  let start = items.findIndex((item) => item.to > from);
  if (start < 0) start = items.length - 1;
  let end = start + 1;
  if (!empty) {
    while (end < items.length && items[end]!.from < to) end++;
  }
  return { scope, section: s, start, end };
}

export interface SourceSnapshot {
  target: SourceTarget;
  text: string;
  /** Raw HTML the target holds (the parse report lists only new raw HTML). */
  rawHtml: string[];
}

/** The source text of `target` in `doc`. */
export function sourceOf(schema: Schema, doc: PMNode, target: SourceTarget, sections: readonly Section[] = sectionsOf(doc)): SourceSnapshot {
  const printer = new SourcePrinter(schema);
  if (target.scope === 'selection') {
    const nodes = sections[target.section]!.items.slice(target.start, target.end).map((i) => i.node);
    return { target, text: printer.printBlocks(nodes), rawHtml: rawHtmlOf(nodes) };
  }
  const chosen = sections.slice(target.first, target.end);
  return { target, text: printer.printSections(chosen), rawHtml: rawHtmlOf(chosen.flatMap((s) => s.items.map((i) => i.node))) };
}

/** Whether the target still exists in `doc` (sections can go while a dialog is open). */
export function targetExists(sections: readonly Section[], target: SourceTarget): boolean {
  if (target.scope === 'selection') {
    const section = sections[target.section];
    return section !== undefined && target.end <= section.items.length;
  }
  return target.end <= sections.length;
}

// ---------------------------------------------------------------------------------------------
// building the transaction

const paragraph = (schema: Schema): PMNode => schema.nodes.paragraph!.create();

/**
 * Replaces `from`…`to` (page boundaries: positions before/after whole pages) with `pages`,
 * narrowed to the part that differs. Returns whether anything changed.
 */
function replacePages(tr: Transaction, from: number, to: number, pages: readonly PMNode[]): boolean {
  const next = Fragment.fromArray([...pages]);
  const old = tr.doc.slice(from, to).content;
  const start = old.findDiffStart(next);
  if (start === null) return false;
  const diffEnd = old.findDiffEnd(next)!;
  let endA = diffEnd.a;
  let endB = diffEnd.b;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  // The narrow step, if ProseMirror's fitting reproduces exactly `pages` (it does unless the
  // difference straddles structure it can't close the same way); else the whole range.
  const holder = tr.doc.type.create(null, next);
  const probe = new Transform(tr.doc);
  try {
    probe.replace(from + start, from + endA, holder.slice(start, endB));
    if (probe.doc.slice(from, from + next.size).content.eq(next) && probe.doc.content.size === tr.doc.content.size - old.size + next.size) {
      for (const step of probe.steps) tr.step(step);
      return true;
    }
  } catch {
    // fall through to the whole range
  }
  tr.replaceWith(from, to, next);
  return true;
}

/**
 * Replaces the flow of section `section` (positions in tr.doc) with `blocks`: only the range of
 * items that differ, the pages it spans rebuilt (see the top of the file).
 */
function replaceFlow(tr: Transaction, section: Section, blocks: readonly PMNode[]): boolean {
  const { items } = section;
  let head = 0;
  while (head < items.length && head < blocks.length && sameBlock(items[head]!.node, blocks[head]!)) head++;
  let tail = 0;
  while (tail < items.length - head && tail < blocks.length - head && sameBlock(items[items.length - 1 - tail]!.node, blocks[blocks.length - 1 - tail]!)) tail++;
  const oldEnd = items.length - tail;
  const inserted = blocks.slice(head, blocks.length - tail);
  if (head === oldEnd && inserted.length === 0) return false;

  let from: number;
  let to: number;
  if (head < oldEnd) {
    from = items[head]!.from;
    to = items[oldEnd - 1]!.to;
  } else {
    from = to = head > 0 ? items[head - 1]!.to : items[0]!.from;
  }
  const doc = tr.doc;
  const schema = doc.type.schema;
  const pF = doc.resolve(from).index(0);
  const pL = doc.resolve(to).index(0);
  const pageStart = (index: number) => {
    let pos = section.pos;
    for (let i = section.first; i < index; i++) pos += doc.child(i).nodeSize;
    return pos;
  };
  const fPos = pageStart(pF);
  const first = doc.child(pF);
  const last = doc.child(pL);
  const lPos = pF === pL ? fPos : pageStart(pL);

  let fContent = first.content.cut(0, from - fPos - 1).append(Fragment.fromArray(inserted));
  let lContent = last.content.cut(to - lPos - 1);
  if (pF === pL) {
    fContent = fContent.append(lContent);
    lContent = Fragment.empty;
  } else if (fContent.size === 0) {
    // Nothing before or instead of the removed items on page F: the rest moves up to it.
    fContent = lContent;
    lContent = Fragment.empty;
  }

  const pages: PMNode[] = [];
  const keep = (page: PMNode, content: Fragment, required: boolean) => {
    if (content.size > 0) pages.push(page.copy(content));
    else if (required || carriesPageData(page)) pages.push(page.copy(Fragment.from(paragraph(schema))));
  };
  keep(first, fContent, pF === section.first);
  for (let i = pF + 1; i < pL; i++) {
    const page = doc.child(i);
    if (carriesPageData(page)) pages.push(page.copy(Fragment.from(paragraph(schema))));
  }
  if (pL !== pF) keep(last, lContent, false);
  return replacePages(tr, fPos, lPos + last.nodeSize, pages);
}

/** Writes the source-visible page attributes of `page` onto the page at `pos` (AttrSteps). */
function setPageAttrs(tr: Transaction, pos: number, current: PMNode, page: PMNode): void {
  for (const key of SOURCE_PAGE_ATTRS) {
    if (!sameValue(current.attrs[key], page.attrs[key])) tr.setNodeAttribute(pos, key, page.attrs[key]);
  }
}

const sameSection = (old: Section, next: ParsedSection): boolean =>
  samePageAttrs(old.page, next.page) && old.items.length === next.blocks.length && old.items.every((item, i) => sameBlock(item.node, next.blocks[i]!));

/** A new section: a manual page holding the flow (pagination makes its auto pages). */
function newSectionPage(schema: Schema, parsed: ParsedSection): PMNode {
  const content = parsed.blocks.length ? Fragment.fromArray(parsed.blocks) : Fragment.from(paragraph(schema));
  return parsed.page.type.create({ ...parsed.page.attrs, kind: 'manual', pid: null }, content);
}

export class SourceApplyError extends Error {}

/**
 * The transaction that applies `parsed` to `target`, or null when nothing changes. Throws
 * SourceApplyError when the target no longer exists.
 */
export function buildApplyTransaction(state: EditorState, target: SourceTarget, parsed: ParsedBlocks | ParsedSections): Transaction | null {
  const tr = state.tr;
  const schema = state.schema;
  const sections = sectionsOf(state.doc);
  if (!targetExists(sections, target)) throw new SourceApplyError('The brew changed while the source was open: open the source again.');

  if (target.scope === 'selection') {
    if (parsed.mode !== 'blocks') throw new SourceApplyError('Selection source must be blocks.');
    const section = sections[target.section]!;
    const blocks = [...section.items.slice(0, target.start).map((i) => i.node), ...parsed.blocks, ...section.items.slice(target.end).map((i) => i.node)];
    if (!replaceFlow(tr, section, blocks.length ? blocks : [paragraph(schema)])) return null;
    return finish(tr, section.items[target.start]?.from ?? section.pos + 1);
  }

  if (parsed.mode !== 'sections') throw new SourceApplyError('Section source must be sections.');
  const old = sections.slice(target.first, target.end);
  let next = parsed.sections;
  // The document can't be empty: nothing left of the whole brew is one empty section.
  if (next.length === 0 && sections.length === old.length) next = [{ page: schema.nodes.page!.create(), blocks: [paragraph(schema)] }];

  let head = 0;
  while (head < old.length && head < next.length && sameSection(old[head]!, next[head]!)) head++;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && sameSection(old[old.length - 1 - tail]!, next[next.length - 1 - tail]!)) tail++;
  const oldMid = old.slice(head, old.length - tail);
  const newMid = next.slice(head, next.length - tail);
  if (oldMid.length === 0 && newMid.length === 0) return null;
  const paired = Math.min(oldMid.length, newMid.length);

  // Last first: every change leaves the positions before it alone.
  if (newMid.length > paired) {
    const insertAt = paired > 0 ? oldMid[paired - 1]!.end : head > 0 ? old[head - 1]!.end : old[head]?.pos ?? (target.first < sections.length ? sections[target.first]!.pos : state.doc.content.size);
    tr.insert(insertAt, newMid.slice(paired).map((s) => newSectionPage(schema, s)));
  } else if (oldMid.length > paired) {
    tr.delete(oldMid[paired]!.pos, oldMid.at(-1)!.end);
  }
  for (let k = paired - 1; k >= 0; k--) {
    const section = oldMid[k]!;
    const parsedSection = newMid[k]!;
    setPageAttrs(tr, section.pos, tr.doc.child(section.first), parsedSection.page);
    // Positions of this section are still those of `state.doc`: only later sections changed, and
    // AttrSteps don't move positions. Its page nodes now carry the new attributes.
    const current: Section = { ...section, page: tr.doc.child(section.first) };
    replaceFlow(tr, current, parsedSection.blocks.length ? parsedSection.blocks : [paragraph(schema)]);
  }
  if (!tr.docChanged) return null;
  const firstChanged = oldMid[0]?.pos ?? (head > 0 ? old[head - 1]!.end : 0);
  return finish(tr, firstChanged + 1);
}

/** Caret near `pos` (in tr.doc) and a clean undo step of its own. */
function finish(tr: Transaction, pos: number): Transaction {
  const at = Math.max(0, Math.min(pos, tr.doc.content.size));
  tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
  return tr.scrollIntoView();
}

