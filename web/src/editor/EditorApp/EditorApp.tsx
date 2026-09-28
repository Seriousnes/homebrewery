// EditorApp (plan §5, §6, §9; P3 integration, P7.1, P7.2): the composed editor of the app pages.
//
//   chrome (UiRoot)   EditorToolbar (keymap actions, Insert menu + block/table/icon menus, zoom,
//                     save status) · EditorAppBar (panels, page navigation, layout warnings,
//                     print, properties, local history) · lock banner · draft banner · page banners
//   SplitPanel        OutlinePanel · StylePanel | EditorCanvas | InspectorPanel
//   dialogs           MetadataDialog · ConflictDialog · LocalHistoryDialog
//   navbar            brew title · Share / Edit items (NavbarPortal)
//
// Modes: 'edit' (editable) or 'view' (read-only, pagination still on: the share page). Saving:
// 'server' runs autosave (drafts, snapshots, 409 dialog; a brew without editId is created by its
// first save), 'local' writes the brew to this browser's local brew library (issue #4: no account
// needed; a new one is stored by its first change; signed in, it can be uploaded), or 'none'
// (home, share: nothing is saved or written to IndexedDB).
//
// The editor owns the document: `content` is read once. Everything else the brew holds (style,
// snippets, metadata) lives here and goes to autosave through its getters. Mount a new EditorApp
// (a new React key) to show another brew.
import { useQueryClient } from '@tanstack/react-query';
import type { Editor, JSONContent } from '@tiptap/core';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type BrewAuthorInfo,
  type BrewForEdit,
  type BrewLockInfo,
  type BrewMetaInput,
  type DeleteBrewResponse,
  normalizeHandle,
  queryKeys,
  type SaveBrewRequest,
  type SaveBrewResponse,
  useMe,
} from '@/api';
import { NavbarPortal } from '@/app/NavbarPortal';
import { removeRecentBrew, useRecordRecentBrew } from '@/app/recentBrews';
import { registerBeforeSignOut } from '@/app/signOutHooks';
import { type PanelId, useUiStore } from '@/app/uiStore';
import { usePageTitle } from '@/app/usePageTitle';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { registerActiveLocalEditor } from '@/editor/local/activeEditors';
import { localMeta } from '@/editor/local/localBrews';
import { LocalSaveStatus } from '@/editor/local/LocalSaveStatus';
import { useLocalSave } from '@/editor/local/useLocalSave';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import { DownloadPdfButton } from '@/editor/export/DownloadPdfButton';
import type { ThemeSnippetRef } from '@/editor/canvas/themeLoader';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { settleNow } from '@/editor/pagination';
import {
  type AutosaveController,
  type AutosaveState,
  type BrewBaseline,
  type BrewContent,
  ConflictDialog,
  defaultDraftStore,
  defaultSnapshotHistory,
  DraftRestoreBanner,
  LeaveGuard,
  LocalHistoryDialog,
  readDraftsFor,
  SaveStatus,
  useAutosave,
} from '@/editor/save';
import { SnippetGeneratorError, generateStyleSnippet, groupsForView, insertStyleSnippet, useSnippetGroups } from '@/editor/snippets';
import { BlockMenu } from '@/editor/ui/blockMenu/BlockMenu';
import { IconPickerButton } from '@/editor/ui/iconPicker/IconPicker';
import { InsertMenu, SnippetPicker } from '@/editor/ui/insertMenu';
import { InspectorPanel } from '@/editor/ui/inspector';
import { MetadataDialog } from '@/editor/ui/metadata/MetadataDialog';
import { OutlinePanel } from '@/editor/ui/outline/OutlinePanel';
import { usePageTracker } from '@/editor/ui/pageNav/usePageTracker';
import { SnippetsPanel, SnippetsToggle, useSnippetsEditor } from '@/editor/ui/snippetsEditor';
import { StylePanel } from '@/editor/ui/styleDrawer';
import { TableMenu } from '@/editor/ui/tableMenu/TableMenu';
import { EditorToolbar } from '@/editor/ui/toolbar';
import { draftFromBrew, type MetadataBrew, type MetadataChange, type MetaDraft, metadataBrewFrom } from '@/ported/metadata/metaDraft';
import { SplitMain, SplitPanel, toast, UiRoot, VisuallyHidden } from '@/ui';
import { exposeEditorApp } from './devApi';
import { EDITOR_KEYBOARD_HINT, editingExtensions, EDITOR_LABEL, viewingExtensions } from './editorAppExtensions';
import { displayTitle, type EditorAppBrew, type EditorAppMode, type EditorAppSaving, metaFromInput } from './editorAppModel';
import { EditorAppBar } from './EditorAppBar';
import styles from './EditorApp.module.css';
import { EditorNavItems } from './EditorNavItems';
import { LockBanner } from './LockBanner';
import { useEditorShortcuts } from './useEditorShortcuts';

