// The pagination plugin (plan §4.7): plugin state with the dirty page range, and a scheduler
// that settles pages in requestAnimationFrame, before paint, within a frame budget.
//
// - Every pagination transaction carries addToHistory: false and the PAGINATE meta.
// - Nothing is restructured while view.composing (IME input) or before opts.isReady() (fonts).
// - A settle that takes more than maxStepsPerSettle steps is stopped and logged (loop guard);
//   stats.guardHits counts them. The step logic only moves forward, so it should never fire.
// - An image that finishes loading (or fails) re-checks its page (plan §4.7 trigger). A page
//   skipped because an image in its flow has no size yet stays in `waiting` (not settled) until
//   that load, or a timer once measurements stop waiting for the image, checks it again.
// - When the page count changes during a pass and odd/even pages lay out differently (Journal-
//   like themes, brew CSS), the pass continues to the last page (step.ts; `parity` option).
// - An attribute-only change of a manual page (section settings, markers) re-checks from that
//   page: the page before it can't pull across a section start.
// - While the editor is hidden, retries back off (250 ms doubling, 5 tries), then wait for the
//   next change.
// - Attributes changed on one fragment of a split block go to all its fragments, and a fragment
//   whose head the author deleted becomes a block of its own (fragments.ts).
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type EditorState, type PluginView, type Transaction } from '@tiptap/pm/state';
import { AttrStep } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { LAYOUT_NEUTRAL_META } from '../schema/plugins/meta';
import { inlineOnly } from '../schema/plugins/stepScope';
import { pageAt, pageIndexAt } from './boundary';
import { FRAGMENT_ATTRS, addSharedFragmentAttrs, clearOrphanedContinuations, isAuthorChange, repairContinuations } from './fragments';
import { domLayout } from './layout';
import { IMAGE_WAIT_MS, pendingImages } from './measure';
import { dropEmptiedPlaceholders, restoreJoinedPages } from './pageData';
import {
  PAGINATE,
  REPAGINATE,
  emptyStats,
  paginationKey,
  paginateSteps,
  type PaginateMeta,
  type PaginateStep,
  type PaginationState,
  type PaginationStats,
  type RepaginateMeta,
  type StepAction,
} from './state';
import { paginatePage, type LayoutMeasure, type PageLayout, type PaginationProgress, type StepResult } from './step';

export interface SettleInfo {
  /** steps the settle took */
  steps: number;
  /** ms from the first change of the settle to its end */
  ms: number;
  stats: PaginationStats;
}

export interface PaginationOptions {
  /** ms of pagination work per animation frame (default 8) */
  budgetMs?: number;
  /** false while fonts or the theme are loading: pagination waits (default: always ready) */
  isReady?: () => boolean;
  /** loop guard: most steps one settle may take (default 200 + 30 per page) */
  maxStepsPerSettle?: number | ((doc: PMNode) => number);
  /** layout implementation (default: the DOM, layout.ts) */
  layout?: (view: EditorView) => PageLayout<LayoutMeasure>;
  /** frame scheduling (default requestAnimationFrame / cancelAnimationFrame) */
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  /**
   * Runs `callback` in a task of its own, soon (between frames): offscreen pages are checked in
   * such tasks, a budget at a time, besides the frames (P8.1). Default: a MessageChannel message
   * in the browser, none (frames only) when `requestFrame` is given (tests control the frames) or
   * null is passed.
   */
  requestTask?: ((callback: () => void) => void) | null;
  /** clock for the budget (default performance.now) */
  now?: () => number;
  /** called after every completed settle (debugging, measurements) */
  onSettle?: (info: SettleInfo) => void;
  /** where the loop guard and step errors are reported (default console) */
  logger?: Pick<Console, 'error' | 'warn'>;
  /**
   * Whether odd and even pages lay out their flow differently, so that adding or removing a page
   * re-checks every page after it (plan §4.7). 'auto' (default) asks the layout (domLayout
   * compares the flow box of an odd and an even page of one section); true / false force it.
   */
  parity?: boolean | 'auto';
}

const DEFAULT_BUDGET_MS = 8;
/** First retry delay while pages can't be measured (hidden editor); it doubles per retry. */
const BLOCKED_RETRY_MS = 250;
/** Retries while hidden before waiting for the next change (250 + 500 + … + 4000 ms). */
const BLOCKED_RETRIES = 5;
/**
 * Pages waiting for an image's size are checked again after this long (ms): measurements stop
 * waiting for an image IMAGE_WAIT_MS after they first saw it, so this check measures the page.
 */
