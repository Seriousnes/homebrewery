// What the BlockMenu and TableMenu offer for a state (pure: no DOM).
import { EditorState, NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import { tableEditing } from '@tiptap/pm/tables';
import { describe, expect, it } from 'vitest';
import { applyObjectSelection, objectSelectionKey, OBJECT_SELECTION, type ObjectSelectionState } from '../../objects/state';
import { DOC, P, PAGE, posOf, schema } from '../../pagination/testing';
import type { PageObject } from '../../schema';
import { createTable } from '../../tables/commands';
import { tableMenuContext } from '../tableMenu/tableMenuContext';
import { blockMenuContext } from './blockMenuContext';

const selection = () =>
  new Plugin<ObjectSelectionState>({ key: objectSelectionKey, state: { init: (): ObjectSelectionState => ({ selected: null }), apply: (tr, prev) => applyObjectSelection(tr, prev) } });

const IMG: PageObject = { id: 'o1', kind: 'image', classes: ['banner'], style: 'position: absolute;', src: 'a.png' };
const TXT: PageObject = { id: 'o2', kind: 'text', classes: [], style: 'position: absolute;', text: 'Chapter One' };

describe('blockMenuContext', () => {
  it('describes the selection page, its cover and objects, and what can be inserted', () => {
    const doc = DOC(PAGE(null, P('One')), PAGE({ markers: ['partCover'], objects: [IMG, TXT] }, P('Two'), schema.nodes.spacer!.create()));
    let state = EditorState.create({ doc, plugins: [selection()] });
    state = state.apply(state.tr.setSelection(TextSelection.create(doc, posOf(doc, 'Two') + 3)));
    const ctx = blockMenuContext(state);
    expect(ctx.pageNumber).toBe(2);
    expect(ctx.cover).toBe('partCover');
    expect(ctx.objects.map((o) => o.label)).toEqual(['Image 1 (banner)', 'Text “Chapter One”']);
    expect(ctx.canInsert).toMatchObject({ definitionList: true, spacer: true, columnBreak: true, horizontalRule: true, pageBreak: true });
    expect(ctx.removable).toEqual(['spacer']); // the caret is at the end of "Two", the spacer follows
    expect(ctx.selected).toBeNull();
    expect(ctx.imagePos).toBeNull();
  });

  it('follows the selected object (its page wins over the caret) and a node-selected image', () => {
    const image = schema.nodes.image!.create({ src: 'b.png' });
    const doc = DOC(PAGE(null, schema.nodes.paragraph!.create(null, [schema.text('x'), image])), PAGE({ objects: [IMG, TXT] }, P('Two')));
    let state = EditorState.create({ doc, plugins: [selection()] });
    const page2 = doc.child(0).nodeSize;
    state = state.apply(state.tr.setMeta(OBJECT_SELECTION, { pagePos: page2, id: 'o2' }));
    let ctx = blockMenuContext(state);
    expect(ctx.pagePos).toBe(page2);
    expect(ctx.selected).toMatchObject({ id: 'o2', kind: 'text', index: 1, count: 2 });
    state = state.apply(state.tr.setMeta(OBJECT_SELECTION, null).setSelection(NodeSelection.create(state.doc, 3)));
    ctx = blockMenuContext(state);
    expect(ctx.imagePos).toBe(3);
    expect(ctx.pagePos).toBe(0);
  });
});

describe('tableMenuContext', () => {
  it('outside a table offers insertion only; inside, the row/column/cell commands', () => {
    const doc = DOC(PAGE(null, P('Intro'), createTable(schema, { rows: 3, cols: 2 })!));
    let state = EditorState.create({ doc, plugins: [tableEditing()] });
    state = state.apply(state.tr.setSelection(TextSelection.create(doc, 3)));
    let ctx = tableMenuContext(state);
    expect(ctx.inTable).toBe(false);
    expect(ctx.canInsertTable).toBe(true);
    const cell = posOf(doc, 'Intro') + 5 + 4; // into the first header cell's paragraph
    state = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(cell))));
    ctx = tableMenuContext(state);
    expect(ctx.inTable).toBe(true);
    expect(ctx.headerRow).toBe(true);
    expect(ctx.can).toMatchObject({ addRowAfter: true, deleteRow: true, addColumnAfter: true, deleteColumn: true, mergeCells: false, deleteTable: true });
    expect(ctx.classes).toEqual({ classTable: false, frame: false, decoration: false, wide: false });
  });
});
