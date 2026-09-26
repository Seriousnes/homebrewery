// Block type changes whose undo survives pagination (review finding PG-2).
//
// ProseMirror's setBlockType rewraps a textblock with a ReplaceAroundStep whose "gap" is the
// block's content. Once pagination splits that block across pages (or re-joins its fragments),
// the gap is no longer a flat range: history can't map the undo step, and the undo is silently
// lost. These commands replace the whole textblock instead (a ReplaceStep with the new node and
// the same content). A ReplaceStep maps through pagination's joins and splits: its undo puts the
// old block back over whatever range the new one covers by then, even across a page boundary
// (pagination then settles the pages again).
//
// A paragraph split across pages (a continuation chain) is one block to the author: all of it
// changes type. The pages it spans are joined and its fragments re-joined first (JoinPagesStep
// and join steps, whose undo splits and re-creates the pages at the seams again), then the one
// block is replaced. Pagination lays the new block out (a heading or code block moves whole);
// pages that carried objects or markers come back after it.
//
// The selection keeps its place in the text.
//
//   setTextblockType(type, attrs?)               PM command (like setBlockType)
//   toggleTextblockType(type, toggleType, attrs?) PM command (like TipTap's toggleNode)
//   setListType(listType)                        PM command: bullet ↔ ordered for the list the
//                                                selection is in, all its fragments (TipTap's
//                                                toggleList does it with setNodeMarkup on one
//                                                fragment, which breaks the chain)
//   withChainsJoined(command)                    a wrap command (list, blockquote, theme block) on
//                                                whole split paragraphs, with an undo that
//                                                survives pagination (PGR-3)
//   BlockTypeCommands                            TipTap extension: TipTap's setNode, toggleNode,
//                                                toggleList, wrapIn and wrapInList with these, so
//                                                setParagraph, setHeading, toggleHeading,
//                                                setCodeBlock, toggleCodeBlock, toggleBulletList,
//                                                toggleOrderedList, toggleBlockquote and their
//                                                shortcuts are history-safe too.
//
// A textblock that can't take the type where it is (a list item's paragraph can't become a
// heading) falls back to TipTap's setNode, which lifts it out of its wrapper first (clearNodes);
// that lift is not history-safe on a split list.
import { Extension, commands as coreCommands, type RawCommands } from '@tiptap/core';
import { wrapIn as pmWrapIn } from '@tiptap/pm/commands';
import { Fragment, type Attrs, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model';
import { wrapInList as pmWrapInList } from '@tiptap/pm/schema-list';
import { EditorState, Selection, TextSelection, type Command, type Transaction } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep, Transform, canJoin, type Step } from '@tiptap/pm/transform';
import { JoinPagesStep, carriesPageData, fragmentChain, pageAt, pageIndexAt, rejoinContinuations, restorePageAt } from '../pagination';

/** Attributes a converted block keeps from the block it replaces (when its type has them). */
const CARRIED = ['classes', 'style', 'attributes', 'align', 'id', 'language'];

/** Attributes of the block replacing `node` with type `type` (explicit `attrs` win). */
export function convertedAttrs(node: PMNode, type: NodeType, attrs: Attrs | null = null): Attrs {
  const declared = type.spec.attrs ?? {};
  const out: Record<string, unknown> = {};
  for (const key of CARRIED) if (key in declared && key in node.attrs) out[key] = node.attrs[key];
  // A generated heading id belongs to the heading: dropped when it becomes something else. An id
  // the author set stays, and marks the new heading's id as the author's.
  if (node.type.name === 'heading' && node.attrs.customId !== true) out.id = null;
  if (type.name === 'heading') {
    if (node.type === type) out.customId = node.attrs.customId;
    else if ('customId' in declared) out.customId = typeof out.id === 'string' && out.id !== '';
  }
  if (node.type === type && 'level' in declared) out.level = node.attrs.level;
  if ('continuation' in declared) out.continuation = false;
  for (const [key, value] of Object.entries(attrs ?? {})) if (key in declared) out[key] = value;
  return out;
}

