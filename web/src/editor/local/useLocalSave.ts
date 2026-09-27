// Saving a local brew (issue #4): EditorApp's 'local' saving mode. Every author's change (dirty.ts:
// not pagination or id bookkeeping), and every style, snippet or metadata edit, is written to the
// local brew library 1 s after the last one, on Mod-S, when the page is hidden or closed, and when
// the editor goes away. A new brew (no id yet) is stored on its first change; onCreated then gets
// its id (the page moves to /local/:localId). Pagination is finished before each write, so the
// stored pages are the ones the editor shows (the PDF of a listed brew is made from them).
import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { useCallback, useEffect, useRef, useState } from 'react';
import { settleNow } from '../pagination';
import { isDirtyDispatch } from '../save/dirty';
import { DOC_SCHEMA_VERSION } from '../schema/version';
import {
  defaultLocalBrews,
  LOCAL_BREW_FORMAT,
  type LocalBrewLibrary,
  type LocalBrewMeta,
  newLocalBrewId,
  requestPersistentStorage,
} from './localBrews';

export const LOCAL_SAVE_DELAY_MS = 1000;

/** 'idle': nothing to save yet (a new brew nobody has typed in); 'dirty': a write is scheduled. */
export type LocalSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface LocalSaveState {
  status: LocalSaveStatus;
  /** The brew's id (null until a new brew's first write). */
  localId: string | null;
  lastSavedAt: number | null;
  error: unknown;
  /** false when this browser keeps the brews only as long as the page (site data blocked). */
  persistent: boolean;
}

export interface LocalSaveContent {
  style: string;
  snippets: unknown;
  meta: LocalBrewMeta;
}

export interface UseLocalSaveOptions {
  editor: Editor | null;
  /** false: nothing is written (another saving mode, or the brew was deleted). */
  enabled: boolean;
  /** The stored brew (null for a new one: its first change stores it). */
  localId: string | null;
  /** The stored brew's creation time and import text (kept on every write). */
  createdAt?: number | null;
  sourceMarkdown?: string | null;
  /** When the stored brew was last written (the status shows it). */
  lastSavedAt?: number | null;
  /** The latest style, snippets and metadata. */
  getContent: () => LocalSaveContent;
  /** Values behind getContent: a change is an edit (like effect dependencies). */
  watch: readonly unknown[];
  /** A new brew was stored under `id`. */
  onCreated?: (id: string) => void;
  library?: LocalBrewLibrary;
  delayMs?: number;
}

export interface UseLocalSaveResult extends LocalSaveState {
  /** Writes now if anything changed; resolves false when the write failed. */
  saveNow: () => Promise<boolean>;
  /** No more writes (the brew is being uploaded, or is gone): pending changes are dropped. */
  stop: () => void;
  /** Writes again after stop() (an upload failed). */
  resume: () => void;
}

