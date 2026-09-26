// What a transaction's steps can have changed (P8.1): plugins that keep something derived from the
// whole document (heading ids, page ids, header rows, fragment fixes) use these to skip their walk
// over every page when a transaction can't have changed what they derive. Cheap: they look at
// each step's own range, never at the whole document.
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep, type Step } from '@tiptap/pm/transform';

/**
 * The positions a step names itself (steps whose map is empty): a mark step's range, or the start
 * of the node an attribute or node-mark step changes (the range reaches into it, so the node counts
 * as touched).
 */
function ownRange(step: Step): [number, number] | null {
  const s = step as unknown as { from?: unknown; to?: unknown; pos?: unknown };
  if (typeof s.from === 'number' && typeof s.to === 'number') return [s.from, s.to];
  if (typeof s.pos === 'number') return [s.pos, s.pos + 1];
  return null;
}

/**
 * Calls `fn(doc, from, to)` for every range the steps of `trs` changed, in the document before
 * the step and in the one after it. Returns false (and stops) when a step has no range (a document
 * attribute: it touches everything) or `fn` returns false.
 */
export function everyChangedRange(trs: readonly Transaction[], fn: (doc: PMNode, from: number, to: number) => boolean): boolean {
  for (const tr of trs) {
    for (let k = 0; k < tr.steps.length; k++) {
      const step = tr.steps[k]!;
      const before = tr.docs[k]!;
      const after = k + 1 < tr.docs.length ? tr.docs[k + 1]! : tr.doc;
      let ok = true;
      let ranges = 0;
      step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
        ranges += 1;
        if (ok) ok = fn(before, oldStart, oldEnd) && fn(after, newStart, newEnd);
      });
      if (!ok) return false;
      if (ranges > 0) continue;
      const own = ownRange(step);
      if (own === null) return false;
      if (!fn(before, own[0], Math.min(own[1], before.content.size)) || !fn(after, own[0], Math.min(own[1], after.content.size))) return false;
    }
  }
  return true;
}

/**
 * Whether the steps of `trs` touched a node for which `test` is true: one that overlaps a changed
 * range (holds it, or lies in it) in the document before or after a step. Inline content is not
 * looked into; `test` sees blocks (textblocks included) and pages.
 */
export function touchesNode(trs: readonly Transaction[], test: (node: PMNode) => boolean): boolean {
  let found = false;
  const clean = everyChangedRange(trs, (doc, from, to) => {
    const a = Math.max(0, Math.min(from, doc.content.size));
    const b = Math.max(a, Math.min(to, doc.content.size));
    doc.nodesBetween(a, b, (node) => {
      if (found) return false;
      if (test(node)) found = true;
      return !found && !node.isTextblock && !node.isAtom;
    });
    return !found;
  });
  return !clean || found;
}

/**
 * Whether every change of `trs` stays inside one page's content: both ends of every changed range
 * are in the same page, below its own level, so no page was added, removed or given attributes.
 */
export function withinPages(trs: readonly Transaction[]): boolean {
  return everyChangedRange(trs, (doc, from, to) => {
    const size = doc.content.size;
    if (from < 0 || to > size) return false;
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    return $from.depth >= 1 && $to.depth >= 1 && $from.index(0) === $to.index(0);
  });
}

/**
 * Whether `tr` only changed the inline content of textblocks: text typed, deleted or replaced
 * inside one textblock per step (no block opened, closed, split or joined), or marks.
 */
export function inlineOnly(tr: Transaction): boolean {
  return tr.steps.every((step, k) => {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    const { slice } = step;
    if (slice.openStart !== 0 || slice.openEnd !== 0) return false;
    const s = step as unknown as { from: number; to: number };
    const doc = tr.docs[k]!;
    const $from = doc.resolve(s.from);
    if (!$from.parent.isTextblock || !$from.sameParent(doc.resolve(s.to))) return false;
    let inline = true;
    slice.content.forEach((node) => {
      if (!node.isInline) inline = false;
    });
    return inline;
  });
}
