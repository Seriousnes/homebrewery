// Table commands beyond TipTap's (P5.6, plan §6.6). TipTap's Table extension (in the schema)
// already provides addRowBefore/After, deleteRow, addColumnBefore/After, deleteColumn,
// mergeCells, splitCell, toggleHeaderRow/Column/Cell, deleteTable and goToNextCell; they keep
// colspan/rowspan consistent (prosemirror-tables). This file adds:
//
// - insertTable({ rows, cols, headerRows })          a table at the caret (insertBlock rules)
// - setHeaderRows(on)                                 the selected rows become header rows (th)
//                                                     or body rows (td); leading header rows
//                                                     render like upstream's <thead>
// - setColumnWidth(px | null), resetColumnWidths()    colwidth of the selected columns
// - toggleTableClass(cls)                             classTable, frame, decoration, wide
//
// Table classes live where upstream puts them: `{{classTable,frame,decoration …}}` is a theme
// block around the table (5ePHB styles `.classTable.frame`), so they are toggled on that
// wrapper. classTable creates the wrapper (frame and decoration need it and create it too), and
// removing classTable unwraps it (keeping `wide` on the table). Without a wrapper, `wide` goes on
// the table itself. Every command is one transaction (one undo step) and changes attributes with
// setNodeAttribute (pagination convention, PG-2).
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { TextSelection, type Command, type EditorState, type Transaction } from '@tiptap/pm/state';
import { CellSelection, selectedRect, isInTable, type TableMap, type TableRect } from '@tiptap/pm/tables';
import { insertBlock } from '../ui/blockMenu/blockCommands';

export const TABLE_CLASSES = ['classTable', 'frame', 'decoration', 'wide'] as const;
export type TableClass = (typeof TABLE_CLASSES)[number];

export const TABLE_CLASS_LABELS: Record<TableClass, string> = {
  classTable: 'Class table',
  frame: 'Frame',
  decoration: 'Decoration',
  wide: 'Wide (both columns)',
};

// ---------------------------------------------------------------------------------------------
// Finding the table
// ---------------------------------------------------------------------------------------------

export interface TableContext {
  table: PMNode;
  /** position before the table */
  tablePos: number;
  /** the classTable theme block around it, if any */
  wrapper: { node: PMNode; pos: number } | null;
}

function classesOf(node: PMNode): string[] {
  return Array.isArray(node.attrs.classes) ? (node.attrs.classes as string[]) : [];
}

/** The table the selection is in (and its classTable wrapper), or null. */
export function tableContext(state: EditorState): TableContext | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.spec.tableRole === 'table') {
      const tablePos = $from.before(d);
      const parent = $from.node(d - 1);
      const wrapper = d > 1 && parent.type.name === 'themeBlock' && classesOf(parent).includes('classTable') ? { node: parent, pos: $from.before(d - 1) } : null;
      return { table: node, tablePos, wrapper };
    }
  }
  // A node selection of a table.
  const sel = state.selection as { node?: PMNode; from: number };
  if (sel.node?.type.spec.tableRole === 'table') {
    const $pos = state.doc.resolve(sel.from);
    const parent = $pos.parent;
    const wrapper =
      parent.type.name === 'themeBlock' && classesOf(parent).includes('classTable') && $pos.depth > 1 ? { node: parent, pos: $pos.before() } : null;
    return { table: sel.node, tablePos: sel.from, wrapper };
  }
  return null;
}

/** Which table classes are on (wrapper classes, or the table's own `wide`). */
export function tableClasses(state: EditorState): Record<TableClass, boolean> {
  const ctx = tableContext(state);
  const on = new Set([...(ctx?.wrapper ? classesOf(ctx.wrapper.node) : []), ...(ctx ? classesOf(ctx.table) : [])]);
  return { classTable: on.has('classTable'), frame: on.has('frame'), decoration: on.has('decoration'), wide: on.has('wide') };
}

// ---------------------------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------------------------

export interface InsertTableOptions {
  rows?: number;
  cols?: number;
  /** leading header rows (default 1) */
  headerRows?: number;
}

/** A table node of empty cells (each holding an empty paragraph). */
export function createTable(schema: Schema, { rows = 3, cols = 3, headerRows = 1 }: InsertTableOptions = {}): PMNode | null {
  const { table, tableRow, tableCell, tableHeader } = schema.nodes;
  if (!table || !tableRow || !tableCell || !tableHeader) return null;
  const rowNodes: PMNode[] = [];
  for (let r = 0; r < Math.max(1, rows); r++) {
    const type = r < headerRows ? tableHeader : tableCell;
    const cells: PMNode[] = [];
    for (let c = 0; c < Math.max(1, cols); c++) cells.push(type.createAndFill()!);
    rowNodes.push(tableRow.create(null, cells));
  }
  return table.create(null, rowNodes);
}

