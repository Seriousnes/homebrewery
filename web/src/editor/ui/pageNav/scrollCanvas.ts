// Scrolling the editor canvas to a page or a block (P3.9).
//
// The canvas is scaled with transform: scale(zoom) inside a sizer (useCanvasZoom), so offsets
// inside it are in unscaled CSS px while the viewport scrolls in screen px. Bounding client rects
// include the transform, so the distance between the target's rect and the viewport's rect is the
// scroll delta at any zoom (upstream used scrollIntoView, which also scrolled the window).

export interface ScrollCanvasOptions {
  /** Space left above the target, in screen px (default 16). */
  margin?: number;
  behavior?: ScrollBehavior;
}

/** The scroll position that puts `target` at the top of `viewport` (and in view horizontally). */
export function canvasScrollTarget(viewport: Element, target: Element, margin = 16): { top: number; left: number } {
  const view = viewport.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const viewTop = view.top + viewport.clientTop;
  const viewLeft = view.left + viewport.clientLeft;
  const viewWidth = viewport.clientWidth;
  const top = viewport.scrollTop + (rect.top - viewTop) - margin;
  let left = viewport.scrollLeft;
  if (rect.left < viewLeft || rect.right > viewLeft + viewWidth) {
    // Centre it when it fits, else show its start.
    const offset = rect.width < viewWidth ? (viewWidth - rect.width) / 2 : margin;
    left = viewport.scrollLeft + (rect.left - viewLeft) - offset;
  }
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  return { top: clamp(top, 0, maxTop), left: clamp(left, 0, maxLeft) };
}

/** Scrolls `viewport` so `target` (a page, a heading) is at its top. */
export function scrollCanvasTo(viewport: Element, target: Element, { margin = 16, behavior = 'auto' }: ScrollCanvasOptions = {}): void {
  const { top, left } = canvasScrollTarget(viewport, target, margin);
  viewport.scrollTo({ top, left, behavior });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