/** `content` made valid for `type`: marks it doesn't allow dropped, line breaks as newlines in code. */
export function convertedContent(content: Fragment, type: NodeType, schema: Schema): Fragment {
  if (type.validContent(content) && !type.spec.code) return content;
  const parts: PMNode[] = [];
  content.forEach((child) => {
    if (child.isText) {
      const marks = type.spec.code ? [] : child.marks.filter((m) => type.allowsMarkType(m.type));
      parts.push(child.mark(marks));
    } else if (type.spec.code) {
      if (child.type.name === 'hardBreak') parts.push(schema.text('\n'));
      else if (child.textContent) parts.push(schema.text(child.textContent));
    } else if (type.contentMatch.matchType(child.type)) {
      parts.push(child.mark(child.marks.filter((m) => type.allowsMarkType(m.type))));
    }
  });
  const fragment = Fragment.fromArray(parts);
  return type.validContent(fragment) ? fragment : Fragment.empty;
}

/** Whether a block of type `type` can stand where the textblock at `pos` is. */
function canChangeType(doc: PMNode, pos: number, type: NodeType): boolean {
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  return $pos.parent.canReplaceWith(index, index + 1, type);
}

interface Target {
  /** positions of the fragments, head first (just the block when it isn't split) */
  chain: number[];
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether `node` already is `type` with (at least) `attrs`. */
const isAlready = (node: PMNode, type: NodeType, attrs: Attrs | null): boolean =>
  node.type === type && Object.entries(attrs ?? {}).every(([key, value]) => !(key in node.attrs) || sameValue(node.attrs[key], value));

/**
 * Textblocks the selection covers that aren't already `type` with `attrs`, as whole chains, and
 * whether some covered textblock can't take the type where it stands.
 */
export function blockTypeTargets(state: EditorState, type: NodeType, attrs: Attrs | null): { chains: Target[]; blocked: boolean } {
  const heads = new Map<number, Target>();
  let blocked = false;
  const doc = state.doc;
  for (const range of state.selection.ranges) {
    doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (!node.isTextblock) return true;
      if (isAlready(node, type, attrs)) return false;
      if (node.type !== type && !canChangeType(doc, pos, type)) {
        blocked = true;
        return false;
      }
      const chain = fragmentChain(doc, pos);
      if (!heads.has(chain[0]!)) heads.set(chain[0]!, { chain });
      return false;
    });
  }
  return { chains: [...heads.values()].sort((a, b) => a.chain[0]! - b.chain[0]!), blocked };
}

/** Attributes that belong to one fragment of a split block (never written to all of them). */
const OWN_ATTRS = new Set(['continuation', 'id', 'customId', 'start']);

/** Text offset of `pos` within a chain (fragment contents joined), or null when it isn't inside. */
function chainOffset(doc: PMNode, chain: number[], pos: number): number | null {
  let offset = 0;
  for (const at of chain) {
    const node = doc.nodeAt(at)!;
    if (pos > at && pos < at + node.nodeSize) return offset + (pos - at - 1);
    offset += node.content.size;
  }
  return null;
}

/**
 * Changes the chain (head first) to `type`. Same type (other attributes, e.g. a heading level):
 * attribute steps on every fragment. Another type: the pages the chain spans are joined and its
 * fragments re-joined into one block (JoinPagesStep and join steps: an undo splits the block at
 * the seams again and re-creates the pages there, wherever pagination moved things by then), which
 * is then replaced by a block of `type`. Pages that carried objects or markers come back after it.
 */
function changeChain(tr: Transaction, chain: number[], type: NodeType, attrs: Attrs | null): void {
  const schema = tr.doc.type.schema;
  const head = tr.doc.nodeAt(chain[0]!)!;
  if (head.type === type) {
    chain.forEach((pos, k) => {
      const node = tr.doc.nodeAt(pos)!;
      for (const [key, value] of Object.entries(attrs ?? {})) {
        if (!(key in node.attrs) || (k > 0 && OWN_ATTRS.has(key))) continue;
        if (!sameValue(node.attrs[key], value)) tr.setNodeAttribute(pos, key, value);
      }
    });
    return;
  }
  const first = pageIndexAt(tr.doc, chain[0]!);
  const last = pageIndexAt(tr.doc, chain[chain.length - 1]!);
  const joined: PMNode[] = [];
  // Last page first: the head's position stays valid.
  for (let k = last; k > first; k--) {
    const page = pageAt(tr.doc, k)!;
    if (tr.maybeStep(new JoinPagesStep(page.pos, 1)).failed) return;
    joined.unshift(page.node);
    rejoinContinuations(tr, page.pos - 1);
  }
  const block = tr.doc.nodeAt(chain[0]!)!;
  const next = type.create(convertedAttrs(head, type, attrs), convertedContent(block.content, type, schema), head.marks);
  tr.replaceWith(chain[0]!, chain[0]! + block.nodeSize, next);
  restorePages(tr, chain[0]! + next.nodeSize, joined);
}

