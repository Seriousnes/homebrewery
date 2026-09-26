// An attribute change on an auto page that its undo survives pagination (review finding UI-1).
//
// ProseMirror's AttrStep names its node by position. Pagination moves the boundary before an auto
// page with join + split (pagination/boundary.ts moveBoundary): the join deletes the page's
// opening token, so history maps the AttrStep of an earlier object edit to "deleted" and drops
// it. Undo then silently does nothing, and a deleted object is gone for good. The split re-creates
// the page with the same attributes, pid included.
//
// PageAttrStep names the page by its pid (plan §3.4: stable page ids) and keeps its position as a
// hint: it maps through every change, and applies to the page that has the pid, wherever that page
// is now. Manual pages never lose their opening token to pagination, so they keep plain AttrSteps
// (setPageAttr), as do pages without a pid yet.
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Step, StepMap, StepResult, type Mappable, type Transform } from '@tiptap/pm/transform';

const STEP_ID = 'hbPageAttr';

/** The position of the page with `pid`, preferring the one at `hint`; -1 when there is none. */
function findPage(doc: PMNode, pid: string, hint: number): number {
  const at = hint >= 0 && hint < doc.content.size ? doc.nodeAt(hint) : null;
  if (at?.type.name === 'page' && at.attrs.pid === pid && doc.resolve(hint).depth === 0) return hint;
  let found = -1;
  doc.forEach((page, pos) => {
    if (found < 0 && page.type.name === 'page' && page.attrs.pid === pid) found = pos;
  });
  return found;
}

export class PageAttrStep extends Step {
  /**
   * Where the page is: a hint, updated to the page's real position when the step applies, so code
   * that reads a step's `pos` (pagination's changed pages) sees the page it changed.
   */
  pos: number;
  /** the page's pid */
  readonly pid: string;
  readonly attr: string;
  readonly value: unknown;

  constructor(pos: number, pid: string, attr: string, value: unknown) {
    super();
    this.pos = pos;
    this.pid = pid;
    this.attr = attr;
    this.value = value;
  }

  override apply(doc: PMNode): StepResult {
    const pos = findPage(doc, this.pid, this.pos);
    if (pos < 0) return StepResult.fail(`No page with pid ${this.pid}`);
    this.pos = pos;
    const page = doc.nodeAt(pos)!;
    const attrs: Record<string, unknown> = { ...page.attrs, [this.attr]: this.value };
    const updated = page.type.create(attrs, null, page.marks);
    return StepResult.fromReplace(doc, pos, pos + 1, new Slice(Fragment.from(updated), 0, 1));
  }

  override getMap(): StepMap {
    return StepMap.empty;
  }

  override invert(doc: PMNode): Step {
    const pos = findPage(doc, this.pid, this.pos);
    const page = pos < 0 ? null : doc.nodeAt(pos);
    return new PageAttrStep(pos < 0 ? this.pos : pos, this.pid, this.attr, page?.attrs[this.attr] ?? null);
  }

  /** Never dropped: a position deleted by a join is only a hint, the pid finds the page. */
  override map(mapping: Mappable): Step {
    return new PageAttrStep(mapping.mapResult(this.pos, 1).pos, this.pid, this.attr, this.value);
  }

  override toJSON(): { stepType: string; pos: number; pid: string; attr: string; value: unknown } {
    return { stepType: STEP_ID, pos: this.pos, pid: this.pid, attr: this.attr, value: this.value };
  }

  static override fromJSON(_schema: Schema, json: { pos?: unknown; pid?: unknown; attr?: unknown; value?: unknown }): PageAttrStep {
    if (typeof json.pos !== 'number' || typeof json.pid !== 'string' || typeof json.attr !== 'string') {
      throw new RangeError('Invalid input for PageAttrStep.fromJSON');
    }
    return new PageAttrStep(json.pos, json.pid, json.attr, json.value);
  }
}

try {
  Step.jsonID(STEP_ID, PageAttrStep);
} catch {
  // Already registered (a hot module reload evaluates this file again).
}

/**
 * Sets attribute `attr` of the page at `pagePos`: a PageAttrStep on an auto page with a pid (its
 * undo survives pagination's boundary moves), a plain AttrStep otherwise.
 */
export function setPageAttr<T extends Transform>(tr: T, pagePos: number, attr: string, value: unknown): T {
  const page = tr.doc.nodeAt(pagePos);
  const pid = page?.attrs.pid as unknown;
  if (page?.type.name === 'page' && page.attrs.kind === 'auto' && typeof pid === 'string' && pid !== '') {
    tr.step(new PageAttrStep(pagePos, pid, attr, value));
    return tr;
  }
  tr.setNodeAttribute(pagePos, attr, value);
  return tr;
}
