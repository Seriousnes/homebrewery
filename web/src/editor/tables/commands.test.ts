// Table commands and header rows (P5.6) on pure ProseMirror states, including the 5ePHB full
// caster class table (header rows with colspan and rowspan) rendered by the import lane's HBFM
// renderer: every edit must keep a consistent table and its spans.
import { elementFromString } from '@tiptap/core';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { DOMParser as PMDOMParser, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Command } from '@tiptap/pm/state';
import { addColumnAfter, addRowAfter, CellSelection, deleteColumn, deleteRow, mergeCells, splitCell, TableMap, tableEditing } from '@tiptap/pm/tables';
import { describe, expect, it } from 'vitest';
import classTableText from '../../../e2e/fixtures/snippet-5ephb-tables-class-tables-full-caster-class-table.hbfm.txt?raw';
import { createHbfmRenderer } from '../import/hbfm/renderer';
import { DOC, P, PAGE, posOf, schema } from '../pagination/testing';
import { markMultilineDefinitionLists } from '../schema';
import {
  createTable,
  insertTable,
  isHeaderRowSelected,
  resetColumnWidths,
  selectedColumnWidth,
  setColumnWidth,
  setHeaderRows,
  tableClasses,
  toggleTableClass,
} from './commands';
import { headerRowCount, headerRowPositions, headerRowsKey, headerRowsPlugin } from './headerRows';

const plugins = () => [history(), tableEditing(), headerRowsPlugin()];

function run(state: EditorState, command: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = command(state, (tr) => (next = state.apply(tr)));
  return ok ? next : null;
}

/** The first table of the document and its position. */
function firstTable(doc: PMNode): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'table') {
      found = { node, pos };
      return false;
    }
    return true;
  });
  if (!found) throw new Error('no table');
  return found;
}

/** Caret in the cell at (row, col) of the first table. */
function inCell(state: EditorState, row: number, col: number): EditorState {
  const { node, pos } = firstTable(state.doc);
  const map = TableMap.get(node);
  const cellPos = pos + 1 + map.map[row * map.width + col]!;
  return state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(cellPos + 1))));
}

function spans(table: PMNode): string[] {
  const out: string[] = [];
  table.descendants((n) => {
    if (n.type.spec.tableRole === 'cell' || n.type.spec.tableRole === 'header_cell') {
      if (n.attrs.colspan > 1 || n.attrs.rowspan > 1) out.push(`${n.textContent.trim()}:${n.attrs.colspan}x${n.attrs.rowspan}`);
      return false;
    }
    return true;
  });
  return out;
}

function expectConsistent(table: PMNode) {
  const map = TableMap.get(table);
  expect(map.problems ?? []).toEqual([]);
}

function classTableDoc(): PMNode {
  const html = createHbfmRenderer().render(classTableText, 0);
  const el = elementFromString(`<div class="page"><div class="columnWrapper">${html}</div></div>`);
  markMultilineDefinitionLists(el);
  return PMDOMParser.fromSchema(schema).parse(el);
}

describe('the class table snippet', () => {
  it('imports with its header rows, colspan and rowspan', () => {
    const doc = classTableDoc();
    const { node } = firstTable(doc);
    expectConsistent(node);
    expect(headerRowCount(node)).toBe(2);
    expect(spans(node)).toContainEqual(expect.stringMatching(/Spell Slots Per Spell Level.*:9x1$/));
    expect(spans(node).filter((s) => s.endsWith('x2'))).toHaveLength(4); // Level, Proficiency Bonus, Features, Cantrips Known
    const wrapper = doc.resolve(firstTable(doc).pos).parent;
    expect(wrapper.type.name).toBe('themeBlock');
    expect(wrapper.attrs.classes).toEqual(['classTable', 'frame', 'decoration', 'wide']);
  });

  it('keeps its spans through row, column and cell edits', () => {
    let s = EditorState.create({ doc: classTableDoc(), plugins: plugins() });
    const before = spans(firstTable(s.doc).node);
    const edits: [string, number, number, Command][] = [
      ['add row after a body row', 3, 0, addRowAfter],
      ['add column after the Features column', 3, 2, addColumnAfter],
      ['delete that column again', 3, 3, deleteColumn],
      ['delete a body row', 4, 0, deleteRow],
      ['add row after the first header row', 0, 5, addRowAfter],
    ];
    for (const [label, row, col, command] of edits) {
      const next = run(inCell(s, row, col), command);
      expect(next, label).not.toBeNull();
      s = next!;
      expectConsistent(firstTable(s.doc).node);
    }
    const after = spans(firstTable(s.doc).node);
    // Adding a row inside the header block grows the four rowspans by one; nothing else changed.
    expect(after.filter((x) => !x.endsWith('x3'))).toEqual(before.filter((x) => !x.endsWith('x2')));
    expect(after.filter((x) => x.endsWith('x3'))).toHaveLength(4);
    expect(undoDepth(s)).toBe(edits.length);
  });

  it('merge and split cells: colspan/rowspan and back', () => {
    let s = EditorState.create({ doc: classTableDoc(), plugins: plugins() });
    const { node, pos } = firstTable(s.doc);
    const map = TableMap.get(node);
    // Select the Features cells of two body rows and merge them.
    const a = pos + 1 + map.map[3 * map.width + 2]!;
    const b = pos + 1 + map.map[4 * map.width + 2]!;
    s = s.apply(s.tr.setSelection(CellSelection.create(s.doc, a, b)));
    s = run(s, mergeCells)!;
    const merged = firstTable(s.doc).node;
    expectConsistent(merged);
    const tall = (t: PMNode) => spans(t).filter((x) => x.endsWith(':1x2')).length;
    expect(tall(merged)).toBe(5); // the four header cells, and the merged one
    s = run(inCell(s, 3, 2), splitCell)!;
    expectConsistent(firstTable(s.doc).node);
    expect(tall(firstTable(s.doc).node)).toBe(4);
  });
});

