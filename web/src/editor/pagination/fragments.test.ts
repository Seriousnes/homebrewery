// fragments.ts on the line model (1 column of 10 lines of 10 characters), keys pressed through the
// editor's keymaps: continuation flags that no chain reaches any more are repaired in the author's
// undo event (repairContinuations), and new head attributes travel along a whole chain.
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { pageAt } from './boundary';
import { repaginate } from './plugin';
import { mountPaginated, type MountedEditor } from './testEditor';
import { DOC, H, OL, P, PAGE, UL, canonical, li, pageTexts, posOf, seamProblems } from './testing';

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

/** The line model's options of the last mount (mutable: a font or CSS change). */
let lineOptions = { columns: 1, lines: 10 };

function mount(doc: PMNode): MountedEditor {
  lineOptions = { columns: 1, lines: 10 };
  m = mountPaginated(doc, { lines: lineOptions });
  m.settle();
  return m;
}

/** Continuation flags that are not at the top of an auto page (where fragmentChain reaches them). */
function strayFlags(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((page, _offset, index) => {
    page.forEach((block, _o, k) => {
      block.descendants((node) => {
        if (!node.isText && node.attrs.continuation === true && k > 0) out.push(`page ${index}: ${node.type.name} "${node.textContent.slice(0, 12)}"`);
      });
      if (block.attrs.continuation === true && k > 0) out.push(`page ${index}: ${block.type.name} "${block.textContent.slice(0, 12)}"`);
    });
  });
  return out;
}

/** The same edit on the same document laid out on one tall page (nothing split): canonical(). */
function unsplit(doc: PMNode, edit: (e: MountedEditor) => void): PMNode {
  const u = mountPaginated(doc, { lines: { columns: 1, lines: 200 } });
  u.settle();
  edit(u);
  u.settle();
  const result = canonical(u.editor.state.doc);
  u.destroy();
  return result;
}

describe('undo of a heading / paragraph join after pagination re-split the result (PGR-1)', () => {
  // "a…" and "b…" fill page 0; the heading starts page 1 (auto).
  const doc = () => DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 50)), P(words('b', 35)), H(2, 'Heading of chapter X'), P(words('c', 30))));

  it('Backspace at the heading\'s start, settle, undo: the heading is whole again', () => {
    const e = mount(doc());
    const original = e.editor.state.doc;
    expect(pageTexts(original)[1]![0]).toBe('Heading of chapter X');
    e.select(posOf(original, 'Heading'));
    e.press('Backspace');
    e.settle();
    // The joined paragraph is split again: its tail starts page 1.
    expect(e.editor.state.doc.child(1).firstChild!.attrs.continuation).toBe(true);
    expect(e.editor.commands.undo()).toBe(true);
    e.settle();
    expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
    expect(seamProblems(e.editor.state.doc)).toEqual([]);
    expect(strayFlags(e.editor.state.doc)).toEqual([]);
    // Redo gives the join back.
    expect(e.editor.commands.redo()).toBe(true);
    e.settle();
    expect(canonical(e.editor.state.doc).child(0).child(1).textContent).toBe(words('b', 35) + 'Heading of chapter X');
  });

  it('Delete at the end of the paragraph before the heading, settle, undo: the same', () => {
    const e = mount(doc());
    const original = e.editor.state.doc;
    e.select(pageAt(original, 0)!.contentEnd - 1); // the end of "b…" (page 0's end)
    e.press('Delete');
    e.settle();
    expect(canonical(e.editor.state.doc).child(0).child(1).textContent).toBe(words('b', 35) + 'Heading of chapter X');
    expect(e.editor.state.doc.child(1).firstChild!.attrs.continuation).toBe(true);
    expect(e.editor.commands.undo()).toBe(true);
    e.settle();
    expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
    expect(strayFlags(e.editor.state.doc)).toEqual([]);
  });

  it('a paragraph head joined into a heading takes its whole text along (as unsplit)', () => {
    // The heading ends page 0's flow before a split paragraph: Backspace at the paragraph's start.
    const d = DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 40)), H(2, 'Title'), P(words('p', 100))));
    const edit = (x: MountedEditor) => {
      x.select(posOf(x.editor.state.doc, 'p0 '));
      x.press('Backspace');
    };
    const expected = unsplit(d, edit);
    const e = mount(d);
    const original = e.editor.state.doc;
    expect(original.child(1).firstChild!.attrs.continuation).toBe(true);
    edit(e);
    e.settle();
    expect(canonical(e.editor.state.doc).toJSON()).toEqual(expected.toJSON());
    expect(strayFlags(e.editor.state.doc)).toEqual([]);
    e.editor.commands.undo();
    e.settle();
    expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
  });
});

