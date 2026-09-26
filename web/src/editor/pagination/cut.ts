// Choosing the cut (plan §4.4): where an overflowing page must end.
//
//   first overflowing block                    cut
//   paragraph whose first fragment fits        start of its first line outside the box (binary
//                                              search over text positions with coordsAtPos)
//   bullet / ordered list                      before the first item outside (li is
//                                              break-inside: avoid); inside the first item only
//                                              when that item alone doesn't fit
//   definition list                            before the first group (dt + its dd) outside
//   a float outside the box (image)            before the float's anchor in its paragraph (a
//                                              paragraph holding only the float moves whole)
//   a heading right before the cut             the cut moves above the heading (keep-with-next),
//                                              unless that heading starts the page and the unit
//                                              fits a fresh page: then the unit moves alone
//   anything else (theme block, table, …)      before the block (they are break-inside: avoid)
//   the cut would be at the page's start       the page is oversized: the unit stays, whatever
//                                              follows it moves on
//
// On a right-to-left page (direction: rtl) overflow columns lie to the left of the box.
//
// Text positions come from view.coordsAtPos, never posAtCoords: overflow columns are clipped,
// and hit testing (caretPositionFromPoint & co.) can't see clipped content. coordsAtPos reads
// the layout, so it works there.
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { isAutoPage, normalizeCut, type PageRef } from './boundary';
import {
  SPLITTABLE,
  blockRects,
  floatsOf,
  forEachBlock,
  isOutOfFlow,
  isOutside,
  isSpanner,
  visibleRects,
  type Geometry,
  type PageMeasure,
} from './measure';

export type CutRule =
  /** inside a paragraph, at the start of its first line outside the box */
  | 'line'
  /** before a list item */
  | 'item'
  /** inside the first list item, which doesn't fit on its own */
  | 'nested'
  /** before a definition group (dt + dd…) */
  | 'group'
  /** before a whole block */
  | 'block'
  /** above the heading(s) right before the cut */
  | 'keepWithNext'
  /** the overflowing unit starts the page: it stays (page flagged), what follows moves */
  | 'oversized'
  /** nothing overflows, or nothing can move */
  | 'none';

export interface CutChoice {
  /** where the page must end (a document position), or null when nothing can move */
  pos: number | null;
  /** the page keeps a unit that doesn't fit (plan §4.4, last row): flag it */
  oversized: boolean;
  rule: CutRule;
}

/** A cut inside some flow, and the end of the unit it would move (for the oversized fallback). */
interface FlowCut {
  pos: number;
  unitEnd: number;
  rule: CutRule;
  /**
   * Client px the unit needs at the top of a fresh page, margin-top included (0 for a unit
   * that can split there: lines, items, groups).
   */
  unitHeight: number;
}

const heightOf = (rects: DOMRect[]): number => rects.reduce((sum, r) => sum + r.height, 0);

/** Height an unsplittable unit needs at the top of a column: its fragments and floats, and margin-top. */
function unitHeightOf(el: HTMLElement, g: Geometry): number {
  return (parseFloat(getComputedStyle(el).marginTop) || 0) * g.scale + heightOf(blockRects(el));
}

/** Whether the text at `pos` lies outside the box (in an overflow column or below it). */
function posOutside(view: EditorView, pos: number, g: Geometry): boolean {
  let c: { left: number; right: number; top: number };
  try {
    c = view.coordsAtPos(pos, 1);
  } catch {
    return false;
  }
  const inOverflowColumn = g.rtl ? c.right <= g.box.left + g.eps : c.left >= g.box.right - g.eps;
  // `top` rather than `bottom`: a glyph's box can reach a little below its line box.
  return inOverflowColumn || c.top >= g.box.bottom - g.eps;
}

/**
 * First position in [from, to] whose text is outside the box, by binary search (text flows in
 * order through the columns, so "outside" is monotonic). Returns `to` when nothing is outside.
 * With side 1, coordsAtPos at a line wrap reports the start of the next line, so the result is
 * the first position of the first line outside: a line start.
 */
