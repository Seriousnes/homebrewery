// Seam editing (P4.7, plan §4.8) on the line-model layout: keys pressed through the editor's
// keymaps (real keydown events). The browser behaviour (caret stops, both engines) is covered
// by web/e2e/sections/seams.spec.ts.
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { pageAt } from '../pagination';
import { mountPaginated, type MountedEditor } from '../pagination/testEditor';
import { AUTO, DOC, LI, OL, P, PAGE, PC, canonical, li, pageTexts, posOf, schema } from '../pagination/testing';
import { firstGraphemeLength, lastGraphemeLength, wordLengthAfter, wordLengthBefore } from './continuation';

function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

/** Ids of the objects on a page. */
const objectIds = (page: PMNode): string[] => (page.attrs.objects as { id: string }[]).map((o) => o.id);

let m: MountedEditor | undefined;
afterEach(() => {
  m?.destroy();
  m = undefined;
});

/** One column of 10 lines of 10 characters: "a…" (5 lines), then "b…" split 50 / 50. */
function splitParagraph(): MountedEditor {
  m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), P(words('b', 100)))), { lines: { columns: 1 } });
  m.settle();
  const doc = m.editor.state.doc;
  expect(pageTexts(doc)).toEqual([[words('a', 50), words('b', 100).slice(0, 50)], [words('b', 100).slice(50)]]);
  expect(doc.child(1).firstChild!.attrs.continuation).toBe(true);
  return m;
}

const B = words('b', 100);
/** Start of the tail fragment's text (page 1). */
const tailStart = (e: MountedEditor) => pageAt(e.editor.state.doc, 1)!.contentStart + 1;
/** End of the head fragment's text (page 0). */
const headEnd = (e: MountedEditor) => pageAt(e.editor.state.doc, 0)!.contentEnd - 1;
/** The paragraph "b…" as the author sees it (fragments joined). */
const bText = (e: MountedEditor) => canonical(e.editor.state.doc).child(0).child(1).textContent;
const head = (e: MountedEditor) => e.editor.state.selection.head;

