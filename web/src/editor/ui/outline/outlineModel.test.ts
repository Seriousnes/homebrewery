// The outline from the document, with upstream's header navigation labels (headerNav.jsx:20-37).
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { docOf, node, p, page, schema, text } from '@/editor/schema/testing';
import { buildOutline, findBlockById, firstLine, nodeText, sameOutline, shortLabel, topLevelPageType } from './outlineModel';

const h = (level: number, value: string, id: string | null = null): JSONContent => node('heading', { level, id }, [text(value)]);
const build = (json: JSONContent) => buildOutline(schema.nodeFromJSON(json));

describe('page labels (upstream topLevelPages)', () => {
  it('numbers ordinary pages', () => {
    expect(build(docOf(page([p('a')]), page([p('b')]))).map((pg) => [pg.number, pg.id, pg.label, pg.pageType])).toEqual([
      [1, 'p1', 'Page 1', null],
      [2, 'p2', 'Page 2', null],
    ]);
  });

  it('labels covers with their first h1, or a default', () => {
    const outline = build(
      docOf(
        page([h(1, 'The Inn', 'the-inn')], { markers: ['frontCover'] }),
        page([p('x')], { markers: ['insideCover'] }),
        page([h(2, 'Not an h1', 'not-an-h1'), h(1, 'Part Two', 'part-two')], { markers: ['partCover'] }),
        page([p('bye')], { markers: ['backCover'] }),
        page([node('toc')]),
      ),
    );
    expect(outline.map((pg) => pg.label)).toEqual([
      'Page 1 - Cover: The Inn',
      'Page 2 - Interior Cover Page',
      'Page 3 - Section: Part Two',
      'Page 4 - Rear Cover Page',
      'Page 5 - Table of Contents',
    ]);
    expect(outline.map((pg) => pg.pageType)).toEqual(['frontCover', 'insideCover', 'partCover', 'backCover', 'toc']);
    // Top-level pages don't list their headings.
    expect(outline.every((pg) => pg.entries.length === 0)).toBe(true);
  });

  it('finds cover classes anywhere on the page: blocks, spans, page objects', () => {
    const viaBlock = docOf(page([node('themeBlock', { classes: ['backCover'] }, [p('x')])]));
    const viaSpan = docOf(page([node('paragraph', {}, [text('x', [{ type: 'span', attrs: { classes: ['partCover'] } }])])]));
    const viaObject = docOf(page([p('x')], { objects: [{ id: 'o1', kind: 'text', classes: ['insideCover'], style: '', text: 'x' }] }));
    const viaToc = docOf(page([node('themeBlock', { classes: ['toc', 'wide'] }, [p('x')])]));
    expect(build(viaBlock)[0]?.label).toBe('Page 1 - Rear Cover Page');
    expect(build(viaSpan)[0]?.label).toBe('Page 1 - Section Cover Page');
    expect(build(viaObject)[0]?.label).toBe('Page 1 - Interior Cover Page');
    expect(build(viaToc)[0]?.label).toBe('Page 1 - Table of Contents');
  });

  it('uses upstream’s order when a page has several markers', () => {
    const json = docOf(page([node('toc')], { markers: ['backCover', 'frontCover'] }));
    expect(topLevelPageType(schema.nodeFromJSON(json).child(0))).toBe('frontCover');
  });

  it('ignores the page’s own classes (upstream looked inside the page only)', () => {
    expect(build(docOf(page([p('x')], { classes: ['frontCover'] })))[0]?.pageType).toBeNull();
  });
});

describe('entries (upstream selector)', () => {
  it('lists direct blocks with ids (headings by level, others at depth 7) and nested h2s', () => {
    const outline = build(
      docOf(
        page([
          h(1, 'Intro', 'intro'),
          p('plain'),
          h(3, 'Deep', 'deep'),
          node('paragraph', { id: 'anchor' }, [text('Anchored paragraph')]),
          node('themeBlock', { classes: ['monster', 'frame'] }, [h(2, 'Innkeeper', 'innkeeper'), h(3, 'Actions', 'actions'), p('x')]),
          node('themeBlock', { classes: ['note'], id: 'note-1' }, [p('Note text'), p('more')]),
        ]),
      ),
    );
    expect(outline[0]?.entries.map((e) => [e.kind, e.id, e.depth, e.text])).toEqual([
      ['heading', 'intro', 1, 'Intro'],
      ['heading', 'deep', 3, 'Deep'],
      ['block', 'anchor', 7, 'Anchored paragraph'],
      ['heading', 'innkeeper', 2, 'Innkeeper'],
      ['block', 'note-1', 7, 'Note text'],
    ]);
  });

  it('skips headings without an id (continued from the previous page) and empty text', () => {
    const outline = build(docOf(page([h(2, 'continued'), h(2, '   ', 'blank'), h(2, 'Kept', 'kept')])));
    expect(outline[0]?.entries.map((e) => e.id)).toEqual(['kept']);
  });

  it('records positions that resolve to the nodes', () => {
    const doc = schema.nodeFromJSON(docOf(page([p('x')]), page([p('y'), h(2, 'Here', 'here')])));
    const outline = buildOutline(doc);
    const entry = outline[1]?.entries[0];
    expect(doc.nodeAt(entry!.pos)?.attrs.id).toBe('here');
    expect(doc.nodeAt(outline[1]!.pos)?.type.name).toBe('page');
  });
});

describe('text helpers', () => {
  it('firstLine takes the first non-empty line, trimmed', () => {
    expect(firstLine('\n  First  \nSecond')).toBe('First');
    expect(firstLine('')).toBe('');
  });

  it('shortLabel trims to 40 - prefix characters like upstream', () => {
    const long = 'A heading that is much longer than forty characters';
    expect(shortLabel(long)).toBe('A heading that is much longer than forty...');
    expect(shortLabel(long, 2)).toBe('A heading that is much longer than for...');
    expect(shortLabel('Short')).toBe('Short');
  });

  it('nodeText turns hard breaks into new lines', () => {
    const heading = schema.nodeFromJSON(node('heading', { level: 1 }, [text('One'), node('hardBreak'), text('Two')]));
    expect(nodeText(heading)).toBe('One\nTwo');
    expect(build(docOf(page([node('heading', { level: 1, id: 'one' }, [text('One'), node('hardBreak'), text('Two')])])))[0]?.entries[0]?.text).toBe('One');
  });
});

describe('findBlockById / sameOutline', () => {
  it('finds the block with an id, nearest to a hint when duplicated', () => {
    const doc = schema.nodeFromJSON(docOf(page([h(2, 'A', 'dup'), p('x')]), page([h(2, 'B', 'dup')])));
    const [first, second] = buildOutline(doc).flatMap((pg) => pg.entries);
    expect(findBlockById(doc, 'dup', 0)).toBe(first!.pos);
    expect(findBlockById(doc, 'dup', second!.pos + 3)).toBe(second!.pos);
    expect(findBlockById(doc, 'missing')).toBeNull();
    // Page ids are not block ids.
    expect(findBlockById(doc, 'p1')).toBeNull();
  });

  it('compares what is rendered, not positions', () => {
    const a = build(docOf(page([p('x'), h(2, 'H', 'h')])));
    const b = build(docOf(page([p('longer text'), h(2, 'H', 'h')])));
    const c = build(docOf(page([p('x'), h(2, 'H2', 'h')])));
    expect(sameOutline(a, b)).toBe(true);
    expect(sameOutline(a, c)).toBe(false);
    expect(sameOutline(a, [])).toBe(false);
  });
});
