// Column commands (columns.ts): the section at the cursor and every section, one undo step each,
// auto pages following through the section sync. The menus that use them: ui/columns.
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { pageAt } from '../pagination/boundary';
import { sectionSyncPlugin } from '../pagination/sections';
import { docOf, p, page } from '../schema/testing';
import { columnsAt, renderedColumnsAt, setAllColumns, setSectionColumns } from './columns';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const SectionSync = Extension.create({ name: 'testSectionSync', addProseMirrorPlugins: () => [sectionSyncPlugin()] });

function makeEditor(content: JSONContent): Editor {
  editor = new Editor({ extensions: buildEditorExtensions({ extensions: [SectionSync] }), content });
  return editor;
}

// Two sections: pages 0–2 (two columns) and pages 3–4 (the theme's default).
const content = () =>
  docOf(
    page([p('s1 p0')], { columns: 2 }),
    page([p('s1 p1')], { kind: 'auto', columns: 2 }),
    page([p('s1 p2')], { kind: 'auto', columns: 2 }),
    page([p('s2 p3')]),
    page([p('s2 p4')], { kind: 'auto' }),
  );

const columns = (e: Editor) => e.state.doc.content.content.map((pg) => pg.attrs.columns as unknown);
const dispatch = (e: Editor) => (tr: Parameters<typeof e.view.dispatch>[0]) => e.view.dispatch(tr);
const cursorOn = (e: Editor, index: number) => {
  const target = pageAt(e.state.doc, index)!;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, target.contentStart + 1)));
};

describe('columnsAt', () => {
  it('reads the section at the cursor and whether every section agrees', () => {
    const e = makeEditor(content());
    cursorOn(e, 2);
    expect(columnsAt(e.state)).toEqual({ section: 2, all: 'mixed' });
    cursorOn(e, 4);
    expect(columnsAt(e.state)).toEqual({ section: null, all: 'mixed' });
    expect(setAllColumns(e.state, dispatch(e), 1)).toEqual({ ok: true, changed: true });
    expect(columnsAt(e.state)).toEqual({ section: 1, all: 1 });
  });
});

describe('setSectionColumns', () => {
  it('changes the section at the cursor only; auto pages follow; one undo step', () => {
    const e = makeEditor(content());
    cursorOn(e, 4);
    expect(setSectionColumns(e.state, dispatch(e), 1)).toEqual({ ok: true, changed: true });
    expect(columns(e)).toEqual([2, 2, 2, 1, 1]);
    cursorOn(e, 1);
    expect(setSectionColumns(e.state, dispatch(e), null)).toEqual({ ok: true, changed: true });
    expect(columns(e)).toEqual([null, null, null, 1, 1]);
    e.commands.undo();
    expect(columns(e)).toEqual([2, 2, 2, 1, 1]);
    e.commands.undo();
    expect(columns(e)).toEqual([2, 2, 2, null, null]);
  });

  it('refuses an invalid value and reports an unchanged setting', () => {
    const e = makeEditor(content());
    const before = e.state.doc;
    expect(setSectionColumns(e.state, dispatch(e), 3 as never)).toMatchObject({ ok: false });
    expect(setSectionColumns(e.state, dispatch(e), 2)).toEqual({ ok: true, changed: false });
    expect(e.state.doc).toBe(before);
  });
});

describe('setAllColumns', () => {
  it('sets every section in one undo step', () => {
    const e = makeEditor(content());
    expect(setAllColumns(e.state, dispatch(e), 1)).toEqual({ ok: true, changed: true });
    expect(columns(e)).toEqual([1, 1, 1, 1, 1]);
    e.commands.undo();
    expect(columns(e)).toEqual([2, 2, 2, null, null]);
  });

  it('changes nothing when every section already has the value; refuses invalid values', () => {
    const e = makeEditor(docOf(page([p('a')], { columns: 1 }), page([p('b')], { columns: 1 })));
    const before = e.state.doc;
    expect(setAllColumns(e.state, dispatch(e), 1)).toEqual({ ok: true, changed: false });
    expect(setAllColumns(e.state, dispatch(e), 0 as never)).toMatchObject({ ok: false });
    expect(e.state.doc).toBe(before);
  });
});

describe('renderedColumnsAt', () => {
  it('is null without layout (jsdom computes no column-count)', () => {
    const e = makeEditor(content());
    expect(renderedColumnsAt(e.view)).toBeNull();
  });
});