/**
 * Pages `joined` (in order) were joined into the page holding position `after` (the end of the new
 * block): those that carried objects or markers come back after it, with their attributes. The
 * last one takes whatever followed the block; the others are placeholders (one empty paragraph).
 * PageBreakSteps (restorePageAt): the undo removes exactly these pages, wherever pagination has
 * moved their boundaries by then (review finding PGR-2).
 */
export function restorePages(tr: Transaction, after: number, joined: PMNode[]): void {
  const keep = joined.filter(carriesPageData);
  if (keep.length === 0) return;
  const index = pageIndexAt(tr.doc, after);
  const page = pageAt(tr.doc, index)!;
  const lastKeep = keep[keep.length - 1]!;
  if (after > page.contentStart && after < page.contentEnd && lastKeep === joined[joined.length - 1]) {
    restorePageAt(tr, after, lastKeep.attrs);
    keep.pop();
  }
  // Placeholders right after the page, in order (made last first at the same place).
  for (let k = keep.length - 1; k >= 0; k--) restorePageAt(tr, pageAt(tr.doc, index)!.contentEnd, keep[k]!.attrs);
}

/**
 * Changes the textblocks the selection covers to `type` (with `attrs`), history-safe (see the
 * top of this file). Fails when no covered textblock can take the type where it stands.
 */
export function setTextblockType(typeOrName: NodeType | string, attrs: Attrs | null = null): Command {
  return (state, dispatch) => {
    const type = typeof typeOrName === 'string' ? state.schema.nodes[typeOrName] : typeOrName;
    if (!type || !type.isTextblock) return false;
    const { chains } = blockTypeTargets(state, type, attrs);
    if (chains.length === 0) return false;
    if (dispatch) {
      const tr = state.tr;
      const { anchor, head } = state.selection;
      // Where the selection ends are, as text offsets in the chains that get replaced.
      const place = (pos: number) => {
        for (const t of chains) {
          if (state.doc.nodeAt(t.chain[0]!)!.type === type) continue; // re-attributed: positions stay
          const offset = chainOffset(state.doc, t.chain, pos);
          if (offset !== null) return { chain: t.chain[0]!, offset };
        }
        return null;
      };
      const anchorAt = place(anchor);
      const headAt = place(head);
      // Last chain first: chains don't interleave, so positions before the one changed stay
      // valid. The starts of the chains already changed are mapped through each later change.
      const starts = new Map<number, number>();
      for (let k = chains.length - 1; k >= 0; k--) {
        const chain = chains[k]!.chain;
        const stepsBefore = tr.steps.length;
        changeChain(tr, chain, type, attrs);
        const shift = tr.mapping.slice(stepsBefore);
        for (const [key, value] of starts) starts.set(key, shift.map(value, 1));
        starts.set(chain[0]!, chain[0]!);
      }
      const resolve = (at: { chain: number; offset: number } | null, fallback: number): number => {
        if (!at) return tr.mapping.map(fallback);
        const start = starts.get(at.chain)!;
        const node = tr.doc.nodeAt(start);
        if (!node) return tr.mapping.map(fallback);
        return start + 1 + Math.min(at.offset, node.content.size);
      };
      const selection =
        state.selection instanceof TextSelection
          ? TextSelection.create(tr.doc, resolve(anchorAt, anchor), resolve(headAt, head))
          : state.selection.map(tr.doc, tr.mapping);
      tr.setSelection(selection);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Whether every textblock the selection covers is `type` with (at least) `attrs`. */
export function isTextblockActive(state: EditorState, type: NodeType, attrs: Attrs = {}): boolean {
  let seen = false;
  let all = true;
  for (const range of state.selection.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
      if (!node.isTextblock) return true;
      seen = true;
      if (node.type !== type || Object.entries(attrs).some(([k, v]) => node.attrs[k] !== v)) all = false;
      return false;
    });
  }
  return seen && all;
}

/** `type` (with `attrs`), or `toggleType` when the selection already is `type` (TipTap's toggleNode). */
export function toggleTextblockType(typeOrName: NodeType | string, toggleTypeOrName: NodeType | string, attrs: Attrs | null = null): Command {
  return (state, dispatch, view) => {
    const type = typeof typeOrName === 'string' ? state.schema.nodes[typeOrName] : typeOrName;
    const toggleType = typeof toggleTypeOrName === 'string' ? state.schema.nodes[toggleTypeOrName] : toggleTypeOrName;
    if (!type || !toggleType) return false;
    const active = isTextblockActive(state, type, attrs ?? {});
    return setTextblockType(active ? toggleType : type, active ? null : attrs)(state, dispatch, view);
  };
}

// TipTap ----------------------------------------------------------------------------------------

/**
 * TipTap's setNode with setTextblockType. When some covered textblock can't take the type where
 * it stands (a list item's paragraph), TipTap's own setNode runs (it lifts the blocks out of
 * their wrappers first). When every covered textblock already is the type, nothing happens (false):
 * TipTap's setNode would run clearNodes, whose setNodeMarkup resets the block's attributes (align,
 * classes, a fragment's continuation flag).
 */
export const setNode: RawCommands['setNode'] = (typeOrName, attributes = {}) => (props) => {
  const type = typeof typeOrName === 'string' ? props.state.schema.nodes[typeOrName] : typeOrName;
  if (type?.isTextblock) {
    const { chains, blocked } = blockTypeTargets(props.state, type, attributes);
    if (!blocked && chains.length > 0) return setTextblockType(type, attributes)(props.state, props.dispatch);
    if (!blocked) return false;
  }
  return coreCommands.setNode(typeOrName, attributes)(props);
};

/** TipTap's toggleNode with toggleTextblockType (falls back like setNode). */
export const toggleNode: RawCommands['toggleNode'] = (typeOrName, toggleTypeOrName, attributes = {}) => (props) => {
  const { state } = props;
  const type = typeof typeOrName === 'string' ? state.schema.nodes[typeOrName] : typeOrName;
  const toggleType = typeof toggleTypeOrName === 'string' ? state.schema.nodes[toggleTypeOrName] : toggleTypeOrName;
  if (!type || !toggleType) return coreCommands.toggleNode(typeOrName, toggleTypeOrName, attributes)(props);
  const active = isTextblockActive(state, type, attributes);
  return props.commands.setNode(active ? toggleType : type, active ? {} : attributes);
};

// Lists -----------------------------------------------------------------------------------------

const LIST_TYPES = new Set(['bulletList', 'orderedList']);

/**
 * The list the selection is directly in (the one TipTap's toggleList would switch): the innermost
 * bullet or ordered list around the selection whose items hold the selection's block range.
 */
export function listAround(state: EditorState): { pos: number; node: PMNode } | null {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to);
  if (!range) return null;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (!LIST_TYPES.has(node.type.name)) continue;
    // TipTap: the range must be inside that list, at most one level down (its items).
    return range.depth >= 1 && range.depth - d <= 1 ? { pos: $from.before(d), node } : null;
  }
  return null;
}