/** The local brew of saving 'local' (issue #4). */
export interface EditorAppLocalBrew {
  /** Its id in the local brew library; null for a new brew (its first change stores it). */
  id: string | null;
  createdAt?: number | null;
  /** When it was last stored (the status shows it). */
  updatedAt?: number | null;
  /** An import's original text, kept with the brew. */
  sourceMarkdown?: string | null;
  /** A new brew was stored under `id`. */
  onCreated?: (id: string) => void;
  /** The author changed the brew (before its first write stores it). */
  onEdited?: () => void;
  /**
   * "Upload" (signed in): uploads brew `id` (uploadLocalBrew, which first lets this editor store its
   * changes and stop writing; see editor/local/activeEditors.ts).
   */
  onUpload?: (id: string) => Promise<void>;
  /** The brew was uploaded (from here, the sign-in prompt or Brews on this device): open the cloud brew. */
  onUploaded?: (created: BrewForEdit) => void;
}

export interface EditorAppProps {
  mode: EditorAppMode;
  saving: EditorAppSaving;
  /** With saving 'local': the brew in the local library. */
  local?: EditorAppLocalBrew | null;
  /** The initial document (ProseMirror JSON, already migrated). Read once. */
  content: JSONContent;
  /** The brew: ids, version, metadata, style, snippets, authors, lock. Read once. */
  brew: EditorAppBrew;
  /** Metadata edits not saved yet (a /new draft's meta); sent with the first save. */
  initialMetaInput?: BrewMetaInput | null;
  /** What the server holds, for "Restore unsaved changes" (edit pages). */
  baseline?: BrewBaseline | null;
  /**
   * The initial content is not on the server yet (a /new draft): it is saved as soon as someone
   * is signed in, without waiting for an edit.
   */
  unsavedOnLoad?: boolean;
  /** A brew was created (first save of a new brew, or "Save mine as a copy"): navigate to it. */
  onCreated?: (brew: BrewForEdit, reason: 'new' | 'copy') => void;
  /** The brew was deleted or left (metadata dialog): navigate away. Autosave has stopped. */
  onDeleted?: (result: DeleteBrewResponse, editId: string) => void;
  /** Record the brew in the navbar's recent brews: its editor ('edit') or share page ('view'). */
  recent?: 'edit' | 'view' | null;
  /** Put the page items (share, edit) in the site navbar. Default true. */
  navbar?: boolean;
  /** Show the brew title in the navbar (with `navbar`). Default true. */
  showTitle?: boolean;
  /** More navbar items, before the editor's own. */
  navItems?: ReactNode;
  /** Set the tab title to the brew title. Default true. */
  tabTitle?: boolean;
  /**
   * The page's h1 (visually hidden; it takes the focus after a client-side navigation). A
   * function gets the current brew title. Omit when the page renders its own h1.
   */
  heading?: string | ((title: string) => string);
  /** Banners under the toolbars (page notices). */
  banner?: ReactNode;
  /** The toolbar's status slot when nothing is saved (saving 'none'); in view mode, the end of the viewing bar. */
  statusNote?: ReactNode;
  /** Floating content over the canvas (e.g. the home page's "Create your own"). */
  overlay?: ReactNode;
  /** Put the caret in the editor once it is ready, unless the focus is already somewhere else. */
  autoFocus?: boolean;
  /** The editor's accessible name. */
  label?: string;
  'data-testid'?: string;
}

