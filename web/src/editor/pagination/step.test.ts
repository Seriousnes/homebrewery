// step.ts (plan §4.6) on a line-model layout (testing.ts): pure ProseMirror, no DOM. The DOM
// rules themselves are covered by the Playwright specs in web/e2e/pagination.
import { history, undo } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';
import { describe, expect, it } from 'vitest';
import { isPlaceholderPage, pageAt } from './boundary';
import { defaultMaxSteps, paginationPlugin } from './plugin';
import { paginationKey } from './state';
import { paginatePage } from './step';
import {
  AUTO,
  BLOCK,
  DOC,
  H,
  LI,
  OL,
  P,
  PAGE,
  canonical,
  li,
  lineCount,
  lineLayout,
  pageTexts,
  posOf,
  schema,
  seamProblems,
  type LineLayoutOptions,
} from './testing';

/** Deterministic text of `n` characters ("a1 a2 a3 …" style words, unique per `tag`). */
function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

interface Harness {
  state: EditorState;
  layout: ReturnType<typeof lineLayout>;
  /** runs steps until settled; returns the actions taken */
  settle(limit?: number): string[];
  apply(tr: Transaction): void;
}

function harness(doc: PMNode, opts: LineLayoutOptions = {}, withHistory = false): Harness {
  const h: Harness = {
    state: EditorState.create({ doc, plugins: [...(withHistory ? [history()] : []), paginationPlugin()] }),
    layout: lineLayout(() => h.state.doc, opts),
    settle(limit = defaultMaxSteps(h.state.doc)) {
      const actions: string[] = [];
      for (;;) {
        const st = paginationKey.getState(h.state)!;
        if (st.dirtyFrom === null) return actions;
        if (actions.length >= limit) throw new Error(`no settle after ${limit} steps: ${actions.slice(-20).join(' ')}`);
        const r = paginatePage(h.state, st, h.layout);
        actions.push(`${r.action}@${r.page}`);
        h.state = h.state.apply(r.tr);
      }
    },
    apply(tr) {
      h.state = h.state.apply(tr);
    },
  };
  return h;
}

/**
 * Every page fits (or is flagged oversized), no page could take content from the next, and the
 * seams are right (seamProblems: fragment attributes, list numbering, stranded headings).
 */
function expectSettledLayout(h: Harness) {
  const doc = h.state.doc;
  expect(seamProblems(doc)).toEqual([]);
  for (let i = 0; i < doc.childCount; i++) {
    const page = pageAt(doc, i)!;
    const m = h.layout.lines(page);
    if (m.overflow) expect(page.node.attrs.oversized, `page ${i} overflows`).toBe(true);
    const next = pageAt(doc, i + 1);
    if (next && !m.overflow) expect(h.layout.pullTarget(page, m, next), `page ${i} could pull`).toBeNull();
  }
}

const linesOf = (page: PMNode, chars = 10) => {
  let n = 0;
  page.forEach((b) => (n += lineCount(b, chars)));
  return n;
};

