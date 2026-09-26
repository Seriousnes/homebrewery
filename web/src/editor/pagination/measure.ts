// Measuring a rendered page (plan §4.3). A page overflows when part of its flow lands outside
// the content box of its .columnWrapper: in an overflow column to the right of the box (the
// wrapper is a multi-column container with a fixed height and column-fill: auto) or below it
// (column-spanning or monolithic content taller than the space left).
//
// All geometry is in client (viewport) pixels, read from the same layout pass. Canvas zoom is a
// transform on an ancestor, which scales every rect alike, so comparisons give the same result
// at every zoom level; CSS lengths read from computed styles (padding, margins, line heights,
// the column gap) are multiplied by the page's scale to join them.
//
// A block is measured by its own fragments plus those of its floated descendants (blockRects):
// a float (.wrapLeft / .wrapRight images, float: right) that doesn't fit is pushed into the
// overflow column on its own, while the paragraph holding it keeps its line box inside.
// Right-to-left pages (direction: rtl) place overflow columns to the left of the box.
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { isAutoPage, isPlaceholderPage, pageAt, type PageRef } from './boundary';

/** Tolerance in CSS pixels (scaled with the zoom, so the same at every zoom level). */
export const EPS = 0.5;

/** A plain rectangle (DOMRect without the methods; serializable). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** The measurement geometry the cut and pull rules share. */
export interface Geometry {
  /** content box of .columnWrapper (padding and border excluded), client px */
  box: Box;
  /** client px per CSS px: the canvas zoom */
  scale: number;
  /** EPS in client px */
  eps: number;
  /** computed column-count of the wrapper (themes and :has() rules can change it) */
  columns: number;
  /** column gap, client px */
  gap: number;
  /** width of one column, client px */
  columnWidth: number;
  /** direction: rtl on the wrapper: columns (and overflow columns) run right to left */
  rtl: boolean;
}

/** The first flow block with a fragment outside the content box. */
export interface OverflowHit {
  /** index of the block among the page's children */
  index: number;
  /** document position before the block */
  pos: number;
  el: HTMLElement;
  /** the block's first fragment outside the box */
  rect: Box;
  /** whether the block's first fragment is inside (it began on this page) */
  startsInside: boolean;
}

export interface PageMeasure extends Geometry {
  overflow: boolean;
  first: OverflowHit | null;
  /** top of the last row of columns (below the last column-spanning block) */
  rowTop: number;
  /** column the flow ends in, in the last row (columns = a forced break filled the last one) */
  lastColumn: number;
  /** bottom of the flow in lastColumn */
  lastBottom: number;
  /** margin-bottom of the last flow block, client px (collapses with what follows) */
  lastMarginBottom: number;
  /**
   * Free height per column of the last row: 0 before lastColumn (the flow has passed them),
   * the space below the flow in lastColumn, the whole row height after it.
   */
  columnFree: number[];
  /**
   * Sum of columnFree: px of flow that could still be added. Content that can't split across
   * columns, and rows balanced above a spanner, make this an over-estimate; that's safe (an
   * over-eager pull is cut again on the next pass).
   */
  freeSpace: number;
}

const px = (value: string): number => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

export const toBox = (r: DOMRectReadOnly | Box): Box => ({
  left: r.left,
  top: r.top,
  right: r.right,
  bottom: r.bottom,
  width: r.width,
  height: r.height,
});

/** The page element and its .columnWrapper for `page`, or null when they aren't rendered. */
export function pageElements(view: EditorView, page: PageRef): { pageEl: HTMLElement; wrap: HTMLElement } | null {
  const dom = view.nodeDOM(page.pos);
  if (!(dom instanceof HTMLElement)) return null;
  const wrap = dom.querySelector<HTMLElement>(':scope > div.columnWrapper');
  return wrap ? { pageEl: dom, wrap } : null;
}