export const WAITING_RECHECK_MS = IMAGE_WAIT_MS + 100;
/**
 * Steps a frame may take past its budget while the next page to check is in view (a push from
 * the typed page onto the next, visible page settles before paint; offscreen pages wait).
 */
export const MAX_STEPS_PAST_BUDGET = 12;

/** A task of its own, soon: a MessageChannel message (setTimeout(0) is clamped to 4 ms when nested). */
function messageTask(callback: () => void): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    callback();
  };
  channel.port2.postMessage(null);
}

/** Chromium's isInputPending (a keystroke or click is waiting): offscreen work yields to it. */
function inputPending(): boolean {
  const scheduling = (navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } }).scheduling;
  try {
    return scheduling?.isInputPending?.() === true;
  } catch {
    return false;
  }
}

export const defaultMaxSteps = (doc: PMNode): number => 200 + 30 * doc.childCount;

/** What one scheduler run (an animation frame's work, or settleNow) did: setPaginationProfiler. */
export interface PaginationFrameProfile {
  /** performance.now() when the run started and ended */
  start: number;
  end: number;
  /** steps run, and those whose transaction changed the document (push, insert, pull, attrs) */
  steps: number;
  docSteps: number;
  /** ms in paginatePage (measure, cut, building the transaction) */
  stepMs: number;
  /** ms in dispatch (state apply, DOM update, editor listeners) */
  dispatchMs: number;
  /** steps per action */
  actions: Partial<Record<StepResult['action'], number>>;
  /** the run ended with pagination settled */
  settled: boolean;
  /**
   * each step: the page, what it did, ms in paginatePage (measuring included) and in its dispatch
   * (0 while held), and the page count after it
   */
  detail: { page: number; action: StepResult['action']; stepMs: number; dispatchMs: number; pages: number }[];
  /** settleNow (no budget) */
  forced: boolean;
}

let profiler: ((frame: PaginationFrameProfile) => void) | null = null;

/**
 * Reports every scheduler run of every paginated editor to `fn` (performance work, dev pages);
 * null stops. Costs nothing while unset.
 */
export function setPaginationProfiler(fn: ((frame: PaginationFrameProfile) => void) | null): void {
  profiler = fn;
}

/**
 * Page indexes (in the final doc) touched by a transaction: [first, last]. One pass over the
 * steps (a replace-all can have thousands): the range so far is kept in the coordinates after the
 * current step and mapped through each following step. Mapping is monotonic, so keeping the
 * smallest and largest position per association (-1 / 1) gives exactly the range of mapping
 * every step's own range through all the steps after it.
 */
export function changedPages(tr: Transaction): [number, number] {
  const range = changedRange(tr);
  return range ? pagesOf(tr.doc, range) : [0, 0];
}

/** Page indexes of positions [from, to] of `doc` (clamped to the document). */
function pagesOf(doc: PMNode, [from, to]: [number, number]): [number, number] {
  const size = doc.content.size;
  const index = (pos: number) => Math.min(doc.resolve(Math.max(0, Math.min(pos, size))).index(0), doc.childCount - 1);
  return [index(from), index(to)];
}

/**
 * Whether a change starting at `from` on page `a` can let the page before it pull content back:
 * only a page after an auto page's start can pull from it (content never crosses a section start),
 * and only what it would pull can have changed: the page's leading headings and the block after
 * them (pullTarget never pulls a heading without the block after it; a whole block that didn't
 * fit before doesn't fit now; a later block is only pulled after them). An attribute change of
 * the page itself (kind, for one: removeSectionBreak) starts at its position, so it counts.
 */
function reachesPreviousPage(doc: PMNode, a: number, from: number): boolean {
  const page = a > 0 ? pageAt(doc, a) : null;
  if (!page) return false;
  if (page.node.attrs.kind !== 'auto') return from <= page.contentStart;
  let end = page.contentStart;
  for (let i = 0; i < page.node.childCount; i++) {
    const child = page.node.child(i);
    end += child.nodeSize;
    if (child.type.name !== 'heading') break;
  }
  return from <= end;
}

/**
 * Positions (in the final doc) touched by a transaction: [first, last], or null when no step
 * touched a position (nothing to check).
 */
