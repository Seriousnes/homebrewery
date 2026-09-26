// dirty.ts: which transactions autosave saves (plan §9: docChanged && !PAGINATE, and not the
// id bookkeeping or a server sync).
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { FRAGMENT_ATTRS } from '../pagination/fragments';
import { PAGINATE } from '../pagination/state';
import { LAYOUT_NEUTRAL_META } from '../schema/plugins/meta';
import { isDirtyDispatch, isDirtyTransaction, SERVER_DOC_META } from './dirty';
import { docOf, mountEditor, typeText } from './testing';

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

function record(ed: Editor): { transaction: Transaction; appended: Transaction[] }[] {
  const seen: { transaction: Transaction; appended: Transaction[] }[] = [];
  ed.on('transaction', ({ transaction, appendedTransactions }) => seen.push({ transaction, appended: appendedTransactions }));
  return seen;
}

describe('isDirtyTransaction', () => {
  it('counts an author edit, and undo', () => {
    editor = mountEditor(docOf('Hello')).editor;
    const seen = record(editor);
    typeText(editor, ' world');
    editor.commands.undo();
    expect(seen.map((s) => isDirtyDispatch(s.transaction, s.appended))).toEqual([true, true]);
  });

  it('ignores selection-only and meta-only transactions', () => {
    editor = mountEditor(docOf('Hello')).editor;
    expect(isDirtyTransaction(editor.state.tr.setSelection(editor.state.selection))).toBe(false);
    expect(isDirtyTransaction(editor.state.tr.setMeta('hbRepaginate', 0))).toBe(false);
  });

  it('ignores pagination, id bookkeeping and server syncs', () => {
    editor = mountEditor(docOf('Hello')).editor;
    const edit = () => editor!.state.tr.insertText('x', 2);
    expect(isDirtyTransaction(edit())).toBe(true);
    expect(isDirtyTransaction(edit().setMeta(PAGINATE, { dirtyFrom: null, dirtyTo: 0, action: 'push' }))).toBe(false);
    expect(isDirtyTransaction(edit().setMeta(LAYOUT_NEUTRAL_META, true))).toBe(false);
    expect(isDirtyTransaction(edit().setMeta(SERVER_DOC_META, true))).toBe(false);
  });
});

describe('isDirtyDispatch', () => {
  it('lets appended transactions follow their root', () => {
    editor = mountEditor(docOf('Hello')).editor;
    const author = editor.state.tr.insertText('x', 2);
    const fragmentSync = editor.state.tr.insertText('y', 2).setMeta(FRAGMENT_ATTRS, true);
    const selection = editor.state.tr.setSelection(editor.state.selection);
    const paginate = editor.state.tr.insertText('z', 2).setMeta(PAGINATE, { dirtyFrom: null, dirtyTo: 0, action: 'push' });
    const server = editor.state.tr.insertText('s', 2).setMeta(SERVER_DOC_META, true);
    // The fragment-attribute sync pagination appends to an author's edit is part of that edit.
    expect(isDirtyDispatch(author, [fragmentSync])).toBe(true);
    // A root that changed nothing can still carry an author's appended change.
    expect(isDirtyDispatch(selection, [fragmentSync])).toBe(true);
    // Whatever is appended to pagination or a server sync is not the author's.
    expect(isDirtyDispatch(paginate, [fragmentSync])).toBe(false);
    expect(isDirtyDispatch(server, [fragmentSync])).toBe(false);
  });
});