describe('paginatePage (line model: 2 columns × 10 lines of 10 characters)', () => {
  it('splits an overfull page into auto pages, continuing the paragraph', () => {
    const h = harness(DOC(PAGE({ pid: 'aaaaaaaa', columns: 2, footer: 'F' }, P(words('a', 250)), P(words('b', 100)))));
    const actions = h.settle();
    expect(actions).toEqual(['insert@0', 'settled@0', 'settled@1']);
    const doc = h.state.doc;
    expect(pageTexts(doc)).toEqual([[words('a', 250).slice(0, 200)], [words('a', 250).slice(200), words('b', 100)]]);
    expect(doc.child(1).attrs).toMatchObject({ kind: 'auto', columns: 2, footer: 'F', pid: null });
    expect(doc.child(1).child(0).attrs.continuation).toBe(true);
    expectSettledLayout(h);
  });

  it('pushes through a long section and pulls back after deletions, removing emptied auto pages', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => P(words(`p${i}x`, 50))); // 5 lines each: 100 lines
    const h = harness(DOC(PAGE(null, ...paragraphs)));
    h.settle();
    expect(h.state.doc.childCount).toBe(5);
    expect(Array.from({ length: 5 }, (_, i) => linesOf(h.state.doc.child(i)))).toEqual([20, 20, 20, 20, 20]);
    const before = canonical(h.state.doc);

    // Delete three paragraphs on page 1 and two on page 2 (25 lines): everything after pulls
    // back, and the last page goes.
    const tr = h.state.tr;
    const second = pageAt(h.state.doc, 1)!;
    tr.delete(second.contentStart, second.contentStart + 2 * second.node.child(0).nodeSize);
    const first = pageAt(h.state.doc, 0)!;
    tr.delete(first.contentStart, first.contentStart + 3 * first.node.child(0).nodeSize);
    h.apply(tr);
    const actions = h.settle();
    expect(actions.filter((a) => a.startsWith('pull')).length).toBeGreaterThan(0);
    expect(h.state.doc.childCount).toBe(4);
    expect(Array.from({ length: 4 }, (_, i) => linesOf(h.state.doc.child(i)))).toEqual([20, 20, 20, 15]);
    const deleted = [0, 1, 2, 4, 5].map((i) => words(`p${i}x`, 50));
    expect(canonical(h.state.doc).textContent).toBe(deleted.reduce((text, d) => text.replace(d, ''), before.textContent));
    expectSettledLayout(h);
  });

  it('never moves content across a manual page (section start)', () => {
    const h = harness(DOC(PAGE({ columns: 1 }, P(words('a', 150))), PAGE({ columns: 2, pid: 'bbbbbbbb' }, P(words('b', 30)))));
    h.settle();
    expect(pageTexts(h.state.doc)).toEqual([[words('a', 150).slice(0, 100)], [words('a', 150).slice(100)], [words('b', 30)]]);
    expect(h.state.doc.child(1).attrs).toMatchObject({ kind: 'auto', columns: 1 });
    expect(h.state.doc.child(2).attrs).toMatchObject({ kind: 'manual', pid: 'bbbbbbbb' });
    expectSettledLayout(h); // page 1 has room, but the next page starts a section
  });

  it('keeps a heading with the block after it', () => {
    // One column of 10 lines: 9 lines of text, the heading on line 10, its paragraph outside.
    const h = harness(DOC(PAGE({ columns: 1 }, P(words('a', 90)), H(2, 'Heading'), P(words('b', 50)))));
    h.settle();
    expect(pageTexts(h.state.doc)).toEqual([[words('a', 90)], ['Heading', words('b', 50)]]);
    expectSettledLayout(h);
  });

  it('continues ordered list numbering on the next page', () => {
    const items = Array.from({ length: 14 }, (_, i) => li(`item ${i + 1}`));
    const h = harness(DOC(PAGE({ columns: 1 }, OL({ start: 1 }, ...items))));
    h.settle();
    const second = h.state.doc.child(1).child(0);
    expect(second.type.name).toBe('orderedList');
    expect(second.attrs).toMatchObject({ start: 11, continuation: true });
    expect(second.textContent.startsWith('item 11')).toBe(true);
  });

  it('flags a block taller than a column as oversized and moves what follows', () => {
    const tall = BLOCK(['monster'], ...Array.from({ length: 12 }, (_, i) => P(`row ${i}`)));
    const h = harness(DOC(PAGE({ columns: 1 }, tall, P('after'))));
    h.settle();
    expect(h.state.doc.childCount).toBe(2);
    expect(h.state.doc.child(0).attrs.oversized).toBe(true);
    expect(pageTexts(h.state.doc)[1]).toEqual(['after']);
    // Nothing else can move: the next pass over page 0 changes nothing.
    h.apply(h.state.tr.setMeta('hbRepaginate', 0));
    expect(h.settle()).toEqual(['oversized@0', 'settled@1']);
    // Once the block fits, the flag clears.
    const page = pageAt(h.state.doc, 0)!;
    const block = page.node.child(0);
    let rows = page.contentStart + 1;
    for (let k = 0; k < 3; k++) rows += block.child(k).nodeSize;
    h.apply(h.state.tr.delete(page.contentStart + 1, rows));
    h.settle();
    expect(h.state.doc.child(0).attrs.oversized).toBe(false);
    expectSettledLayout(h);
  });

  it('checks from the page before the edit, not from the start', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => P(words(`p${i}x`, 45))); // 5 lines each
    const h = harness(DOC(PAGE(null, ...paragraphs)));
    h.settle();
    expect(h.state.doc.childCount).toBe(10);
    const measuredBefore = h.layout.measured;
    // Two characters on page 7 (index 6): its paragraph still takes 5 lines.
    h.apply(h.state.tr.insertText('zz', posOf(h.state.doc, 'p24x0')));
    expect(paginationKey.getState(h.state)).toMatchObject({ dirtyFrom: 5, dirtyTo: 6 });
    expect(h.settle()).toEqual(['settled@5', 'settled@6']);
    expect(h.layout.measured - measuredBefore).toBe(2);
  });

  it('undo after pagination restores the text, and pages settle to the same layout as before', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => P(words(`p${i}x`, 45)));
    const h = harness(DOC(PAGE({ pid: 'aaaaaaaa' }, ...paragraphs)), {}, true);
    h.settle();
    const settledBefore = h.state.doc;
    // The author types a long sentence at the end of page 1: its tail moves on, pages shift.
    const at = posOf(h.state.doc, 'p7x0') - 1;
    h.apply(h.state.tr.insertText(words('new', 80), at));
    h.settle();
    expect(h.state.doc.eq(settledBefore)).toBe(false);
    expect(undo(h.state, (tr) => h.apply(tr))).toBe(true);
    h.settle();
    expect(h.state.doc.toJSON()).toEqual(settledBefore.toJSON());
  });
});