function changedRange(tr: Transaction): [number, number] | null {
  let minBack = Infinity; // smallest start, associated backward (-1)
  let minFwd = Infinity; // … forward (1)
  let maxBack = -Infinity; // largest end, associated backward
  let maxFwd = -Infinity; // … forward
  let all = false;
  tr.steps.forEach((step, i) => {
    const map = tr.mapping.maps[i]!;
    if (minBack !== Infinity) minBack = map.map(minBack, -1);
    if (minFwd !== Infinity) minFwd = map.map(minFwd, 1);
    if (maxBack !== -Infinity) maxBack = map.map(maxBack, -1);
    if (maxFwd !== -Infinity) maxFwd = map.map(maxFwd, 1);
    let mapped = false;
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      mapped = true;
      minBack = Math.min(minBack, newFrom);
      maxFwd = Math.max(maxFwd, newTo);
    });
    if (mapped) return;
    // Steps that don't move positions: marks (from, to), node attributes and marks (pos).
    const s = step as unknown as { from?: unknown; to?: unknown; pos?: unknown };
    if (typeof s.from === 'number' && typeof s.to === 'number') {
      minFwd = Math.min(minFwd, s.from);
      maxBack = Math.max(maxBack, s.to);
    } else if (typeof s.pos === 'number') {
      minFwd = Math.min(minFwd, s.pos);
      maxFwd = Math.max(maxFwd, s.pos);
    } else all = true; // doc attributes: everything
  });
  const size = tr.doc.content.size;
  let min = Math.min(minBack, minFwd);
  let max = Math.max(maxBack, maxFwd);
  if (all) {
    min = Math.min(min, 0);
    max = Math.max(max, size);
  }
  if (min === Infinity) return null;
  return [Math.max(0, Math.min(min, size)), Math.max(0, Math.min(max, size))];
}

/**
 * A REPAGINATE payload as a page range within the document: a page index, or { from, to? }
 * (fractions floored, clamped to the pages). null when it is anything else.
 */
function repaginateRange(meta: unknown, last: number): { from: number; to: number } | null {
  const index = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null);
  let from: number | null = null;
  let to: number | null = last;
  if (typeof meta === 'number') from = index(meta);
  else if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const range = meta as { from?: unknown; to?: unknown };
    from = index(range.from);
    if (range.to !== undefined) to = index(range.to);
  }
  if (from === null || to === null) return null;
  from = Math.max(0, Math.min(from, last));
  return { from, to: Math.max(from, Math.min(to, last)) };
}

/** Sorted, without duplicates. */
const sortedPages = (pages: Iterable<number>): number[] => [...new Set(pages)].sort((a, b) => a - b);

/** Page indexes of `oldDoc` mapped through `tr` (each to the page its content start lands in). */
function mapPages(pages: number[], tr: Transaction, oldDoc: PMNode): number[] {
  if (pages.length === 0 || !tr.docChanged) return pages;
  const out: number[] = [];
  for (const index of pages) {
    const page = pageAt(oldDoc, index);
    if (page) out.push(pageIndexAt(tr.doc, tr.mapping.map(page.contentStart, 1)));
  }
  return sortedPages(out);
}

/** Measure-only steps held back in runSteps: the last one, and those before it. */
interface Held {
  step: StepResult;
  batch: PaginateStep[];
}

/** Steps held back when they change nothing in the document (see runSteps). */
const HOLDABLE: ReadonlySet<StepAction> = new Set<StepAction>(['settled', 'oversized', 'waiting', 'done']);

/** Steps that measure a page (the page's waiting, if any, is over). */
const MEASURED: ReadonlySet<string> = new Set(['push', 'insert', 'pull', 'oversized', 'settled']);

/**
 * Whether `tr` only changes attributes of manual pages other than `kind` (section settings,
 * markers, objects): the page before such a page can't pull from it, so the check starts at it.
 */
function manualPageAttrsOnly(tr: Transaction): boolean {
  return (
    tr.steps.length > 0 &&
    tr.steps.every((step, k) => {
      if (!(step instanceof AttrStep) || step.attr === 'kind') return false;
      const doc = tr.docs[k]!;
      const node = doc.nodeAt(step.pos);
      return node !== null && node.type.name === 'page' && node.attrs.kind !== 'auto' && doc.resolve(step.pos).depth === 0;
    })
  );
}

