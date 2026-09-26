// Section commands (P4.6) on the line-model layout: Mod-Enter, Backspace at a section start,
// section settings and their sync to auto pages, pid assignment, undo.
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { pageAt, sectionEndIndex, sectionStartIndex } from '../pagination';
import { mountPaginated, type MountedEditor } from '../pagination/testEditor';
import { DOC, H, LI, OL, P, PAGE, canonical, li, pageTexts, posOf, seamProblems, type LineLayoutOptions } from '../pagination/testing';

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

function mount(doc: PMNode, lines?: LineLayoutOptions): MountedEditor {
  m = mountPaginated(doc, { lines });
  m.settle();
  return m;
}

const kinds = (doc: PMNode) => {
  const out: string[] = [];
  doc.forEach((page) => out.push(String(page.attrs.kind)));
  return out;
};

/** 1 column of 10 lines, 10 characters a line. */
const ONE_COLUMN = { columns: 1 };

describe('insertPageBreak (Mod-Enter)', () => {
  it('splits the page at the cursor: the new page is manual, starts a section with the same settings and gets a pid', () => {
    const e = mount(DOC(PAGE({ pid: 'aaaaaaaa', columns: 1, footer: 'F', pageNumber: true }, P('first paragraph'), P('second half here'), P('third'))), ONE_COLUMN);
    const before = e.editor.state.doc;
    e.select(posOf(before, 'half'));
    e.press('Mod-Enter');
    const doc = e.editor.state.doc;
    expect(pageTexts(doc)).toEqual([['first paragraph', 'second '], ['half here', 'third']]);
    expect(doc.child(1).attrs).toMatchObject({ kind: 'manual', columns: 1, footer: 'F', pageNumber: true, markers: [], objects: [] });
    expect(doc.child(1).attrs.pid).toMatch(/^[0-9a-z]{8}$/); // PageIds assigned one
    expect(doc.child(1).attrs.pid).not.toBe('aaaaaaaa');
    expect(doc.child(1).firstChild!.attrs.continuation).toBe(false);
    // The cursor is at the start of the new section.
    const $head = e.editor.state.selection.$head;
    expect($head.index(0)).toBe(1);
    expect($head.parentOffset).toBe(0);
    // One undo step gives the page back.
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('content never flows back across the new section start', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P(words('a', 30)), P(words('b', 30)), P(words('c', 30)))), ONE_COLUMN);
    e.select(posOf(e.editor.state.doc, 'b0'));
    e.press('Mod-Enter');
    e.settle();
    // Page 0 has room for "b…", but the next page starts a section.
    expect(pageTexts(e.editor.state.doc)).toEqual([[words('a', 30)], [words('b', 30), words('c', 30)]]);
    expect(kinds(e.editor.state.doc)).toEqual(['manual', 'manual']);
  });

  it('at a page seam, the auto page becomes the section start and the split paragraph becomes two', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P(words('a', 50)), P(words('b', 100)))), ONE_COLUMN);
    expect(kinds(e.editor.state.doc)).toEqual(['manual', 'auto']);
    const tail = pageAt(e.editor.state.doc, 1)!;
    expect(tail.node.firstChild!.attrs.continuation).toBe(true);
    const before = e.editor.state.doc;
    // The cursor at the end of the head fragment (the same place as the start of the tail).
    e.select(pageAt(before, 0)!.contentEnd - 1);
    e.press('Mod-Enter');
    const doc = e.editor.state.doc;
    expect(kinds(doc)).toEqual(['manual', 'manual']);
    expect(doc.child(1).firstChild!.attrs.continuation).toBe(false);
    expect(e.editor.state.selection.$head.index(0)).toBe(1);
    e.settle();
    expect(canonical(e.editor.state.doc).childCount).toBe(2);
    expect(pageTexts(canonical(e.editor.state.doc))[0]).toHaveLength(2);
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('at the end of a section, adds a blank page (a new section) after it', () => {
    const e = mount(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P('only')), PAGE({ columns: 2, pid: 'bbbbbbbb' }, P('next'))), ONE_COLUMN);
    e.select(posOf(e.editor.state.doc, 'only') + 4);
    e.press('Mod-Enter');
    const doc = e.editor.state.doc;
    expect(pageTexts(doc)).toEqual([['only'], [''], ['next']]);
    expect(doc.child(1).attrs).toMatchObject({ kind: 'manual', columns: 1 });
    expect(e.editor.state.selection.$head.index(0)).toBe(1);
  });

  it('at the start of a section, adds a blank page before the content (the page keeps its markers)', () => {
    const e = mount(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa', markers: ['frontCover'] }, P('title'), P('text'))), ONE_COLUMN);
    e.select(posOf(e.editor.state.doc, 'title'));
    e.press('Mod-Enter');
    const doc = e.editor.state.doc;
    expect(pageTexts(doc)).toEqual([[''], ['title', 'text']]);
    expect(doc.child(0).attrs).toMatchObject({ pid: 'aaaaaaaa', markers: ['frontCover'] });
    expect(doc.child(1).attrs).toMatchObject({ kind: 'manual', markers: [] });
    expect(e.editor.state.selection.$head.index(0)).toBe(1);
  });

  it('inside an ordered list, splits the list: the second part is its own list and continues the numbering', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, OL({ start: 1 }, li('one'), li('two'), li('three')))), ONE_COLUMN);
    e.select(posOf(e.editor.state.doc, 'three'));
    e.press('Mod-Enter');
    const doc = e.editor.state.doc;
    expect(doc.childCount).toBe(2);
    const second = doc.child(1).firstChild!;
    expect(second.type.name).toBe('orderedList');
    expect(second.attrs).toMatchObject({ start: 3, continuation: false });
    expect(second.firstChild!.attrs.continuation).toBe(false);
    expect(pageTexts(doc)).toEqual([['one', 'two'], ['three']]);
  });

  it('replaces a selection', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P('keep this, drop that, keep the rest'))), ONE_COLUMN);
    const doc = e.editor.state.doc;
    e.select(posOf(doc, 'drop'), posOf(doc, 'keep the'));
    e.press('Mod-Enter');
    expect(pageTexts(e.editor.state.doc)).toEqual([['keep this, '], ['keep the rest']]);
  });

  it('leaves code blocks to TipTap (Mod-Enter exits them there)', () => {
    const doc = DOC(PAGE({ columns: 1 }, P('before')));
    const e = mount(doc, ONE_COLUMN);
    e.editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'page', attrs: { columns: 1 }, content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'code' }] }] }],
    });
    e.select(3);
    e.press('Mod-Enter');
    expect(e.editor.state.doc.childCount).toBe(1);
  });
});

