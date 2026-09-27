import type { Editor, JSONContent } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import type { ThemeChain } from '@/editor/canvas/themeLoader';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { editingExtensions, viewingExtensions } from '@/editor/EditorApp/editorAppExtensions';
import { exportBrewHtml, type ExportResult } from '@/editor/export/exportHtml';
import { DownloadPdfButton } from '@/editor/export/DownloadPdfButton';
import { hbfmToDoc } from '@/editor/import/hbfmToDoc';
import { isSettled, settleNow } from '@/editor/pagination';
import { IconButton, Toolbar, UiRoot } from '@/ui';
import { loadFixture } from '../import/fixtures';
import { exportDevDocs } from './devDocs';
import styles from './ExportDevPage.module.css';

/** The test API of /dev/export (web/e2e/export). */
export interface ExportDevApi {
  editor: Editor;
  handle: EditorCanvasHandle;
  /** Canvas ready (theme, CSS, fonts) and pagination settled. */
  settled: () => boolean;
  /** The brew as exported by the app bar's button. `separators: false` writes Firefox's DOM. */
  exportHtml: (options?: { separators?: boolean }) => Promise<ExportResult>;
  /** The app's print path: pagination finished, lazy images loaded, window.print. */
  print: () => Promise<void>;
}

declare global {
  interface Window {
    __hbExport?: ExportDevApi;
  }
}

type Loaded = { state: 'loading' } | { state: 'ready'; content: JSONContent; css: string } | { state: 'error'; message: string };

/**
 * /dev/export[?doc=inn|external|a5|s1|chrome][&fixture=<S3 fixture>][&theme=5ePHB][&css=<brew CSS>]
 * [&editable=1]: a read-only canvas (as the share page shows a brew; `editable=1` for the editor's
 * DOM) with pagination, the "Download PDF" button (it needs the API and a signed-in session) and a
 * Print button. window.__hbExport.exportHtml gives the HTML export that the PDF is rendered from.
 * `fixture` imports an S3 fixture with hbfmToDoc (its CSS becomes the brew CSS).
 * data-theme-status is "ready" once the canvas is.
 */
export function ExportDevPage() {
  const [params] = useSearchParams();
  const theme = params.get('theme') ?? '5ePHB';
  const docKey = params.get('doc') ?? 'inn';
  const fixture = params.get('fixture');
  const cssParam = params.get('css');
  const editable = params.get('editable') === '1';
  const devDoc = exportDevDocs[docKey] ?? exportDevDocs.inn!;
  const [loaded, setLoaded] = useState<Loaded>(() => (fixture ? { state: 'loading' } : { state: 'ready', content: devDoc.content, css: cssParam ?? devDoc.css }));
  const [status, setStatus] = useState<CanvasStatus>({ state: 'loading', theme });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [handle, setHandle] = useState<EditorCanvasHandle | null>(null);
  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo(() => (editable ? editingExtensions(gate) : viewingExtensions(gate)), [editable, gate]);
  const chain: ThemeChain | null = status.state === 'ready' ? status.chain : null;
  const css = loaded.state === 'ready' ? loaded.css : '';
  const lang = 'en';
  const title = fixture ?? `Export test (${docKey})`;

  useEffect(() => {
    if (!fixture) return;
    let cancelled = false;
    void (async () => {
      try {
        const source = await loadFixture(fixture);
        if (source === null) throw new Error(`No fixture named "${fixture}".`);
        const result = await hbfmToDoc(source, { theme });
        if (!cancelled) setLoaded({ state: 'ready', content: result.doc, css: cssParam ?? result.style });
      } catch (error) {
        if (!cancelled) setLoaded({ state: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixture, theme, cssParam]);

  const print = useCallback(async () => {
    if (!editor || !handle) return;
    settleNow(editor.view);
    await handle.print();
  }, [editor, handle]);

  useEffect(() => {
    if (!editor || !handle) return;
    window.__hbExport = {
      editor,
      handle,
      settled: () => handle.isReady() && isSettled(editor.state),
      exportHtml: async (options = {}) => {
        if (!chain) throw new Error('The theme is not loaded yet.');
        return exportBrewHtml(editor, { chain, userCss: css, lang, title, separators: options.separators });
      },
      print,
    };
    return () => {
      delete window.__hbExport;
    };
  }, [editor, handle, chain, css, title, print]);

  const onReady = useCallback((e: Editor, h: EditorCanvasHandle) => {
    setEditor(e);
    setHandle(h);
  }, []);

  const frameStatus = loaded.state === 'error' ? 'error' : loaded.state === 'loading' ? 'loading' : status.state;

  return (
    <div className={styles.frame} data-theme-status={frameStatus}>
      <UiRoot className={styles.chrome}>
        <header className={styles.bar}>
          <strong>/dev/export</strong>
          <Toolbar label="Export" data-testid="export-toolbar">
            <IconButton icon="print" label="Print" tooltip="bottom" disabled={!editor} onClick={() => void print()} data-testid="print" />
            <DownloadPdfButton editor={editor} chain={chain} userCss={css} lang={lang} title={title} signedIn />
          </Toolbar>
          <span data-testid="canvas-status">{loaded.state === 'error' ? loaded.message : frameStatus}</span>
        </header>
      </UiRoot>
      {loaded.state === 'ready' ? (
        <EditorCanvas
          key={`${docKey}-${fixture ?? ''}-${editable}`}
          className={styles.canvas}
          content={loaded.content}
          theme={theme}
          lang={lang}
          userCss={css}
          editable={editable}
          gate={gate}
          extensions={extensions}
          onReady={onReady}
          onStatusChange={setStatus}
        />
      ) : null}
    </div>
  );
}
