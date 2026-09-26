// Page boundaries (plan §4.5). The only two ways pagination changes the document:
//
//   split  a page at a cut position (a new auto page starts there)          insertAutoPageAt
//   join   two pages, then split them again at a new position                moveBoundary
//
// Both are ProseMirror join/split (ReplaceStep with structure) steps, so every position maps
// continuously: the caret stays in the text being moved, and prosemirror-history rebases the
// user's undo steps through them. Never "move" content with delete + insert: history would see
// the moved text as deleted and drop the user's undo steps for it (boundary.test.ts shows both).
//
// Everything here is pure ProseMirror (no DOM), so it runs in Vitest and on a Transform.
import { Fragment, Slice, type Attrs, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import { ReplaceStep, canJoin, type Mapping, type Transform } from '@tiptap/pm/transform';
import { SECTION_ATTRS, type PageAttrs } from '../schema/nodes/page';

/** A page of the document and where it sits. */
export interface PageRef {
  node: PMNode;
  /** 0-based index among the doc's pages */
  index: number;
  /** position before the page */
  pos: number;
  /** first position inside the page (before its first block) */
  contentStart: number;
  /** last position inside the page (after its last block) */
  contentEnd: number;
}

/** The page at `index`, or null when there is none. */
export function pageAt(doc: PMNode, index: number): PageRef | null {
  if (!Number.isInteger(index) || index < 0 || index >= doc.childCount) return null;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  const node = doc.child(index);
  return { node, index, pos, contentStart: pos + 1, contentEnd: pos + node.nodeSize - 1 };
}

/** Index of the page that contains `pos` (a position between pages counts for the next one). */
export function pageIndexAt(doc: PMNode, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  return Math.min(doc.resolve(clamped).index(0), doc.childCount - 1);
}

/** Position right after the first block of page `p` (pulling it back ends the previous page there). */
export const endOfFirstBlock = (p: PageRef): number => p.contentStart + (p.node.firstChild?.nodeSize ?? 0);

/** Whether a page is an auto page (created by pagination; content may flow into it). */
export const isAutoPage = (page: PMNode): boolean => page.attrs.kind === 'auto';

/**
 * Index of the first page of the section page `index` belongs to: the nearest manual page at or
 * before it (page 0 when there is none: the document's first page always starts a section).
 */
export function sectionStartIndex(doc: PMNode, index: number): number {
  let i = Math.max(0, Math.min(Math.floor(index), doc.childCount - 1));
  while (i > 0 && isAutoPage(doc.child(i))) i--;
  return i;
}

/** Index of the last page of the section page `index` belongs to (the page before the next manual one). */
export function sectionEndIndex(doc: PMNode, index: number): number {
  let i = Math.max(0, Math.min(Math.floor(index), doc.childCount - 1));
  while (i + 1 < doc.childCount && isAutoPage(doc.child(i + 1))) i++;
  return i;
}

/**
 * Whether a page carries data of its own that must not vanish with its flow: page objects (plan
 * §4.9) or page markers (a cover, skip or restart page numbering). Such a page is never deleted by
 * a pull, and the commands that join pages bring it back.
 */
export function carriesPageData(page: PMNode): boolean {
  const objects = page.attrs.objects as unknown;
  const markers = page.attrs.markers as unknown;
  return (Array.isArray(objects) && objects.length > 0) || (Array.isArray(markers) && markers.length > 0);
}

/**
 * A page kept alive only for its page objects or markers (carriesPageData): its flow is one empty
 * paragraph (plan §4.9: a page that carries objects is never deleted by a pull).
 */
export function isPlaceholderPage(page: PMNode): boolean {
  const first = page.firstChild;
  return carriesPageData(page) && page.childCount === 1 && first !== null && first.type.name === 'paragraph' && first.content.size === 0;
}

/**
 * Where the token that starts at `pos` (e.g. a node's opening token) is after `mapping` (a slice
 * of one included), or null when a step deleted it. (MapResult.deletedAfter also reports a mere
 * insertion right at `pos`.)
 */
export function mapToken(mapping: Mapping, pos: number): number | null {
  let at = pos;
  // Mapping.maps is the whole array, also for a slice: only from…to count.
  for (let i = mapping.from; i < mapping.to; i++) {
    const map = mapping.maps[i]!;
    let deleted = false;
    map.forEach((oldStart, oldEnd) => {
      if (oldStart <= at && at + 1 <= oldEnd) deleted = true;
    });
    if (deleted) return null;
    at = map.map(at, 1);
  }
  return at;
}

/** Only the attributes `type` declares (ProseMirror's checkAttrs rejects unknown ones). */
function pickAttrs(type: NodeType, attrs: Attrs): Attrs {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(type.spec.attrs ?? {})) if (name in attrs) out[name] = attrs[name];
  return out;
}