export function useLocalSave({
  editor,
  enabled,
  localId,
  createdAt = null,
  sourceMarkdown = null,
  lastSavedAt = null,
  getContent,
  watch,
  onCreated,
  library = defaultLocalBrews(),
  delayMs = LOCAL_SAVE_DELAY_MS,
}: UseLocalSaveOptions): UseLocalSaveResult {
  const [state, setState] = useState<LocalSaveState>(() => ({
    status: localId ? 'saved' : 'idle',
    localId,
    lastSavedAt,
    error: null,
    persistent: library.persistent(),
  }));

  // The latest options and bookkeeping, for timers and event handlers.
  const latest = useRef({ editor, enabled, getContent, onCreated, library, delayMs, sourceMarkdown });
  useEffect(() => {
    latest.current = { editor, enabled, getContent, onCreated, library, delayMs, sourceMarkdown };
  });
  const id = useRef(localId);
  // Set on the first write of a new brew.
  const created = useRef<number | null>(createdAt);
  const dirty = useRef(false);
  const writing = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const stopped = useRef(false);
  // The editor's latest state: a write while the page goes away may find the editor destroyed.
  const lastState = useRef<EditorState | null>(null);

  const update = useCallback((patch: Partial<LocalSaveState>) => {
    if (mounted.current) setState((s) => ({ ...s, ...patch }));
  }, []);

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const write = useCallback(async (): Promise<boolean> => {
    // One write at a time; a change during a write is written after it.
    if (writing.current) {
      await writing.current;
      if (!dirty.current) return true;
    }
    const { editor: ed, enabled: on, getContent: content, library: lib, onCreated: created$, sourceMarkdown: source } = latest.current;
    const live = ed !== null && !ed.isDestroyed;
    if (!on || stopped.current || !dirty.current || (!live && !lastState.current)) return true;
    clearTimer();
    dirty.current = false;
    const run = (async () => {
      update({ status: 'saving' });
      try {
        // Finish pagination: the stored pages are what the editor shows (typing may have left a
        // pass unfinished; this is what print and export do too).
        let doc: JSONContent;
        if (live) {
          try {
            settleNow(ed.view);
          } catch {
            // A detached view: store what is there.
          }
          doc = ed.getJSON();
        } else {
          doc = lastState.current!.doc.toJSON() as JSONContent;
        }
        const isNew = id.current === null;
        const brewId = id.current ?? newLocalBrewId();
        const now = Date.now();
        created.current ??= now;
        await lib.save({
          v: LOCAL_BREW_FORMAT,
          id: brewId,
          createdAt: created.current,
          updatedAt: now,
          docSchemaVersion: DOC_SCHEMA_VERSION,
          doc,
          ...content(),
          ...(source ? { sourceMarkdown: source } : {}),
        });
        id.current = brewId;
        update({ status: dirty.current ? 'dirty' : 'saved', localId: brewId, lastSavedAt: now, error: null, persistent: lib.persistent() });
        if (isNew) {
          void requestPersistentStorage();
          created$?.(brewId);
        }
        return true;
      } catch (error) {
        dirty.current = true;
        update({ status: 'error', error });
        return false;
      }
    })();
    writing.current = run;
    try {
      return await run;
    } finally {
      if (writing.current === run) writing.current = null;
      // Typed during the write: schedule the next one.
      if (dirty.current && latest.current.enabled && timer.current === null && mounted.current) {
        timer.current = setTimeout(() => void write(), latest.current.delayMs);
      }
    }
  }, [update]);

  const markDirty = useCallback(() => {
    if (!latest.current.enabled || stopped.current) return;
    dirty.current = true;
    update({ status: 'dirty' });
    clearTimer();
    timer.current = setTimeout(() => void write(), latest.current.delayMs);
  }, [update, write]);

  // Author's changes to the document.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    lastState.current = editor.state;
    const onTransaction = ({ editor: source, transaction, appendedTransactions }: { editor: Editor; transaction: Transaction; appendedTransactions: Transaction[] }) => {
      lastState.current = source.state;
      if (isDirtyDispatch(transaction, appendedTransactions)) markDirty();
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor, markDirty]);

  // Style, snippets and metadata edits: a change of a watched value after the first render.
  const watched = useRef<string | null>(null);
  const watchKey = JSON.stringify(watch);
  useEffect(() => {
    if (watched.current !== null && watched.current !== watchKey) markDirty();
    watched.current = watchKey;
  }, [watchKey, markDirty]);

  // Hidden or closed page: write at once (IndexedDB finishes the transaction after pagehide).
  useEffect(() => {
    const flush = () => {
      if (dirty.current) void write();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [write]);

  // Leaving the page (route change): write what is pending.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      if (dirty.current) void write();
    };
  }, [write]);

  const saveNow = useCallback(async () => {
    if (!dirty.current) return writing.current ? writing.current : true;
    return write();
  }, [write]);

  const stop = useCallback(() => {
    stopped.current = true;
    dirty.current = false;
    clearTimer();
  }, []);
  const resume = useCallback(() => {
    stopped.current = false;
  }, []);

  return { ...state, saveNow, stop, resume };
}
