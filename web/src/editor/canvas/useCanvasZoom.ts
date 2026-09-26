// Zoom for the canvas (plan §5): transform: scale(z) on .hb-canvas, never CSS zoom (it distorts
// caret coordinates, brewRenderer.jsx:309). A transform doesn't change layout size, so an outer
// sizer gets the scaled size and gives the scroll container the right scroll range:
//
//   div.viewport (scrolls)
//     div.sizer            width = W·z, height = H·z        (set here)
//       div.hb-canvas      width = W, transform: scale(z)    (absolutely positioned, origin 0 0)
//
// W = max(viewport width / z, the width the spread needs), so pages stay centred when they
// fit and the viewport scrolls horizontally when they don't. H is the canvas's layout height,
// tracked with a ResizeObserver (pages come and go while pagination runs).
//
// Pagination compares rects in one coordinate space, so the scale doesn't change page
// boundaries. Styles are written directly (no React state), in the same frame as the resize.
import { useLayoutEffect, useRef, type RefObject } from 'react';

export type CanvasSpread = 'single' | 'facing' | 'flow';

/** Page width (layout px) when there are no pages yet: 215.9mm. */
const DEFAULT_PAGE_WIDTH = 816;
/** Horizontal room kept around the pages (layout px, before scaling). */
const SIDE_GUTTER = 40;
/** Gap between facing pages (EditorCanvas.module.css). */
const SPREAD_GAP = 10;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const clampZoom = (z: number): number => (Number.isFinite(z) && z > 0 ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) : 1);

/** Layout width (unscaled) the canvas needs for its spread. */
export function spreadMinWidth(spread: CanvasSpread, pageWidth: number, gap = SPREAD_GAP): number {
  const pages = spread === 'facing' ? 2 : 1;
  return pages * pageWidth + (pages - 1) * gap + 2 * SIDE_GUTTER;
}

function measurePageWidth(canvas: HTMLElement): number {
  const page = canvas.querySelector<HTMLElement>('.page');
  return page?.offsetWidth || DEFAULT_PAGE_WIDTH;
}

export interface CanvasZoomRefs {
  viewportRef: RefObject<HTMLDivElement | null>;
  sizerRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
}

/** Returns the refs to attach to the viewport, the sizer and .hb-canvas. */
export function useCanvasZoom(zoom: number, spread: CanvasSpread, onApplied?: (zoom: number) => void): CanvasZoomRefs {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const previousZoom = useRef<number | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const sizer = sizerRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !sizer || !canvas) return;
    const z = clampZoom(zoom);

    // Keep the point at the viewport's centre in place when the zoom changes. The pages are
    // centred in a canvas whose width W depends on the zoom, so x is kept relative to the first
    // page (its left edge in layout px moves when W changes); y needs no correction.
    const before = previousZoom.current;
    const pageLeft = (scale: number): number => {
      const page = canvas.querySelector<HTMLElement>('.page');
      return page ? (page.getBoundingClientRect().left - canvas.getBoundingClientRect().left) / scale : 0;
    };
    const anchor =
      before !== null && before !== z
        ? {
            x: (viewport.scrollLeft + viewport.clientWidth / 2) / before - pageLeft(before),
            y: (viewport.scrollTop + viewport.clientHeight / 2) / before,
          }
        : null;

    const apply = () => {
      // An even number of pixels: centred pages start on a whole pixel at 100% (text on half
      // pixels renders blurred in Chromium).
      const width = 2 * Math.floor(Math.max(viewport.clientWidth / z, spreadMinWidth(spread, measurePageWidth(canvas))) / 2);
      const w = `${width}px`;
      if (canvas.style.width !== w) canvas.style.width = w;
      const transform = z === 1 ? '' : `scale(${z})`;
      if (canvas.style.transform !== transform) canvas.style.transform = transform;
      const sw = `${Math.ceil(width * z)}px`;
      const sh = `${Math.ceil(canvas.offsetHeight * z)}px`;
      if (sizer.style.width !== sw) sizer.style.width = sw;
      if (sizer.style.height !== sh) sizer.style.height = sh;
    };

    apply();
    if (anchor) {
      viewport.scrollLeft = (anchor.x + pageLeft(z)) * z - viewport.clientWidth / 2;
      viewport.scrollTop = anchor.y * z - viewport.clientHeight / 2;
    }
    previousZoom.current = z;
    onApplied?.(z);

    if (typeof ResizeObserver === 'undefined') return;
    // Applied in the next frame, not inside the observer callback: resizing the sizer can toggle
    // the viewport's horizontal scrollbar, which would resize an observed element during the
    // callback ("ResizeObserver loop completed with undelivered notifications").
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          apply();
        });
      }
    });
    observer.observe(viewport);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [zoom, spread, onApplied]);

  return { viewportRef, sizerRef, canvasRef };
}
