// Page tracking for the page navigation toolbar and the outline (P3.9): which page is current,
// which pages are in view, and navigation between them. Ported from upstream's brewRenderer
// (IntersectionObserver per page) and toolBar.jsx (prev/next/jump).
//
// One IntersectionObserver on the canvas viewport watches every div.page; a MutationObserver on
// the pages root (div.pages.ProseMirror) keeps the observed set in step with pagination adding
// and removing pages. Rects include the canvas transform, so zoom needs no special handling.
//
// Current page: the page showing the largest share of itself in the viewport (the first one on a
// tie), except that the page made current by a jump stays current while it is among those. So
// jumping to page 12 of 12 at a small zoom, where pages 9-12 are all fully visible, shows 12.
// Upstream used the page crossing the viewport's middle, which at small zooms was rarely the page
// the user asked for.
//
// Previous / next move by rows: a facing spread's two pages, or a row of the flow layout, count
// as one step (upstream stepped by the number of visible pages).
//
// The tracker observes only while it has subscribers (useSyncExternalStore), so creating one is
// free of side effects.
import { scrollCanvasTo } from './scrollCanvas';

export interface PageTrackingState {
  /** The current page, 1-based (0 when there are no pages). */
  current: number;
  total: number;
  /** 1-based pages with at least 30% of their area in view (the current page when none are). */
  visible: readonly number[];
  /** The current page is in the first row (no previous page to go to). */
  atStart: boolean;
  /** The current page's row holds the last page (no next row). */
  atEnd: boolean;
}

export interface PageTrackerOptions {
  /** The canvas scroll container (EditorCanvasHandle.viewport). Read when observation starts. */
  viewport: () => HTMLElement | null;
  /** The pages root, div.pages.ProseMirror (editor.view.dom). */
  root: () => HTMLElement | null;
  /** Space left above a page or block scrolled to (screen px, default 16). */
  margin?: number;
}

export interface PageTracker {
  getState: () => PageTrackingState;
  subscribe: (listener: () => void) => () => void;
  /** Scrolls page `n` (1-based, clamped) to the top of the viewport and makes it current. */
  goToPage: (n: number) => boolean;
  /** The first page of the next row. */
  goToNext: () => boolean;
  /** The first page of the previous row. */
  goToPrevious: () => boolean;
  /** Scrolls an element inside the canvas (a heading) to the top; its page becomes current. */
  scrollToElement: (el: Element) => boolean;
  /** The 1-based page that contains `el` (0 when none). */
  pageOf: (el: Element | null) => number;
  /** Re-reads pages and recomputes (normally automatic). */
  refresh: () => void;
}

/** A page counts as visible from this share of its area (upstream's threshold). */
export const VISIBLE_RATIO = 0.3;
const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);
/** Rows: pages whose tops differ by less than this (px) are in one row. */
const ROW_EPSILON = 2;
/** Pages within this share of the best ratio tie for current. */
const RATIO_EPSILON = 0.01;

const EMPTY: PageTrackingState = { current: 0, total: 0, visible: [], atStart: true, atEnd: true };

