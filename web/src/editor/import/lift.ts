// Page-level pieces of upstream HTML that become page attributes (plan §7 "Lift out the
// page-level pieces", parse rules table):
//
//   empty span.inline-block.<marker>               → data-markers   (page.markers)
//   top-level span.inline-block.footnote            → data-footer    (page.footer)
//   top-level empty span.inline-block.pageNumber.auto → data-page-number (page.pageNumber)
//   absolutely positioned element whose containing block is the page
//                                                   → data-objects   (page.objects)
//
// Two phases per page, because lifting changes computed styles (e.g. removing the frontCover
// marker turns `.page:has(.frontCover) .banner { position: absolute }` off):
//   analyzePage()  reads the laid-out probe (computed styles) and decides,
//   applyLift()    then moves the pieces into data-* attributes and removes them from the flow.
//
// Page objects can only be an image or a plain-text span (PageObject in schema/nodes/page.ts).
// Positioned elements with richer content (an .artist block with a heading and a link, a
// .logo span around an image, an image mask) stay in the flow: their containing block is still
// the page in the editor, so they render in the same place. They are listed in the report.
// A positioned *inline* element that is alone on its line (upstream's bare top-level span, e.g.
// `{{logo ![](…)}}`) becomes a rawHtml block: as a paragraph it would keep an empty line in the
// flow (ProseMirror's trailing break) where upstream had none.
import { PAGE_MARKERS, RESERVED_CLASSES, stripHbSrc, type PageObject } from '../schema';
import { RAW_HTML_WRAPPER_ATTR } from '../schema/html';

const MARKERS: ReadonlySet<string> = new Set(PAGE_MARKERS);

/** Inline tags a text object may contain; anything else makes the element "rich". */
const TEXT_ONLY_TAGS = new Set(['SPAN', 'STRONG', 'B', 'EM', 'U', 'S', 'DEL', 'STRIKE', 'SUB', 'SUP', 'BR', 'SMALL', 'BIG', 'FONT', 'MARK', 'P', 'CODE', 'A']);

export interface PositionedInFlow {
  tag: string;
  classes: string[];
  reason: string;
}

export interface PageAnalysis {
  markers: Array<{ el: HTMLElement; names: string[]; lost: string[] }>;
  footer: { el: HTMLElement; text: string; lost: string[] } | null;
  pageNumber: HTMLElement | null;
  objects: Array<{ el: HTMLElement; object: PageObject; lost: string[] }>;
  positionedInFlow: PositionedInFlow[];
  /** Positioned inline elements alone on their line: kept as rawHtml blocks (see the header). */
  rawBlocks: HTMLElement[];
  /** Upstream clipped content on this page (it didn't fit), with the estimated page count. */
  clipped: { estimatedPages: number } | null;
}

export interface LiftCounts {
  markers: number;
  footers: number;
  pageNumbers: number;
  objects: number;
  /** Positioned inline elements turned into rawHtml blocks. */
  rawBlocks: number;
  /** What the page model can't keep (extra classes on markers, footer formatting, …). */
  lost: string[];
}

/** Whether `holder`'s only content is `el` (whitespace and <br> aside). */
function holdsOnly(holder: Element, el: Element): boolean {
  return Array.from(holder.childNodes).every(
    (n) => n === el || (n.nodeType === 3 && (n.textContent ?? '').trim() === '') || (n.nodeType === 1 && (n as Element).tagName === 'BR'),
  );
}

/** A positioned inline element alone on its line at the top of the flow (bare, or alone in a <p>). */
function isAloneInline(el: HTMLElement, wrapper: HTMLElement): boolean {
  if (el.tagName !== 'SPAN') return false;
  const parent = el.parentElement;
  if (parent === wrapper) return true;
  return !!parent && parent.tagName === 'P' && parent.parentElement === wrapper && holdsOnly(parent, el);
}

function authorClasses(el: Element): string[] {
  return Array.from(el.classList).filter((c) => !RESERVED_CLASSES.has(c));
}

/** Upstream renders a {{span}} as span.inline-block; "empty" = no elements and only whitespace. */
function isEmptySpan(el: Element): boolean {
  return el.children.length === 0 && (el.textContent ?? '').trim() === '';
}

