// /dev/pagination (and /dev/sections) harness logic, kept out of the component file. The page
// mounts EditorCanvas (PageView, theme chain, zoom, fonts gate) with paginatedExtensions(), and
// exposes window.__hbPagination for web/e2e/pagination and web/e2e/sections (measurements,
// cuts, a per-frame overflow watch, an in-page fuzz, and a log of pagination steps and
// repagination triggers). The API mirror for the specs is web/e2e/pagination/harness.ts.
import type { AnyExtension, Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';
import { createCanvasGate, type CanvasGate } from '@/editor/canvas/canvasState';
import type { RepaginateEvent } from '@/editor/canvas/useCanvasTheme';
import { paginatedExtensions } from '@/editor/paginatedExtensions';
import {
  PAGINATE,
  REPAGINATE,
  chooseCut,
  fragmentChain,
  isSettled,
  measurePage,
  pageAt,
  paginationKey,
  parityMatters,
  repaginate,
  settleNow,
  type PageMeasure,
  type PaginateMeta,
  type PaginationState,
  type SettleInfo,
} from '@/editor/pagination';
import { FIXTURES, fillerText } from './fixtures';

/** One entry of the harness's event log (HarnessApi.events). */
export type HarnessEvent =
  | { kind: 'step'; page: number | null; action: string }
  | { kind: 'repaginate'; from: number; to: number | null; source: 'canvas' | 'meta'; reason?: string };

/** Controls the page component gives the harness (EditorCanvas props live in React state). */
export interface HarnessControls {
  setZoom(zoom: number): void;
  setUserCss(css: string): void;
  setTheme(theme: string): void;
}

// Serializable reports -------------------------------------------------------------------------

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

export interface MeasureReport extends Omit<PageMeasure, 'first'> {
  first: { index: number; pos: number; rect: Rect; startsInside: boolean; type: string } | null;
}

export interface PosReport {
  pos: number;
  page: number;
  depth: number;
  parent: string;
  before: string;
  after: string;
  nodeBefore: string | null;
  nodeAfter: string | null;
  coords: Rect | null;
  coordsBefore: Rect | null;
  /** fragments of the node right before / after the position (non-text nodes) */
  beforeRects: Rect[] | null;
  afterRects: Rect[] | null;
}

export interface PageReport {
  index: number;
  kind: string;
  pid: string | null;
  columns: number | null;
  oversized: boolean;
  blocks: string[];
  overflow: boolean | null;
  freeSpace: number | null;
  measuredColumns: number | null;
}

export interface FrameReport {
  frames: number;
  /** frames whose painted state had an overflowing page: frame number, pages, settled flag */
  overflowFrames: { frame: number; pages: number[]; settled: boolean }[];
}

/**
 * Overflow of one page read straight from the DOM, independent of measure.ts: every rendered
 * descendant of the .columnWrapper (floats included) against the wrapper's content box.
 */
export interface DomTruth {
  box: Rect;
  rtl: boolean;
  overflow: boolean;
  /** elements with a fragment outside the box (first 10): tag, classes and the fragment */
  outside: { tag: string; className: string; rect: Rect }[];
}

export interface FuzzReport {
  edits: number;
  pagesBefore: number;
  pagesAfter: number;
  settleMs: { max: number; avg: number; p95: number };
  maxSettleSteps: number;
  /** settles that ended with an overflowing page (DOM truth) that isn't flagged oversized */
  overflowAfterSettle: { edit: number; pages: number[] }[];
  /** settles that changed the flow text (flowText before the settle vs after it) */
  textChanged: { edit: number; lengthBefore: number; lengthAfter: number; firstDifference: number }[];
  oversizedPages: number;
  guardHits: number;
  errors: number;
  durationMs: number;
  kinds: Record<string, number>;
}

const toRect = (r: { left: number; top: number; right: number; bottom: number }): Rect => ({
  left: r.left,
  top: r.top,
  right: r.right,
  bottom: r.bottom,
  width: r.right - r.left,
  height: r.bottom - r.top,
});

/** mulberry32: a small seeded PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export class PaginationHarness {
  /** For EditorCanvas (memoized: one array for the page's lifetime). */
  readonly extensions: AnyExtension[];
  /** EditorCanvas's gate: theme, CSS and fonts applied. */
  readonly gate: CanvasGate;
  private enabled: boolean;
  private editor: Editor | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private controls: HarnessControls | null = null;
  private log: HarnessEvent[] = [];
  lastSettle: SettleInfo | null = null;

  constructor(opts: { paginate: boolean }) {
    this.enabled = opts.paginate;
    this.gate = createCanvasGate();
    this.extensions = paginatedExtensions({
      gate: this.gate,
      isReady: () => this.enabled,
      onSettle: (info) => {
        this.lastSettle = info;
        this.emit();
      },
    });
  }

  /** The page component's controls (zoom, user CSS, theme). */
  setControls(controls: HarnessControls | null): void {
    this.controls = controls;
  }

  /** EditorCanvas's onRepaginate (theme, CSS and fonts triggers). */
  onCanvasRepaginate = (event: RepaginateEvent): void => {
    this.log.push({ kind: 'repaginate', from: event.from, to: null, source: 'canvas', reason: event.reason });
  };

  private readonly onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    const meta = transaction.getMeta(PAGINATE) as PaginateMeta | undefined;
    // Measure-only steps are sent with the next transaction (PaginateMeta.batch, P8.1).
    for (const step of meta?.batch ?? []) this.log.push({ kind: 'step', page: step.page, action: step.action });
    if (meta) this.log.push({ kind: 'step', page: meta.page ?? null, action: meta.action });
    const forced = transaction.getMeta(REPAGINATE) as unknown;
    if (forced !== undefined) {
      const range = typeof forced === 'number' ? { from: forced, to: null } : (forced as { from: number; to?: number });
      this.log.push({ kind: 'repaginate', from: range.from, to: range.to ?? null, source: 'meta' });
    }
    if (this.log.length > 20_000) this.log.splice(0, this.log.length - 10_000);
  };

  // React glue (useSyncExternalStore) -----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.version;

  private emit() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  attach(editor: Editor | null): void {
    this.editor?.off('transaction', this.onTransaction);
    this.editor = editor;
    if (editor) {
      editor.on('transaction', this.onTransaction);
      (window as unknown as { __hbPagination?: HarnessApi }).__hbPagination = this.api(editor);
    }
    this.emit();
  }

  status(): { pages: number; settled: boolean; stats: PaginationState['stats'] | null } {
    const state = this.editor?.state;
    return {
      pages: state?.doc.childCount ?? 0,
      settled: state ? isSettled(state) : false,
      stats: state ? (paginationKey.getState(state)?.stats ?? null) : null,
    };
  }

  // The window API --------------------------------------------------------------------------------

  private api(editor: Editor): HarnessApi {
    const view = () => editor.view;
    const doc = () => editor.state.doc;

    const measure = (i: number): MeasureReport | null => {
      const page = pageAt(doc(), i);
      const m = page ? measurePage(view(), page) : null;
      if (!m) return null;
      return {
        ...m,
        box: toRect(m.box),
        first: m.first
          ? {
              index: m.first.index,
              pos: m.first.pos,
              rect: toRect(m.first.rect),
              startsInside: m.first.startsInside,
              type: page!.node.child(m.first.index).type.name,
            }
          : null,
      };
    };

    const describe = (pos: number): PosReport => {
      const d = doc();
      const $pos = d.resolve(pos);
      const coords = (p: number): Rect | null => {
        try {
          return toRect(view().coordsAtPos(p, 1));
        } catch {
          return null;
        }
      };
      const label = (n: PMNode | null | undefined) => (n ? `${n.type.name}${n.isText ? `:${n.text?.slice(0, 20)}` : `:${n.textContent.slice(0, 20)}`}` : null);
      const rects = (p: number): Rect[] | null => {
        const el = view().nodeDOM(p);
        return el instanceof Element ? Array.from(el.getClientRects()).map(toRect) : null;
      };
      return {
        pos,
        page: $pos.index(0),
        depth: $pos.depth,
        parent: $pos.parent.type.name,
        before: $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 40), $pos.parentOffset, ' ', ' '),
        after: $pos.parent.textBetween($pos.parentOffset, Math.min($pos.parent.content.size, $pos.parentOffset + 40), ' ', ' '),
        nodeBefore: label($pos.nodeBefore),
        nodeAfter: label($pos.nodeAfter),
        coords: coords(pos),
        coordsBefore: pos > 0 ? coords(pos - 1) : null,
        beforeRects: $pos.nodeBefore && !$pos.nodeBefore.isText ? rects(pos - $pos.nodeBefore.nodeSize) : null,
        afterRects: $pos.nodeAfter && !$pos.nodeAfter.isText ? rects(pos) : null,
      };
    };

    // The oracle for "no page overflows": the DOM itself, not measurePage (whose blind spots it
    // must be able to see). Block-level boxes and floats count when they reach past the bottom
    // of the box too; inline boxes only when they sit in an overflow column (a glyph's inline box
    // can reach a little below its line box at the bottom of a column).
    const domTruth = (i: number): DomTruth | null => {
      const page = pageAt(doc(), i);
      const pageEl = page ? view().nodeDOM(page.pos) : null;
      const wrap = pageEl instanceof HTMLElement ? pageEl.querySelector<HTMLElement>(':scope > div.columnWrapper') : null;
      if (!wrap) return null;
      const r = wrap.getBoundingClientRect();
      const cs = getComputedStyle(wrap);
      const scale = wrap.offsetWidth > 0 ? r.width / wrap.offsetWidth : 1;
      const len = (v: string) => (parseFloat(v) || 0) * scale;
      const box = toRect({
        left: r.left + len(cs.borderLeftWidth) + len(cs.paddingLeft),
        top: r.top + len(cs.borderTopWidth) + len(cs.paddingTop),
        right: r.right - len(cs.borderRightWidth) - len(cs.paddingRight),
        bottom: r.bottom - len(cs.borderBottomWidth) - len(cs.paddingBottom),
      });
      const rtl = cs.direction === 'rtl';
      const eps = 0.5 * scale;
      const outside: DomTruth['outside'] = [];
      const walk = (parent: Element) => {
        for (let el = parent.firstElementChild; el; el = el.nextElementSibling) {
          const ecs = getComputedStyle(el);
          if (ecs.display === 'none' || ecs.position === 'absolute' || ecs.position === 'fixed') continue;
          const blockLevel = !ecs.display.startsWith('inline') || ecs.float !== 'none';
          for (const x of Array.from(el.getClientRects())) {
            if (x.height <= eps || x.width <= 0) continue;
            const inOverflowColumn = rtl ? x.right <= box.left + eps : x.left >= box.right - eps;
            if (inOverflowColumn || (blockLevel && x.bottom > box.bottom + eps)) {
              if (outside.length < 10) outside.push({ tag: el.tagName.toLowerCase(), className: String(el.className), rect: toRect(x) });
              break;
            }
          }
          walk(el);
        }
      };
      walk(wrap);
      return { box, rtl, overflow: outside.length > 0, outside };
    };

    const overflowing = (): number[] => {
      const out: number[] = [];
      const d = doc();
      for (let i = 0; i < d.childCount; i++) {
        if (domTruth(i)?.overflow && d.child(i).attrs.oversized !== true) out.push(i);
      }
      return out;
    };

    // The text of the flow as the author sees it: textblocks one per line, except that a
    // fragment continuing a block across a page seam (continuation, first at every level of its
    // page) joins the text before it. Pagination must never change it.
    const flowText = (): string => {
      let text = '';
      doc().forEach((pg, _offset, pageIndex) => {
        const walk = (node: PMNode, leftSpine: boolean) => {
          node.forEach((child, _o, k) => {
            const onSpine = leftSpine && k === 0 && child.attrs.continuation === true;
            if (child.isTextblock) text += (onSpine && pageIndex > 0 ? '' : '\n') + child.textContent;
            else if (!child.isLeaf) walk(child, onSpine);
          });
        };
        walk(pg, true);
      });
      return text;
    };

    const settled = (timeoutMs = 60_000) =>
      new Promise<{ ms: number; frames: number }>((resolve, reject) => {
        const t0 = performance.now();
        let frames = 0;
        const check = () => {
          if (isSettled(editor.state)) {
            resolve({ ms: performance.now() - t0, frames });
            return;
          }
          if (performance.now() - t0 > timeoutMs) {
            reject(new Error(`pagination not settled after ${timeoutMs} ms`));
            return;
          }
          frames += 1;
          requestAnimationFrame(check);
        };
        check();
      });

    const pageBlocks = (d: PMNode) => {
      const out: { pos: number; node: PMNode; page: PMNode }[] = [];
      d.forEach((pg, pagePos) => pg.forEach((node, offset) => out.push({ pos: pagePos + 1 + offset, node, page: pg })));
      return out;
    };

    const randomEdit = (rand: () => number, n: number): { tr: Transaction; kind: string } | null => {
      const state = editor.state;
      const schema = state.schema;
      const pick = <T,>(list: T[]): T | undefined => list[Math.floor(rand() * list.length)];
      const node = (json: JSONContent) => schema.nodeFromJSON(json);
      const paragraphs = pageBlocks(state.doc).filter((b) => b.node.type.name === 'paragraph');
      const r = rand();
      const tr = state.tr;
      if (r < 0.3) {
        const at = pick(paragraphs);
        if (!at) return null;
        const pos = at.pos + 1 + Math.floor(rand() * (at.node.content.size + 1));
        const length = 1 + Math.floor(rand() * 220);
        return { tr: tr.insertText(` ${fillerText(length, n)}`.slice(0, length), pos), kind: 'insertText' };
      }
      if (r < 0.52) {
        const at = pick(paragraphs.filter((b) => b.node.content.size > 2));
        if (!at) return null;
        const a = Math.floor(rand() * at.node.content.size);
        const b = Math.min(at.node.content.size, a + 1 + Math.floor(rand() * 250));
        return { tr: tr.delete(at.pos + 1 + a, at.pos + 1 + b), kind: 'deleteText' };
      }
      if (r < 0.68) {
        const at = pick(pageBlocks(state.doc));
        if (!at) return null;
        const k = rand();
        const block =
          k < 0.45
            ? { type: 'paragraph', content: [{ type: 'text', text: fillerText(40 + Math.floor(rand() * 700), n) }] }
            : k < 0.6
              ? { type: 'heading', attrs: { level: 2 + Math.floor(rand() * 3) }, content: [{ type: 'text', text: `Heading ${n}` }] }
              : k < 0.75
                ? {
                    type: rand() < 0.5 ? 'bulletList' : 'orderedList',
                    content: Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, j) => ({
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: fillerText(30 + Math.floor(rand() * 90), n + j) }] }],
                    })),
                  }
                : k < 0.9
                  ? {
                      type: 'themeBlock',
                      attrs: { classes: ['note'] },
                      content: [
                        { type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: `Note ${n}` }] },
                        { type: 'paragraph', content: [{ type: 'text', text: fillerText(40 + Math.floor(rand() * 250), n) }] },
                      ],
                    }
                  : { type: 'definitionList', content: [
                      { type: 'definitionTerm', content: [{ type: 'text', text: 'Armor Class' }] },
                      { type: 'definitionDesc', content: [{ type: 'text', text: `${10 + (n % 10)}` }] },
                      { type: 'definitionTerm', content: [{ type: 'text', text: 'Hit Points' }] },
                      { type: 'definitionDesc', content: [{ type: 'text', text: `${n % 90}` }] },
                    ] };
        return { tr: tr.insert(at.pos, node(block)), kind: 'insertBlock' };
      }
      if (r < 0.8) {
        const at = pick(pageBlocks(state.doc).filter((b) => b.page.childCount > 1));
        if (!at) return null;
        // A plain node delete: when the block continues on the next page, the pagination plugin
        // makes the fragment there a block of its own (P4.7), before flowText reads the document.
        return { tr: tr.delete(at.pos, at.pos + at.node.nodeSize), kind: 'deleteBlock' };
      }
      if (r < 0.9) {
        const at = pick(paragraphs.filter((b) => b.node.content.size > 2));
        if (!at) return null;
        return { tr: tr.split(at.pos + 2 + Math.floor(rand() * (at.node.content.size - 1))), kind: 'split' };
      }
      if (r < 0.95) {
        const blocks = pageBlocks(state.doc);
        const k = Math.floor(rand() * blocks.length);
        const a = blocks[k];
        const b = blocks[k + 1];
        if (!a || !b || a.page !== b.page || a.node.type.name !== 'paragraph' || b.node.type.name !== 'paragraph') return null;
        const seam = a.pos + a.node.nodeSize;
        return canJoin(state.doc, seam) ? { tr: tr.join(seam), kind: 'join' } : null;
      }
      return null; // undo / redo, handled by the caller
    };

    const api: HarnessApi = {
      editor,
      isSettled: () => isSettled(editor.state),
      state: () => {
        const s = paginationKey.getState(editor.state);
        return s ? { dirtyFrom: s.dirtyFrom, dirtyTo: s.dirtyTo, blocked: s.blocked, waiting: [...s.waiting], stats: { ...s.stats } } : null;
      },
      events: () => this.log.splice(0),
      caretInBlock: () => {
        // The caret's textblock and its fragments on other pages, joined: the block the author sees.
        const state = editor.state;
        const $head = state.selection.$head;
        if (!$head.parent.isTextblock || $head.depth < 2) return null;
        const own = $head.before();
        const chain = fragmentChain(state.doc, own);
        let text = '';
        let offset = -1;
        for (const pos of chain) {
          const node = state.doc.nodeAt(pos)!;
          if (pos === own) offset = text.length + $head.parentOffset;
          text += node.textContent;
        }
        return { text, offset, fragments: chain.length, page: $head.index(0), fragment: chain.indexOf(own) };
      },
      setUserCss: (css: string) => this.controls?.setUserCss(css),
      setTheme: (theme: string) => this.controls?.setTheme(theme),
      parityMatters: () => parityMatters(view()),
      lastSettle: () => (this.lastSettle ? { steps: this.lastSettle.steps, ms: this.lastSettle.ms } : null),
      settled,
      load(content: JSONContent | string) {
        const json = typeof content === 'string' ? FIXTURES[content]?.() : content;
        if (!json) throw new Error(`unknown fixture ${typeof content === 'string' ? content : '(json)'}`);
        const state = EditorState.create({ doc: editor.schema.nodeFromJSON(json), plugins: editor.state.plugins });
        view().updateState(state);
      },
      setPaginate: (on: boolean) => {
        this.enabled = on;
        if (on) repaginate(view());
      },
      measure,
      cut(i: number) {
        const page = pageAt(doc(), i);
        const m = page ? measurePage(view(), page) : null;
        if (!page || !m) return null;
        const choice = chooseCut(view(), page, m);
        return { ...choice, at: choice.pos === null ? null : describe(choice.pos) };
      },
      describe,
      pages() {
        const d = doc();
        const out: PageReport[] = [];
        for (let i = 0; i < d.childCount; i++) {
          const page = pageAt(d, i)!;
          const m = measurePage(view(), page);
          const blocks: string[] = [];
          page.node.forEach((b) => blocks.push(`${b.type.name}${b.attrs.continuation === true ? '(cont)' : ''}:${b.textContent.slice(0, 24)}`));
          out.push({
            index: i,
            kind: String(page.node.attrs.kind),
            pid: (page.node.attrs.pid as string | null) ?? null,
            columns: (page.node.attrs.columns as number | null) ?? null,
            oversized: page.node.attrs.oversized === true,
            blocks,
            overflow: m ? m.overflow : null,
            freeSpace: m ? m.freeSpace : null,
            measuredColumns: m ? m.columns : null,
          });
        }
        return out;
      },
      texts() {
        const pages: string[][] = [];
        doc().forEach((pg) => {
          const blocks: string[] = [];
          pg.descendants((n) => {
            if (n.isTextblock) {
              blocks.push(n.textContent);
              return false;
            }
            return true;
          });
          pages.push(blocks);
        });
        return pages;
      },
      overflowing,
      domTruth,
      flowText,
      selection() {
        const { head, anchor } = editor.state.selection;
        return { head, anchor, page: editor.state.doc.resolve(head).index(0) };
      },
      select(anchor: number, head = anchor) {
        // view.focus() is synchronous; TipTap's focus command waits for an animation frame, and
        // a key pressed before that would go to the page instead of the editor.
        view().focus();
        view().dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)));
      },
      blockPos(i: number, k: number) {
        const page = pageAt(doc(), i);
        if (!page) throw new Error(`no page ${i}`);
        let pos = page.contentStart;
        for (let j = 0; j < Math.min(k, page.node.childCount); j++) pos += page.node.child(j).nodeSize;
        return pos;
      },
      endOfPage(i: number) {
        const page = pageAt(doc(), i);
        if (!page) throw new Error(`no page ${i}`);
        return TextSelection.near(editor.state.doc.resolve(page.contentEnd), -1).head;
      },
      posOf(text: string) {
        let found = -1;
        doc().descendants((n, pos) => {
          if (found >= 0) return false;
          if (n.isText && n.text) {
            const at = n.text.indexOf(text);
            if (at >= 0) found = pos + at;
          }
          return true;
        });
        return found;
      },
      docJSON: () => editor.getJSON(),
      repaginate: (from = 0) => repaginate(view(), from),
      settleNow: () => settleNow(view()),
      setZoom: (zoom: number) => {
        // EditorCanvas's zoom prop, rendered synchronously (the page uses flushSync).
        this.controls?.setZoom(zoom);
      },
      grow(i: number, until: { column: number; fraction: number }, chunk = 120) {
        for (let n = 0; n < 2000; n++) {
          const m = measure(i);
          if (!m) return null;
          const rowHeight = m.box.bottom - m.rowTop;
          const reached =
            m.overflow ||
            m.lastColumn > until.column ||
            (m.lastColumn === until.column && m.lastBottom - m.rowTop >= until.fraction * rowHeight);
          if (reached) return m;
          const page = pageAt(doc(), i)!;
          const para = editor.schema.nodeFromJSON({ type: 'paragraph', content: [{ type: 'text', text: fillerText(chunk, n) }] });
          view().dispatch(editor.state.tr.insert(page.contentEnd, para).setMeta('addToHistory', false));
        }
        return measure(i);
      },
      insertBlock(i: number, json: JSONContent) {
        const page = pageAt(doc(), i);
        if (!page) throw new Error(`no page ${i}`);
        view().dispatch(editor.state.tr.insert(page.contentEnd, editor.schema.nodeFromJSON(json)).setMeta('addToHistory', false));
      },
      frameWatch() {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0';
        document.body.append(probe);
        const report: FrameReport = { frames: 0, overflowFrames: [] };
        let active = true;
        // ResizeObserver callbacks run after layout and after every requestAnimationFrame
        // callback of the frame, right before paint: they see what the frame will show.
        const observer = new ResizeObserver(() => {
          if (!active) return;
          report.frames += 1;
          const pages = overflowing();
          if (pages.length) report.overflowFrames.push({ frame: report.frames, pages, settled: isSettled(editor.state) });
        });
        observer.observe(probe);
        let wide = false;
        const tick = () => {
          if (!active) return;
          wide = !wide;
          probe.style.width = wide ? '2px' : '1px';
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const stop = () => {
          active = false;
          observer.disconnect();
          probe.remove();
          return report;
        };
        (window as unknown as { __hbFrameWatch?: () => FrameReport }).__hbFrameWatch = stop;
        return { stop };
      },
      async fuzz({ seed, edits, burst = 0.1 }: { seed: number; edits: number; burst?: number }) {
        const rand = prng(seed);
        const t0 = performance.now();
        const pagesBefore = doc().childCount;
        const times: number[] = [];
        const overflowAfterSettle: FuzzReport['overflowAfterSettle'] = [];
        const textChanged: FuzzReport['textChanged'] = [];
        const kinds: Record<string, number> = {};
        let maxSettleSteps = 0;
        let applied = 0;
        for (let n = 0; applied < edits && n < edits * 20; n++) {
          const batch = rand() < burst ? 2 + Math.floor(rand() * 2) : 1;
          const start = performance.now();
          let did = 0;
          for (let b = 0; b < batch && applied < edits; b++) {
            const roll = rand();
            if (roll < 0.04) {
              if (editor.commands.undo()) {
                kinds.undo = (kinds.undo ?? 0) + 1;
                applied += 1;
                did += 1;
              }
              continue;
            }
            if (roll < 0.06) {
              if (editor.commands.redo()) {
                kinds.redo = (kinds.redo ?? 0) + 1;
                applied += 1;
                did += 1;
              }
              continue;
            }
            const edit = randomEdit(rand, n);
            if (!edit || !edit.tr.docChanged) continue;
            view().dispatch(edit.tr);
            kinds[edit.kind] = (kinds[edit.kind] ?? 0) + 1;
            applied += 1;
            did += 1;
          }
          if (!did) continue;
          const textBefore = flowText(); // pagination runs in the next frames, not before
          await settled();
          times.push(performance.now() - start);
          maxSettleSteps = Math.max(maxSettleSteps, paginationKey.getState(editor.state)?.stats.lastSettleSteps ?? 0);
          const bad = overflowing();
          if (bad.length) overflowAfterSettle.push({ edit: applied, pages: bad });
          const textAfter = flowText();
          if (textAfter !== textBefore && textChanged.length < 20) {
            let k = 0;
            while (k < textBefore.length && textBefore[k] === textAfter[k]) k++;
            textChanged.push({ edit: applied, lengthBefore: textBefore.length, lengthAfter: textAfter.length, firstDifference: k });
          }
          if (applied % 100 === 0) await nextFrame();
        }
        const sorted = [...times].sort((a, b) => a - b);
        const stats = paginationKey.getState(editor.state)!.stats;
        let oversizedPages = 0;
        doc().forEach((pg) => {
          if (pg.attrs.oversized === true) oversizedPages += 1;
        });
        return {
          edits: applied,
          pagesBefore,
          pagesAfter: doc().childCount,
          settleMs: {
            max: sorted[sorted.length - 1] ?? 0,
            avg: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
            p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
          },
          maxSettleSteps,
          overflowAfterSettle,
          textChanged,
          oversizedPages,
          guardHits: stats.guardHits,
          errors: stats.errors,
          durationMs: performance.now() - t0,
          kinds,
        };
      },
    };
    return api;
  }
}

