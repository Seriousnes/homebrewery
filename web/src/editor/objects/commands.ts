// Page object commands (P5.3, plan §4.9) and the cover marker of the cover-page workflow (page
// breaks are commands/sections.ts insertPageBreak).
// Plain ProseMirror commands; every one is a single transaction (one undo step). Object changes
// are one attribute step on the page (setPageAttr: an AttrStep, or on an auto page a
// PageAttrStep whose undo survives pagination's boundary moves), and objects are out of the flow,
// so pagination re-measures the page but moves nothing. Pages that carry objects survive pulls
// (pagination/boundary.ts). An auto page kept only for its objects (isPlaceholderPage) goes with
// its last object in the same step: pagination would otherwise remove it outside the history, and
// the undo would have no page to bring the object back to (review finding UI-1).
//
// DOM measurements (where an image sits on its page, where a dragged object ends up) are made by
// the caller (ObjectLayer, BlockMenu) and passed in as page pixels.
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, type Command, type EditorState, type Transaction } from '@tiptap/pm/state';
import { isAutoPage, isPlaceholderPage } from '../pagination/boundary';
import type { PageObject } from '../schema';
import {
  coverOf,
  findObject,
  imageObject,
  imageStyleFromObject,
  newObjectId,
  objectsOf,
  objectStyleFromImage,
  patchObject,
  removeObject,
  reorderObject,
  textObject,
  withCover,
  type CoverMarker,
  type NewObjectPlacement,
  type ZOrderMove,
} from './model';
import { setPageAttr } from './pageAttrStep';
import { OBJECT_SELECTION, pageNodeAt, type ObjectRef } from './state';

/** Where new objects go when nothing better is known: 1 inch in from the page's corner. */
export const DEFAULT_PLACEMENT: NewObjectPlacement = { left: 96, top: 96 };

/** The page (position and node) around `pos`, or null. */
export function pageAround(doc: PMNode, pos: number): { pagePos: number; page: PMNode } | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.depth >= 1) return { pagePos: $pos.before(1), page: $pos.node(1) };
  const after = $pos.nodeAfter;
  if (after?.type.name === 'page') return { pagePos: $pos.pos, page: after };
  const before = $pos.nodeBefore;
  if (before?.type.name === 'page') return { pagePos: $pos.pos - before.nodeSize, page: before };
  return null;
}

/** The page of the selection (its head). */
export function selectionPage(state: EditorState): { pagePos: number; page: PMNode } | null {
  return pageAround(state.doc, state.selection.head);
}

function setObjects(tr: Transaction, pagePos: number, objects: PageObject[]): Transaction {
  return setPageAttr(tr, pagePos, 'objects', objects);
}

/**
 * Whether removing object `id` leaves the page at `pagePos` with nothing to keep it: an auto page
 * kept only for its objects (empty flow) whose last object this is. Pagination removes such a page;
 * the commands remove it themselves, in the author's step.
 */
function goesWithLastObject(doc: PMNode, pagePos: number, page: PMNode, id: string): boolean {
  if (!isAutoPage(page) || !isPlaceholderPage(page) || pagePos <= 0 || doc.childCount < 2) return false;
  // Markers keep the page too (pagination/boundary.ts carriesPageData, PGR-5).
  if (Array.isArray(page.attrs.markers) && page.attrs.markers.length > 0) return false;
  const objects = objectsOf(page.attrs);
  return objects.length === 1 && objects[0]!.id === id;
}

/** Deletes the page at `pagePos`; a caret on it goes to the end of the page before. */
function deletePage(tr: Transaction, pagePos: number, page: PMNode): Transaction {
  const inside = tr.selection.from >= pagePos && tr.selection.to <= pagePos + page.nodeSize;
  tr.delete(pagePos, pagePos + page.nodeSize);
  if (inside) tr.setSelection(Selection.near(tr.doc.resolve(pagePos), -1));
  return tr;
}

/** Selects an object (or clears the selection with null): no document change, no history. */
export function selectObject(ref: ObjectRef | null): Command {
  return (state, dispatch) => {
    if (ref && !findObject(objectsOf(pageNodeAt(state.doc, ref.pagePos)?.attrs ?? {}), ref.id)) return false;
    dispatch?.(state.tr.setMeta(OBJECT_SELECTION, ref).setMeta('addToHistory', false));
    return true;
  };
}