/**
 * Attributes of a new auto page that follows `src` (a page of the same section): the section
 * settings (SECTION_ATTRS) are copied; markers, objects and ids belong to one page and are not.
 * pid is left null: the pageIds plugin assigns one (outside the undo history).
 */
export function autoPageAttrs(src: Attrs): Partial<PageAttrs> {
  const inherited: Record<string, unknown> = {};
  for (const key of SECTION_ATTRS) {
    const value = src[key] as unknown;
    inherited[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  return {
    ...(inherited as Partial<PageAttrs>),
    kind: 'auto',
    pid: null,
    id: null,
    attributes: {},
    markers: [],
    objects: [],
    oversized: false,
  };
}

/**
 * Attributes for the second fragment of `node`, split before its child `splitIndex` (or inside
 * it). The fragment is marked `continuation`; ids stay on the first fragment. An ordered list
 * continues its numbering: the fragment starts at the number of its first item, which is the
 * item at `splitIndex` (when the split falls inside that item, its continuation keeps the same
 * number; canvas CSS hides the marker of a continued item).
 */
export function continuationAttrs(node: PMNode, splitIndex: number): Attrs {
  const attrs: Record<string, unknown> = { ...node.attrs, continuation: true, id: null };
  if (node.type.name === 'orderedList') {
    const start = typeof node.attrs.start === 'number' ? node.attrs.start : 1;
    attrs.start = start + splitIndex;
  }
  return pickAttrs(node.type, attrs);
}

/**
 * Lifts a cut that sits at the start or end of a node's content to the boundary of that node,
 * so a split never leaves an empty fragment behind (e.g. the start of a paragraph becomes the
 * position before the paragraph). Stops at page level (depth 1).
 */
export function normalizeCut(doc: PMNode, cut: number): number {
  let pos = cut;
  let $pos = doc.resolve(pos);
  while ($pos.depth > 1) {
    if ($pos.parentOffset === 0) pos = $pos.before();
    else if ($pos.parentOffset === $pos.parent.content.size) pos = $pos.after();
    else break;
    $pos = doc.resolve(pos);
  }
  return pos;
}

/**
 * Splits every level from the cut up to the page: the page (the new page gets `pageAttrs`)
 * and, for a cut inside a block, each enclosing block (the new fragments get continuationAttrs).
 * The cut must fall strictly inside the page's flow (both sides keep at least one block).
 */
export function splitToPage(tr: Transform, cut: number, pageAttrs: Attrs): void {
  const pos = normalizeCut(tr.doc, cut);
  const $cut = tr.doc.resolve(pos);
  if ($cut.depth < 1) throw new RangeError(`pagination: cut ${cut} is not inside a page`);
  if (pos <= $cut.start(1) || pos >= $cut.end(1)) {
    throw new RangeError(`pagination: cut ${cut} would leave an empty page (page content ${$cut.start(1)}–${$cut.end(1)})`);
  }
  const page = $cut.node(1);
  const typesAfter: { type: NodeType; attrs: Attrs }[] = [{ type: page.type, attrs: pickAttrs(page.type, pageAttrs) }];
  for (let d = 2; d <= $cut.depth; d++) {
    const node = $cut.node(d);
    typesAfter.push({ type: node.type, attrs: continuationAttrs(node, $cut.index(d)) });
  }
  const stepsBefore = tr.steps.length;
  splitFilled(tr, pos, $cut.depth, typesAfter);
  // A cut between two nodes leaves the node after it whole: it can't be a continuation. A flag
  // it still carries is stale (user edits moved it away from its head); left in place, the
  // next re-join would merge it into whatever block ends up before it.
  const start = tr.mapping.slice(stepsBefore).map(pos, 1);
  const after = tr.doc.resolve(start).nodeAfter;
  if (after && !after.isText && after.attrs.continuation === true) tr.setNodeAttribute(start, 'continuation', false);
}

/**
 * Transform.split, except that a new fragment whose content must start with a node it doesn't
 * have gets that node: a list item split before its nested list continues as
 * `li(continuation) › [p(continuation, empty), ul(continuation) …]`, because listItem content
 * is `paragraph block*`. Such fillers are empty continuation textblocks; rejoinContinuations
 * removes them again. Same step shape as Transform.split (one ReplaceStep with structure).
 */
function splitFilled(tr: Transform, pos: number, depth: number, typesAfter: { type: NodeType; attrs: Attrs }[]): void {
  const $pos = tr.doc.resolve(pos);
  let before = Fragment.empty;
  let after = Fragment.empty;
  for (let d = $pos.depth, e = $pos.depth - depth, i = depth - 1; d > e; d--, i--) {
    before = Fragment.from($pos.node(d).copy(before));
    const { type, attrs } = typesAfter[i]!;
    // The rest of this node's children follow `after` once the step closes the slice, so only
    // the start of the content has to match.
    const fill = after.size ? type.contentMatch.fillBefore(after) : Fragment.empty;
    let content = after;
    if (fill && fill.childCount) {
      const fillers: PMNode[] = [];
      fill.forEach((n) => fillers.push(n.isTextblock && 'continuation' in (n.type.spec.attrs ?? {}) ? n.type.create({ ...n.attrs, continuation: true }) : n));
      content = Fragment.fromArray(fillers).append(after);
    }
    after = Fragment.from(type.create(attrs, content));
  }
  tr.step(new ReplaceStep(pos, pos, new Slice(before.append(after), depth, depth), true));
}

/** New auto page after page `i`, starting at `cut` (a position inside page i). */
export function insertAutoPageAt(tr: Transform, i: number, cut: number): void {
  const src = pageAt(tr.doc, i);
  if (!src) throw new RangeError(`pagination: no page ${i}`);
  if (cut <= src.contentStart || cut >= src.contentEnd) {
    throw new RangeError(`pagination: cut ${cut} is not inside page ${i} (${src.contentStart}–${src.contentEnd})`);
  }
  splitToPage(tr, cut, autoPageAttrs(src.node.attrs));
}

/**
 * Joins the fragments that pagination split, at `seam` (a position between two sibling nodes):
 * while the node after the seam is a `continuation` of the same type as the node before it,
 * they become one node again, level by level (list → item → paragraph). The head keeps its
 * attributes (ids, list start). Returns the number of joins.
 */
export function rejoinContinuations(tr: Transform, seam: number): number {
  let joins = 0;
  let pos = seam;
  for (;;) {
    const $pos = tr.doc.resolve(pos);
    const before = $pos.nodeBefore;
    const after = $pos.nodeAfter;
    if (!before || !after || before.isText || after.isText) break;
    if (after.attrs.continuation !== true) break;
    if (after.isTextblock && after.content.size === 0 && before.type !== after.type) {
      // A filler splitFilled added (e.g. the paragraph a continued list item had to start
      // with): drop it and look at the seam again.
      tr.delete(pos, pos + after.nodeSize);
      continue;
    }
    if (before.type !== after.type || !canJoin(tr.doc, pos)) break;
    tr.join(pos);
    joins++;
    pos -= 1; // the seam between the joined nodes' children
  }
  return joins;
}

/**
 * Renumbers the ordered lists continuing across the seam between page `i` and page i+1 (level
 * by level, as rejoinContinuations walks it): each continues at the number after its head's
 * items (the same number when the head's last item continues too). Returns whether any start
 * changed.
 */
export function renumberContinuations(tr: Transform, i: number): boolean {
  const a = pageAt(tr.doc, i);
  const b = pageAt(tr.doc, i + 1);
  if (!a || !b) return false;
  let changed = false;
  let before = a.node.lastChild;
  let after = b.node.firstChild;
  let pos = b.contentStart;
  while (before && after && !after.isText && after.attrs.continuation === true && before.type === after.type) {
    if (after.type.name === 'orderedList') {
      const start = typeof before.attrs.start === 'number' ? before.attrs.start : 1;
      const expected = start + before.childCount - (after.firstChild?.attrs.continuation === true ? 1 : 0);
      if (after.attrs.start !== expected) {
        tr.setNodeAttribute(pos, 'start', expected);
        changed = true;
      }
    }
    before = before.lastChild;
    after = after.firstChild;
    pos += 1;
  }
  return changed;
}

/** What moveBoundary did with the second page. */
export type MoveResult =
  /** page i ends at the cut; page i+1 (same pid and objects) starts there */
  | 'split'
  /** page i+1's whole flow now fits on page i: page i+1 is gone */
  | 'merged'
  /** as 'merged', but page i+1 carries page objects or markers, so it stays with one empty paragraph */
  | 'kept';

/**
 * Makes page `i` end at `cut` by joining page i+1 into it and splitting again. `cut` is a
 * position in the current document, inside page i (push: content moves forward) or inside page
 * i+1 (pull: content moves back); page i+1 keeps its attributes (pid, objects, section).
 *
 *   before  page i [ A B C(1-9) ]      page i+1 [ C′(7-9) D E ]
 *   join    page i [ A B C(1-9) D E ]                   (continuation C′ re-joined with C)
 *   split   page i [ A B C(1-6) ]      page i+1 [ C′(4-9) D E ]
 */
export function moveBoundary(tr: Transform, i: number, cut: number): MoveResult {
  const a = pageAt(tr.doc, i);
  const b = pageAt(tr.doc, i + 1);
  if (!a || !b) throw new RangeError(`pagination: moveBoundary needs pages ${i} and ${i + 1}`);
  if (cut <= a.contentStart || cut > b.contentEnd || (cut > a.contentEnd && cut < b.contentStart)) {
    throw new RangeError(`pagination: cut ${cut} is outside pages ${i}–${i + 1} (${a.contentStart}–${b.contentEnd})`);
  }
  const keep = b.node.attrs;
  const pull = cut >= b.contentStart;
  // A page kept alive only for its objects has nothing to give back.
  if (pull && isPlaceholderPage(b.node)) return 'kept';
  const stepsBefore = tr.steps.length;

  const boundary = b.pos;
  tr.join(boundary); // </page><page> removed: page i now holds both flows
  let seam = boundary - 1; // between page i's last block and page i+1's first block
  // A placeholder page's empty paragraph goes as soon as real content arrives on it.
  if (!pull && isPlaceholderPage(b.node)) tr.delete(seam, seam + 2);
  if (isPlaceholderPage(a.node)) {
    tr.delete(a.contentStart, a.contentStart + 2);
    seam -= 2;
  }
  rejoinContinuations(tr, seam);

  const joined = pageAt(tr.doc, i)!;
  const mapped = tr.mapping.slice(stepsBefore).map(cut);
  if (mapped >= joined.contentEnd) {
    if (!carriesPageData(b.node)) return 'merged';
    // Everything fits on page i, but page i+1 carries page objects or markers: keep it, with one
    // empty paragraph (inserted, then split off, so the page keeps its pid and attributes).
    const schema = tr.doc.type.schema;
    tr.insert(joined.contentEnd, schema.nodes.paragraph!.create());
    tr.split(joined.contentEnd, 1, [{ type: joined.node.type, attrs: pickAttrs(joined.node.type, keep) }]);
    return 'kept';
  }
  splitToPage(tr, mapped, keep);
  return 'split';
}