export interface HarnessApi {
  editor: Editor;
  isSettled(): boolean;
  state(): Pick<PaginationState, 'dirtyFrom' | 'dirtyTo' | 'blocked' | 'waiting' | 'stats'> | null;
  /** the pagination steps and repagination triggers since the last call (and clears the log) */
  events(): HarnessEvent[];
  /** EditorCanvas's userCss (the Style tab), applied after its debounce */
  setUserCss(css: string): void;
  setTheme(theme: string): void;
  /** the caret's block (fragments on other pages joined): its text and the caret's offset in it */
  caretInBlock(): { text: string; offset: number; fragments: number; page: number; fragment: number } | null;
  /** the DOM layout's answer: do odd and even pages lay out their flow differently? */
  parityMatters(): boolean;
  lastSettle(): { steps: number; ms: number } | null;
  /** resolves when pagination is settled (checked once per frame, after pagination ran) */
  settled(timeoutMs?: number): Promise<{ ms: number; frames: number }>;
  /** replaces the document (a fixture name or JSON) with fresh plugin state and history */
  load(content: JSONContent | string): void;
  setPaginate(on: boolean): void;
  measure(i: number): MeasureReport | null;
  cut(i: number): (ReturnType<typeof chooseCut> & { at: PosReport | null }) | null;
  describe(pos: number): PosReport;
  pages(): PageReport[];
  /** text of every textblock, per page */
  texts(): string[][];
  /** pages that overflow (DOM truth, not measurePage) and aren't flagged oversized */
  overflowing(): number[];
  /** page i's overflow read straight from the DOM (null when it isn't rendered) */
  domTruth(i: number): DomTruth | null;
  /** the flow's text, fragments of a block joined (pagination never changes it) */
  flowText(): string;
  selection(): { head: number; anchor: number; page: number };
  select(anchor: number, head?: number): void;
  /** last text position of page i */
  endOfPage(i: number): number;
  /** position before block k of page i (k = childCount: the end of the page's flow) */
  blockPos(i: number, k: number): number;
  posOf(text: string): number;
  docJSON(): JSONContent;
  repaginate(from?: number): void;
  settleNow(): boolean;
  setZoom(zoom: number): void;
  /** appends paragraphs to page i until its flow reaches `until` (or overflows); pagination should be off */
  grow(i: number, until: { column: number; fraction: number }, chunk?: number): MeasureReport | null;
  insertBlock(i: number, json: JSONContent): void;
  /** starts watching every frame for overflowing pages; stop() returns the report */
  frameWatch(): { stop(): FrameReport };
  fuzz(opts: { seed: number; edits: number; burst?: number }): Promise<FuzzReport>;
}
