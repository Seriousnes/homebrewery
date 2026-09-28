// Block commands behind the keymap and the toolbar (plan §6.1, §6.2): block type changes, the
// "Text style" menu's styles (definition lists, theme boxes), column breaks, theme-block wrapping,
// paragraph alignment, and the read-outs the toolbar shows (block type, list type, alignment).
//
// Every command builds one transaction: plain ProseMirror commands (see marks.ts for how they run
// inside TipTap chains), and the block type changes as TipTap command props. Attribute changes use
// tr.setNodeAttribute (AttrStep): the pagination extension relies on that for undo (implementation
// notes, PG-2). Manual page breaks are commands/sections.ts's insertPageBreak (pagination-UX lane).
import { commands as coreCommands, type CommandProps } from '@tiptap/core';
import { Fragment, NodeRange, type Attrs, type Node as PMNode, type NodeType, type ResolvedPos, type Schema } from '@tiptap/pm/model';
import { liftListItem, sinkListItem } from '@tiptap/pm/schema-list';
import { EditorState, Selection, TextSelection, type Command, type Transaction } from '@tiptap/pm/state';
import { canSplit, findWrapping, liftTarget } from '@tiptap/pm/transform';
import { JoinPagesStep, fragmentChain, pageAt, pageIndexAt, rejoinContinuations } from '../pagination';
import type { ParagraphAlign } from '../schema/nodes/textBlocks';
import { blockTypeTargets, convertedContent, isTextblockActive, restorePages, setTextblockType, withChainsJoined } from './blockType';
import { cleanClassList } from './marks';

// ---------------------------------------------------------------------------------------------
// read-outs for the toolbar

/** The text block types the block-type menu offers. */
export const TEXT_BLOCK_KINDS = ['paragraph', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'codeBlock'] as const;
export type TextBlockKind = (typeof TEXT_BLOCK_KINDS)[number];

export const TEXT_BLOCK_LABELS: Record<TextBlockKind, string> = {
  paragraph: 'Paragraph',
  heading1: 'Heading 1',
  heading2: 'Heading 2',
  heading3: 'Heading 3',
  heading4: 'Heading 4',
  heading5: 'Heading 5',
  heading6: 'Heading 6',
  codeBlock: 'Code block',
};

/**
 * Every text style the "Text style" menu offers: the text block kinds and definition lists (the
 * block-level styles upstream's markdown wrote as `#`…`######`, fences and `Term :: Definition`).
 */
export const TEXT_STYLE_KINDS = [...TEXT_BLOCK_KINDS, 'definitionList'] as const;
export type TextStyleKind = (typeof TEXT_STYLE_KINDS)[number];

export const TEXT_STYLE_LABELS: Record<TextStyleKind, string> = { ...TEXT_BLOCK_LABELS, definitionList: 'Definition list' };

/**
 * Theme boxes the "Text style" menu offers ({{note}}, {{descriptive}}, {{quote}} upstream): theme
 * blocks with one of these classes. The menu shows a box when the active theme styles its class
 * (5ePHB and 5eDMG: all three; Journal: note and descriptive; Blank and UnearthedArcana: none),
 * and always while the selection is in one.
 */
export const THEME_BOX_CLASSES = ['note', 'descriptive', 'quote'] as const;
export type ThemeBoxClass = (typeof THEME_BOX_CLASSES)[number];

export const THEME_BOX_LABELS: Record<ThemeBoxClass, string> = { note: 'Note', descriptive: 'Descriptive text box', quote: 'Quote' };

export const headingKind = (level: number): TextBlockKind => `heading${Math.min(6, Math.max(1, Math.round(level)))}` as TextBlockKind;

/** The heading level of a kind, or null for paragraph and code block. */
export function kindLevel(kind: TextBlockKind): 1 | 2 | 3 | 4 | 5 | 6 | null {
  const match = /^heading([1-6])$/.exec(kind);
  return match ? (Number(match[1]) as 1 | 2 | 3 | 4 | 5 | 6) : null;
}