describe('Backspace at the start of a manual page', () => {
  it('removes the section break: the page joins the section before it, content pulls back; undo restores the section and its settings', () => {
    const e = mount(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 30))), PAGE({ columns: 2, pid: 'bbbbbbbb', footer: 'B' }, P(words('b', 30)))), ONE_COLUMN);
    const before = e.editor.state.doc;
    e.select(posOf(before, 'b0'));
    e.press('Backspace');
    const doc = e.editor.state.doc;
    expect(doc.child(1).attrs).toMatchObject({ kind: 'auto', columns: 1, footer: null, pid: 'bbbbbbbb' });
    e.settle();
    expect(pageTexts(e.editor.state.doc)).toEqual([[words('a', 30), words('b', 30)]]);
    // The cursor followed the text.
    expect(e.editor.state.selection.$head.parent.textContent).toBe(words('b', 30));
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
    expect(e.editor.state.doc.child(1).attrs).toMatchObject({ kind: 'manual', columns: 2, footer: 'B' });
  });

  it('does nothing on the first page', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P('first'))), ONE_COLUMN);
    e.select(posOf(e.editor.state.doc, 'first'));
    const before = e.editor.state.doc;
    e.press('Backspace');
    expect(e.editor.state.doc.eq(before)).toBe(true);
  });
});

