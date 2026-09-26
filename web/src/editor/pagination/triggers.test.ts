// Plan §4.7 triggers (P4.5) and the PG-5 'waiting' state, on the line-model layout (jsdom has no
// layout). Each trigger shows which pages the check starts and ends at. The DOM side (fonts,
// theme and user CSS through EditorCanvas, real image loads, Journal) is in web/e2e/sections.
import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { pageAt } from './boundary';
import { Pagination } from './extension';
import { pendingImages } from './measure';
import { WAITING_RECHECK_MS, type PaginationOptions } from './plugin';
import { PAGINATE, isPaginating, isSettled, paginationKey, type PaginateMeta, type PaginationState } from './state';
import { DOC, H, P, PAGE, lineLayout, pageTexts, type LineLayout, type LineLayoutOptions } from './testing';

function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

interface Mounted {
  editor: Editor;
  layout: () => LineLayout;
  frame(): void;
  settle(max?: number): void;
  st(): PaginationState;
  /** PAGINATE metas dispatched since the last call */
  steps(): PaginateMeta[];
}

let mounted: Editor | undefined;
afterEach(() => {
  mounted?.destroy();
  mounted = undefined;
  vi.useRealTimers();
});

function mount(doc: PMNode, opts: PaginationOptions & { lines?: LineLayoutOptions } = {}): Mounted {
  const frames: (() => void)[] = [];
  const { lines, ...options } = opts;
  let layout: LineLayout | null = null;
  const metas: PaginateMeta[] = [];
  const editor = new Editor({
    extensions: buildEditorExtensions({
      extensions: [
        Pagination.configure({
          layout: (view) => (layout = lineLayout(() => view.state.doc, lines)),
          requestFrame: (callback) => frames.push(callback),
          cancelFrame: () => {},
          ...options,
        }),
      ],
    }),
    content: doc.toJSON() as Record<string, unknown>,
  });
  mounted = editor;
  editor.on('transaction', ({ transaction }) => {
    const meta = transaction.getMeta(PAGINATE) as PaginateMeta | undefined;
    if (meta) metas.push(meta);
  });
  const m: Mounted = {
    editor,
    layout: () => layout!,
    frame() {
      for (const callback of frames.splice(0)) callback();
    },
    settle(max = 1000) {
      for (let n = 0; isPaginating(editor.state); n++) {
        if (n > max) throw new Error('not settled');
        m.frame();
      }
    },
    st: () => paginationKey.getState(editor.state)!,
    steps: () => metas.splice(0),
  };
  return m;
}

/** Pages checked by the metas (the `page` of each step). */
const checked = (metas: PaginateMeta[]) => [...new Set(metas.map((meta) => meta.page).filter((p) => p !== undefined))];

describe('image load (capturing listener on the editor root → that image\'s page)', () => {
  it('re-checks exactly the page of an image a measurement saw unloaded', async () => {
    const image = { type: 'image', attrs: { src: 'https://example.com/a.png' } };
    const json = DOC(PAGE(null, P('zero')), PAGE(null, P('one')), PAGE(null, P('two')), PAGE(null, P('three'))).toJSON() as {
      content: { content: Record<string, unknown>[] }[];
    };
    json.content[2]!.content.push({ type: 'paragraph', content: [image] });
    const m = mount(DOC(PAGE(null, P('x'))));
    m.editor.commands.setContent(json);
    m.settle();
    m.steps();
    const img = m.editor.view.dom.querySelectorAll('.page')[2]!.querySelector('img:not(.ProseMirror-separator)')!;
    expect(img).toBeInstanceOf(HTMLImageElement);
    // Loads of images no measurement waited for are ignored.
    img.dispatchEvent(new Event('load'));
    await Promise.resolve();
    expect(isSettled(m.editor.state)).toBe(true);
    // An image a measurement saw without a size: its load re-checks its page only.
    pendingImages.add(img as HTMLImageElement);
    img.dispatchEvent(new Event('load'));
    await Promise.resolve();
    expect(m.st()).toMatchObject({ dirtyFrom: 2, dirtyTo: 2 });
    m.settle();
    expect(checked(m.steps())).toEqual([2]);
  });
});