/** Changes an object's fields (style, text, classes, src). */
export function updateObject(ref: ObjectRef, patch: Partial<Omit<PageObject, 'id'>>): Command {
  return (state, dispatch) => {
    const page = pageNodeAt(state.doc, ref.pagePos);
    if (!page) return false;
    const next = patchObject(objectsOf(page.attrs), ref.id, patch);
    if (!next) return false;
    dispatch?.(setObjects(state.tr, ref.pagePos, next).setMeta(OBJECT_SELECTION, ref));
    return true;
  };
}

export function deleteObject(ref: ObjectRef): Command {
  return (state, dispatch) => {
    const page = pageNodeAt(state.doc, ref.pagePos);
    if (!page) return false;
    const next = removeObject(objectsOf(page.attrs), ref.id);
    if (!next) return false;
    if (!dispatch) return true;
    const tr = state.tr.setMeta(OBJECT_SELECTION, null);
    if (goesWithLastObject(state.doc, ref.pagePos, page, ref.id)) deletePage(tr, ref.pagePos, page);
    else setObjects(tr, ref.pagePos, next);
    dispatch(tr);
    return true;
  };
}

export function moveObjectInZOrder(ref: ObjectRef, move: ZOrderMove): Command {
  return (state, dispatch) => {
    const page = pageNodeAt(state.doc, ref.pagePos);
    if (!page) return false;
    const next = reorderObject(objectsOf(page.attrs), ref.id, move);
    if (!next) return false;
    dispatch?.(setObjects(state.tr, ref.pagePos, next).setMeta(OBJECT_SELECTION, ref));
    return true;
  };
}

/** Adds an object to a page and selects it. `make` gets a fresh id. */
export function addObject(pagePos: number, make: (id: string) => PageObject): Command {
  return (state, dispatch) => {
    const page = pageNodeAt(state.doc, pagePos);
    if (!page) return false;
    const objects = objectsOf(page.attrs);
    const object = make(newObjectId(objects));
    if (dispatch) {
      const tr = setObjects(state.tr, pagePos, [...objects, object]).setMeta(OBJECT_SELECTION, { pagePos, id: object.id });
      dispatch(tr);
    }
    return true;
  };
}

/** A new image object on the selection's page. */
export function addImageObject(src: string, at: NewObjectPlacement = { ...DEFAULT_PLACEMENT, width: 300 }): Command {
  return (state, dispatch) => {
    const target = selectionPage(state);
    if (!target || !src.trim()) return false;
    return addObject(target.pagePos, (id) => imageObject(id, src.trim(), at))(state, dispatch);
  };
}

/** A new text object on the selection's page. */
export function addTextObject(text = 'Text', at: NewObjectPlacement = DEFAULT_PLACEMENT, classes: string[] = []): Command {
  return (state, dispatch) => {
    const target = selectionPage(state);
    if (!target) return false;
    return addObject(target.pagePos, (id) => textObject(id, text, at, classes))(state, dispatch);
  };
}

// ---------------------------------------------------------------------------------------------
// Inline image ⇄ page object
// ---------------------------------------------------------------------------------------------

/** The inline image the selection points at (a node selection), or null. */
export function selectedImage(state: EditorState): { pos: number; node: PMNode } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === 'image') return { pos: sel.from, node: sel.node };
  return null;
}

/**
 * 'Place freely': the inline image at `imagePos` leaves the text and becomes a page object at
 * `at` (page px, measured by the caller where the image was). Its classes and style come along,
 * minus what only made sense in the flow (float, margins).
 */