// Review findings (line model, 1 column × 10 lines unless noted) -------------------------------

const OBJECTS = [{ id: 'o1', kind: 'image', classes: ['banner'], style: 'position:absolute;top:0', src: 'https://example.com/a.png' }];

/** The fragments of the paragraph whose text starts with `prefix` (head first), with their attributes. */
function fragmentsOf(doc: PMNode, prefix: string): { continuation: boolean; align: unknown; classes: unknown }[] {
  const out: { continuation: boolean; align: unknown; classes: unknown }[] = [];
  let inChain = false;
  doc.forEach((page) =>
    page.forEach((block) => {
      if (block.type.name !== 'paragraph') return;
      if (block.textContent.startsWith(prefix)) inChain = true;
      else if (block.attrs.continuation !== true || page.firstChild !== block) inChain = false;
      if (inChain) out.push({ continuation: block.attrs.continuation === true, align: block.attrs.align, classes: block.attrs.classes });
    }),
  );
  return out;
}

describe('review findings', () => {
  it('PG-4: a block that fits a fresh page leaves its heading behind instead of being flagged oversized', () => {
    const rows = Array.from({ length: 10 }, (_, k) => `row ${k}`); // 10 one-line paragraphs: the block needs a whole column
    const h = harness(DOC(PAGE({ columns: 1 }, H(2, 'Head'), BLOCK(['note'], ...rows.map((r) => P(r))), P('after'))));
    h.settle();
    expect(pageTexts(h.state.doc)).toEqual([['Head'], rows, ['after']]);
    h.state.doc.forEach((page) => expect(page.attrs.oversized).toBe(false));
    expectSettledLayout(h);
  });

  it('PG-4: a block taller than a column stays with its heading (flagged oversized, as before)', () => {
    const rows = Array.from({ length: 12 }, (_, k) => P(`row ${k}`));
    const h = harness(DOC(PAGE({ columns: 1 }, H(2, 'Head'), BLOCK(['monster'], ...rows), P('after'))));
    h.settle();
    expect(pageTexts(h.state.doc)[0]![0]).toBe('Head');
    expect(h.state.doc.child(0).attrs.oversized).toBe(true);
    expect(pageTexts(h.state.doc)[1]).toEqual(['after']);
  });

  it('PG-6: a heading added on the last line of a settled page moves to the next page with its block', () => {
    const h = harness(DOC(PAGE({ columns: 1 }, P(words('a', 90)), BLOCK(['note'], P('r1'), P('r2'), P('r3')))));
    h.settle();
    expect(pageTexts(h.state.doc)).toEqual([[words('a', 90)], ['r1', 'r2', 'r3']]);
    h.apply(h.state.tr.insert(pageAt(h.state.doc, 0)!.contentEnd, H(2, 'Title')));
    h.settle();
    expect(pageTexts(h.state.doc)).toEqual([[words('a', 90)], ['Title', 'r1', 'r2', 'r3']]);
    expectSettledLayout(h);
  });

  it('PG-7: a continued ordered list renumbers when its head gains or loses items and nothing moves', () => {
    // intro (1 line) + 7 one-line items fill 8 lines; the last item (3 or 4 lines) continues.
    const list = (last: number) => OL({ start: 1 }, ...Array.from({ length: 7 }, (_, k) => li(`item ${k + 1}`)), LI(null, P(words('long', last))));
    const starts = (doc: PMNode) => [doc.child(0).lastChild!.attrs.start as number, doc.child(1).firstChild!.attrs.start as number];

    const added = harness(DOC(PAGE({ columns: 1 }, P('intro'), list(30))));
    added.settle();
    expect(starts(added.state.doc)).toEqual([1, 8]);
    const second = posOf(added.state.doc, 'item 2') - 2; // before the second item
    added.apply(added.state.tr.insert(second, li('new')));
    added.settle();
    expect(added.state.doc.child(0).lastChild!.childCount).toBe(8);
    expect(starts(added.state.doc)).toEqual([1, 9]);
    expectSettledLayout(added);

    const removed = harness(DOC(PAGE({ columns: 1 }, P('intro'), list(40))));
    removed.settle();
    expect(starts(removed.state.doc)).toEqual([1, 8]);
    const at = posOf(removed.state.doc, 'item 2') - 2;
    removed.apply(removed.state.tr.delete(at, at + li('item 2').nodeSize));
    removed.settle();
    expect(removed.state.doc.child(0).lastChild!.childCount).toBe(6);
    expect(starts(removed.state.doc)).toEqual([1, 7]);
    expectSettledLayout(removed);
  });

  it('PG-10: after a page kept for its objects takes content, the page before it is checked again', () => {
    const h = harness(
      DOC(
        PAGE({ columns: 1 }, P(words('a', 20))),
        AUTO({ columns: 1, objects: OBJECTS }, P(words('b', 30))),
        AUTO({ columns: 1 }, P(words('c', 40))),
      ),
    );
    h.settle();
    expect(pageTexts(h.state.doc)).toEqual([[words('a', 20), words('b', 30), words('c', 40)], ['']]);
    expect(isPlaceholderPage(h.state.doc.child(1))).toBe(true);
    expectSettledLayout(h);
  });

  it('PG-3: formatting set on a continuation fragment is the whole paragraph\'s, and survives boundary moves', () => {
    const h = harness(DOC(PAGE({ columns: 1 }, P(words('a', 50)), P(words('b', 100)))));
    h.settle();
    expect(fragmentsOf(h.state.doc, 'b0 ').map((f) => f.continuation)).toEqual([false, true]);
    const tail = pageAt(h.state.doc, 1)!;
    h.apply(h.state.tr.setNodeMarkup(tail.contentStart, undefined, { ...tail.node.firstChild!.attrs, align: 'center', classes: ['quote'] }));
    expect(fragmentsOf(h.state.doc, 'b0 ').map((f) => [f.align, f.classes])).toEqual([['center', ['quote']], ['center', ['quote']]]);
    // An unrelated edit moves the boundary: 10 characters fewer at the start of page 1.
    const first = pageAt(h.state.doc, 0)!;
    h.apply(h.state.tr.delete(first.contentStart + 1, first.contentStart + 11));
    h.settle();
    const fragments = fragmentsOf(h.state.doc, 'b0 ');
    expect(fragments.map((f) => f.continuation)).toEqual([false, true]);
    expect(fragments.map((f) => [f.align, f.classes])).toEqual([['center', ['quote']], ['center', ['quote']]]);
    expectSettledLayout(h);
  });

  it('PG-9 / P4.7: deleting a split paragraph\'s head leaves its tail a paragraph of its own (the plugin clears the flag)', () => {
    const h = harness(DOC(PAGE({ columns: 1 }, P(words('a', 50)), P(words('b', 100)))));
    h.settle();
    const head = pageBlocks(h.state.doc).find((b) => b.node.textContent.startsWith('b0 '))!;
    const tailText = h.state.doc.child(1).firstChild!.textContent;
    expect(h.state.doc.child(1).firstChild!.attrs.continuation).toBe(true);
    // A plain node delete, as the editor does it (drag, cut of a node selection, …).
    h.apply(h.state.tr.delete(head.pos, head.pos + head.node.nodeSize));
    expect(h.state.doc.child(1).firstChild!.attrs.continuation).toBe(false);
    // canonical() of the edited document is the truth the settle is compared with: two
    // paragraphs, not the tail merged into "a…" (it would be, with the continuation flag kept).
    const expected = canonical(h.state.doc);
    expect(pageTexts(expected)).toEqual([[words('a', 50), tailText]]);
    h.settle();
    expect(canonical(h.state.doc).toJSON()).toEqual(expected.toJSON());
    expectSettledLayout(h);
  });

  it('P4.7: deleting the head\'s text, or joining it with the block before it, keeps the tail its continuation', () => {
    const start = () => {
      const h = harness(DOC(PAGE({ columns: 1 }, P(words('a', 50)), P(words('b', 100)))));
      h.settle();
      return { h, head: pageBlocks(h.state.doc).find((b) => b.node.textContent.startsWith('b0 '))! };
    };
    // Delete the head's text only: the (empty) head stays, the tail re-joins it.
    const text = start();
    const tail = text.h.state.doc.child(1).firstChild!.textContent;
    text.h.apply(text.h.state.tr.delete(text.head.pos + 1, text.head.pos + text.head.node.nodeSize - 1));
    expect(text.h.state.doc.child(1).firstChild!.attrs.continuation).toBe(true);
    text.h.settle();
    expect(pageTexts(text.h.state.doc).flat()).toEqual([words('a', 50), tail]);
    // Delete from the middle of "a…" to the end of the head (a range selection over the seam's
    // first half): "a…" joins the tail, as in an unsplit paragraph.
    const joined = start();
    const tail2 = joined.h.state.doc.child(1).firstChild!.textContent;
    joined.h.apply(joined.h.state.tr.delete(posOf(joined.h.state.doc, 'a2 '), joined.head.pos + joined.head.node.nodeSize - 1));
    expect(joined.h.state.doc.child(1).firstChild!.attrs.continuation).toBe(true);
    joined.h.settle();
    expect(canonical(joined.h.state.doc).textContent).toBe(`${words('a', 50).slice(0, words('a', 50).indexOf('a2 '))}${tail2}`);
    expect(pageTexts(canonical(joined.h.state.doc))[0]).toHaveLength(1);
  });

  it('P4.7: deleting the head item of a split list item keeps the list continuing, the item becomes its own', () => {
    // A list item split across pages (the DOM cut splits a tall item; the line model doesn't).
    const items = Array.from({ length: 3 }, (_, k) => li(`item ${k + 1}`));
    const h = harness(
      DOC(
        PAGE({ columns: 1 }, P('intro'), OL({ start: 1 }, ...items, LI(null, P('head of four ')))),
        AUTO({ columns: 1 }, OL({ start: 4, continuation: true }, LI({ continuation: true }, P('tail of four', { continuation: true })), li('item 5'))),
      ),
    );
    h.settle();
    expect(canonical(h.state.doc).textContent).toContain('head of four tail of four');
    // Rebuild the split state (the settle re-joined it in one column), then delete the head item.
    const split = harness(
      DOC(
        PAGE({ columns: 1 }, P('intro'), OL({ start: 1 }, ...items, LI(null, P('head of four ')))),
        AUTO({ columns: 1 }, OL({ start: 4, continuation: true }, LI({ continuation: true }, P('tail of four', { continuation: true })), li('item 5'))),
      ),
    );
    const list = pageBlocks(split.state.doc).find((b) => b.node.type.name === 'orderedList')!;
    let itemPos = list.pos + 1;
    for (let k = 0; k < list.node.childCount - 1; k++) itemPos += list.node.child(k).nodeSize;
    split.apply(split.state.tr.delete(itemPos, itemPos + list.node.lastChild!.nodeSize));
    const after = split.state.doc.child(1).firstChild!;
    expect(after.attrs.continuation).toBe(true); // the list still continues
    expect(after.firstChild!.attrs.continuation).toBe(false); // the item is its own now
    expect(after.firstChild!.firstChild!.attrs.continuation).toBe(false);
    split.settle();
    const lists = canonical(split.state.doc).child(0).child(1);
    expect(lists.childCount).toBe(5); // items 1–3, "tail of four" as an item, item 5
    expect(lists.child(3).textContent).toBe('tail of four');
    expectSettledLayout(split);
  });

  it('PG-9: seamProblems sees what canonical() can\'t', () => {
    const good = DOC(PAGE(null, P('head ', { align: 'center' })), AUTO(null, P('tail', { align: 'center', continuation: true })));
    const tailAttrs = DOC(PAGE(null, P('head ', { align: 'center' })), AUTO(null, P('tail', { continuation: true })));
    expect(canonical(tailAttrs).eq(canonical(good))).toBe(true); // canonical keeps the head's attributes
    expect(seamProblems(good)).toEqual([]);
    expect(seamProblems(tailAttrs)).toHaveLength(1);
    const numbering = DOC(PAGE(null, OL({ start: 1 }, li('a'), li('b'))), AUTO(null, OL({ start: 2, continuation: true }, li('c'))));
    expect(seamProblems(numbering)).toEqual(['page 1: ordered list continues at 2, expected 3']);
    const stranded = DOC(PAGE(null, P('text'), H(2, 'Title')), AUTO(null, P('more')));
    expect(seamProblems(stranded)).toEqual(['page 0 ends with a heading, apart from what follows it']);
  });
});