describe('Backspace and Delete at a seam', () => {
  it('Backspace at the start of a continuation deletes the last character before the seam; one undo step', () => {
    const e = splitParagraph();
    const before = e.editor.state.doc;
    e.select(tailStart(e));
    e.press('Backspace');
    expect(bText(e)).toBe(B.slice(0, 49) + B.slice(50));
    // The cursor stays at the seam (the start of the continuation).
    expect(e.editor.state.selection.$head.parentOffset).toBe(0);
    expect(e.editor.state.selection.$head.index(0)).toBe(1);
    e.settle();
    expect(bText(e)).toBe(B.slice(0, 49) + B.slice(50));
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('repeated Backspace keeps deleting backwards across the seam, like in one paragraph', () => {
    const e = splitParagraph();
    e.select(tailStart(e));
    for (let k = 0; k < 3; k++) {
      e.press('Backspace');
      e.settle();
    }
    expect(bText(e)).toBe(B.slice(0, 47) + B.slice(50));
  });

  it('Delete at the end of the fragment before a continuation deletes the first character after the seam', () => {
    const e = splitParagraph();
    const before = e.editor.state.doc;
    e.select(headEnd(e));
    e.press('Delete');
    expect(bText(e)).toBe(B.slice(0, 50) + B.slice(51));
    expect(head(e)).toBe(headEnd(e)); // the cursor stays
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('a continuation emptied by Delete goes when its page has more blocks', () => {
    m = mountPaginated(DOC(PAGE({ columns: 1 }, P('head ')), AUTO({ columns: 1 }, PC('x'), P('next'))), { lines: { columns: 1, lines: 1 } });
    m.select(posOf(m.editor.state.doc, 'head ') + 5);
    m.press('Delete');
    expect(pageTexts(m.editor.state.doc)).toEqual([['head '], ['next']]);
    expect(m.editor.state.doc.child(1).firstChild!.attrs.continuation).toBe(false);
  });

  it('deletes a whole grapheme (emoji, combining marks)', () => {
    expect(lastGraphemeLength('ab😀')).toBe(2);
    expect(firstGraphemeLength('😀b')).toBe(2);
    expect(lastGraphemeLength('é')).toBe(2);
    m = mountPaginated(DOC(PAGE({ columns: 1 }, P('flag 😀')), AUTO({ columns: 1 }, PC('tail'))), { lines: { columns: 1, lines: 1, chars: 100 } });
    m.select(pageAt(m.editor.state.doc, 1)!.contentStart + 1);
    m.press('Backspace');
    expect(m.editor.state.doc.child(0).textContent).toBe('flag ');
  });
});

describe('ArrowLeft / ArrowRight skip the seam (one press, one character)', () => {
  it('ArrowRight at the end of a fragment lands one character into the continuation', () => {
    const e = splitParagraph();
    e.select(headEnd(e));
    e.press('ArrowRight');
    expect(head(e)).toBe(tailStart(e) + 1);
  });

  it('ArrowLeft at the start of a continuation lands one character before the seam', () => {
    const e = splitParagraph();
    e.select(tailStart(e));
    e.press('ArrowLeft');
    expect(head(e)).toBe(headEnd(e) - 1);
  });

  it('Shift extends the selection across the seam', () => {
    const e = splitParagraph();
    e.select(headEnd(e) - 2, headEnd(e));
    e.press('Shift-ArrowRight');
    expect(e.editor.state.selection.anchor).toBe(headEnd(e) - 2);
    expect(head(e)).toBe(tailStart(e) + 1);
    e.press('Shift-ArrowLeft'); // native (jsdom: nothing); not at a seam
    e.select(tailStart(e) + 1, tailStart(e));
    e.press('Shift-ArrowLeft');
    expect(head(e)).toBe(headEnd(e) - 1);
  });

  it('leaves other positions and modified keys to the browser', () => {
    const e = splitParagraph();
    e.select(headEnd(e) - 3);
    e.press('ArrowRight');
    expect(head(e)).toBe(headEnd(e) - 3); // jsdom moves nothing natively
    e.select(headEnd(e));
    e.press('Alt-ArrowRight');
    expect(head(e)).toBe(headEnd(e));
  });
});

describe('Enter at a seam', () => {
  it('at the end of the fragment: the text after the seam becomes its own paragraph, no empty paragraph; one undo step', () => {
    const e = splitParagraph();
    const before = e.editor.state.doc;
    e.select(headEnd(e));
    e.press('Enter');
    const doc = e.editor.state.doc;
    expect(doc.child(1).firstChild!.attrs.continuation).toBe(false);
    expect(pageTexts(doc)).toEqual(pageTexts(before)); // no empty paragraph anywhere
    expect(head(e)).toBe(tailStart(e)); // the cursor at the start of the new paragraph
    e.settle();
    const paragraphs = canonical(e.editor.state.doc).child(0);
    expect(paragraphs.childCount).toBe(3);
    expect(paragraphs.child(1).textContent).toBe(B.slice(0, 50));
    expect(paragraphs.child(2).textContent).toBe(B.slice(50));
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('at the start of the continuation: the same split, the cursor stays', () => {
    const e = splitParagraph();
    e.select(tailStart(e));
    e.press('Enter');
    expect(e.editor.state.doc.child(1).firstChild!.attrs.continuation).toBe(false);
    expect(head(e)).toBe(tailStart(e));
    expect(e.editor.state.doc.child(1).childCount).toBe(1);
  });

  it('in a list item split across pages: the item after the seam becomes a new item of the same list', () => {
    m = mountPaginated(
      DOC(
        PAGE({ columns: 1 }, OL({ start: 1 }, li('one'), LI(null, P('two head ')))),
        AUTO({ columns: 1 }, OL({ start: 2, continuation: true }, LI({ continuation: true }, P('two tail', { continuation: true })))),
      ),
      { lines: { columns: 1, lines: 2 } },
    );
    m.select(posOf(m.editor.state.doc, 'two tail'));
    m.press('Enter');
    const list = m.editor.state.doc.child(1).firstChild!;
    expect(list.attrs.continuation).toBe(true); // the list continues
    expect(list.firstChild!.attrs.continuation).toBe(false); // a new item
    expect(list.firstChild!.firstChild!.attrs.continuation).toBe(false);
  });

  it('elsewhere Enter splits as usual', () => {
    const e = splitParagraph();
    e.select(tailStart(e) + 4);
    e.press('Enter');
    expect(e.editor.state.doc.child(1).childCount).toBe(2);
    expect(e.editor.state.doc.child(1).firstChild!.attrs.continuation).toBe(true); // the head part stays a continuation
    // The new paragraph is not (PGR-6): no hb-continued in the middle of the page.
    expect(e.editor.state.doc.child(1).child(1).attrs.continuation).toBe(false);
    e.settle();
    expect(e.editor.state.doc.child(1).child(1).attrs.continuation).toBe(false);
  });
});

describe('word delete at a seam (PGR-7)', () => {
  it('Ctrl+Backspace at the start of a continuation deletes the word before the seam; one undo step', () => {
    const e = splitParagraph();
    const before = e.editor.state.doc;
    e.select(tailStart(e));
    e.press('Mod-Backspace');
    // "…b13 b14 " + "b15 …": the word before the seam and its space go, as in one paragraph.
    expect(bText(e)).toBe(B.slice(0, 46) + B.slice(50));
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('Ctrl+Delete at the end of a fragment deletes the word after the seam (to the next word)', () => {
    const e = splitParagraph();
    e.select(headEnd(e));
    e.press('Mod-Delete');
    expect(bText(e)).toBe(B.slice(0, 50) + B.slice(54));
  });

  it('Alt+Backspace / Alt+Delete (macOS word delete) too; elsewhere the keys stay native', () => {
    const e = splitParagraph();
    e.select(tailStart(e));
    e.press('Alt-Backspace');
    expect(bText(e)).toBe(B.slice(0, 46) + B.slice(50));
    const doc = e.editor.state.doc;
    e.select(tailStart(e) + 2);
    e.press('Mod-Backspace'); // not at a seam: TipTap / the browser (jsdom: nothing)
    expect(e.editor.state.doc.eq(doc)).toBe(true);
  });

  it('word lengths: spaces and punctuation, then one word', () => {
    expect(wordLengthBefore('one two ')).toBe(4);
    expect(wordLengthBefore('one two')).toBe(3);
    expect(wordLengthBefore('')).toBe(0);
    expect(wordLengthAfter('two three', false)).toBe(4);
    expect(wordLengthAfter(' two three', false)).toBe(1);
    expect(wordLengthAfter(' two three', true)).toBe(4);
  });
});

describe('typing at the start of a continuation (PGR-9, PGR-13)', () => {
  const type = (e: MountedEditor, text: string) => {
    for (const ch of text) {
      const { from, to } = e.editor.state.selection;
      const view = e.editor.view;
      const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };

  for (const input of ['- ', '1. ', '# ', '> ', '* ']) {
    it(`"${input}" is text there, not a list, heading or quote (the middle of the paragraph)`, () => {
      const e = splitParagraph();
      e.select(tailStart(e));
      type(e, input);
      const para = canonical(e.editor.state.doc).child(0);
      expect(para.childCount).toBe(2);
      expect(para.child(1).type.name).toBe('paragraph');
      expect(para.child(1).textContent).toBe(B.slice(0, 50) + input + B.slice(50));
    });
  }

  it('control: the same input at the start of a paragraph of its own still converts it', () => {
    m = mountPaginated(DOC(PAGE({ columns: 1 }, P('first'), P('second'))), { lines: { columns: 1 } });
    m.select(posOf(m.editor.state.doc, 'second'));
    type(m, '# ');
    expect(m.editor.state.doc.child(0).child(1).type.name).toBe('heading');
  });

  it('text typed after Backspace at the seam keeps the marks of the text before it', () => {
    const bold = schema.marks.bold!.create();
    const head = schema.nodes.paragraph!.create(null, [schema.text('plain '), schema.text('BOLDx', [bold])]);
    m = mountPaginated(DOC(PAGE({ columns: 1 }, head), AUTO({ columns: 1 }, PC(' tail'))), { lines: { columns: 1, lines: 1, chars: 100 } });
    m.select(pageAt(m.editor.state.doc, 1)!.contentStart + 1);
    m.press('Backspace');
    type(m, 'y');
    const tail = m.editor.state.doc.child(1).firstChild!;
    expect(tail.textContent).toBe('y tail');
    expect(tail.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['bold']);
  });

  it('and so does text typed at the start of a continuation reached with the arrow keys or a click', () => {
    const bold = schema.marks.bold!.create();
    const head = schema.nodes.paragraph!.create(null, [schema.text('plain '), schema.text('BOLD', [bold])]);
    m = mountPaginated(DOC(PAGE({ columns: 1 }, head), AUTO({ columns: 1 }, PC(' tail'))), { lines: { columns: 1, lines: 1, chars: 100 } });
    m.select(pageAt(m.editor.state.doc, 1)!.contentStart + 1);
    type(m, 'y');
    expect(m.editor.state.doc.child(1).firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['bold']);
  });
});

describe('Backspace / Delete at a page boundary without a continuation', () => {
  /** Page 0 full with "a…" and "b…" (whole), page 1 (auto) starts with a new paragraph "c…". */
  function wholeBlocks(): MountedEditor {
    m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), P(words('b', 50)), P(words('c', 30)))), { lines: { columns: 1 } });
    m.settle();
    const doc = m.editor.state.doc;
    expect(pageTexts(doc)).toEqual([[words('a', 50), words('b', 50)], [words('c', 30)]]);
    expect(doc.child(1).firstChild!.attrs.continuation).toBe(false);
    return m;
  }

  it('Backspace at the start of an auto page joins the pages and runs joinBackward; one undo step', () => {
    const e = wholeBlocks();
    const before = e.editor.state.doc;
    e.select(pageAt(before, 1)!.contentStart + 1);
    e.press('Backspace');
    expect(canonical(e.editor.state.doc).child(0).childCount).toBe(2);
    expect(canonical(e.editor.state.doc).child(0).child(1).textContent).toBe(words('b', 50) + words('c', 30));
    // The cursor sits at the join, between "b…" and "c…".
    expect(e.editor.state.selection.$head.parent.textContent.slice(0, e.editor.state.selection.$head.parentOffset)).toBe(words('b', 50));
    e.settle();
    e.editor.commands.undo();
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('Delete at the end of a page before an auto page joins them with joinForward', () => {
    const e = wholeBlocks();
    e.select(pageAt(e.editor.state.doc, 0)!.contentEnd - 1);
    e.press('Delete');
    expect(canonical(e.editor.state.doc).child(0).child(1).textContent).toBe(words('b', 50) + words('c', 30));
  });

  it('a page that carries objects stays when it is joined', () => {
    const objects = [{ id: 'o1', kind: 'image', classes: ['banner'], style: 'position:absolute;top:0', src: 'https://example.com/a.png' }];
    m = mountPaginated(DOC(PAGE({ columns: 1 }, P('head')), AUTO({ columns: 1, pid: 'objpage1', objects }, P('tail'), P('more'))), { lines: { columns: 1, lines: 1 } });
    m.select(posOf(m.editor.state.doc, 'tail'));
    m.press('Backspace');
    const doc = m.editor.state.doc;
    expect(doc.child(0).firstChild!.textContent).toBe('headtail');
    expect(doc.child(1).attrs).toMatchObject({ pid: 'objpage1', objects });
    expect(pageTexts(doc)[1]).toEqual(['more']);
  });

  it('after pagination moved the restored page\'s boundary, undo leaves one page with the objects (PGR-2)', () => {
    const objects = [{ id: 'o1', kind: 'image', classes: ['banner'], style: 'position:absolute;top:0', src: 'https://example.com/a.png' }];
    m = mountPaginated(
      DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 50)), P(words('b', 50))), AUTO({ columns: 1, pid: 'objpage1', objects }, P(words('c', 30)), P(words('d', 30)))),
      { lines: { columns: 1 } },
    );
    m.settle();
    const original = m.editor.state.doc;
    m.select(posOf(original, 'c0 '));
    m.press('Backspace');
    m.settle();
    // "c…" joined "b…" and was pushed back onto the page with the objects as a continuation.
    expect(m.editor.state.doc.child(1).attrs.pid).toBe('objpage1');
    expect(m.editor.state.doc.child(1).firstChild!.attrs.continuation).toBe(true);
    const objectPages = (d: PMNode) => {
      const out: string[] = [];
      d.forEach((page) => {
        if (objectIds(page).length) out.push(`${String(page.attrs.pid)}:${JSON.stringify(objectIds(page))}`);
      });
      return out;
    };
    expect(m.editor.commands.undo()).toBe(true);
    m.settle();
    expect(objectPages(m.editor.state.doc)).toEqual(['objpage1:["o1"]']);
    expect(m.editor.state.doc.childCount).toBe(2);
    expect(canonical(m.editor.state.doc).eq(canonical(original))).toBe(true);
    expect(m.editor.commands.redo()).toBe(true);
    m.settle();
    expect(objectPages(m.editor.state.doc)).toEqual(['objpage1:["o1"]']);
    expect(canonical(m.editor.state.doc).child(0).child(1).textContent).toBe(words('b', 50) + words('c', 30));
  });

  it('with a table before the page boundary, Backspace selects it and leaves the pages apart', () => {
    const table = schema.nodes.table!.create(null, schema.nodes.tableRow!.create(null, schema.nodes.tableCell!.create(null, P('cell'))));
    m = mountPaginated(DOC(PAGE({ columns: 1 }, P('x'), table), AUTO({ columns: 1 }, P('after'))), { lines: { columns: 1, lines: 2 } });
    const before = m.editor.state.doc;
    m.select(posOf(before, 'after'));
    m.press('Backspace');
    expect(m.editor.state.doc.eq(before)).toBe(true);
    // The table is selected (prosemirror-tables turns the node selection into a cell selection).
    const sel = m.editor.state.selection;
    expect(sel instanceof NodeSelection ? sel.node.type.name : sel.$from.node(2)?.type.name).toBe('table');
  });
});

describe('Backspace / Delete in an empty page', () => {
  /** An imported page number (an empty text object) on a blank auto page left at the end of a section. */
  const pageNumber = [{ id: 'o5-1', kind: 'text', text: '', style: '', classes: ['pageNumber', 'auto'] }];

  /** A section with content, then the blank auto page kept only for its object (as brew hd3KnxwrWuHV had it). */
  function trailingBlankPage(): MountedEditor {
    m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'page0000' }, P('last words')), AUTO({ columns: 1, pid: 'blank001', objects: pageNumber }, P(''))), { lines: { columns: 1 } });
    m.settle();
    // Pagination keeps it: a page that carries objects is never deleted by a pull.
    expect(m.editor.state.doc.childCount).toBe(2);
    return m;
  }

  it('Backspace at its start deletes the page (and its objects); the caret ends the page before; one undo step brings it back', () => {
    const e = trailingBlankPage();
    const before = e.editor.state.doc;
    e.select(pageAt(before, 1)!.contentStart + 1);
    e.press('Backspace');
    e.settle();
    const doc = e.editor.state.doc;
    expect(doc.childCount).toBe(1);
    expect(pageTexts(doc)).toEqual([['last words']]);
    expect(doc.child(0).attrs.objects).toEqual([]);
    expect(e.editor.state.selection.$head.parent.textContent).toBe('last words');
    expect(e.editor.state.selection.$head.parentOffset).toBe('last words'.length);
    expect(e.editor.commands.undo()).toBe(true);
    e.settle();
    expect(e.editor.state.doc.toJSON()).toEqual(before.toJSON());
    expect(e.editor.commands.redo()).toBe(true);
    e.settle();
    expect(e.editor.state.doc.childCount).toBe(1);
  });

  it('Delete at the end of the page before it deletes it too; the caret stays', () => {
    const e = trailingBlankPage();
    const end = pageAt(e.editor.state.doc, 0)!.contentEnd - 1;
    e.select(end);
    e.press('Delete');
    e.settle();
    expect(e.editor.state.doc.childCount).toBe(1);
    expect(pageTexts(e.editor.state.doc)).toEqual([['last words']]);
    expect(head(e)).toBe(end);
  });

  it('a blank manual page (Mod-Enter at the end) goes with one Backspace, without leaving an empty line behind', () => {
    m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'page0000' }, P('text'))), { lines: { columns: 1 } });
    m.settle();
    m.select(posOf(m.editor.state.doc, 'text') + 4);
    m.press('Mod-Enter');
    m.settle();
    expect(pageTexts(m.editor.state.doc)).toEqual([['text'], ['']]);
    m.press('Backspace');
    m.settle();
    expect(pageTexts(m.editor.state.doc)).toEqual([['text']]);
  });

  it('pages with content keep the old rules (Backspace at a manual page start removes the section break)', () => {
    m = mountPaginated(DOC(PAGE({ columns: 1 }, P('one')), PAGE({ columns: 1, pid: 'page0001' }, P('two'))), { lines: { columns: 1 } });
    m.settle();
    m.select(posOf(m.editor.state.doc, 'two'));
    m.press('Backspace');
    m.settle();
    expect(pageTexts(m.editor.state.doc)).toEqual([['one', 'two']]);
  });
});