describe('pages waiting for an image size (PG-5)', () => {
  it('stay unsettled until a later check measures them; the other pages paginate meanwhile', () => {
    vi.useFakeTimers();
    let sized = false;
    const doc = DOC(PAGE({ pid: 'aaaaaaaa' }, ...Array.from({ length: 12 }, (_, i) => P(words(`p${i}x`, 45)))));
    // Page 1 holds an image without a size until `sized`.
    const m = mount(doc, { lines: { waiting: (page) => page.index === 1 && !sized } });
    m.settle();
    // Page 0 was paginated; page 1 (40 lines) waits and keeps its overflow for now.
    expect(m.editor.state.doc.childCount).toBe(2);
    expect(m.st().waiting).toEqual([1]);
    expect(m.st().dirtyFrom).toBeNull(); // the pass ended …
    expect(isSettled(m.editor.state)).toBe(false); // … but autosave keeps waiting
    expect(isPaginating(m.editor.state)).toBe(false);
    // An edit before page 1 (page indexes stay): still waiting.
    m.editor.commands.insertContentAt(pageAt(m.editor.state.doc, 0)!.contentStart + 1, 'x');
    m.settle();
    expect(m.st().waiting).toEqual([1]);
    // The image gets its size; the recheck timer measures the page.
    sized = true;
    m.steps();
    vi.advanceTimersByTime(WAITING_RECHECK_MS);
    expect(m.st().dirtyFrom).toBe(1);
    m.settle();
    expect(checked(m.steps())[0]).toBe(1);
    expect(m.st().waiting).toEqual([]);
    expect(isSettled(m.editor.state)).toBe(true);
    expect(m.editor.state.doc.childCount).toBe(3);
  });

  it('waiting page indexes follow page inserts before them', () => {
    let sized = false;
    // 1 column of 10 lines: page 0 is the first section, page 1 a second section with the image.
    const doc = DOC(PAGE({ columns: 1 }, P(words('a', 50))), PAGE({ columns: 1, pid: 'bbbbbbbb' }, P(words('b', 50))));
    const m = mount(doc, { lines: { waiting: (page) => page.node.attrs.pid === 'bbbbbbbb' && !sized } });
    m.settle();
    expect(m.st().waiting).toEqual([1]);
    // Page 0 grows past its page: an auto page is inserted before the waiting page.
    m.editor.commands.insertContentAt(pageAt(m.editor.state.doc, 0)!.contentEnd, `<p>${words('c', 90)}</p>`);
    m.settle();
    expect(m.editor.state.doc.childCount).toBe(3);
    expect(m.st().waiting).toEqual([2]);
    sized = true;
    m.editor.view.dispatch(m.editor.state.tr.setMeta('hbRepaginate', 2).setMeta('addToHistory', false));
    m.settle();
    expect(m.st().waiting).toEqual([]);
    expect(isSettled(m.editor.state)).toBe(true);
  });
});