export function insertTable(options: InsertTableOptions = {}): Command {
  return insertBlock((schema) => createTable(schema, options));
}

// ---------------------------------------------------------------------------------------------
// Header rows
// ---------------------------------------------------------------------------------------------

/** Cells (position, node) that start in row `row` of the table. */
function cellsStartingInRow(rect: TableRect, row: number): { pos: number; node: PMNode }[] {
  const { map, table, tableStart } = rect;
  const seen = new Set<number>();
  const out: { pos: number; node: PMNode }[] = [];
  for (let col = 0; col < map.width; col++) {
    const offset = map.map[row * map.width + col]!;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const cellRect = map.findCell(offset);
    if (cellRect.top !== row) continue;
    out.push({ pos: tableStart + offset, node: table.nodeAt(offset)! });
  }
  return out;
}

/** Whether every cell starting in the selection's first row is a header cell. */
export function isHeaderRowSelected(state: EditorState): boolean {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const cells = cellsStartingInRow(rect, rect.top);
  return cells.length > 0 && cells.every((c) => c.node.type.spec.tableRole === 'header_cell');
}

/**
 * Makes the selected rows (the caret's row, or every row of a cell selection) header rows (on)
 * or body rows (off): their cells become th / td, keeping every attribute (spans, widths).
 */
export function setHeaderRows(on: boolean): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const { tableHeader, tableCell } = state.schema.nodes;
    if (!tableHeader || !tableCell) return false;
    const target = on ? tableHeader : tableCell;
    const rect = selectedRect(state);
    const cells: { pos: number; node: PMNode }[] = [];
    for (let row = rect.top; row < rect.bottom; row++) cells.push(...cellsStartingInRow(rect, row));
    const changed = cells.filter((c) => c.node.type !== target);
    if (changed.length === 0) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const c of changed) tr.setNodeMarkup(c.pos, target, c.node.attrs, c.node.marks);
      dispatch(tr);
    }
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// Column widths
// ---------------------------------------------------------------------------------------------

/** Every cell covering column `col`, with the index of that column inside the cell. */
function cellsInColumn(table: PMNode, map: TableMap, tableStart: number, col: number): { pos: number; node: PMNode; index: number }[] {
  const seen = new Set<number>();
  const out: { pos: number; node: PMNode; index: number }[] = [];
  for (let row = 0; row < map.height; row++) {
    const offset = map.map[row * map.width + col]!;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const cellRect = map.findCell(offset);
    out.push({ pos: tableStart + offset, node: table.nodeAt(offset)!, index: col - cellRect.left });
  }
  return out;
}

/** The pixel width (colwidth) of the selection's first column, or null when it has none. */
export function selectedColumnWidth(state: EditorState): number | null {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state);
  for (const cell of cellsInColumn(rect.table, rect.map, rect.tableStart, rect.left)) {
    const widths = cell.node.attrs.colwidth as unknown;
    const w: unknown = Array.isArray(widths) ? (widths as unknown[])[cell.index] : null;
    if (typeof w === 'number' && w > 0) return w;
  }
  return null;
}

/** Sets the pixel width of the selected columns (null: back to automatic). */
export function setColumnWidth(width: number | null): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const w = width === null ? null : Math.round(width);
    if (w !== null && !(w >= 10 && w <= 2000)) return false;
    const rect = selectedRect(state);
    const next = new Map<number, (number | null)[]>(); // cell pos → widths
    const nodes = new Map<number, PMNode>();
    for (let col = rect.left; col < rect.right; col++) {
      for (const cell of cellsInColumn(rect.table, rect.map, rect.tableStart, col)) {
        const colspan = typeof cell.node.attrs.colspan === 'number' ? cell.node.attrs.colspan : 1;
        const current = next.get(cell.pos) ?? (Array.isArray(cell.node.attrs.colwidth) ? [...(cell.node.attrs.colwidth as number[])] : new Array<number | null>(colspan).fill(null));
        while (current.length < colspan) current.push(null);
        current[cell.index] = w;
        next.set(cell.pos, current);
        nodes.set(cell.pos, cell.node);
      }
    }
    const tr = state.tr;
    for (const [pos, widths] of next) {
      const value = widths.every((x) => x === null) ? null : widths.map((x) => x ?? 0);
      const node = nodes.get(pos)!;
      if (JSON.stringify(node.attrs.colwidth ?? null) !== JSON.stringify(value)) tr.setNodeAttribute(pos, 'colwidth', value);
    }
    if (!tr.docChanged) return false;
    dispatch?.(tr);
    return true;
  };
}