// Fuzz --------------------------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function textblocks(doc: PMNode): { pos: number; node: PMNode }[] {
  const out: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push({ pos, node });
      return false;
    }
    return true;
  });
  return out;
}

/** Block positions at page level: [pos, node, page] for every block. */
function pageBlocks(doc: PMNode): { pos: number; node: PMNode; page: PMNode }[] {
  const out: { pos: number; node: PMNode; page: PMNode }[] = [];
  doc.forEach((page, pagePos) => {
    page.forEach((node, offset) => out.push({ pos: pagePos + 1 + offset, node, page }));
  });
  return out;
}

/**
 * Deletes a page-level block with a plain node delete. When the block continues on the next page,
 * the pagination plugin's appendTransaction makes the fragment there a block of its own (P4.7), so
 * canonical() of the edited document (read after the append) stays a truthful oracle.
 */
function deleteBlock(state: EditorState, at: { pos: number; node: PMNode }): Transaction {
  return state.tr.delete(at.pos, at.pos + at.node.nodeSize);
}

function randomEdit(state: EditorState, rand: () => number, n: number): Transaction | null {
  const pick = <T,>(list: T[]): T | undefined => list[Math.floor(rand() * list.length)];
  const r = rand();
  const tr = state.tr;
  if (r < 0.3) {
    const tb = pick(textblocks(state.doc));
    if (!tb) return null;
    const at = tb.pos + 1 + Math.floor(rand() * (tb.node.content.size + 1));
    return tr.insertText(words(`i${n}x`, 1 + Math.floor(rand() * 120)), at);
  }
  if (r < 0.52) {
    const tb = pick(textblocks(state.doc));
    if (!tb || tb.node.content.size < 2) return null;
    const a = Math.floor(rand() * tb.node.content.size);
    const b = Math.min(tb.node.content.size, a + 1 + Math.floor(rand() * 100));
    return tr.delete(tb.pos + 1 + a, tb.pos + 1 + b);
  }
  if (r < 0.67) {
    const at = pick(pageBlocks(state.doc));
    if (!at) return null;
    const kind = rand();
    const block =
      kind < 0.5
        ? P(words(`n${n}x`, 5 + Math.floor(rand() * 200)))
        : kind < 0.65
          ? H(2, `Heading ${n}`)
          : kind < 0.8
            ? OL(null, ...Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, k) => li(`it${n}.${k}`)))
            : BLOCK(['note'], P(words(`b${n}x`, 10 + Math.floor(rand() * 60))));
    return tr.insert(at.pos, block);
  }
  if (r < 0.78) {
    const at = pick(pageBlocks(state.doc).filter((b) => b.page.childCount > 1));
    return at ? deleteBlock(state, at) : null;
  }
  if (r < 0.88) {
    const tb = pick(textblocks(state.doc).filter((t) => t.node.type.name === 'paragraph' && t.node.content.size > 2));
    if (!tb) return null;
    const $pos = state.doc.resolve(tb.pos);
    if ($pos.depth !== 1) return null; // top-level paragraphs only
    return tr.split(tb.pos + 1 + 1 + Math.floor(rand() * (tb.node.content.size - 1)));
  }
  if (r < 0.93) {
    const blocks = pageBlocks(state.doc);
    const k = Math.floor(rand() * blocks.length);
    const a = blocks[k];
    const b = blocks[k + 1];
    if (!a || !b || a.page !== b.page || a.node.type !== b.node.type || a.node.type.name !== 'paragraph') return null;
    const seam = a.pos + a.node.nodeSize;
    return canJoin(state.doc, seam) ? tr.join(seam) : null;
  }
  // Formatting of any paragraph (list items too), on whichever fragment: the whole block's.
  const tb = pick(textblocks(state.doc).filter((t) => t.node.type.name === 'paragraph'));
  if (!tb) return null;
  const align = pick([null, 'center', 'right']) ?? null;
  if (rand() < 0.5) return tr.setNodeAttribute(tb.pos, 'align', align);
  return tr.setNodeMarkup(tb.pos, undefined, { ...tb.node.attrs, align, classes: rand() < 0.5 ? [] : ['quote'] });
}

