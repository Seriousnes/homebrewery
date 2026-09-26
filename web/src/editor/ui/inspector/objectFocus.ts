// "Select → focus the object" for the inspector's objects list (plan §4.9). The objects lane
// (P5.3, web/src/editor/objects) owns selecting, moving and resizing objects on the canvas:
//
//   focusPageObject      the Inspector's default. With the PageObjects extension installed it
//                        selects the object (objects/commands selectObject) and focuses the
//                        layer's selection frame, where the arrow keys move it. Without it, it
//                        scrolls the object's element into view and focuses it if it can take
//                        focus. Either way it then dispatches OBJECT_SELECT_EVENT.
//   OBJECT_SELECT_EVENT  a bubbling CustomEvent<PageObjectRef> on the object's element (PageView
//                        renders it with data-object-id inside the page's chrome), for hosts that
//                        want to react to the inspector's selection.
// Pass Inspector `onSelectObject` to replace all of this.
import type { Editor } from '@tiptap/core';
import { OBJECT_ID_ATTR } from '@/editor/nodeviews/PageView';
import { selectObject } from '@/editor/objects/commands';
import { objectLayerOf } from '@/editor/objects/extension';
import { pageAt } from '@/editor/pagination/boundary';

export const OBJECT_SELECT_EVENT = 'hb:select-object';

export interface PageObjectRef {
  /** 0-based page index. */
  pageIndex: number;
  /** PageObject.id */
  id: string;
}

/** The element PageView rendered for object `id` on page `pageIndex`, if it is in the DOM. */
export function pageObjectElement(editor: Editor, ref: PageObjectRef): HTMLElement | null {
  if (editor.isDestroyed) return null;
  const page = pageAt(editor.state.doc, ref.pageIndex);
  if (!page) return null;
  const dom = editor.view.nodeDOM(page.pos);
  if (!(dom instanceof HTMLElement)) return null;
  for (const el of Array.from(dom.querySelectorAll<HTMLElement>(`[${OBJECT_ID_ATTR}]`))) {
    if (el.getAttribute(OBJECT_ID_ATTR) === ref.id) return el;
  }
  return null;
}

/**
 * Selects page object `ref` on the canvas and moves focus to it (see the top of this file).
 * Returns false when the object has no element.
 */
export function focusPageObject(editor: Editor, ref: PageObjectRef): boolean {
  const el = pageObjectElement(editor, ref);
  const page = pageAt(editor.state.doc, ref.pageIndex);
  if (!el || !page) return false;
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  const layer = objectLayerOf(editor);
  if (layer && selectObject({ pagePos: page.pos, id: ref.id })(editor.state, (tr) => editor.view.dispatch(tr))) layer.focusFrame();
  else if (el.hasAttribute('tabindex')) el.focus({ preventScroll: true });
  el.dispatchEvent(new CustomEvent<PageObjectRef>(OBJECT_SELECT_EVENT, { bubbles: true, detail: ref }));
  return true;
}