/** Client px per CSS px of `el` (the transform scale of the canvas zoom). */
export function scaleOf(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  let width = px(cs.width);
  if (cs.boxSizing !== 'border-box') {
    width += px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
  }
  const scale = el.getBoundingClientRect().width / width;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Content box of `el` in client px: its border box minus border and padding. */
export function contentBox(el: HTMLElement, scale: number): Box {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const left = r.left + (px(cs.borderLeftWidth) + px(cs.paddingLeft)) * scale;
  const top = r.top + (px(cs.borderTopWidth) + px(cs.paddingTop)) * scale;
  const right = r.right - (px(cs.borderRightWidth) + px(cs.paddingRight)) * scale;
  const bottom = r.bottom - (px(cs.borderBottomWidth) + px(cs.paddingBottom)) * scale;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Geometry of a page's flow, or null when the page isn't laid out (hidden, detached, jsdom). */
export function pageGeometry(view: EditorView, page: PageRef): (Geometry & { wrap: HTMLElement }) | null {
  const els = pageElements(view, page);
  if (!els) return null;
  const scale = scaleOf(els.pageEl);
  const box = contentBox(els.wrap, scale);
  if (!(box.width > 0 && box.height > 0)) return null;
  const cs = getComputedStyle(els.wrap);
  const columns = Math.max(1, parseInt(cs.columnCount, 10) || 1);
  const gapValue = parseFloat(cs.columnGap);
  const gap = (Number.isFinite(gapValue) ? gapValue : px(cs.fontSize)) * scale; // 'normal' = 1em
  const columnWidth = Math.max(0, (box.width - (columns - 1) * gap) / columns);
  const rtl = cs.direction === 'rtl';
  return { wrap: els.wrap, box, scale, eps: EPS * scale, columns, gap, columnWidth, rtl };
}

/**
 * A fragment outside the box: in an overflow column (right of the box; left of it on an rtl
 * page), or reaching below the box.
 */
export const isOutside = (r: Box | DOMRectReadOnly, g: Geometry): boolean =>
  (g.rtl ? r.right <= g.box.left + g.eps : r.left >= g.box.right - g.eps) || r.bottom > g.box.bottom + g.eps;

/** Column index (0-based, in flow order) of a fragment: from its left edge, or its right edge on an rtl page. */
export function columnOf(r: { left: number; right: number }, g: Geometry): number {
  const pitch = g.columnWidth + g.gap;
  const offset = g.rtl ? g.box.right - r.right : r.left - g.box.left;
  const col = pitch > 0 ? Math.floor((offset + g.eps) / pitch) : 0;
  return Math.max(0, Math.min(g.columns - 1, col));
}

/** Fragments with some height (zero-height fragments carry nothing visible). */
export function visibleRects(el: Element, eps = 0): DOMRect[] {
  return Array.from(el.getClientRects()).filter((r) => r.height > eps);
}

export function isOutOfFlow(cs: CSSStyleDeclaration): boolean {
  return cs.position === 'absolute' || cs.position === 'fixed' || cs.display === 'none' || cs.display === 'contents';
}

/**
 * Unsized images a measurement saw before they had loaded. The scheduler re-checks their page
 * on their load or error event (plugin.ts), and only for these.
 */
export const pendingImages = new WeakSet<HTMLImageElement>();

/** How long measurements wait for an unsized image to load before taking its current size. */
export const IMAGE_WAIT_MS = 3000;
const firstSeen = new WeakMap<HTMLImageElement, number>();

/**
 * Whether an image's size is still unknown: it hasn't loaded, has no width and height
 * attributes, and was first seen less than IMAGE_WAIT_MS ago. Its page can't be measured yet
 * (the image has no height until it loads; in Firefox even an image already in the cache, when a
 * boundary move re-renders its paragraph). It is remembered (pendingImages), and if the browser
 * defers it (loading=lazy, far below the viewport) it starts loading now.
 */
function unsized(img: HTMLImageElement): boolean {
  if (img.complete || (img.hasAttribute('width') && img.hasAttribute('height'))) return false;
  pendingImages.add(img);
  if (img.loading === 'lazy') img.loading = 'eager';
  const now = performance.now();
  const since = firstSeen.get(img);
  if (since === undefined) firstSeen.set(img, now);
  return since === undefined || now - since < IMAGE_WAIT_MS;
}

interface BlockContent {
  floats: HTMLElement[];
  /** images in the flow (ProseMirror's separators left out) */
  images: HTMLImageElement[];
  /** an image whose size isn't known yet (see unsized) */
  waiting: boolean;
}

/** What a block holds besides text: floats and images. */
function contentOf(el: Element): BlockContent {
  const content: BlockContent = { floats: [], images: [], waiting: false };
  const walk = (parent: Element) => {
    for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
      if (!(child instanceof HTMLElement)) continue;
      const image = child instanceof HTMLImageElement && !child.classList.contains('ProseMirror-separator') ? child : null;
      if (image && unsized(image)) content.waiting = true;
      const cs = getComputedStyle(child);
      if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
      if (cs.float !== 'none') content.floats.push(child);
      else if (image) content.images.push(image);
      else if (child.firstElementChild) walk(child);
    }
  };
  if (el.firstElementChild) walk(el);
  return content;
}

/**
 * Floated descendants of `el` (computed float other than none). Hidden and absolutely
 * positioned subtrees are skipped; a float's own descendants are covered by its box.
 */
export function floatsOf(el: Element): HTMLElement[] {
  return contentOf(el).floats;
}

/**
 * Whether a block can't be cut line by line the way pull estimates assume: it holds a float,
 * or an image taller than one and a half lines (its line is one tall line box).
 */
function holdsMonolith(el: Element, lineHeight: number): { monolith: boolean; floats: HTMLElement[]; waiting: boolean } {
  const { floats, images, waiting } = contentOf(el);
  const monolith = floats.length > 0 || images.some((img) => img.getBoundingClientRect().height > 1.5 * lineHeight);
  return { monolith, floats, waiting };
}

/**
 * The fragments of a flow block: its own (one per column fragment) followed by those of its
 * floated descendants, which the block's own rects don't include. A float that doesn't fit is
 * placed in the overflow column by itself.
 */
export function blockRects(el: Element, eps = 0): DOMRect[] {
  const rects = visibleRects(el, eps);
  for (const float of floatsOf(el)) rects.push(...visibleRects(float, eps));
  return rects;
}

export const isSpanner = (cs: CSSStyleDeclaration): boolean => cs.columnSpan === 'all';

const FORCED_BREAKS = new Set(['column', 'always', 'page', 'left', 'right', 'recto', 'verso', 'all']);
export const hasForcedBreakAfter = (cs: CSSStyleDeclaration): boolean => FORCED_BREAKS.has(cs.breakAfter);
export const hasForcedBreakBefore = (cs: CSSStyleDeclaration): boolean => FORCED_BREAKS.has(cs.breakBefore);

/**
 * Calls `fn` for each child of `parent` (content from `contentStart`) with its rendered element,
 * skipping unrendered ones, until `fn` returns false.
 */
export function forEachBlock(
  view: EditorView,
  parent: PMNode,
  contentStart: number,
  fn: (node: PMNode, pos: number, index: number, el: HTMLElement) => boolean,
  fromIndex = 0,
): void {
  let pos = contentStart;
  for (let i = 0; i < parent.childCount; i++) {
    const node = parent.child(i);
    if (i >= fromIndex) {
      const el = view.nodeDOM(pos);
      if (el instanceof HTMLElement && !fn(node, pos, i, el)) return;
    }
    pos += node.nodeSize;
  }
}

/**
 * Measures page `page`: whether its flow overflows the content box (and the first block that
 * does), and how much free space is left. Null when the page isn't laid out, and while an image
 * in its flow (before the first overflow) has no size yet: its load re-checks the page.
 */
export function measurePage(view: EditorView, page: PageRef): PageMeasure | null {
  const m = measurePageStatus(view, page);
  return m === 'waiting' ? null : m;
}

/**
 * measurePage, telling the two unmeasurable cases apart: null when the page isn't laid out,
 * 'waiting' while an image in its flow has no size yet (the pagination layout, layout.ts).
 */
export function measurePageStatus(view: EditorView, page: PageRef): PageMeasure | 'waiting' | null {
  const g = pageGeometry(view, page);
  if (!g) return null;
  const { box, eps, columns } = g;
  let rowTop = box.top;
  let lastColumn = 0;
  let lastBottom = box.top;
  let lastMarginBottom = 0;
  let first: OverflowHit | null = null;
  let waiting = false;

  forEachBlock(view, page.node, page.contentStart, (_node, pos, index, el) => {
    const cs = getComputedStyle(el);
    if (isOutOfFlow(cs)) return true;
    const content = contentOf(el);
    if (content.waiting) {
      waiting = true;
      return false;
    }
    const rects = visibleRects(el, eps);
    for (const float of content.floats) rects.push(...visibleRects(float, eps));
    const spanner = isSpanner(cs);
    if (hasForcedBreakBefore(cs) && lastBottom > rowTop + eps) {
      lastColumn += 1;
      lastBottom = rowTop;
    }
    for (let r = 0; r < rects.length; r++) {
      const rect = rects[r]!;
      if (isOutside(rect, g)) {
        first = { index, pos, el, rect: toBox(rect), startsInside: r > 0 };
        return false;
      }
      if (spanner) {
        rowTop = Math.max(rowTop, rect.bottom + px(cs.marginBottom) * g.scale);
        lastColumn = 0;
        lastBottom = rowTop;
        continue;
      }
      const col = columnOf(rect, g);
      if (col > lastColumn) {
        lastColumn = col;
        lastBottom = rect.bottom;
      } else if (col === lastColumn) {
        lastBottom = Math.max(lastBottom, rect.bottom);
      }
    }
    lastMarginBottom = spanner ? 0 : px(cs.marginBottom) * g.scale;
    if (!spanner && hasForcedBreakAfter(cs)) {
      lastColumn += 1;
      lastBottom = rowTop;
      lastMarginBottom = 0;
    }
    return true;
  });

  if (waiting) return 'waiting';
  const geometry: Geometry = { box: g.box, scale: g.scale, eps: g.eps, columns: g.columns, gap: g.gap, columnWidth: g.columnWidth, rtl: g.rtl };
  if (first) {
    return {
      ...geometry,
      overflow: true,
      first,
      rowTop,
      lastColumn,
      lastBottom,
      lastMarginBottom,
      columnFree: new Array<number>(columns).fill(0),
      freeSpace: 0,
    };
  }
  const columnFree: number[] = [];
  for (let c = 0; c < columns; c++) {
    if (c < lastColumn) columnFree.push(0);
    else if (c === lastColumn) columnFree.push(Math.max(0, box.bottom - lastBottom));
    else columnFree.push(Math.max(0, box.bottom - rowTop));
  }
  return {
    ...geometry,
    overflow: false,
    first: null,
    rowTop,
    lastColumn,
    lastBottom,
    lastMarginBottom,
    columnFree,
    freeSpace: columnFree.reduce((a, b) => a + b, 0),
  };
}

// Pull estimates ------------------------------------------------------------------------------

/** Blocks the cut rules can split: they flow across columns (lines, list items, dl groups). */
export const SPLITTABLE = new Set(['paragraph', 'bulletList', 'orderedList', 'definitionList']);

function lineHeightOf(cs: CSSStyleDeclaration): number {
  const lh = parseFloat(cs.lineHeight);
  return Number.isFinite(lh) ? lh : px(cs.fontSize) * 1.2;
}

/** A fragmentation count (orphans, widows) from computed style; 1 where it isn't supported (Firefox). */
function lineCountOf(value: string): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const heightOf = (rects: DOMRect[]): number => rects.reduce((sum, r) => sum + r.height, 0);

/**
 * Height (client px, margins excluded) the start of a block needs to begin on a page: the first
 * lines of a paragraph (orphans; one line for a continuation, which joins the paragraph already
 * on the page), the first item of a list or the first group of a definition list, the whole
 * block otherwise (and for a block holding a float or a tall image, which can't split there).
 */
export function unitHeight(node: PMNode, el: HTMLElement, cs: CSSStyleDeclaration, scale: number): number {
  const { monolith, floats } = holdsMonolith(el, lineHeightOf(cs) * scale);
  const total = heightOf(visibleRects(el)) + floats.reduce((sum, f) => sum + heightOf(visibleRects(f)), 0);
  if (monolith) return total;
  switch (node.type.name) {
    case 'paragraph': {
      const lines = node.attrs.continuation === true ? 1 : lineCountOf(cs.orphans);
      return Math.min(total, lines * lineHeightOf(cs) * scale);
    }
    case 'bulletList':
    case 'orderedList': {
      const item = el.firstElementChild;
      if (!item) return total;
      const itemCs = getComputedStyle(item);
      const itemHeight = heightOf(visibleRects(item));
      return Math.min(total, itemHeight + (px(cs.paddingTop) + px(itemCs.marginTop)) * scale);
    }
    case 'definitionList': {
      // dt/dd are usually inline (one group per line), so one group ≈ one line of the list.
      return Math.min(total, lineHeightOf(cs) * scale);
    }
    default:
      return total;
  }
}

/**
 * The height (client px) the first block of `next` needs on the previous page, margin
 * included: see unitHeight. Infinity when it can't be measured.
 */
export function firstUnitHeight(view: EditorView, next: PageRef): number {
  const node = next.node.firstChild;
  const el = view.nodeDOM(next.contentStart);
  if (!node || !(el instanceof HTMLElement)) return Infinity;
  const els = pageElements(view, next);
  const scale = els ? scaleOf(els.pageEl) : 1;
  const cs = getComputedStyle(el);
  const margin = node.attrs.continuation === true ? 0 : px(cs.marginTop) * scale; // re-joins its head
  return margin + unitHeight(node, el, cs, scale);
}

/** Whether the columns of page `next` are as wide as those of the measured page (same line breaks). */
function sameColumnWidth(view: EditorView, m: PageMeasure, next: PageRef): boolean {
  const g = pageGeometry(view, next);
  return g !== null && Math.abs(g.columnWidth - m.columnWidth) <= m.eps && g.rtl === m.rtl;
}

/**
 * The position where line `n` (0-based) of paragraph `el` (the node at `pos`) starts, as it is
 * laid out now, found with coordsAtPos (it reads layout, so it works in clipped overflow columns
 * too). Null when its lines aren't regular (a line box taller than the line height: inline
 * images, bigger text), or when line `n` is its first or isn't there.
 */
export function lineStart(view: EditorView, el: HTMLElement, pos: number, node: PMNode, n: number, lineHeight: number): number | null {
  if (n <= 0 || !(lineHeight > 0)) return null;
  const rects = visibleRects(el);
  let before = 0;
  for (let f = 0; f < rects.length; f++) {
    const rect = rects[f]!;
    const count = Math.round(rect.height / lineHeight);
    if (Math.abs(count * lineHeight - rect.height) > lineHeight / 4) return null; // irregular lines
    if (n >= before + count) {
      before += count;
      continue;
    }
    const top = rect.top + (n - before) * lineHeight;
    // The fragment (column) a caret rect is in: the one whose horizontal span holds its centre.
    const fragmentOf = (c: { left: number; right: number }): number => {
      const x = (c.left + c.right) / 2;
      let best = 0;
      let distance = Infinity;
      rects.forEach((r, k) => {
        const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        if (d < distance) {
          distance = d;
          best = k;
        }
      });
      return best;
    };
    // At or after the target line: in a later fragment, or in this one at or below its top.
    const atOrAfter = (p: number): boolean => {
      const c = view.coordsAtPos(p, 1);
      const k = fragmentOf(c);
      return k > f || (k === f && (c.top + c.bottom) / 2 >= top);
    };
    const from = pos + 1;
    const to = pos + node.nodeSize - 1;
    let lo = from;
    let hi = to;
    try {
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (atOrAfter(mid)) hi = mid;
        else lo = mid + 1;
      }
    } catch {
      return null;
    }
    return lo > from && lo < to ? lo : null;
  }
  return null;
}

