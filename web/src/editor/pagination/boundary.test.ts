// boundary.ts (plan §4.5, P4.3): pure ProseMirror, no DOM. Each case asserts the exact
// resulting document and how a selection in the moved text maps.
import { history, redo, undo } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { describe, expect, it } from 'vitest';
import {
  autoPageAttrs,
  carriesPageData,
  continuationAttrs,
  endOfFirstBlock,
  insertAutoPageAt,
  isPlaceholderPage,
  moveBoundary,
  normalizeCut,
  pageAt,
  pageIndexAt,
  rejoinContinuations,
} from './boundary';
import {
  AUTO,
  DD,
  DL,
  DOC,
  DT,
  H,
  LI,
  OL,
  P,
  PAGE,
  PC,
  UL,
  describePos,
  flowText,
  li,
  pageTexts,
  posOf,
  schema,
} from './testing';

const OBJECTS = [{ id: 'o1', kind: 'image', classes: ['banner'], style: 'position:absolute;top:0', src: 'https://example.com/a.png' }];

/** Applies `edit` to `doc` with a caret at `caret` (a doc position) and returns doc + mapped caret. */
function run(doc: PMNode, caret: number, edit: (tr: Transaction) => unknown) {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, caret) });
  const tr = state.tr;
  const result = edit(tr);
  tr.doc.check();
  return { doc: tr.doc, caret: tr.selection.head, result, tr };
}

function expectDoc(actual: PMNode, expected: PMNode) {
  expected.check();
  expect(actual.toJSON()).toEqual(expected.toJSON());
}

describe('pageAt / endOfFirstBlock / pageIndexAt', () => {
  const doc = DOC(PAGE({ pid: 'aaaaaaaa' }, P('one'), P('two')), AUTO({ pid: 'bbbbbbbb' }, P('three')));

  it('locates pages by index', () => {
    const first = pageAt(doc, 0)!;
    const second = pageAt(doc, 1)!;
    expect(first).toMatchObject({ index: 0, pos: 0, contentStart: 1, contentEnd: 11 });
    expect(second).toMatchObject({ index: 1, pos: 12, contentStart: 13, contentEnd: 20 });
    expect(pageAt(doc, 2)).toBeNull();
    expect(pageAt(doc, -1)).toBeNull();
    expect(endOfFirstBlock(first)).toBe(6);
    expect(endOfFirstBlock(second)).toBe(20);
    expect([0, 1, 11, 12, 13, 20, 21].map((pos) => pageIndexAt(doc, pos))).toEqual([0, 0, 0, 1, 1, 1, 1]);
  });
});

describe('autoPageAttrs / continuationAttrs / normalizeCut', () => {
  it('copies the section settings only', () => {
    const src = PAGE({
      pid: 'k3f9a1qe',
      kind: 'manual',
      columns: 1,
      markers: ['frontCover'],
      pageNumber: true,
      footer: 'Part 1',
      objects: OBJECTS,
      classes: ['wide-margins'],
      style: 'color: red;',
      id: 'chapter',
      attributes: { 'data-x': '1' },
    }).attrs;
    expect(autoPageAttrs(src)).toEqual({
      columns: 1,
      pageNumber: true,
      footer: 'Part 1',
      classes: ['wide-margins'],
      style: 'color: red;',
      kind: 'auto',
      pid: null,
      id: null,
      attributes: {},
      markers: [],
      objects: [],
      oversized: false,
    });
  });

  it('marks fragments as continuations, drops ids, continues ordered list numbers', () => {
    expect(continuationAttrs(P('x', { id: 'intro', classes: ['lead'], align: 'center' }), 0)).toEqual({
      align: 'center',
      continuation: true,
      classes: ['lead'],
      style: null,
      id: null,
      attributes: {},
    });
    expect(continuationAttrs(OL({ start: 3, id: 'steps' }, li('a'), li('b'), li('c')), 2)).toMatchObject({
      start: 5,
      continuation: true,
      id: null,
    });
    // definitionTerm has no generic attributes: only the declared ones come back.
    expect(continuationAttrs(DT('Term'), 0)).toEqual({ continuation: true });
  });

  it('lifts cuts at the start or end of a node to its boundary', () => {
    const doc = DOC(PAGE(null, P('ab'), UL(null, li('x'), li('y'))));
    // positions: page 0, p 1, "ab" 2-4, /p 4, ul 5, li 6, p 7, "x" 8
    expect(normalizeCut(doc, 2)).toBe(1); // start of "ab" → before the paragraph
    expect(normalizeCut(doc, 3)).toBe(3); // inside the text: unchanged
    expect(normalizeCut(doc, 4)).toBe(5); // end of "ab" → after the paragraph
    expect(normalizeCut(doc, 8)).toBe(5); // start of "x" → before the (first) item → before the list
    expect(normalizeCut(doc, 6)).toBe(5); // before the first item → before the list
  });
});

