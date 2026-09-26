// applyDoc.ts: replacing the document with another version without losing the caret or the
// undo history outside the replaced range.
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceDocTransaction, replaceDocument } from './applyDoc';
import { SERVER_DOC_META } from './dirty';
import { docOf, mountEditor, texts, typeText } from './testing';

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

const twoPages = (a: string[], b: string[]): JSONContent => ({
  type: 'doc',
  content: [
    { type: 'page', attrs: { pid: 'page0001' }, content: a.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) },
    { type: 'page', attrs: { pid: 'page0002' }, content: b.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) },
  ],
});

describe('replaceDocTransaction', () => {
  it('is null for an equal document, whatever the key order', () => {
    editor = mountEditor(docOf('One', 'Two')).editor;
    const same = editor.state.schema.nodeFromJSON(JSON.parse(JSON.stringify(editor.getJSON())));
    expect(replaceDocTransaction(editor.state, same)).toBeNull();
  });

  it('replaces only the range that differs', () => {
    editor = mountEditor(docOf('Alpha', 'Bravo', 'Charlie')).editor;
    const next = editor.state.schema.nodeFromJSON(docOf('Alpha', 'Bravissimo', 'Charlie'));
    const tr = replaceDocTransaction(editor.state, next)!;
    expect(tr.doc.eq(next)).toBe(true);
    expect(tr.steps).toHaveLength(1);
    const map = tr.mapping.maps[0]!;
    let touched = 0;
    map.forEach((oldStart, oldEnd) => (touched += oldEnd - oldStart));
    expect(touched).toBeLessThanOrEqual('Bravo'.length);
  });

  it('handles structural differences (a page added, a block type changed)', () => {
    editor = mountEditor(twoPages(['A'], ['B'])).editor;
    const withPage = editor.state.schema.nodeFromJSON({
      ...twoPages(['A'], ['B']),
      content: [...(twoPages(['A'], ['B']).content ?? []), { type: 'page', attrs: { pid: 'page0003' }, content: [{ type: 'paragraph' }] }],
    });
    expect(replaceDocTransaction(editor.state, withPage)!.doc.eq(withPage)).toBe(true);
    const heading = editor.state.schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'page', attrs: { pid: 'page0001' }, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'A' }] }] },
        { type: 'page', attrs: { pid: 'page0002' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
      ],
    });
    expect(replaceDocTransaction(editor.state, heading)!.doc.eq(heading)).toBe(true);
  });
});

describe('replaceDocument', () => {
  it('keeps the caret and the undo history of untouched text (outside the history)', () => {
    editor = mountEditor(twoPages(['First'], ['Second'])).editor;
    typeText(editor, ' edited', 0); // an undo step in page 1
    const caret = editor.state.doc.resolve(3).pos;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caret)));
    const next = twoPages(['First edited'], ['Second, sanitized']);
    expect(replaceDocument(editor, next, { undoable: false, dirty: false })).toBe(true);
    expect(texts(editor)).toEqual(['First edited', 'Second, sanitized']);
    expect(editor.state.selection.from).toBe(caret);
    // The author's step survived the server sync, and undoing it leaves the sync alone.
    expect(undoDepth(editor.state)).toBe(1);
    editor.commands.undo();
    expect(texts(editor)).toEqual(['First', 'Second, sanitized']);
  });

  it('is one undo step of its own when undoable', () => {
    editor = mountEditor(docOf('Mine')).editor;
    typeText(editor, ' typed');
    replaceDocument(editor, docOf('Restored', 'Two'), { undoable: true, dirty: true });
    expect(texts(editor)).toEqual(['Restored', 'Two']);
    editor.commands.undo();
    expect(texts(editor)).toEqual(['Mine typed']);
    editor.commands.undo();
    expect(texts(editor)).toEqual(['Mine']);
  });

  it('marks server syncs so autosave ignores them', () => {
    editor = mountEditor(docOf('Mine')).editor;
    const metas: unknown[] = [];
    editor.on('transaction', ({ transaction }) => metas.push(transaction.getMeta(SERVER_DOC_META)));
    replaceDocument(editor, docOf('Server'), { undoable: true, dirty: false });
    replaceDocument(editor, docOf('Restored'), { undoable: true, dirty: true });
    expect(metas).toEqual([true, undefined]);
  });

  it('does nothing for an equal document and throws for one that breaks the schema', () => {
    editor = mountEditor(docOf('Same')).editor;
    expect(replaceDocument(editor, docOf('Same'), { undoable: true, dirty: true })).toBe(false);
    expect(() => replaceDocument(editor!, { type: 'doc', content: [{ type: 'paragraph' }] }, { undoable: true, dirty: true })).toThrow();
    expect(texts(editor)).toEqual(['Same']);
  });
});
