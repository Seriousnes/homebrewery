import type { EditorState, PluginView, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * A plugin `view` factory that runs `fix` once, right after the editor is mounted, and dispatches
 * its transaction. appendTransaction only sees later changes, so documents loaded without ids
 * need this first pass. Runs in a microtask so the editor is fully constructed.
 */
export function runOnceAfterInit(fix: (state: EditorState) => Transaction | null) {
  return (view: EditorView): PluginView => {
    let destroyed = false;
    queueMicrotask(() => {
      if (destroyed || view.isDestroyed) return;
      const tr = fix(view.state);
      if (tr) view.dispatch(tr);
    });
    return {
      destroy() {
        destroyed = true;
      },
    };
  };
}
