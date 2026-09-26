// The import preview (plan §7, P6.3): the converted document in a read-only, paginated
// EditorCanvas with the brew's theme and CSS, zoomed to fit its box. Pagination runs as in the
// editor, so pages that clipped upstream flow onto new auto pages here; every time the layout
// settles, onSettled gets the document, for recordPaginatedPages (the report's "grew into" counts).
//
// Heavy (TipTap, pagination, NodeViews): load it with LazyImportPreview.
import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { viewingExtensions } from '@/editor/EditorApp/editorAppExtensions';
import { isSettled } from '@/editor/pagination';
import { DEFAULT_PAGE_WIDTH, fitZoom } from './fitZoom';
import styles from './ImportPreview.module.css';

export interface ImportPreviewSettled {
  /** The paginated document (ProseMirror node; recordPaginatedPages takes it). */
  doc: PMNode;
  /** The same document as JSON (what a create request sends). */
  json: () => JSONContent;
}

export interface ImportPreviewProps {
  /** The converted document. Read once: mount a new preview (a new key) for another import. */
  doc: JSONContent;
  theme: string;
  /** The brew's CSS (scoped to the canvas). */
  style: string;
  lang: string;
  /** After every settled layout (the first one, and again after images or fonts moved pages). */
  onSettled?: (settled: ImportPreviewSettled) => void;
  onStatusChange?: (status: CanvasStatus) => void;
  /** The scrollable region's name (default 'Preview of the imported brew'). */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

/** Frames the layout must stay settled before it counts (pagination steps one frame at a time). */
const STABLE_FRAMES = 2;

export function ImportPreview({
  doc,
  theme,
  style,
  lang,
  onSettled,
  onStatusChange,
  label = 'Preview of the imported brew',
  className,
  'data-testid': testId = 'import-preview',
}: ImportPreviewProps) {
  const [initialDoc] = useState(doc);
  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo(() => viewingExtensions(gate, 'Imported brew'), [gate]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [handle, setHandle] = useState<EditorCanvasHandle | null>(null);
  const [status, setStatus] = useState<CanvasStatus['state']>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  const onSettledRef = useRef(onSettled);
  const onStatusRef = useRef(onStatusChange);
  useEffect(() => {
    onSettledRef.current = onSettled;
    onStatusRef.current = onStatusChange;
  });

  // Fit one page into the box's width (the page width comes from the theme once it is ready).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const page = handle?.canvas?.querySelector<HTMLElement>(':scope .page');
      const pageWidth = page?.offsetWidth || DEFAULT_PAGE_WIDTH;
      setZoom(fitZoom(host.clientWidth, pageWidth));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [handle, status]);

  // Settled: the canvas is ready (theme, CSS, fonts) and pagination has nothing left to do for a
  // few frames. Any later transaction (an image or font moved a page) starts watching again.
  useEffect(() => {
    if (!editor || !handle || status !== 'ready') return;
    let frame = 0;
    let stable = 0;
    let reported: PMNode | null = null;
    const tick = () => {
      frame = 0;
      if (editor.isDestroyed) return;
      if (handle.isReady() && isSettled(editor.state)) {
        stable++;
        if (stable >= STABLE_FRAMES) {
          const current = editor.state.doc;
          if (current !== reported) {
            reported = current;
            setSettled(true);
            onSettledRef.current?.({ doc: current, json: () => editor.getJSON() });
          }
          return;
        }
      } else {
        stable = 0;
      }
      frame = requestAnimationFrame(tick);
    };
    const onTransaction = () => {
      stable = 0;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    editor.on('transaction', onTransaction);
    frame = requestAnimationFrame(tick);
    return () => {
      editor.off('transaction', onTransaction);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, handle, status]);

  // Read-only: nothing in the canvas takes the focus, so the scroll container does (keyboard
  // scrolling; axe scrollable-region-focusable), as the share page's viewer.
  useEffect(() => {
    const viewport = handle?.viewport;
    if (!viewport) return;
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', label);
    return () => {
      viewport.removeAttribute('tabindex');
      viewport.removeAttribute('role');
      viewport.removeAttribute('aria-label');
    };
  }, [handle, label]);

  return (
    <div
      ref={hostRef}
      className={clsx(styles.preview, className)}
      data-testid={testId}
      data-canvas-status={status}
      data-settled={settled ? 'true' : 'false'}
      data-zoom={zoom}
    >
      <EditorCanvas
        className={styles.canvas}
        content={initialDoc}
        theme={theme}
        userCss={style}
        userCssDelayMs={0}
        lang={lang || 'en'}
        zoom={zoom}
        editable={false}
        gate={gate}
        extensions={extensions}
        onReady={(next, nextHandle) => {
          setEditor(next);
          setHandle(nextHandle);
        }}
        onStatusChange={(next) => {
          setStatus(next.state);
          setErrorMessage(next.state === 'error' ? next.message : null);
          onStatusRef.current?.(next);
        }}
      />
      {errorMessage ? (
        <p className={styles.error} role="alert">
          The preview could not load the theme: {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

export default ImportPreview;
