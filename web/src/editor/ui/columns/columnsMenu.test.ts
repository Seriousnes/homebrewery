// The Columns menu entries (columnsMenu.ts): the section's choices with the current one checked,
// the every-page actions, read-only editors. Toolbar and context menu wiring: their own tests;
// the canvas reflowing to one column: web/e2e/columns.
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuEntry, MenuGroup, MenuItem } from '@/ui';
import { pageAt } from '../../pagination/boundary';
import { docOf, p, page } from '../../schema/testing';
import { createTestEditor } from '../toolbar/testing';
import { columnsButtonLabel, columnsEntries } from './columnsMenu';

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

const content = () => docOf(page([p('one')]), page([p('two')], { kind: 'auto' }), page([p('three')], { columns: 1 }));
const group = (entries: MenuEntry[], id: string) => entries.find((e): e is MenuGroup => e.type === 'group' && e.id === id)!;
const item = (entries: MenuEntry[], id: string) =>
  entries.flatMap((e) => (e.type === 'group' ? e.items : [e])).find((e): e is MenuItem => 'id' in e && e.id === id)!;
const select = (entry: MenuItem) => {
  if (entry.type === 'checkbox' || entry.type === 'submenu') throw new Error('not an action');
  entry.onSelect();
};
const columns = (e: Editor) => e.state.doc.content.content.map((pg) => pg.attrs.columns as unknown);
const cursorOn = (e: Editor, index: number) => {
  const target = pageAt(e.state.doc, index)!;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, target.contentStart + 1)));
};

describe('columnsEntries', () => {
  it('names the section’s pages and checks its setting', () => {
    const e = (editor = createTestEditor(content()));
    cursorOn(e, 1);
    const entries = columnsEntries(e);
    expect(group(entries, 'columns-section').label).toBe('This section (pages 1–2)');
    expect(group(entries, 'columns-section').items.map((i) => ('label' in i ? i.label : '-'))).toEqual(['1 column', '2 columns', 'Theme default']);
    expect(item(entries, 'columns-section-theme')).toMatchObject({ type: 'radio', checked: true });
    expect(item(entries, 'columns-section-1')).toMatchObject({ checked: false });
    expect(group(entries, 'columns-all').items.map((i) => ('label' in i ? i.label : '-'))).toEqual([
      '1 column on every page',
      '2 columns on every page',
      'Theme default on every page',
    ]);
    cursorOn(e, 2);
    expect(group(columnsEntries(e), 'columns-section').label).toBe('This section (page 3)');
    expect(item(columnsEntries(e), 'columns-section-1')).toMatchObject({ checked: true });
  });

  it('switches the section, then every page, one undo step each, and runs afterSelect', () => {
    const e = (editor = createTestEditor(content()));
    const afterSelect = vi.fn();
    cursorOn(e, 0);
    select(item(columnsEntries(e, { afterSelect }), 'columns-section-1'));
    expect(columns(e)).toEqual([1, null, 1]); // no section sync in this editor: the first page only
    expect(afterSelect).toHaveBeenCalledTimes(1);
    expect(item(columnsEntries(e), 'columns-all-1')).toMatchObject({ disabled: true }); // already everywhere
    select(item(columnsEntries(e), 'columns-all-2'));
    expect(columns(e)).toEqual([2, null, 2]);
    e.commands.undo();
    expect(columns(e)).toEqual([1, null, 1]);
  });

  it('disables every choice in a read-only editor', () => {
    const e = (editor = createTestEditor(content(), { editable: false }));
    const items = columnsEntries(e).flatMap((g) => (g.type === 'group' ? g.items : []));
    expect(items.length).toBe(6);
    for (const i of items) expect(i).toMatchObject({ disabled: true });
  });
});

describe('columnsButtonLabel', () => {
  it('shows the setting, with an accessible name', () => {
    expect(columnsButtonLabel(null)).toEqual({ text: 'Columns', name: 'Columns: theme default' });
    expect(columnsButtonLabel(1)).toEqual({ text: '1 column', name: 'Columns: 1 column' });
    expect(columnsButtonLabel(2)).toEqual({ text: '2 columns', name: 'Columns: 2 columns' });
  });
});