describe('header rows', () => {
  const table = () => createTable(schema, { rows: 4, cols: 2, headerRows: 1 })!;

  it('decorates the leading all-header rows only', () => {
    const t = createTable(schema, { rows: 4, cols: 2, headerRows: 2 })!;
    const s = EditorState.create({ doc: DOC(PAGE(null, P('x'), t)), plugins: plugins() });
    expect(headerRowPositions(s.doc)).toHaveLength(2);
    const decos = headerRowsKey.getState(s)!.find();
    expect(decos).toHaveLength(2);
    expect((decos[0] as unknown as { type: { attrs: { class: string } } }).type.attrs.class).toBe('hb-header-row');
  });

  it('keeps its decorations equal to a fresh build through edits outside and inside tables (mapped when no table is touched, P8.1)', () => {
    const at = (s: EditorState) => headerRowsKey.getState(s)!.find().map((d) => [d.from, d.to]);
    const fresh = (s: EditorState) => headerRowPositions(s.doc).map((pos) => [pos, pos + s.doc.nodeAt(pos)!.nodeSize]);
    let s = EditorState.create({ doc: DOC(PAGE(null, P('alpha'), table(), P('beta')), PAGE({ kind: 'auto' }, P('gamma'), table())), plugins: plugins() });
    const before = headerRowsKey.getState(s);
    // Typing before the tables: the set is mapped (no rebuild), positions follow.
    s = s.apply(s.tr.insertText('typed ', posOf(s.doc, 'alpha')));
    expect(headerRowsKey.getState(s)).not.toBe(before);
    expect(at(s)).toEqual(fresh(s));
    // A page boundary moved (join + split, as pagination does): mapped too.
    const second = s.doc.child(0).nodeSize;
    s = s.apply(s.tr.join(second));
    s = s.apply(s.tr.split(posOf(s.doc, 'beta') - 1, 1, [{ type: schema.nodes.page!, attrs: { kind: 'auto' } }]));
    expect(at(s)).toEqual(fresh(s));
    // A cell edited, a header row added: rebuilt.
    s = run(inCell(s, 1, 0), setHeaderRows(true))!;
    expect(at(s)).toEqual(fresh(s));
    expect(at(s)).toHaveLength(3);
  });

  it('setHeaderRows makes the caret row a header row (or body row), one undo step', () => {
    let s = inCell(EditorState.create({ doc: DOC(PAGE(null, table())), plugins: plugins() }), 1, 0);
    expect(isHeaderRowSelected(s)).toBe(false);
    s = run(s, setHeaderRows(true))!;
    expect(headerRowCount(firstTable(s.doc).node)).toBe(2);
    expect(isHeaderRowSelected(s)).toBe(true);
    expect(headerRowsKey.getState(s)!.find()).toHaveLength(2);
    expect(run(s, setHeaderRows(true))).toBeNull(); // already
    s = run(inCell(s, 0, 0), setHeaderRows(false))!;
    // Row 1 is still all-header, but no longer leading: upstream would put it in <tbody>.
    expect(headerRowCount(firstTable(s.doc).node)).toBe(0);
    expect(undoDepth(s)).toBe(2);
  });
});

