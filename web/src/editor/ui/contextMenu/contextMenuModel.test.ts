// The context menu's model: what it offers per selection kind (caret, text, node, table cells,
// theme block, code block), the block it acts on, and the actions that change the document (one
// undo step each).
import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuEntry, MenuItem } from '@/ui';
import { AUTO, BLOCK, DOC, P, PAGE, PC, posOf, schema } from '../../pagination/testing';
import { createTestEditor, selectNode, selectText } from '../toolbar/testing';
import { blockTarget, contextMenuContext, contextMenuEntries, deleteBlock, type ContextMenuDeps } from './contextMenuModel';

const node = (name: string, content?: PMNode[], attrs: Record<string, unknown> | null = null) => schema.nodes[name]!.create(attrs, content);
const cell = (text: string) => node('tableCell', [P(text)]);
const TABLE = node('table', [node('tableRow', [cell('A1'), cell('B1')]), node('tableRow', [cell('A2'), cell('B2')])]);
const CODE = node('codeBlock', [schema.text('let x = 1;')]);

/** A page with a paragraph (bold "strong"), a theme block, a table, a spacer and a code block. */
const DOCUMENT = DOC(
  PAGE(
    null,
    schema.nodes.paragraph!.create(null, [schema.text('Plain and '), schema.text('strong', [schema.marks.bold!.create()]), schema.text(' words.')]),
    BLOCK(['note'], P('Inside the note.')),
    TABLE,
    node('spacer'),
    CODE,
  ),
);

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

function open(): Editor {
  editor = createTestEditor(DOCUMENT.toJSON() as JSONContent);
  return editor;
}

/** Every entry of the menu by id (groups and submenus included). */
function byId(entries: readonly MenuEntry[]): Map<string, MenuEntry> {
  const out = new Map<string, MenuEntry>();
  const walk = (list: readonly MenuEntry[]) => {
    for (const e of list) {
      if (e.id) out.set(e.id, e);
      if (e.type === 'group' || e.type === 'submenu') walk(e.items);
    }
  };
  walk(entries);
  return out;
}

const deps = (over: Partial<ContextMenuDeps> = {}): ContextMenuDeps => ({ clipboard: vi.fn(), properties: vi.fn(), textStyles: [], ...over });

function menu(e: Editor, over: Partial<ContextMenuDeps> = {}) {
  const ctx = contextMenuContext(e.state);
  return { ctx, items: byId(contextMenuEntries(e, ctx, deps(over))) };
}

const item = (items: Map<string, MenuEntry>, id: string): MenuItem => {
  const e = items.get(id);
  if (!e || e.type === 'separator' || e.type === 'group') throw new Error(`no item ${id}`);
  return e;
};
const disabled = (items: Map<string, MenuEntry>, id: string) => Boolean(item(items, id).disabled);
const run = (items: Map<string, MenuEntry>, id: string) => {
  const e = item(items, id);
  if (e.type === 'checkbox') e.onCheckedChange(!e.checked);
  else if (e.type !== 'submenu') e.onSelect();
};

describe('contextMenuContext and the entries per selection kind', () => {
  it('caret in a paragraph: no Cut/Copy, Paste, formatting, the paragraph as the block, nothing to unwrap', () => {
    const e = open();
    selectText(e, 'Plain', 2);
    const { ctx, items } = menu(e);
    expect(ctx.selection).toBe('caret');
    expect([disabled(items, 'cut'), disabled(items, 'copy'), disabled(items, 'paste'), disabled(items, 'pastePlain')]).toEqual([true, true, false, false]);
    expect(disabled(items, 'format')).toBe(false);
    expect(item(items, 'link').label).toBe('Link…');
    expect(disabled(items, 'table')).toBe(true); // not in a table: shown, disabled
    expect(disabled(items, 'block-unwrap')).toBe(true);
    expect(item(items, 'block-delete').label).toBe('Delete paragraph');
    expect(items.get('block')).toMatchObject({ type: 'group', label: 'Paragraph' });
    expect(disabled(items, 'insert-table')).toBe(false);
    expect(item(items, 'cut').shortcut).toBe('Ctrl+X');
    expect(item(items, 'pastePlain').shortcut).toBe('Ctrl+Shift+V');
  });

  it('a text range: Cut and Copy, the active marks checked', () => {
    const e = open();
    selectText(e, 'strong');
    const { ctx, items } = menu(e);
    expect(ctx.selection).toBe('text');
    expect(disabled(items, 'cut')).toBe(false);
    expect(disabled(items, 'copy')).toBe(false);
    expect(items.get('mark-bold')).toMatchObject({ type: 'checkbox', checked: true, shortcut: 'Ctrl+B' });
    expect(items.get('mark-italic')).toMatchObject({ checked: false });
  });

  it('in a theme block: the block group is the theme block, which can be unwrapped', () => {
    const e = open();
    selectText(e, 'Inside', 1);
    const { ctx, items } = menu(e);
    expect(ctx.themeBlock).toEqual(['note']);
    expect(ctx.block).toMatchObject({ type: 'themeBlock', label: 'Theme block' });
    expect(disabled(items, 'block-unwrap')).toBe(false);
    expect(item(items, 'block-delete').label).toBe('Delete theme block');
  });

  it('in a table: the Table submenu takes the table entries; no table inside a table', () => {
    const e = open();
    selectText(e, 'B2', 1);
    const tableItems: MenuEntry[] = [{ id: 'row-after', label: 'Add row below', onSelect: () => {} }];
    let { ctx, items } = menu(e);
    expect(ctx.inTable).toBe(true);
    expect(disabled(items, 'table')).toBe(true); // no entries given
    expect(disabled(items, 'insert-table')).toBe(true);
    ({ items } = menu(e, { table: tableItems }));
    expect(disabled(items, 'table')).toBe(false);
    expect(item(items, 'row-after').label).toBe('Add row below');
    expect(ctx.block).toMatchObject({ type: 'table', label: 'Table' });
  });

  it('table cells selected: a range (Cut, Copy)', () => {
    const e = open();
    // Cell positions: the text starts inside cell › paragraph.
    const cellAt = (text: string) => posOf(e.state.doc, text) - 2;
    e.view.dispatch(e.state.tr.setSelection(CellSelection.create(e.state.doc, cellAt('A1'), cellAt('B2'))));
    const { ctx, items } = menu(e);
    expect(ctx.selection).toBe('cells');
    expect(disabled(items, 'copy')).toBe(false);
  });

  it('a selected spacer: a node selection; no formatting; the spacer is the block', () => {
    const e = open();
    let spacer = -1;
    e.state.doc.descendants((n, pos) => {
      if (n.type.name === 'spacer') spacer = pos;
    });
    selectNode(e, spacer);
    const { ctx, items } = menu(e);
    expect(ctx.selection).toBe('node');
    expect(disabled(items, 'format')).toBe(true);
    expect(disabled(items, 'link')).toBe(true);
    expect(disabled(items, 'cut')).toBe(false);
    expect(ctx.block).toMatchObject({ type: 'spacer', pos: spacer });
  });

  it('in a code block: plain text, so no marks, link or span', () => {
    const e = open();
    selectText(e, 'let x', 2);
    const { ctx, items } = menu(e);
    expect(ctx.inText).toBe(false);
    expect(ctx.blockKind).toBe('codeBlock');
    expect([disabled(items, 'format'), disabled(items, 'link'), disabled(items, 'span')]).toEqual([true, true, true]);
  });

  it('the Text style submenu takes the entries it is given', () => {
    const e = open();
    selectText(e, 'Plain', 1);
    const { items } = menu(e, { textStyles: [{ id: 'ts-title', label: 'Title', onSelect: () => {} }] });
    expect(item(items, 'ts-title').label).toBe('Title');
  });
});

