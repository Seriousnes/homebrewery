// Which page object is selected (P5.3). Plugin state of the PageObjects extension, outside the
// undo history; commands set it with the OBJECT_SELECTION meta.
//
// The selection names the page by position (mapped through every transaction) and the object by
// its id. When pagination re-splits the page (join + split: the position is deleted, the pid is
// kept), the page is found again by its pid. It is dropped when the page or the object goes away.
import type { Node as PMNode } from '@tiptap/pm/model';
import { PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';

export interface ObjectRef {
  /** position before the page node */
  pagePos: number;
  /** PageObject.id */
  id: string;
}

export interface ObjectSelectionState {
  selected: ObjectRef | null;
}

export const objectSelectionKey = new PluginKey<ObjectSelectionState>('hbPageObjects');

/** Transaction meta: `ObjectRef` selects an object, null clears the selection. */
export const OBJECT_SELECTION = 'hbObjectSelection';

export function selectedObject(state: EditorState): ObjectRef | null {
  return objectSelectionKey.getState(state)?.selected ?? null;
}

/** The page node at `pagePos`, or null. */
export function pageNodeAt(doc: PMNode, pagePos: number): PMNode | null {
  if (pagePos < 0 || pagePos >= doc.content.size) return null;
  const node = doc.nodeAt(pagePos);
  return node?.type.name === 'page' ? node : null;
}

function hasObject(page: PMNode | null, id: string): boolean {
  const objects = page?.attrs.objects as unknown;
  return Array.isArray(objects) && objects.some((o) => (o as { id?: unknown })?.id === id);
}

/**
 * Where object `id` is now when the page it was on (`pid`) moved in a way positions can't follow:
 * pagination re-splits an auto page with join + split, which keeps its pid. null when it's gone.
 */
export function findObjectByPid(doc: PMNode, pid: unknown, id: string): ObjectRef | null {
  if (typeof pid !== 'string' || pid === '') return null;
  let found: ObjectRef | null = null;
  doc.forEach((page, pos) => {
    if (!found && page.attrs.pid === pid && hasObject(page, id)) found = { pagePos: pos, id };
  });
  return found;
}

/** The next selection state after `tr` (see the file header). */
export function applyObjectSelection(tr: Transaction, prev: ObjectSelectionState): ObjectSelectionState {
  const meta = tr.getMeta(OBJECT_SELECTION) as ObjectRef | null | undefined;
  if (meta !== undefined) {
    if (meta === null) return prev.selected === null ? prev : { selected: null };
    return hasObject(pageNodeAt(tr.doc, meta.pagePos), meta.id) ? { selected: { pagePos: meta.pagePos, id: meta.id } } : { selected: null };
  }
  const selected = prev.selected;
  if (!selected || !tr.docChanged) return prev;
  const mapped = tr.mapping.mapResult(selected.pagePos, 1);
  if (mapped.deleted || !hasObject(pageNodeAt(tr.doc, mapped.pos), selected.id)) {
    const moved = findObjectByPid(tr.doc, pageNodeAt(tr.before, selected.pagePos)?.attrs.pid, selected.id);
    return { selected: moved };
  }
  return mapped.pos === selected.pagePos ? prev : { selected: { pagePos: mapped.pos, id: selected.id } };
}
