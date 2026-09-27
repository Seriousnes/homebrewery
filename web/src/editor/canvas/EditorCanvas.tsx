// EditorCanvas (P3.3, plan §5): the WYSIWYG editing surface.
//
//   div.viewport (scroll container)                     EditorCanvas.module.css
//     div.sizer (scaled size, useCanvasZoom)
//       div.hb-canvas[lang][data-spread]  (transform: scale(zoom))
//         div.pages.ProseMirror          (TipTap root: only pages as children)
//           div.page …                   (PageView)
//
// It owns the TipTap editor (schema + PageView + canvas state + paste cleanup + column
// navigation + `extensions`), the theme chain and the brew's CSS (useCanvasTheme), the fonts
// gate (isCanvasReady), zoom (useCanvasZoom), spreads, page shadows and print styles. The pages
// stay hidden until the theme is first applied.
import type { AnyExtension, Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { clsx } from 'clsx';
import { useCallback, useEffect, useEffectEvent, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { buildEditorExtensions } from '../editorExtensions';
import { editorNodeViews } from '../nodeviews';
import './canvas.css';
import { CanvasState, isCanvasReady, requestRepagination, setCanvasZoom, type CanvasGate } from './canvasState';
import { ColumnNavigation } from './columnNavigation';
import styles from './EditorCanvas.module.css';
import { probeSkippedLayout, skippedLayoutAnswer } from './offscreen';
import { ExternalPaste } from './pasteCleanup';
import { printCanvas } from './print';
import { REPAGINATE_DELAY_MS, USER_CSS_DELAY_MS, useCanvasTheme, type CanvasStatus, type RepaginateEvent } from './useCanvasTheme';
import { clampZoom, useCanvasZoom, type CanvasSpread } from './useCanvasZoom';

export interface EditorCanvasHandle {
  editor: Editor;
  /** The .hb-canvas element. */
  canvas: HTMLElement | null;
  /** The scroll container around it. */
  viewport: HTMLElement | null;
  /** Theme, CSS and fonts applied: the paginator's gate (same as isCanvasReady(editor)). */
  isReady: () => boolean;
  /** Dispatches the REPAGINATE meta from page `from` (default 0). */
  repaginate: (from?: number) => void;
  /** Waits for lazy images and opens the print dialog (print styles show only the pages). */
  print: () => Promise<void>;
}

export interface EditorCanvasProps {
  /** Initial document (ProseMirror JSON). Read when the editor is created only. */
  content: JSONContent;
  /** Theme key ('5ePHB') or user theme id. */
  theme: string;
  /** The brew's own CSS (Style tab), scoped to the canvas. */
  userCss?: string;
  /** Delay before user CSS edits restyle the canvas (ms, default 150). */
  userCssDelayMs?: number;
  /**
   * Debounce of the repagination from page 0 that a theme or user CSS change triggers (plan §4.7;
   * ms, default 300): dispatched once the change is applied and fonts are ready, and no sooner
   * than this long after the last theme or user CSS change. The first load repaginates at once.
   */
  repaginateDelayMs?: number;
  /** lang of the brew, on .hb-canvas (hyphenation, quotes). */
  lang?: string;
  /** 1 = 100%. */
  zoom?: number;
  spread?: CanvasSpread;
  /** facing: first page on the right, like a book's cover (default true, as upstream). */
  startOnRight?: boolean;
  pageShadows?: boolean;
  editable?: boolean;
  /**
   * More extensions: NodeViews replace the extension with the same name, others are added
   * (pagination, keymaps …). Memoize the array: a new array re-creates the editor.
   */
  extensions?: AnyExtension[];
  /** Where theme styles come from (default 'auto': API bundle, then the static catalog). */
  themeSource?: 'auto' | 'api' | 'static';
  /** Gets this canvas's editor attached, for extensions created before it (the paginator). */
  gate?: CanvasGate;
  /** Called once per editor instance, after it is mounted. */
  onReady?: (editor: Editor, handle: EditorCanvasHandle) => void;
  onStatusChange?: (status: CanvasStatus) => void;
  /** Called after every REPAGINATE dispatch the canvas makes (theme, CSS, fonts). */
  onRepaginate?: (event: RepaginateEvent) => void;
  className?: string;
  ref?: Ref<EditorCanvasHandle | null>;
}

export function EditorCanvas({
  content,
  theme,
  userCss = '',
  userCssDelayMs = USER_CSS_DELAY_MS,
  repaginateDelayMs = REPAGINATE_DELAY_MS,
  lang = 'en',
  zoom = 1,
  spread = 'single',
  startOnRight = true,
  pageShadows = true,
  editable = true,
  extensions,
  themeSource,
  gate,
  onReady,
  onStatusChange,
  onRepaginate,
  className,
  ref,
}: EditorCanvasProps) {
  const allExtensions = useMemo(
    () => buildEditorExtensions({ extensions: [...editorNodeViews, CanvasState, ExternalPaste, ColumnNavigation, ...(extensions ?? [])] }),
    [extensions],
  );

  const editor = useEditor(
    {
      extensions: allExtensions,
      content,
      editable,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
    },
    [allExtensions],
  );

  // Offscreen pages skip rendering where layout queries still see them (offscreen.ts, P8.1): once
  // the browser has answered (pages stay visible until then).
  const [skipOffscreen, setSkipOffscreen] = useState(() => skippedLayoutAnswer() === true);
  useEffect(() => {
    let alive = true;
    void probeSkippedLayout().then((skip) => {
      if (alive) setSkipOffscreen(skip);
    });
    return () => {
      alive = false;
    };
  }, []);
  const onZoomApplied = useCallback((z: number) => setCanvasZoom(editor, z), [editor]);
  const { viewportRef, sizerRef, canvasRef } = useCanvasZoom(zoom, spread, onZoomApplied);
  const slot = `canvas-${useId()}`;
  const onRepaginateLatest = useRef(onRepaginate);
  useEffect(() => {
    onRepaginateLatest.current = onRepaginate;
  });

  useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);

  const getCanvas = useCallback(() => canvasRef.current, [canvasRef]);
  const status = useCanvasTheme({
    editor,
    theme,
    userCss,
    userCssDelayMs,
    repaginateDelayMs,
    themeSource,
    slot,
    canvas: getCanvas,
    onStatusChange,
    onRepaginate,
  });
  // The pages stay invisible until the theme, the brew's CSS and the fonts have first been applied
  // (or failed), so a brew never shows unstyled. Later theme or CSS changes keep them visible.
  const [revealed, setRevealed] = useState(false);
  if (!revealed && status.state !== 'loading') setRevealed(true);

  const handle = useMemo<EditorCanvasHandle>(
    () => ({
      editor,
      get canvas() {
        return canvasRef.current;
      },
      get viewport() {
        return viewportRef.current;
      },
      isReady: () => isCanvasReady(editor),
      repaginate: (from = 0) => {
        if (requestRepagination(editor, from)) onRepaginateLatest.current?.({ from, reason: 'manual' });
      },
      print: () => (canvasRef.current ? printCanvas(canvasRef.current) : Promise.resolve()),
    }),
    [editor, canvasRef, viewportRef],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  useEffect(() => {
    if (!gate) return;
    gate.attach(editor);
    return () => gate.attach(null);
  }, [gate, editor]);

  // useEditor (immediatelyRender) schedules the destruction of a new editor 1 ms after rendering it, cancelled
  // by its effect. When a concurrent render yields before the commit (a lazy route loading in a transition), the
  // timer wins: this commit's editor is already destroyed (its view gone) and a new one follows in the next
  // render. Only a live editor is ready.
  const notifyReady = useEffectEvent(() => {
    if (!editor.isDestroyed) onReady?.(editor, handle);
  });
  useEffect(() => {
    notifyReady();
  }, [editor, handle]);

  return (
    <div ref={viewportRef} className={clsx(styles.viewport, className)} data-canvas-status={status.state} data-canvas-theme={status.theme}>
      <div ref={sizerRef} className={clsx(styles.sizer, !revealed && styles.unstyled)}>
        <EditorContent
          editor={editor}
          ref={canvasRef}
          className={clsx('hb-canvas', styles.canvas, pageShadows && styles.shadows)}
          lang={lang}
          data-spread={spread}
          data-recto={spread === 'facing' && startOnRight ? '' : undefined}
          data-zoom={clampZoom(zoom)}
          data-hb-offscreen={skipOffscreen ? 'skip' : undefined}
        />
      </div>
    </div>
  );
}
