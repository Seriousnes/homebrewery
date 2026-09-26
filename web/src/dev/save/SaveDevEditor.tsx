import type { Editor, JSONContent } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMe, type BrewForEdit, type BrewMetaInput } from '@/api';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas } from '@/editor/canvas/EditorCanvas';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { Pagination } from '@/editor/pagination';
import {
  ConflictDialog,
  defaultDraftStore,
  defaultSnapshotHistory,
  DraftRestoreBanner,
  idbStore,
  LeaveGuard,
  LocalHistoryDialog,
  NEW_DRAFT_KEY,
  readDraftsFor,
  SaveStatus,
  useAutosave,
  type BrewBaseline,
} from '@/editor/save';
import { migrateDoc } from '@/editor/schema';
import { Button, TextField, UiRoot } from '@/ui';
import { BLANK_DOC } from './devGlobals';
import styles from './SaveDevPage.module.css';

export interface SaveDevEditorProps {
  /** The loaded brew, or null for a new one. */
  brew: BrewForEdit | null;
}

export function SaveDevEditor({ brew }: SaveDevEditorProps) {
  const [, setParams] = useSearchParams();
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  // Read once: the editor owns the document from here on.
  const [content] = useState<JSONContent>(() => (brew ? migrateDoc(brew.doc as JSONContent, brew.docSchemaVersion) : BLANK_DOC));
  const [baseline] = useState<BrewBaseline>(() =>
    brew ? { doc: brew.doc, style: brew.style, snippets: brew.snippets, meta: brew.meta } : { doc: BLANK_DOC, style: '', snippets: null },
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [style, setStyle] = useState(brew?.style ?? '');
  const [title, setTitle] = useState(brew?.meta.title ?? '');
  const [snippets, setSnippets] = useState<unknown>(brew?.snippets ?? null);
  const [canvasState, setCanvasState] = useState<CanvasStatus['state']>('loading');
  const [historyOpen, setHistoryOpen] = useState(false);

  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo(() => [Pagination.configure({ isReady: gate.isReady })], [gate]);

  const autosave = useAutosave({
    editor,
    editId: brew?.editId ?? null,
    baseVersion: brew?.version ?? null,
    lastSavedAt: brew?.updatedAt ?? null,
    baseline,
    getStyle: () => style,
    getSnippets: () => snippets,
    getMeta: (): BrewMetaInput => ({ title }),
    watch: [style, title, snippets],
    userKey: me.data?.id ?? null,
    signedOut: me.isSuccess && me.data === null,
    onCreated: (created) => {
      setParams({ edit: created.editId }, { replace: true });
    },
    onServerBrew: (loaded) => {
      setStyle(loaded.style);
      setTitle(loaded.meta.title);
      setSnippets(loaded.snippets);
    },
    onRestore: (restored) => {
      setStyle(restored.style);
      if (restored.meta?.title != null) setTitle(restored.meta.title);
      setSnippets(restored.snippets ?? null);
    },
  });

  const { controller, saveNow } = autosave;
  useEffect(() => {
    if (!editor) return;
    const drafts = (editId: string) => readDraftsFor(defaultDraftStore(), editId === NEW_DRAFT_KEY ? null : editId);
    window.__hbSave = {
      editor,
      state: controller.getState,
      draft: async (key) => (await drafts(key))[0] ?? null,
      drafts,
      snapshots: (editId) => defaultSnapshotHistory().list(editId),
      saveNow: () => saveNow(),
      idbRoundTrip: async () => {
        const store = idbStore<{ n: number }>('hb-e2e-kv', 'kv');
        await store.delMany((await store.entries()).map(([key]) => key));
        await store.set('a', { n: 1 });
        await store.setMany([
          ['b', { n: 2 }],
          ['c', { n: 3 }],
        ]);
        const one = await store.get('a');
        const many = await store.getMany(['a', 'b', 'missing']);
        await store.del('a');
        await store.delMany(['b']);
        const left = await store.entries();
        return { one, many, left };
      },
    };
  }, [editor, controller, saveNow]);

  const onReady = useCallback((ready: Editor) => setEditor(ready), []);
  const onStatusChange = useCallback((status: CanvasStatus) => setCanvasState(status.state), []);

  return (
    <div
      className={styles.editorFrame}
      data-testid="dev-save"
      data-theme-status={canvasState}
      data-status={autosave.status}
      data-edit-id={autosave.editId ?? ''}
      data-base-version={autosave.baseVersion ?? ''}
      data-unsaved={autosave.unsaved ? 'true' : 'false'}
    >
      <UiRoot className={styles.chrome}>
        <div className={styles.bar} role="toolbar" aria-label="Brew">
          <SaveStatus autosave={autosave} />
          <Button size="sm" variant="ghost" icon="undo" onClick={() => setHistoryOpen(true)} aria-haspopup="dialog">
            Local history
          </Button>
          <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} className={styles.title} />
          <span className={styles.info} data-testid="dev-save-info">
            {autosave.editId ? `edit ${autosave.editId} · version ${autosave.baseVersion}` : 'new brew (not created yet)'}
          </span>
        </div>
        <DraftRestoreBanner autosave={autosave} className={styles.banner} />
        <ConflictDialog autosave={autosave} />
        <LeaveGuard autosave={autosave} />
        <LocalHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} autosave={autosave} />
      </UiRoot>
      <div className={styles.body}>
        <UiRoot className={styles.side}>
          <label className={styles.styleLabel}>
            Brew CSS
            <textarea className={styles.css} value={style} onChange={(e) => setStyle(e.target.value)} spellCheck={false} data-testid="css-input" />
          </label>
        </UiRoot>
        <EditorCanvas
          className={styles.canvas}
          content={content}
          theme={brew?.meta.theme ?? '5ePHB'}
          userCss={style}
          gate={gate}
          extensions={extensions}
          onReady={onReady}
          onStatusChange={onStatusChange}
        />
      </div>
    </div>
  );
}
