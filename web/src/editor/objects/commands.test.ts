// Page object and page commands (P5.3) on pure ProseMirror states: each command is one undo step,
// object changes never make pagination move content (objects are out of the flow), and pages
// that carry objects survive pulls.
import { closeHistory, history, redo, undo, undoDepth } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, Plugin, TextSelection, type Command } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { pageAt } from '../pagination/boundary';
import { defaultMaxSteps, paginationPlugin } from '../pagination/plugin';
import { paginationKey } from '../pagination/state';
import { paginatePage } from '../pagination/step';
import { AUTO, DOC, P, PAGE, canonical, lineLayout, pageTexts, posOf, schema } from '../pagination/testing';
import type { PageObject } from '../schema';
import {
  addObject,
  addTextObject,
  deleteObject,
  moveObjectInZOrder,
  placeImageFreely,
  putObjectInText,
  selectObject,
  setPageCover,
  setSelectionCover,
  updateObject,
} from './commands';
import { imageObject, textObject } from './model';
import { applyObjectSelection, objectSelectionKey, selectedObject, type ObjectSelectionState } from './state';

const selectionPlugin = () =>
  new Plugin<ObjectSelectionState>({ key: objectSelectionKey, state: { init: (): ObjectSelectionState => ({ selected: null }), apply: (tr, prev) => applyObjectSelection(tr, prev) } });

function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

const IMG: PageObject = { id: 'o1', kind: 'image', classes: ['banner'], style: 'position: absolute; top: 10px; left: 20px;', src: 'https://example.com/a.png' };
const TXT: PageObject = { id: 'o2', kind: 'text', classes: [], style: 'position: absolute; top: 40px; left: 20px;', text: 'Title' };

class Harness {
  state: EditorState;
  readonly layout = lineLayout(() => this.state.doc, { lines: 10, chars: 10, columns: 1 });

  constructor(doc: PMNode, withPagination = true) {
    this.state = EditorState.create({ doc, plugins: [history(), selectionPlugin(), ...(withPagination ? [paginationPlugin()] : [])] });
  }

  run(command: Command): boolean {
    return command(this.state, (tr) => (this.state = this.state.apply(tr)));
  }

  /** Pagination steps until settled; returns their actions. */
  settle(): string[] {
    const actions: string[] = [];
    for (;;) {
      const st = paginationKey.getState(this.state);
      if (!st || st.dirtyFrom === null) return actions;
      if (actions.length > defaultMaxSteps(this.state.doc)) throw new Error('no settle');
      const r = paginatePage(this.state, st, this.layout);
      actions.push(r.action);
      this.state = this.state.apply(r.tr);
    }
  }

  objects(page = 0): PageObject[] {
    return pageAt(this.state.doc, page)!.node.attrs.objects as PageObject[];
  }
}

