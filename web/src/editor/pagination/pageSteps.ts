// Page-structure steps whose undo and redo survive pagination.
//
// prosemirror-history rebases its undo steps through pagination's non-history steps (join +
// split). Steps anchored on a page boundary don't survive that: an attribute step on a page is
// dropped once pagination joins the page into the one before it (its opening token is deleted),
// and the inverse of a plain page join (insert `</page><page>`) fails when pagination has put a
// page boundary right there by then (it would leave an empty page). Section commands (a page
// break, removing one, joining pages from the keyboard) would lose their undo or redo.
//
//   PageBreakStep(pos, attrs)   make a page with `attrs` start at `pos`:
//                               - `pos` at a page boundary (between pages, at the start of a
//                                 page's flow, at the end of a page's flow before another page):
//                                 the page that starts there gets `attrs` (its content stays);
//                               - `pos` inside a page's flow: the page is split there, through
//                                 every level (a paragraph becomes two; second parts are not
//                                 continuations, an ordered list keeps counting).
//                               Its inverse is a JoinPagesStep (split) or a PageBreakStep with the
//                               page's old attributes (boundary).
//   JoinPagesStep(pos, depth, pid?)
//                               join the page before `pos` (a page boundary) with the page after
//                               it, and `depth - 1` levels of blocks at the seam. Its inverse is
//                               a PageBreakStep with the second page's attributes: the page comes
//                               back wherever its first content is by then.
//                               With `pid` (the inverse of a PageBreakStep that made a page with
//                               that pid), a page join whose `pos` is no page boundary any more
//                               (pagination moved that boundary: join + split elsewhere) joins the
//                               page with that pid instead, when it is the page `pos` is in or the
//                               one after it. So undoing a restored page (commands that join pages
//                               and bring back a page that carries objects or markers) removes
//                               exactly that page, wherever pagination put its boundary.
//
// Both map positions like the plain steps they stand for, so the caret and the history's other
// steps map through them as usual.
import { Fragment, Slice, type Attrs, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model';
import { ReplaceStep, Step, StepMap, StepResult, Transform, type Mappable } from '@tiptap/pm/transform';
import { isAutoPage, isPlaceholderPage, mapToken, normalizeCut, rejoinContinuations } from './boundary';

/**
 * Attributes of the second part of `node` split before its child `index`: not a continuation,
 * no id (ids stay on the first part), and an ordered list keeps counting.
 */
export function secondPartAttrs(node: PMNode, index: number): Attrs {
  const attrs: Record<string, unknown> = { ...node.attrs };
  if ('continuation' in attrs) attrs.continuation = false;
  if ('id' in attrs) attrs.id = null;
  if ('customId' in attrs) attrs.customId = false;
  if (node.type.name === 'orderedList') attrs.start = (typeof node.attrs.start === 'number' ? node.attrs.start : 1) + index;
  return attrs;
}

/** Index of the page that starts at `pos` (a page boundary as described above), or null. */
function pageStartingAt(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(pos);
  if ($pos.depth === 0) return $pos.index(0) < doc.childCount && $pos.index(0) > 0 ? $pos.index(0) : null;
  if ($pos.depth !== 1) return null;
  const index = $pos.index(0);
  if (pos === $pos.start(1)) return index > 0 ? index : null;
  if (pos === $pos.end(1)) return index + 1 < doc.childCount ? index + 1 : null;
  return null;
}

function pagePos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/** Only the attributes `type` declares. */
function declared(type: NodeType, attrs: Attrs): Attrs {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(type.spec.attrs ?? {})) if (name in attrs) out[name] = attrs[name];
  return out;
}

export class PageBreakStep extends Step {
  readonly pos: number;
  readonly attrs: Attrs;
  // Filled by apply (getMap and invert need them; Transform calls them right after apply).
  private mode: 'split' | 'attrs' = 'split';
  private at = 0;
  private depth = 1;
  private target = 0;
  private oldAttrs: Attrs | null = null;
  /** split mode: the tokens a fold removed, in the coordinates before the step (see apply) */
  private fold: { from: number; size: number } | null = null;

  constructor(pos: number, attrs: Attrs) {
    super();
    this.pos = pos;
    this.attrs = attrs;
    this.at = pos;
  }