// 1,000 fuzzed edits as four short, independent tests (CLAUDE.md "Tests fail fast"): 250 edits each
// (under half a second alone), from the same 20-page document, each with its own seed.
const FUZZ_SEEDS = [20260924, 20260925, 20260926, 20260927];
const FUZZ_EDITS = 250;

describe('fuzz (line model)', () => {
  it.each(FUZZ_SEEDS)(`${FUZZ_EDITS} random edits on a 20-page document (seed %i): always settles, never loses content`, (seed) => {
    const rand = prng(seed);
    const sections = [0, 1, 2].map((s) =>
      PAGE(
        { columns: s === 1 ? 1 : 2, pid: `section${s}` },
        H(1, `Chapter ${s}`),
        ...Array.from({ length: 25 }, (_, i) => (i % 7 === 3 ? OL(null, li(`s${s} item a`), li(`s${s} item b`)) : P(words(`s${s}p${i}x`, 40 + ((i * 37) % 140))))),
      ),
    );
    const h = harness(DOC(...sections), { lines: 12, chars: 12 });
    h.settle();
    expect(h.state.doc.childCount).toBeGreaterThanOrEqual(15);
    let edits = 0;
    let maxSteps = 0;
    for (let n = 0; edits < FUZZ_EDITS; n++) {
      const tr = randomEdit(h.state, rand, n);
      if (!tr || !tr.docChanged) continue;
      h.apply(tr);
      edits += 1;
      const expected = canonical(h.state.doc);
      const actions = h.settle(defaultMaxSteps(h.state.doc));
      maxSteps = Math.max(maxSteps, actions.length);
      if (!canonical(h.state.doc).eq(expected)) {
        expect(pageTexts(canonical(h.state.doc)), `edit ${edits}: pagination changed the content`).toEqual(pageTexts(expected));
        expect(canonical(h.state.doc).toJSON(), `edit ${edits}: pagination changed the structure`).toEqual(expected.toJSON());
      }
      expectSettledLayout(h);
    }
    // Pages never lose their manual starts.
    expect(h.state.doc.child(0).attrs.pid).toBe('section0');
    expect(maxSteps).toBeLessThan(defaultMaxSteps(h.state.doc));
    // Keep the numbers visible in the test output.
    console.info(`[fuzz line model] seed ${seed}: ${FUZZ_EDITS} edits, ${h.state.doc.childCount} pages, max ${maxSteps} steps per settle`);
  });

  it('with the schema', () => {
    // sanity: the builders produce valid documents
    expect(() => DOC(PAGE(null, P('x')), AUTO(null, P('y'))).check()).not.toThrow();
    expect(schema.nodes.page).toBeDefined();
  });
});