describe('section settings change → re-check from the section\'s first page', () => {
  const threeSections = () =>
    DOC(
      PAGE({ columns: 2, pid: 'sectionA' }, H(1, 'A'), ...Array.from({ length: 7 }, (_, i) => P(words(`a${i}x`, 45)))),
      PAGE({ columns: 2, pid: 'sectionB' }, H(1, 'B'), ...Array.from({ length: 7 }, (_, i) => P(words(`b${i}x`, 45)))),
      PAGE({ columns: 2, pid: 'sectionC' }, H(1, 'C'), ...Array.from({ length: 7 }, (_, i) => P(words(`c${i}x`, 45)))),
    );

  it('reflows only that section, starting at its first page; its auto pages follow the setting', () => {
    const m = mount(threeSections());
    m.settle();
    const pids = () => {
      const out: string[] = [];
      m.editor.state.doc.forEach((page) => out.push(`${page.attrs.kind === 'auto' ? '+' : ''}${String(page.attrs.pid).slice(0, 8)}:${page.attrs.columns}`));
      return out;
    };
    const before = m.editor.state.doc;
    expect(before.childCount).toBe(6); // two pages per section
    const headB = pageAt(before, 2)!;
    expect(headB.node.attrs.pid).toBe('sectionB');
    m.steps();
    // The inspector's call: updateAttributes on the section's auto page goes to its first page.
    m.editor.chain().setTextSelection(pageAt(before, 3)!.contentStart + 1).updateAttributes('page', { columns: 1 }).run();
    expect(m.editor.state.doc.child(2).attrs.columns).toBe(1);
    expect(m.editor.state.doc.child(3).attrs.columns).toBe(1); // synced
    expect(m.st()).toMatchObject({ dirtyFrom: 2, dirtyTo: 3 });
    m.settle();
    const after = m.editor.state.doc;
    // Section B needs twice the pages in one column; A and C are untouched.
    expect(pids().filter((p) => p.includes('sectionB') || p.startsWith('+')).length).toBeGreaterThan(0);
    expect(after.child(0).eq(before.child(0))).toBe(true);
    expect(after.child(1).eq(before.child(1))).toBe(true);
    expect(after.child(after.childCount - 1).eq(before.child(5))).toBe(true);
    expect(after.child(after.childCount - 2).eq(before.child(4))).toBe(true);
    expect(after.childCount).toBe(8);
    for (let i = 2; i < 6; i++) expect(after.child(i).attrs.columns).toBe(1);
    // Only section B's pages were checked.
    const pages = checked(m.steps());
    expect(Math.min(...pages)).toBe(2);
    expect(Math.max(...pages)).toBeLessThanOrEqual(5);
  });

  it('undo of a section setting is one step: the first page and its auto pages go back together', () => {
    const m = mount(threeSections());
    m.settle();
    const before = m.editor.state.doc;
    m.editor.chain().setTextSelection(pageAt(before, 2)!.contentStart + 1).updateAttributes('page', { columns: 1, footer: 'Part B' }).run();
    m.settle();
    expect(m.editor.state.doc.childCount).toBe(8);
    for (let i = 2; i < 6; i++) expect(m.editor.state.doc.child(i).attrs).toMatchObject({ columns: 1, footer: 'Part B' });
    expect(m.editor.commands.undo()).toBe(true);
    m.settle();
    const doc = m.editor.state.doc;
    expect(doc.childCount).toBe(6);
    for (let i = 0; i < 6; i++) expect(doc.child(i).attrs).toMatchObject({ columns: 2, footer: null });
    expect(pageTexts(doc)).toEqual(pageTexts(before));
    expect(m.editor.commands.redo()).toBe(true);
    m.settle();
    expect(m.editor.state.doc.childCount).toBe(8);
    for (let i = 2; i < 6; i++) expect(m.editor.state.doc.child(i).attrs).toMatchObject({ columns: 1, footer: 'Part B' });
  });
});