describe('insertAutoPageAt', () => {
  const section = {
    pid: 'k3f9a1qe',
    kind: 'manual',
    columns: 2,
    pageNumber: true,
    footer: 'Part 1 | The Wandering Inn',
    markers: ['frontCover'],
    objects: OBJECTS,
    classes: ['x'],
  };

  it('pushes a paragraph tail to a new auto page (continuation, section attrs copied)', () => {
    const doc = DOC(PAGE(section, H(1, 'The Wandering Inn'), P('Travelers speak of an inn. The common room smells of cedar.', { id: 'p1' })));
    const cut = posOf(doc, 'The common');
    const caret = posOf(doc, 'mon room'); // inside the moved text
    const r = run(doc, caret, (tr) => insertAutoPageAt(tr, 0, cut));
    expectDoc(
      r.doc,
      DOC(
        PAGE(section, H(1, 'The Wandering Inn'), P('Travelers speak of an inn. ', { id: 'p1' })),
        AUTO({ columns: 2, pageNumber: true, footer: 'Part 1 | The Wandering Inn', classes: ['x'] }, PC('The common room smells of cedar.')),
      ),
    );
    expect(describePos(r.doc, r.caret)).toEqual({ page: 1, before: 'The com', after: 'mon room smells of cedar.', parent: 'paragraph' });
  });

  it('keeps a caret sitting exactly at the cut with the moved text (it follows the line)', () => {
    const doc = DOC(PAGE(null, P('aaa bbb ccc')));
    const cut = posOf(doc, 'ccc');
    const r = run(doc, cut, (tr) => insertAutoPageAt(tr, 0, cut));
    expect(pageTexts(r.doc)).toEqual([['aaa bbb '], ['ccc']]);
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 1, before: '', after: 'ccc' });
  });

  it('moves whole blocks when the cut is between blocks (no continuation)', () => {
    const doc = DOC(PAGE(null, P('one'), P('two'), P('three')));
    const cut = pageAt(doc, 0)!.contentStart + doc.child(0).child(0).nodeSize;
    const r = run(doc, posOf(doc, 'hree'), (tr) => insertAutoPageAt(tr, 0, cut));
    expectDoc(r.doc, DOC(PAGE(null, P('one')), AUTO(null, P('two'), P('three'))));
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 1, before: 't', after: 'hree' });
  });

  it('clears a stale continuation flag on a whole block that starts the new page', () => {
    // User edits left a continuation fragment away from its head (not first on its page).
    const doc = DOC(PAGE(null, P('one'), P('two'), PC('stale')));
    const cut = posOf(doc, 'stale') - 1; // before the paragraph: it moves whole
    const r = run(doc, posOf(doc, 'tale'), (tr) => insertAutoPageAt(tr, 0, cut));
    expectDoc(r.doc, DOC(PAGE(null, P('one'), P('two')), AUTO(null, P('stale'))));
  });

  it('refuses cuts that would leave an empty page', () => {
    const doc = DOC(PAGE(null, P('one'), P('two')));
    const page = pageAt(doc, 0)!;
    expect(() => insertAutoPageAt(new Transform(doc), 0, page.contentStart)).toThrow(RangeError);
    expect(() => insertAutoPageAt(new Transform(doc), 0, page.contentEnd)).toThrow(RangeError);
    // The start of the first paragraph's text is the start of the page once normalized.
    expect(() => insertAutoPageAt(new Transform(doc), 0, page.contentStart + 1)).toThrow(RangeError);
  });
});

