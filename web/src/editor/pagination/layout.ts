// The DOM implementation of PageLayout: measure.ts and cut.ts on the rendered pages.
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { isAutoPage, pageAt, type PageRef } from './boundary';
import { chooseCut, hangingSpacesPull } from './cut';
import { measurePageStatus, pageGeometry, pullTarget, type PageMeasure } from './measure';
import { paginationKey } from './state';
import type { PageLayout } from './step';

/**
 * Attribute on the pages pagination is measuring: the page and the one after it (canvas.css
 * renders them with content-visibility: visible). Offscreen pages skip rendering
 * (content-visibility: auto); a skipped page is brought up to date when a measurement reads it,
 * but in Chromium its layout right after a boundary move can differ from the page's settled
 * layout by a line, which costs a pull and a push back per page in a long pass (P8.1). The
 * attribute changes nothing ProseMirror reads (PageView ignores attribute changes of the page
 * element and keeps attributes it didn't write).
 */
export const MEASURING_ATTR = 'data-hb-measuring';

const measuring = new WeakMap<EditorView, HTMLElement[]>();

/**
 * Marks page `index` and the page after it as measured (MEASURING_ATTR), and unmarks the others.
 * Only where offscreen pages skip rendering (.hb-canvas[data-hb-offscreen="skip"], canvas/
 * offscreen.ts); elsewhere every page renders anyway.
 */
export function markMeasuring(view: EditorView, index: number): void {
  if (!measuring.has(view) && !view.dom.closest('[data-hb-offscreen="skip"]')) return;
  const els: HTMLElement[] = [];
  for (const i of [index, index + 1]) {
    const page = pageAt(view.state.doc, i);
    const el = page ? view.nodeDOM(page.pos) : null;
    if (el instanceof HTMLElement) els.push(el);
  }
  for (const el of measuring.get(view) ?? []) if (!els.includes(el)) el.removeAttribute(MEASURING_ATTR);
  for (const el of els) if (!el.hasAttribute(MEASURING_ATTR)) el.setAttribute(MEASURING_ATTR, '');
  measuring.set(view, els);
}

// Failed pulls (P8.1) ---------------------------------------------------------------------------
//
// A pull estimate can be wrong: the pulled content doesn't fit, and the next step pushes all of
// it back. The estimate can't know everything the browser does: a block's margin at the top of a
// page (often 0) and after the page's last block (theme rules such as `dl + * { margin-top }`
// apply there), a definition group or list item taller than a line, Firefox filling columns to
// the last line (no orphans or widows in columns). Each such pull re-renders two pages twice, and
// the same estimate is made again on the page's re-check and on every later check (every
// keystroke on that page). So a pull whose content all came back is remembered, and the same
// pull (same last block of the page, same first block of the next page, same end, same free
// space and column geometry) isn't tried again. Forgotten on every REPAGINATE (theme, CSS,
// fonts: what decided it may have changed) and when the editor goes.

/** What a pull was decided on: page `index`'s last block, the next page's first block, the pull's end, the measurement. */
interface PullKey {
  last: PMNode | null;
  first: PMNode;
  /** the pull's end, from the start of the next page's content */
  offset: number;
  /** the measurement it was decided on: columns, their width, the box height, the free space */
  measured: string;
}

/** Failed pulls remembered per editor (the oldest go first). */
const MAX_FAILED_PULLS = 64;

const r2 = (v: number) => Math.round(v * 20) / 20;

function measuredKey(m: PageMeasure): string {
  return [m.columns, r2(m.columnWidth), r2(m.box.height), r2(m.scale), m.lastColumn, r2(m.lastMarginBottom), ...m.columnFree.map(r2)].join(' ');
}

function sameNode(a: PMNode | null, b: PMNode | null): boolean {
  return a === b || (a !== null && b !== null && a.eq(b));
}

function sameKey(a: PullKey, b: PullKey): boolean {
  return a.offset === b.offset && a.measured === b.measured && sameNode(a.first, b.first) && sameNode(a.last, b.last);
}

/** The failed pulls of one editor (see above). `generation` is stats.repaginations: a new one forgets them. */
export class FailedPulls {
  private generation = -1;
  /** the pull being tried: its page (index and node before the pull), judged by the next measurements */
  private attempt: (PullKey & { index: number; page: PMNode; checks: number }) | null = null;
  /** pulls whose content came back (most recent last) */
  private readonly failed: PullKey[] = [];

  private sync(generation: number): void {
    if (generation === this.generation) return;
    this.generation = generation;
    this.attempt = null;
    this.failed.length = 0;
  }

  /**
   * Before each measurement (`doc` is the document now): when the pull being tried was pushed back
   * whole (its page is as it was before the pull), it is remembered as failed. A pull is judged
   * within three measurements (the page again, then its re-check), then forgotten.
   */
  judge(doc: PMNode, generation: number): void {
    this.sync(generation);
    const attempt = this.attempt;
    if (!attempt) return;
    const now = attempt.index < doc.childCount ? doc.child(attempt.index) : null;
    if (now !== null && now !== attempt.page && now.eq(attempt.page)) {
      this.attempt = null;
      this.failed.push({ last: attempt.last, first: attempt.first, offset: attempt.offset, measured: attempt.measured });
      if (this.failed.length > MAX_FAILED_PULLS) this.failed.shift();
      return;
    }
    attempt.checks += 1;
    if (attempt.checks >= 3) this.attempt = null;
  }