export function createPageTracker({ viewport: getViewport, root: getRoot, margin = 16 }: PageTrackerOptions): PageTracker {
  const listeners = new Set<() => void>();
  let state: PageTrackingState = EMPTY;
  let pages: HTMLElement[] = [];
  let indexOf = new Map<Element, number>();
  const ratios = new Map<Element, number>();
  /** 1-based page chosen by the last jump (or the last current page): kept while it ties for current. */
  let preferred = 0;
  // After a jump the observer reports the new layout a frame later; until then (and never from
  // entries computed before the jump) the jump target is current.
  let jumpPending = false;
  let jumpTime = 0;
  let intersection: IntersectionObserver | null = null;
  let mutation: MutationObserver | null = null;
  let observedRoot: HTMLElement | null = null;
  let scheduled = false;

  const emit = (next: PageTrackingState) => {
    if (sameState(state, next)) return;
    state = next;
    for (const listener of Array.from(listeners)) listener();
  };

  const readPages = () => {
    const root = observedRoot;
    const next = root ? Array.from(root.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('page')) : [];
    const nextSet = new Set(next);
    for (const el of pages) {
      if (!nextSet.has(el)) {
        intersection?.unobserve(el);
        ratios.delete(el);
      }
    }
    const before = new Set(pages);
    for (const el of next) if (!before.has(el)) intersection?.observe(el);
    pages = next;
    indexOf = new Map(next.map((el, i) => [el, i]));
  };

  const top = (el: Element | undefined) => el?.getBoundingClientRect().top ?? 0;

  const compute = (): PageTrackingState => {
    const total = pages.length;
    if (total === 0) return EMPTY;
    let best = 0;
    for (const el of pages) best = Math.max(best, ratios.get(el) ?? 0);
    const candidates: number[] = [];
    const visible: number[] = [];
    pages.forEach((el, i) => {
      const ratio = ratios.get(el) ?? 0;
      if (best > 0 && ratio >= best - RATIO_EPSILON) candidates.push(i + 1);
      if (ratio >= VISIBLE_RATIO - 1e-6) visible.push(i + 1);
    });
    let current: number;
    if (jumpPending && preferred >= 1 && preferred <= total) current = preferred;
    else if (candidates.length === 0) current = preferred >= 1 && preferred <= total ? preferred : 1;
    else if (candidates.includes(preferred)) current = preferred;
    else current = candidates[0] ?? 1;
    preferred = current;
    const currentTop = top(pages[current - 1]);
    return {
      current,
      total,
      visible: visible.length > 0 ? visible : [current],
      atStart: Math.abs(currentTop - top(pages[0])) < ROW_EPSILON,
      atEnd: Math.abs(currentTop - top(pages[total - 1])) < ROW_EPSILON,
    };
  };

  const update = () => {
    scheduled = false;
    if (!observedRoot) return;
    emit(compute());
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(update);
  };

  const start = () => {
    const viewport = getViewport();
    const root = getRoot();
    if (!viewport || !root || typeof IntersectionObserver === 'undefined') return;
    observedRoot = root;
    intersection = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
          if (entry.time >= jumpTime) jumpPending = false;
        }
        schedule();
      },
      { root: viewport, threshold: THRESHOLDS },
    );
    mutation = new MutationObserver(() => {
      readPages();
      schedule();
    });
    mutation.observe(root, { childList: true });
    pages = [];
    readPages();
    emit(compute());
  };

  const stop = () => {
    intersection?.disconnect();
    mutation?.disconnect();
    intersection = null;
    mutation = null;
    observedRoot = null;
    pages = [];
    indexOf = new Map();
    ratios.clear();
  };

  /** Pages as they are now (also when not observing, e.g. a call from a test). */
  const livePages = (): HTMLElement[] => {
    if (observedRoot) return pages;
    const root = getRoot();
    return root ? Array.from(root.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('page')) : [];
  };

  const markJump = (page: number) => {
    preferred = page;
    jumpPending = true;
    jumpTime = performance.now();
  };

  const goToPage = (n: number): boolean => {
    const list = livePages();
    const viewport = getViewport();
    if (list.length === 0 || !viewport || !Number.isFinite(n)) return false;
    const page = Math.min(list.length, Math.max(1, Math.round(n)));
    const el = list[page - 1];
    if (!el) return false;
    markJump(page);
    scrollCanvasTo(viewport, el, { margin });
    if (observedRoot) emit(compute());
    return true;
  };

  const currentIndex = (list: HTMLElement[]) => {
    const current = observedRoot ? state.current : preferred || 1;
    return Math.min(list.length, Math.max(1, current)) - 1;
  };

  const goToNext = (): boolean => {
    const list = livePages();
    if (list.length === 0) return false;
    const from = currentIndex(list);
    const rowTop = top(list[from]);
    for (let i = from + 1; i < list.length; i++) {
      if (top(list[i]) > rowTop + ROW_EPSILON) return goToPage(i + 1);
    }
    return false;
  };

  const goToPrevious = (): boolean => {
    const list = livePages();
    if (list.length === 0) return false;
    const from = currentIndex(list);
    const rowTop = top(list[from]);
    for (let i = from - 1; i >= 0; i--) {
      const t = top(list[i]);
      if (t < rowTop - ROW_EPSILON) {
        let first = i;
        while (first > 0 && Math.abs(top(list[first - 1]) - t) < ROW_EPSILON) first--;
        return goToPage(first + 1);
      }
    }
    return false;
  };

  const pageOf = (el: Element | null): number => {
    let node: Element | null = el;
    while (node) {
      const index = indexOf.get(node);
      if (index !== undefined) return index + 1;
      if (node.classList.contains('page') && node.parentElement === getRoot()) {
        return livePages().indexOf(node as HTMLElement) + 1;
      }
      node = node.parentElement;
    }
    return 0;
  };

  const scrollToElement = (el: Element): boolean => {
    const viewport = getViewport();
    if (!viewport || !el.isConnected) return false;
    const page = pageOf(el);
    if (page > 0) markJump(page);
    scrollCanvasTo(viewport, el, { margin });
    if (observedRoot) emit(compute());
    return true;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    goToPage,
    goToNext,
    goToPrevious,
    scrollToElement,
    pageOf,
    refresh: () => {
      if (!observedRoot) return;
      readPages();
      emit(compute());
    },
  };
}

function sameState(a: PageTrackingState, b: PageTrackingState): boolean {
  return (
    a.current === b.current &&
    a.total === b.total &&
    a.atStart === b.atStart &&
    a.atEnd === b.atEnd &&
    a.visible.length === b.visible.length &&
    a.visible.every((v, i) => v === b.visible[i])
  );
}
