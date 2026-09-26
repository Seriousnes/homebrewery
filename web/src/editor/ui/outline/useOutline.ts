// The outline of an editor's document as React state. Rebuilt at most every `delayMs` while the
// document changes (typing, pagination), and only re-rendered when a label or entry changed.
import type { Editor } from '@tiptap/core';
import { useMemo, useSyncExternalStore } from 'react';
import { buildOutline, type OutlinePage, sameOutline } from './outlineModel';

export const OUTLINE_DELAY_MS = 150;

export interface OutlineStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly OutlinePage[];
}

/** An outline store for `editor`: listens to transactions only while subscribed. */
export function createOutlineStore(editor: Editor, delayMs = OUTLINE_DELAY_MS): OutlineStore {
  let snapshot: readonly OutlinePage[] | null = null;
  let builtFrom: unknown = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const build = (): readonly OutlinePage[] => {
    if (editor.isDestroyed) return snapshot ?? [];
    const doc = editor.state.doc;
    if (snapshot && builtFrom === doc) return snapshot;
    const next = buildOutline(doc);
    builtFrom = doc;
    snapshot = snapshot && sameOutline(snapshot, next) ? mergePositions(snapshot, next) : next;
    return snapshot;
  };

  const flush = () => {
    timer = undefined;
    const before = snapshot;
    build();
    if (snapshot !== before) for (const listener of Array.from(listeners)) listener();
  };

  const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
    if (!transaction.docChanged || timer !== undefined) return;
    timer = setTimeout(flush, delayMs);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        editor.on('transaction', onTransaction);
        // Changes made while nobody listened.
        if (snapshot && !editor.isDestroyed && builtFrom !== editor.state.doc && timer === undefined) timer = setTimeout(flush, 0);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          editor.off('transaction', onTransaction);
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => snapshot ?? build(),
  };
}

/**
 * Keeps the rendered outline object when only positions moved (typing inside a paragraph), but
 * with fresh positions for navigation: positions are mutated in place, which is safe because
 * nothing renders them.
 */
function mergePositions(current: readonly OutlinePage[], next: readonly OutlinePage[]): readonly OutlinePage[] {
  current.forEach((page, i) => {
    const fresh = next[i];
    if (!fresh) return;
    page.pos = fresh.pos;
    page.entries.forEach((entry, j) => {
      const e = fresh.entries[j];
      if (e) entry.pos = e.pos;
    });
  });
  return current;
}

const EMPTY: readonly OutlinePage[] = [];
const noop = () => () => {};

/** The outline of `editor`'s document (empty without an editor). */
export function useOutline(editor: Editor | null | undefined, delayMs = OUTLINE_DELAY_MS): readonly OutlinePage[] {
  const store = useMemo(() => (editor ? createOutlineStore(editor, delayMs) : null), [editor, delayMs]);
  return useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? (() => EMPTY), () => EMPTY);
}
