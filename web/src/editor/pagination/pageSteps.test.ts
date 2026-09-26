// pageSteps.ts: PageBreakStep / JoinPagesStep, and why they exist: undo and redo of page-structure
// commands after pagination has joined or split the pages involved.
import type { Node as PMNode } from '@tiptap/pm/model';
import { Step, Transform } from '@tiptap/pm/transform';
import { afterEach, describe, expect, it } from 'vitest';
import { pageAt } from './boundary';
import { JoinPagesStep, PageBreakStep } from './pageSteps';
import { mountPaginated, type MountedEditor } from './testEditor';
import { AUTO, DOC, OL, P, PAGE, PC, canonical, li, pageTexts, posOf, schema } from './testing';

function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

const apply = (doc: PMNode, step: Step) => {
  const tr = new Transform(doc);
  const result = tr.maybeStep(step);
  return { tr, failed: result.failed };
};

const kinds = (doc: PMNode) => {
  const out: string[] = [];
  doc.forEach((page) => out.push(`${String(page.attrs.kind)}:${String(page.attrs.pid)}`));
  return out;
};

describe('PageBreakStep', () => {
  const doc = DOC(PAGE({ pid: 'aaaaaaaa' }, P('one'), P('two')), AUTO({ pid: 'bbbbbbbb' }, P('three')));
  const manual = { kind: 'manual', pid: 'newpage1', columns: 1 };

  it('inside a page\'s flow, between blocks: splits the page; its inverse joins it again', () => {
    const at = posOf(doc, 'two') - 1;
    const { tr } = apply(doc, new PageBreakStep(at, manual));
    expect(pageTexts(tr.doc)).toEqual([['one'], ['two'], ['three']]);
    expect(tr.doc.child(1).attrs).toMatchObject(manual);
    expect(tr.mapping.map(posOf(doc, 'two'))).toBe(posOf(tr.doc, 'two'));
    const inverse = tr.steps[0]!.invert(doc);
    expect(inverse).toBeInstanceOf(JoinPagesStep);
    expect(apply(tr.doc, inverse).tr.doc.eq(doc)).toBe(true);
  });

  it('inside a paragraph: splits every level; the second part is no continuation', () => {
    const list = DOC(PAGE(null, OL({ start: 1 }, li('one'), li('two three'))));
    const { tr } = apply(list, new PageBreakStep(posOf(list, 'three'), manual));
    const second = tr.doc.child(1).firstChild!;
    expect(second.attrs).toMatchObject({ start: 2, continuation: false });
    expect(second.firstChild!.attrs.continuation).toBe(false);
    expect(pageTexts(tr.doc)).toEqual([['one', 'two '], ['three']]);
    expect(apply(tr.doc, tr.steps[0]!.invert(list)).tr.doc.eq(list)).toBe(true);
  });

  it('at a page boundary (start of a page, end of the page before it, between pages): that page takes the attributes', () => {
    const b = pageAt(doc, 1)!;
    for (const pos of [b.contentStart, b.pos, pageAt(doc, 0)!.contentEnd]) {
      const { tr, failed } = apply(doc, new PageBreakStep(pos, manual));
      expect(failed).toBeNull();
      expect(kinds(tr.doc)).toEqual(['manual:aaaaaaaa', 'manual:newpage1']);
      expect(pageTexts(tr.doc)).toEqual(pageTexts(doc));
      // Its inverse gives the page its old attributes back.
      expect(apply(tr.doc, tr.steps[0]!.invert(doc)).tr.doc.eq(doc)).toBe(true);
    }
  });

  it('fails where no page can start (the very start of the document)', () => {
    expect(apply(doc, new PageBreakStep(1, manual)).failed).not.toBeNull();
  });

  it('round-trips through JSON', () => {
    const step = new PageBreakStep(5, manual);
    expect(Step.fromJSON(schema, step.toJSON())).toBeInstanceOf(PageBreakStep);
    expect(Step.fromJSON(schema, new JoinPagesStep(9, 2).toJSON())).toMatchObject({ pos: 9, depth: 2 });
  });
});

