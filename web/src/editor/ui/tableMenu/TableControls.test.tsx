// The table controls (T3, tables/controls.ts): shown under the table at the caret while the editor
// has focus, their actions (one undo step each), Shift+Alt+F10 / Escape, deleting the table, and
// the column width dialog other menus open.
import type { Editor } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { docOf, p, page } from '../../schema/testing';
import { createTable } from '../../tables/commands';
import { openColumnWidthDialog, TableControls, tableControlsOf } from '../../tables/controls';
import { createTestEditor, press, selectText } from '../toolbar/testing';

let editor: Editor | undefined;
beforeAll(() => {
  // jsdom has no layout: a focused editor scrolls the selection into view (Delete table does) with Range rects.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  if (!('getClientRects' in Range.prototype)) Object.defineProperty(Range.prototype, 'getClientRects', { value: empty, configurable: true, writable: true });
  if (!('getBoundingClientRect' in Range.prototype)) Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: () => new DOMRect(), configurable: true, writable: true });
});
afterEach(async () => {
  editor?.destroy();
  editor = undefined;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  document.body.innerHTML = '';
});

/** Lets the controls' refresh timers, microtask mount and React render run. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** An editor with the table controls, "Intro", a 3 × 3 table and "After"; the caret in body cell (1, 1), focused. */
async function mount(): Promise<Editor> {
  const element = document.createElement('div');
  document.body.append(element);
  const e = createTestEditor(docOf(page([p('Intro'), p('After')])), { element, extensions: [TableControls] });
  editor = e;
  const table = createTable(e.schema, { rows: 3, cols: 3, headerRows: 1 })!;
  e.view.dispatch(e.state.tr.insert(e.state.doc.child(0).child(0).nodeSize + 1, table));
  const cells: number[] = [];
  e.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell') cells.push(pos);
    return true;
  });
  e.commands.setTextSelection(cells[1]! + 2);
  e.view.focus();
  await flush();
  return e;
}

const rows = (e: Editor) => {
  let count = -1;
  e.state.doc.descendants((node) => {
    if (node.type.name === 'table') count = node.childCount;
    return count < 0;
  });
  return count;
};

describe('table controls', () => {
  it('show while the caret is in a table and the editor has focus; hide outside it', async () => {
    const e = await mount();
    const controls = screen.getByTestId('table-controls');
    expect(within(controls).getByRole('toolbar', { name: 'Table' })).toBeInTheDocument();
    selectText(e, 'Intro', 2);
    await flush();
    expect(screen.queryByTestId('table-controls')).toBeNull();
    expect(tableControlsOf(e.view)).toBeDefined();
  });

  it('add a row below and delete it again, one undo step each; the editor keeps the focus', async () => {
    const e = await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add row below' }));
    expect(rows(e)).toBe(4);
    expect(undoDepth(e.state)).toBe(2); // the table, the row
    await user.click(screen.getByRole('button', { name: 'Delete row' }));
    expect(rows(e)).toBe(3);
    expect(undoDepth(e.state)).toBe(3);
    expect(e.view.hasFocus()).toBe(true);
    expect(e.state.selection.$from.node(-1).type.name).toBe('tableCell');
  });

  it('toggle Wide and the header row, and show their state', async () => {
    const e = await mount();
    const user = userEvent.setup();
    const wide = screen.getByTestId('table-wide');
    expect(wide).toHaveAttribute('aria-pressed', 'false');
    await user.click(wide);
    await flush();
    expect(screen.getByTestId('table-wide')).toHaveAttribute('aria-pressed', 'true');
    let classes: unknown = null;
    e.state.doc.descendants((node) => {
      if (node.type.name === 'table') classes = node.attrs.classes;
      return classes === null;
    });
    expect(classes).toEqual(['wide']);
    await user.click(screen.getByTestId('table-header-row'));
    await flush();
    expect(e.state.selection.$from.node(-1).type.name).toBe('tableHeader');
    expect(screen.getByTestId('table-header-row')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Delete table removes it, hides the controls and leaves the caret in the text after it', async () => {
    const e = await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete table' }));
    await flush();
    expect(rows(e)).toBe(-1);
    expect(e.state.selection.$from.parent.textContent).toBe('After');
    expect(screen.queryByTestId('table-controls')).toBeNull();
    expect(e.view.hasFocus()).toBe(true);
  });

  it('Shift+Alt+F10 moves the focus into the controls, Escape back to the text', async () => {
    const e = await mount();
    const user = userEvent.setup();
    let handled = false;
    act(() => {
      handled = press(e, 'Shift-Alt-F10');
    });
    await flush();
    expect(handled).toBe(true);
    const controls = screen.getByTestId('table-controls');
    expect(controls.contains(document.activeElement)).toBe(true);
    // Keyboard actions keep the focus in the toolbar.
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    await flush();
    expect(rows(e)).toBe(4);
    expect(screen.getByTestId('table-controls').contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await flush();
    expect(e.view.hasFocus()).toBe(true);
    expect(e.state.selection.$from.node(-1).type.name).toBe('tableCell');
  });

  it('Shift+Alt+F10 outside a table is not the controls’', async () => {
    const e = await mount();
    selectText(e, 'Intro', 1);
    expect(press(e, 'Shift-Alt-F10')).toBe(false);
  });

  it('open the column width dialog for menus without their own', async () => {
    const e = await mount();
    let opened = false;
    act(() => {
      opened = openColumnWidthDialog(e.view);
    });
    await flush();
    expect(opened).toBe(true);
    const user = userEvent.setup();
    const dialog = screen.getByRole('dialog', { name: 'Column width' });
    await user.type(within(dialog).getByTestId('column-width-input'), '120');
    await user.click(within(dialog).getByTestId('column-width-apply'));
    expect(e.state.selection.$from.node(-1).attrs.colwidth).toEqual([120]);
  });
});
