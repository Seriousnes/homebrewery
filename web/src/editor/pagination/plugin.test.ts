// plugin.ts (plan §4.7, P4.4): plugin state, dirty range, frame budget, IME guard, ready gate,
// loop guard, isSettled. jsdom has no layout, so the layout is the line model (testing.ts),
// frames and the clock are fakes. The real layout runs in web/e2e/pagination.
import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { canJoin, StepMap } from '@tiptap/pm/transform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { LAYOUT_NEUTRAL_META } from '../schema/plugins';
import { insertAutoPageAt, pageAt } from './boundary';
import { Pagination } from './extension';
import { changedPages, paginationPlugin, repaginate, settleNow, type PaginationOptions } from './plugin';
import { PAGINATE, REPAGINATE, isSettled, paginateSteps, paginationKey, type PaginateMeta, type PaginationState } from './state';
import type { LayoutMeasure, PageLayout } from './step';
import { AUTO, DOC, H, P, PAGE, lineLayout, pageTexts, posOf, type LineMeasure } from './testing';

function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

/** Document JSON with the pids of auto pages removed (page identity isn't layout). */
function withoutAutoPids(doc: PMNode): unknown {
  const json = doc.toJSON() as { content: { attrs: Record<string, unknown> }[] };
  for (const page of json.content) if (page.attrs.kind === 'auto') delete page.attrs.pid;
  return json;
}

/** 60 paragraphs of 5 lines: 15 pages of 2 × 10 lines in the line model. */
const longDoc = () => DOC(PAGE({ pid: 'aaaaaaaa' }, ...Array.from({ length: 60 }, (_, i) => P(words(`p${i}x`, 45)))));

interface Mounted {
  editor: Editor;
  frames: (() => void)[];
  /** runs the callbacks of one animation frame */
  frame(): void;
  /** runs frames until settled; returns how many */
  frameUntilSettled(max?: number): number;
  clock: { t: number };
  st(): PaginationState;
  metas: Transaction[];
}

let mounted: Editor | undefined;
afterEach(() => {
  mounted?.destroy();
  mounted = undefined;
  vi.useRealTimers();
});

function mount(doc: PMNode, opts: PaginationOptions & { stepCostMs?: number } = {}): Mounted {
  const frames: (() => void)[] = [];
  const clock = { t: 0 };
  const metas: Transaction[] = [];
  const { stepCostMs = 0, ...options } = opts;
  const editor = new Editor({
    extensions: buildEditorExtensions({
      extensions: [
        Pagination.configure({
          layout: (view) => {
            const line = lineLayout(() => view.state.doc);
            return {
              measure: (page) => {
                clock.t += stepCostMs;
                return line.measure(page);
              },
              chooseCut: (page, measured) => line.chooseCut(page, measured as LineMeasure),
              pullTarget: (page, measured, next) => line.pullTarget(page, measured as LineMeasure, next),
            };
          },
          requestFrame: (callback) => frames.push(callback),
          cancelFrame: () => {},
          now: () => clock.t,
          ...options,
        }),
      ],
    }),
    content: doc.toJSON() as Record<string, unknown>,
  });
  mounted = editor;
  editor.on('transaction', ({ transaction }) => {
    if (transaction.getMeta(PAGINATE)) metas.push(transaction);
  });
  const m: Mounted = {
    editor,
    frames,
    frame() {
      const callbacks = frames.splice(0);
      for (const callback of callbacks) callback();
    },
    frameUntilSettled(max = 1000) {
      let n = 0;
      while (!isSettled(editor.state)) {
        if (++n > max) throw new Error('not settled');
        m.frame();
      }
      return n;
    },
    clock,
    st: () => paginationKey.getState(editor.state)!,
    metas,
  };
  return m;
}

describe('changedPages', () => {
  const doc = DOC(PAGE(null, P('zero')), AUTO(null, P('one')), AUTO(null, P('two'), P('more')), PAGE(null, P('three')));
  const state = () => EditorState.create({ doc });

  it('reports the pages a transaction touched, in the new document', () => {
    const s = state();
    expect(changedPages(s.tr.insertText('x', posOf(doc, 'two')))).toEqual([2, 2]);
    expect(changedPages(s.tr.delete(posOf(doc, 'ne'), posOf(doc, 'wo')))).toEqual([1, 1]); // pages 1–2 joined
    const marks = s.tr.addMark(posOf(doc, 'one'), posOf(doc, 'one') + 3, s.schema.marks.bold!.create());
    expect(changedPages(marks)).toEqual([1, 1]); // mark steps don't map positions
    expect(changedPages(s.tr.setNodeAttribute(pageAt(doc, 3)!.pos, 'columns', 1))).toEqual([3, 3]);
    const both = s.tr.insertText('a', posOf(doc, 'zero')).insertText('b', posOf(doc, 'three') + 1);
    expect(changedPages(both)).toEqual([0, 3]);
  });
});