function kindOf(node: PMNode): TextStyleKind | 'other' {
  switch (node.type.name) {
    case 'paragraph':
      return 'paragraph';
    case 'heading':
      return headingKind(Number(node.attrs.level));
    case 'codeBlock':
      return 'codeBlock';
    case 'definitionTerm':
    case 'definitionDesc':
      return 'definitionList';
    default:
      return 'other';
  }
}

/** Text blocks the selection touches (the cursor's own for an empty selection). */
function selectedTextblocks(state: EditorState): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  for (const range of state.selection.ranges) {
    const from = range.$from.pos;
    const to = range.$to.pos;
    if (from === to) {
      const $pos = range.$from;
      if ($pos.parent.isTextblock) out.push({ node: $pos.parent, pos: $pos.before() });
      continue;
    }
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) {
        out.push({ node, pos });
        return false;
      }
      return true;
    });
  }
  return out;
}

/**
 * The text style the selection has: one kind ('definitionList' for definition list parts), 'mixed'
 * for several, 'other' for a text block no style describes, null when no text block is selected
 * (a selected image, rule or column break).
 */
export function blockKindOf(state: EditorState): TextStyleKind | 'mixed' | 'other' | null {
  let kind: TextStyleKind | 'other' | null = null;
  for (const { node } of selectedTextblocks(state)) {
    const k = kindOf(node);
    if (kind === null) kind = k;
    else if (kind !== k) return 'mixed';
  }
  return kind;
}

/** Whether the selection starts inside a blockquote. */
export function inBlockquote(state: EditorState): boolean {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'blockquote') return true;
  return false;
}

/** The theme box classes of the theme blocks around the selection's start. */
export function themeBoxesAt(state: EditorState): ThemeBoxClass[] {
  const $from = state.selection.$from;
  const found = new Set<ThemeBoxClass>();
  for (let d = $from.depth; d > 1; d--) {
    const node = $from.node(d);
    if (node.type.name !== 'themeBlock') continue;
    for (const cls of THEME_BOX_CLASSES) if (classesOf(node).includes(cls)) found.add(cls);
  }
  return THEME_BOX_CLASSES.filter((cls) => found.has(cls));
}

const classesOf = (node: PMNode): readonly string[] => (Array.isArray(node.attrs.classes) ? (node.attrs.classes as string[]) : []);

export type ListKind = 'bulletList' | 'orderedList';

/** The innermost list around the selection's start. */
export function listKindOf(state: EditorState): ListKind | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'bulletList' || name === 'orderedList') return name;
  }
  return null;
}

/** Whether the selection's start is inside a list item. */
export function inListItem(state: EditorState): boolean {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'listItem') return true;
  return false;
}

/**
 * Whether the innermost list item or table cell around the selection is a table cell: a table
 * inside a list item keeps Tab for its cell navigation (review finding UI-5).
 */
export function inTableCellOfList(state: EditorState): boolean {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'listItem') return false;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}

/**
 * The pages to join before sinking or lifting the list item at the selection, when pagination split
 * the page's top-level block holding it (null: nothing to join). Fragments are found through that
 * block's chain: deeper fragments may start after a filler paragraph (cut.ts 'nested' rule), which
 * fragmentChain doesn't look through.
 * - Sink: the item's previous sibling is on the page before when the item starts a continued list
 *   fragment (PGR-12); an item that ends its page may go on to the next pages (while a page holds
 *   nothing but the block's fragment, the next one too).
 * - Lift: it moves the items after the item too (into the lifted item, or into a list of their
 *   own that must not stay a continuation), so the block's whole chain is joined (PGR-11).
 */