/** The element's inline style, normalized like the schema stores it (cssText). */
function normalizedStyle(el: HTMLElement, image: boolean): string {
  if (!el.hasAttribute('style')) return '';
  const css = el.style?.cssText ?? el.getAttribute('style') ?? '';
  return (image ? stripHbSrc(css) : css.trim()) ?? '';
}

/** Text of a text object: textContent with <br> as newlines, whitespace runs collapsed. */
function objectText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const br of Array.from(clone.querySelectorAll('br'))) br.replaceWith('\n');
  return (clone.textContent ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f]+/g, ' ').trim())
    .join('\n')
    .trim();
}

function isTextOnly(el: HTMLElement): boolean {
  for (const d of Array.from(el.querySelectorAll('*'))) {
    if (!TEXT_ONLY_TAGS.has(d.tagName)) return false;
    if (d.tagName === 'SPAN' && d.classList.contains('inline-block') && isEmptySpan(d)) return false; // icon boxes
  }
  return true;
}

/**
 * The element that is `el`'s containing block, or null for the viewport (fixed without a
 * transformed ancestor). Only for absolutely/fixed positioned elements.
 */
export function containingBlock(el: Element, win: Window): Element | null {
  const position = win.getComputedStyle(el).position;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const s = win.getComputedStyle(a);
    if (position === 'absolute' && s.position !== 'static' && s.position !== '') return a;
    if ((s.transform && s.transform !== 'none') || (s.perspective && s.perspective !== 'none') || (s.filter && s.filter !== 'none')) return a;
    if (/\b(?:paint|layout|strict|content)\b/.test(s.contain ?? '')) return a;
    if (/\b(?:transform|perspective|filter)\b/.test(s.willChange ?? '')) return a;
    const extra = s as CSSStyleDeclaration & { containerType?: string; backdropFilter?: string };
    if (extra.containerType && extra.containerType !== 'normal') return a;
    if (extra.backdropFilter && extra.backdropFilter !== 'none') return a;
  }
  return null;
}

/** Border boxes of the flow's top-level in-flow content: element fragments and bare text. */
function flowRects(wrapper: HTMLElement, win: Window): DOMRect[] {
  const rects: DOMRect[] = [];
  for (const node of Array.from(wrapper.childNodes)) {
    if (node.nodeType === 1) {
      const cs = win.getComputedStyle(node as Element);
      if (cs.position === 'absolute' || cs.position === 'fixed' || cs.display === 'none') continue;
      rects.push(...Array.from((node as Element).getClientRects()));
    } else if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') {
      // Upstream's paragraph renderer leaves some inline content outside any <p>.
      const range = wrapper.ownerDocument.createRange();
      range.selectNodeContents(node);
      rects.push(...Array.from(range.getClientRects()));
    }
  }
  return rects.filter((r) => r.width > 0 || r.height > 0);
}

/**
 * Upstream clipping (plan §4.2, §4.3): the page's flow didn't fit its content box, and
 * `.page { overflow: clip }` cut the rest off. Only in-flow content counts (not absolutely
 * positioned decorations such as a .classTable.decoration frame):
 *   - fragments starting at or beyond the content box's right edge form overflow columns;
 *   - monolithic content (a `.wide` block spans all columns, images) can overflow the bottom.
 * Returns the estimated number of pages the content needs, or null when it fits.
 */
export function measureClipping(wrapper: HTMLElement, win: Window): { estimatedPages: number } | null {
  const box = wrapper.getBoundingClientRect();
  const s = win.getComputedStyle(wrapper);
  const px = (v: string) => parseFloat(v) || 0;
  const left = box.left + px(s.paddingLeft) + px(s.borderLeftWidth);
  const right = box.right - px(s.paddingRight) - px(s.borderRightWidth);
  const top = box.top + px(s.paddingTop) + px(s.borderTopWidth);
  const bottom = box.bottom - px(s.paddingBottom) - px(s.borderBottomWidth);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  const EPS = 1;
  let maxRight = right;
  let maxBottom = bottom;
  for (const rect of flowRects(wrapper, win)) {
    if (rect.left >= right - EPS) maxRight = Math.max(maxRight, rect.right);
    else if (rect.bottom > bottom + EPS) maxBottom = Math.max(maxBottom, rect.bottom);
  }
  if (maxRight <= right && maxBottom <= bottom) return null;
  const gap = px(s.columnGap);
  const count = Math.max(1, parseInt(s.columnCount, 10) || 1);
  const columnWidth = (width - gap * (count - 1)) / count;
  const columns = maxRight > right ? Math.ceil((maxRight - left + gap) / (columnWidth + gap) - 0.01) : count;
  const overflowPages = Math.ceil(columns / count) - 1; // pages of overflow columns
  const tallPages = maxBottom > bottom ? Math.ceil((maxBottom - top) / height - 0.01) - 1 : 0; // monolithic overflow
  return { estimatedPages: Math.max(2, 1 + overflowPages + tallPages) };
}

