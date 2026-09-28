// The toolbar's table button (T3): the size picker outside a table (pointer, keys, fields, the
// 'insertTable' request) and the menu of table actions inside one (tableMenuEntries: one undo
// step each, the caret stays in the table).
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitKeymapRequest, onKeymapRequest } from '../../commands/keymap';
import { docOf, p, page } from '../../schema/testing';
import { createTable } from '../../tables/commands';
import { createTestEditor, selectText } from '../toolbar/testing';
import { TableMenu } from './TableMenu';
import { tableMenuContext } from './tableMenuContext';
import { tableMenuEntries } from './tableMenuEntries';
import { moveGridCell, PICKER_COLS, PICKER_ROWS } from './tableSize';

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.innerHTML = '';
});

function mountEditor(content: JSONContent = docOf(page([p('Intro')]))): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = createTestEditor(content, { element });
  return editor;
}

/** An editor with a 3 × 3 table (one header row) after "Intro", the caret in its body cell (1, 1). */
function inTable(): Editor {
  const e = mountEditor(docOf(page([p('Intro')])));
  const table = createTable(e.schema, { rows: 3, cols: 3, headerRows: 1 })!;
  e.view.dispatch(e.state.tr.insert(e.state.doc.child(0).nodeSize - 1, table));
  const cells: number[] = [];
  e.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell') cells.push(pos);
    return true;
  });
  e.commands.setTextSelection(cells[1]! + 2); // row 1, column 1
  return e;
}

const tableOf = (e: Editor) => {
  let found: { rows: number; cols: number; header: number } | null = null;
  e.state.doc.descendants((node) => {
    if (found || node.type.name !== 'table') return !found;
    let header = 0;
    node.forEach((row) => {
      if (row.firstChild?.type.name === 'tableHeader') header++;
    });
    found = { rows: node.childCount, cols: node.firstChild!.childCount, header };
    return false;
  });
  return found as { rows: number; cols: number; header: number } | null;
};

describe('moveGridCell', () => {
  it('moves by one cell and stays inside the grid', () => {
    expect(moveGridCell({ rows: 3, cols: 3 }, 'ArrowRight')).toEqual({ rows: 3, cols: 4 });
    expect(moveGridCell({ rows: 3, cols: 3 }, 'ArrowDown')).toEqual({ rows: 4, cols: 3 });
    expect(moveGridCell({ rows: 1, cols: 1 }, 'ArrowUp')).toEqual({ rows: 1, cols: 1 });
    expect(moveGridCell({ rows: 1, cols: 1 }, 'ArrowLeft')).toEqual({ rows: 1, cols: 1 });
    expect(moveGridCell({ rows: 2, cols: 2 }, 'End')).toEqual({ rows: 2, cols: PICKER_COLS });
    expect(moveGridCell({ rows: 2, cols: 2 }, 'PageDown')).toEqual({ rows: PICKER_ROWS, cols: 2 });
    expect(moveGridCell({ rows: 2, cols: 2 }, 'a')).toBeNull();
  });
});

describe('TableMenu outside a table: the size picker', () => {
  it('picks the size with the arrow keys; Enter inserts it with a header row, caret in the table', async () => {
    const e = mountEditor();
    selectText(e, 'Intro', 5);
    const user = userEvent.setup();
    render(<TableMenu editor={e} />);
    const button = screen.getByTestId('table-menu');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(button);
    const picker = screen.getByRole('dialog', { name: 'Insert table' });
    expect(within(picker).getByTestId('table-size-label')).toHaveTextContent('3 × 3 table');
    expect(within(picker).getByRole('gridcell', { name: '3 by 3' })).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowDown}{ArrowDown}');
    expect(within(picker).getByRole('gridcell', { name: '5 by 4' })).toHaveFocus();
    expect(within(picker).getByTestId('table-size-label')).toHaveTextContent('5 × 4 table');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Insert table' })).toBeNull();
    expect(tableOf(e)).toEqual({ rows: 5, cols: 4, header: 1 });
    expect(e.state.selection.$from.node(-1).type.name).toBe('tableHeader');
    expect(undoDepth(e.state)).toBe(1);
  });

  it('inserts the size typed in the fields, without a header row when unchecked', async () => {
    const e = mountEditor();
    selectText(e, 'Intro', 5);
    const user = userEvent.setup();
    render(<TableMenu editor={e} />);
    await user.click(screen.getByTestId('table-menu'));
    await user.clear(screen.getByTestId('table-rows-input'));
    await user.type(screen.getByTestId('table-rows-input'), '12');
    await user.clear(screen.getByTestId('table-cols-input'));
    await user.type(screen.getByTestId('table-cols-input'), '2');
    await user.click(screen.getByTestId('table-header-input'));
    await user.click(screen.getByTestId('table-insert'));
    expect(tableOf(e)).toEqual({ rows: 12, cols: 2, header: 0 });
  });

  it('rejects sizes out of range', async () => {
    const e = mountEditor();
    selectText(e, 'Intro', 5);
    const user = userEvent.setup();
    render(<TableMenu editor={e} />);
    await user.click(screen.getByTestId('table-menu'));
    await user.clear(screen.getByTestId('table-cols-input'));
    await user.type(screen.getByTestId('table-cols-input'), '0');
    await user.click(screen.getByTestId('table-insert'));
    expect(screen.getByRole('alert')).toHaveTextContent(/columns from 1/);
    expect(tableOf(e)).toBeNull();
  });

  it('a pointer click on a grid cell inserts that size', async () => {
    const e = mountEditor();
    selectText(e, 'Intro', 5);
    const user = userEvent.setup();
    render(<TableMenu editor={e} />);
    await user.click(screen.getByTestId('table-menu'));
    await user.click(screen.getByRole('gridcell', { name: '2 by 6' }));
    expect(tableOf(e)).toEqual({ rows: 2, cols: 6, header: 1 });
  });

  it("opens on the 'insertTable' request (context menu)", async () => {
    const e = mountEditor();
    selectText(e, 'Intro', 5);
    render(<TableMenu editor={e} />);
    let handled = false;
    act(() => {
      handled = emitKeymapRequest(e, 'insertTable');
    });
    expect(handled).toBe(true);
    expect(await screen.findByRole('dialog', { name: 'Insert table' })).toBeInTheDocument();
  });
});