describe('object commands', () => {
  it('add, update, reorder and delete are one undo step each and select the object', () => {
    const h = new Harness(DOC(PAGE({ objects: [IMG] }, P('Hello'))), false);
    expect(h.run(addObject(0, (id) => textObject(id, 'Title', { left: 5, top: 6 })))).toBe(true);
    const added = h.objects()[1]!;
    expect(added).toMatchObject({ kind: 'text', text: 'Title', style: 'position: absolute; left: 5px; top: 6px;' });
    expect(selectedObject(h.state)).toEqual({ pagePos: 0, id: added.id });
    expect(undoDepth(h.state)).toBe(1);

    const ref = { pagePos: 0, id: added.id };
    expect(h.run(updateObject(ref, { style: 'position: absolute; left: 50px; top: 60px;' }))).toBe(true);
    expect(h.run(moveObjectInZOrder(ref, 'backward'))).toBe(true);
    expect(h.objects().map((o) => o.id)).toEqual([added.id, 'o1']);
    expect(h.run(moveObjectInZOrder(ref, 'backward'))).toBe(false); // already at the back
    expect(h.run(deleteObject(ref))).toBe(true);
    expect(selectedObject(h.state)).toBeNull();
    expect(h.objects().map((o) => o.id)).toEqual(['o1']);
    expect(undoDepth(h.state)).toBe(4);

    // Undo walks back one action at a time.
    undo(h.state, (tr) => (h.state = h.state.apply(tr)));
    expect(h.objects().map((o) => o.id)).toEqual([added.id, 'o1']);
    undo(h.state, (tr) => (h.state = h.state.apply(tr)));
    expect(h.objects().map((o) => o.id)).toEqual(['o1', added.id]);
    expect(h.objects()[1]!.style).toBe('position: absolute; left: 50px; top: 60px;');
    undo(h.state, (tr) => (h.state = h.state.apply(tr)));
    expect(h.objects()[1]!.style).toBe('position: absolute; left: 5px; top: 6px;');
    undo(h.state, (tr) => (h.state = h.state.apply(tr)));
    expect(h.objects()).toEqual([IMG]);
    redo(h.state, (tr) => (h.state = h.state.apply(tr)));
    expect(h.objects()).toHaveLength(2);
  });

  it('refuses unknown pages and objects', () => {
    const h = new Harness(DOC(PAGE({ objects: [IMG] }, P('Hello'))), false);
    expect(h.run(updateObject({ pagePos: 0, id: 'nope' }, { text: 'x' }))).toBe(false);
    expect(h.run(updateObject({ pagePos: 3, id: 'o1' }, { text: 'x' }))).toBe(false);
    expect(h.run(updateObject({ pagePos: 0, id: 'o1' }, { style: IMG.style }))).toBe(false); // no change
    expect(h.run(selectObject({ pagePos: 0, id: 'nope' }))).toBe(false);
    expect(undoDepth(h.state)).toBe(0);
  });

  it('keeps the selection on its page as positions move, and drops it with the object', () => {
    const h = new Harness(DOC(PAGE(null, P('First')), PAGE({ objects: [IMG] }, P('Second'))), false);
    const pagePos = pageAt(h.state.doc, 1)!.pos;
    h.run(selectObject({ pagePos, id: 'o1' }));
    // Typing on page 1 shifts page 2.
    h.state = h.state.apply(h.state.tr.insertText('abc', 2));
    expect(selectedObject(h.state)).toEqual({ pagePos: pagePos + 3, id: 'o1' });
    // Undo of the object's removal elsewhere: the selection goes when the object goes.
    h.run(deleteObject({ pagePos: pagePos + 3, id: 'o1' }));
    expect(selectedObject(h.state)).toBeNull();
  });

  it('selecting is not an undo step and does not change the document', () => {
    const h = new Harness(DOC(PAGE({ objects: [IMG] }, P('Hello'))), false);
    const before = h.state.doc;
    h.run(selectObject({ pagePos: 0, id: 'o1' }));
    expect(h.state.doc).toBe(before);
    expect(undoDepth(h.state)).toBe(0);
    h.run(selectObject(null));
    expect(selectedObject(h.state)).toBeNull();
  });

  it('adds a text object on the selection page', () => {
    const h = new Harness(DOC(PAGE(null, P('One')), PAGE(null, P('Two'))), false);
    h.state = h.state.apply(h.state.tr.setSelection(TextSelection.create(h.state.doc, posOf(h.state.doc, 'Two') + 1)));
    expect(h.run(addTextObject('Hi'))).toBe(true);
    expect(h.objects(0)).toEqual([]);
    expect(h.objects(1)).toHaveLength(1);
  });
});

describe('objects and pagination', () => {
  it('moving, resizing and reordering objects never makes pagination move content', () => {
    const h = new Harness(DOC(PAGE({ columns: 1, objects: [IMG, TXT] }, P(words('a', 150)), P(words('b', 150)))));
    h.settle();
    const settled = h.state.doc;
    const texts = pageTexts(settled);
    expect(texts.length).toBeGreaterThan(1);
    const ref = { pagePos: 0, id: 'o1' };
    for (const command of [
      updateObject(ref, { style: 'position: absolute; top: 300px; left: 200px; width: 400px; height: 300px;' }),
      moveObjectInZOrder(ref, 'front'),
      updateObject({ pagePos: 0, id: 'o2' }, { text: 'A much longer title than before' }),
      deleteObject({ pagePos: 0, id: 'o2' }),
    ]) {
      expect(h.run(command)).toBe(true);
      const actions = h.settle();
      expect(actions.every((a) => a === 'settled')).toBe(true);
      expect(pageTexts(h.state.doc)).toEqual(texts);
    }
    // Only the objects changed: the flow is the same document as before.
    expect(canonical(h.state.doc).content.eq(canonical(settled).content)).toBe(false);
    expect(pageTexts(canonical(h.state.doc))).toEqual(pageTexts(canonical(settled)));
    expect(h.objects().map((o) => o.id)).toEqual(['o1']);
  });

  it('a page that carries objects survives a pull that empties it', () => {
    const h = new Harness(DOC(PAGE({ columns: 1 }, P(words('a', 90))), AUTO({ columns: 1, objects: [IMG] }, P(words('b', 30)))));
    h.settle();
    // Delete most of page 1: page 2's text is pulled back, page 2 stays for its object.
    const from = 2;
    h.state = h.state.apply(h.state.tr.delete(from, from + 80));
    h.settle();
    expect(h.state.doc.childCount).toBe(2);
    expect(pageAt(h.state.doc, 1)!.node.attrs.objects).toEqual([IMG]);
    expect(pageAt(h.state.doc, 1)!.node.textContent).toBe('');
  });
});