describe('actions', () => {
  it('a mark is one undo step; clipboard and properties go to the host', () => {
    const e = open();
    selectText(e, 'Plain');
    const d = deps();
    const items = byId(contextMenuEntries(e, contextMenuContext(e.state), d));
    const before = e.state.doc;
    run(items, 'mark-italic');
    expect(e.state.doc.eq(before)).toBe(false);
    e.commands.undo();
    expect(e.state.doc.eq(before)).toBe(true);
    run(items, 'copy');
    run(items, 'pastePlain');
    expect(d.clipboard).toHaveBeenNthCalledWith(1, 'copy');
    expect(d.clipboard).toHaveBeenNthCalledWith(2, 'pastePlain');
    run(items, 'block-properties');
    expect(d.properties).toHaveBeenCalledTimes(1);
  });

  it('Delete theme block removes the whole block in one undo step', () => {
    const e = open();
    selectText(e, 'Inside', 1);
    const before = e.state.doc;
    run(menu(e).items, 'block-delete');
    expect(e.state.doc.textContent).not.toContain('Inside the note.');
    let blocks = 0;
    e.state.doc.descendants((n) => void (n.type.name === 'themeBlock' && blocks++));
    expect(blocks).toBe(0);
    e.commands.undo();
    expect(e.state.doc.eq(before)).toBe(true);
  });

  it('Unwrap theme block keeps the text', () => {
    const e = open();
    selectText(e, 'Inside', 1);
    run(menu(e).items, 'block-unwrap');
    expect(e.state.doc.textContent).toContain('Inside the note.');
    expect(contextMenuContext(e.state).themeBlock).toBeNull();
  });

  it('keymap requests: snippet, table, source, link, span, theme block', () => {
    const e = open();
    selectText(e, 'Plain', 1);
    const requests: string[] = [];
    const storage = (e.storage as unknown as { hbKeymap: { listeners: Set<(r: string) => boolean> } }).hbKeymap;
    storage.listeners.add((r) => (requests.push(r), true));
    const { items } = menu(e);
    for (const id of ['insert-snippet', 'insert-table', 'edit-source', 'link', 'span', 'block-wrap']) run(items, id);
    expect(requests).toEqual(['insertSnippet', 'insertTable', 'editSource', 'link', 'span', 'themeBlock']);
  });
});

describe('deleteBlock', () => {
  it('deletes every fragment of a block pagination split, and keeps a page from being empty', () => {
    const doc = DOC(PAGE(null, P('before'), P('head of it')), AUTO(null, PC('tail of it')));
    let state = EditorState.create({ doc, schema });
    state = state.apply(state.tr.setSelection(TextSelection.create(doc, posOf(doc, 'tail') + 2)));
    expect(blockTarget(state)?.pos).toBe(doc.child(0).nodeSize + 1);
    let next: EditorState | null = null;
    expect(deleteBlock(state, (tr) => (next = state.apply(tr)))).toBe(true);
    const after = next!.doc;
    expect(after.textContent).toBe('before');
    expect(after.child(1).childCount).toBe(1); // the auto page keeps an empty paragraph
    expect(after.child(1).firstChild!.textContent).toBe('');
  });

  it('a node selection deletes that node', () => {
    const doc = DOC(PAGE(null, P('a'), node('spacer'), P('b')));
    let state = EditorState.create({ doc, schema });
    const spacer = doc.child(0).child(0).nodeSize + 1;
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, spacer)));
    let next: EditorState | null = null;
    deleteBlock(state, (tr) => (next = state.apply(tr)));
    expect(next!.doc.child(0).childCount).toBe(2);
  });
});