describe('JoinPagesStep', () => {
  it('joins two pages (and, with depth 2, the blocks at the seam); refuses when the seam has content', () => {
    const doc = DOC(PAGE({ pid: 'aaaaaaaa' }, P('head ')), AUTO({ pid: 'bbbbbbbb' }, PC('tail')));
    const b = pageAt(doc, 1)!;
    const pages = apply(doc, new JoinPagesStep(b.pos, 1));
    expect(pageTexts(pages.tr.doc)).toEqual([['head ', 'tail']]);
    const blocks = apply(doc, new JoinPagesStep(b.pos, 2));
    expect(pageTexts(blocks.tr.doc)).toEqual([['head tail']]);
    // Its inverse re-creates the page (with its attributes) at the seam.
    const back = apply(blocks.tr.doc, blocks.tr.steps[0]!.invert(doc)).tr.doc;
    expect(kinds(back)).toEqual(['manual:aaaaaaaa', 'auto:bbbbbbbb']);
    expect(pageTexts(back)).toEqual([['head '], ['tail']]);
    expect(apply(doc, new JoinPagesStep(b.pos + 1, 1)).failed).not.toBeNull();
    expect(apply(doc, new JoinPagesStep(b.pos, 3)).failed).not.toBeNull();
  });

  it('with a pid (the inverse of a PageBreakStep that made that page): joins that page where its boundary is now (PGR-2)', () => {
    // The page "objpage1" was made at "c…"; pagination has since moved its boundary back into "b…".
    const doc = DOC(PAGE({ pid: 'aaaaaaaa' }, P('a'), P('b head ')), AUTO({ pid: 'objpage1' }, PC('b tail'), P('c'), P('d')), AUTO({ pid: 'cccccccc' }, P('e')));
    const inPage = posOf(doc, 'c') - 1; // the old boundary, mapped: now inside objpage1's flow
    const joined = apply(doc, new JoinPagesStep(inPage, 1, 'objpage1'));
    expect(joined.failed).toBeNull();
    expect(kinds(joined.tr.doc)).toEqual(['manual:aaaaaaaa', 'auto:cccccccc']);
    // Its inverse brings that page back at its real boundary.
    const back = apply(joined.tr.doc, joined.tr.steps[0]!.invert(doc)).tr.doc;
    expect(back.eq(doc)).toBe(true);
    // Without the pid, or with another one, it fails as before (no page boundary there).
    expect(apply(doc, new JoinPagesStep(inPage, 1)).failed).not.toBeNull();
    expect(apply(doc, new JoinPagesStep(inPage, 1, 'zzzzzzzz')).failed).not.toBeNull();
    // Before the page with the pid (the pull case: the page after the one holding the position).
    const before = posOf(doc, 'b head') + 2;
    expect(kinds(apply(doc, new JoinPagesStep(before, 1, 'objpage1')).tr.doc)).toEqual(['manual:aaaaaaaa', 'auto:cccccccc']);
    // A PageBreakStep's inverse carries the new page's pid; JSON keeps it.
    const made = apply(DOC(PAGE({ pid: 'aaaaaaaa' }, P('one'), P('two'))), new PageBreakStep(6, { kind: 'auto', pid: 'newpage1' }));
    const inverse = made.tr.steps[0]!.invert(DOC(PAGE({ pid: 'aaaaaaaa' }, P('one'), P('two'))));
    expect(inverse).toMatchObject({ pid: 'newpage1' });
    expect(Step.fromJSON(schema, inverse.toJSON())).toMatchObject({ pid: 'newpage1' });
  });
});

describe('PageBreakStep re-making a page that pagination moved (fold)', () => {
  it('the same-pid auto page right after the break folds into the new page; the inverse restores exactly', () => {
    // An undo re-creating section B before "b…": pagination had pulled "b head" back onto page 0
    // and left the rest on the (now auto) page with B's pid.
    const doc = DOC(PAGE({ pid: 'sectionA' }, P('a'), P('b head ')), AUTO({ pid: 'sectionB', footer: 'B' }, PC('b tail'), P('c')));
    const attrs = { ...doc.child(1).attrs, kind: 'manual' };
    const { tr, failed } = apply(doc, new PageBreakStep(posOf(doc, 'b head') - 1, attrs));
    expect(failed).toBeNull();
    expect(kinds(tr.doc)).toEqual(['manual:sectionA', 'manual:sectionB']);
    expect(pageTexts(tr.doc)).toEqual([['a'], ['b head b tail', 'c']]);
    // Positions after the fold map onto the same text.
    expect(tr.mapping.map(posOf(doc, 'c'))).toBe(posOf(tr.doc, 'c'));
    expect(tr.mapping.map(posOf(doc, 'tail'))).toBe(posOf(tr.doc, 'tail'));
    const back = apply(tr.doc, tr.steps[0]!.invert(doc)).tr.doc;
    expect(back.eq(doc)).toBe(true);
  });

  it('a placeholder page (kept for its markers) loses its empty paragraph in the fold', () => {
    const doc = DOC(PAGE({ pid: 'sectionA' }, P('a'), P('b')), AUTO({ pid: 'sectionB', markers: ['skipCounting'] }, P('')));
    const { tr } = apply(doc, new PageBreakStep(posOf(doc, 'b') - 1, { ...doc.child(1).attrs, kind: 'manual' }));
    expect(pageTexts(tr.doc)).toEqual([['a'], ['b']]);
    expect(kinds(tr.doc)).toEqual(['manual:sectionA', 'manual:sectionB']);
    expect(apply(tr.doc, tr.steps[0]!.invert(doc)).tr.doc.eq(doc)).toBe(true);
  });
});

