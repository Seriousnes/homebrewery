// DOM measurements for object commands: where an element sits on its page, in page pixels
// (the coordinate space of an object's left/top: the page's padding box, unscaled by the zoom).
import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { canvasZoom } from '../canvas/canvasState';
import type { NewObjectPlacement } from './model';

/** The rectangle of `el` relative to the page element at `pagePos`, divided by the zoom. */
export function placementInPage(view: EditorView, el: Element, pagePos: number, zoom: number): Required<NewObjectPlacement> | null {
  const pageEl = view.nodeDOM(pagePos);
  if (!(pageEl instanceof HTMLElement)) return null;
  const page = pageEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const z = zoom > 0 ? zoom : 1;
  return {
    left: Math.round((r.left - page.left) / z - pageEl.clientLeft),
    top: Math.round((r.top - page.top) / z - pageEl.clientTop),
    width: Math.round(r.width / z),
    height: Math.round(r.height / z),
  };
}

/** Where the inline image at `imagePos` is on its page (for 'Place freely'). */
export function imagePlacement(editor: Editor, imagePos: number, pagePos: number): Required<NewObjectPlacement> | null {
  const img = editor.view.nodeDOM(imagePos);
  if (!(img instanceof Element)) return null;
  return placementInPage(editor.view, img, pagePos, canvasZoom(editor));
}