  apply(doc: PMNode): StepResult {
    const size = doc.content.size;
    const cut = normalizeCut(doc, Math.max(0, Math.min(this.pos, size)));
    const start = pageStartingAt(doc, cut);
    const pageType = doc.type.schema.nodes.page!;
    if (start !== null) {
      // A boundary is there already: that page takes the attributes (like an AttrStep).
      const pos = pagePos(doc, start);
      const page = doc.child(start);
      this.mode = 'attrs';
      this.target = pos;
      this.oldAttrs = page.attrs;
      const updated = pageType.create(declared(pageType, { ...page.attrs, ...this.attrs }), null, page.marks);
      return StepResult.fromReplace(doc, pos, pos + 1, new Slice(Fragment.from(updated), 0, 1));
    }
    const $cut = doc.resolve(cut);
    if ($cut.depth < 1 || cut <= $cut.start(1) || cut >= $cut.end(1)) return StepResult.fail('PageBreakStep: no place for a page boundary');
    const typesAfter: { type: NodeType; attrs: Attrs }[] = [{ type: pageType, attrs: declared(pageType, this.attrs) }];
    for (let d = 2; d <= $cut.depth; d++) typesAfter.push({ type: $cut.node(d).type, attrs: secondPartAttrs($cut.node(d), $cut.index(d)) });
    const split = (): Transform => {
      const tr = new Transform(doc);
      tr.split(cut, $cut.depth, typesAfter);
      return tr;
    };
    let tr: Transform;
    try {
      tr = split();
    } catch (error) {
      return StepResult.fail(`PageBreakStep: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.mode = 'split';
    this.at = cut;
    this.depth = $cut.depth;
    this.fold = this.foldDisplaced(doc, tr, $cut.index(0));
    if (this.fold === null && tr.steps.length > 1) tr = split();
    return StepResult.ok(tr.doc);
  }

  /**
   * The page this step makes may still exist right after the split, as the auto page with the same
   * pid: an undo re-creating a page start (of a section, of a page with objects or markers) after
   * pagination moved that page's boundary (join + split elsewhere). That page folds into the new
   * one: joined, with its fragments re-joined (or its placeholder paragraph dropped), so the page
   * starts at `pos` again instead of existing twice. Adds the steps to `tr` (after the split) and
   * returns the tokens removed, in the coordinates before this step; null when there is nothing
   * to fold.
   */
  private foldDisplaced(doc: PMNode, tr: Transform, index: number): { from: number; size: number } | null {
    const pid = this.attrs.pid as unknown;
    const next = index + 1 < doc.childCount ? doc.child(index + 1) : null;
    if (typeof pid !== 'string' || pid === '' || !next || next.attrs.pid !== pid || !isAutoPage(next)) return null;
    const shift = 2 * this.depth; // the split's tokens, all before the displaced page
    const boundary = pagePos(doc, index + 1) + shift; // before the displaced page, after the split
    const stepsBefore = tr.steps.length;
    tr.join(boundary);
    if (isPlaceholderPage(next)) tr.delete(boundary - 1, boundary + 1);
    else rejoinContinuations(tr, boundary - 1);
    // The removed tokens form one range around the boundary (each join and filler is at the seam).
    const fold = tr.mapping.slice(stepsBefore);
    let from = boundary;
    while (from > 0 && mapToken(fold, from - 1) === null) from--;
    let to = boundary;
    while (to < doc.content.size + shift && mapToken(fold, to) === null) to++;
    return from - shift > this.at ? { from: from - shift, size: to - from } : null;
  }

  override getMap(): StepMap {
    if (this.mode !== 'split') return StepMap.empty;
    return new StepMap(this.fold ? [this.at, 0, 2 * this.depth, this.fold.from, this.fold.size, 0] : [this.at, 0, 2 * this.depth]);
  }

  invert(doc: PMNode): Step {
    if (this.mode === 'attrs') {
      // The page gets its old attributes back (a boundary step too, so a redo after pagination
      // moved things still finds its place).
      return new PageBreakStep(this.target + 1, this.oldAttrs ?? doc.nodeAt(this.target)?.attrs ?? {});
    }
    if (this.fold) {
      // Split and folded: the old content between the cut and the end of what the fold removed
      // comes back as it was (the displaced page, its fragments' seam).
      const end = this.fold.from + this.fold.size;
      return new ReplaceStep(this.at, this.fold.from + 2 * this.depth, doc.slice(this.at, end));
    }
    // The new page's pid lets the join find the page again after pagination moved its boundary.
    const pid = typeof this.attrs.pid === 'string' && this.attrs.pid !== '' ? this.attrs.pid : null;
    return new JoinPagesStep(this.at + this.depth, this.depth, pid);
  }

  map(mapping: Mappable): Step {
    return new PageBreakStep(mapping.map(this.pos, 1), this.attrs);
  }

  toJSON(): { stepType: string; pos: number; attrs: Attrs } {
    return { stepType: 'hbPageBreak', pos: this.pos, attrs: this.attrs };
  }

  static override fromJSON(_schema: Schema, json: { pos: number; attrs: Attrs }): PageBreakStep {
    if (typeof json.pos !== 'number') throw new RangeError('Invalid input for PageBreakStep.fromJSON');
    return new PageBreakStep(json.pos, json.attrs ?? {});
  }
}

/** Why the page boundary at `pos` can't be joined `depth` levels deep, or null when it can. */
function joinProblem(doc: PMNode, pos: number, depth: number): string | null {
  if (pos - depth < 0 || pos + depth > doc.content.size) return 'out of range';
  const $pos = doc.resolve(pos);
  if ($pos.depth !== 0 || !$pos.nodeBefore || !$pos.nodeAfter) return 'not a page boundary';
  // The seam must be closing / opening tokens only, `depth` levels on each side: the range is
  // at the very end of the last blocks before it and the very start of the first blocks after.
  const $from = doc.resolve(pos - depth);
  const $to = doc.resolve(pos + depth);
  if ($from.depth !== depth || $to.depth !== depth) return 'the seam has content';
  if ($from.parentOffset !== $from.parent.content.size || $to.parentOffset !== 0) return 'the seam has content';
  for (let d = 1; d < depth; d++) {
    if ($from.index(d) !== $from.node(d).childCount - 1 || $to.index(d) !== 0) return 'the seam has content';
  }
  return null;
}

/**
 * The boundary before the page with `pid`, when that page is the one `pos` is in or the one after
 * it (and not the first page); null otherwise.
 */
function boundaryOfPage(doc: PMNode, pos: number, pid: string): number | null {
  const index = doc.resolve(Math.max(0, Math.min(pos, doc.content.size))).index(0);
  for (const k of [index, index + 1]) {
    if (k > 0 && k < doc.childCount && doc.child(k).attrs.pid === pid) return pagePos(doc, k);
  }
  return null;
}

export class JoinPagesStep extends Step {
  /** position between the two pages */
  readonly pos: number;
  /** levels joined: 1 = the pages only, 2 = the pages and the blocks at the seam, … */
  readonly depth: number;
  /**
   * The pid of the page after the boundary, when known (see the top of this file): a page join
   * whose boundary moved joins the page with this pid instead. Only for depth 1.
   */
  readonly pid: string | null;
  // The boundary actually joined, filled by apply (getMap and invert need it).
  private at: number;

  constructor(pos: number, depth = 1, pid: string | null = null) {
    super();
    this.pos = pos;
    this.depth = depth;
    this.pid = pid;
    this.at = pos;
  }

  apply(doc: PMNode): StepResult {
    const { pos, depth } = this;
    let at = pos;
    let problem = joinProblem(doc, at, depth);
    if (problem !== null && this.pid !== null && depth === 1) {
      // Pagination moved the boundary (join + split elsewhere): join the page it belongs to.
      const found = boundaryOfPage(doc, pos, this.pid);
      if (found !== null && joinProblem(doc, found, depth) === null) {
        at = found;
        problem = null;
      }
    }
    if (problem !== null) return StepResult.fail(`JoinPagesStep: ${problem}`);
    this.at = at;
    return StepResult.fromReplace(doc, at - depth, at + depth, Slice.empty);
  }

  override getMap(): StepMap {
    return new StepMap([this.at - this.depth, 2 * this.depth, 0]);
  }

  invert(doc: PMNode): Step {
    return new PageBreakStep(this.at - this.depth, doc.nodeAt(this.at)?.attrs ?? {});
  }

  map(mapping: Mappable): Step | null {
    const from = mapping.mapResult(this.pos - this.depth, 1);
    const to = mapping.mapResult(this.pos + this.depth, -1);
    if (from.deletedAcross && to.deletedAcross) return null;
    const pos = mapping.mapResult(this.pos, -1);
    return new JoinPagesStep(pos.pos, this.depth, this.pid);
  }

  toJSON(): { stepType: string; pos: number; depth: number; pid?: string } {
    return { stepType: 'hbJoinPages', pos: this.pos, depth: this.depth, ...(this.pid !== null ? { pid: this.pid } : {}) };
  }

  static override fromJSON(_schema: Schema, json: { pos: number; depth?: number; pid?: unknown }): JoinPagesStep {
    if (typeof json.pos !== 'number') throw new RangeError('Invalid input for JoinPagesStep.fromJSON');
    return new JoinPagesStep(json.pos, json.depth ?? 1, typeof json.pid === 'string' ? json.pid : null);
  }
}

/**
 * Brings back a page with `attrs` (a page that a command joined away, which carried objects or
 * markers), history-safe: a PageBreakStep at `pos`, a block boundary inside a page's flow, so the
 * page takes whatever follows `pos`. When nothing follows (`pos` at the end of the page's flow), the
 * page comes back as a placeholder with one empty paragraph. Undo removes exactly that page (the
 * inverse is a JoinPagesStep that finds the page by its pid), wherever pagination has moved its
 * boundary by then. False when no page could be made there.
 */
export function restorePageAt(tr: Transform, pos: number, attrs: Attrs): boolean {
  const $pos = tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size)));
  if ($pos.depth < 1) return false;
  const start = $pos.start(1);
  const end = $pos.end(1);
  // Lift to the page level: the boundary after the page-level block that holds `pos`.
  const at = $pos.depth >= 2 ? $pos.after(2) : $pos.pos;
  if (at > start && at < end) return !tr.maybeStep(new PageBreakStep(at, attrs)).failed;
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (!paragraph) return false;
  tr.insert(end, paragraph.create());
  return !tr.maybeStep(new PageBreakStep(end, attrs)).failed;
}

// Registered once (a module re-run by hot reload would throw on a duplicate id).
for (const [id, stepClass] of [
  ['hbPageBreak', PageBreakStep],
  ['hbJoinPages', JoinPagesStep],
] as const) {
  try {
    Step.jsonID(id, stepClass);
  } catch {
    // already registered
  }
}