describe('plugin state', () => {
  const doc = DOC(PAGE(null, P('zero')), AUTO(null, P('one')), AUTO(null, P('two')), AUTO(null, P('three')));
  const create = () => EditorState.create({ doc, plugins: [paginationPlugin()] });
  const settled = (s: EditorState) =>
    s.apply(s.tr.setMeta(PAGINATE, { dirtyFrom: null, dirtyTo: 3, action: 'settled' }).setMeta('addToHistory', false));

  it('starts dirty over the whole document (verifies the stored layout on load)', () => {
    expect(paginationKey.getState(create())).toMatchObject({ dirtyFrom: 0, dirtyTo: 3, blocked: false });
    expect(isSettled(create())).toBe(false);
  });

  it('marks the page before the first changed page, up to the last changed page', () => {
    const s = settled(create());
    expect(isSettled(s)).toBe(true);
    const typed = s.apply(s.tr.insertText('x', posOf(doc, 'two')));
    expect(paginationKey.getState(typed)).toMatchObject({ dirtyFrom: 1, dirtyTo: 2 });
    // A second change widens the range.
    const more = typed.apply(typed.tr.insertText('y', posOf(typed.doc, 'three')));
    expect(paginationKey.getState(more)).toMatchObject({ dirtyFrom: 1, dirtyTo: 3 });
    const first = settled(s).apply(s.tr.insertText('x', posOf(doc, 'zero')));
    expect(paginationKey.getState(first)).toMatchObject({ dirtyFrom: 0, dirtyTo: 0 });
  });

  it('ignores selection changes and layout-neutral transactions (heading ids, page ids)', () => {
    const s = settled(create());
    expect(paginationKey.getState(s.apply(s.tr.setSelection(s.selection)))!.dirtyFrom).toBeNull();
    const neutral = s.tr.setNodeAttribute(pageAt(doc, 2)!.pos, 'pid', 'zzzzzzzz').setMeta(LAYOUT_NEUTRAL_META, true);
    expect(paginationKey.getState(s.apply(neutral))!.dirtyFrom).toBeNull();
  });

  it('REPAGINATE forces a check from a page (to the end, or to a given page)', () => {
    const s = settled(create());
    expect(paginationKey.getState(s.apply(s.tr.setMeta(REPAGINATE, 2)))).toMatchObject({ dirtyFrom: 2, dirtyTo: 3 });
    expect(paginationKey.getState(s.apply(s.tr.setMeta(REPAGINATE, { from: 1, to: 1 })))).toMatchObject({ dirtyFrom: 1, dirtyTo: 1 });
    expect(paginationKey.getState(s.apply(s.tr.setMeta(REPAGINATE, 99)))).toMatchObject({ dirtyFrom: 3, dirtyTo: 3 });
  });

  it('isSettled is true without the plugin', () => {
    expect(isSettled(EditorState.create({ doc }))).toBe(true);
  });
});