describe('setSectionAttrs and the section sync', () => {
  const sections = () =>
    DOC(
      PAGE({ columns: 2, pid: 'sectionA' }, H(1, 'A'), ...Array.from({ length: 7 }, (_, i) => P(words(`a${i}x`, 45)))),
      PAGE({ columns: 2, pid: 'sectionB' }, H(1, 'B'), ...Array.from({ length: 7 }, (_, i) => P(words(`b${i}x`, 45)))),
      PAGE({ columns: 2, pid: 'sectionC' }, H(1, 'C'), ...Array.from({ length: 7 }, (_, i) => P(words(`c${i}x`, 45)))),
    );

  it('changing a section to 1 column reflows only that section', () => {
    const e = mount(sections());
    const before = e.editor.state.doc;
    expect(before.childCount).toBe(6);
    e.steps();
    // Cursor on section B's auto page: the setting goes to B's first page.
    e.select(pageAt(before, 3)!.contentStart + 1);
    expect(e.editor.commands.setSectionAttrs({ columns: 1 })).toBe(true);
    expect(e.editor.state.doc.child(2).attrs.columns).toBe(1);
    expect(e.editor.state.doc.child(3).attrs.columns).toBe(1);
    e.settle();
    const doc = e.editor.state.doc;
    expect(doc.childCount).toBe(8);
    // Sections A and C: the same page nodes.
    expect(doc.child(0)).toBe(e.editor.state.doc.child(0));
    for (const [i, j] of [[0, 0], [1, 1], [6, 4], [7, 5]]) expect(doc.child(i!).eq(before.child(j!))).toBe(true);
    const checked = new Set(e.steps().map((meta) => meta.page));
    expect(Math.min(...[...checked].filter((p): p is number => p !== undefined))).toBe(2);
    expect(Math.max(...[...checked].filter((p): p is number => p !== undefined))).toBeLessThanOrEqual(5);
    expect(sectionStartIndex(doc, 5)).toBe(2);
    expect(sectionEndIndex(doc, 2)).toBe(5);
    expect(seamProblems(doc)).toEqual([]);
  });

  it('writes to the first page of the section of a given page, validates values, and syncs new auto pages', () => {
    const e = mount(sections());
    expect(e.editor.commands.setSectionAttrs({ footer: 'Part C', classes: ['wide-margins'] }, 5)).toBe(true);
    const doc = e.editor.state.doc;
    expect(doc.child(4).attrs).toMatchObject({ footer: 'Part C', classes: ['wide-margins'] });
    expect(doc.child(5).attrs).toMatchObject({ footer: 'Part C', classes: ['wide-margins'] });
    expect(doc.child(2).attrs.footer).toBeNull();
    // Invalid values and pages fail without a change.
    expect(e.editor.commands.setSectionAttrs({ columns: 3 as 1 })).toBe(false);
    expect(e.editor.commands.setSectionAttrs({ footer: 7 as unknown as string })).toBe(false);
    expect(e.editor.commands.setSectionAttrs({ columns: 1 }, 99)).toBe(false);
    expect(e.editor.state.doc.eq(doc)).toBe(true);
  });

  it('an auto page edited directly takes its section\'s settings back (the first page wins)', () => {
    const e = mount(sections());
    const auto = pageAt(e.editor.state.doc, 1)!;
    e.editor.view.dispatch(e.editor.state.tr.setNodeAttribute(auto.pos, 'footer', 'rogue'));
    expect(e.editor.state.doc.child(1).attrs.footer).toBeNull();
  });

  it('a list item split is kept intact by setSectionAttrs (only page attributes change)', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P('intro'), OL({ start: 1 }, LI(null, P('x'))))), ONE_COLUMN);
    const before = canonical(e.editor.state.doc);
    e.editor.commands.setSectionAttrs({ pageNumber: true });
    expect(canonical(e.editor.state.doc).child(0).attrs.pageNumber).toBe(true);
    expect(canonical(e.editor.state.doc).child(0).content.eq(before.child(0).content)).toBe(true);
  });
});