function applyPagination(tr: Transaction, prev: PaginationState, oldState: EditorState, logger: Pick<Console, 'warn'>): PaginationState {
  const own = tr.getMeta(PAGINATE) as PaginateMeta | undefined;
  if (own) {
    let waiting = prev.waiting;
    // The measure-only steps sent with this transaction, then its own (page indexes before it).
    for (const step of paginateSteps(own)) {
      if (step.action === 'waiting') waiting = waiting.includes(step.page) ? waiting : sortedPages([...waiting, step.page]);
      else if (MEASURED.has(step.action) && waiting.includes(step.page)) waiting = waiting.filter((p) => p !== step.page);
    }
    waiting = mapPages(waiting, tr, oldState.doc);
    const stats = { ...prev.stats };
    const batched = own.batch?.length ?? 0;
    stats.steps += batched;
    stats.settleSteps += batched;
    if (own.action === 'guard') stats.guardHits += 1;
    else if (own.action === 'error') stats.errors += 1;
    else if (own.action !== 'retry') {
      stats.steps += 1;
      stats.settleSteps += 1;
      if (own.action === 'push') stats.pushes += 1;
      else if (own.action === 'insert') stats.inserts += 1;
      else if (own.action === 'pull') stats.pulls += 1;
    }
    if (own.dirtyFrom === null) {
      stats.settles += 1;
      stats.lastSettleSteps = stats.settleSteps;
      stats.maxSettleSteps = Math.max(stats.maxSettleSteps, stats.settleSteps);
      stats.settleSteps = 0;
    }
    return {
      dirtyFrom: own.dirtyFrom,
      dirtyTo: own.dirtyTo,
      blocked: own.action === 'blocked',
      rechecked: own.dirtyFrom === null ? null : (own.rechecked ?? prev.rechecked),
      waiting,
      parity: own.dirtyFrom === null ? false : (own.parity ?? prev.parity),
      stats,
    };
  }

  const last = tr.doc.childCount - 1;
  const meta = tr.getMeta(REPAGINATE) as unknown;
  const forced = meta === undefined ? null : repaginateRange(meta, last);
  if (meta !== undefined && forced === null) logger.warn('[pagination] REPAGINATE needs a page index or { from, to? }; ignored', meta);
  // Heading ids and page ids: attribute changes that can't change the layout.
  const neutral = tr.getMeta(LAYOUT_NEUTRAL_META) === true;
  const waiting = mapPages(prev.waiting, tr, oldState.doc);
  // Every REPAGINATE counts (the layout's memo of failed pulls is forgotten then).
  const base = meta === undefined ? prev : { ...prev, stats: { ...prev.stats, repaginations: prev.stats.repaginations + 1 } };
  if (forced === null && (!tr.docChanged || neutral)) return waiting === prev.waiting ? base : { ...base, waiting };

  let from = Infinity;
  let to = -Infinity;
  if (forced !== null) {
    from = forced.from;
    to = forced.to;
  }
  if (tr.docChanged && !neutral) {
    const range = changedRange(tr);
    const [a, b] = range ? pagesOf(tr.doc, range) : [0, 0];
    // The previous page may now have room, unless only settings of a section start changed, or
    // the change is past what that page could pull from this one (P8.1: typing mid-page checks
    // one page, not two).
    const previous = !manualPageAttrsOnly(tr) && (range === null || reachesPreviousPage(tr.doc, a, range[0]));
    from = Math.min(from, previous ? Math.max(0, a - 1) : a);
    to = Math.max(to, b);
  }
  const shift = Math.max(0, tr.doc.childCount - oldState.doc.childCount);
  const running = prev.dirtyFrom !== null;
  return {
    dirtyFrom: running ? Math.min(prev.dirtyFrom!, from) : from,
    dirtyTo: Math.min(last, Math.max(running ? prev.dirtyTo + shift : -1, to)),
    blocked: false,
    rechecked: null,
    waiting,
    // Pages added or removed by the author (page break, joined pages) shift the parity of the
    // pages after them, like pagination's own inserts.
    parity: (running && prev.parity) || tr.doc.childCount !== oldState.doc.childCount,
    // The author is active: count this settle's steps from here (the loop guard is about
    // pagination feeding itself, not about a long typing session).
    stats: { ...base.stats, settleSteps: 0 },
  };
}