describe('scheduler', () => {
  it('settles in animation frames within the frame budget, outside the undo history', () => {
    const m = mount(longDoc(), { budgetMs: 8, stepCostMs: 3 });
    expect(m.frames).toHaveLength(1); // scheduled on mount
    m.frame();
    // 3 ms per page: steps start at 0, 3 and 6 ms; the one at 9 ms waits for the next frame.
    expect(m.st().stats.steps).toBe(3);
    expect(isSettled(m.editor.state)).toBe(false);
    expect(m.frames).toHaveLength(1);
    const frames = m.frameUntilSettled();
    expect(frames).toBeGreaterThan(3);
    expect(m.editor.state.doc.childCount).toBe(15);
    expect(m.metas.every((tr) => tr.getMeta('addToHistory') === false)).toBe(true);
    expect(m.st().stats).toMatchObject({ settles: 1, guardHits: 0, errors: 0 });
    expect(m.frames).toHaveLength(0); // nothing scheduled once settled
  });

  it('goes on between frames (tasks) while the pages it checks are offscreen, a budget at a time (P8.1)', () => {
    const tasks: (() => void)[] = [];
    const m = mount(longDoc(), { budgetMs: 8, stepCostMs: 3, requestTask: (callback) => tasks.push(callback) });
    m.frame();
    expect(m.st().stats.steps).toBe(3);
    // Out of budget with offscreen pages left (the line layout has no isVisible): a frame and a task.
    expect(m.frames).toHaveLength(1);
    expect(tasks).toHaveLength(1);
    tasks.shift()!();
    expect(m.st().stats.steps).toBe(6); // one more budget's worth
    expect(tasks).toHaveLength(1); // and the next task
    let n = 0;
    while (!isSettled(m.editor.state) && tasks.length > 0 && n++ < 1000) tasks.shift()!();
    expect(isSettled(m.editor.state)).toBe(true); // no frame needed
    expect(m.editor.state.doc.childCount).toBe(15);
    expect(tasks).toHaveLength(0);
  });

  it('leaves pages in view to the frames (no task for them)', () => {
    const tasks: (() => void)[] = [];
    const m = mount(longDoc(), {
      budgetMs: 8,
      stepCostMs: 3,
      requestTask: (callback) => tasks.push(callback),
      layout: (view) => {
        const line = lineLayout(() => view.state.doc);
        return {
          measure: (page) => {
            m.clock.t += 3;
            return line.measure(page);
          },
          chooseCut: (page, measured) => line.chooseCut(page, measured as LineMeasure),
          pullTarget: (page, measured, next) => line.pullTarget(page, measured as LineMeasure, next),
          isVisible: () => true,
        };
      },
    });
    // Visible pages run a few steps past the budget, then wait for the next frame, not a task.
    m.frameUntilSettled();
    expect(tasks).toHaveLength(0);
  });

  it('settles right away when the budget allows (the typed page settles in the keystroke frame)', () => {
    const m = mount(longDoc(), { budgetMs: 8 });
    m.frame();
    expect(isSettled(m.editor.state)).toBe(true);
    // Type on page 3: the next frame settles it.
    m.editor.commands.insertContentAt(posOf(m.editor.state.doc, 'p10x0'), words('typed', 30));
    expect(isSettled(m.editor.state)).toBe(false);
    expect(m.frames).toHaveLength(1);
    m.frame();
    expect(isSettled(m.editor.state)).toBe(true);
  });

  it('never ends a frame between a pull and the measurement that follows it', () => {
    // 20 ms per page: every frame is over budget after its first step.
    const m = mount(longDoc(), { budgetMs: 8, stepCostMs: 20 });
    m.frameUntilSettled();
    // Delete two paragraphs on page 1: page 1 pulls from page 2.
    const page = pageAt(m.editor.state.doc, 0)!;
    const second = page.contentStart + page.node.child(0).nodeSize;
    m.editor.view.dispatch(m.editor.state.tr.delete(page.contentStart, second + page.node.child(1).nodeSize));
    const actions: string[] = [];
    const frames: string[][] = [];
    m.editor.on('transaction', ({ transaction }) => {
      const meta = transaction.getMeta(PAGINATE) as { action: string } | undefined;
      if (meta) actions.push(meta.action);
    });
    while (!isSettled(m.editor.state)) {
      actions.length = 0;
      m.frame();
      frames.push([...actions]);
    }
    expect(frames.flat()).toContain('pull');
    // A frame may end after a push or a settled page, never after a pull.
    for (const frame of frames) expect(frame[frame.length - 1]).not.toBe('pull');
  });

  it('does not paginate during IME composition', () => {
    const m = mount(longDoc());
    m.frameUntilSettled();
    const steps = m.st().stats.steps;
    const dom = m.editor.view.dom;
    dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(m.editor.view.composing).toBe(true);
    // Content arriving during the composition makes page 1 overflow.
    m.editor.view.dispatch(m.editor.state.tr.insertText(words('ime', 60), posOf(m.editor.state.doc, 'p2x0')));
    for (let k = 0; k < 5; k++) m.frame();
    expect(m.st().stats.steps).toBe(steps);
    expect(isSettled(m.editor.state)).toBe(false);
    expect(m.frames).toHaveLength(1); // still watching
    dom.dispatchEvent(new CompositionEvent('compositionend', { data: 'x' }));
    expect(m.editor.view.composing).toBe(false);
    m.frameUntilSettled();
    expect(m.st().stats.steps).toBeGreaterThan(steps);
  });

  it('waits for isReady (fonts, theme)', () => {
    let ready = false;
    const m = mount(longDoc(), { isReady: () => ready });
    for (let k = 0; k < 3; k++) m.frame();
    expect(m.st().stats.steps).toBe(0);
    expect(m.editor.state.doc.childCount).toBe(1);
    ready = true;
    m.frameUntilSettled();
    expect(m.editor.state.doc.childCount).toBe(15);
  });

  it('stops a settle that exceeds the step limit (loop guard) and reports it', () => {
    const errors: unknown[] = [];
    // A broken layout: always "room for more", pulling nothing real (join + split in place).
    const broken = (): PageLayout<LayoutMeasure> => ({
      measure: () => ({ overflow: false }),
      chooseCut: () => ({ pos: null, oversized: false, rule: 'none' }),
      pullTarget: (_page, _m, next) => next.contentStart,
    });
    const m = mount(DOC(PAGE(null, P('a')), AUTO(null, P('b'))), {
      layout: broken,
      maxStepsPerSettle: 50,
      logger: { error: (...args: unknown[]) => errors.push(args), warn: () => {} },
    });
    m.frameUntilSettled();
    expect(m.st().stats).toMatchObject({ guardHits: 1, settleSteps: 0 });
    expect(m.st().stats.lastSettleSteps).toBe(50);
    expect(String((errors[0] as unknown[])[0])).toMatch(/loop guard/);
    expect(pageTexts(m.editor.state.doc)).toEqual([['a'], ['b']]); // nothing lost
  });

  it('reports a failing step and stops until the next change', () => {
    const errors: unknown[] = [];
    let fail = true;
    const m = mount(longDoc(), {
      layout: (view) => {
        const line = lineLayout(() => view.state.doc);
        return {
          ...line,
          measure: (page) => {
            if (fail) throw new Error('boom');
            return line.measure(page);
          },
        };
      },
      logger: { error: (...args: unknown[]) => errors.push(args), warn: () => {} },
    });
    m.frame();
    expect(m.st().stats.errors).toBe(1);
    expect(isSettled(m.editor.state)).toBe(true);
    expect(errors).toHaveLength(1);
    fail = false;
    repaginate(m.editor.view);
    m.frameUntilSettled();
    expect(m.editor.state.doc.childCount).toBe(15);
  });

  it('treats unmeasurable pages as settled and retries later', () => {
    vi.useFakeTimers();
    let visible = false;
    const m = mount(longDoc(), {
      layout: (view) => {
        const line = lineLayout(() => view.state.doc);
        return { ...line, measure: (page) => (visible ? line.measure(page) : null) };
      },
    });
    m.frame();
    expect(m.st().blocked).toBe(true);
    expect(isSettled(m.editor.state)).toBe(true);
    visible = true;
    vi.advanceTimersByTime(300);
    m.frameUntilSettled();
    expect(m.st().blocked).toBe(false);
    expect(m.editor.state.doc.childCount).toBe(15);
  });

  it('settleNow settles synchronously, ignoring the budget and the ready gate', () => {
    const m = mount(longDoc(), { isReady: () => false, budgetMs: 0 });
    expect(settleNow(m.editor.view)).toBe(true);
    expect(isSettled(m.editor.state)).toBe(true);
    expect(m.editor.state.doc.childCount).toBe(15);
  });

  it('calls onSettle with the step count', () => {
    const settles: { steps: number }[] = [];
    const m = mount(longDoc(), { onSettle: (info) => settles.push(info) });
    m.frameUntilSettled();
    expect(settles).toHaveLength(1);
    expect(settles[0]!.steps).toBe(m.st().stats.lastSettleSteps);
    expect(settles[0]!.steps).toBeGreaterThanOrEqual(15);
  });

  it('undo restores the text after pagination moved it (pagination is not in the history)', () => {
    const m = mount(DOC(PAGE({ pid: 'aaaaaaaa' }, H(1, 'Title'), ...Array.from({ length: 7 }, (_, i) => P(words(`p${i}x`, 45))))));
    m.frameUntilSettled();
    const before = m.editor.state.doc;
    m.editor.commands.insertContentAt(posOf(before, 'p3x0'), words('typed', 90));
    m.frameUntilSettled();
    expect(before.childCount).toBe(2);
    expect(m.editor.state.doc.childCount).toBe(3); // the typed text pushed a line onto a new page
    m.editor.commands.undo();
    m.frameUntilSettled();
    // Same layout as before the edit. Auto pages may have new pids: undo deletes the typed text
    // across the page boundary, which removes that page; a page made during the edit replaces it.
    expect(withoutAutoPids(m.editor.state.doc)).toEqual(withoutAutoPids(before));
    m.editor.commands.redo();
    m.frameUntilSettled();
    expect(m.editor.state.doc.textContent).toContain('typed0');
  });
});