/** Attributes of a list of type `type` replacing `node` (generic attributes kept; numbering kept or 1). */
function listAttrs(node: PMNode, type: NodeType): Attrs {
  const declared = type.spec.attrs ?? {};
  const out: Record<string, unknown> = {};
  for (const key of ['classes', 'style', 'attributes', 'id']) if (key in declared && key in node.attrs) out[key] = node.attrs[key];
  if ('start' in declared) out.start = typeof node.attrs.start === 'number' ? node.attrs.start : 1;
  if ('continuation' in declared) out.continuation = false;
  return out;
}

/**
 * Changes the list the selection is in (listAround) to `listType`, history-safe: the list's
 * fragments on other pages are joined into it first (as for block types, see changeChain), so
 * the whole list changes and its undo survives pagination. Like TipTap's toggleList, the new list
 * then joins a list of the same type right before or after it. False when there is no such list
 * or it already is `listType`.
 */
export function setListType(typeOrName: NodeType | string): Command {
  return (state, dispatch) => {
    const listType = typeof typeOrName === 'string' ? state.schema.nodes[typeOrName] : typeOrName;
    const current = listAround(state);
    if (!listType || !LIST_TYPES.has(listType.name) || !current || current.node.type === listType) return false;
    if (!listType.validContent(current.node.content)) return false;
    if (dispatch) {
      const tr = state.tr;
      const chain = fragmentChain(state.doc, current.pos);
      const first = pageIndexAt(tr.doc, chain[0]!);
      const last = pageIndexAt(tr.doc, chain[chain.length - 1]!);
      const joined: PMNode[] = [];
      for (let k = last; k > first; k--) {
        const page = pageAt(tr.doc, k)!;
        if (tr.maybeStep(new JoinPagesStep(page.pos, 1)).failed) return false;
        joined.unshift(page.node);
        rejoinContinuations(tr, page.pos - 1);
      }
      const start = chain[0]!;
      const anchor = tr.mapping.map(state.selection.anchor) - start;
      const head = tr.mapping.map(state.selection.head) - start;
      const list = tr.doc.nodeAt(start)!;
      tr.replaceWith(start, start + list.nodeSize, listType.create(listAttrs(list, listType), list.content, list.marks));
      restorePages(tr, start + list.nodeSize, joined);
      tr.setSelection(TextSelection.create(tr.doc, start + anchor, start + head));
      // TipTap's toggleList joins the list with a same-type list right before or after it.
      const after = start + list.nodeSize;
      const $after = tr.doc.resolve(after);
      if ($after.nodeAfter?.type === listType && canJoin(tr.doc, after)) tr.join(after);
      const $before = tr.doc.resolve(start);
      if ($before.nodeBefore?.type === listType && canJoin(tr.doc, start)) tr.join(start);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * TipTap's toggleList with setListType for its "change the list type" case (the selection is in
 * a list of another type). Wrapping in a list goes through TipTap's wrapInList, which
 * BlockTypeCommands replaces too (withChainsJoined); lifting out of lists stays TipTap's.
 */
export const toggleList: RawCommands['toggleList'] = (listTypeOrName, itemTypeOrName, keepMarks, attributes = {}) => (props) => {
  const listType = typeof listTypeOrName === 'string' ? props.state.schema.nodes[listTypeOrName] : listTypeOrName;
  const current = listAround(props.state);
  if (listType && current && current.node.type !== listType && LIST_TYPES.has(listType.name)) {
    if (setListType(listType)(props.state)) return setListType(listType)(props.state, props.dispatch);
  }
  return coreCommands.toggleList(listTypeOrName, itemTypeOrName, keepMarks, attributes)(props);
};

// Wraps -----------------------------------------------------------------------------------------

/**
 * The pages to join (their indexes, last first) so that every textblock the selection covers, and
 * the textblocks at `more`, are one block on one page again: the pages after the first page of the
 * first split chain, up to the last page of the last one. Empty when none of them is split.
 */
function chainPagesToJoin(state: EditorState, more: number[]): number[] {
  const doc = state.doc;
  let first = Infinity;
  let last = -Infinity;
  const add = (pos: number) => {
    const chain = fragmentChain(doc, pos);
    if (chain.length < 2) return;
    first = Math.min(first, pageIndexAt(doc, chain[0]!));
    last = Math.max(last, pageIndexAt(doc, chain[chain.length - 1]!));
  };
  for (const range of state.selection.ranges) {
    doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (!node.isTextblock) return true;
      add(pos);
      return false;
    });
  }
  for (const pos of more) if (doc.nodeAt(pos)?.isTextblock) add(pos);
  const pages: number[] = [];
  for (let k = last; k > first; k--) pages.push(k);
  return pages;
}

