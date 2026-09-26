// Pages that carry objects or markers (boundary.ts carriesPageData, pageData.ts) on the line model
// (1 column of 10 lines of 10 characters): markers set on an auto page survive pagination merging
// the page (PGR-5), and a page kept only for its markers goes with its last one.
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { editMarkers } from '../commands/attrs';
import { deleteObject, setPageCover } from '../objects/commands';
import { pageAt } from './boundary';
import { mountPaginated, type MountedEditor } from './testEditor';
import { AUTO, DOC, P, PAGE, canonical, pageTexts, posOf } from './testing';

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

/** Markers of every page that has any: ["page index:marker,…"]. */
function markers(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((page, _o, index) => {
    const list = page.attrs.markers as string[];
    if (list.length) out.push(`${index}:${list.join(",")}`);
  });
  return out;
}

/** "a…" (60), "b…" (40) fill page 0; "c…" (20) is alone on auto page 1. */
function coverDoc(): MountedEditor {
  m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 60)), P(words('b', 40)), P(words('c', 20)))), { lines: { columns: 1 } });
  m.settle();
  expect(pageTexts(m.editor.state.doc)[1]).toEqual([words('c', 20)]);
  return m;
}

/** Deletes 40 characters of "a…": everything fits on page 0 again. */
function deleteFromA(e: MountedEditor): void {
  const from = posOf(e.editor.state.doc, 'a0 ');
  e.select(from, from + 40);
  e.press('Backspace');
  e.settle();
}

describe('markers on an auto page (PGR-5)', () => {
  it('a cover set on an auto page stays when all of its text flows back: the page is kept; undo and redo keep the cover', () => {
    const e = coverDoc();
    const page1 = pageAt(e.editor.state.doc, 1)!;
    expect(setPageCover(page1.pos, 'frontCover')(e.editor.state, e.editor.view.dispatch)).toBe(true);
    e.settle();
    expect(markers(e.editor.state.doc)).toEqual(['1:frontCover']);
    deleteFromA(e);
    // Page 1 keeps the cover, with one empty paragraph; "c…" moved back to page 0.
    expect(markers(e.editor.state.doc)).toEqual(['1:frontCover']);
    expect(pageTexts(e.editor.state.doc)).toEqual([[words('a', 60).slice(40), words('b', 40), words('c', 20)], ['']]);
    e.editor.commands.undo();
    e.settle();
    expect(markers(e.editor.state.doc)).toEqual(['1:frontCover']);
    expect(pageTexts(e.editor.state.doc)[1]).toEqual([words('c', 20)]);
    e.editor.commands.redo();
    e.settle();
    expect(markers(e.editor.state.doc)).toEqual(['1:frontCover']);
  });

  it('markers from the inspector (skip page numbering) too', () => {
    const e = coverDoc();
    editMarkers(e.editor.state, e.editor.view.dispatch, 1, ['skipCounting']);
    e.settle();
    deleteFromA(e);
    expect(markers(e.editor.state.doc)).toEqual(['1:skipCounting']);
  });

  it('deleting the last object of a kept page that also carries a marker keeps the page and the marker', () => {
    const objects = [{ id: 'o1', kind: 'image', classes: ['banner'], style: 'position:absolute;top:0', src: 'https://example.com/a.png' }];
    m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 30))), AUTO({ columns: 1, pid: 'kept0001', objects, markers: ['skipCounting'] }, P(''))), {
      lines: { columns: 1 },
    });
    m.settle();
    expect(deleteObject({ pagePos: m.editor.state.doc.child(0).nodeSize, id: 'o1' })(m.editor.state, m.editor.view.dispatch)).toBe(true);
    m.settle();
    expect(markers(m.editor.state.doc)).toEqual(['1:skipCounting']);
    expect(m.editor.state.doc.child(1).attrs.objects).toEqual([]);
  });

  it('a page kept only for its marker goes with the marker, in the same undo step; undo brings both back', () => {
    const e = coverDoc();
    setPageCover(pageAt(e.editor.state.doc, 1)!.pos, 'frontCover')(e.editor.state, e.editor.view.dispatch);
    e.settle();
    deleteFromA(e);
    const kept = e.editor.state.doc;
    expect(kept.childCount).toBe(2);
    expect(setPageCover(pageAt(kept, 1)!.pos, null)(e.editor.state, e.editor.view.dispatch)).toBe(true);
    // No stray empty paragraph pulled into page 0: the page went.
    expect(e.editor.state.doc.childCount).toBe(1);
    e.settle();
    expect(pageTexts(e.editor.state.doc)).toEqual([[words('a', 60).slice(40), words('b', 40), words('c', 20)]]);
    e.editor.commands.undo();
    e.settle();
    expect(canonical(e.editor.state.doc).eq(canonical(kept))).toBe(true);
    expect(markers(e.editor.state.doc)).toEqual(['1:frontCover']);
  });
});