const omitAuthors = (meta: BrewMetaInput): BrewMetaInput => {
  const { authors: _authors, ...rest } = meta;
  return rest;
};

/** The author list a restored draft asks for: known authors keep their role, others are invited. */
const restoredAuthors = (handles: readonly string[], current: readonly BrewAuthorInfo[]): BrewAuthorInfo[] =>
  handles.map((handle) => {
    const known = current.find((a) => normalizeHandle(a.handle) === normalizeHandle(handle));
    return known ? { handle: known.handle, role: known.role } : { handle, role: 'invited' };
  });

/**
 * The brew is gone for this user (deleted, or they left its authors): forget it on this device —
 * the Recent brews entries that would lead to an error page, its drafts and its local history.
 * Best effort: storage failures are ignored.
 */
function forgetBrew(editId: string, shareId: string | null, deleted: boolean): void {
  removeRecentBrew('edit', editId);
  if (deleted && shareId) removeRecentBrew('view', shareId);
  const drafts = defaultDraftStore();
  void readDraftsFor(drafts, editId)
    .then((list) => drafts.delMany(list.map((draft) => draft.key)))
    .catch(() => undefined);
  void defaultSnapshotHistory()
    .clear(editId)
    .catch(() => undefined);
}

/** Save what is pending and wait until it is saved or has failed (a sign-out follows). */
async function saveBeforeSignOut(controller: AutosaveController): Promise<void> {
  const pending = (state: AutosaveState) => state.status === 'dirty' || state.status === 'saving';
  if (!pending(controller.getState())) return;
  if ((await controller.saveNow()) === 'disabled') return;
  await new Promise<void>((resolve) => {
    const check = () => {
      if (pending(controller.getState())) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = controller.subscribe(check);
    check();
  });
}

export function EditorApp({
  mode,
  saving,
  local = null,
  content,
  brew,
  initialMetaInput = null,
  baseline = null,
  unsavedOnLoad = false,
  onCreated,
  onDeleted,
  recent = null,
  navbar = true,
  showTitle = true,
  navItems,
  tabTitle = true,
  heading,
  banner,
  statusNote,
  overlay,
  autoFocus = false,
  label = EDITOR_LABEL,
  'data-testid': testId = 'editor-app',
}: EditorAppProps) {
  const editable = mode === 'edit';
  // Read once: the editor, and this component, own the brew from here on.
  const [initial] = useState(() => ({ content, brew, metaInput: initialMetaInput }));
  const gate = useMemo(() => createCanvasGate(), []);
  // The editor's description: how to reach the toolbars and panels from the text.
  const hintId = useId();
  const extensions = useMemo(
    () => (editable ? editingExtensions(gate, label, hintId) : viewingExtensions(gate, label)),
    [editable, gate, label, hintId],
  );

  const [editor, setEditor] = useState<Editor | null>(null);
  const [handle, setHandle] = useState<EditorCanvasHandle | null>(null);
  const handleRef = useRef<EditorCanvasHandle | null>(null);
  const [canvasStatus, setCanvasStatus] = useState<CanvasStatus>({ state: 'loading', theme: initial.brew.meta.theme });

  // The brew's non-document content.
  const [style, setStyle] = useState(initial.brew.style);
  const [snippets, setSnippets] = useState<unknown>(initial.brew.snippets);
  // The Snippets panel's editor (its list and undo history live as long as this page).
  const snippetsEditor = useSnippetsEditor(snippets, setSnippets);
  const snippetsToggle = useRef<HTMLButtonElement>(null);
  const [metaBrew, setMetaBrew] = useState<MetadataBrew>(() => ({
    editId: initial.brew.editId,
    shareId: initial.brew.shareId,
    meta: initial.brew.meta,
    authors: initial.brew.authors,
    role: initial.brew.role,
    lock: initial.brew.lock,
  }));
  const [lock, setLock] = useState<BrewLockInfo | null>(initial.brew.lock);
  const [metaDraft, setMetaDraft] = useState<MetaDraft>(() => draftFromBrew({ meta: metaFromInput(initial.metaInput, initial.brew.meta), authors: initial.brew.authors }));
  const [metaInput, setMetaInput] = useState<BrewMetaInput | null>(initial.metaInput);
  const metaInputRef = useRef(metaInput);
  useEffect(() => {
    metaInputRef.current = metaInput;
  });
  const [savedTitle, setSavedTitle] = useState(initial.brew.meta.title);
  // Deleted (or left) through the properties dialog: nothing more to save.
  const [stopped, setStopped] = useState<{ result: DeleteBrewResponse; editId: string } | null>(null);

  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const propertiesRef = useRef<HTMLButtonElement>(null);
  const outlineToggle = useRef<HTMLButtonElement>(null);
  const styleToggle = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const toggleRefs = useMemo(() => ({ outline: outlineToggle, style: styleToggle, inspector: inspectorToggle }), []) as Record<
    PanelId,
    typeof outlineToggle
  >;

  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const userKey = me.data?.id ?? null;
  const saves = saving === 'server';
  const localMode = saving === 'local';

  const autosave = useAutosave({
    editor,
    editId: saves ? initial.brew.editId : null,
    baseVersion: saves ? initial.brew.version : null,
    enabled: saves && !stopped,
    drafts: saves ? undefined : null,
    snapshots: saves ? undefined : null,
    shortcut: saves,
    warnOnUnload: saves,
    baseline: saves ? baseline : null,
    lastSavedAt: initial.brew.updatedAt,
    getStyle: () => style,
    // The Snippets panel reports typing at most every SNIPPETS_REPORT_MS: its latest value.
    getSnippets: () => snippetsEditor.value(),
    getMeta: () => metaInput,
    watch: [style, snippets, metaInput],
    userKey,
    // Known to be signed out: a new brew stays in its draft instead of a 401 POST (APP-9).
    signedOut: me.isSuccess && me.data === null,
    onCreated: (created, reason) => {
      setMetaBrew(metadataBrewFrom(created));
      setLock(created.lock ?? null);
      setSavedTitle(created.meta.title);
      // The server's author list from now on (the creator is its owner).
      setMetaDraft((d) => ({ ...d, authors: created.authors.map((a) => ({ handle: a.handle, role: a.role })) }));
      setMetaInput((m) => (m?.authors ? omitAuthors(m) : m));
      onCreated?.(created, reason);
    },
    onSaved: (response: SaveBrewResponse, request: SaveBrewRequest) => {
      setSavedTitle(response.title);
      setMetaBrew((b) => ({ ...b, authors: response.authors }));
      // Once an author list edit is saved, the server's list is the truth.
      const sent = metaInputRef.current;
      if (sent && sent === request.meta && sent.authors) {
        setMetaInput(omitAuthors(sent));
        setMetaDraft((d) => ({ ...d, authors: response.authors.map((a) => ({ handle: a.handle, role: a.role })) }));
      }
    },
    onServerBrew: (loaded) => {
      setStyle(loaded.style ?? '');
      setSnippets(loaded.snippets ?? null);
      setMetaBrew(metadataBrewFrom(loaded));
      setMetaDraft(draftFromBrew(loaded));
      setMetaInput(null);
      setLock(loaded.lock ?? null);
      setSavedTitle(loaded.meta.title);
    },
    onRestore: (restored: BrewContent, source: 'draft' | 'snapshot') => {
      setStyle(restored.style ?? '');
      setSnippets(restored.snippets ?? null);
      if (restored.meta) {
        // A snapshot's author list is history: sending it again would re-invite people removed
        // since (or remove people added since). An unsaved draft's author edit comes back, and
        // the Properties dialog shows it.
        const handles = source === 'draft' ? restored.meta.authors : null;
        const restoredMeta = source === 'draft' ? restored.meta : omitAuthors(restored.meta);
        setMetaInput(restoredMeta);
        setMetaDraft((d) => ({
          ...draftFromBrew({ meta: metaFromInput(restoredMeta, metaBrew.meta), authors: metaBrew.authors }),
          authors: handles ? restoredAuthors(handles, d.authors) : d.authors,
        }));
      }
    },
  });

  // A local brew: written to this browser (useLocalSave). The metadata it keeps is the dialog's draft.
  const localSave = useLocalSave({
    editor,
    enabled: localMode && editable,
    localId: local?.id ?? null,
    createdAt: local?.createdAt ?? null,
    sourceMarkdown: local?.sourceMarkdown ?? null,
    lastSavedAt: local?.updatedAt ?? null,
    getContent: () => ({ style, snippets: snippetsEditor.value(), meta: localMeta(metaDraft) }),
    watch: [style, snippets, metaDraft.title, metaDraft.description, metaDraft.tags, metaDraft.lang, metaDraft.theme],
    onCreated: local?.onCreated,
  });
  const [uploading, setUploading] = useState(false);
  const onUpload = local?.onUpload;
  const uploadLocal = async () => {
    if (!onUpload || uploading || !localSave.localId) return;
    try {
      await onUpload(localSave.localId);
    } catch {
      // The page reported it; the brew stays local and editable (uploadFailed below).
    }
  };
  // An upload of this brew, from anywhere in this tab, first stores what the editor has and
  // freezes it; afterwards the page opens the cloud brew, or the editor writes again.
  const { saveNow: storeLocalNow, stop: stopLocal, resume: resumeLocal, localId: storedLocalId, status: localStatus } = localSave;
  const localCallbacks = useRef({ onUploaded: local?.onUploaded, onEdited: local?.onEdited });
  useEffect(() => {
    localCallbacks.current = { onUploaded: local?.onUploaded, onEdited: local?.onEdited };
  });
  useEffect(() => {
    if (!localMode || !editable || !storedLocalId) return;
    return registerActiveLocalEditor(storedLocalId, {
      prepareUpload: async () => {
        if (!(await storeLocalNow())) return false;
        stopLocal();
        if (editor && !editor.isDestroyed) editor.setEditable(false);
        setUploading(true);
        return true;
      },
      uploaded: (created) => {
        setUploading(false);
        localCallbacks.current.onUploaded?.(created);
      },
      uploadFailed: () => {
        resumeLocal();
        if (editor && !editor.isDestroyed) editor.setEditable(true);
        setUploading(false);
      },
    });
  }, [localMode, editable, storedLocalId, storeLocalNow, stopLocal, resumeLocal, editor]);
  // The author typed: a signed-out /new must not be swapped for a signed-in one any more.
  useEffect(() => {
    if (localMode && localStatus !== 'idle') localCallbacks.current.onEdited?.();
  }, [localMode, localStatus]);

  // A save answered 401: the session is gone. Autosave calls the API directly, so the query
  // client's 401 policy (`me` = null) never saw it: apply it here. The navbar then offers "Sign
  // in", and signing in again, even as the same user, changes userKey, which retries the save.
  const queryClient = useQueryClient();
  const { status: saveStatus, controller } = autosave;
  const signedIn = me.data != null;
  useEffect(() => {
    // The live state: a sign-in in this same commit has already started the retry.
    if (saveStatus === 'signedOut' && signedIn && controller.getState().status === 'signedOut') {
      queryClient.setQueryData(queryKeys.account.me(), null);
    }
  }, [saveStatus, signedIn, controller, queryClient]);

  // Signing out from the navbar or the account page saves pending changes first.
  useEffect(() => {
    if (!saves) return;
    return registerBeforeSignOut(() => saveBeforeSignOut(controller));
  }, [saves, controller]);

  // A /new draft is saved once someone is signed in (at once, or after signing in here).
  const pendingLoadSave = useRef(unsavedOnLoad && saves);
  const { markDirty } = autosave;
  useEffect(() => {
    if (!pendingLoadSave.current || !editor || !userKey) return;
    pendingLoadSave.current = false;
    markDirty();
  }, [editor, userKey, markDirty]);

  // Deleted: autosave is disabled by now (this effect runs after the render that disabled it),
  // so leaving doesn't save the brew again, and nothing writes its draft after it is forgotten.
  useEffect(() => {
    if (!stopped) return;
    if (saves) forgetBrew(stopped.editId, metaBrew.shareId, stopped.result.brewDeleted);
    onDeleted?.(stopped.result, stopped.editId);
    // Once per deletion.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped]);

  const theme = metaDraft.theme || initial.brew.meta.theme;
  const lang = metaDraft.lang || initial.brew.meta.lang;
  const title = displayTitle(metaDraft.title, savedTitle);
  const editId = saves ? autosave.editId : metaBrew.editId;
  const shareId = metaBrew.shareId;
  usePageTitle(tabTitle ? title : null);
  useRecordRecentBrew('edit', recent === 'edit' && editId ? { id: editId, title } : null);
  useRecordRecentBrew('view', recent === 'view' && shareId ? { id: shareId, title } : null);

  const zoom = useUiStore((s) => s.zoom);
  const spread = useUiStore((s) => s.spread);
  const startOnRight = useUiStore((s) => s.startOnRight);
  const pageShadows = useUiStore((s) => s.pageShadows);
  const tracker = usePageTracker(handle);

  // Snippets of the theme chain (from the canvas once it is ready) plus the brew's own.
  const chainSnippets = useMemo<readonly ThemeSnippetRef[] | null>(
    () => (editable && canvasStatus.state === 'ready' ? canvasStatus.chain.snippets : null),
    [editable, canvasStatus],
  );
  const snippetGroups = useSnippetGroups(chainSnippets, snippets, title);
  const styleGroups = useMemo(() => groupsForView(snippetGroups.groups, 'style'), [snippetGroups.groups]);
  const snippetBrew = useMemo(() => ({ shareId: shareId ?? undefined, title, theme, lang }), [shareId, title, theme, lang]);
  const appendStyle = useCallback((css: string) => setStyle((old) => insertStyleSnippet(old, css).css), []);

  const print = useCallback(() => {
    const current = handleRef.current;
    if (!current) {
      window.print();
      return;
    }
    // Lay out every page now (typing may have left a pass unfinished), then print.
    try {
      if (!current.editor.isDestroyed) settleNow(current.editor.view);
    } catch {
      // A detached view: print what is there.
    }
    void current.print();
  }, []);

  const { saveNow } = autosave;
  const localSaveNow = localSave.saveNow;
  const onSaveKey = useCallback(() => {
    if (saves) {
      void saveNow();
      return;
    }
    if (localMode) {
      void localSaveNow();
      return;
    }
    toast({ id: 'editor-not-saved', title: 'This page is never saved', description: 'Create your own brew to keep your work.', tone: 'info' });
  }, [saves, saveNow, localMode, localSaveNow]);
  useEditorShortcuts({ editor, onSave: onSaveKey, onPrint: print, saveKeyOnWindow: !saves });

  const saveState = useRef(autosave.controller.getState);
  const onReady = useCallback((next: Editor, nextHandle: EditorCanvasHandle) => {
    handleRef.current = nextHandle;
    setEditor(next);
    setHandle(nextHandle);
  }, []);
  useEffect(() => {
    if (!editor || !handle) return;
    return exposeEditorApp(editor, handle, () => (saves ? saveState.current() : null));
  }, [editor, handle, saves]);

  // Read-only, nothing in the canvas takes the focus: make its scroll container focusable so the
  // pages can be scrolled from the keyboard (arrows, Page Up/Down, Space).
  // Editable, the caret scrolls the pages: the scroll container is no Tab stop of its own (Firefox
  // makes scrollable elements focusable, which put an unnamed stop between the toolbars and the
  // text; P8.2).
  useEffect(() => {
    const viewport = handle?.viewport;
    if (!editable || !viewport) return;
    viewport.setAttribute('tabindex', '-1');
    return () => viewport.removeAttribute('tabindex');
  }, [editable, handle]);
  useEffect(() => {
    const viewport = handle?.viewport;
    if (editable || !viewport) return;
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', 'Pages');
    return () => {
      viewport.removeAttribute('tabindex');
      viewport.removeAttribute('role');
      viewport.removeAttribute('aria-label');
    };
  }, [editable, handle]);

  // The caret goes to the start of the brew, unless the reader is already busy elsewhere on this
  // page (a control of the page, a dialog or popover). The page heading that route focus picked,
  // <main> itself and the navbar item that led here don't count.
  // Per editor instance: an editor re-created at mount (React StrictMode) takes the focus its
  // predecessor had when it went away (focus fell back to <body>).
  const autoFocused = useRef<Editor | null>(null);
  useEffect(() => {
    if (!autoFocus || !editable || !editor || autoFocused.current === editor) return;
    autoFocused.current = editor;
    const active = document.activeElement;
    const main = document.getElementById('main-content');
    const busy =
      active instanceof HTMLElement &&
      (active.closest('[data-hb-portal-root]') !== null || (main !== null && main !== active && main.contains(active) && !active.hasAttribute('data-route-focus')));
    if (!busy && !editor.isDestroyed) editor.view.focus();
  }, [autoFocus, editable, editor]);

  const onMetaChange = (change: MetadataChange) => {
    setMetaDraft(change.draft);
    setMetaInput(change.meta);
  };
  const metadataBrew = useMemo<MetadataBrew>(() => ({ ...metaBrew, lock }), [metaBrew, lock]);

  const insertMenu = editor ? (
    <>
      <InsertMenu
        editor={editor}
        groups={snippetGroups.groups}
        loading={snippetGroups.status === 'loading'}
        theme={theme}
        lang={lang}
        brew={snippetBrew}
        onStyle={appendStyle}
      />
      <BlockMenu editor={editor} iconOnly />
      <TableMenu editor={editor} iconOnly />
      <IconPickerButton editor={editor} />
    </>
  ) : null;

  const status = saves ? (
    <SaveStatus autosave={autosave} />
  ) : localMode ? (
    <LocalSaveStatus state={localSave} signedIn={signedIn} onUpload={onUpload ? () => void uploadLocal() : undefined} uploading={uploading} />
  ) : (
    (statusNote ?? null)
  );

  return (
    <div
      className={styles.app}
      data-testid={testId}
      data-mode={mode}
      data-canvas-status={canvasStatus.state}
      data-save-status={saves ? autosave.status : localMode ? localSave.status : 'none'}
      data-local-id={localMode ? (localSave.localId ?? '') : undefined}
      data-edit-id={editId ?? ''}
      data-share-id={shareId ?? ''}
    >
      {heading ? (
        <h1 className={styles.srOnly} tabIndex={-1} data-route-focus="" data-testid="editor-heading">
          {typeof heading === 'function' ? heading(title) : heading}
        </h1>
      ) : null}
      {editable ? (
        <VisuallyHidden id={hintId} data-testid="editor-keyboard-hint">
          {EDITOR_KEYBOARD_HINT}
        </VisuallyHidden>
      ) : null}
      {navbar ? (
        <>
          {showTitle ? (
            <NavbarPortal slot="title">
              <span data-testid="brew-title">{title}</span>
            </NavbarPortal>
          ) : null}
          <NavbarPortal slot="items">
            {navItems}
            <EditorNavItems shareId={editable ? shareId : null} editId={editable ? null : editId} />
          </NavbarPortal>
        </>
      ) : null}

      <UiRoot className={styles.chrome}>
        {editable && editor ? (
          <EditorToolbar editor={editor} insertMenu={insertMenu} status={status} data-testid="editor-toolbar" />
        ) : editable ? (
          <div className={styles.placeholderBar} />
        ) : null}
        <EditorAppBar
          mode={mode}
          editor={editor}
          tracker={tracker}
          toggleRefs={toggleRefs}
          onProperties={(saves || localMode) && editable ? () => setPropertiesOpen(true) : null}
          onHistory={saves && editable ? () => setHistoryOpen(true) : null}
          onPrint={print}
          exportAction={
            <DownloadPdfButton
              editor={editor}
              chain={canvasStatus.state === 'ready' ? canvasStatus.chain : null}
              userCss={style}
              lang={lang}
              title={title}
            />
          }
          propertiesRef={propertiesRef}
          status={editable ? null : statusNote}
          panelToggles={editable ? <SnippetsToggle ref={snippetsToggle} /> : null}
        />
        <div className={styles.banners}>
          {lock && editable ? <LockBanner lock={lock} editId={editId} onLockChange={setLock} /> : null}
          {saves ? <DraftRestoreBanner autosave={autosave} /> : null}
          {banner}
        </div>
      </UiRoot>

      <SplitPanel className={styles.split}>
        <OutlinePanel editor={editor} tracker={tracker} returnFocusRef={outlineToggle} />
        {editable ? (
          <StylePanel
            value={style}
            onChange={setStyle}
            returnFocusRef={styleToggle}
            snippets={(api) => (
              <SnippetPicker
                groups={styleGroups}
                loading={snippetGroups.status === 'loading'}
                label="Snippets"
                dialogLabel="Insert a style snippet"
                onPick={(entry) => {
                  try {
                    api.insert(generateStyleSnippet(entry, snippetBrew));
                  } catch (error) {
                    toast({
                      title: "Couldn't insert the snippet",
                      description: error instanceof SnippetGeneratorError || error instanceof Error ? error.message : String(error),
                      tone: 'error',
                    });
                  }
                }}
                data-testid="style-snippets"
              />
            )}
          />
        ) : null}
        {editable ? <SnippetsPanel store={snippetsEditor} brewTitle={title} themeSnippets={chainSnippets} returnFocusRef={snippetsToggle} /> : null}
        <SplitMain className={styles.main}>
          <EditorCanvas
            className={styles.canvas}
            content={initial.content}
            theme={theme}
            lang={lang}
            userCss={style}
            zoom={zoom}
            spread={spread}
            startOnRight={startOnRight}
            pageShadows={pageShadows}
            editable={editable}
            gate={gate}
            extensions={extensions}
            onReady={onReady}
            onStatusChange={setCanvasStatus}
          />
          {overlay}
        </SplitMain>
        {editable ? <InspectorPanel editor={editor} returnFocusRef={inspectorToggle} /> : null}
      </SplitPanel>

      {saves && editable ? (
        <>
          <ConflictDialog autosave={autosave} />
          <LeaveGuard autosave={autosave} />
          <LocalHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} autosave={autosave} />
          <MetadataDialog
            open={propertiesOpen}
            onOpenChange={setPropertiesOpen}
            brew={metadataBrew}
            draft={metaDraft}
            onChange={onMetaChange}
            serverError={autosave.error}
            onLockChange={setLock}
            baseUrl={window.location.origin}
            onDeleted={(result, deletedId) => {
              setPropertiesOpen(false);
              setStopped({ result, editId: deletedId });
            }}
          />
        </>
      ) : null}
      {localMode && editable ? (
        <MetadataDialog
          open={propertiesOpen}
          onOpenChange={setPropertiesOpen}
          brew={metadataBrew}
          draft={metaDraft}
          onChange={onMetaChange}
          baseUrl={window.location.origin}
          local
        />
      ) : null}
    </div>
  );
}