/**
 * The units a splittable block flows in, as laid out now (P8.1): a paragraph's lines (none when
 * its lines aren't regular: inline images, bigger text), a list's items (break-inside: avoid; an
 * item's height with the gap before it, the list's padding on the first), with the position after
 * each unit where a page may end (items only: a paragraph's line starts come from lineStart).
 * Null when the block can't be read that way (a definition list, an item not laid out).
 */
function flowUnits(view: EditorView, node: PMNode, pos: number, el: HTMLElement, cs: CSSStyleDeclaration, scale: number): { heights: number[]; ends: number[] | null } | null {
  if (node.type.name === 'paragraph') {
    const lh = lineHeightOf(cs) * scale;
    if (!(lh > 0)) return null;
    let lines = 0;
    for (const rect of visibleRects(el)) {
      const count = Math.round(rect.height / lh);
      if (count < 1 || Math.abs(count * lh - rect.height) > lh / 4) return null;
      lines += count;
    }
    return lines > 0 ? { heights: new Array<number>(lines).fill(lh), ends: null } : null;
  }
  if (node.type.name !== 'bulletList' && node.type.name !== 'orderedList') return null;
  const heights: number[] = [];
  const ends: number[] = [];
  let prevMarginBottom = 0;
  let ok = true;
  forEachBlock(view, node, pos + 1, (item, itemPos, k, itemEl) => {
    const height = heightOf(visibleRects(itemEl));
    if (!(height > 0)) {
      ok = false;
      return false;
    }
    const ics = getComputedStyle(itemEl);
    heights.push(height + (k === 0 ? px(cs.paddingTop) * scale : Math.max(prevMarginBottom, px(ics.marginTop) * scale)));
    ends.push(itemPos + item.nodeSize);
    prevMarginBottom = px(ics.marginBottom) * scale;
    return true;
  });
  if (!ok || heights.length !== node.childCount || heights.length === 0) return null;
  heights[heights.length - 1]! += px(cs.paddingBottom) * scale;
  return { heights, ends };
}

