// What the BlockMenu offers for an editor state (plain data, so it can be compared between
// transactions and unit-tested).
import type { EditorState } from '@tiptap/pm/state';
import { insertPageBreak } from '../../commands/sections';
import { selectedImage, selectionPage } from '../../objects/commands';
import { coverOf, objectsOf, type CoverMarker } from '../../objects/model';
import { pageNodeAt, selectedObject } from '../../objects/state';
import { BLOCK_TYPES, findBlock, insertColumnBreak, insertDefinitionList, insertHorizontalRule, insertSpacer, type BlockTypeName } from './blockCommands';

export interface MenuObjectInfo {
  id: string;
  kind: 'image' | 'text';
  /** e.g. "Image 1 (banner)", "Text “Chapter 1”" */
  label: string;
}

export interface BlockMenuContext {
  /** Insert items that apply at the selection. */
  canInsert: Record<BlockTypeName | 'pageBreak', boolean>;
  /** Block types findBlock finds at the selection (their Remove items). */
  removable: BlockTypeName[];
  /** The page the Page items act on: the selected object's page, else the selection's. */
  pagePos: number | null;
  pageNumber: number | null;
  cover: CoverMarker | null;
  objects: MenuObjectInfo[];
  selected: (MenuObjectInfo & { pagePos: number; index: number; count: number }) | null;
  /** position of a node-selected inline image ('Place freely') */
  imagePos: number | null;
}

function describe(o: { id: string; kind: 'image' | 'text'; classes: string[]; text?: string }, n: number): MenuObjectInfo {
  const classes = o.classes.length ? ` (${o.classes.join(' ')})` : '';
  const label = o.kind === 'image' ? `Image ${n}${classes}` : `Text “${(o.text ?? '').trim().slice(0, 24) || '…'}”${classes}`;
  return { id: o.id, kind: o.kind, label };
}

export function blockMenuContext(state: EditorState): BlockMenuContext {
  const selected = selectedObject(state);
  const page = selected ? { pagePos: selected.pagePos, page: pageNodeAt(state.doc, selected.pagePos) } : selectionPage(state);
  const pageNode = page?.page ?? null;
  const objects = pageNode ? objectsOf(pageNode.attrs) : [];
  let images = 0;
  const infos = objects.map((o) => describe(o, o.kind === 'image' ? ++images : 0));
  const selIndex = selected ? objects.findIndex((o) => o.id === selected.id) : -1;
  let pageNumber: number | null = null;
  if (page && pageNode) {
    const index = state.doc.resolve(page.pagePos).index(0);
    pageNumber = index + 1;
  }
  return {
    canInsert: {
      definitionList: insertDefinitionList(state),
      spacer: insertSpacer(state),
      columnBreak: insertColumnBreak(state),
      horizontalRule: insertHorizontalRule(state),
      pageBreak: insertPageBreak(state),
    },
    removable: BLOCK_TYPES.filter((t) => findBlock(state, t) !== null),
    pagePos: page && pageNode ? page.pagePos : null,
    pageNumber,
    cover: pageNode ? coverOf(pageNode.attrs.markers) : null,
    objects: infos,
    selected: selected && selIndex >= 0 ? { ...infos[selIndex]!, pagePos: selected.pagePos, index: selIndex, count: objects.length } : null,
    imagePos: selectedImage(state)?.pos ?? null,
  };
}
