// A small test API for the app's editor pages (dev builds only; the e2e flows read it). Production
// builds leave it out: the condition is compile-time.
import type { Editor } from '@tiptap/core';
import type { EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import { isSettled } from '@/editor/pagination';
import type { AutosaveState } from '@/editor/save';

export interface EditorAppDevApi {
  editor: Editor;
  handle: EditorCanvasHandle;
  /** Theme, CSS and fonts applied and pagination idle. */
  settled: () => boolean;
  /** The autosave state (status, editId, baseVersion, …). */
  save: () => AutosaveState | null;
}

declare global {
  interface Window {
    __hbEditorApp?: EditorAppDevApi;
  }
}

export const DEV_API_ENABLED: boolean = import.meta.env.DEV;

/** Publishes the editor for e2e tests; returns the cleanup. */
export function exposeEditorApp(editor: Editor, handle: EditorCanvasHandle, save: () => AutosaveState | null): () => void {
  if (!DEV_API_ENABLED) return () => {};
  const api: EditorAppDevApi = {
    editor,
    handle,
    settled: () => handle.isReady() && !editor.isDestroyed && isSettled(editor.state),
    save,
  };
  window.__hbEditorApp = api;
  return () => {
    if (window.__hbEditorApp === api) delete window.__hbEditorApp;
  };
}