function listJoinRange(state: EditorState, direction: 'sink' | 'lift'): { first: number; last: number } | null {
  const $from = state.selection.$from;
  let depth = -1;
  for (let d = $from.depth; d > 1; d--) {
    if ($from.node(d).type.name === 'listItem') {
      depth = d;
      break;
    }
  }
  if (depth < 0) return null;
  const doc = state.doc;
  const chain = fragmentChain(doc, $from.before(2));
  if (chain.length === 1) return null;
  const chainFirst = pageIndexAt(doc, chain[0]!);
  const chainLast = pageIndexAt(doc, chain[chain.length - 1]!);
  if (direction === 'lift') return { first: chainFirst, last: chainLast };
  const page = $from.index(0);
  let first = page;
  let last = page;
  if ($from.node(depth - 1).attrs.continuation === true && $from.index(depth - 1) === 0) first = Math.max(chainFirst, page - 1);
  let endsPage = true;
  for (let d = 1; d < depth; d++) if ($from.index(d) !== $from.node(d).childCount - 1) endsPage = false;
  if (endsPage) {
    last = Math.min(chainLast, page + 1);
    while (last < chainLast && doc.child(last).childCount === 1) last++;
  }
  return first < last ? { first, last } : null;
}

/**
 * Tab / Shift-Tab: sinks or lifts the list item at the selection (prosemirror-schema-list's
 * sinkListItem / liftListItem), also when pagination split its list across pages (review findings
 * PGR-11, PGR-12). The pages the move needs are joined first and the list's fragments re-joined
 * (JoinPagesStep and join steps, as blockType.ts does for block types; the undo splits them again).
 * The moved result then replaces the page's whole top-level block holding the item: one ReplaceStep,
 * whose undo maps through pagination's later joins and splits (the move's own ReplaceAroundSteps
 * don't: PG-2). Pagination lays the pages out again; joined pages that carried objects or markers
 * come back after the block. False (nothing dispatched) when the item can't move.
 */