/** Pages (in `doc`, the document after `trs`) that the author's transactions changed, or null. */
function touchedPages(trs: readonly Transaction[], doc: PMNode): [number, number] | null {
  let first = Infinity;
  let last = -Infinity;
  for (const tr of trs) {
    if (!isAuthorChange(tr)) continue;
    const [a, b] = changedPages(tr);
    first = Math.min(first, a);
    last = Math.max(last, b);
  }
  if (first === Infinity) return null;
  const end = doc.childCount - 1;
  return [Math.min(first, end), Math.min(last, end)];
}

/**
 * appendTransaction: after the author's changes, fragments whose head was deleted become blocks
 * of their own, formatting is shared between the fragments of each block, and continuation flags
 * no chain reaches any more are repaired (fragments.ts); pages with objects or markers that a
 * range delete joined away come back, and a page kept only for them that lost them goes
 * (pageData.ts). One transaction, in the author's undo event.
 */
function appendFragmentFixes(trs: readonly Transaction[], oldState: EditorState, state: EditorState): Transaction | null {
  if (!trs.some(isAuthorChange)) return null;
  // Typing (text or marks inside a textblock) opens, closes, joins and deletes no block and
  // changes no attribute: there is nothing to fix, and no walk over every page per keystroke (P8.1).
  if (trs.every((tr) => !isAuthorChange(tr) || inlineOnly(tr))) return null;
  const tr = state.tr;
  const pages = touchedPages(trs, state.doc);
  clearOrphanedContinuations(tr, trs, oldState.doc);
  // Attribute steps only up to here (positions after `trs` stay valid).
  addSharedFragmentAttrs(tr, trs, pages);
  repairContinuations(tr, trs, oldState.doc, pages);
  restoreJoinedPages(tr, trs, oldState.doc);
  dropEmptiedPlaceholders(tr, trs, oldState.doc);
  return tr.steps.length > 0 ? tr.setMeta(FRAGMENT_ATTRS, true) : null;
}

const schedulers = new WeakMap<EditorView, PaginationScheduler>();

/** The pagination ProseMirror plugin. Add it through the Pagination extension (extension.ts). */
export function paginationPlugin(opts: PaginationOptions = {}): Plugin<PaginationState> {
  return new Plugin<PaginationState>({
    key: paginationKey,
    state: {
      // Verify the stored layout on load: saved documents include their auto pages.
      init: (_config, state) => ({
        dirtyFrom: 0,
        dirtyTo: state.doc.childCount - 1,
        blocked: false,
        rechecked: null,
        waiting: [],
        parity: false,
        stats: emptyStats(),
      }),
      apply: (tr, prev, oldState) => applyPagination(tr, prev, oldState, opts.logger ?? console),
    },
    appendTransaction: appendFragmentFixes,
    view: (view) => new PaginationScheduler(view, opts),
  });
}

/** `layout` with parityMatters forced by the `parity` option (true / false), or as it is ('auto'). */
function withParity(layout: PageLayout<LayoutMeasure>, parity: PaginationOptions['parity']): PageLayout<LayoutMeasure> {
  if (parity === undefined || parity === 'auto') return layout;
  return {
    measure: (page) => layout.measure(page),
    ...(layout.isHidden ? { isHidden: () => layout.isHidden!() } : {}),
    ...(layout.isVisible ? { isVisible: (index: number) => layout.isVisible!(index) } : {}),
    chooseCut: (page, m) => layout.chooseCut(page, m),
    pullTarget: (page, m, next) => layout.pullTarget(page, m, next),
    parityMatters: () => parity,
  };
}

class PaginationScheduler implements PluginView {
  private readonly view: EditorView;
  private readonly layout: PageLayout<LayoutMeasure>;
  private readonly budgetMs: number;
  private readonly isReady: () => boolean;
  private readonly maxSteps: (doc: PMNode) => number;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly requestTask: ((callback: () => void) => void) | null;
  /** a between-frames task is pending (see continueOffscreen) */
  private task = false;
  private readonly now: () => number;
  private readonly onSettle?: (info: SettleInfo) => void;
  private readonly logger: Pick<Console, 'error' | 'warn'>;
  private frame: number | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** re-checks the pages waiting for an image's size */
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  /** retries since the last change while the editor is hidden */
  private retries = 0;
  private dispatching = false;
  private dirtySince: number | null = null;
  /** pages whose images loaded since the last check (flushed in a microtask) */
  private loaded: { from: number; to: number } | null = null;
  private readonly onLoad = (event: Event): void => this.imageLoaded(event.target);

