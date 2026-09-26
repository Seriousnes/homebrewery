// cut.ts afterHangingSpaces and hangingSpacesPull (matrix lane, P4.9): the spaces of a soft wrap
// stay at the end of the line before the seam, never at the start of the continuation. Found by
// e2e/matrix/undo.spec.ts in Linux Chromium: after an undo and redo the same text split before or
// after a hanging space.
import { Transform } from '@tiptap/pm/transform';
import { describe, expect, it } from 'vitest';
import { moveBoundary, pageAt } from './boundary';
import { afterHangingSpaces, hangingSpacesPull } from './cut';
import { AUTO, DOC, H, P, PAGE, PC, pageTexts, posOf, schema } from './testing';

describe('afterHangingSpaces', () => {
  const doc = DOC(PAGE(null, P('the year  The wanderers'), P('last')));
  const end = 1 + doc.child(0).child(0).nodeSize - 1; // the end of the first paragraph's text

  it('moves a cut on spaces past them, to the next word', () => {
    const firstSpace = posOf(doc, 'year') + 4;
    expect(doc.textBetween(firstSpace, firstSpace + 1)).toBe(' ');
    const at = afterHangingSpaces(doc, firstSpace, end);
    expect(doc.textBetween(at, end)).toBe('The wanderers');
    expect(afterHangingSpaces(doc, firstSpace + 1, end)).toBe(at);
  });

  it('leaves a cut at a word alone', () => {
    const word = posOf(doc, 'The');
    expect(afterHangingSpaces(doc, word, end)).toBe(word);
  });

  it('stops at the limit: a paragraph ending in spaces keeps them', () => {
    const trailing = DOC(PAGE(null, P('end  ')));
    const limit = trailing.child(0).child(0).nodeSize; // end of the text
    expect(afterHangingSpaces(trailing, posOf(trailing, 'end') + 3, limit)).toBe(limit);
  });

  it('does not skip non-breaking spaces or inline nodes', () => {
    const nbsp = DOC(PAGE(null, P(`a${String.fromCharCode(0xa0)}b`)));
    const at = posOf(nbsp, 'a') + 1;
    expect(afterHangingSpaces(nbsp, at, nbsp.child(0).child(0).nodeSize)).toBe(at);
    const withBreak = DOC(PAGE(null, schema.nodes.paragraph!.create(null, [schema.text('a '), schema.nodes.hardBreak!.create(), schema.text(' b')])));
    const beforeBreak = posOf(withBreak, 'a') + 1; // on the space before the hard break
    expect(afterHangingSpaces(withBreak, beforeBreak, withBreak.child(0).child(0).nodeSize)).toBe(beforeBreak + 1);
  });
});

describe('hangingSpacesPull', () => {
  const split = () => DOC(PAGE({ pid: 'aaaaaaaa' }, P('the year '), P('head of the chain')), AUTO(null, PC('  The wanderers'), P('after')));

  it('pulls the spaces a continuation starts with back to its head, where they hang', () => {
    const doc = split();
    const target = hangingSpacesPull(doc.child(0), pageAt(doc, 1)!);
    expect(target).toBe(pageAt(doc, 1)!.contentStart + 1 + 2);
    const tr = new Transform(doc);
    moveBoundary(tr, 0, target!);
    tr.doc.check();
    expect(pageTexts(tr.doc)).toEqual([['the year ', 'head of the chain  '], ['The wanderers', 'after']]);
    expect(tr.doc.child(1).child(0).attrs.continuation).toBe(true);
  });

  it('is null when the continuation starts with a word, is no paragraph, or the page is manual', () => {
    const word = DOC(PAGE(null, P('head ')), AUTO(null, PC('The wanderers')));
    expect(hangingSpacesPull(word.child(0), pageAt(word, 1)!)).toBeNull();
    const notContinued = DOC(PAGE(null, P('head ')), AUTO(null, P('  loose')));
    expect(hangingSpacesPull(notContinued.child(0), pageAt(notContinued, 1)!)).toBeNull();
    const manual = DOC(PAGE(null, P('head ')), PAGE(null, PC('  section')));
    expect(hangingSpacesPull(manual.child(0), pageAt(manual, 1)!)).toBeNull();
    const heading = DOC(PAGE(null, H(2, 'Title')), AUTO(null, PC('  x')));
    expect(hangingSpacesPull(heading.child(0), pageAt(heading, 1)!)).toBeNull();
  });
});

describe('hangingSpacesPull: a continuation of nothing but spaces', () => {
  it('pulls the whole block back (a redo can leave it on a page of its own)', () => {
    const doc = DOC(PAGE({ pid: 'aaaaaaaa' }, P('head of the year ')), AUTO(null, PC(' ')), AUTO(null, PC('The wanderers')));
    const next = pageAt(doc, 1)!;
    const target = hangingSpacesPull(doc.child(0), next);
    expect(target).toBe(next.contentStart + next.node.child(0).nodeSize);
    const tr = new Transform(doc);
    expect(moveBoundary(tr, 0, target!)).toBe('merged');
    tr.doc.check();
    expect(pageTexts(tr.doc)).toEqual([['head of the year  '], ['The wanderers']]);
  });
});