export function moveListItem(direction: 'sink' | 'lift'): Command {
  return (state, dispatch) => {
    const itemType = state.schema.nodes.listItem;
    if (!itemType || state.selection.$from.depth < 3) return false;
    const move = direction === 'sink' ? sinkListItem(itemType) : liftListItem(itemType);
    const range = listJoinRange(state, direction);
    const tr = state.tr;
    const joined: PMNode[] = [];
    for (let k = range?.last ?? 0; range && k > range.first; k--) {
      const page = pageAt(tr.doc, k)!;
      if (tr.maybeStep(new JoinPagesStep(page.pos, 1)).failed) return false;
      joined.unshift(page.node);
      rejoinContinuations(tr, page.pos - 1);
    }
    let moved: Transaction | null = null;
    if (!move(EditorState.create({ doc: tr.doc, selection: tr.selection }), (t) => (moved = t))) return false;
    if (!dispatch) return true;
    const done = moved as unknown as Transaction;
    const $at = tr.doc.resolve(tr.selection.from);
    const start = $at.before(2);
    const end = $at.after(2);
    // The move stays inside that block: the document after the replacement is the moved one.
    const content = done.doc.slice(done.mapping.map(start, -1), done.mapping.map(end, 1)).content;
    tr.replaceWith(start, end, content);
    const { anchor, head } = done.selection;
    tr.setSelection(done.selection instanceof TextSelection ? TextSelection.create(tr.doc, anchor, head) : Selection.near(tr.doc.resolve(head)));
    restorePages(tr, start + content.size, joined);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export type AlignValue = ParagraphAlign | null;

/**
 * The alignment of the selected paragraphs: a value (null = the theme's default), 'mixed', or
 * undefined when no paragraph is selected (headings and code blocks have no align attribute).
 */
export function alignOf(state: EditorState): AlignValue | 'mixed' | undefined {
  let value: AlignValue | 'mixed' | undefined;
  for (const { node } of selectedTextblocks(state)) {
    if (node.type.name !== 'paragraph') continue;
    const align = (node.attrs.align as AlignValue) ?? null;
    if (value === undefined) value = align;
    else if (value !== align) return 'mixed';
  }
  return value;
}

/** Sets `align` on every selected paragraph (null resets to the theme's default). */
export function setAlign(align: AlignValue): Command {
  return (state, dispatch) => {
    const paragraphs = selectedTextblocks(state).filter(({ node }) => node.type.name === 'paragraph');
    if (paragraphs.length === 0) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const { node, pos } of paragraphs) if ((node.attrs.align ?? null) !== align) tr.setNodeAttribute(pos, 'align', align);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// block type changes (history-safe: commands/blockType.ts, pagination-UX lane)

/** The node type and attributes of a kind in `schema`. */
export function kindType(schema: Schema, kind: TextBlockKind): { type: NodeType; attrs: Attrs | null } | null {
  const level = kindLevel(kind);
  const type = schema.nodes[level !== null ? 'heading' : kind];
  return type ? { type, attrs: level !== null ? { level } : null } : null;
}

/**
 * Sets the selected text blocks to `kind` (TipTap command props, for chains). It uses
 * blockType.ts's setTextblockType: a paragraph split by pagination changes as a whole, the undo
 * survives pagination, and classes, style, attributes and align carry over where the new type has
 * them. No change (false) when the blocks already are `kind`. Blocks that can't take the kind
 * where they stand (definition list parts) are left alone; when that is all the selection holds
 * (a list item's paragraph can't become a heading), TipTap's setNode runs, which lifts the block
 * out of its wrapper first (not history-safe on a split list, as blockType.ts notes).
 *
 * (blockType.ts's own setNode also falls back to TipTap's when nothing needs changing, and that
 * one resets the block's attributes through clearNodes; so that case is a no-op here.)
 */
export function setTextBlockKind(kind: TextBlockKind): (props: CommandProps) => boolean {
  return (props) => {
    const target = kindType(props.state.schema, kind);
    if (!target) return false;
    const { chains, blocked } = blockTypeTargets(props.state, target.type, target.attrs);
    if (chains.length > 0) return setTextblockType(target.type, target.attrs)(props.state, props.dispatch);
    return blocked && coreCommands.setNode(target.type, target.attrs ?? {})(props);
  };
}

/** `kind`, or back to paragraphs when every selected text block already is `kind`. */
export function toggleTextBlockKind(kind: TextBlockKind): (props: CommandProps) => boolean {
  return (props) => {
    const target = kindType(props.state.schema, kind);
    if (!target) return false;
    const active = kind !== 'paragraph' && isTextblockActive(props.state, target.type, target.attrs ?? {});
    return setTextBlockKind(active ? 'paragraph' : kind)(props);
  };
}

// ---------------------------------------------------------------------------------------------
// text styles: the block kinds and definition lists (the "Text style" menu)

/**
 * Sets the selection's text style (TipTap command props, for chains): setTextBlockKind for the
 * text block kinds, toDefinitionList for 'definitionList'. From a definition list, another kind
 * turns the whole list into text blocks of that kind (fromDefinitionList). One transaction; false
 * (nothing changed) when the selection already has the style.
 */
export function setTextStyle(kind: TextStyleKind): (props: CommandProps) => boolean {
  return (props) => {
    const { state, dispatch } = props;
    if (kind === 'definitionList') return toDefinitionList(state, dispatch);
    if (!definitionListAt(state)) return setTextBlockKind(kind)(props);
    const target = kindType(state.schema, kind);
    if (!target) return false;
    return fromDefinitionList(target.type, target.attrs)(state, dispatch);
  };
}

/** The innermost definition list around the selection's start. */
function definitionListAt(state: EditorState): { pos: number; node: PMNode; depth: number } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 1; d--) {
    const node = $from.node(d);
    if (node.type.name === 'definitionList') return { pos: $from.before(d), node, depth: d };
  }
  return null;
}

/**
 * Runs `change` on a copy of the document in which the pages that the page-level blocks from the
 * selection's start to its end (on the start's page) span are joined, and those blocks' fragments
 * re-joined (JoinPagesStep and join steps, as moveListItem does): a paragraph or definition list
 * that pagination split is changed whole, and the undo, whose steps are all ReplaceSteps, maps
 * through pagination's later joins and splits (PG-2). `change` gets the selection's range in the
 * joined document and returns false to give up. Joined pages that carried objects or markers come
 * back after the change (restorePages).
 */
function changeJoinedBlocks(state: EditorState, change: (tr: Transaction, from: number, to: number) => boolean, dispatch?: (tr: Transaction) => void): boolean {
  const { $from } = state.selection;
  if ($from.depth < 2) return false;
  const to = Math.max($from.pos, Math.min(state.selection.to, $from.end(1)));
  const $to = state.doc.resolve(to);
  if ($to.depth < 2) return false;
  const doc = state.doc;
  const head = fragmentChain(doc, $from.before(2));
  const tail = fragmentChain(doc, $to.before(2));
  const first = pageIndexAt(doc, head[0]!);
  const last = pageIndexAt(doc, tail[tail.length - 1]!);
  // On a copy: nothing reaches the caller's transaction (a TipTap chain's, which is dispatched
  // whatever its commands answer) unless all of it works.
  const tr = EditorState.create({ doc, selection: state.selection }).tr;
  const joined: PMNode[] = [];
  for (let k = last; k > first; k--) {
    const page = pageAt(tr.doc, k)!;
    if (tr.maybeStep(new JoinPagesStep(page.pos, 1)).failed) return false;
    joined.unshift(page.node);
    rejoinContinuations(tr, page.pos - 1);
  }
  if (!change(tr, tr.mapping.map($from.pos), tr.mapping.map(to))) return false;
  restorePages(tr, tr.selection.to, joined);
  if (dispatch) {
    const out = state.tr;
    for (const step of tr.steps) out.step(step);
    out.setSelection(Selection.fromJSON(out.doc, tr.selection.toJSON()));
    dispatch(out.scrollIntoView());
  }
  return true;
}

const OBJECT_REPLACEMENT = String.fromCharCode(0xfffc);

/** `fragment` without white space at its start and end. */
function trimmed(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((n) => nodes.push(n));
  const edge = (i: number, pattern: RegExp) => {
    const n = nodes[i];
    if (!n?.isText) return;
    const text = n.text!.replace(pattern, '');
    if (text) nodes[i] = n.type.schema.text(text, n.marks);
    else nodes.splice(i, 1);
  };
  edge(0, /^\s+/);
  edge(nodes.length - 1, /\s+$/);
  return Fragment.from(nodes);
}

/** A text block's content as a term and a description: split at the first `::` (upstream's `Term :: Definition`). */
function termAndDescription(block: PMNode, schema: Schema): [Fragment, Fragment] {
  const content = convertedContent(block.content, schema.nodes.definitionTerm!, schema);
  // One character per inline leaf (icons, images, breaks), so text offsets are content offsets.
  const text = content.textBetween(0, content.size, undefined, OBJECT_REPLACEMENT);
  const split = text.indexOf('::');
  if (split < 0) return [content, Fragment.empty];
  return [trimmed(content.cut(0, split)), trimmed(content.cut(split + 2))];
}

/**
 * Turns the selected text blocks (siblings: paragraphs, headings, code blocks) into one definition
 * list, one term and description per block, split at `::` (without one the block becomes the term).
 * Definition lists among them are merged in. One transaction; the caret goes to the end of the
 * list's last item. False when the selection already is all definition list, or the blocks can't
 * become one (a list item's first paragraph).
 */
export const toDefinitionList: Command = (state, dispatch) => {
  const { definitionList, definitionTerm, definitionDesc } = state.schema.nodes;
  if (!definitionList || !definitionTerm || !definitionDesc) return false;
  if (blockKindOf(state) === 'definitionList') return false;
  const build = (tr: Transaction, from: number, to: number): boolean => {
    const $from = tr.doc.resolve(from);
    const range = $from.blockRange(tr.doc.resolve(to), (parent) => !parent.isTextblock && parent.type !== definitionList);
    if (!range) return false;
    const items: PMNode[] = [];
    for (let i = range.startIndex; i < range.endIndex; i++) {
      const child = range.parent.child(i);
      if (child.type === definitionList) child.forEach((item) => items.push(item));
      else if (child.isTextblock) {
        const [term, desc] = termAndDescription(child, state.schema);
        items.push(definitionTerm.create(null, term), definitionDesc.create(null, desc));
      } else return false;
    }
    const dl = definitionList.create(null, items);
    if (!range.parent.canReplaceWith(range.startIndex, range.endIndex, definitionList)) return false;
    tr.replaceWith(range.start, range.end, dl);
    tr.setSelection(TextSelection.create(tr.doc, range.start + dl.nodeSize - 2));
    return true;
  };
  return changeJoinedBlocks(state, build, dispatch);
};

/**
 * Turns the definition list at the selection's start into text blocks of `type`: one per term,
 * holding "Term :: Description" (the inverse of toDefinitionList), and one per description that
 * has no term. One transaction; the caret keeps its place in the text.
 */
export function fromDefinitionList(type: NodeType, attrs: Attrs | null = null): Command {
  return (state, dispatch) => {
    if (!definitionListAt(state) || !type.isTextblock) return false;
    const schema = state.schema;
    const build = (tr: Transaction, from: number): boolean => {
      const $from = tr.doc.resolve(from);
      let depth = -1;
      for (let d = $from.depth; d > 1 && depth < 0; d--) if ($from.node(d).type.name === 'definitionList') depth = d;
      if (depth < 0) return false;
      const dl = $from.node(depth);
      const dlPos = $from.before(depth);
      const itemIndex = $from.index(depth);
      // Blocks as lists of parts; where each item starts in its block.
      const blocks: Fragment[][] = [];
      let caretBlock = 0;
      let caretOffset = 0;
      dl.forEach((item, _, i) => {
        const startsBlock = item.type.name === 'definitionTerm' || blocks.length === 0;
        if (startsBlock) blocks.push([]);
        const parts = blocks[blocks.length - 1]!;
        if (!startsBlock && item.content.size > 0 && parts.some((f) => f.size > 0)) parts.push(Fragment.from(schema.text(' :: ')));
        if (i === itemIndex) {
          caretBlock = blocks.length - 1;
          caretOffset = parts.reduce((size, f) => size + f.size, 0) + $from.parentOffset;
        }
        parts.push(item.content);
      });
      const nodes = blocks.map((parts) => {
        const content = parts.reduce((all, f) => all.append(f), Fragment.empty);
        return type.create(attrs, convertedContent(content, type, schema));
      });
      const parent = $from.node(depth - 1);
      const index = $from.index(depth - 1);
      if (!parent.canReplace(index, index + 1, Fragment.from(nodes))) return false;
      tr.replaceWith(dlPos, dlPos + dl.nodeSize, nodes);
      let caret = dlPos;
      for (let k = 0; k < caretBlock; k++) caret += nodes[k]!.nodeSize;
      caret += 1 + Math.min(caretOffset, nodes[caretBlock]!.content.size);
      tr.setSelection(TextSelection.create(tr.doc, caret));
      return true;
    };
    return changeJoinedBlocks(state, build, dispatch);
  };
}

// ---------------------------------------------------------------------------------------------
// splitting helpers

/** Attributes for the part after a split: never a continuation, and the id stays on the first part. */
function afterAttrs(node: PMNode): Attrs {
  const attrs: Record<string, unknown> = { ...node.attrs };
  if ('continuation' in attrs) attrs.continuation = false;
  if ('id' in attrs) attrs.id = null;
  if ('customId' in attrs) attrs.customId = false;
  return attrs;
}

/** Whether the node at `level` has the cursor's text block as its first (last) descendant. */
function isEdgeDescendant($pos: ResolvedPos, level: number, side: 'first' | 'last'): boolean {
  for (let d = level; d < $pos.depth; d++) {
    const index = $pos.index(d);
    if (side === 'first' ? index !== 0 : index !== $pos.node(d).childCount - 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// column break (\column)

/**
 * Shift-Mod-Enter: inserts a column break at the cursor (replacing the selection). In the middle
 * of a text block the block is split around it; at a block's start it goes before the block, at
 * its end after it. It goes into the innermost container that may hold it (a list item's
 * paragraph splits the item's content, not the list). The cursor ends up after the break; an
 * empty paragraph follows it when nothing else can take the cursor.
 */
export const insertColumnBreak: Command = (state, dispatch) => {
  const type = state.schema.nodes.columnBreak;
  if (!type) return false;
  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  const done = insertBlockAtCursor(tr, type.create());
  if (!done) return false;
  dispatch?.(tr.scrollIntoView());
  return true;
};

/** Inserts `node` at the selection as described for insertColumnBreak. */
function insertBlockAtCursor(tr: Transaction, node: PMNode): boolean {
  const $pos = tr.selection.$from;
  if (!$pos.parent.isTextblock) {
    const index = $pos.index();
    if (!$pos.parent.canReplaceWith(index, index, node.type)) return false;
    tr.insert($pos.pos, node);
    placeCursorAfter(tr, $pos.pos + node.nodeSize);
    return true;
  }
  const depth = $pos.depth;
  const atStart = $pos.parentOffset === 0;
  const atEnd = $pos.parentOffset === $pos.parent.content.size;
  for (let d = depth - 1; d >= 1; d--) {
    const container = $pos.node(d);
    const index = $pos.index(d);
    const child = container.child(index);
    const mode = atStart && isEdgeDescendant($pos, d + 1, 'first') ? 'before' : atEnd && isEdgeDescendant($pos, d + 1, 'last') ? 'after' : 'split';
    const children: PMNode[] = [];
    container.forEach((c) => children.push(c));
    const middle = mode === 'before' ? [node, child] : mode === 'after' ? [child, node] : [child, node, child];
    const sequence = [...children.slice(0, index), ...middle, ...children.slice(index + 1)];
    if (!container.type.validContent(Fragment.fromArray(sequence))) continue;
    const levels = depth - d;
    if (mode === 'before') {
      tr.insert($pos.before(d + 1), node);
      return true; // the cursor maps past the inserted node, to the start of its text block
    }
    if (mode === 'after') {
      const at = $pos.after(d + 1);
      tr.insert(at, node);
      placeCursorAfter(tr, at + node.nodeSize);
      return true;
    }
    const typesAfter = Array.from({ length: levels }, (_, i) => {
      const n = $pos.node(d + 1 + i);
      return { type: n.type, attrs: afterAttrs(n) };
    });
    if (!canSplit(tr.doc, $pos.pos, levels, typesAfter)) continue;
    tr.split($pos.pos, levels, typesAfter);
    const between = $pos.pos + levels;
    tr.insert(between, node);
    tr.setSelection(Selection.near(tr.doc.resolve(between + node.nodeSize + levels), 1));
    return true;
  }
  return false;
}

/**
 * Puts the cursor in the first text after `pos`. At the end of its container, an empty paragraph
 * is added there for it.
 */
function placeCursorAfter(tr: Transaction, pos: number): void {
  const $pos = tr.doc.resolve(pos);
  if (!$pos.nodeAfter) {
    const paragraph = tr.doc.type.schema.nodes.paragraph;
    const index = $pos.index();
    if (paragraph && $pos.parent.canReplaceWith(index, index, paragraph)) {
      tr.insert(pos, paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      return;
    }
  }
  tr.setSelection(Selection.findFrom($pos, 1, true) ?? Selection.near($pos, 1));
}

// ---------------------------------------------------------------------------------------------
// theme blocks ({{class … }} upstream)

export interface ThemeBlockHit {
  pos: number;
  node: PMNode;
  depth: number;
}

/** The innermost theme block around the selection's start. */
export function themeBlockAt(state: EditorState): ThemeBlockHit | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 1; d--) {
    const node = $from.node(d);
    if (node.type.name === 'themeBlock') return { pos: $from.before(d), node, depth: d };
  }
  return null;
}

/**
 * Shift-Mod-M: wraps the selected blocks in a theme block with `classes` (nested theme blocks are
 * fine). Where a block can't be wrapped where it is (a list item's first paragraph), the wrap
 * moves outward (the whole list). A selection that crosses pages wraps the part on its first page.
 * A paragraph split across pages is wrapped whole (blockType.ts withChainsJoined, PGR-3).
 */
export function wrapInThemeBlock(classes: readonly string[]): Command {
  return withChainsJoined((state, dispatch) => {
    const type = state.schema.nodes.themeBlock;
    if (!type) return false;
    const attrs = { classes: cleanClassList(classes) };
    const { $from } = state.selection;
    if ($from.depth < 1) return false;
    const $to = state.doc.resolve(Math.min(state.selection.$to.pos, $from.end(1)));
    let range: NodeRange | null = $from.blockRange($to);
    while (range) {
      const wrapping = findWrapping(range, type, attrs);
      if (wrapping) {
        dispatch?.(state.tr.wrap(range, wrapping).scrollIntoView());
        return true;
      }
      range = range.depth > 1 ? new NodeRange($from, $to, range.depth - 1) : null;
    }
    return false;
  });
}

/** The innermost theme block around the selection's start whose classes pass `test`. */
function themeBlockWhere(state: EditorState, test: (classes: readonly string[]) => boolean): ThemeBlockHit | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 1; d--) {
    const node = $from.node(d);
    if (node.type.name === 'themeBlock' && test(classesOf(node))) return { pos: $from.before(d), node, depth: d };
  }
  return null;
}

/** Lifts the content of the theme block `find` finds out of it. */
function unwrapFound(find: (state: EditorState) => ThemeBlockHit | null): Command {
  return (state, dispatch) => {
    const hit = find(state);
    if (!hit) return false;
    const $start = state.doc.resolve(hit.pos + 1);
    const $end = state.doc.resolve(hit.pos + hit.node.nodeSize - 1);
    const range = new NodeRange($start, $end, hit.depth);
    const target = liftTarget(range);
    if (target === null) return false;
    dispatch?.(state.tr.lift(range, target).scrollIntoView());
    return true;
  };
}

/** Lifts the content of the innermost theme block around the selection out of it. */
export const unwrapThemeBlock: Command = unwrapFound(themeBlockAt);

/**
 * A theme box of the "Text style" menu (THEME_BOX_CLASSES): in a box with class `cls`, the box is
 * removed (its content stays); in another theme box, that box's class changes to `cls` (its other
 * classes, e.g. wide, stay); elsewhere the selected blocks are wrapped in a new box
 * (wrapInThemeBlock). One transaction; the removal is recorded as a whole-block replacement whose
 * undo survives pagination (withChainsJoined), the class change as an AttrStep.
 */
export function toggleThemeBox(cls: ThemeBoxClass): Command {
  const boxes: readonly string[] = THEME_BOX_CLASSES;
  return (state, dispatch) => {
    if (themeBlockWhere(state, (classes) => classes.includes(cls))) {
      return withChainsJoined(unwrapFound((s) => themeBlockWhere(s, (classes) => classes.includes(cls))))(state, dispatch);
    }
    const other = themeBlockWhere(state, (classes) => classes.some((c) => boxes.includes(c)));
    if (other) {
      if (dispatch) {
        const classes = classesOf(other.node);
        const at = classes.findIndex((c) => boxes.includes(c));
        const next = cleanClassList([...classes.slice(0, at), cls, ...classes.slice(at + 1).filter((c) => !boxes.includes(c))]);
        dispatch(state.tr.setNodeAttribute(other.pos, 'classes', next).scrollIntoView());
      }
      return true;
    }
    return wrapInThemeBlock([cls])(state, dispatch);
  };
}