  /** `target` (a pull onto `page` from `next`, measured `m`), or null when the same pull failed before. */
  allow(page: PageRef, m: PageMeasure, next: PageRef, target: number | null, generation: number): number | null {
    this.sync(generation);
    const first = next.node.firstChild;
    if (target === null || first === null) return target;
    const key: PullKey = { last: page.node.lastChild, first, offset: target - next.contentStart, measured: measuredKey(m) };
    if (this.failed.some((f) => sameKey(f, key))) return null;
    this.attempt = { ...key, index: page.index, page: page.node, checks: 0 };
    return target;
  }

  /** What the remembered failures were decided on (tests, the performance page). */
  list(): { last: string | null; first: string; continuation: boolean; offset: number; measured: string }[] {
    return this.failed.map((f) => ({
      last: f.last?.type.name ?? null,
      first: f.first.type.name,
      continuation: f.first.attrs.continuation === true,
      offset: f.offset,
      measured: f.measured,
    }));
  }
}

const failedPullMemos = new WeakMap<EditorView, FailedPulls>();

function failedPullMemo(view: EditorView): FailedPulls {
  let memo = failedPullMemos.get(view);
  if (!memo) failedPullMemos.set(view, (memo = new FailedPulls()));
  return memo;
}

const generationOf = (view: EditorView): number => paginationKey.getState(view.state)?.stats.repaginations ?? 0;

/** The failed pulls remembered for `view` (tests, the performance page): what they were decided on. */
export function failedPulls(view: EditorView): ReturnType<FailedPulls['list']> {
  return failedPullMemos.get(view)?.list() ?? [];
}

export function domLayout(view: EditorView): PageLayout<PageMeasure> {
  return {
    measure: (page) => {
      markMeasuring(view, page.index);
      failedPullMemo(view).judge(view.state.doc, generationOf(view));
      return measurePageStatus(view, page);
    },
    chooseCut: (page, m) => chooseCut(view, page, m),
    // Spaces left at the top of a continuation go back to the line they hang on (cut.ts).
    pullTarget: (page, m, next) => failedPullMemo(view).allow(page, m, next, pullTarget(view, m, next) ?? hangingSpacesPull(page.node, next), generationOf(view)),
    // Hidden: the editor has no boxes (display: none on it or an ancestor, detached).
    isHidden: () => !view.dom.isConnected || view.dom.getClientRects().length === 0,
    parityMatters: () => parityMatters(view),
    isVisible: (index) => pageInView(view, index),
  };
}

/** The nearest ancestor of `el` that scrolls (clips its content), or null. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(`${overflowX} ${overflowY}`)) return node;
  }
  return null;
}

const scrollParents = new WeakMap<HTMLElement, HTMLElement | null>();

/** Whether page `index` intersects the window and the editor's scroll container. */
export function pageInView(view: EditorView, index: number): boolean {
  const page = pageAt(view.state.doc, index);
  const el = page ? view.nodeDOM(page.pos) : null;
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
  if (!scrollParents.has(view.dom)) scrollParents.set(view.dom, scrollParent(view.dom));
  const clip = scrollParents.get(view.dom);
  if (!clip) return true;
  const c = clip.getBoundingClientRect();
  return r.bottom > c.top && r.top < c.bottom && r.right > c.left && r.left < c.right;
}

const hasMarkers = (attrs: Record<string, unknown>): boolean => Array.isArray(attrs.markers) && attrs.markers.length > 0;

/**
 * Whether odd and even pages lay out their flow differently: compares the flow box (content box
 * size, column count, gap, direction) of the first two consecutive pages of one section without
 * markers (an auto page and the page before it share their section settings, so only the page
 * parity tells them apart). False when there is no such pair or they aren't laid out.
 *
 * Journal, for one, gives odd and even pages different paddings, but of the same total width,
 * so its flow boxes have the same size and this is false: adding a page changes nothing after it.
 */
export function parityMatters(view: EditorView): boolean {
  const doc = view.state.doc;
  for (let k = 0; k + 1 < doc.childCount; k++) {
    const b = doc.child(k + 1);
    if (!isAutoPage(b) || hasMarkers(b.attrs) || hasMarkers(doc.child(k).attrs)) continue;
    const ga = pageGeometry(view, pageAt(doc, k)!);
    const gb = pageGeometry(view, pageAt(doc, k + 1)!);
    if (!ga || !gb) continue;
    const tol = Math.max(ga.eps, gb.eps);
    return (
      Math.abs(ga.box.width - gb.box.width) > tol ||
      Math.abs(ga.box.height - gb.box.height) > tol ||
      Math.abs(ga.gap - gb.gap) > tol ||
      ga.columns !== gb.columns ||
      ga.rtl !== gb.rtl
    );
  }
  return false;
}