/** Reads one laid-out page (no changes). `pageIndex` numbers object ids. */
export function analyzePage(pageEl: HTMLElement, win: Window, pageIndex: number): PageAnalysis {
  const result: PageAnalysis = { markers: [], footer: null, pageNumber: null, objects: [], positionedInFlow: [], rawBlocks: [], clipped: null };
  const wrapper = pageEl.querySelector<HTMLElement>(':scope > .columnWrapper');
  if (!wrapper) return result;
  result.clipped = measureClipping(wrapper, win);

  const taken = new Set<Element>();

  // Markers: empty span.inline-block carrying a marker class, anywhere in the flow.
  for (const el of Array.from(wrapper.querySelectorAll<HTMLElement>('span.inline-block'))) {
    const names = authorClasses(el).filter((c) => MARKERS.has(c));
    if (!names.length || !isEmptySpan(el)) continue;
    const lost: string[] = [];
    const others = authorClasses(el).filter((c) => !MARKERS.has(c));
    if (others.length) lost.push(`marker ${names.join(' ')}: classes ${others.join(' ')} dropped`);
    if (el.getAttribute('style')) lost.push(`marker ${names.join(' ')}: style "${el.getAttribute('style')}" dropped`);
    if (el.id) lost.push(`marker ${names.join(' ')}: id "${el.id}" dropped`);
    result.markers.push({ el, names, lost });
    taken.add(el);
  }

  // Footer and page number: top-level spans. Upstream renders a {{span}} that ends a paragraph
  // outside the <p>; the lines before it stay in a <p> ("{{pageNumber,auto}}\n{{footnote …}}"
  // gives <p><span pageNumber/></p><span footnote/>), so spans in a top-level <p> that holds
  // nothing but spans count too.
  const topLevel: HTMLElement[] = [];
  for (const child of Array.from(wrapper.children) as HTMLElement[]) {
    if (child.tagName === 'P' && child.attributes.length === 0 && child.children.length > 0) {
      const spans = Array.from(child.children) as HTMLElement[];
      const onlySpans = spans.every((s) => s.tagName === 'SPAN' && s.classList.contains('inline-block'));
      const ownText = Array.from(child.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
      if (onlySpans && !ownText) topLevel.push(...spans);
    } else topLevel.push(child);
  }
  for (const el of topLevel) {
    if (el.tagName !== 'SPAN' || !el.classList.contains('inline-block') || taken.has(el)) continue;
    if (!result.footer && el.classList.contains('footnote') && !isEmptySpan(el)) {
      const lost: string[] = [];
      const others = authorClasses(el).filter((c) => c !== 'footnote');
      if (others.length) lost.push(`footer: classes ${others.join(' ')} dropped`);
      if (el.getAttribute('style')) lost.push(`footer: style "${el.getAttribute('style')}" dropped`);
      if (el.querySelector('*:not(br)')) lost.push('footer: formatting dropped (text kept)');
      result.footer = { el, text: objectText(el), lost };
      taken.add(el);
    } else if (!result.pageNumber && el.classList.contains('pageNumber') && el.classList.contains('auto') && isEmptySpan(el)) {
      result.pageNumber = el;
      taken.add(el);
    }
  }

  // Page objects: absolutely positioned, containing block = the page. Outermost only.
  let n = 0;
  for (const el of Array.from(wrapper.querySelectorAll<HTMLElement>('*'))) {
    if (taken.has(el)) continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    let inside = false;
    for (const t of taken) {
      if (t !== el && t.contains(el)) {
        inside = true;
        break;
      }
    }
    if (inside) continue;
    const style = win.getComputedStyle(el);
    if (style.position !== 'absolute' && style.position !== 'fixed') continue;
    if (style.display === 'none') continue;
    if (containingBlock(el, win) !== pageEl) continue;

    const classes = authorClasses(el);
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      const lost: string[] = [];
      if (el.getAttribute('alt')) lost.push(`image object: alt text "${el.getAttribute('alt')}" dropped`);
      if (el.id) lost.push(`image object: id "${el.id}" dropped`);
      result.objects.push({ el, object: { id: `o${pageIndex + 1}-${++n}`, kind: 'image', classes, style: normalizedStyle(el, true), src }, lost });
      taken.add(el);
    } else if (!el.querySelector('img, svg, i, table, ul, ol, dl, h1, h2, h3, h4, h5, h6, div, blockquote, pre, hr') && isTextOnly(el)) {
      const lost: string[] = [];
      if (el.querySelector('*:not(br)')) lost.push(`text object .${classes.join('.')}: formatting dropped (text kept)`);
      if (el.tagName !== 'SPAN') lost.push(`text object .${classes.join('.')}: <${el.tagName.toLowerCase()}> becomes span.inline-block`);
      if (el.id) lost.push(`text object .${classes.join('.')}: id "${el.id}" dropped`);
      result.objects.push({ el, object: { id: `o${pageIndex + 1}-${++n}`, kind: 'text', classes, style: normalizedStyle(el, false), text: objectText(el) }, lost });
      taken.add(el);
    } else if (isAloneInline(el, wrapper)) {
      result.positionedInFlow.push({ tag: el.tagName.toLowerCase(), classes, reason: 'positioned inline element with rich content kept as a rawHtml block (renders in place)' });
      result.rawBlocks.push(el);
      taken.add(el);
    } else {
      result.positionedInFlow.push({ tag: el.tagName.toLowerCase(), classes, reason: 'positioned element with rich content (images, blocks or icons) stays in the flow' });
      taken.add(el); // don't look inside it again
    }
  }
  return result;
}

