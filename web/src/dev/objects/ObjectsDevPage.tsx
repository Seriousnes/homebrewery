import type { Editor, JSONContent } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { hbfmToDoc } from '@/editor/import/hbfmToDoc';
import { objectsOf, pageEditingExtensions, selectedObject, type ObjectRef } from '@/editor/objects';
import { isSettled, Pagination } from '@/editor/pagination';
import type { PageObject } from '@/editor/schema';
import { BlockMenu } from '@/editor/ui/blockMenu/BlockMenu';
import { IconPickerButton } from '@/editor/ui/iconPicker/IconPicker';
import { TableMenu } from '@/editor/ui/tableMenu/TableMenu';
import { IconButton, Toolbar, ToolbarGroup, UiRoot } from '@/ui';
import { loadFixture } from '../import/fixtures';
import { objectsDevDocs } from './devDocs';
import styles from './ObjectsDevPage.module.css';

const ZOOMS = [0.5, 0.75, 1, 1.5, 2];

/** The test API of /dev/objects (web/e2e/objects). */
export interface ObjectsDevApi {
  editor: Editor;
  handle: EditorCanvasHandle;
  /** Pagination settled (and the canvas ready). */
  settled: () => boolean;
  doc: () => JSONContent;
  pages: () => number;
  objects: (pageIndex: number) => PageObject[];
  markers: (pageIndex: number) => string[];
  selected: () => ObjectRef | null;
  undo: () => boolean;
  redo: () => boolean;
}

declare global {
  interface Window {
    __hbObjects?: ObjectsDevApi;
  }
}

type Loaded = { state: 'loading' } | { state: 'ready'; content: JSONContent; css: string } | { state: 'error'; message: string };

/**
 * /dev/objects[?doc=blank|blocks|tables|images|objects][&fixture=<S3 fixture>][&theme=5ePHB]
 * [&zoom=1][&paginate=0]: an editing canvas with pagination and the objects lane's UI — the
 * BlockMenu, TableMenu and icon picker in a toolbar, page objects (click, drag, handles, keys),
 * `:` icon autocomplete — without the inspector. `fixture` imports an S3 fixture with hbfmToDoc
 * (its CSS becomes the brew style). The frame's data-theme-status is "ready" once the canvas is.
 */
export function ObjectsDevPage() {
  const [params, setParams] = useSearchParams();
  const theme = params.get('theme') ?? '5ePHB';
  const zoom = Number(params.get('zoom') ?? '1') || 1;
  const paginate = params.get('paginate') !== '0';
  const docKey = params.get('doc') ?? 'blank';
  const fixture = params.get('fixture');
  const [loaded, setLoaded] = useState<Loaded>(() =>
    fixture ? { state: 'loading' } : { state: 'ready', content: objectsDevDocs[docKey] ?? objectsDevDocs.blank!, css: '' },
  );
  const [status, setStatus] = useState<CanvasStatus['state']>('loading');
  const [editor, setEditor] = useState<Editor | null>(null);
  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo(() => [...(paginate ? [Pagination.configure({ isReady: gate.isReady })] : []), ...pageEditingExtensions], [gate, paginate]);

  useEffect(() => {
    if (!fixture) return;
    let cancelled = false;
    void (async () => {
      try {
        const text = await loadFixture(fixture);
        if (text === null) throw new Error(`No fixture named "${fixture}".`);
        const result = await hbfmToDoc(text, { theme });
        if (!cancelled) setLoaded({ state: 'ready', content: result.doc, css: result.style });
      } catch (error) {
        if (!cancelled) setLoaded({ state: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixture, theme]);

  const onReady = useCallback((e: Editor, handle: EditorCanvasHandle) => {
    setEditor(e);
    const pageAt = (i: number) => (i >= 0 && i < e.state.doc.childCount ? e.state.doc.child(i) : null);
    window.__hbObjects = {
      editor: e,
      handle,
      settled: () => handle.isReady() && isSettled(e.state),
      doc: () => e.getJSON(),
      pages: () => e.state.doc.childCount,
      objects: (i) => (pageAt(i) ? objectsOf(pageAt(i)!.attrs) : []),
      markers: (i) => (pageAt(i)?.attrs.markers as string[] | undefined) ?? [],
      selected: () => selectedObject(e.state),
      undo: () => e.commands.undo(),
      redo: () => e.commands.redo(),
    };
  }, []);

  const frameStatus = loaded.state === 'error' ? 'error' : loaded.state === 'loading' ? 'loading' : status;

  return (
    <div className={styles.frame} data-theme-status={frameStatus}>
      <UiRoot className={styles.chrome}>
        <header className={styles.bar}>
          <strong>/dev/objects</strong>
          <Toolbar label="Editor" className={styles.toolbar} data-testid="objects-toolbar">
            <ToolbarGroup label="History">
              <IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" disabled={!editor} onClick={() => editor?.chain().focus().undo().run()} data-testid="undo" />
              <IconButton icon="redo" label="Redo" shortcut="Ctrl+Y" disabled={!editor} onClick={() => editor?.chain().focus().redo().run()} data-testid="redo" />
            </ToolbarGroup>
            <ToolbarGroup label="Insert">
              <BlockMenu editor={editor} />
              <TableMenu editor={editor} />
              <IconPickerButton editor={editor} />
            </ToolbarGroup>
          </Toolbar>
          <label className={styles.field}>
            zoom{' '}
            <select
              data-testid="zoom-select"
              value={String(zoom)}
              onChange={(e) =>
                setParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.set('zoom', e.target.value);
                    return next;
                  },
                  { replace: true },
                )
              }
            >
              {ZOOMS.map((z) => (
                <option key={z} value={String(z)}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
          </label>
          <span data-testid="canvas-status">{loaded.state === 'error' ? loaded.message : frameStatus}</span>
        </header>
      </UiRoot>
      {loaded.state === 'ready' ? (
        <EditorCanvas
          key={`${docKey}-${fixture ?? ''}`}
          className={styles.canvas}
          content={loaded.content}
          theme={theme}
          userCss={loaded.css}
          zoom={zoom}
          gate={gate}
          extensions={extensions}
          onReady={onReady}
          onStatusChange={(s) => setStatus(s.state)}
        />
      ) : null}
    </div>
  );
}