describe('a split paragraph\'s head moved into a list (PGR-4)', () => {
  const afterList = (list: PMNode, tag: string) => DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 40)), list, P(words(tag, 100))));

  const cases: [string, () => PMNode, (e: MountedEditor) => void][] = [
    [
      'Backspace at its start after an ordered list',
      () => afterList(OL(null, li('o7a item'), li('o7b item')), 'p8x'),
      (e) => {
        e.select(posOf(e.editor.state.doc, 'p8x0 '));
        e.press('Backspace');
      },
    ],
    [
      'Delete at the end of the bullet list before it',
      () => afterList(UL(null, li('u1 item'), li('u2 item')), 'p13x'),
      (e) => {
        e.select(posOf(e.editor.state.doc, 'u2 item') + 7);
        e.press('Delete');
      },
    ],
    [
      'a range deleted from a list item into it',
      () => afterList(UL(null, li('u1 item'), li('u2 item')), 'p13x'),
      (e) => {
        e.select(posOf(e.editor.state.doc, 'u2 item') + 3, posOf(e.editor.state.doc, 'p13x2 '));
        e.press('Backspace');
      },
    ],
  ];

  for (const [name, doc, edit] of cases) {
    it(`${name}: the whole paragraph goes into the list, as unsplit; undo restores it`, () => {
      const expected = unsplit(doc(), edit);
      const e = mount(doc());
      const original = e.editor.state.doc;
      expect(original.child(1).firstChild!.attrs.continuation).toBe(true);
      edit(e);
      e.settle();
      expect(canonical(e.editor.state.doc).toJSON()).toEqual(expected.toJSON());
      expect(strayFlags(e.editor.state.doc)).toEqual([]);
      expect(seamProblems(e.editor.state.doc)).toEqual([]);
      expect(e.editor.commands.undo()).toBe(true);
      e.settle();
      expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
    });
  }
});

describe('new paragraphs inside a continuation are not continuations (PGR-6)', () => {
  const split = () => mount(DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 50)), P(words('b', 100)))));

  it('Enter in the middle of a continuation: only the fragment at the top of the page keeps the flag', () => {
    const e = split();
    e.select(pageAt(e.editor.state.doc, 1)!.contentStart + 1 + 4);
    e.press('Enter');
    const page = e.editor.state.doc.child(1);
    expect(page.childCount).toBe(2);
    expect(page.child(0).attrs.continuation).toBe(true);
    expect(page.child(1).attrs.continuation).toBe(false);
    e.settle();
    expect(strayFlags(e.editor.state.doc)).toEqual([]);
    // One undo step gives the paragraph back whole.
    e.editor.commands.undo();
    e.settle();
    expect(canonical(e.editor.state.doc).child(0).childCount).toBe(2);
  });

  it('blocks inserted in the middle of a continuation (a snippet, a pasted heading): the text after them is a paragraph of its own', () => {
    const e = split();
    const at = pageAt(e.editor.state.doc, 1)!.contentStart + 1 + 20;
    e.editor.commands.insertContentAt(at, [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Snippet title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'snippet body' }] },
    ]);
    const doc = e.editor.state.doc;
    expect(pageTexts(doc)[1]).toContain('Snippet title');
    expect(doc.child(1).firstChild!.attrs.continuation).toBe(true);
    expect(strayFlags(doc)).toEqual([]);
    e.settle();
    expect(strayFlags(e.editor.state.doc)).toEqual([]);
  });
});

describe('undo re-flags a fragment that pagination has moved next to its head (PGR-10)', () => {
  it('deleting a split paragraph\'s head, settle, undo: one paragraph again', () => {
    const e = mount(DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 50)), P(words('b', 100)), P(words('c', 20)))));
    const original = e.editor.state.doc;
    const page0 = pageAt(original, 0)!;
    const head = page0.contentEnd - page0.node.lastChild!.nodeSize;
    e.editor.view.dispatch(e.editor.state.tr.delete(head, page0.contentEnd));
    e.settle();
    // The tail became a paragraph of its own and was pulled back onto page 0.
    expect(pageTexts(e.editor.state.doc)[0]).toContain(words('b', 100).slice(50));
    e.editor.commands.undo();
    e.settle();
    expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
    expect(strayFlags(e.editor.state.doc)).toEqual([]);
  });

  it('Enter at a seam, a repagination outside the history (fonts, CSS), undo: one paragraph again', () => {
    const e = mount(DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 50)), P(words('b', 100)))));
    const original = e.editor.state.doc;
    e.select(pageAt(original, 0)!.contentEnd - 1);
    e.press('Enter');
    e.settle();
    // A font or CSS change: taller pages, everything is re-checked.
    lineOptions.lines = 20;
    repaginate(e.editor.view, 0);
    e.settle();
    expect(e.editor.state.doc.childCount).toBe(1);
    e.editor.commands.undo();
    e.settle();
    expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
    expect(strayFlags(e.editor.state.doc)).toEqual([]);
    lineOptions.lines = 10;
    repaginate(e.editor.view, 0);
    e.settle();
    expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
  });
});

describe('attributes shared along a chain', () => {
  it('a head\'s new attributes reach every fragment of a block split over three pages', () => {
    // "c…" (170 characters) is split 40 / 100 / 30 over pages 0-2.
    const e = mount(DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 40)), P(words('b', 20), { align: 'center' }), P(words('c', 170)))));
    const doc = e.editor.state.doc;
    expect(pageTexts(doc).map((p) => p.length)).toEqual([3, 1, 1]);
    // Join "b…" (centered) with "c…": the whole block is centered. The lines don't change, so
    // pagination moves no boundary that would copy the attributes.
    e.select(posOf(doc, 'c0 '));
    e.press('Backspace');
    e.settle();
    expect(seamProblems(e.editor.state.doc)).toEqual([]);
    e.editor.state.doc.forEach((page, _o, index) => {
      if (index > 0) expect(page.firstChild!.attrs.align).toBe('center');
    });
  });
});
