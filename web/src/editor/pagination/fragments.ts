// Fragments of one block split across pages (continuations) share their formatting.
//
// A paragraph (list, definition list) that pagination split is one block to the author, so a
// formatting change on any of its fragments is a change of the whole block:
//
//   shareFragmentAttrs   appendTransaction: an attribute a transaction changed on one fragment
//                        (align, classes, style, attributes) is written to the others. Without
//                        it the next boundary move re-joins the fragments, keeping the head's
//                        attributes only, and the change is lost outside the undo history.
//   updateAttributes     TipTap's command, with AttrSteps (tr.setNodeAttribute) instead of
//                        setNodeMarkup. setNodeMarkup's undo step replaces the whole node; once
//                        pagination re-joins or re-splits that node (join + split), history can't
//                        map it and the undo is silently lost. An AttrStep maps by the node's
//                        start, which a re-join keeps.
//
//   clearOrphanedContinuations
//                        appendTransaction: when the author deletes the head of a split block
//                        (the whole node, not just its text), the fragment on the next page becomes
//                        a block of its own. Left flagged, the next boundary move would merge it
//                        into whatever block ends the page now (plan §4.8, P4.7).
//
// Type changes (setBlockType) have no attribute-step equivalent: commands/blockType.ts replaces
// whole nodes instead, which history can map through pagination.
//
// Section settings of a page (SECTION_ATTRS) belong to its section: updateAttributes writes them
// to the section's first page (commands/sections.ts copies them to the auto pages).
import { commands as coreCommands, type RawCommands } from '@tiptap/core';
import type { Attrs, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { AttrStep, Mapping, ReplaceAroundStep } from '@tiptap/pm/transform';
import { SECTION_ATTRS } from '../schema/nodes/page';
import { carriesPageData, isAutoPage, mapToken, pageAt, rejoinContinuations, sectionStartIndex } from './boundary';
import { JoinPagesStep, restorePageAt } from './pageSteps';
import { PAGINATE, SECTION_SYNC } from './state';

/** Meta on the transaction the pagination plugin appends (fragment attributes, orphans). */
export const FRAGMENT_ATTRS = 'hbFragmentAttrs';

/**
 * Meta: this transaction deletes a split block's head on purpose and keeps the fragment after it
 * a continuation (it joins the block before the head; commands/continuation.ts).
 */
export const KEEP_CONTINUATIONS = 'hbKeepContinuations';

/**
 * A document change by the author (or a command): not pagination's, not one this file appended,
 * not the section sync's.
 */
export const isAuthorChange = (tr: Transaction): boolean =>
  tr.docChanged && tr.getMeta(PAGINATE) === undefined && tr.getMeta(FRAGMENT_ATTRS) === undefined && tr.getMeta(SECTION_SYNC) === undefined;

/** Attributes that belong to one fragment: the flag itself, ids (first fragment only), numbering. */
const OWN_ATTRS = new Set(['continuation', 'id', 'start', 'customId']);

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Positions of every fragment of the block at `pos` (head first; just [pos] for a block that
 * isn't split). Fragments meet at page seams: the head is the last node at its level of its page,
 * the next fragment the first at the same level of the next (auto) page, with the same type and
 * `continuation`, and so is every ancestor between them and the page (rejoinContinuations
 * joins exactly these).
 */
export function fragmentChain(doc: PMNode, pos: number): number[] {
  const node = doc.nodeAt(pos);
  if (!node || node.isText || doc.resolve(pos).depth < 1) return [pos];
  const chain = [pos];
  for (let at = pos, cur: PMNode = node; cur.attrs.continuation === true; ) {
    const prev = neighbour(doc, at, -1);
    if (prev === null) break;
    chain.unshift(prev);
    at = prev;
    cur = doc.nodeAt(prev)!;
  }
  for (let at = pos; ; ) {
    const next = neighbour(doc, at, 1);
    if (next === null) break;
    chain.push(next);
    at = next;
  }
  return chain;
}

/** The fragment before (dir -1) or after (dir 1) the node at `pos` across a page seam, or null. */
function neighbour(doc: PMNode, pos: number, dir: -1 | 1): number | null {
  const $pos = doc.resolve(pos);
  const depth = $pos.depth; // the node's parent's depth; the page is at depth 1
  // On the page's spine: last (dir 1) or first (dir -1) child at every level.
  for (let d = 1; d <= depth; d++) {
    const index = $pos.index(d);
    if (dir === 1 ? index !== $pos.node(d).childCount - 1 : index !== 0) return null;
  }
  const pageIndex = $pos.index(0);
  const otherIndex = pageIndex + dir;
  if (otherIndex < 0 || otherIndex >= doc.childCount) return null;
  const tailPage = dir === 1 ? doc.child(otherIndex) : doc.child(pageIndex);
  if (!isAutoPage(tailPage)) return null;
  // Walk down the other page's spine, level by level, checking types and the flag (the side
  // after the seam must be a continuation at every level). The other page starts right after or
  // before this one (O(depth), not a sum over the pages before it).
  const pagePos = $pos.before(1);
  let otherPos = dir === 1 ? pagePos + $pos.node(1).nodeSize : pagePos - doc.child(otherIndex).nodeSize;
  let other: PMNode = doc.child(otherIndex);
  for (let d = 2; d <= depth + 1; d++) {
    const child: PMNode | null = dir === 1 ? other.firstChild : other.lastChild;
    if (!child) return null;
    otherPos = dir === 1 ? otherPos + 1 : otherPos + other.nodeSize - 1 - child.nodeSize;
    other = child;
    const mine = d <= depth ? $pos.node(d) : doc.nodeAt(pos)!;
    const after = dir === 1 ? other : mine;
    if (other.type !== mine.type || after.attrs.continuation !== true) return null;
  }
  return otherPos;
}

/** Attribute names that differ between two nodes of the same type ([] for a type change). */
function changedKeys(before: PMNode | null, after: PMNode | null): string[] {
  if (!before || !after || before.type !== after.type) return [];
  return Object.keys(after.attrs).filter((key) => !sameValue(before.attrs[key], after.attrs[key]));
}

/** A setNodeMarkup step: the node at `from` rewrapped with new attributes (same content). */
function isMarkupStep(step: ReplaceAroundStep): boolean {
  const s = step as unknown as { from: number; to: number; gapFrom: number; gapTo: number; insert: number; structure: boolean };
  return s.structure && s.gapFrom === s.from + 1 && s.gapTo === s.to - 1 && s.insert === 1 && step.slice.size === 2 && step.slice.content.childCount === 1;
}

/**
 * appendTransaction: attributes that `trs` changed on a fragment of a split block, written to the
 * block's other fragments (in `state`, the state after `trs`). Then, at the seams after pages
 * `pages` (the pages the transactions touched), fragments whose attributes still differ from
 * their head's take the head's: an edit that replaced the head or joined it with the block
 * before it (Backspace, a range delete) gave the block the head's new attributes, as in an unsplit
 * block. Pagination's own transactions are left alone (they copy attributes when they split).
 * The result joins the same undo event.
 */
export function shareFragmentAttrs(trs: readonly Transaction[], state: EditorState, pages: [number, number] | null = null): Transaction | null {
  const tr = state.tr;
  addSharedFragmentAttrs(tr, trs, pages);
  return tr.steps.length > 0 ? tr.setMeta(FRAGMENT_ATTRS, true) : null;
}

/**
 * shareFragmentAttrs, adding its steps to `tr` (a transaction on the state after `trs`, holding
 * only attribute steps so far: positions after `trs` are positions in tr.doc).
 */
export function addSharedFragmentAttrs(tr: Transaction, trs: readonly Transaction[], pages: [number, number] | null = null): void {
  const changed: { pos: number; keys: string[] }[] = [];
  trs.forEach((source, t) => {
    if (source.getMeta(PAGINATE) !== undefined || source.getMeta(FRAGMENT_ATTRS) !== undefined) return;
    source.steps.forEach((step, k) => {
      let pos: number;
      let keys: string[];
      if (step instanceof AttrStep) {
        pos = step.pos;
        keys = [step.attr];
      } else if (step instanceof ReplaceAroundStep && isMarkupStep(step)) {
        pos = step.from;
        keys = changedKeys(source.docs[k]!.nodeAt(pos), step.slice.content.firstChild);
      } else return;
      keys = keys.filter((key) => !OWN_ATTRS.has(key));
      if (keys.length === 0) return;
      // To the final document: through the rest of this transaction and the ones after it.
      let result = source.mapping.slice(k + 1).mapResult(pos, 1);
      for (const later of trs.slice(t + 1)) {
        if (result.deletedAfter) return;
        result = later.mapping.mapResult(result.pos, 1);
      }
      if (!result.deletedAfter) changed.push({ pos: result.pos, keys });
    });
  });
  if (changed.length === 0 && pages === null) return;
  // Only attribute steps so far: positions after `trs` are positions in tr.doc. Chains are read
  // from tr.doc, so a fragment whose continuation flag was just cleared (orphans) is left alone.
  const doc = tr.doc;
  for (const { pos, keys } of changed) {
    const node = doc.nodeAt(pos);
    if (!node || node.isText) continue;
    for (const other of fragmentChain(doc, pos)) {
      if (other === pos) continue;
      const fragment = tr.doc.nodeAt(other)!;
      for (const key of keys) {
        if (key in fragment.attrs && !sameValue(fragment.attrs[key], node.attrs[key])) tr.setNodeAttribute(other, key, node.attrs[key]);
      }
    }
  }
  if (pages !== null) {
    // Past the touched pages while a seam changed: a block split over more pages passes its new
    // attributes on, fragment by fragment.
    for (let i = Math.max(0, pages[0] - 1), changed = false; i + 1 < tr.doc.childCount && (i <= pages[1] || changed); i++) changed = followHead(tr, i);
  }
}

/**
 * appendTransaction part: fragments whose head the author's transactions `trs` removed (the head
 * node itself, e.g. a deleted or moved paragraph, not only its text) lose their continuation
 * flag, level by level from the removed level down, so the next boundary move doesn't merge them
 * into whatever ends the page now. Adds the attribute steps to `tr` (a transaction on the state
 * after `trs`); `oldDoc` is the document before `trs`.
 *
 * A head counts as removed when both sides of the end of its content were deleted. Deleting its
 * text keeps the (empty) head, and a delete that joins it with the block before it keeps its end:
 * in both the fragment still continues that block, as in an unsplit paragraph.
 */
export function clearOrphanedContinuations(tr: Transaction, trs: readonly Transaction[], oldDoc: PMNode): void {
  const authored = trs.filter(isAuthorChange);
  if (authored.length === 0 || authored.some((t) => t.getMeta(KEEP_CONTINUATIONS) === true)) return;
  const mapping = new Mapping();
  for (const t of trs) mapping.appendMapping(t.mapping);
  const doc = tr.doc;
  let pagePos = 0;
  for (let k = 0; k + 1 < oldDoc.childCount; k++) {
    const page = oldDoc.child(k);
    const nextPos = pagePos + page.nodeSize;
    const next = oldDoc.child(k + 1);
    let before: PMNode | null = page.lastChild;
    let after: PMNode | null = next.firstChild;
    let beforePos = before ? nextPos - 1 - before.nodeSize : 0;
    let afterPos = nextPos + 1;
    while (isAutoPage(next) && before && after && !after.isText && after.attrs.continuation === true && before.type === after.type) {
      const headEnd = mapping.mapResult(beforePos + before.nodeSize - 1, -1);
      if (headEnd.deletedAcross) {
        const tail = mapping.mapResult(afterPos, 1);
        if (!tail.deletedAfter) clearChainFrom(tr, doc, tail.pos, after.type.name);
        break;
      }
      const lastChild: PMNode | null = before.lastChild;
      beforePos = lastChild ? beforePos + before.nodeSize - 1 - lastChild.nodeSize : beforePos;
      before = lastChild;
      after = after.firstChild;
      afterPos += 1;
    }
    pagePos = nextPos;
  }
}

/**
 * Positions (in the document after `trs`) of the fragments that were chained continuations before
 * `trs` (in `oldDoc`: on an auto page's first-child spine, after a same-type head), and of the
 * nodes whose flag an attribute step in `trs` set (an undo of Enter at a seam, of an orphan's
 * clearing). Every page is walked, not only those near the change: an undo can bring a fragment
 * back to a page far from where the history's mapping puts its change. neighbour() is O(depth)
 * (P8.1), so the walk stays linear in the pages.
 */
function formerContinuations(trs: readonly Transaction[], oldDoc: PMNode, mapping: Mapping): Set<number> {
  const were = new Set<number>();
  let pagePos = 0;
  oldDoc.forEach((page, _offset, index) => {
    if (index > 0 && isAutoPage(page)) {
      let pos = pagePos + 1;
      for (let node = page.firstChild; node && !node.isText && node.attrs.continuation === true; node = node.firstChild, pos += 1) {
        if (neighbour(oldDoc, pos, -1) === null) break;
        const mapped = mapToken(mapping, pos);
        if (mapped !== null) were.add(mapped);
      }
    }
    pagePos += page.nodeSize;
  });
  trs.forEach((source, t) => {
    source.steps.forEach((step, k) => {
      if (!(step instanceof AttrStep) || step.attr !== 'continuation' || step.value !== true) return;
      // (appendMapping would take a slice's maps before k too.)
      const rest = new Mapping(source.mapping.maps.slice(k + 1));
      for (const later of trs.slice(t + 1)) rest.appendMapping(later.mapping);
      const mapped = mapToken(rest, step.pos);
      if (mapped !== null) were.add(mapped);
    });
  });
  return were;
}

/**
 * The textblock that ends right before the node at `pos` in reading order, with only closing and
 * opening tokens between them (across a page seam when `pos` starts an auto page's flow), or null.
 */
function textblockBefore(doc: PMNode, pos: number): { pos: number; node: PMNode } | null {
  let at = pos;
  for (;;) {
    const $at = doc.resolve(at);
    const before = $at.nodeBefore;
    if (before) {
      let node: PMNode = before;
      let nodePos = at - before.nodeSize;
      while (!node.isTextblock) {
        const last = node.lastChild;
        if (!last || node.isLeaf) return null;
        nodePos += node.nodeSize - 1 - last.nodeSize;
        node = last;
      }
      return { pos: nodePos, node };
    }
    if ($at.depth === 0) return null;
    // Leaving a page backwards: only an auto page continues the page before it.
    if ($at.depth === 1 && !isAutoPage($at.node(1))) return null;
    at = $at.before();
  }
}

/** A repair of a flagged node that no chain reaches (see repairContinuations). */
type Repair = { kind: 'clear'; pos: number; type: string } | { kind: 'join'; pos: number } | { kind: 'merge'; pos: number; into: number };

/**
 * appendTransaction part (after clearOrphanedContinuations and the attribute sharing): continuation
 * flags on the pages the author's transactions touched (`pages`, in `tr.doc`) that no chain reaches
 * any more. A flagged node is reached when it continues, across the seam before its auto page, a
 * same-type head (fragmentChain; an empty filler at the start of a reached list item counts too).
 * Any other flag is repaired in the author's undo event (for an undo, on the redo stack):
 *
 *   join   it was a continuation before these transactions (or they set its flag: an undo) and
 *          now follows a node of its type inside a page: joined with it (review finding PGR-10: an
 *          undo re-flags a fragment that pagination has since moved next to its head);
 *   merge  such a textblock whose head is now another block (a heading an undo restored over
 *          the head fragment, a head that Backspace or Delete moved into a list item): its text
 *          goes to the end of the textblock right before it, which is what the same edit does in
 *          an unsplit paragraph (PGR-1, PGR-4). Across a seam the pages are joined first
 *          (JoinPagesStep; a page with objects or markers comes back after the block);
 *   clear  anything else (a paragraph that Enter or a block insert split off inside a
 *          continuation, PGR-6): the flag goes, so it renders and saves as a block of its own.
 *
 * A textblock moved deeper than the block before it (wrapped into a list or quote by a path that
 * isn't chain-aware) is cleared rather than merged: its wrapper would lose it.
 */
export function repairContinuations(tr: Transaction, trs: readonly Transaction[], oldDoc: PMNode, pages: [number, number] | null): void {
  if (pages === null || trs.some((t) => isAuthorChange(t) && t.getMeta(KEEP_CONTINUATIONS) === true)) return;
  const mapping = new Mapping();
  for (const t of trs) mapping.appendMapping(t.mapping);
  const doc = tr.doc; // only attribute steps so far: positions after `trs`
  const repairs: Repair[] = [];
  const first = Math.max(0, pages[0] - 1);
  const last = Math.min(doc.childCount - 1, pages[1] + 1);
  const were = formerContinuations(trs, oldDoc, mapping);
  let pagePos = pageAt(doc, first)!.pos;
  for (let index = first; index <= last; index++) {
    const page = doc.child(index);
    page.descendants((node, offset, parent, childIndex) => {
      if (node.isText) return false;
      const pos = pagePos + 1 + offset;
      if (node.attrs.continuation !== true) return !node.isTextblock;
      if (neighbour(doc, pos, -1) !== null) return !node.isTextblock;
      // The empty paragraph a continued list item starts with before its nested list (splitFilled).
      if (node.isTextblock && node.content.size === 0 && childIndex === 0 && parent !== null && parent !== page && parent.attrs.continuation === true) return false;
      if (were.has(pos)) {
        const $pos = doc.resolve(pos);
        if ($pos.nodeBefore?.type === node.type) {
          repairs.push({ kind: 'join', pos });
          return false;
        }
        const head = node.isTextblock ? textblockBefore(doc, pos) : null;
        if (head && doc.resolve(head.pos).depth >= $pos.depth) {
          repairs.push({ kind: 'merge', pos, into: head.pos });
          return false;
        }
      }
      repairs.push({ kind: 'clear', pos, type: node.type.name });
      return false;
    });
    pagePos += page.nodeSize;
  }
  // Last first: a repair changes nothing before its own position.
  for (let k = repairs.length - 1; k >= 0; k--) {
    const repair = repairs[k]!;
    if (repair.kind === 'clear') clearChainFrom(tr, tr.doc, repair.pos, repair.type);
    else if (repair.kind === 'join') rejoinContinuations(tr, repair.pos);
    else mergeInto(tr, repair.into, repair.pos);
  }
}

/**
 * Moves the text of the textblock at `pos` to the end of the textblock at `into` (right before it
 * in reading order, possibly across a page seam), as deleting the tokens between them does.
 */
function mergeInto(tr: Transaction, into: number, pos: number): void {
  const intoIndex = tr.doc.resolve(into).index(0);
  const index = tr.doc.resolve(pos).index(0);
  let from = into + tr.doc.nodeAt(into)!.nodeSize - 1;
  let to = pos + 1;
  let keep: PMNode | null = null;
  if (index !== intoIndex) {
    // The textblock starts the next (auto) page: join the pages first.
    const page = pageAt(tr.doc, index)!;
    if (tr.maybeStep(new JoinPagesStep(page.pos, 1)).failed) {
      clearChainFrom(tr, tr.doc, pos, tr.doc.nodeAt(pos)!.type.name);
      return;
    }
    keep = page.node;
    to -= 2;
  }
  tr.delete(from, to);
  from = tr.mapping.slice(tr.steps.length - 1).map(from, -1);
  if (keep && carriesPageData(keep)) restorePageAt(tr, from, keep.attrs);
}

/** Clears `continuation` on the node at `pos` (of type `typeName`) and down its first-child spine. */
function clearChainFrom(tr: Transaction, doc: PMNode, pos: number, typeName: string): void {
  let node = doc.nodeAt(pos);
  if (!node || node.type.name !== typeName) return;
  for (let at = pos; node && !node.isText && node.attrs.continuation === true; ) {
    if (tr.doc.nodeAt(at)?.attrs.continuation === true) tr.setNodeAttribute(at, 'continuation', false);
    node = node.firstChild;
    at += 1;
  }
}

/**
 * At the seam after page `i`, level by level: a continuation's shared attributes become its
 * head's. Returns whether it changed any.
 */
function followHead(tr: Transaction, i: number): boolean {
  let pos = 1;
  for (let k = 0; k <= i; k++) pos += tr.doc.child(k).nodeSize;
  if (!isAutoPage(tr.doc.child(i + 1))) return false;
  let before: PMNode | null = tr.doc.child(i).lastChild;
  let after: PMNode | null = tr.doc.child(i + 1).firstChild;
  let changed = false;
  while (before && after && !after.isText && after.attrs.continuation === true && before.type === after.type) {
    for (const [key, value] of Object.entries(before.attrs)) {
      if (!OWN_ATTRS.has(key) && !sameValue(after.attrs[key], value)) {
        tr.setNodeAttribute(pos, key, value);
        changed = true;
      }
    }
    before = before.lastChild;
    after = after.firstChild;
    pos += 1;
  }
  return changed;
}

const SECTION_KEYS: ReadonlySet<string> = new Set(SECTION_ATTRS);

/**
 * Writes `attributes` onto the node at `pos` with one AttrStep per changed, declared attribute.
 * Section settings of an auto page go to its section's first page instead (the section sync
 * copies them to every auto page of the section; an AttrStep on an auto page could be undone
 * on a page pagination has since merged away).
 */
function setAttributes(tr: Transaction, pos: number, node: PMNode, attributes: Attrs): void {
  const declared = node.type.spec.attrs ?? {};
  let head: number | null = null;
  if (node.type.name === 'page' && isAutoPage(node) && tr.doc.resolve(pos).depth === 0) {
    head = pageAt(tr.doc, sectionStartIndex(tr.doc, tr.doc.resolve(pos).index(0)))?.pos ?? null;
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (!(key in declared)) continue;
    const at = head !== null && SECTION_KEYS.has(key) ? head : pos;
    const current = tr.doc.nodeAt(at);
    if (current && !sameValue(current.attrs[key], value)) tr.setNodeAttribute(at, key, value);
  }
}

/**
 * TipTap's updateAttributes for nodes, with AttrSteps (see the top of this file). The nodes are
 * the ones TipTap picks: with a caret, the innermost node of the type around it; with a range, the
 * nodes of the type starting in it and the innermost one it starts in. Marks: TipTap's command.
 */
export const updateAttributes: RawCommands['updateAttributes'] = (typeOrName, attributes = {}) => (props) => {
  const { tr, dispatch } = props;
  const name = typeof typeOrName === 'string' ? typeOrName : typeOrName.name;
  const nodeType = tr.doc.type.schema.nodes[name];
  if (!nodeType) return coreCommands.updateAttributes(typeOrName, attributes)(props);
  let found = false;
  const doc = tr.doc;
  tr.selection.ranges.forEach((range) => {
    const from = range.$from.pos;
    const to = range.$to.pos;
    const targets: { pos: number; node: PMNode }[] = [];
    let around: { pos: number; node: PMNode } | null = null;
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type !== nodeType) return;
      found = true;
      if (tr.selection.empty || pos < from) around = { pos, node };
      else if (pos <= to) targets.push({ pos, node });
    });
    if (around) targets.push(around);
    if (dispatch) for (const { pos, node } of targets) setAttributes(tr, pos, node, attributes);
  });
  return found;
};