describe('undo of object changes on auto pages (UI-1)', () => {
  const undoIn = (h: Harness) => undo(h.state, (tr) => (h.state = h.state.apply(tr)));
  const redoIn = (h: Harness) => redo(h.state, (tr) => (h.state = h.state.apply(tr)));
  const allObjects = (h: Harness) => {
    const ids: string[] = [];
    h.state.doc.forEach((page) => ids.push(...(page.attrs.objects as PageObject[]).map((o) => o.id)));
    return ids;
  };

  it('deleting the last object of a page kept only for it removes the page in the same step: undo brings both back', () => {
    const h = new Harness(DOC(PAGE({ columns: 1, pid: 'p1' }, P('Short text on page one.')), AUTO({ columns: 1, pid: 'p2', objects: [IMG] }, P(''))));
    h.settle();
    expect(h.state.doc.childCount).toBe(2);
    // The caret sits in the placeholder page's empty paragraph.
    const pagePos = pageAt(h.state.doc, 1)!.pos;
    h.state = h.state.apply(h.state.tr.setSelection(TextSelection.create(h.state.doc, pagePos + 2)));
    expect(h.run(deleteObject({ pagePos, id: 'o1' }))).toBe(true);
    h.settle();
    expect(h.state.doc.childCount).toBe(1);
    expect(allObjects(h)).toEqual([]);
    // The caret went to the end of the page before.
    expect(h.state.selection.from).toBe(posOf(h.state.doc, 'Short text on page one.') + 'Short text on page one.'.length);
    expect(undoDepth(h.state)).toBe(1);

    undoIn(h);
    h.settle();
    expect(h.state.doc.childCount).toBe(2);
    expect(h.objects(1)).toEqual([IMG]);
    expect(pageAt(h.state.doc, 1)!.node.attrs.pid).toBe('p2');

    redoIn(h);
    h.settle();
    expect(h.state.doc.childCount).toBe(1);
    expect(allObjects(h)).toEqual([]);
  });

  it("'Put back in text' from a page kept only for its object puts the image at the end of the page before", () => {
    const h = new Harness(DOC(PAGE({ columns: 1, pid: 'p1' }, P('Short text on page one.')), AUTO({ columns: 1, pid: 'p2', objects: [IMG] }, P(''))));
    h.settle();
    const pagePos = pageAt(h.state.doc, 1)!.pos;
    expect(h.run(putObjectInText({ pagePos, id: 'o1' }, pagePos + 2))).toBe(true);
    h.settle();
    expect(allObjects(h)).toEqual([]);
    let images = 0;
    h.state.doc.descendants((node) => {
      if (node.type.name === 'image') images++;
    });
    expect(images).toBe(1);
    expect(h.state.selection).toBeInstanceOf(NodeSelection);

    undoIn(h);
    h.settle();
    expect(h.state.doc.childCount).toBe(2);
    expect(h.objects(1)).toEqual([IMG]);
    images = 0;
    h.state.doc.descendants((node) => {
      if (node.type.name === 'image') images++;
    });
    expect(images).toBe(0);
  });

  it("an object change on an auto page is undone after pagination moved that page's boundary", () => {
    const h = new Harness(DOC(PAGE({ columns: 1, pid: 'p1' }, P(words('a', 80))), AUTO({ columns: 1, pid: 'p2', objects: [IMG, TXT] }, P(words('b', 50)))));
    h.settle();
    expect(h.state.doc.childCount).toBe(2);
    const pagePos = pageAt(h.state.doc, 1)!.pos;
    expect(h.run(deleteObject({ pagePos, id: 'o1' }))).toBe(true);
    expect(h.run(updateObject({ pagePos, id: 'o2' }, { text: 'Changed' }))).toBe(true);
    h.settle();
    // Typing on page 1 (a new undo step) pushes text to page 2: its boundary moves (join + split).
    h.state = h.state.apply(closeHistory(h.state.tr).insertText('more words here ', 2));
    h.settle();
    const moved = pageAt(h.state.doc, 1)!;
    expect(moved.node.attrs.pid).toBe('p2');
    expect(moved.pos).not.toBe(pagePos);

    undoIn(h); // the typing
    h.settle();
    undoIn(h); // the text change
    h.settle();
    expect(h.objects(1).map((o) => o.id)).toEqual(['o2']);
    expect(h.objects(1)[0]!.text).toBe('Title');
    undoIn(h); // the deletion
    h.settle();
    expect(h.objects(1)).toEqual([IMG, TXT]);
    redoIn(h);
    h.settle();
    expect(h.objects(1)).toEqual([TXT]);
  });
});