describe('column widths', () => {
  it('sets and clears the pixel width of the selected column in every row', () => {
    let s = inCell(EditorState.create({ doc: DOC(PAGE(null, createTable(schema, { rows: 3, cols: 3 })!)), plugins: plugins() }), 1, 1);
    expect(selectedColumnWidth(s)).toBeNull();
    s = run(s, setColumnWidth(120))!;
    expect(selectedColumnWidth(s)).toBe(120);
    const widths: unknown[] = [];
    firstTable(s.doc).node.forEach((row) => widths.push(row.child(1).attrs.colwidth, row.child(0).attrs.colwidth));
    expect(widths).toEqual([[120], null, [120], null, [120], null]);
    expect(run(s, setColumnWidth(5))).toBeNull(); // out of range
    s = run(s, resetColumnWidths)!;
    expect(selectedColumnWidth(s)).toBeNull();
    expect(undoDepth(s)).toBe(2);
  });

  it('writes the right index of a spanning cell', () => {
    let s = EditorState.create({ doc: classTableDoc(), plugins: plugins() });
    s = run(inCell(s, 1, 5), setColumnWidth(40))!; // "2nd" under the 9-column header
    const { node } = firstTable(s.doc);
    const header = node.child(0).lastChild!; // the colspan-9 cell
    expect(header.attrs.colspan).toBe(9);
    expect(header.attrs.colwidth).toEqual([0, 40, 0, 0, 0, 0, 0, 0, 0]);
    expectConsistent(node);
  });
});

describe('table classes', () => {
  it('classTable wraps the table in a classTable block; frame and decoration go on it; removing classTable unwraps', () => {
    let s = inCell(EditorState.create({ doc: DOC(PAGE(null, P('Intro'), createTable(schema)!)), plugins: plugins() }), 1, 1);
    s = run(s, toggleTableClass('wide'))!;
    expect(firstTable(s.doc).node.attrs.classes).toEqual(['wide']);
    s = run(s, toggleTableClass('frame'))!; // needs the wrapper: creates it (wide moves to it)
    let wrapper = s.doc.resolve(firstTable(s.doc).pos).parent;
    expect(wrapper.type.name).toBe('themeBlock');
    expect(wrapper.attrs.classes).toEqual(['classTable', 'frame', 'wide']);
    expect(firstTable(s.doc).node.attrs.classes).toEqual([]);
    expect(s.selection.$from.parent.type.name).toBe('paragraph'); // the caret is still in the cell
    expect(tableClasses(s)).toEqual({ classTable: true, frame: true, decoration: false, wide: true });
    s = run(s, toggleTableClass('decoration'))!;
    s = run(s, toggleTableClass('frame'))!;
    wrapper = s.doc.resolve(firstTable(s.doc).pos).parent;
    expect(wrapper.attrs.classes).toEqual(['classTable', 'wide', 'decoration']);
    s = run(s, toggleTableClass('classTable'))!;
    expect(s.doc.resolve(firstTable(s.doc).pos).parent.type.name).toBe('page');
    expect(firstTable(s.doc).node.attrs.classes).toEqual(['wide']);
    expect(s.selection.$from.node(-3)?.type.name).toBe('table');
    expect(undoDepth(s)).toBe(5);
    s = run(s, undo)!;
    expect(s.doc.resolve(firstTable(s.doc).pos).parent.type.name).toBe('themeBlock');
  });

  it('toggles on the imported class table block', () => {
    let s = inCell(EditorState.create({ doc: classTableDoc(), plugins: plugins() }), 3, 0);
    expect(tableClasses(s)).toEqual({ classTable: true, frame: true, decoration: true, wide: true });
    s = run(s, toggleTableClass('decoration'))!;
    expect(tableClasses(s).decoration).toBe(false);
    expect(spans(firstTable(s.doc).node).length).toBeGreaterThan(0);
  });
});

describe('insertTable', () => {
  it('inserts a table with a header row after the paragraph, caret in the first cell', () => {
    const doc = DOC(PAGE(null, P('Intro')));
    let s = EditorState.create({ doc, plugins: plugins() });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posOf(s.doc, 'Intro') + 5)));
    s = run(s, insertTable({ rows: 2, cols: 3 }))!;
    const { node } = firstTable(s.doc);
    expect(node.childCount).toBe(2);
    expect(headerRowCount(node)).toBe(1);
    expect(s.selection.$from.node(-1).type.name).toBe('tableHeader');
    expect(undoDepth(s)).toBe(1);
  });
});
