import type { AnyExtension, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import '@/editor/canvas/canvas.css';
import { inlineCssImports, scopeCss } from '@/editor/canvas/cssScope';
import { EditorCanvas } from '@/editor/canvas/EditorCanvas';
import { applyThemeStyles, loadThemeChain, waitForFonts } from '@/editor/canvas/themeLoader';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import type { VariablesMode } from '@/editor/import/hbfm/renderer';
import { hbfmToDoc, type HbfmImportResult, type HbfmToDocOptions } from '@/editor/import/hbfmToDoc';
import { recordPaginatedPages, sectionPageCounts } from '@/editor/import/importReport';
import { OPEN_SANS_CSS } from '@/editor/import/upstreamBase';
import { ImageWithView } from '@/editor/objects/imageView';
import { fixtureNames, loadFixture, settleImages } from './fixtures';
import styles from './ImportDevPage.module.css';

/** How the imported document is shown: the editor's canvas (default) or a bare TipTap editor. */
type View = 'canvas' | 'plain';

type Status =
  | { state: 'loading' }
  | { state: 'imported'; result: HbfmImportResult; failed: string[] }
  | { state: 'error'; message: string };

/**
 * Images load eagerly in the harness (as upstream's print does), so screenshots see them. Built on
 * the editor's ImageWithView (same name, so it replaces it): imported images carry their natural
 * size, which only ImageView renders without fixing both dimensions.
 */
const EagerImage = ImageWithView.extend({
  renderHTML(props) {
    const spec = this.parent?.(props) as [string, Record<string, unknown>] | undefined;
    return spec ? [spec[0], { ...spec[1], loading: 'eager' }] : ['img', props.HTMLAttributes];
  },
  // extend() copies ImageWithView's addProseMirrorPlugins, which calls this.parent: inherited as
  // is, it would run twice and add the keyed natural-size plugin twice (a RangeError).
  addProseMirrorPlugins() {
    return this.parent?.() ?? [];
  },
});

/** The test API /dev/import exposes (e2e/import specs). */
export interface ImportDevApi {
  hbfmToDoc: (text: string, options?: Omit<HbfmToDocOptions, 'probe'>) => Promise<HbfmImportResult>;
  recordPaginatedPages: typeof recordPaginatedPages;
  sectionPageCounts: typeof sectionPageCounts;
}

declare global {
  interface Window {
    /** Set by /dev/import for the S3 spec: the import result of the current fixture. */
    __hbImport?: Pick<HbfmImportResult, 'doc' | 'style' | 'report' | 'meta'>;
    /** Set by /dev/import (any URL): hbfmToDoc on arbitrary text, for the e2e specs. */
    __hbImportApi?: ImportDevApi;
  }
}

/**
 * ?experiment=trailing-break: hides ProseMirror's trailing <br> where upstream had no line (a
 * paragraph whose only in-flow content is a float or an absolutely positioned span, an empty dt,
 * an empty table cell). Measures what a canvas.css rule like this would buy; not editor CSS.
 */
const TRAILING_BREAK = [
  '.hb-canvas .page :is(dt, dd) > br.ProseMirror-trailingBreak,',
  '.hb-canvas .page :is(td, th) > p:only-child > br.ProseMirror-trailingBreak:only-child,',
  '.hb-canvas .page p:has(> :not(br)) > br.ProseMirror-trailingBreak { display: none; }',
].join(' ');
const EXPERIMENTS: Record<string, string> = {
  'trailing-break': TRAILING_BREAK,
  // + ProseMirror's separator <img> after a trailing inline node (e.g. a floated image in a link
  // alone in its paragraph: upstream's <p> has no line, the separator makes one).
  'trailing-break-separator': `${TRAILING_BREAK} .hb-canvas .page p:has(> :not(br)) img.ProseMirror-separator { display: none; }`,
};

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** A <style> in the app document for the lifetime of the component. */
function useDocumentStyle(css: string | undefined, marker: string) {
  useEffect(() => {
    if (!css) return;
    const style = document.createElement('style');
    style.setAttribute('data-hb-dev', marker);
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
  }, [css, marker]);
}

/**
 * /dev/import?fixture=<name>[&theme=<key>][&view=canvas|plain][&variables=expand|keep][&experiment=trailing-break]
 *
 * Runs hbfmToDoc on an S3 fixture and shows the document read-only:
 *   view=canvas (default)  in EditorCanvas (editable=false): the editor's NodeViews, canvas.css,
 *                          theme loading, scoped brew CSS and fonts, no pagination;
 *   view=plain             in a bare TipTap editor (buildEditorExtensions, no NodeViews), with the
 *                          theme and brew CSS applied here (isolates canvas-lane effects).
 * `variables=keep` imports with hbfmToDoc({ variables: 'keep' }); `experiment` see EXPERIMENTS.
 * `data-render-status="ready"` once theme, fonts and images have loaded; the import result is
 * on window.__hbImport, and window.__hbImportApi runs hbfmToDoc on any text.
 */
export function ImportDevPage() {
  const [params] = useSearchParams();
  const fixture = params.get('fixture') ?? '';
  const themeOverride = params.get('theme');
  const view: View = params.get('view') === 'plain' ? 'plain' : 'canvas';
  const variables: VariablesMode = params.get('variables') === 'keep' ? 'keep' : 'expand';
  const experiment = params.get('experiment');
  const [status, setStatus] = useState<Status>({ state: 'loading' });

  useDocumentStyle(experiment ? EXPERIMENTS[experiment] : undefined, `experiment-${experiment ?? ''}`);
  // EditorCanvas brings its own Open Sans @font-face; the plain view needs it here.
  useDocumentStyle(view === 'plain' ? OPEN_SANS_CSS : undefined, 'open-sans');

  useEffect(() => {
    window.__hbImportApi = { hbfmToDoc: (text, options) => hbfmToDoc(text, options), recordPaginatedPages, sectionPageCounts };
  }, []);

  useEffect(() => {
    if (!fixture) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const run = async () => {
      const text = await loadFixture(fixture);
      if (text === null) throw new Error(`No fixture named "${fixture}".`);
      const result = await hbfmToDoc(text, { variables, ...(themeOverride ? { theme: themeOverride } : {}) });
      const failed: string[] = [];
      if (view === 'plain') {
        const chain = await loadThemeChain(result.report.theme);
        const inlined = await inlineCssImports(result.style, { baseUrl: document.baseURI });
        if (cancelled) return; // React re-ran the effect (StrictMode): only the live run applies styles
        const applied = await applyThemeStyles(chain, inlined.css, { scopeCss: (css, baseURL) => scopeCss(css, baseURL) });
        dispose = applied.dispose;
        failed.push(...applied.failed, ...inlined.failed);
      }
      if (cancelled) return;
      window.__hbImport = { doc: result.doc, style: result.style, report: result.report, meta: result.meta };
      setStatus({ state: 'imported', result, failed });
    };
    run().catch((error: unknown) => {
      if (!cancelled) setStatus({ state: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [fixture, themeOverride, view, variables]);

  if (!fixture) {
    return (
      <main className={styles.index}>
        <h1>/dev/import</h1>
        <p>hbfmToDoc on an S3 fixture, shown read-only. Compare with /dev/legacy-render.</p>
        <ul>
          {fixtureNames.map((name) => (
            <li key={name}>
              <Link to={`?fixture=${encodeURIComponent(name)}`}>{name}</Link> · <Link to={`/dev/legacy-render?fixture=${encodeURIComponent(name)}`}>upstream</Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  return (
    <div className={styles.frame}>
      <header className={styles.bar}>
        <strong>/dev/import</strong> <code>{fixture}</code>{' '}
        {status.state === 'imported'
          ? `theme ${status.result.report.theme}, view ${view}, variables ${variables}${status.failed.length ? `, failed: ${status.failed.join(', ')}` : ''}`
          : status.state === 'error'
            ? 'error'
            : 'importing…'}{' '}
        · <Link to={`/dev/legacy-render?fixture=${encodeURIComponent(fixture)}`}>upstream version</Link>
      </header>
      {status.state === 'error' ? <pre className={styles.error}>{status.message}</pre> : null}
      {status.state === 'imported' ? (
        view === 'canvas' ? (
          <CanvasDocument key={fixture} result={status.result} />
        ) : (
          <PlainDocument key={fixture} doc={status.result.doc} lang={status.result.meta.lang || 'en'} />
        )
      ) : (
        <div data-render-status={status.state === 'error' ? 'error' : 'loading'} />
      )}
      {status.state === 'imported' ? (
        <details className={styles.report}>
          <summary>Import report</summary>
          <pre data-testid="import-report">{JSON.stringify(status.result.report, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** Waits for fonts and images under `root`, then two frames. */
async function settle(root: HTMLElement): Promise<void> {
  await waitForFonts({ root });
  await settleImages(root);
  await nextFrame();
  await nextFrame();
}

/** The imported document in the editor's canvas, read-only; data-render-status turns "ready" when settled. */
function CanvasDocument({ result }: { result: HbfmImportResult }) {
  const [ready, setReady] = useState(false);
  const [pages, setPages] = useState<number>();
  const [canvasStatus, setCanvasStatus] = useState<CanvasStatus['state']>('loading');
  const [canvasError, setCanvasError] = useState<string>();
  const extensions = useMemo<AnyExtension[]>(() => [EagerImage], []);
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (canvasStatus !== 'ready' || !root) return;
    let cancelled = false;
    void settle(root).then(() => {
      if (cancelled) return;
      setPages(root.querySelectorAll(':scope > .page').length);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [canvasStatus, root]);

  const state = canvasStatus === 'error' ? 'error' : ready ? 'ready' : 'loading';
  return (
    <div className={styles.canvasHost} data-render-status={state} data-page-count={ready ? pages : undefined}>
      {canvasError ? <pre className={styles.error}>{canvasError}</pre> : null}
      <EditorCanvas
        content={result.doc}
        theme={result.report.theme}
        userCss={result.style}
        userCssDelayMs={0}
        lang={result.meta.lang || 'en'}
        editable={false}
        pageShadows={false}
        extensions={extensions}
        onReady={(editor) => setRoot(editor.view.dom)}
        onStatusChange={(s) => {
          setCanvasStatus(s.state);
          if (s.state === 'error') setCanvasError(s.message);
        }}
      />
    </div>
  );
}

/** The imported document in a bare read-only TipTap editor; data-render-status turns "ready" when settled. */
function PlainDocument({ doc, lang }: { doc: JSONContent; lang: string }) {
  const [ready, setReady] = useState(false);
  const extensions = useMemo(() => buildEditorExtensions({ extensions: [EagerImage] }), []);
  const editor = useEditor({ extensions, content: doc, editable: false, shouldRerenderOnTransaction: false });

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    void settle(editor.view.dom).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [editor]);

  return (
    <div data-render-status={ready ? 'ready' : 'loading'} data-page-count={ready ? editor?.view.dom.querySelectorAll(':scope > .page').length : undefined}>
      <EditorContent editor={editor} className={`hb-canvas ${styles.canvas}`} lang={lang} />
    </div>
  );
}
