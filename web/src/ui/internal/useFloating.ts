import { type RefObject, useLayoutEffect } from 'react';
import { computePosition, type Placement, type RectLike } from './position';

/** An element, or a ref to one. */
export type ElementOrRef = HTMLElement | null | RefObject<HTMLElement | null>;

/** A position on screen to place against, instead of an element (e.g. a right-click's point). */
export interface VirtualAnchor {
  getBoundingClientRect(): RectLike;
}

/** An element, a ref to one, or a virtual anchor. */
export type AnchorTarget = ElementOrRef | VirtualAnchor;

function resolveAnchor(target: AnchorTarget | undefined): HTMLElement | VirtualAnchor | null {
  if (target && !(target instanceof HTMLElement) && !('current' in target)) return target;
  return resolveElement(target);
}

export function resolveElement(target: ElementOrRef | undefined): HTMLElement | null {
  if (!target) return null;
  return target instanceof HTMLElement ? target : target.current;
}

export interface FloatingOptions {
  placement?: Placement;
  offset?: number;
  padding?: number;
  /** Make the floating element at least as wide as the anchor. */
  matchAnchorWidth?: boolean;
}

/**
 * Keep a position: fixed element next to its anchor while `open`: placed before paint, then again
 * on resize, on scroll of any ancestor, and when either element changes size. Writes top, left,
 * max-height, max-width and data-placement directly on the element (no re-render).
 */
export function useFloating(
  open: boolean,
  anchor: AnchorTarget,
  floatingRef: RefObject<HTMLElement | null>,
  { placement = 'bottom-start', offset = 4, padding = 8, matchAnchorWidth = false }: FloatingOptions = {},
): void {
  useLayoutEffect(() => {
    const floating = floatingRef.current;
    const anchorEl = resolveAnchor(anchor);
    if (!open || !floating || !anchorEl) return;
    const win = floating.ownerDocument.defaultView ?? window;
    let frame = 0;

    const update = () => {
      frame = 0;
      if ((anchorEl instanceof HTMLElement && !anchorEl.isConnected) || !floating.isConnected) return;
      const rect = anchorEl.getBoundingClientRect();
      if (matchAnchorWidth) floating.style.minWidth = `${Math.round(rect.width)}px`;
      floating.style.maxHeight = '';
      floating.style.maxWidth = '';
      const view = floating.ownerDocument.documentElement;
      const result = computePosition({
        anchor: rect,
        floating: { width: floating.offsetWidth, height: floating.offsetHeight },
        viewport: { width: view.clientWidth || win.innerWidth, height: view.clientHeight || win.innerHeight },
        placement,
        offset,
        padding,
      });
      floating.style.top = `${result.top}px`;
      floating.style.left = `${result.left}px`;
      floating.style.maxHeight = `${result.maxHeight}px`;
      floating.style.maxWidth = `${result.maxWidth}px`;
      floating.dataset.placement = result.placement;
    };
    const schedule = (event?: Event) => {
      if (event?.type === 'scroll' && event.target instanceof Node && floating.contains(event.target)) return;
      if (!frame) frame = win.requestAnimationFrame(update);
    };

    update();
    win.addEventListener('resize', schedule);
    win.addEventListener('scroll', schedule, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    if (anchorEl instanceof HTMLElement) observer?.observe(anchorEl);
    observer?.observe(floating);
    return () => {
      if (frame) win.cancelAnimationFrame(frame);
      win.removeEventListener('resize', schedule);
      win.removeEventListener('scroll', schedule, true);
      observer?.disconnect();
    };
  }, [open, anchor, floatingRef, placement, offset, padding, matchAnchorWidth]);
}
