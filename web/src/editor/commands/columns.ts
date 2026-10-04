// Column layout (plan §1 "1 or 2 per section", §4.1, §6.2): the toolbar's Columns menu and the
// context menu's Columns submenu. Columns are a section setting (page.attrs.columns: 1, 2, or
// null for the theme's default; 5ePHB's default is two). They live on the section's first page;
// the section sync copies them to its auto pages.
//
//   columnsAt             the setting of the section at the cursor, and whether every section
//                         has the same one (plain data: the toolbar selects it deep-equal, and it
//                         is stable under pagination, so pagination never re-renders the toolbar)
//   setSectionColumns     the section at the cursor (inspector-style edit, one undo step)
//   setAllColumns         every section of the document, one undo step
//   renderedColumnsAt     the column count the canvas shows for the page at the cursor (DOM)
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { isAutoPage, pageAt } from '../pagination/boundary';
import { applyEdit, editSection, validateColumns, writeSectionAttrs, type ColumnsSetting, type Dispatch, type EditResult } from './attrs';
import { sectionStartAt, selectionPageIndex } from './sections';

export interface ColumnsInfo {
  /** The section at the cursor: 1, 2, or null (the theme decides). */
  section: ColumnsSetting;
  /** The setting every section shares, or 'mixed'. */
  all: ColumnsSetting | 'mixed';
}

/** Indexes of the pages that start a section (the first page and every manual page). */
function sectionStarts(state: EditorState): number[] {
  const starts: number[] = [];
  state.doc.forEach((page, _offset, index) => {
    if (index === 0 || !isAutoPage(page)) starts.push(index);
  });
  return starts;
}

const columnsOf = (state: EditorState, index: number): ColumnsSetting => {
  const value: unknown = state.doc.child(index).attrs.columns;
  return value === 1 || value === 2 ? value : null;
};

export function columnsAt(state: EditorState): ColumnsInfo {
  const section = columnsOf(state, sectionStartAt(state));
  let all: ColumnsInfo['all'] = section;
  for (const index of sectionStarts(state)) {
    if (columnsOf(state, index) !== section) {
      all = 'mixed';
      break;
    }
  }
  return { section, all };
}

/** Sets the columns of the section at the cursor (or of page `pageIndex`'s section). One undo step. */
export function setSectionColumns(state: EditorState, dispatch: Dispatch | undefined, columns: ColumnsSetting, pageIndex?: number): EditResult {
  return editSection(state, dispatch, pageIndex ?? selectionPageIndex(state), { columns });
}

/** Sets the columns of every section of the document. One undo step. */
export function setAllColumns(state: EditorState, dispatch: Dispatch | undefined, columns: ColumnsSetting): EditResult {
  const valid = validateColumns(columns);
  if (!valid.ok) return valid;
  const changed = applyEdit(state, dispatch, (tr) => {
    let any = false;
    for (const index of sectionStarts(state)) any = writeSectionAttrs(tr, index, { columns: valid.value }) || any;
    return any;
  });
  return { ok: true, changed };
}

/**
 * The column count the canvas shows for the page at the cursor, or page `pageIndex` (its
 * .columnWrapper's computed column-count: theme rules, :has(.frontCover), the brew's CSS), or null
 * when it can't be read (no layout, e.g. jsdom).
 */
export function renderedColumnsAt(view: EditorView, pageIndex?: number): number | null {
  const page = pageAt(view.state.doc, pageIndex ?? selectionPageIndex(view.state));
  if (!page) return null;
  const dom = view.nodeDOM(page.pos);
  const wrapper = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(':scope > .columnWrapper') : null;
  if (!wrapper) return null;
  const count = Number.parseInt(getComputedStyle(wrapper).columnCount, 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}
