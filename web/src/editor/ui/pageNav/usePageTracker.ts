// React bindings for the page tracker: one tracker per canvas, shared by PageNav and the Outline.
import { useMemo, useSyncExternalStore } from 'react';
import type { EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import { createPageTracker, type PageTracker, type PageTrackingState } from './pageTracker';

/**
 * A page tracker for the canvas behind `handle` (from EditorCanvas onReady or its ref). It starts
 * observing when a component subscribes (usePageTracking, PageNav, Outline) and stops with the last.
 */
export function usePageTracker(handle: EditorCanvasHandle | null | undefined, options?: { margin?: number }): PageTracker | null {
  const margin = options?.margin;
  return useMemo(
    () =>
      handle
        ? createPageTracker({
            viewport: () => handle.viewport,
            root: () => (handle.editor.isDestroyed ? null : handle.editor.view.dom),
            ...(margin === undefined ? {} : { margin }),
          })
        : null,
    [handle, margin],
  );
}

const NO_PAGES: PageTrackingState = { current: 0, total: 0, visible: [], atStart: true, atEnd: true };
const noop = () => () => {};

/** The tracker's state (current page, total, visible pages); re-renders when it changes. */
export function usePageTracking(tracker: PageTracker | null | undefined): PageTrackingState {
  return useSyncExternalStore(tracker?.subscribe ?? noop, tracker?.getState ?? (() => NO_PAGES), () => NO_PAGES);
}