describe('moveBoundary', () => {
  it('pushes into an existing auto page, which keeps its pid and objects', () => {
    const doc = DOC(
      PAGE({ pid: 'aaaaaaaa' }, P('A'), P('aaa bbb ccc')),
      AUTO({ pid: 'bbbbbbbb', objects: OBJECTS }, P('D')),
    );
    const r = run(doc, posOf(doc, 'ccc') + 1, (tr) => moveBoundary(tr, 0, posOf(doc, 'ccc')));
    expect(r.result).toBe('split');
    expectDoc(r.doc, DOC(PAGE({ pid: 'aaaaaaaa' }, P('A'), P('aaa bbb ')), AUTO({ pid: 'bbbbbbbb', objects: OBJECTS }, PC('ccc'), P('D'))));
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 1, before: 'c', after: 'cc' });
  });

  it('re-joins a continuation with its head when the boundary moves (push)', () => {
    const doc = DOC(PAGE(null, P('A'), P('one two three ')), AUTO({ pid: 'bbbbbbbb' }, PC('four five'), P('D')));
    const caret = posOf(doc, 'ive'); // in the continuation, which is re-joined and re-split
    const r = run(doc, caret, (tr) => moveBoundary(tr, 0, posOf(doc, 'three')));
    expectDoc(r.doc, DOC(PAGE(null, P('A'), P('one two ')), AUTO({ pid: 'bbbbbbbb' }, PC('three four five'), P('D'))));
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 1, before: 'three four f', after: 'ive' });
  });

  it('pulls back: joins the continuation with its head, removing the emptied auto page', () => {
    const doc = DOC(PAGE(null, P('A'), P('one two ')), AUTO(null, PC('three four')));
    const caret = posOf(doc, 'four');
    const r = run(doc, caret, (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(doc, 1)!)));
    expect(r.result).toBe('merged');
    expectDoc(r.doc, DOC(PAGE(null, P('A'), P('one two three four'))));
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 0, before: 'one two three ', after: 'four' });
  });

  it('pulls one block back, then re-splits later at a new line (join + split)', () => {
    const doc = DOC(PAGE(null, P('A'), P('one two ')), AUTO({ pid: 'bbbbbbbb' }, PC('three four'), P('D'), P('E')));
    const caret = posOf(doc, 'our');
    const pulled = run(doc, caret, (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(doc, 1)!)));
    expect(pulled.result).toBe('split');
    expectDoc(pulled.doc, DOC(PAGE(null, P('A'), P('one two three four')), AUTO({ pid: 'bbbbbbbb' }, P('D'), P('E'))));
    expect(describePos(pulled.doc, pulled.caret)).toMatchObject({ page: 0, before: 'one two three f' });

    // The pulled text didn't fit after all: the next pass cuts it again, before "four".
    const resplit = run(pulled.doc, pulled.caret, (tr) => moveBoundary(tr, 0, posOf(pulled.doc, 'four')));
    expectDoc(resplit.doc, DOC(PAGE(null, P('A'), P('one two three ')), AUTO({ pid: 'bbbbbbbb' }, PC('four'), P('D'), P('E'))));
    expect(describePos(resplit.doc, resplit.caret)).toMatchObject({ page: 1, before: 'f', after: 'our' });
  });

  it('pulls several whole blocks at once', () => {
    const doc = DOC(PAGE(null, P('A')), AUTO({ pid: 'bbbbbbbb' }, P('B'), P('C'), P('D')));
    const b = pageAt(doc, 1)!;
    const afterC = b.contentStart + b.node.child(0).nodeSize + b.node.child(1).nodeSize;
    const r = run(doc, posOf(doc, 'C'), (tr) => moveBoundary(tr, 0, afterC));
    expectDoc(r.doc, DOC(PAGE(null, P('A'), P('B'), P('C')), AUTO({ pid: 'bbbbbbbb' }, P('D'))));
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 0, after: 'C' });
  });

  it('continues ordered list numbering, and re-joins the list when pulled back', () => {
    const doc = DOC(PAGE(null, OL({ start: 3, id: 'steps' }, li('a'), li('b'), li('c'), li('d'))), AUTO(null, P('E')));
    const list = pageAt(doc, 0)!.contentStart;
    const beforeC = list + 1 + 2 * li('a').nodeSize;
    const r = run(doc, posOf(doc, 'c'), (tr) => moveBoundary(tr, 0, beforeC));
    const pushed = DOC(
      PAGE(null, OL({ start: 3, id: 'steps' }, li('a'), li('b'))),
      AUTO(null, OL({ start: 5, continuation: true }, li('c'), li('d')), P('E')),
    );
    expectDoc(r.doc, pushed);
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 1, after: 'c' });

    const back = run(r.doc, r.caret, (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(r.doc, 1)!)));
    expectDoc(back.doc, DOC(PAGE(null, OL({ start: 3, id: 'steps' }, li('a'), li('b'), li('c'), li('d'))), AUTO(null, P('E'))));
    expect(describePos(back.doc, back.caret)).toMatchObject({ page: 0, after: 'c' });
  });

  it('splits inside an ordered list item: the continued item keeps its number', () => {
    const doc = DOC(PAGE(null, OL({ start: 1 }, li('first'), li('second part'), li('third'))));
    const r = run(doc, posOf(doc, 'art'), (tr) => insertAutoPageAt(tr, 0, posOf(doc, 'part')));
    expectDoc(
      r.doc,
      DOC(
        PAGE(null, OL({ start: 1 }, li('first'), li('second '))),
        AUTO(null, OL({ start: 2, continuation: true }, LI({ continuation: true }, PC('part')), li('third'))),
      ),
    );
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 1, before: 'p', after: 'art' });
  });

  it('splits a nested list and re-joins every level when the boundary moves back', () => {
    const nested = () => UL(null, LI(null, P('a'), UL(null, li('x'), li('y'), li('z'))), li('b'));
    const doc = DOC(PAGE(null, nested()), AUTO(null, P('E')));
    const r = run(doc, posOf(doc, 'y'), (tr) => moveBoundary(tr, 0, posOf(doc, 'y') - 2)); // before the item "y"
    expectDoc(
      r.doc,
      DOC(
        PAGE(null, UL(null, LI(null, P('a'), UL(null, li('x'))))),
        // listItem content is `paragraph block*`: the continued item starts with an empty
        // continuation paragraph (a filler, removed again when the fragments re-join).
        AUTO(null, UL({ continuation: true }, LI({ continuation: true }, PC(''), UL({ continuation: true }, li('y'), li('z'))), li('b')), P('E')),
      ),
    );
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 1, after: 'y' });

    const back = run(r.doc, r.caret, (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(r.doc, 1)!)));
    expectDoc(back.doc, DOC(PAGE(null, nested()), AUTO(null, P('E'))));
    expect(describePos(back.doc, back.caret)).toMatchObject({ page: 0, after: 'y' });
  });

  it('splits a definition list between groups (dt starts the continuation)', () => {
    const doc = DOC(PAGE(null, DL({ multiline: true }, DT('Armor Class'), DD('15'), DT('Hit Points'), DD('52'))), AUTO(null, P('E')));
    const r = run(doc, posOf(doc, '52'), (tr) => moveBoundary(tr, 0, posOf(doc, 'Hit') - 1));
    expectDoc(
      r.doc,
      DOC(
        PAGE(null, DL({ multiline: true }, DT('Armor Class'), DD('15'))),
        AUTO(null, DL({ multiline: true, continuation: true }, DT('Hit Points'), DD('52')), P('E')),
      ),
    );
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 1, parent: 'definitionDesc', after: '52' });
    const back = run(r.doc, r.caret, (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(r.doc, 1)!)));
    expectDoc(back.doc, doc);
  });

  it('keeps ids and classes on the first fragment only (classes are copied)', () => {
    const doc = DOC(PAGE(null, P('head tail', { id: 'intro', classes: ['lead'] })), AUTO(null, P('E')));
    const r = run(doc, 1, (tr) => moveBoundary(tr, 0, posOf(doc, 'tail')));
    expectDoc(
      r.doc,
      DOC(PAGE(null, P('head ', { id: 'intro', classes: ['lead'] })), AUTO(null, PC('tail', { classes: ['lead'] }), P('E'))),
    );
  });

  it('keeps a page that carries objects alive with one empty paragraph', () => {
    const doc = DOC(PAGE(null, P('A')), AUTO({ pid: 'objpage1', objects: OBJECTS }, P('B')), AUTO({ pid: 'cccccccc' }, P('C')));
    const r = run(doc, posOf(doc, 'B'), (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(doc, 1)!)));
    expect(r.result).toBe('kept');
    const kept = DOC(PAGE(null, P('A'), P('B')), AUTO({ pid: 'objpage1', objects: OBJECTS }, P('')), AUTO({ pid: 'cccccccc' }, P('C')));
    expectDoc(r.doc, kept);
    expect(isPlaceholderPage(r.doc.child(1))).toBe(true);
    expect(describePos(r.doc, r.caret)).toMatchObject({ page: 0, after: 'B' });

    // Nothing to pull from a placeholder: no steps, same document.
    const again = run(r.doc, r.caret, (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(r.doc, 1)!)));
    expect(again.result).toBe('kept');
    expect(again.tr.steps).toHaveLength(0);

    // Content pulled into the placeholder replaces its empty paragraph …
    const filled = run(r.doc, posOf(r.doc, 'C'), (tr) => moveBoundary(tr, 1, endOfFirstBlock(pageAt(r.doc, 2)!)));
    expectDoc(filled.doc, DOC(PAGE(null, P('A'), P('B')), AUTO({ pid: 'objpage1', objects: OBJECTS }, P('C'))));
    expect(describePos(filled.doc, filled.caret)).toMatchObject({ page: 1, after: 'C' });

    // … and so does content pushed into it.
    const pushed = run(r.doc, posOf(r.doc, 'B'), (tr) => moveBoundary(tr, 0, posOf(r.doc, 'B') - 1));
    expectDoc(pushed.doc, DOC(PAGE(null, P('A')), AUTO({ pid: 'objpage1', objects: OBJECTS }, P('B')), AUTO({ pid: 'cccccccc' }, P('C'))));
  });

  it('keeps a page that carries markers (a cover, page numbering) the same way (PGR-5)', () => {
    const doc = DOC(PAGE(null, P('A')), AUTO({ pid: 'coverpg1', markers: ['frontCover'] }, P('B')), AUTO({ pid: 'cccccccc' }, P('C')));
    const r = run(doc, posOf(doc, 'B'), (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(doc, 1)!)));
    expect(r.result).toBe('kept');
    expectDoc(r.doc, DOC(PAGE(null, P('A'), P('B')), AUTO({ pid: 'coverpg1', markers: ['frontCover'] }, P('')), AUTO({ pid: 'cccccccc' }, P('C'))));
    expect(isPlaceholderPage(r.doc.child(1))).toBe(true);
    expect(carriesPageData(r.doc.child(1))).toBe(true);
    // Without markers or objects the page is merged away.
    const plain = DOC(PAGE(null, P('A')), AUTO({ pid: 'bbbbbbbb' }, P('B')));
    expect(run(plain, posOf(plain, 'B'), (tr) => moveBoundary(tr, 0, endOfFirstBlock(pageAt(plain, 1)!))).result).toBe('merged');
  });

  it('rejects cuts outside the two pages', () => {
    const doc = DOC(PAGE(null, P('A'), P('B')), AUTO(null, P('C')));
    expect(() => moveBoundary(new Transform(doc), 0, 1)).toThrow(RangeError); // page 0's start
    expect(() => moveBoundary(new Transform(doc), 1, 3)).toThrow(RangeError); // no page 2
  });
});