describe('inline image ⇄ page object', () => {
  const imageDoc = () =>
    DOC(
      PAGE(
        null,
        schema.nodes.paragraph!.create(null, [
          schema.text('Before '),
          schema.nodes.image!.create({ src: 'https://example.com/p.png', classes: ['wrapLeft'], style: 'float: left; width: 120px; margin-right: 8px;' }),
          schema.text(' after'),
        ]),
      ),
    );

  it("'Place freely' moves the image out of the text onto the page, in one undo step", () => {
    const h = new Harness(imageDoc(), false);
    const imagePos = posOf(h.state.doc, ' after') - 1;
    expect(h.state.doc.nodeAt(imagePos)?.type.name).toBe('image');
    expect(h.run(placeImageFreely(imagePos, { left: 40, top: 50, width: 120, height: 90 }))).toBe(true);
    expect(h.state.doc.textContent).toBe('Before  after');
    const [object] = h.objects();
    expect(object).toMatchObject({ kind: 'image', src: 'https://example.com/p.png', classes: ['wrapLeft'] });
    expect(object!.style).toBe('width: 120px; position: absolute; left: 40px; top: 50px; height: 90px;');
    expect(selectedObject(h.state)).toEqual({ pagePos: 0, id: object!.id });
    expect(undoDepth(h.state)).toBe(1);
    undo(h.state, (tr) => (h.state = h.state.apply(tr)));
    expect(h.state.doc.eq(imageDoc())).toBe(true);
  });

  it("'Put back in text' inserts the image at the hint (or the page's first paragraph) without its positioning", () => {
    const h = new Harness(DOC(PAGE({ objects: [IMG] }, P('Hello world'))), false);
    const hint = posOf(h.state.doc, 'world');
    expect(h.run(putObjectInText({ pagePos: 0, id: 'o1' }, hint))).toBe(true);
    expect(h.objects()).toEqual([]);
    const image = h.state.doc.nodeAt(hint)!;
    expect(image.type.name).toBe('image');
    expect(image.attrs).toMatchObject({ src: IMG.src, classes: ['banner'], style: null });
    expect(h.state.selection).toBeInstanceOf(NodeSelection);
    undo(h.state, (tr) => (h.state = h.state.apply(tr)));
    expect(h.objects()).toEqual([IMG]);

    // No hint: start of the first paragraph. A text object can't go back.
    const h2 = new Harness(DOC(PAGE({ objects: [IMG, TXT] }, P('Hi'))), false);
    expect(h2.run(putObjectInText({ pagePos: 0, id: 'o2' }))).toBe(false);
    expect(h2.run(putObjectInText({ pagePos: 0, id: 'o1' }))).toBe(true);
    expect(h2.state.doc.nodeAt(2)?.type.name).toBe('image');
  });

  it('round-trips: placed freely and put back keeps the source, classes and size', () => {
    const h = new Harness(imageDoc(), false);
    const imagePos = posOf(h.state.doc, ' after') - 1;
    h.run(placeImageFreely(imagePos, { left: 40, top: 50, width: 120, height: 90 }));
    const id = h.objects()[0]!.id;
    h.run(putObjectInText({ pagePos: 0, id }, imagePos));
    const image = h.state.doc.nodeAt(imagePos)!;
    expect(image.attrs).toMatchObject({ src: 'https://example.com/p.png', classes: ['wrapLeft'], style: 'width: 120px; height: 90px;' });
  });
});

describe('page commands', () => {
  it('sets, replaces and clears the cover marker, keeping other markers', () => {
    const h = new Harness(DOC(PAGE({ markers: ['skipCounting'] }, P('Cover'))), false);
    expect(h.run(setPageCover(0, 'frontCover'))).toBe(true);
    expect(pageAt(h.state.doc, 0)!.node.attrs.markers).toEqual(['frontCover', 'skipCounting']);
    expect(h.run(setSelectionCover('backCover'))).toBe(true);
    expect(pageAt(h.state.doc, 0)!.node.attrs.markers).toEqual(['backCover', 'skipCounting']);
    expect(h.run(setPageCover(0, 'backCover'))).toBe(false);
    expect(h.run(setPageCover(0, null))).toBe(true);
    expect(pageAt(h.state.doc, 0)!.node.attrs.markers).toEqual(['skipCounting']);
    expect(undoDepth(h.state)).toBe(3);
  });

  it('image objects are created with an absolute position', () => {
    expect(imageObject('x', 'a.png', { left: 1, top: 2, width: 3 })).toEqual({ id: 'x', kind: 'image', classes: [], style: 'position: absolute; left: 1px; top: 2px; width: 3px;', src: 'a.png' });
  });
});