/** A ReplaceAroundStep as the ReplaceStep with the same effect on `doc` (other steps as they are). */
function asReplaceStep(step: Step, doc: PMNode): Step {
  if (!(step instanceof ReplaceAroundStep)) return step;
  const after = step.apply(doc).doc;
  return after ? new ReplaceStep(step.from, step.to, after.slice(step.from, step.getMap().map(step.to, 1))) : step;
}

/**
 * Adds to `tr` (whose document is `before`) the change from `before` to `after` as one ReplaceStep
 * of the whole page-level blocks it touches, when they are on one page; otherwise `steps` (the
 * steps that made `after`, ReplaceAroundSteps as ReplaceSteps).
 */
function replaceBlocks(tr: Transaction, before: PMNode, after: PMNode, steps: readonly Step[], docs: readonly PMNode[]): void {
  const start = before.content.findDiffStart(after.content);
  if (start === null) return;
  const end = before.content.findDiffEnd(after.content)!;
  let endA = end.a;
  let endB = end.b;
  // Repeated content can make the ends overlap the start (as in ProseMirror's own DOM diffing).
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const $from = before.resolve(start);
  const $to = before.resolve(endA);
  if ($from.depth < 1 || $to.depth < 1 || $from.index(0) !== $to.index(0)) {
    steps.forEach((step, k) => tr.step(asReplaceStep(step, docs[k]!)));
    return;
  }
  const from = $from.depth >= 2 ? $from.before(2) : start;
  const to = $to.depth >= 2 ? $to.after(2) : endA;
  tr.replaceWith(from, to, after.slice(from, endB + (to - endA)).content);
}