describe('rejoinContinuations', () => {
  it('re-joins list → item → paragraph and stops at the first non-continuation', () => {
    const doc = DOC(
      PAGE(
        null,
        UL(null, LI(null, P('ab'))),
        UL({ continuation: true }, LI({ continuation: true }, PC('cd')), li('e')),
      ),
    );
    const seam = pageAt(doc, 0)!.contentStart + doc.child(0).child(0).nodeSize;
    const tr = new Transform(doc);
    expect(rejoinContinuations(tr, seam)).toBe(3);
    expectDoc(tr.doc, DOC(PAGE(null, UL(null, LI(null, P('abcd')), li('e')))));
  });

  it('never joins different node types or non-continuations', () => {
    const doc = DOC(PAGE(null, H(2, 'Title'), PC('text'), P('x'), P('y')));
    const tr = new Transform(doc);
    const afterHeading = 1 + doc.child(0).child(0).nodeSize;
    expect(rejoinContinuations(tr, afterHeading)).toBe(0);
    const afterText = afterHeading + doc.child(0).child(1).nodeSize;
    expect(rejoinContinuations(tr, afterText)).toBe(0);
    expect(tr.steps).toHaveLength(0);
  });
});

describe('undo history through pagination (why moves are join + split)', () => {
  const base = () =>
    DOC(
      PAGE({ pid: 'aaaaaaaa' }, P('Intro.'), P('The common room smells of cedar and pipe smoke. ')),
      AUTO({ pid: 'bbbbbbbb' }, PC('Rain never falls outside.'), P('Next paragraph.')),
    );

  /** A user edit, then pagination transactions that move the edited text to the next page and back. */
  function scenario(move: (state: EditorState, cutText: string) => Transaction) {
    const doc = base();
    let state = EditorState.create({ doc, plugins: [history()] });
    const at = posOf(doc, ' smoke.') + ' smoke'.length;
    // The user types at the end of the page's last line (history event 1).
    state = state.apply(state.tr.insertText(' and old wine', at));
    const edited = state.doc;
    // Pagination: the line overflows, so its tail moves to the next page; the next pass pulls it
    // back and cuts at a different word (both outside the history).
    state = state.apply(move(state, 'and old wine'));
    state = state.apply(move(state, 'pipe smoke'));
    return { state, edited, original: doc };
  }

  const joinSplit = (state: EditorState, cutText: string) => {
    const tr = state.tr.setMeta('addToHistory', false);
    moveBoundary(tr, 0, posOf(state.doc, cutText));
    return tr;
  };

  it('undo restores the text the user typed; redo brings it back; layout is left to pagination', () => {
    const { state, edited, original } = scenario(joinSplit);
    expect(pageTexts(state.doc)).toEqual([
      ['Intro.', 'The common room smells of cedar and '],
      ['pipe smoke and old wine. Rain never falls outside.', 'Next paragraph.'],
    ]);

    let after = state;
    expect(undo(after, (tr) => (after = after.apply(tr)))).toBe(true);
    // The typed words are gone; everything else is where pagination left it.
    expect(after.doc.textContent).toBe(original.textContent);
    expect(flowText(after.doc)).not.toContain('old wine');
    expect(redo(after, (tr) => (after = after.apply(tr)))).toBe(true);
    expect(after.doc.textContent).toBe(edited.textContent);
  });

  it('control: a delete + insert "move" makes history drop the user\'s edit', () => {
    const deleteInsert = (state: EditorState, cutText: string) => {
      // Same result as moveBoundary for the text, but built from delete + insert.
      const tr = state.tr.setMeta('addToHistory', false);
      const from = posOf(state.doc, cutText);
      const $from = state.doc.resolve(from);
      const tail = state.doc.textBetween(from, $from.end());
      tr.delete(from, $from.end());
      const nextPage = pageAt(tr.doc, 1)!;
      tr.insert(nextPage.contentStart, schema.nodes.paragraph!.create({ continuation: true }, schema.text(tail)));
      return tr;
    };
    const { state } = scenario(deleteInsert);
    expect(state.doc.textContent).toContain('old wine');
    let after = state;
    undo(after, (tr) => (after = after.apply(tr)));
    expect(after.doc.textContent).toContain('old wine'); // the user's undo step was lost
  });
});
