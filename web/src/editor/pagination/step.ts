// One pagination step (plan §4.6): settle one page, then say which page to look at next.
//
//   overflow   push everything after the cut onto the next page (join + split into the next
//              auto page, or a new auto page before a manual one), then check this page once
//              more (a push can leave room: when the overflow was one line of a paragraph whose
//              continuation is on the next page, the browser's widows rule moves a second line
//              with it; the re-check pulls it back through the re-joined paragraph), then the next
//   underflow  pull content of the next auto page back, then measure this page again (a pull
//              that didn't fit is cut again: a wrong estimate costs a step, never a loop); after
//              a pull onto a page kept only for its objects, check the page before it again
//   heading    a heading left at the bottom of the page, apart from the block after it on the
//              next auto page, moves on (keep-with-next; pullTarget never pulls it back alone)
//   settled    renumber an ordered list continuing on the next page, and move on while pages
//              before dirtyTo remain
//
// A page that can't be measured while the editor is visible (user CSS hiding it) is skipped;
// while the whole editor is hidden, the pass waits (blocked). A page whose flow holds an image
// without a size yet is skipped as 'waiting': the plugin keeps it in PaginationState.waiting
// (not settled) until a later check measures it.
//
// Parity: when the page count changes during a pass, every later page swaps odd for even. If the
// layout says that changes the flow (a theme or brew CSS that sizes odd and even pages
// differently), the pass continues to the last page instead of stopping after dirtyTo.
//
// The work only moves forward: a page is checked again only after a pull onto it (every pull
// moves content back, so pulls run out) or once after a push, so a settle always ends. The
// scheduler's loop guard is a safety net.
//
// Layout is behind the PageLayout interface: the DOM implementation (layout.ts) in the editor,
// fakes in unit tests.
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { endOfFirstBlock, insertAutoPageAt, isAutoPage, isPlaceholderPage, moveBoundary, pageAt, renumberContinuations, type PageRef } from './boundary';
import { keepWithNext, type CutChoice } from './cut';
import { PAGINATE, type PaginateMeta, type StepAction } from './state';

/** Where the pass is: the next page to check, and the last page that needs it. */
export interface PaginationProgress {
  dirtyFrom: number | null;
  dirtyTo: number;
  /** the page whose one re-check after a push was done in this pass (see paginatePage) */
  rechecked?: number | null;
  /** the page count changed in this pass: parity may matter after dirtyTo (see the top) */
  parity?: boolean;
}

/** A page measurement: all a step needs to know is whether it overflows. */
export interface LayoutMeasure {
  overflow: boolean;
}

/** Measurement and cut rules (layout.ts for the DOM; tests use fakes). */
export interface PageLayout<M extends LayoutMeasure = LayoutMeasure> {
  /**
   * null when the page isn't laid out: the pass waits while the editor is hidden (isHidden),
   * and skips the page otherwise. 'waiting' when an image in its flow has no size yet: the page
   * is skipped and stays unsettled until a later check measures it.
   */
  measure(page: PageRef): M | null | 'waiting';
  /** whether the whole editor is hidden (not laid out); absent: an unmeasurable page means it is */
  isHidden?(): boolean;
  /**
   * Whether odd and even pages lay out their flow differently (content box size, columns), so
   * that adding or removing a page changes the pages after it. Absent: it doesn't.
   */
  parityMatters?(): boolean;
  /**
   * Whether page `index` is on screen: the scheduler lets a frame run a few steps past its
   * budget for pages in view, so they settle before paint. Absent: never.
   */
  isVisible?(index: number): boolean;
  /** where an overflowing page must end */
  chooseCut(page: PageRef, m: M): CutChoice;
  /** position in `next` (an auto page) where a page with free space should end, or null */
  pullTarget(page: PageRef, m: M, next: PageRef): number | null;
}

export interface StepResult {
  /** the transaction to dispatch: addToHistory false and the PAGINATE meta */
  tr: Transaction;
  action: StepAction;
  /** the page this step looked at */
  page: number;
  progress: PaginationProgress;
}

/**
 * Whether auto page `next` starts with an empty continuation textblock of the block `page` ends
 * with (same type): the fragment holds nothing after the seam.
 */
function startsWithEmptyContinuation(page: PMNode, next: PMNode): boolean {
  const first = next.firstChild;
  const last = page.lastChild;
  return (
    isAutoPage(next) &&
    !isPlaceholderPage(next) &&
    first !== null &&
    last !== null &&
    first.isTextblock &&
    first.content.size === 0 &&
    first.attrs.continuation === true &&
    first.type === last.type
  );
}