describe('undo and redo of section commands after pagination moved the pages', () => {
  let m: MountedEditor | undefined;
  afterEach(() => {
    m?.destroy();
    m = undefined;
  });

  /** Section A (page 0) and section B; the break is removed with Backspace, pagination settles. */
  function removeBreak(a: PMNode[], b: PMNode[], markers: string[] = ['skipCounting']): { m: MountedEditor; before: PMNode } {
    m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'sectionA' }, ...a), PAGE({ columns: 1, pid: 'sectionB', footer: 'B', markers }, ...b)), {
      lines: { columns: 1 },
    });
    m.settle();
    const before = m.editor.state.doc;
    m.select(pageAt(before, sectionBIndex(before))!.contentStart + 1);
    m.press('Backspace');
    m.settle();
    return { m, before };
  }
  const sectionBIndex = (doc: PMNode) => {
    let index = -1;
    doc.forEach((page, _o, i) => {
      if (page.attrs.pid === 'sectionB') index = i;
    });
    return index;
  };

  it('the page was merged away (all of B fits after A): undo re-creates it with its settings; redo removes it again', () => {
    const { m, before } = removeBreak([P(words('a', 30))], [P(words('b', 30))], []);
    expect(m.editor.state.doc.childCount).toBe(1);
    m.editor.commands.undo();
    m.settle();
    expect(m.editor.state.doc.toJSON()).toEqual(before.toJSON());
    m.editor.commands.redo();
    m.settle();
    expect(pageTexts(m.editor.state.doc)).toEqual([[words('a', 30), words('b', 30)]]);
  });

  it('a page with markers is not merged away (all of B fits after A): it stays with its marker; undo restores the section start once', () => {
    const { m, before } = removeBreak([P(words('a', 30))], [P(words('b', 30))]);
    // PGR-5: the page keeps its marker (a placeholder with one empty paragraph).
    expect(pageTexts(m.editor.state.doc)).toEqual([[words('a', 30), words('b', 30)], ['']]);
    expect(m.editor.state.doc.child(1).attrs).toMatchObject({ pid: 'sectionB', kind: 'auto', markers: ['skipCounting'] });
    m.editor.commands.undo();
    m.settle();
    expect(m.editor.state.doc.toJSON()).toEqual(before.toJSON());
    m.editor.commands.redo();
    m.settle();
    expect(pageTexts(m.editor.state.doc)).toEqual([[words('a', 30), words('b', 30)], ['']]);
  });

  it('pagination pulled part of B back (the boundary moved into B): undo puts the section start back before B', () => {
    const { m, before } = removeBreak([P(words('a', 50))], [P(words('b', 100))]);
    expect(pageTexts(m.editor.state.doc)[0]).toEqual([words('a', 50), words('b', 100).slice(0, 50)]);
    m.editor.commands.undo();
    m.settle();
    expect(m.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('A is full (B stays on its page as an auto page): undo makes it the section start again', () => {
    const { m, before } = removeBreak([P(words('a', 100))], [P(words('b', 30))]);
    expect(m.editor.state.doc.child(1).attrs.kind).toBe('auto');
    m.editor.commands.undo();
    m.settle();
    expect(m.editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('a page break at a seam: redo after the undo re-joined the paragraph puts the break back at the same text', () => {
    m = mountPaginated(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), P(words('b', 100)))), { lines: { columns: 1 } });
    m.settle();
    m.select(pageAt(m.editor.state.doc, 0)!.contentEnd - 1);
    m.press('Mod-Enter');
    m.settle();
    const broken = canonical(m.editor.state.doc);
    expect(broken.childCount).toBe(2);
    m.editor.commands.undo();
    m.settle();
    expect(canonical(m.editor.state.doc).childCount).toBe(1);
    // Make pagination move the boundary away from the old seam before redoing (a change outside
    // the history, like a collaborator's or a layout change, keeps the redo).
    m.editor.view.dispatch(m.editor.state.tr.insertText('xxxxxxxxxxxxxxxxxxxx', posOf(m.editor.state.doc, 'a0')).setMeta('addToHistory', false));
    m.settle();
    expect(m.editor.commands.redo()).toBe(true);
    m.settle();
    const sections = pageTexts(canonical(m.editor.state.doc));
    expect(sections).toHaveLength(2);
    expect(sections[0]!.at(-1)).toBe(words('b', 100).slice(0, 50));
    expect(sections[1]).toEqual([words('b', 100).slice(50)]);
    expect(pageTexts(broken)[1]).toEqual(sections[1]);
  });
});