export function placeImageFreely(imagePos: number, at: NewObjectPlacement): Command {
  return (state, dispatch) => {
    const image = state.doc.nodeAt(imagePos);
    if (image?.type.name !== 'image' || typeof image.attrs.src !== 'string' || !image.attrs.src) return false;
    const target = pageAround(state.doc, imagePos);
    if (!target) return false;
    const objects = objectsOf(target.page.attrs);
    const id = newObjectId(objects);
    const object: PageObject = {
      id,
      kind: 'image',
      classes: Array.isArray(image.attrs.classes) ? [...(image.attrs.classes as string[])] : [],
      style: objectStyleFromImage(image.attrs.style as string | null, at),
      src: image.attrs.src,
    };
    if (dispatch) {
      const tr = closeHistory(state.tr).delete(imagePos, imagePos + image.nodeSize);
      // The page starts before the image, so its position is unchanged.
      setObjects(tr, target.pagePos, [...objects, object]).setMeta(OBJECT_SELECTION, { pagePos: target.pagePos, id });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** A text position on page `pagePos` where an inline image fits, near `hint` when given. */
function inlinePositionOnPage(doc: PMNode, pagePos: number, hint: number | null): number | null {
  const page = pageNodeAt(doc, pagePos);
  if (!page) return null;
  const start = pagePos + 1;
  const end = pagePos + page.nodeSize - 1;
  if (hint !== null && hint >= start && hint <= end) {
    const $hint = doc.resolve(hint);
    if ($hint.parent.inlineContent && $hint.parent.type.contentMatch.matchType(doc.type.schema.nodes.image!)) return hint;
  }
  let found: number | null = null;
  page.descendants((node, offset) => {
    if (found !== null) return false;
    if (node.isTextblock && node.type.contentMatch.matchType(doc.type.schema.nodes.image!)) {
      found = start + offset + 1;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * 'Put back in text': an image object becomes an inline image again, at `hint` (a document
 * position near where the object was, from posAtCoords) or at the start of the page's first
 * paragraph. Its size and classes come along; its positioning doesn't.
 */
export function putObjectInText(ref: ObjectRef, hint: number | null = null): Command {
  return (state, dispatch) => {
    const page = pageNodeAt(state.doc, ref.pagePos);
    const imageType = state.schema.nodes.image;
    if (!page || !imageType) return false;
    const objects = objectsOf(page.attrs);
    const object = findObject(objects, ref.id);
    if (object?.kind !== 'image' || !object.src) return false;
    if (!dispatch) return true;
    const image = imageType.create({ src: object.src, alt: '', classes: [...object.classes], style: imageStyleFromObject(object.style) });
    if (goesWithLastObject(state.doc, ref.pagePos, page, ref.id)) {
      // The page goes with its last object; the image ends the page before, where the flow is.
      const tr = deletePage(state.tr.setMeta(OBJECT_SELECTION, null), ref.pagePos, page);
      const end = ref.pagePos - 1;
      tr.insert(end, state.schema.nodes.paragraph!.create(null, image));
      tr.setSelection(NodeSelection.create(tr.doc, end + 1));
      dispatch(tr.scrollIntoView());
      return true;
    }
    const at = inlinePositionOnPage(state.doc, ref.pagePos, hint);
    const tr = setObjects(state.tr, ref.pagePos, objects.filter((o) => o.id !== ref.id)).setMeta(OBJECT_SELECTION, null);
    if (at !== null) {
      tr.insert(at, image);
      tr.setSelection(NodeSelection.create(tr.doc, at));
    } else {
      // No paragraph on the page: a new one at its start.
      const paragraph = state.schema.nodes.paragraph!.create(null, image);
      tr.insert(ref.pagePos + 1, paragraph);
      tr.setSelection(NodeSelection.create(tr.doc, ref.pagePos + 2));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// Pages: cover marker
// ---------------------------------------------------------------------------------------------

/** The cover marker of the selection's page. */
export function selectionCover(state: EditorState): CoverMarker | null {
  const target = selectionPage(state);
  return target ? coverOf(target.page.attrs.markers) : null;
}

/** Sets (or clears, with null) the cover marker of the page at `pagePos`. */
export function setPageCover(pagePos: number, cover: CoverMarker | null): Command {
  return (state, dispatch) => {
    const page = pageNodeAt(state.doc, pagePos);
    if (!page) return false;
    const next = withCover(page.attrs.markers, cover);
    if (JSON.stringify(next) === JSON.stringify(page.attrs.markers)) return false;
    dispatch?.(setPageAttr(state.tr, pagePos, 'markers', next));
    return true;
  };
}

/** setPageCover for the selection's page. */
export function setSelectionCover(cover: CoverMarker | null): Command {
  return (state, dispatch) => {
    const target = selectionPage(state);
    return target ? setPageCover(target.pagePos, cover)(state, dispatch) : false;
  };
}