describe('page added or removed with odd/even-styled pages → continue to the last page', () => {
  // Paragraphs of 2 lines; 1 column; odd pages hold 10 lines, even pages 8 (evenLines).
  const short = (tag: string, n: number) => Array.from({ length: n }, (_, i) => P(words(`${tag}${i}x`, 20)));
  // Section A (5 paragraphs, 1 page) and section B (25 paragraphs, 50 lines: 6 pages).
  const twoSections = () =>
    DOC(PAGE({ columns: 1, pid: 'sectionA' }, ...short('a', 5)), PAGE({ columns: 1, pid: 'sectionB' }, ...short('b', 25)));
  const opts = (parity: boolean | 'auto') => ({ lines: { lines: 10, evenLines: 8 }, parity });

  /** Section A gets a second page: every page of section B changes parity. */
  function growA(m: Mounted) {
    m.steps();
    m.editor.commands.insertContentAt(pageAt(m.editor.state.doc, 0)!.contentEnd, `<p>${words('grow', 20)}</p>`);
    m.settle();
  }

  it('continues to the last page when parity matters (the layout says so)', () => {
    const m = mount(twoSections(), opts('auto'));
    m.settle();
    expect(m.editor.state.doc.childCount).toBe(1 + 6);
    growA(m);
    // A overflowed into a new auto page; nothing in section B changed, but its pages swapped
    // odd for even, so each was checked again (to the last page) and re-laid out.
    const doc = m.editor.state.doc;
    expect(doc.child(1).attrs.kind).toBe('auto');
    const pages = checked(m.steps());
    expect(pages).toContain(doc.childCount - 1);
    const b = sectionTexts(doc, 'sectionB');
    mounted?.destroy();
    // The same section B, after a 2-page section: the layout a fresh settle gives.
    const fresh = mount(
      DOC(PAGE({ columns: 1, pid: 'sectionA' }, ...short('a', 6)), PAGE({ columns: 1, pid: 'sectionB' }, ...short('b', 25))),
      opts('auto'),
    );
    fresh.settle();
    expect(b).toEqual(sectionTexts(fresh.editor.state.doc, 'sectionB'));
  });

  it('stops after the changed pages when parity doesn\'t matter (parity: false)', () => {
    const m = mount(twoSections(), opts(false));
    m.settle();
    growA(m);
    // Section B isn't checked: its pages (now of the wrong parity) keep their old boundaries.
    const pages = checked(m.steps());
    expect(Math.max(...pages)).toBeLessThan(2);
  });

  it('a page added by the author (a page break) re-checks every later page too', () => {
    const m = mount(twoSections(), opts(true));
    m.settle();
    m.steps();
    const page0 = pageAt(m.editor.state.doc, 0)!;
    const cut = page0.contentStart + page0.node.child(0).nodeSize;
    m.editor.view.dispatch(m.editor.state.tr.split(cut, 1, [{ type: page0.node.type, attrs: { columns: 1, kind: 'manual' } }]));
    expect(m.st().parity).toBe(true);
    m.settle();
    expect(checked(m.steps())).toContain(m.editor.state.doc.childCount - 1);
  });

  it('a change that adds no page stops right after the changed page', () => {
    const m = mount(twoSections(), opts(true));
    m.settle();
    m.steps();
    const at = pageAt(m.editor.state.doc, 0)!.contentStart + 2;
    m.editor.view.dispatch(m.editor.state.tr.delete(at, at + 1)); // one character: no page moves
    m.settle();
    expect(checked(m.steps())).toEqual([0]);
  });
});

/** Texts of the pages of the section whose first page has pid `pid`. */
function sectionTexts(doc: PMNode, pid: string): string[][] {
  const texts = pageTexts(doc);
  const out: string[][] = [];
  let inside = false;
  doc.forEach((page, _offset, i) => {
    if (page.attrs.kind !== 'auto') inside = page.attrs.pid === pid;
    if (inside) out.push(texts[i]!);
  });
  return out;
}

describe('pages in view settle before paint (frame budget)', () => {
  /** 60 paragraphs of 5 lines (2 columns of 10 lines): 15 pages; each step costs 5 ms, budget 8 ms. */
  function slow(visible: (index: number) => boolean) {
    const clock = { t: 0 };
    const m = mount(DOC(PAGE({ pid: 'aaaaaaaa' }, ...Array.from({ length: 60 }, (_, i) => P(words(`p${i}x`, 45))))), {
      budgetMs: 8,
      now: () => clock.t,
      lines: { visible },
    });
    const layout = () => m.layout();
    // Every measurement costs 5 ms of the fake clock.
    const measure = layout().measure.bind(layout());
    layout().measure = (page) => {
      clock.t += 5;
      return measure(page);
    };
    return m;
  }

  it('a frame goes past its budget while the next page to check is on screen, then stops', () => {
    const m = slow((index) => index <= 3);
    m.frame();
    // Pages 0–3 are on screen: the first frame settles them (and the pages they push into).
    const first = new Set(m.steps().map((meta) => meta.page));
    expect([0, 1, 2, 3].every((p) => first.has(p))).toBe(true);
    expect(isPaginating(m.editor.state)).toBe(true); // offscreen pages wait for later frames
    m.settle();
    expect(m.editor.state.doc.childCount).toBe(15);
  });

  it('offscreen pages keep to the budget', () => {
    const m = slow(() => false);
    m.frame();
    expect(m.steps().length).toBeLessThanOrEqual(2); // 5 ms each: the budget allows two
  });
});