describe('selection across pages', () => {
  it('Backspace deletes it the default way; pagination settles and the text is right', () => {
    m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, ...Array.from({ length: 8 }, (_, i) => P(words(`p${i}x`, 45))))), { lines: { columns: 1 } });
    m.settle();
    const doc = m.editor.state.doc;
    expect(doc.childCount).toBe(4);
    const from = posOf(doc, 'p1x3');
    const to = posOf(doc, 'p5x2');
    const text = (d: PMNode) => canonical(d).textContent;
    const expected = text(doc).replace(text(doc).slice(text(doc).indexOf('p1x3'), text(doc).indexOf('p5x2')), '');
    m.select(from, to);
    m.press('Backspace');
    m.settle();
    expect(text(m.editor.state.doc)).toBe(expected);
    m.editor.state.doc.check();
    expect(m.editor.state.doc.child(0).attrs.pid).toBe('aaaaaaaa');
  });

  it('a later page\'s objects and markers stay (the page comes back after the joined block); undo and redo keep one copy (PGR-8)', () => {
    const objects = [{ id: 'o1', kind: 'image', classes: ['banner'], style: 'position:absolute;top:0', src: 'https://example.com/a.png' }];
    const b = words('b', 60);
    m = mountPaginated(
      DOC(
        PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 70)), P(b.slice(0, 30))),
        AUTO({ columns: 1, pid: 'objpage1', objects, markers: ['skipCounting'] }, PC(b.slice(30)), P(words('d', 30))),
      ),
      { lines: { columns: 1 } },
    );
    m.settle();
    const data = (d: PMNode) => {
      const out: string[] = [];
      d.forEach((page) => {
        if (objectIds(page).length || (page.attrs.markers as string[]).length) out.push(`${String(page.attrs.pid)}:${JSON.stringify(objectIds(page))}${JSON.stringify(page.attrs.markers)}`);
      });
      return out;
    };
    expect(data(m.editor.state.doc)).toEqual(['objpage1:["o1"]["skipCounting"]']);
    m.select(posOf(m.editor.state.doc, 'b2 '), posOf(m.editor.state.doc, 'b12 '));
    m.press('Backspace');
    expect(data(m.editor.state.doc)).toEqual(['objpage1:["o1"]["skipCounting"]']);
    m.settle();
    expect(data(m.editor.state.doc)).toEqual(['objpage1:["o1"]["skipCounting"]']);
    expect(canonical(m.editor.state.doc).textContent).toBe(words('a', 70) + b.slice(0, 6) + b.slice(b.indexOf('b12 ')) + words('d', 30));
    m.editor.commands.undo();
    m.settle();
    expect(data(m.editor.state.doc)).toEqual(['objpage1:["o1"]["skipCounting"]']);
    m.editor.commands.redo();
    m.settle();
    expect(data(m.editor.state.doc)).toEqual(['objpage1:["o1"]["skipCounting"]']);
  });

  it('a page whose whole flow was selected goes with its objects (as a deleted page)', () => {
    const objects = [{ id: 'o1', kind: 'image', classes: ['banner'], style: 'position:absolute;top:0', src: 'https://example.com/a.png' }];
    m = mountPaginated(
      DOC(PAGE({ columns: 1, pid: 'page0000' }, P('first')), AUTO({ columns: 1, pid: 'objpage1', objects }, P('second')), AUTO({ columns: 1, pid: 'page2222' }, P('third'))),
      { lines: { columns: 1, lines: 1 } },
    );
    m.select(posOf(m.editor.state.doc, 'first') + 2, posOf(m.editor.state.doc, 'third') + 2);
    m.press('Backspace');
    let objectsLeft = 0;
    m.editor.state.doc.forEach((page) => (objectsLeft += objectIds(page).length));
    expect(objectsLeft).toBe(0);
  });
});
