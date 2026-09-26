// PageObjects (P5.3): object selection state plus the ObjectLayer (selection frame, handles,
// toolbar, in-place text editing). Add it to an editing canvas:
//
//   const extensions = useMemo(() => [PageObjects, …], []);
//   <EditorCanvas extensions={extensions} … />
//
// The layer only acts in editable views. Other code reads the selection with
// selectedObject(editor.state) and drives the layer with objectLayerOf(editor).
import { Extension, type Editor } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { canvasZoom } from '../canvas/canvasState';
import { ObjectLayer } from '../nodeviews/ObjectLayer';
import { applyObjectSelection, objectSelectionKey, type ObjectSelectionState } from './state';

const layers = new WeakMap<EditorView, ObjectLayer>();

/** The object layer of an editor (null without the PageObjects extension). */
export function objectLayerOf(editor: Editor | null | undefined): ObjectLayer | null {
  if (!editor || editor.isDestroyed) return null;
  return layers.get(editor.view) ?? null;
}

export const PageObjects = Extension.create({
  name: 'hbPageObjects',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<ObjectSelectionState>({
        key: objectSelectionKey,
        state: {
          init: () => ({ selected: null }),
          apply: (tr, prev) => applyObjectSelection(tr, prev),
        },
        view: (view) => {
          const layer = new ObjectLayer(view, { zoom: () => canvasZoom(editor) });
          layers.set(view, layer);
          return {
            update: (v) => layer.update(v),
            destroy: () => {
              layers.delete(view);
              layer.destroy();
            },
          };
        },
      }),
    ];
  },
});
