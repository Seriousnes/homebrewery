// useAutosave (plan §9, P3.8): the React face of autosave.ts. It owns one controller per
// component, feeds it the editor and the latest getters, and wires the page events of the spec:
// Mod-S, visibilitychange → hidden and pagehide (keepalive save + draft), unmount (route
// change), online, beforeunload, and a changed signed-in user.
//
//   const autosave = useAutosave({
//     editor, editId, baseVersion: brew.version,
//     getStyle: () => style, getSnippets: () => snippets, getMeta: () => metaInput,
//     watch: [style, snippets, metaInput],     // style/meta edits are dirty too
//     baseline: brew,                          // offer "Restore unsaved changes"
//     onCreated: (b) => navigate(`/edit/${b.editId}`, { replace: true }),
//     onServerBrew: (b) => { setStyle(b.style); setMeta(b.meta) },
//     onRestore: (c) => { setStyle(c.style); … },
//   });
//   <SaveStatus autosave={autosave} /> <ConflictDialog autosave={autosave} /> <DraftRestoreBanner autosave={autosave} />
import { QueryClientContext } from '@tanstack/react-query';
import type { Editor } from '@tiptap/core';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createAutosave, type AutosaveController, type AutosaveOptions, type AutosaveState, type SaveOutcome } from './autosave';
import { CreateChainContext } from './createChain';
import { patchSavedBrew, seedCreatedBrew } from './cache';
import type { DraftStore } from './drafts';
import type { Snapshot, SnapshotHistory } from './snapshots';
import { defaultDraftStore, defaultSnapshotHistory } from './stores';

export interface UseAutosaveOptions extends Omit<AutosaveOptions, 'drafts' | 'snapshots'> {
  /** The editor (null until it is mounted). */
  editor: Editor | null;
  /** Default: the shared IndexedDB store; null turns drafts off. */
  drafts?: DraftStore | null;
  /** Default: the shared IndexedDB history; null turns local snapshots off. */
  snapshots?: SnapshotHistory | null;
  /**
   * Values behind getStyle / getSnippets / getMeta (like effect dependencies). When one changes,
   * autosave compares the brew's style, snippets and meta with what was last saved or loaded,
   * and a difference is a change. Without it, call markDirty() on such edits.
   */
  watch?: readonly unknown[];
  /**
   * The signed-in user (e.g. me?.id). A change retries a save that needed a sign-in; while it is
   * null, the page being shown again doesn't. Pass `signedOut` too when the page knows nobody is
   * signed in, so a new brew isn't sent at all. It is also the drafts' ownerId (unless `ownerId`
   * is given): /new shows a draft only to its owner (SAVE-12).
   */
  userKey?: string | null;
  /** Mod-S (Ctrl-S / Cmd-S) saves now, anywhere on the page. Default true. */
  shortcut?: boolean;
  /**
   * Ask before closing or reloading the page while changes can't be saved (conflict, offline,
   * error, lost, signed out; a save stuck for STALLED_SAVE_MS). Default true. In-app navigation:
   * <LeaveGuard autosave />.
   */
  warnOnUnload?: boolean;
}

export interface UseAutosaveResult extends AutosaveState {
  editor: Editor | null;
  saveNow: () => Promise<SaveOutcome>;
  markDirty: () => void;
  flush: (trigger?: 'hidden' | 'unmount') => void;
  retry: () => void;
  openConflict: () => void;
  closeConflict: () => void;
  loadSavedVersion: () => Promise<SaveOutcome>;
  overwriteWithMine: () => Promise<SaveOutcome>;
  saveAsCopy: () => Promise<SaveOutcome>;
  restoreDraft: () => boolean;
  discardDraft: () => Promise<void>;
  listSnapshots: () => Promise<Snapshot[]>;
  restoreSnapshot: (snapshot: Snapshot) => boolean;
  controller: AutosaveController;
}

const sameValues = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Ctrl-S / Cmd-S without other modifiers (the physical S key on non-Latin layouts). */
export function isSaveShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return false;
  const key = event.key.toLowerCase();
  return key === 's' || (!/^[a-z]$/.test(key) && event.code === 'KeyS');
}