/**
 * How much of `next` (an auto page) to pull back onto the measured page: the position in `next`
 * where the measured page should end, or null when nothing fits. Simulates the column flow of
 * the free space: whole blocks while they fit (blocks that can't split need one column with
 * room, like break-inside: avoid; paragraphs flow line by line and lists item by item from one
 * column into the next, as the browser breaks them, when both pages' columns are equally wide),
 * then one splittable block if its first lines (items) fit: a list up to its last item that fits, a
 * paragraph up to the start of its first line that doesn't fit when both pages' columns are
 * equally wide (lineStart), otherwise whole (the next measurement cuts it at the right line). A
 * block holding a float or a tall image is taken as
 * unsplittable: its lines aren't the paragraph's line height. A block whose image has no size
 * yet stops the pull. A trailing heading is not pulled without the block after it
 * (keep-with-next), not even when it is all of `next` while another auto page follows: it is
 * there because the block after it didn't fit below it (chooseCut breaks keep-with-next for a
 * block that fits a fresh page).
 */
export function pullTarget(view: EditorView, m: PageMeasure, next: PageRef): number | null {
  if (m.overflow || !isAutoPage(next.node) || isPlaceholderPage(next.node)) return null;
  const free = [...m.columnFree];
  const rowHeight = m.box.bottom - m.rowTop;
  // Pull estimates are strict (EPS is lenient, for overflow): a block that "fits" by a fraction
  // of a pixel the browser disagrees with would be pulled and pushed back on every check.
  const tol = 0.01 * m.scale;
  let col = m.lastColumn;
  if (col >= m.columns) return null;
  let prevMarginBottom = m.lastMarginBottom;
  const pulled: { end: number; heading: boolean }[] = [];
  let sameWidth: boolean | null = null;
  const equalColumns = (): boolean => (sameWidth ??= sameColumnWidth(view, m, next));
  /** Columns after m.lastColumn that the flow entered by an unforced break: a block's margin-top is truncated at their top. */
  let freshColumn = false;
  // Places `amount` px of flowing content from column `col` on; false (nothing changed) when
  // it doesn't all fit.
  const flowInto = (amount: number): boolean => {
    let rest = amount;
    let c = col;
    while (c < m.columns && rest > free[c]! + tol) {
      rest -= free[c]!;
      c += 1;
    }
    if (c >= m.columns) return false;
    for (let k = col; k < c; k++) free[k] = 0;
    free[c] = Math.max(0, free[c]! - rest);
    col = c;
    return true;
  };

  /**
   * Places a block's units (lines or items, their heights) from column `col` on, a unit only
   * where it fits whole; the gap before the block is truncated at the top of a column entered by
   * an unforced break. For a paragraph (`lines`: its style), a break between columns keeps
   * `orphans` lines before it and `widows` after it, as the browser does (1 in Firefox). Returns
   * how many units fit on the page and, for a block that fits whole, the columns after it.
   */
  const placeUnits = (heights: number[], gap: number, lines: CSSStyleDeclaration | null) => {
    const f = [...free];
    let c = col;
    /** column c was entered by an unforced break and holds nothing yet */
    let fresh = freshColumn;
    let k = 0;
    /** index of this block's first unit in column c */
    let first = 0;
    /** the gap taken before unit 0 */
    let gapUsed = 0;
    const orphans = lines ? lineCountOf(lines.orphans) : 1;
    const widows = lines ? lineCountOf(lines.widows) : 1;
    while (k < heights.length) {
      const g = k === 0 && !fresh ? gap : 0;
      if (heights[k]! + g <= f[c]! + tol) {
        f[c] = f[c]! - heights[k]! - g;
        if (k === 0) gapUsed = g;
        k += 1;
        fresh = false;
        continue;
      }
      if (c + 1 >= m.columns) break;
      if (lines && k > first) {
        // Lines first…k-1 stay in column c, the rest go on: orphans before the break, widows after.
        let stay = k - first;
        const rest = heights.length - k;
        if (rest < widows && rest * heights[0]! <= f[c + 1]! + tol) stay -= widows - rest;
        if (stay < orphans) stay = 0;
        for (let u = first + stay; u < k; u++) f[c] = f[c]! + heights[u]! + (u === 0 ? gapUsed : 0);
        k = first + stay;
      }
      c += 1;
      fresh = true;
      first = k;
    }
    return { placed: k, first, free: f, col: c, fresh };
  };

  forEachBlock(view, next.node, next.contentStart, (node, pos, _index, el) => {
    const end = pos + node.nodeSize;
    const cs = getComputedStyle(el);
    if (isOutOfFlow(cs)) {
      pulled.push({ end, heading: false });
      return true;
    }
    const scale = m.scale;
    // A continuation at the top of `next` re-joins the paragraph that ends this page: no margin.
    const rejoins = pulled.length === 0 && node.attrs.continuation === true;
    const marginTop = px(cs.marginTop) * scale;
    const gapBefore = rejoins ? 0 : Math.max(prevMarginBottom, marginTop);
    const { monolith, floats, waiting } = holdsMonolith(el, lineHeightOf(cs) * scale);
    if (waiting) return false; // its size isn't known yet: pull nothing from here on
    const height = heightOf(visibleRects(el)) + floats.reduce((sum, f) => sum + heightOf(visibleRects(f)), 0);
    const need = gapBefore + height;
    const accept = () => {
      pulled.push({ end, heading: node.type.name === 'heading' });
      prevMarginBottom = px(cs.marginBottom) * scale;
    };

    if (hasForcedBreakBefore(cs) && col < m.columns) {
      col += 1;
      freshColumn = false; // margins after a forced break stay
    }
    if (col >= m.columns) return false;

    if (isSpanner(cs)) {
      // Content above a spanner is balanced: the columns of the row shrink to about the
      // average used height, and the spanner goes below them.
      const used = free.reduce((sum, f) => sum + (rowHeight - f), 0);
      const balanced = used / m.columns;
      if (need > rowHeight - balanced + tol) return false;
      const left = rowHeight - balanced - need;
      free.fill(Math.max(0, left));
      col = 0;
      freshColumn = false;
      accept();
      prevMarginBottom = 0;
      return true;
    }

    if (node.type.name === 'columnBreak' || hasForcedBreakAfter(cs)) {
      // A forced break ends the column; worth pulling only if a column is left after it.
      if (col + 1 >= m.columns) return false;
      free[col] = 0;
      col += 1;
      freshColumn = false; // margins after a forced break stay
      accept();
      prevMarginBottom = 0;
      return true;
    }

    if (SPLITTABLE.has(node.type.name) && !monolith) {
      // Line by line (item by item), as the browser breaks it between columns (P8.1): a
      // continuous height would count the part of a column a line or an item doesn't fill.
      const units = equalColumns() ? flowUnits(view, node, pos, el, cs, scale) : null;
      if (units) {
        const flow = placeUnits(units.heights, rejoins ? 0 : gapBefore, node.type.name === 'paragraph' ? cs : null);
        if (flow.placed === units.heights.length) {
          for (let k = 0; k < free.length; k++) free[k] = flow.free[k]!;
          col = flow.col;
          freshColumn = flow.fresh;
          accept();
          return true;
        }
        if (units.ends) {
          // A list: up to the last item that fits (none: nothing from here on).
          if (flow.placed > 0) pulled.push({ end: units.ends[flow.placed - 1]!, heading: false });
          return false;
        }
        const lines = units.heights.length;
        let moved = Math.min(flow.placed, lines - lineCountOf(cs.widows));
        // The page ends in its last column like a column break: orphans there too.
        const inLast = moved - flow.first;
        if (flow.first > 0 && inLast > 0 && inLast < lineCountOf(cs.orphans)) moved = flow.first;
        if (moved >= (rejoins ? 1 : lineCountOf(cs.orphans))) {
          const at = lineStart(view, el, pos, node, moved, units.heights[0]!);
          if (at !== null) pulled.push({ end: at, heading: false });
          else accept();
        }
        return false;
      }
      // Whole, if it fits in the columns left (it flows from one column into the next) …
      if (flowInto(need)) {
        freshColumn = false;
        accept();
        return true;
      }
      // … or in part: the next measurement cuts it. Only when that moves something: for a
      // paragraph at least `orphans` lines (one for a continuation) while `widows` stay
      // behind, otherwise the browser would push them all back and the pull would only cost a
      // join and a split; for a list its first item, for a definition list its first group.
      if (node.type.name === 'paragraph') {
        const lh = lineHeightOf(cs) * scale;
        const lines = Math.max(1, Math.round(height / lh));
        let fit = 0;
        for (let k = col; k < m.columns; k++) fit += Math.floor(Math.max(0, free[k]! - (k === col ? gapBefore : 0) + tol) / lh);
        const moved = Math.min(fit, lines - lineCountOf(cs.widows));
        if (moved >= (rejoins ? 1 : lineCountOf(cs.orphans))) {
          // Exactly those lines, when the pages' columns have the same width (P8.1): line breaks
          // don't depend on the page then, so the start of the first line that stays is where
          // the page must end. A pull of the whole paragraph would move all of it, and the next
          // measurement would push the rest back: twice the work, all of it re-rendered.
          const at = sameColumnWidth(view, m, next) ? lineStart(view, el, pos, node, moved, lh) : null;
          if (at !== null) pulled.push({ end: at, heading: false });
          else accept();
        }
      } else {
        const unit = gapBefore + unitHeight(node, el, cs, scale);
        if (free.slice(col).some((f) => f >= unit - tol)) accept();
      }
      return false;
    }

    // Unsplittable (break-inside: avoid, or holding a float or tall image): needs a column with room for all of it.
    let c = col;
    while (c < m.columns && need > free[c]! + tol) c += 1;
    if (c >= m.columns) return false;
    free[c] = free[c]! - need;
    col = c;
    freshColumn = false;
    accept();
    return true;
  });

  // Keep-with-next: don't pull a heading unless the block after it comes too.
  const after = pageAt(view.state.doc, next.index + 1);
  const followed = after !== null && isAutoPage(after.node);
  while (pulled.length > 0 && (pulled.length < next.node.childCount || followed) && pulled[pulled.length - 1]!.heading) pulled.pop();
  return pulled.length > 0 ? pulled[pulled.length - 1]!.end : null;
}