// Review findings -------------------------------------------------------------------------------

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

/** changedPages as it was before PG-11 (each step mapped through every later step): the reference. */
function changedPagesReference(tr: Transaction): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const add = (from: number, to: number) => {
    min = Math.min(min, from);
    max = Math.max(max, to);
  };
  tr.steps.forEach((step, i) => {
    const rest = tr.mapping.slice(i + 1);
    let mapped = false;
    step.getMap().forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      mapped = true;
      add(rest.map(newFrom, -1), rest.map(newTo, 1));
    });
    if (mapped) return;
    const s = step as unknown as { from?: unknown; to?: unknown; pos?: unknown };
    if (typeof s.from === 'number' && typeof s.to === 'number') add(rest.map(s.from, 1), rest.map(s.to, -1));
    else if (typeof s.pos === 'number') add(rest.map(s.pos, 1), rest.map(s.pos, 1));
    else add(0, tr.doc.content.size);
  });
  if (min === Infinity) return [0, 0];
  const size = tr.doc.content.size;
  const index = (pos: number) => Math.min(tr.doc.resolve(Math.max(0, Math.min(pos, size))).index(0), tr.doc.childCount - 1);
  return [index(min), index(max)];
}

function textblockPositions(doc: PMNode): { pos: number; node: PMNode }[] {
  const out: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) out.push({ pos, node });
    return !node.isTextblock;
  });
  return out;
}

