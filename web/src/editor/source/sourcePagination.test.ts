// Edit source with the paginating editor (line-model layout): applying is one undo step, and
// pagination splits the new flow again with join + split, outside the history.
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { mountPaginated, type MountedEditor } from '../pagination/testEditor';
import { DOC, P, PAGE, canonical, pageTexts, posOf, seamProblems } from '../pagination/testing';
import { buildApplyTransaction, parseSourceFor, sourceOf, targetFor, type SourceScope } from './index';

function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

let m: MountedEditor | undefined;
afterEach(() => {
  m?.destroy();
  m = undefined;
});

/** Opens the source of `scope` at the caret, edits it and applies it through the editor. */
function applyEdit(e: MountedEditor, scope: SourceScope, edit: (text: string) => string): string {
  const { state, schema } = e.editor;
  const target = targetFor(state, scope);
  const snapshot = sourceOf(schema, state.doc, target);
  const tr = buildApplyTransaction(state, target, parseSourceFor(schema, target, edit(snapshot.text), snapshot.rawHtml));
  if (tr) e.editor.view.dispatch(tr);
  return snapshot.text;
}

/** One column of 10 lines of 10 characters: "a…" (5 lines), "b…" split over three pages, "c". */
function mounted(): MountedEditor {
  m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), P(words('b', 200)), P('c'))), { lines: { columns: 1 } });
  m.settle();
  expect(m.editor.state.doc.childCount).toBe(3);
  return m;
}

const flow = (doc: PMNode) => canonical(doc).child(0).content;

describe('edit source in a paginated section', () => {
  it('shows the split paragraph whole, and unchanged source changes nothing', () => {
    const e = mounted();
    const before = e.editor.state.doc;
    e.select(posOf(before, 'b10 '));
    const text = applyEdit(e, 'section', (t) => t);
    expect(text).toContain(`<p>${words('b', 200)}</p>`);
    expect(text).not.toContain('hb-continued');
    expect(e.editor.state.doc).toBe(before);
  });

  it('editing the split paragraph: one undo step; pagination splits it again', () => {
    const e = mounted();
    const before = e.editor.state.doc;
    e.select(posOf(before, 'b10 '));
    applyEdit(e, 'selection', (t) => t.replace('b10 ', 'B10 '));
    e.settle();
    const after = e.editor.state.doc;
    expect(flow(after).child(1).textContent).toBe(words('b', 200).replace('b10 ', 'B10 '));
    expect(pageTexts(after).map((texts) => texts.length)).toEqual(pageTexts(before).map((texts) => texts.length));
    expect(seamProblems(after)).toEqual([]);
    expect(after.child(0).attrs.pid).toBe('aaaaaaaa');

    expect(e.editor.commands.undo()).toBe(true);
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('deleting most of the section: its auto pages go; undo brings everything back', () => {
    const e = mounted();
    const before = e.editor.state.doc;
    e.select(posOf(before, 'c'));
    applyEdit(e, 'section', (t) => t.replace(/<p>b[^<]*<\/p>\n/, ''));
    e.settle();
    expect(pageTexts(e.editor.state.doc)).toEqual([[words('a', 50), 'c']]);
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('a new section in the whole-brew source becomes a manual page with its own auto pages', () => {
    const e = mounted();
    applyEdit(e, 'brew', (t) => `${t}\n\n<div class="page hb-cols-1"><h1>Two</h1><p>${words('d', 150)}</p></div>`);
    e.settle();
    const doc = e.editor.state.doc;
    const kinds = Array.from({ length: doc.childCount }, (_, i) => doc.child(i).attrs.kind as unknown);
    expect(kinds.slice(0, 4)).toEqual(['manual', 'auto', 'auto', 'manual']);
    expect(kinds.length).toBeGreaterThan(4);
    expect(doc.child(3).attrs.pid).toEqual(expect.any(String));
    expect(seamProblems(doc)).toEqual([]);
  });
});

describe('a long brew', () => {
  /** 100 sections of 3 paragraphs. */
  const long = () => DOC(...Array.from({ length: 100 }, (_, i) => PAGE({ pid: `p${i}` }, P(`Section ${i}`), P(words(`s${i}w`, 60)), P('end'))));

  it('whole-brew source of 100 pages: unchanged applies nothing; a one-word edit is one small step', () => {
    m = mountPaginated(long(), { lines: { columns: 1 } });
    m.settle();
    const before = m.editor.state.doc;
    applyEdit(m, 'brew', (t) => t);
    expect(m.editor.state.doc).toBe(before);

    const { state, schema } = m.editor;
    const target = targetFor(state, 'brew');
    const snapshot = sourceOf(schema, state.doc, target);
    const tr = buildApplyTransaction(state, target, parseSourceFor(schema, target, snapshot.text.replace('Section 57<', 'Chapter 57<')))!;
    expect(tr.steps).toHaveLength(1);
    const step = tr.steps[0]!.getMap();
    let changed = 0;
    step.forEach((oldStart, oldEnd) => (changed += oldEnd - oldStart));
    expect(changed).toBeLessThan(10);
    m.editor.view.dispatch(tr);
    expect(m.editor.state.doc.child(57).firstChild!.textContent).toBe('Chapter 57');
    expect(m.editor.state.doc.child(56)).toBe(before.child(56));
  });
});
