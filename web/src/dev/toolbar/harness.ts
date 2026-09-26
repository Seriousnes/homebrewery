// The /dev/toolbar test API (window.__hbToolbar), mirrored in web/e2e/toolbar/helpers.ts.
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import { isSettled } from '@/editor/pagination';

export interface ToolbarHarnessApi {
  editor: Editor;
  handle: EditorCanvasHandle;
  /** Keymap requests the page handled ('save', 'print'), in order. */
  requests: string[];
  /** EditorToolbar renders (React Profiler commits). */
  toolbarRenders: number;
  /** Pagination idle. */
  settled(): boolean;
  /** Selects `text` (occurrence `n`), or puts the cursor `offset` characters into it; focuses the editor. */
  select(text: string, offset?: number, n?: number): { from: number; to: number };
  /** The document without page pids. */
  json(): JSONContent;
  /** Page count. */
  pages(): number;
  undoDepth(): number;
  /** Text of every page. */
  pageTexts(): string[];
  /** Marks on the first character of `text`. */
  marksAt(text: string): { type: string; attrs: Record<string, unknown> }[];
  /** Type (and attrs) of the text block holding `text`, and its ancestors' types below the page (innermost first). */
  blockOf(text: string): { type: string; attrs: Record<string, unknown>; ancestors: string[] };
}

declare global {
  interface Window {
    __hbToolbar?: ToolbarHarnessApi;
  }
}

function posOf(editor: Editor, needle: string, n = 0): number {
  let found = -1;
  let seen = 0;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText) {
      for (let i = node.text!.indexOf(needle); i >= 0; i = node.text!.indexOf(needle, i + 1)) {
        if (seen++ === n) {
          found = pos + i;
          return false;
        }
      }
    }
    return true;
  });
  if (found < 0) throw new Error(`"${needle}" not found`);
  return found;
}

export function createHarness(editor: Editor, handle: EditorCanvasHandle): ToolbarHarnessApi {
  return {
    editor,
    handle,
    requests: [],
    toolbarRenders: 0,
    settled: () => isSettled(editor.state),
    select(text, offset, n = 0) {
      const from = posOf(editor, text, n);
      const selection =
        offset === undefined ? TextSelection.create(editor.state.doc, from, from + text.length) : TextSelection.create(editor.state.doc, from + offset);
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
      return { from: selection.from, to: selection.to };
    },
    json() {
      const json = editor.getJSON();
      for (const page of json.content ?? []) if (page.attrs) delete page.attrs.pid;
      return json;
    },
    pages: () => editor.state.doc.childCount,
    undoDepth: () => Number(undoDepth(editor.state)),
    pageTexts() {
      const out: string[] = [];
      editor.state.doc.forEach((page) => out.push(page.textContent));
      return out;
    },
    marksAt(text) {
      const node = editor.state.doc.nodeAt(posOf(editor, text));
      return (node?.marks ?? []).map((m) => ({ type: m.type.name, attrs: { ...m.attrs } }));
    },
    blockOf(text) {
      const $pos = editor.state.doc.resolve(posOf(editor, text) + 1);
      const ancestors: string[] = [];
      for (let d = $pos.depth - 1; d > 1; d--) ancestors.push($pos.node(d).type.name);
      return { type: $pos.parent.type.name, attrs: { ...$pos.parent.attrs }, ancestors };
    },
  };
}