/** Settles page `st.dirtyFrom` by one step. The transaction may be meta-only. */
export function paginatePage(state: EditorState, st: PaginationProgress, layout: PageLayout<LayoutMeasure>): StepResult {
  const tr = state.tr.setMeta('addToHistory', false);
  const i = st.dirtyFrom;
  const finish = (action: StepAction, progress: PaginationProgress): StepResult => {
    const meta: PaginateMeta = { ...progress, action, ...(i === null ? {} : { page: i }) };
    tr.setMeta(PAGINATE, meta);
    return { tr, action, page: i ?? -1, progress };
  };
  if (i === null) return finish('done', st);
  const page = pageAt(state.doc, i);
  if (!page) return finish('done', { dirtyFrom: null, dirtyTo: Math.max(0, state.doc.childCount - 1), parity: false });
  const next = pageAt(state.doc, i + 1);
  // Move on while pages up to dirtyTo remain; stop at the first unchanged page after it, unless
  // the page count changed in this pass and parity matters (see the top): then go on to the end.
  const onward = (): PaginationProgress => {
    let dirtyTo = st.dirtyTo;
    let parity = st.parity ?? false;
    if (next && i + 1 > dirtyTo && parity) {
      parity = false; // asked once per pass
      if (layout.parityMatters?.()) dirtyTo = state.doc.childCount - 1;
    }
    const more = next !== null && i + 1 <= dirtyTo;
    return { dirtyFrom: more ? i + 1 : null, dirtyTo, rechecked: st.rechecked ?? null, parity: more && parity };
  };
  // After a boundary move: page i+1 changed, and page indexes after it shifted.
  const moved = (dirtyFrom: number, rechecked = st.rechecked ?? null): PaginationProgress => ({
    dirtyFrom,
    dirtyTo: Math.max(st.dirtyTo + tr.doc.childCount - state.doc.childCount, i + 1),
    rechecked,
    parity: (st.parity ?? false) || tr.doc.childCount !== state.doc.childCount,
  });
  // After a push, page i is checked once more (at most once per pass, so this can't loop).
  const afterPush = (): PaginationProgress => (st.rechecked === i ? moved(i + 1) : moved(i, i));

  const m = layout.measure(page);
  // An image in the flow has no size yet: skip the page for now (the plugin keeps it waiting).
  if (m === 'waiting') return finish('waiting', onward());
  if (!m) {
    // The editor is hidden (display: none, detached): wait, the scheduler retries. Only this
    // page isn't laid out (user CSS hides it): skip it, so the pages after it still paginate.
    if (layout.isHidden?.() ?? true) return finish('blocked', st);
    return finish('settled', onward());
  }

  const setOversized = (value: boolean) => {
    if (page.node.attrs.oversized !== value) tr.setNodeAttribute(page.pos, 'oversized', value);
  };

  // 1. Overflow: push everything after the cut onto the next page.
  if (m.overflow) {
    const cut = layout.chooseCut(page, m);
    setOversized(cut.oversized);
    if (cut.pos === null) return finish('oversized', onward());
    if (next && isAutoPage(next.node)) {
      moveBoundary(tr, i, cut.pos);
      return finish('push', afterPush());
    }
    insertAutoPageAt(tr, i, cut.pos);
    return finish('insert', afterPush());
  }
  setOversized(false);

  // 2. Underflow: pull content of the next auto page back, then measure this page again. An empty
  //    continuation at the top of the next page (left by an undo, or by a split at the seam) is
  //    always pulled: re-joined with its head it adds no line, and left there it is an empty line.
  if (next) {
    const target = layout.pullTarget(page, m, next) ?? (startsWithEmptyContinuation(page.node, next.node) ? endOfFirstBlock(next) : null);
    if (target !== null) {
      const stepsBefore = tr.steps.length;
      // pullTarget never pulls from a page kept only for its objects: once such a page has
      // taken content, the page before it (same section) may have room for that content too.
      const back = isPlaceholderPage(page.node) && isAutoPage(page.node) && i > 0 ? i - 1 : i;
      moveBoundary(tr, i, target);
      if (tr.steps.length > stepsBefore) return finish('pull', moved(back));
    }
  }

  // 3. A heading at the bottom of the page whose block is on the next page moves on with it.
  if (next && isAutoPage(next.node)) {
    const cut = keepWithNext(page, page.contentEnd);
    if (cut > page.contentStart && cut < page.contentEnd) {
      moveBoundary(tr, i, cut);
      return finish('push', afterPush());
    }
  }

  // 4. Settled. An ordered list continuing on the next page follows this page's numbering
  //    (items added or removed here without moving the boundary change it); when it changed,
  //    the next page is checked too, for the list's next fragment.
  if (next && isAutoPage(next.node) && renumberContinuations(tr, i)) return finish('settled', moved(i + 1));
  return finish('settled', onward());
}