export function useAutosave(options: UseAutosaveOptions): UseAutosaveResult {
  const queryClient = useContext(QueryClientContext);
  // The create chain of the 'new' draft /new loaded (SAVE-8); the controller reads it once.
  const loadedChain = useContext(CreateChainContext);
  const { editor, watch, userKey, shortcut = true, warnOnUnload = true, drafts, snapshots, ...rest } = options;

  const resolved: AutosaveOptions = {
    ...rest,
    ownerId: rest.ownerId ?? userKey ?? null,
    createChain: rest.createChain ?? loadedChain,
    drafts: drafts === undefined ? defaultDraftStore() : drafts,
    snapshots: snapshots === undefined ? defaultSnapshotHistory() : snapshots,
    onSaved: (response, body) => {
      const id = controller.getState().editId;
      if (queryClient && id) patchSavedBrew(queryClient, id, response, body);
      rest.onSaved?.(response, body);
    },
    onCreated: (brew, reason) => {
      if (queryClient) seedCreatedBrew(queryClient, brew);
      rest.onCreated?.(brew, reason);
    },
  };

  const [controller] = useState(() => createAutosave(resolved));
  // Every render: the getters and callbacks read the latest props (they run later, at save time).
  useLayoutEffect(() => {
    controller.update(resolved);
  });

  useEffect(() => {
    controller.attach(editor);
  }, [controller, editor]);

  useEffect(() => {
    controller.setSession(rest.editId, rest.baseVersion);
  }, [controller, rest.editId, rest.baseVersion]);

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  // Style / snippets / meta: compare when the watched values change, and re-read them after the
  // brew was replaced (externalEpoch), which sets the new baseline instead of marking dirty.
  const previous = useRef<{ watch: readonly unknown[]; epoch: number } | null>(null);
  useEffect(() => {
    const current = { watch: watch ?? [], epoch: state.externalEpoch };
    const before = previous.current;
    previous.current = current;
    if (!before) return;
    if (before.epoch !== current.epoch || !sameValues(before.watch, current.watch)) controller.externalChanged();
  });

  const previousUser = useRef(userKey);
  useEffect(() => {
    if (previousUser.current === userKey) return;
    previousUser.current = userKey;
    if (userKey && controller.getState().status === 'signedOut') controller.retry();
  }, [controller, userKey]);
  const currentUser = useRef(userKey);
  useLayoutEffect(() => {
    currentUser.current = userKey;
  });

  useEffect(() => {
    if (!shortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isSaveShortcut(event)) return;
      event.preventDefault();
      void controller.saveNow();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, shortcut]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        controller.flush('hidden');
        return;
      }
      // Back on the page: offline retries now; a save that needs a sign-in only once someone is
      // signed in (else it would resend the whole brew for another 401 each time, APP-9).
      const { status } = controller.getState();
      if (status === 'offline' || (status === 'signedOut' && currentUser.current)) controller.retry();
    };
    const onPageHide = () => controller.flush('hidden');
    const onOnline = () => controller.retry();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!warnOnUnload || !controller.shouldWarnOnUnload('page')) return;
      event.preventDefault();
      // Older browsers need returnValue set (the text itself is never shown).
      event.returnValue = '';
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('online', onOnline);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [controller, warnOnUnload]);

  return useMemo<UseAutosaveResult>(
    () => ({
      ...state,
      editor,
      saveNow: controller.saveNow,
      markDirty: controller.markDirty,
      flush: controller.flush,
      retry: controller.retry,
      openConflict: controller.openConflict,
      closeConflict: controller.closeConflict,
      loadSavedVersion: controller.loadSavedVersion,
      overwriteWithMine: controller.overwriteWithMine,
      saveAsCopy: controller.saveAsCopy,
      restoreDraft: controller.restoreDraft,
      discardDraft: controller.discardDraft,
      listSnapshots: controller.listSnapshots,
      restoreSnapshot: controller.restoreSnapshot,
      controller,
    }),
    [state, editor, controller],
  );
}