/** Removes every pixel column width of the table. */
export const resetColumnWidths: Command = (state, dispatch) => {
  const ctx = tableContext(state);
  if (!ctx) return false;
  const tr = state.tr;
  ctx.table.descendants((node, offset) => {
    if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') {
      if (node.attrs.colwidth !== null) tr.setNodeAttribute(ctx.tablePos + 1 + offset, 'colwidth', null);
      return false;
    }
    return true;
  });
  if (!tr.docChanged) return false;
  dispatch?.(tr);
  return true;
};

// ---------------------------------------------------------------------------------------------
// Table classes
// ---------------------------------------------------------------------------------------------

/** The selection moved by `delta` when it lay inside [from, to) (wrapping/unwrapping a table). */
function shiftSelection(state: EditorState, tr: Transaction, from: number, to: number, delta: number): void {
  const sel = state.selection;
  const inside = (p: number) => p > from && p < to;
  if (!inside(sel.anchor) || !inside(sel.head)) return;
  if (sel instanceof CellSelection) {
    tr.setSelection(CellSelection.create(tr.doc, sel.$anchorCell.pos + delta, sel.$headCell.pos + delta));
  } else if (sel instanceof TextSelection) {
    tr.setSelection(TextSelection.create(tr.doc, sel.anchor + delta, sel.head + delta));
  }
}

/** Toggles one of the table classes (see the file header). */
export function toggleTableClass(cls: TableClass): Command {
  return (state, dispatch) => {
    const ctx = tableContext(state);
    if (!ctx) return false;
    const { themeBlock } = state.schema.nodes;
    if (!themeBlock) return false;
    const tr = state.tr;
    const { table, tablePos, wrapper } = ctx;
    const tableClasses = classesOf(table);

    if (wrapper) {
      const classes = classesOf(wrapper.node);
      if (cls === 'classTable') {
        // Unwrap: the wrapper's content moves out; `wide` stays with the table.
        const $wrapper = state.doc.resolve(wrapper.pos);
        if (!$wrapper.parent.canReplace($wrapper.index(), $wrapper.index() + 1, wrapper.node.content)) return false;
        if (!dispatch) return true;
        if (classes.includes('wide') && !tableClasses.includes('wide')) tr.setNodeAttribute(tablePos, 'classes', [...tableClasses, 'wide']);
        const end = wrapper.pos + wrapper.node.nodeSize;
        tr.replaceWith(wrapper.pos, end, tr.doc.slice(wrapper.pos + 1, end - 1).content);
        shiftSelection(state, tr, wrapper.pos, end, -1);
        dispatch(tr.scrollIntoView());
        return true;
      }
      if (!dispatch) return true;
      const next = classes.includes(cls) ? classes.filter((c) => c !== cls) : [...classes, cls];
      tr.setNodeAttribute(wrapper.pos, 'classes', next);
      if (cls === 'wide' && tableClasses.includes('wide')) tr.setNodeAttribute(tablePos, 'classes', tableClasses.filter((c) => c !== 'wide'));
      dispatch(tr);
      return true;
    }

    if (cls === 'wide') {
      if (!dispatch) return true;
      const next = tableClasses.includes('wide') ? tableClasses.filter((c) => c !== 'wide') : [...tableClasses, 'wide'];
      tr.setNodeAttribute(tablePos, 'classes', next);
      dispatch(tr);
      return true;
    }

    // classTable, frame, decoration: wrap the table in a classTable block (wide moves to it).
    const $table = state.doc.resolve(tablePos);
    const index = $table.index();
    if (!$table.parent.canReplaceWith(index, index + 1, themeBlock)) return false;
    if (!dispatch) return true;
    const wide = tableClasses.includes('wide');
    const wrapperClasses = ['classTable', ...(cls === 'classTable' ? [] : [cls]), ...(wide ? ['wide'] : [])];
    const inner = wide ? table.type.create({ ...table.attrs, classes: tableClasses.filter((c) => c !== 'wide') }, table.content, table.marks) : table;
    tr.replaceWith(tablePos, tablePos + table.nodeSize, themeBlock.create({ classes: wrapperClasses }, inner));
    shiftSelection(state, tr, tablePos, tablePos + table.nodeSize, 1);
    dispatch(tr.scrollIntoView());
    return true;
  };
}