/** Removes `el`, then any ancestor up to `stop` that is left empty and carries nothing. */
function removeAndPrune(el: Element, stop: Element): void {
  let parent = el.parentElement;
  el.remove();
  while (parent && parent !== stop) {
    const next = parent.parentElement;
    const empty = parent.children.length === 0 && (parent.textContent ?? '').trim() === '';
    const plain = parent.attributes.length === 0 && (parent.tagName === 'P' || parent.tagName === 'SPAN');
    if (!empty || !plain) break;
    parent.remove();
    parent = next;
  }
}

/** Applies an analysis: writes the data-* attributes on the page and removes the pieces. */
export function applyLift(pageEl: HTMLElement, analysis: PageAnalysis): LiftCounts {
  const wrapper = pageEl.querySelector<HTMLElement>(':scope > .columnWrapper') ?? pageEl;
  const counts: LiftCounts = { markers: 0, footers: 0, pageNumbers: 0, objects: 0, rawBlocks: 0, lost: [] };

  const markers: string[] = [];
  for (const m of analysis.markers) {
    for (const name of m.names) if (!markers.includes(name)) markers.push(name);
    counts.lost.push(...m.lost);
    removeAndPrune(m.el, wrapper);
    counts.markers++;
  }
  if (markers.length) pageEl.setAttribute('data-markers', JSON.stringify(markers));

  if (analysis.footer) {
    pageEl.setAttribute('data-footer', analysis.footer.text);
    counts.lost.push(...analysis.footer.lost);
    removeAndPrune(analysis.footer.el, wrapper);
    counts.footers++;
  }
  if (analysis.pageNumber) {
    pageEl.setAttribute('data-page-number', '');
    removeAndPrune(analysis.pageNumber, wrapper);
    counts.pageNumbers++;
  }
  if (analysis.objects.length) {
    pageEl.setAttribute('data-objects', JSON.stringify(analysis.objects.map((o) => o.object)));
    for (const o of analysis.objects) {
      counts.lost.push(...o.lost);
      removeAndPrune(o.el, wrapper);
      counts.objects++;
    }
  }
  for (const el of analysis.rawBlocks) {
    if (!el.isConnected || !isAloneInline(el, wrapper)) continue;
    // The schema's rawHtml rule takes div[data-hb-raw] and keeps its inner HTML (the span).
    const holder = el.parentElement !== wrapper ? el.parentElement! : el;
    const block = el.ownerDocument.createElement('div');
    block.setAttribute(RAW_HTML_WRAPPER_ATTR, '');
    holder.replaceWith(block);
    block.appendChild(el);
    counts.rawBlocks++;
  }
  return counts;
}