/**
 * `command` (a wrap: a list, a blockquote, a theme block; a join at a split paragraph's head) made
 * to act on whole blocks and to keep its undo through pagination (review findings PGR-3, PGR-4;
 * the P4 carry-over on list wraps):
 * - A paragraph split across pages is one block to the author (plan §4.8): the pages its chain
 *   spans (of the textblocks the selection covers, and those at `more(state)`) are joined and its
 *   fragments re-joined first (JoinPagesStep and join steps, like changeChain), so the whole
 *   paragraph is wrapped or joined, not the fragment holding the cursor. Pagination then lays the
 *   result out again; joined pages that carried objects or markers come back after it
 *   (restorePages).
 * - The command's change is recorded as one ReplaceStep of the page-level blocks it touches (as
 *   blockType changes and list item moves are). Its own steps (tr.wrap's ReplaceAroundSteps) have
 *   undos whose gap can't be mapped once pagination splits the result (a list moved on item by
 *   item), and history would drop them (PG-2); a whole-block ReplaceStep maps through the joins and
 *   splits.
 * The command runs on a copy of the state; nothing is dispatched when it fails. Without dispatch
 * (can()), `command` answers for the state as it is.
 */
export function withChainsJoined(command: Command, more: (state: EditorState) => number[] = () => []): Command {
  return (state, dispatch, view) => {
    if (!dispatch) return command(state, undefined, view);
    const pre = new Transform(state.doc);
    const joined: PMNode[] = [];
    for (const k of chainPagesToJoin(state, more(state))) {
      const page = pageAt(pre.doc, k)!;
      if (pre.maybeStep(new JoinPagesStep(page.pos, 1)).failed) return command(state, dispatch, view);
      joined.unshift(page.node);
      rejoinContinuations(pre, page.pos - 1);
    }
    const temp = EditorState.create({ doc: pre.doc, selection: state.selection.map(pre.doc, pre.mapping), storedMarks: state.storedMarks });
    let result: Transaction | null = null;
    if (!command(temp, (t) => (result = t), view)) return false;
    const done = result as Transaction | null;
    if (!done) return false;
    const tr = state.tr;
    for (const step of pre.steps) tr.step(step);
    replaceBlocks(tr, pre.doc, done.doc, done.steps, done.docs);
    // The documents are the same: the selection's positions are too.
    tr.setSelection(Selection.fromJSON(tr.doc, done.selection.toJSON()));
    if (done.storedMarksSet) tr.setStoredMarks(done.storedMarks);
    restorePages(tr, tr.selection.to, joined);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** TipTap's wrapIn (toggleBlockquote, toggleWrap) through withChainsJoined. */
export const wrapIn: RawCommands['wrapIn'] = (typeOrName, attributes = {}) => ({ state, dispatch }) => {
  const type = typeof typeOrName === 'string' ? state.schema.nodes[typeOrName] : typeOrName;
  return !!type && withChainsJoined(pmWrapIn(type, attributes))(state, dispatch);
};

/** TipTap's wrapInList (toggleBulletList, toggleOrderedList when not in a list) through withChainsJoined. */
export const wrapInList: RawCommands['wrapInList'] = (typeOrName, attributes = {}) => ({ state, dispatch }) => {
  const type = typeof typeOrName === 'string' ? state.schema.nodes[typeOrName] : typeOrName;
  return !!type && withChainsJoined(pmWrapInList(type, attributes))(state, dispatch);
};

/**
 * Replaces TipTap's setNode, toggleNode and toggleList (and so setParagraph, setHeading,
 * toggleHeading, setCodeBlock, toggleCodeBlock, toggleBulletList, toggleOrderedList and their
 * shortcuts) with the history-safe versions, and wrapIn and wrapInList (toggleBlockquote, list
 * wraps) with chain-aware, history-safe ones. Default priority: it must come after TipTap's core
 * commands, which it overrides.
 */
export const BlockTypeCommands = Extension.create({
  name: 'hbBlockType',

  addCommands() {
    return { setNode, toggleNode, toggleList, wrapIn, wrapInList };
  },
});