describe('changedPages is linear (PG-11)', () => {
  it('matches the step-by-step reference on random multi-step transactions', () => {
    const rand = prng(20260925);
    const base = DOC(
      PAGE(null, P('zero one'), P('two')),
      AUTO(null, P('three four')),
      AUTO(null, P('five'), P('six seven eight')),
      PAGE(null, P('nine')),
      AUTO(null, P('ten eleven')),
    );
    const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)]!;
    for (let t = 0; t < 500; t++) {
      const tr = EditorState.create({ doc: base }).tr;
      const steps = 1 + Math.floor(rand() * 10);
      for (let k = 0; k < steps; k++) {
        const tb = pick(textblockPositions(tr.doc));
        const at = tb.pos + 1 + Math.floor(rand() * (tb.node.content.size + 1));
        const r = rand();
        if (r < 0.3) tr.insertText('xyz'.slice(0, 1 + Math.floor(rand() * 3)), at);
        else if (r < 0.45 && tb.node.content.size > 1) tr.delete(tb.pos + 1, tb.pos + 1 + 1 + Math.floor(rand() * (tb.node.content.size - 1)));
        else if (r < 0.55 && tb.node.content.size > 0) tr.addMark(tb.pos + 1, tb.pos + 1 + tb.node.content.size, tr.doc.type.schema.marks.bold!.create());
        else if (r < 0.65) tr.setNodeAttribute(tb.pos, 'align', 'center');
        else if (r < 0.75) tr.setNodeAttribute(pageAt(tr.doc, Math.floor(rand() * tr.doc.childCount))!.pos, 'columns', 1);
        else if (r < 0.85 && at > tb.pos + 1 && at < tb.pos + 1 + tb.node.content.size) tr.split(at, 2);
        else if (tr.doc.childCount > 1) {
          const page = pageAt(tr.doc, 1 + Math.floor(rand() * (tr.doc.childCount - 1)))!;
          if (canJoin(tr.doc, page.pos)) tr.join(page.pos);
        }
      }
      expect(changedPages(tr), `transaction ${t} (${tr.steps.map((s) => s.constructor.name).join(' ')})`).toEqual(changedPagesReference(tr));
    }
  });

  it('does linear work: a replace-all of 5,000 matches in one transaction', () => {
    const pages = Array.from({ length: 40 }, (_, i) =>
      (i === 0 ? PAGE : AUTO)(null, ...Array.from({ length: 5 }, () => P('foo bar '.repeat(25).trim()))),
    );
    const doc = DOC(...pages);
    const tr = EditorState.create({ doc }).tr;
    doc.descendants((node, pos) => {
      if (!node.isText) return;
      for (let at = node.text!.indexOf('foo'); at >= 0; at = node.text!.indexOf('foo', at + 1)) {
        const from = tr.mapping.map(pos + at);
        tr.insertText('bazz', from, from + 3);
      }
    });
    expect(tr.steps.length).toBe(5000);
    // The work is position mapping: count it (a clock would measure the machine). Linear = a
    // bounded number of step-map calls per step; mapping through the rest of the transaction
    // per step (the quadratic way) makes ~12.5 million.
    const calls = (['map', 'mapResult', 'forEach'] as const).map((method) => vi.spyOn(StepMap.prototype, method));
    try {
      expect(changedPages(tr)).toEqual([0, 39]);
      const total = calls.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(5 * tr.steps.length);
    } finally {
      calls.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('REPAGINATE payloads are validated (PG-13)', () => {
  const doc = DOC(PAGE(null, P('zero')), AUTO(null, P('one')), AUTO(null, P('two')), AUTO(null, P('three')));

  it('floors fractions, clamps, and ignores anything else without throwing', () => {
    const warnings: unknown[] = [];
    let s = EditorState.create({ doc, plugins: [paginationPlugin({ logger: { error: () => {}, warn: (...args: unknown[]) => warnings.push(args) } })] });
    s = s.apply(s.tr.setMeta(PAGINATE, { dirtyFrom: null, dirtyTo: 3, action: 'settled' }).setMeta('addToHistory', false));
    const after = (meta: unknown) => paginationKey.getState(s.apply(s.tr.setMeta(REPAGINATE, meta)))!;
    expect(after(1.5)).toMatchObject({ dirtyFrom: 1, dirtyTo: 3 });
    expect(after({ from: 1.7, to: 2.2 })).toMatchObject({ dirtyFrom: 1, dirtyTo: 2 });
    expect(after(-4)).toMatchObject({ dirtyFrom: 0, dirtyTo: 3 });
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, 'x', { to: 2 }, { from: 'x' }, { from: 1, to: Number.NaN }, [1]]) {
      expect(() => after(bad), JSON.stringify(bad)).not.toThrow();
      expect(after(bad).dirtyFrom, JSON.stringify(bad)).toBeNull();
    }
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('repaginate() floors and clamps its arguments', () => {
    const quiet: PageLayout<LayoutMeasure> = { measure: () => ({ overflow: false }), chooseCut: () => ({ pos: null, oversized: false, rule: 'none' }), pullTarget: () => null };
    const m = mount(DOC(PAGE({ pid: 'aaaaaaaa' }, P('a')), AUTO(null, P('b')), AUTO(null, P('c'))), { layout: () => quiet });
    m.frameUntilSettled();
    repaginate(m.editor.view, 1.9, 1.2);
    expect(m.st()).toMatchObject({ dirtyFrom: 1, dirtyTo: 1 });
    m.frameUntilSettled();
    repaginate(m.editor.view, -3);
    expect(m.st()).toMatchObject({ dirtyFrom: 0, dirtyTo: 2 });
  });
});

describe('unmeasurable pages (PG-14)', () => {
  it('skips a page that cannot be measured while the editor is visible; later pages still paginate', () => {
    const m = mount(DOC(PAGE({ pid: 'aaaaaaaa' }, P('a')), PAGE({ pid: 'hidden01' }, P('b')), PAGE({ pid: 'cccccccc' }, P(words('c', 900)))), {
      layout: (view) => {
        const line = lineLayout(() => view.state.doc);
        return { ...line, measure: (page) => (page.node.attrs.pid === 'hidden01' ? null : line.measure(page)), isHidden: () => false };
      },
    });
    m.frameUntilSettled();
    expect(m.st().blocked).toBe(false);
    expect(m.editor.state.doc.childCount).toBe(7); // 900 characters: 90 lines, 5 pages of 2 × 10
    expect(m.metas.filter((tr) => (tr.getMeta(PAGINATE) as { action: string }).action === 'retry')).toHaveLength(0);
  });

  it('while the editor is hidden, retries back off and stop; the next change starts again', () => {
    vi.useFakeTimers();
    const m = mount(longDoc(), {
      layout: (view) => {
        const line = lineLayout(() => view.state.doc);
        return { ...line, measure: () => null, isHidden: () => true };
      },
    });
    const retries = () => m.metas.filter((tr) => (tr.getMeta(PAGINATE) as { action: string }).action === 'retry').length;
    m.frame();
    expect(m.st().blocked).toBe(true);
    for (let k = 0; k < 120; k++) {
      vi.advanceTimersByTime(1000);
      m.frame();
    }
    const stopped = retries();
    expect(stopped).toBeGreaterThan(0);
    expect(stopped).toBeLessThanOrEqual(6);
    expect(isSettled(m.editor.state)).toBe(true); // blocked counts as settled
    // A change re-arms the retries.
    m.editor.commands.insertContentAt(posOf(m.editor.state.doc, 'p3x0'), 'x');
    m.frame();
    vi.advanceTimersByTime(300);
    m.frame();
    expect(retries()).toBe(stopped + 1);
  });
});

describe('attribute changes and undo through pagination (PG-2)', () => {
  const aligns = (doc: PMNode) => {
    const out: unknown[] = [];
    doc.descendants((node) => {
      if (node.type.name === 'paragraph') out.push(node.attrs.align);
      return !node.isTextblock;
    });
    return out;
  };
  // 1 column × 10 lines: "a…" takes 5 lines, "b…" 10, so "b…" continues on page 2.
  const split = () => DOC(PAGE({ pid: 'aaaaaaaa', columns: 1 }, P(words('a', 50)), P(words('b', 100))));

  function alignSecondParagraph(m: Mounted) {
    m.frameUntilSettled();
    expect(pageTexts(m.editor.state.doc).map((page) => page.length)).toEqual([2, 1]);
    m.editor.commands.setTextSelection(posOf(m.editor.state.doc, 'b0 ') + 1);
    expect(m.editor.commands.updateAttributes('paragraph', { align: 'center' })).toBe(true);
    m.frameUntilSettled();
    expect(aligns(m.editor.state.doc)).toEqual([null, 'center', 'center']); // every fragment
  }

  it('undo restores the alignment after an edit moved the boundary of the aligned paragraph', () => {
    const m = mount(split());
    alignSecondParagraph(m);
    const before = pageTexts(m.editor.state.doc);
    // A separate history event: 12 characters at the start of page 1 move the boundary.
    m.editor.view.dispatch(closeHistory(m.editor.state.tr.insertText('x'.repeat(12), pageAt(m.editor.state.doc, 0)!.contentStart + 1)));
    m.frameUntilSettled();
    expect(pageTexts(m.editor.state.doc)).not.toEqual(before);
    expect(m.editor.commands.undo()).toBe(true);
    m.frameUntilSettled();
    expect(pageTexts(m.editor.state.doc)).toEqual(before);
    expect(m.editor.commands.undo()).toBe(true);
    m.frameUntilSettled();
    expect(aligns(m.editor.state.doc)).toEqual([null, null, null]);
    expect(m.editor.commands.redo()).toBe(true);
    m.frameUntilSettled();
    expect(aligns(m.editor.state.doc)).toEqual([null, 'center', 'center']);
  });

  it('undo restores the alignment after a layout change (a web font) moved the boundary', () => {
    let chars = 10;
    const layout = (doc: () => PMNode) => lineLayout(doc, { chars });
    const m = mount(split(), {
      layout: (view) => ({
        measure: (page) => layout(() => view.state.doc).measure(page),
        chooseCut: (page, measured) => layout(() => view.state.doc).chooseCut(page, measured as LineMeasure),
        pullTarget: (page, measured, next) => layout(() => view.state.doc).pullTarget(page, measured as LineMeasure, next),
      }),
    });
    alignSecondParagraph(m);
    const before = pageTexts(m.editor.state.doc);
    chars = 9; // narrower glyphs: fewer characters per line
    repaginate(m.editor.view);
    m.frameUntilSettled();
    expect(pageTexts(m.editor.state.doc)).not.toEqual(before);
    expect(m.editor.commands.undo()).toBe(true);
    m.frameUntilSettled();
    expect(aligns(m.editor.state.doc).every((a) => a === null)).toBe(true);
  });
});

describe('which pages a change dirties (P8.1: typing mid-page checks one page)', () => {
  const doc = DOC(
    PAGE({ pid: 'aaaaaaaa' }, P('zero')),
    AUTO(null, P('one'), P('uno')),
    AUTO(null, H(2, 'head'), P('two'), P('more')),
    PAGE({ pid: 'bbbbbbbb' }, P('three'), P('tres')),
  );
  const settled = () => {
    const s = EditorState.create({ doc, plugins: [paginationPlugin()] });
    return s.apply(s.tr.setMeta(PAGINATE, { dirtyFrom: null, dirtyTo: 3, action: 'settled' }).setMeta('addToHistory', false));
  };
  const dirtyAfter = (edit: (s: EditorState) => Transaction) => {
    const s = settled();
    return paginationKey.getState(s.apply(edit(s)))!;
  };

  it('a change past what the previous page could pull (the first block of an auto page) checks its own page only', () => {
    expect(dirtyAfter((s) => s.tr.insertText('x', posOf(doc, 'uno') + 1))).toMatchObject({ dirtyFrom: 1, dirtyTo: 1 });
    expect(dirtyAfter((s) => s.tr.insertText('x', posOf(doc, 'more') + 1))).toMatchObject({ dirtyFrom: 2, dirtyTo: 2 });
  });

  it('a change in the first block, or in leading headings and the block after them, checks the page before too', () => {
    expect(dirtyAfter((s) => s.tr.insertText('x', posOf(doc, 'one') + 1))).toMatchObject({ dirtyFrom: 0, dirtyTo: 1 });
    expect(dirtyAfter((s) => s.tr.insertText('x', posOf(doc, 'head') + 1))).toMatchObject({ dirtyFrom: 1, dirtyTo: 2 });
    expect(dirtyAfter((s) => s.tr.insertText('x', posOf(doc, 'two') + 1))).toMatchObject({ dirtyFrom: 1, dirtyTo: 2 });
    // Deleting the first block of page 2.
    const first = pageAt(doc, 2)!;
    expect(dirtyAfter((s) => s.tr.delete(first.contentStart, first.contentStart + first.node.child(0).nodeSize))).toMatchObject({ dirtyFrom: 1 });
  });

  it('on a section start, only a change of the page itself (kind: the section break) reaches the page before', () => {
    // Content never crosses a section start: typing in its first block checks that page only.
    expect(dirtyAfter((s) => s.tr.insertText('x', posOf(doc, 'three') + 1))).toMatchObject({ dirtyFrom: 3, dirtyTo: 3 });
    expect(dirtyAfter((s) => s.tr.setNodeAttribute(pageAt(doc, 3)!.pos, 'kind', 'auto'))).toMatchObject({ dirtyFrom: 2, dirtyTo: 3 });
    // A change spanning the page break starts on the page before it (past what page 1 pulls).
    expect(dirtyAfter((s) => s.tr.delete(posOf(doc, 'more') + 2, posOf(doc, 'three') + 1))).toMatchObject({ dirtyFrom: 2 });
  });

  it('a transaction with changes on several pages starts from the first', () => {
    expect(dirtyAfter((s) => s.tr.insertText('a', posOf(doc, 'uno') + 1).insertText('b', posOf(doc, 'one') + 1))).toMatchObject({ dirtyFrom: 0, dirtyTo: 1 });
  });
});

describe('measure-only steps go out with the next transaction (P8.1)', () => {
  const metaOf = (tr: Transaction) => tr.getMeta(PAGINATE) as PaginateMeta;

  it('paginateSteps lists the batched steps, then the own step (none for guard, error, retry)', () => {
    const meta: PaginateMeta = { dirtyFrom: 3, dirtyTo: 3, page: 2, action: 'push', batch: [{ page: 0, action: 'settled' }, { page: 1, action: 'waiting' }] };
    expect(paginateSteps(meta)).toEqual([
      { page: 0, action: 'settled' },
      { page: 1, action: 'waiting' },
      { page: 2, action: 'push' },
    ]);
    expect(paginateSteps({ dirtyFrom: null, dirtyTo: 0, action: 'guard' })).toEqual([]);
    expect(paginateSteps({ dirtyFrom: 1, dirtyTo: 1, action: 'retry' })).toEqual([]);
  });

  it('a pass over settled pages dispatches once per frame, and counts every step', () => {
    const m = mount(longDoc());
    m.frameUntilSettled();
    const before = m.st().stats.steps;
    m.metas.length = 0;
    repaginate(m.editor.view, 0);
    m.frameUntilSettled();
    expect(m.metas).toHaveLength(1);
    const steps = paginateSteps(metaOf(m.metas[0]!));
    expect(steps.map((s) => s.page)).toEqual(Array.from({ length: 15 }, (_, i) => i));
    expect(new Set(steps.map((s) => s.action))).toEqual(new Set(['settled']));
    expect(m.st().stats.steps - before).toBe(15);
    expect(m.st().stats.lastSettleSteps).toBe(15);
  });

  it('a boundary move carries the settled steps before it, in order', () => {
    const m = mount(longDoc());
    m.frameUntilSettled();
    m.metas.length = 0;
    // A long first block on page 4 (an auto page): pages 3 and 4 are checked; page 4 overflows.
    m.editor.view.dispatch(m.editor.state.tr.insertText(words('grow', 400), posOf(m.editor.state.doc, pageTexts(m.editor.state.doc)[4]![0]!.slice(0, 8))));
    m.frameUntilSettled();
    const push = m.metas.find((tr) => tr.docChanged)!;
    expect(metaOf(push).batch).toEqual([{ page: 3, action: 'settled' }]);
    expect(metaOf(push).page).toBe(4);
    expect(m.metas.every((tr) => tr.getMeta('addToHistory') === false)).toBe(true);
    // Every page from 3 to the end was checked exactly as before the batching: once per step.
    const pages = m.metas.flatMap((tr) => paginateSteps(metaOf(tr)).map((s) => s.page));
    expect(pages[0]).toBe(3);
    expect(m.st().stats.lastSettleSteps).toBe(pages.length);
  });

  it('the held steps are dispatched when the frame ends, so the state is current between frames', () => {
    const m = mount(longDoc(), { budgetMs: 8, stepCostMs: 3 });
    m.frameUntilSettled();
    m.metas.length = 0;
    repaginate(m.editor.view, 0);
    m.frame();
    expect(m.metas).toHaveLength(1);
    expect(paginateSteps(metaOf(m.metas[0]!)).map((s) => s.page)).toEqual([0, 1, 2]);
    expect(m.st().dirtyFrom).toBe(3);
    expect(isSettled(m.editor.state)).toBe(false);
  });

  it('pages waiting for an image stay waiting when their step was held', () => {
    const m = mount(longDoc(), {
      layout: (view) => lineLayout(() => view.state.doc, { waiting: (page) => page.index === 5 }),
    });
    m.frame();
    expect(m.st()).toMatchObject({ dirtyFrom: null, waiting: [5] });
    expect(isSettled(m.editor.state)).toBe(false);
  });
});

describe('heading ids skip pagination transactions that keep the page count (P8.1)', () => {
  const paginate = (tr: Transaction): Transaction =>
    tr.setMeta(PAGINATE, { dirtyFrom: null, dirtyTo: 1, action: 'settled' } satisfies PaginateMeta).setMeta('addToHistory', false);
  const headingId = (m: Mounted) => m.editor.state.doc.child(0).child(0).attrs.id as string | null;

  it('a stale id stays through a pagination step that keeps the page count, and is fixed by one that changes it', () => {
    const m = mount(DOC(PAGE({ pid: 'aaaaaaaa' }, H(2, 'Intro'), P(words('a', 80)), P(words('b', 80))), AUTO(null, P('tail'))));
    m.frameUntilSettled();
    expect(headingId(m)).toBe('intro');
    // Pagination moves whole headings (join + split): its steps can't change an id, so the plugin
    // doesn't walk the headings for them. (A stale id is only possible here because the test sets one.)
    m.editor.view.dispatch(paginate(m.editor.state.tr.setNodeAttribute(1, 'id', 'stale')));
    expect(headingId(m)).toBe('stale');
    // A step that adds a page can (generated ids avoid the page ids p1…pN): the ids are checked.
    const pages = m.editor.state.doc.childCount;
    const tr = m.editor.state.tr;
    insertAutoPageAt(tr, 0, pageAt(tr.doc, 0)!.contentStart + tr.doc.child(0).child(0).nodeSize + tr.doc.child(0).child(1).nodeSize);
    m.editor.view.dispatch(paginate(tr));
    expect(m.editor.state.doc.childCount).toBe(pages + 1);
    expect(headingId(m)).toBe('intro');
  });
});