  constructor(view: EditorView, opts: PaginationOptions) {
    this.view = view;
    this.layout = withParity((opts.layout ?? domLayout)(view), opts.parity);
    this.budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    this.isReady = opts.isReady ?? (() => true);
    const max = opts.maxStepsPerSettle ?? defaultMaxSteps;
    this.maxSteps = typeof max === 'number' ? () => max : max;
    this.requestFrame = opts.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = opts.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.requestTask =
      opts.requestTask !== undefined ? opts.requestTask : opts.requestFrame === undefined && typeof MessageChannel !== 'undefined' ? messageTask : null;
    this.now = opts.now ?? (() => performance.now());
    this.onSettle = opts.onSettle;
    this.logger = opts.logger ?? console;
    schedulers.set(view, this);
    // load and error don't bubble: listen in the capture phase.
    view.dom.addEventListener('load', this.onLoad, true);
    view.dom.addEventListener('error', this.onLoad, true);
    this.update();
  }

  update(): void {
    if (this.dispatching) return;
    this.watchWaiting();
    const st = paginationKey.getState(this.view.state);
    if (!st || st.dirtyFrom === null) {
      this.dirtySince = null;
      return;
    }
    this.dirtySince ??= this.now();
    if (!st.blocked) {
      this.retries = 0; // a change (or REPAGINATE) re-arms the retries
      this.schedule();
    }
  }

  /** Whether passes wait: IME composition, or the theme and fonts still loading (see run). */
  paused(): boolean {
    return this.view.composing || !this.isReady();
  }

  destroy(): void {
    if (this.frame !== null) this.cancelFrame(this.frame);
    if (this.retry !== null) clearTimeout(this.retry);
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.view.dom.removeEventListener('load', this.onLoad, true);
    this.view.dom.removeEventListener('error', this.onLoad, true);
    this.frame = null;
    this.retry = null;
    this.waitTimer = null;
    schedulers.delete(this.view);
  }