export function firstPosOutside(view: EditorView, from: number, to: number, g: Geometry): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (posOutside(view, mid, g)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Spaces at a soft wrap hang at the end of the line before it (the canvas uses white-space:
 * pre-wrap), so a line cut never starts with one: a cut that falls on spaces moves past them.
 * coordsAtPos places a hanging space inconsistently (inside the box, or outside it, depending on
 * what follows it in the DOM), and without this the same text split differently after an undo
 * and redo, the continuation starting with a space (matrix finding, e2e/matrix/undo.spec.ts).
 */
export function afterHangingSpaces(doc: PMNode, at: number, max: number): number {
  let pos = at;
  while (pos < max && doc.textBetween(pos, pos + 1) === ' ') pos++;
  return pos;
}

/**
 * The pull that takes the spaces a continuation paragraph at the top of auto page `next` starts
 * with back to the end of its head on `page` (the block `page` ends with), where they hang and
 * take no room; null when there are none. A redo or a paste at the seam can leave them after it,
 * where they indent the page's first line, and no other step moves them: the head's page is full
 * and the next page fits. DOM layouts only (a line model gives spaces a width).
 */
export function hangingSpacesPull(page: PMNode, next: PageRef): number | null {
  const first = next.node.firstChild;
  const last = page.lastChild;
  if (!isAutoPage(next.node) || !first || !last || first.type.name !== 'paragraph' || first.type !== last.type) return null;
  const text = first.firstChild;
  if (first.attrs.continuation !== true || !text?.isText || !text.text) return null;
  let spaces = 0;
  while (spaces < text.text.length && text.text[spaces] === ' ') spaces++;
  if (spaces === 0) return null;
  // Nothing but spaces (a redo can leave that on a page of its own): the whole block goes back.
  if (spaces === first.content.size) return next.contentStart + first.nodeSize;
  return next.contentStart + 1 + spaces;
}

interface Hit {
  node: PMNode;
  pos: number;
  el: HTMLElement;
  startsInside: boolean;
  /** a floated descendant outside the box (the block's own fragments may all be inside) */
  float: HTMLElement | null;
}

/** The first child of `parent` (content from `contentStart`) with a fragment outside the box. */
function firstOutside(view: EditorView, parent: PMNode, contentStart: number, g: Geometry, fromIndex = 0): Hit | null {
  let hit: Hit | null = null;
  forEachBlock(
    view,
    parent,
    contentStart,
    (node, pos, _index, el) => {
      if (isOutOfFlow(getComputedStyle(el))) return true;
      const out = visibleRects(el, g.eps).findIndex((r) => isOutside(r, g));
      const float = floatsOf(el).find((f) => visibleRects(f, g.eps).some((r) => isOutside(r, g))) ?? null;
      if (out < 0 && !float) return true;
      hit = { node, pos, el, startsInside: out !== 0, float };
      return false;
    },
    fromIndex,
  );
  return hit;
}

function cutInBlocks(view: EditorView, parent: PMNode, contentStart: number, g: Geometry, fromIndex = 0): FlowCut | null {
  const hit = firstOutside(view, parent, contentStart, g, fromIndex);
  return hit ? cutInBlock(view, hit, g) : null;
}

/** Document position of a float (an inline node: the position before it), clamped to [from, to]. */
function floatAnchor(view: EditorView, float: HTMLElement, from: number, to: number): number {
  try {
    return Math.max(from, Math.min(to, view.posAtDOM(float, 0)));
  } catch {
    return from;
  }
}

function cutInBlock(view: EditorView, hit: Hit, g: Geometry): FlowCut {
  const { node, pos, el } = hit;
  const end = pos + node.nodeSize;
  // A block moved whole needs all of its height at the top of the next page, unless it can
  // split there (lines, items, groups; not a float).
  const splits = SPLITTABLE.has(node.type.name) && floatsOf(el).length === 0;
  const whole: FlowCut = { pos, unitEnd: end, rule: 'block', unitHeight: splits ? 0 : unitHeightOf(el, g) };
  if (!hit.startsInside || isSpanner(getComputedStyle(el))) return whole;
  switch (node.type.name) {
    case 'paragraph': {
      let at = firstPosOutside(view, pos + 1, end - 1, g);
      // A float that doesn't fit moves on with its anchor (and the text after it).
      if (hit.float) at = Math.min(at, floatAnchor(view, hit.float, pos + 1, end - 1));
      if (at <= pos + 1) return whole;
      // Only when a word follows: spaces the fragment ends with stay a line of their own if they are one.
      const word = afterHangingSpaces(view.state.doc, at, end - 1);
      if (word < end - 1) at = word;
      // Nothing of the text is outside (only padding or a descender): keep the paragraph.
      if (at >= end - 1) return { pos: end, unitEnd: end, rule: 'line', unitHeight: 0 };
      return { pos: at, unitEnd: end, rule: 'line', unitHeight: 0 };
    }
    case 'bulletList':
    case 'orderedList':
      return cutInList(view, node, pos, g);
    case 'definitionList':
      return cutInDefinitionList(view, node, pos, g);
    default:
      return whole;
  }
}

function cutInList(view: EditorView, list: PMNode, listPos: number, g: Geometry): FlowCut {
  let result: FlowCut | null = null;
  forEachBlock(view, list, listPos + 1, (item, itemPos, k, el) => {
    const rects = blockRects(el, g.eps);
    const out = rects.findIndex((r) => isOutside(r, g));
    if (out < 0) return true;
    const itemEnd = itemPos + item.nodeSize;
    if (k > 0) {
      result = { pos: itemPos, unitEnd: itemEnd, rule: 'item', unitHeight: 0 };
      return false;
    }
    // The first item doesn't fit. When it began here, it is taller than the space left:
    // cut inside it (its paragraph's lines, its nested list's items).
    if (out > 0) {
      const inner = cutInBlocks(view, item, itemPos + 1, g);
      if (inner && inner.pos > itemPos + 1) {
        result = { pos: inner.pos, unitEnd: inner.unitEnd, rule: 'nested', unitHeight: 0 };
        return false;
      }
    }
    result = { pos: listPos, unitEnd: itemEnd, rule: 'item', unitHeight: unitHeightOf(el, g) };
    return false;
  });
  return result ?? { pos: listPos, unitEnd: listPos + list.nodeSize, rule: 'block', unitHeight: 0 };
}

/** Definition groups: a dt with the dd's after it (leading dd's form a group of their own). */
function cutInDefinitionList(view: EditorView, dl: PMNode, dlPos: number, g: Geometry): FlowCut {
  const groups: { from: number; to: number; first: boolean }[] = [];
  let pos = dlPos + 1;
  dl.forEach((child, _offset, k) => {
    if (k === 0 || child.type.name === 'definitionTerm') groups.push({ from: pos, to: pos, first: k === 0 });
    pos += child.nodeSize;
    groups[groups.length - 1]!.to = pos;
  });
  let result: FlowCut | null = null;
  let group = 0;
  forEachBlock(view, dl, dlPos + 1, (_child, childPos, _k, el) => {
    while (group < groups.length - 1 && childPos >= groups[group]!.to) group += 1;
    if (!blockRects(el, g.eps).some((r) => isOutside(r, g))) return true;
    const { from, to } = groups[group]!;
    result = { pos: group > 0 ? from : dlPos, unitEnd: to, rule: 'group', unitHeight: 0 };
    return false;
  });
  return result ?? { pos: dlPos, unitEnd: dlPos + dl.nodeSize, rule: 'block', unitHeight: 0 };
}

/** Moves a page-level cut above the heading(s) right before it: headings stay with their text. */
export function keepWithNext(page: PageRef, cut: number): number {
  let pos = page.contentStart;
  let index = 0;
  while (index < page.node.childCount && pos < cut) {
    pos += page.node.child(index).nodeSize;
    index += 1;
  }
  if (pos !== cut) return cut; // not between two blocks of the page
  let result = cut;
  while (index > 0 && page.node.child(index - 1).type.name === 'heading') {
    index -= 1;
    result -= page.node.child(index).nodeSize;
  }
  return result;
}

/**
 * Where overflowing page `page` must end (plan §4.4). `m` is its measurement (m.overflow true).
 * The position is normalized (never at the start or end of a node's content) and strictly
 * inside the page's flow; null when nothing can move.
 */
export function chooseCut(view: EditorView, page: PageRef, m: PageMeasure): CutChoice {
  if (!m.overflow || !m.first) return { pos: null, oversized: false, rule: 'none' };
  const doc = view.state.doc;
  const raw = cutInBlocks(view, page.node, page.contentStart, m, m.first.index) ?? {
    pos: m.first.pos,
    unitEnd: m.first.pos + page.node.child(m.first.index).nodeSize,
    rule: 'block' as const,
    unitHeight: unitHeightOf(m.first.el, m),
  };
  const inside = (pos: number) => pos > page.contentStart && pos < page.contentEnd;

  let pos = normalizeCut(doc, raw.pos);
  let rule = raw.rule;
  const kept = keepWithNext(page, pos);
  if (kept !== pos) {
    // Moving the heading(s) that start the page along with the unit would only flag the page
    // (the unit would start it again). If the unit fits a fresh page, break keep-with-next:
    // the heading stays, the unit moves on (pullTarget won't pull the heading after it).
    if (kept <= page.contentStart && inside(pos) && raw.unitHeight <= m.box.height + m.eps) return { pos, oversized: false, rule };
    pos = kept;
    rule = 'keepWithNext';
  }
  if (inside(pos)) return { pos, oversized: false, rule };
  if (pos >= page.contentEnd) return { pos: null, oversized: false, rule: 'none' };

  // The unit that doesn't fit starts the page (after its headings, if any): moving it would
  // move it forever. It stays, the page is flagged, and whatever follows it moves on.
  const after = normalizeCut(doc, raw.unitEnd);
  return { pos: inside(after) ? after : null, oversized: true, rule: 'oversized' };
}
