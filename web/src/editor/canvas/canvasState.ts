// Canvas state shared with other editor lanes through the editor (P3.3).
//
// EditorCanvas adds the `hbCanvas` extension to its editor and keeps its storage current:
//
//   isCanvasReady(editor)   true once the theme chain, user CSS and fonts are applied: the
//                           paginator's gate. The paginator is configured before the editor
//                           exists, so it takes a CanvasGate:
//                             const gate = createCanvasGate();
//                             const extensions = [Pagination.configure({ isReady: gate.isReady })];
//                             <EditorCanvas gate={gate} extensions={extensions} … />
//   canvasZoom(editor)      the transform scale of .hb-canvas (1 = 100%)
//   requestRepagination(editor, from)
//                           dispatches the REPAGINATE meta (page index `from`); EditorCanvas does
//                           it after a theme or CSS change and after fonts load.
import { Extension, type Editor } from '@tiptap/core';
import { REPAGINATE } from '../pagination/state';

/**
 * Transaction meta: force a pagination check from page N (pagination/state.ts, plan §4.7).
 */
export const REPAGINATE_META: typeof REPAGINATE = REPAGINATE;

export type RepaginateReason = 'theme' | 'css' | 'fonts' | 'manual';

export interface HbCanvasStorage {
  /** Theme chain, user CSS and fonts are applied: layout can be measured. */
  ready: boolean;
  /** The theme the canvas shows (or is loading). */
  theme: string | null;
  /** Transform scale of .hb-canvas. */
  zoom: number;
  /** Increments on every requestRepagination (tests, diagnostics). */
  repaginations: number;
}

declare module '@tiptap/core' {
  interface Storage {
    hbCanvas: HbCanvasStorage;
  }
}

export const CanvasState = Extension.create<Record<string, never>, HbCanvasStorage>({
  name: 'hbCanvas',

  addStorage() {
    return { ready: false, theme: null, zoom: 1, repaginations: 0 };
  },
});

function storage(editor: Editor | null | undefined): HbCanvasStorage | undefined {
  if (!editor || editor.isDestroyed) return undefined;
  return (editor.storage as Partial<Record<'hbCanvas', HbCanvasStorage>>).hbCanvas;
}

/**
 * The fonts/theme gate for layout work. true for an editor without EditorCanvas (tests, headless
 * editors), so the paginator never waits forever there.
 */
export function isCanvasReady(editor: Editor | null | undefined): boolean {
  const s = storage(editor);
  return s ? s.ready : true;
}

export function canvasZoom(editor: Editor | null | undefined): number {
  return storage(editor)?.zoom ?? 1;
}

/** Marks the canvas (not) ready. EditorCanvas calls this; others only read it. */
export function setCanvasReady(editor: Editor | null | undefined, ready: boolean, theme?: string): void {
  const s = storage(editor);
  if (!s) return;
  s.ready = ready;
  if (theme !== undefined) s.theme = theme;
}

/**
 * The fonts/theme gate for an editor that doesn't exist yet: pass `gate.isReady` to the
 * paginator and `gate` to EditorCanvas, which attaches its editor. Not ready until attached.
 */
export interface CanvasGate {
  isReady: () => boolean;
  attach: (editor: Editor | null) => void;
}

export function createCanvasGate(): CanvasGate {
  let attached: Editor | null = null;
  return {
    isReady: () => attached !== null && !attached.isDestroyed && isCanvasReady(attached),
    attach: (editor) => {
      attached = editor;
    },
  };
}

export function setCanvasZoom(editor: Editor | null | undefined, zoom: number): void {
  const s = storage(editor);
  if (s) s.zoom = zoom;
}

/**
 * Dispatches a transaction with the REPAGINATE meta (`from` = first page index to re-check),
 * outside the undo history. Returns false when the editor is gone.
 */
export function requestRepagination(editor: Editor | null | undefined, from = 0): boolean {
  if (!editor || editor.isDestroyed) return false;
  const tr = editor.state.tr.setMeta(REPAGINATE_META, from).setMeta('addToHistory', false);
  editor.view.dispatch(tr);
  const s = storage(editor);
  if (s) s.repaginations++;
  return true;
}