  /**
   * While pages wait for an image's size, checks them again after WAITING_RECHECK_MS (their
   * image's load usually comes first and checks them sooner, see imageLoaded).
   */
  private watchWaiting(): void {
    if (this.waitTimer !== null || this.view.isDestroyed) return;
    if ((paginationKey.getState(this.view.state)?.waiting.length ?? 0) === 0) return;
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      if (this.view.isDestroyed) return;
      const waiting = paginationKey.getState(this.view.state)?.waiting ?? [];
      if (waiting.length > 0) repaginate(this.view, waiting[0], waiting[waiting.length - 1]);
    }, WAITING_RECHECK_MS);
  }

  /** An image a measurement saw unloaded has loaded (or failed): its page is checked again. */
  private imageLoaded(target: EventTarget | null): void {
    if (!(target instanceof HTMLImageElement) || !pendingImages.has(target)) return;
    pendingImages.delete(target);
    if (this.view.isDestroyed || !this.view.dom.contains(target)) return;
    let pos: number;
    try {
      pos = this.view.posAtDOM(target, 0);
    } catch {
      return;
    }
    const page = pageIndexAt(this.view.state.doc, pos);
    const flush = this.loaded === null;
    this.loaded = { from: Math.min(this.loaded?.from ?? page, page), to: Math.max(this.loaded?.to ?? page, page) };
    if (!flush) return;
    // Images of one page often load together: one check for all of them.
    queueMicrotask(() => {
      const range = this.loaded;
      this.loaded = null;
      if (range && !this.view.isDestroyed) repaginate(this.view, range.from, range.to);
    });
  }

  private schedule(): void {
    if (this.frame !== null || this.view.isDestroyed) return;
    this.frame = this.requestFrame(() => {
      this.frame = null;
      this.run(this.budgetMs);
    });
  }

  /**
   * Runs steps until the pages are settled or `budgetMs` is spent (at least one step). Runs in
   * requestAnimationFrame, before paint, so a line that overflows while typing has moved before
   * the frame is drawn. Returns whether pagination is settled.
   */
  run(budgetMs: number, force = false): boolean {
    const report = profiler;
    if (!report) return this.runSteps(budgetMs, force, null);
    const frame: PaginationFrameProfile = {
      start: performance.now(),
      end: 0,
      steps: 0,
      docSteps: 0,
      stepMs: 0,
      dispatchMs: 0,
      actions: {},
      settled: false,
      forced: force,
      detail: [],
    };
    const done = this.runSteps(budgetMs, force, frame);
    frame.end = performance.now();
    frame.settled = done && !this.view.isDestroyed && paginationKey.getState(this.view.state)?.dirtyFrom === null;
    if (frame.steps > 0) report(frame);
    return done;
  }

  private runSteps(budgetMs: number, force: boolean, frame: PaginationFrameProfile | null): boolean {
    const { view } = this;
    if (view.isDestroyed) return true;
    if (!force && (view.composing || !this.isReady())) {
      // IME composition or fonts still loading: look again next frame.
      this.schedule();
      return false;
    }
    const deadline = this.now() + budgetMs;
    let last: StepResult['action'] | null = null;
    let extra = 0;
    // Steps that only measured (nothing in the document changed) are not dispatched one by one
    // (P8.1): the next step continues from their progress, and they go out with the next
    // transaction (PaginateMeta.batch), or on their own when the frame ends or the pass settles.
    // A dispatch runs every plugin, the view update and the editor's listeners (React selectors);
    // a settled page doesn't need any of that.
    let held: Held | null = null;
    const flush = (): void => {
      if (!held) return;
      const { step, batch } = held;
      held = null;
      this.dispatchStep(step, batch, frame);
    };
    for (;;) {
      const st = paginationKey.getState(view.state);
      if (!st) return true;
      // Where the pass is: the state, or the progress of the steps held back.
      const progress: PaginationProgress = held ? held.step.progress : st;
      if (progress.dirtyFrom === null) {
        flush();
        return true;
      }
      if (st.blocked) {
        this.retryLater();
        return false;
      }
      // Out of budget: continue next frame. Never right after a pull, though: a pull may join
      // more onto the page than fits, and the next step (the same page, measured again) cuts
      // it back. A frame painted in between would show the content jump back and forth. Pages in
      // view settle before paint too (a push from the typed page onto the next one, on screen):
      // a few steps past the budget while the next page to check is visible.
      if (last !== null && last !== 'pull' && this.now() >= deadline) {
        const inView = this.layout.isVisible?.(progress.dirtyFrom) ?? false;
        if (!inView || extra >= MAX_STEPS_PAST_BUDGET) {
          flush();
          this.schedule();
          // Offscreen pages go on between the frames; pages in view wait for the next frame.
          if (!inView) this.continueOffscreen();
          return false;
        }
        extra += 1;
      }
      const limit = this.maxSteps(view.state.doc);
      const settleSteps = st.stats.settleSteps + (held ? held.batch.length + 1 : 0);
      if (settleSteps >= limit) {
        flush();
        const now = paginationKey.getState(view.state)!;
        this.logger.error(`[pagination] loop guard: a settle took ${settleSteps} steps (limit ${limit}); stopped at page ${progress.dirtyFrom}`);
        this.stop(now, 'guard');
        return true;
      }
      let step: StepResult;
      const t0 = frame ? performance.now() : 0;
      try {
        step = paginatePage(view.state, progress, this.layout);
      } catch (error) {
        flush();
        this.logger.error('[pagination] step failed; pagination stopped until the next change', error);
        this.stop(paginationKey.getState(view.state)!, 'error');
        return true;
      }
      if (frame) {
        const ms = performance.now() - t0;
        frame.stepMs += ms;
        frame.detail.push({ page: step.page, action: step.action, stepMs: ms, dispatchMs: 0, pages: step.tr.doc.childCount });
        frame.steps += 1;
        if (step.tr.docChanged) frame.docSteps += 1;
        frame.actions[step.action] = (frame.actions[step.action] ?? 0) + 1;
      }
      const batch: PaginateStep[] = held ? [...held.batch, { page: held.step.page, action: held.step.action }] : [];
      if (!step.tr.docChanged && HOLDABLE.has(step.action)) held = { step, batch };
      else {
        held = null;
        this.dispatchStep(step, batch, frame);
      }
      last = step.action;
      if (step.progress.dirtyFrom === null) {
        flush();
        this.settled();
      }
    }
  }

  /**
   * Offscreen pages don't need a frame of their own (P8.1): while the pass is offscreen, it goes on
   * in tasks between the frames, a budget at a time, so a long pass (a theme switch, a cascade
   * through a long section) uses the whole frame interval instead of a budget per frame. Input
   * and rendering come in between the tasks (in Chromium, a task also ends early while input is
   * waiting); pages in view are left to the frames, which settle them before paint.
   */
  private continueOffscreen(): void {
    if (this.task || !this.requestTask || this.view.isDestroyed) return;
    this.task = true;
    this.requestTask(() => {
      this.task = false;
      if (this.view.isDestroyed || this.dispatching || this.paused()) return;
      const st = paginationKey.getState(this.view.state);
      if (!st || st.dirtyFrom === null || st.blocked) return;
      if (inputPending() || (this.layout.isVisible?.(st.dirtyFrom) ?? false)) return; // the next frame
      this.run(this.budgetMs);
    });
  }

  /** Dispatches a step's transaction with the measure-only steps held back before it. */
  private dispatchStep(step: StepResult, batch: PaginateStep[], frame: PaginationFrameProfile | null): void {
    if (batch.length > 0) {
      const meta = step.tr.getMeta(PAGINATE) as PaginateMeta;
      step.tr.setMeta(PAGINATE, { ...meta, batch });
    }
    const t0 = frame ? performance.now() : 0;
    this.dispatch(step.tr);
    if (frame) {
      const ms = performance.now() - t0;
      frame.dispatchMs += ms;
      const last = frame.detail[frame.detail.length - 1];
      if (last) last.dispatchMs = ms;
    }
  }

  private stop(st: PaginationState, action: 'guard' | 'error'): void {
    const meta: PaginateMeta = { dirtyFrom: null, dirtyTo: st.dirtyTo, rechecked: null, action };
    this.dispatch(this.view.state.tr.setMeta(PAGINATE, meta).setMeta('addToHistory', false));
    this.settled();
  }

  private settled(): void {
    const stats = paginationKey.getState(this.view.state)?.stats;
    if (stats && this.onSettle) {
      this.onSettle({ steps: stats.lastSettleSteps, ms: this.dirtySince === null ? 0 : this.now() - this.dirtySince, stats });
    }
    this.dirtySince = null;
  }

  private dispatch(tr: Transaction): void {
    this.dispatching = true;
    try {
      this.view.dispatch(tr);
    } finally {
      this.dispatching = false;
    }
    this.watchWaiting();
  }

  private retryLater(): void {
    if (this.retry !== null || this.retries >= BLOCKED_RETRIES) return; // wait for the next change
    const delay = BLOCKED_RETRY_MS * 2 ** this.retries;
    this.retries += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.view.isDestroyed) return;
      const st = paginationKey.getState(this.view.state);
      if (st?.blocked && st.dirtyFrom !== null) {
        // Clear the flag and try again.
        const meta: PaginateMeta = { dirtyFrom: st.dirtyFrom, dirtyTo: st.dirtyTo, action: 'retry' };
        this.dispatch(this.view.state.tr.setMeta(PAGINATE, meta).setMeta('addToHistory', false));
        this.schedule();
      }
    }, delay);
  }
}