describe('TableMenu inside a table', () => {
  it('is a menu of the table actions; each is one undo step and keeps the caret in the table', async () => {
    const e = inTable();
    const user = userEvent.setup();
    render(<TableMenu editor={e} />);
    const button = screen.getByTestId('table-menu');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Add row below' }));
    expect(tableOf(e)).toEqual({ rows: 4, cols: 3, header: 1 });
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Add column left' }));
    expect(tableOf(e)).toEqual({ rows: 4, cols: 4, header: 1 });
    expect(undoDepth(e.state)).toBe(3); // the table, the row, the column
    expect(e.state.selection.$from.node(-1).type.name).toBe('tableCell');
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Delete table' }));
    expect(tableOf(e)).toBeNull();
    expect(e.state.selection.$from.parent.type.name).toBe('paragraph');
  });
});

describe('tableMenuEntries', () => {
  it("outside a table: one 'Insert table…' item that sends the insertTable request", () => {
    const e = mountEditor();
    selectText(e, 'Intro', 5);
    const seen: string[] = [];
    onKeymapRequest(e, (r) => {
      seen.push(r);
      return true;
    });
    const entries = tableMenuEntries(e, tableMenuContext(e.state));
    expect(entries.map((x) => ('label' in x ? x.label : x.type))).toEqual(['Insert table…']);
    const item = entries[0]!;
    if (!('onSelect' in item) || item.type === 'radio') throw new Error('an action item');
    item.onSelect();
    expect(seen).toEqual(['insertTable']);
  });

  it('inside a table: rows, columns, cells, styles, delete; typing before an action is its own undo step', () => {
    const e = inTable();
    const ctx = tableMenuContext(e.state);
    const entries = tableMenuEntries(e, ctx, { onColumnWidth: vi.fn() });
    const labels = entries.flatMap((x) => (x.type === 'group' ? x.items.map((i) => ('label' in i ? i.label : '—')) : ['label' in x ? x.label : '—']));
    expect(labels).toEqual([
      'Add row above',
      'Add row below',
      'Header row',
      'Delete row',
      'Add column left',
      'Add column right',
      'Column width…',
      'Automatic column widths',
      'Delete column',
      'Merge cells',
      'Split cell',
      'Class table',
      'Frame',
      'Decoration',
      'Wide (both columns)',
      '—',
      'Delete table',
    ]);
    const find = (id: string) => {
      for (const x of entries) for (const i of x.type === 'group' ? x.items : [x]) if ('id' in i && i.id === id) return i;
      throw new Error(id);
    };
    expect(find('cells-merge')).toMatchObject({ disabled: true });
    e.commands.insertContent('typed');
    const depth = Number(undoDepth(e.state));
    const row = find('row-before');
    if (!('onSelect' in row)) throw new Error('an action');
    row.onSelect();
    expect(tableOf(e)!.rows).toBe(4);
    expect(undoDepth(e.state)).toBe(depth + 1);
    e.commands.undo();
    expect(tableOf(e)!.rows).toBe(3);
    expect(e.state.doc.textContent).toContain('typed');
  });
});
