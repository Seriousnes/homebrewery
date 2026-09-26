// Vitest helper (jsdom): a TipTap editor with paginatedExtensions() on the line-model layout
// (testing.ts), frames and the clock under the test's control. Not used by the app.
import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { buildEditorExtensions } from '../editorExtensions';
import { paginatedExtensions } from '../paginatedExtensions';
import type { PaginationOptions } from './plugin';
import { PAGINATE, isPaginating, paginationKey, type PaginateMeta, type PaginationState } from './state';
import { lineLayout, type LineLayout, type LineLayoutOptions } from './testing';

export interface MountedEditor {
  editor: Editor;
  layout(): LineLayout;
  /** runs the callbacks of one animation frame */
  frame(): void;
  /** runs frames until no pass is left (waiting pages may remain) */
  settle(max?: number): void;
  st(): PaginationState;
  /** PAGINATE metas dispatched since the last call */
  steps(): PaginateMeta[];
  /** puts the cursor (or a selection) at document positions, focused */
  select(anchor: number, head?: number): void;
  /** presses a key through the editor's keymaps (TipTap's keyboardShortcut) */
  press(key: string): void;
  destroy(): void;
}

export function mountPaginated(doc: PMNode, opts: Omit<PaginationOptions, 'layout' | 'requestFrame' | 'cancelFrame'> & { lines?: LineLayoutOptions } = {}): MountedEditor {
  const frames: (() => void)[] = [];
  const { lines, ...options } = opts;
  let layout: LineLayout | null = null;
  const metas: PaginateMeta[] = [];
  const editor = new Editor({
    extensions: buildEditorExtensions({
      extensions: paginatedExtensions({
        layout: (view) => (layout = lineLayout(() => view.state.doc, lines)),
        requestFrame: (callback) => frames.push(callback),
        cancelFrame: () => {},
        ...options,
      }),
    }),
    content: doc.toJSON() as Record<string, unknown>,
  });
  editor.on('transaction', ({ transaction }) => {
    const meta = transaction.getMeta(PAGINATE) as PaginateMeta | undefined;
    if (meta) metas.push(meta);
  });
  const m: MountedEditor = {
    editor,
    layout: () => layout!,
    frame() {
      for (const callback of frames.splice(0)) callback();
    },
    settle(max = 2000) {
      for (let n = 0; isPaginating(editor.state); n++) {
        if (n > max) throw new Error('not settled');
        m.frame();
      }
    },
    st: () => paginationKey.getState(editor.state)!,
    steps: () => metas.splice(0),
    select(anchor, head = anchor) {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)));
    },
    press(name) {
      // A real keydown through ProseMirror's keymaps (selection changes and metas included;
      // TipTap's keyboardShortcut command keeps only the steps). jsdom is not a Mac: Mod = Ctrl.
      const parts = name.split(/-(?!$)/);
      const key = parts[parts.length - 1]!;
      const mods = new Set(parts.slice(0, -1));
      const event = new KeyboardEvent('keydown', {
        key,
        shiftKey: mods.has('Shift'),
        ctrlKey: mods.has('Ctrl') || mods.has('Mod'),
        altKey: mods.has('Alt'),
        metaKey: mods.has('Meta'),
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(event);
    },
    destroy: () => editor.destroy(),
  };
  return m;
}
