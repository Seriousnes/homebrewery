// What the editor chrome shows about pagination (P4.8): a "Laying out pages…" indicator for long
// passes, pages waiting for images, and the oversized pages (layout warnings).
//
// A store for useSyncExternalStore, fed by the editor's transactions while someone subscribes
// (creating it has no side effects). Pagination dispatches a transaction per step, so the
// snapshot only changes (and React only renders) when something shown changes: `busy` flips at
// most twice per pass, the warnings when the flags change.
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isPaginating, isPaginationPaused, paginationState } from '../../pagination';
import { oversizeWarnings, sameWarnings, type OversizeWarning } from '../oversize/oversize';

export interface LayoutStatusSnapshot {
  /** a pass has run longer than the delay: show "Laying out pages…" */
  busy: boolean;
  /** pages wait for an image's size (autosave waits too) */
  waiting: boolean;
  /** pages in the document */
  pages: number;
  /** oversized pages, in document order */
  oversized: readonly OversizeWarning[];
}

export interface LayoutStatusStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LayoutStatusSnapshot;
}

/** Default delay before a pass counts as long (ms): shorter passes show nothing. */
export const LAYOUT_BUSY_DELAY_MS = 400;

export const EMPTY_LAYOUT_STATUS: LayoutStatusSnapshot = { busy: false, waiting: false, pages: 0, oversized: [] };

export function createLayoutStatusStore(editor: Editor, opts: { delayMs?: number } = {}): LayoutStatusStore {
  const delayMs = opts.delayMs ?? LAYOUT_BUSY_DELAY_MS;
  const listeners = new Set<() => void>();
  let snapshot: LayoutStatusSnapshot = EMPTY_LAYOUT_STATUS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastDoc: PMNode | null = null;

  /** The snapshot for the editor's current state (`busy` as given); the same object when nothing changed. */
  const compute = (busy: boolean): LayoutStatusSnapshot => {
    if (editor.isDestroyed) return snapshot;
    const state = editor.state;
    const next: LayoutStatusSnapshot = {
      busy,
      waiting: (paginationState(state)?.waiting.length ?? 0) > 0,
      pages: state.doc.childCount,
      oversized: snapshot.oversized,
    };
    if (state.doc !== lastDoc) {
      lastDoc = state.doc;
      // Column counts from the page attributes: reading layout here would force it on every step.
      const found = oversizeWarnings(state);
      if (!sameWarnings(found, snapshot.oversized)) next.oversized = found;
    }
    const same = next.busy === snapshot.busy && next.waiting === snapshot.waiting && next.pages === snapshot.pages && next.oversized === snapshot.oversized;
    return same ? snapshot : next;
  };

  const emit = (next: LayoutStatusSnapshot) => {
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  // A pass that waits (IME composition, theme and fonts loading) lays nothing out: not busy
  // (review finding PGR-15; CJK input often composes for longer than the delay).
  const running = () => !editor.isDestroyed && isPaginating(editor.state) && !isPaginationPaused(editor.view);

  const update = () => {
    if (editor.isDestroyed) return;
    const now = running();
    if (now && timer === null && !snapshot.busy) {
      timer = setTimeout(() => {
        timer = null;
        if (running()) emit(compute(true));
      }, delayMs);
    }
    if (!now && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    emit(compute(now && snapshot.busy));
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        editor.on('transaction', update);
        update();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          editor.off('transaction', update);
          if (timer !== null) clearTimeout(timer);
          timer = null;
        }
      };
    },
    getSnapshot() {
      // Before anyone subscribes (the first render), read the state directly.
      if (listeners.size === 0) snapshot = compute(false);
      return snapshot;
    },
  };
}