/**
 * Forces a check of pages `from`…`to` (default: all). For fonts, theme and CSS changes, image
 * loads. Fractions are floored and indexes clamped to the pages; non-finite ones are ignored.
 */
export function repaginate(view: EditorView, from = 0, to?: number): void {
  if (!Number.isFinite(from) || (to !== undefined && !Number.isFinite(to))) return;
  const last = Math.max(0, view.state.doc.childCount - 1);
  const clamp = (n: number) => Math.max(0, Math.min(Math.floor(n), last));
  const start = clamp(from);
  const meta: RepaginateMeta = to === undefined ? start : { from: start, to: Math.max(start, clamp(to)) };
  view.dispatch(view.state.tr.setMeta(REPAGINATE, meta).setMeta('addToHistory', false));
}

/**
 * Whether pagination is paused in `view`: it does no work while the author composes text (IME) or
 * before the theme and fonts are ready, even with pages left to check (isPaginating). False
 * without the plugin.
 */
export function isPaginationPaused(view: EditorView): boolean {
  return schedulers.get(view)?.paused() ?? false;
}

/**
 * Settles pagination synchronously, without the frame budget (print, export, tests). Waits for
 * nothing: IME and fonts gates are ignored. Returns whether it settled (false without the plugin).
 */
export function settleNow(view: EditorView): boolean {
  const scheduler = schedulers.get(view);
  return scheduler ? scheduler.run(Infinity, true) : false;
}
