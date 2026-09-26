// Pagination plugin state, keys and transaction metas (plan §4.7). Kept apart from plugin.ts
// so step.ts and plugin.ts don't import each other.
import { PluginKey, type EditorState } from '@tiptap/pm/state';

/** Counters for debugging and tests (never saved). */
export interface PaginationStats {
  /** settles completed since the editor started */
  settles: number;
  /** pagination steps since the editor started (one page measured per step) */
  steps: number;
  /** steps in the settle in progress (reset when the author changes the document) */
  settleSteps: number;
  /** steps of the last completed settle */
  lastSettleSteps: number;
  /** most steps any settle took */
  maxSettleSteps: number;
  /** settles stopped by the loop guard (should stay 0) */
  guardHits: number;
  /** steps that threw (should stay 0) */
  errors: number;
  /** boundary moves: content pushed forward, new auto pages, content pulled back */
  pushes: number;
  inserts: number;
  pulls: number;
  /** REPAGINATE requests (theme, CSS, fonts, image loads): what was measured before may be stale */
  repaginations: number;
}

export interface PaginationState {
  /** next page index to check; null = settled */
  dirtyFrom: number | null;
  /** last page index that needs checking because of a change */
  dirtyTo: number;
  /** a page couldn't be measured (editor hidden); retried later, counts as settled */
  blocked: boolean;
  /** the page whose one re-check after a push was done in this pass (step.ts) */
  rechecked: number | null;
  /**
   * Pages skipped because an image in their flow has no size yet (sorted page indexes, mapped
   * through every change). Not settled while any is waiting: the image's load, or a timer once
   * measurements stop waiting for it, checks the page again (plan §4.7, review finding PG-5).
   */
  waiting: number[];
  /**
   * The page count changed during this pass, so pages after dirtyTo may have changed parity (odd
   * and even page styles). step.ts asks the layout once whether parity matters and, if it does,
   * continues to the last page (plan §4.7 triggers).
   */
  parity: boolean;
  stats: PaginationStats;
}

export const paginationKey = new PluginKey<PaginationState>('hbPagination');

/** Meta on every pagination transaction (with addToHistory: false). Autosave ignores them. */
export const PAGINATE = 'hbPaginate';

/**
 * Meta on the transaction the section sync appends (sections.ts, addToHistory false): section
 * settings copied from a section's first page to its auto pages.
 */
export const SECTION_SYNC = 'hbSectionSync';

/**
 * Meta that forces a check: a page index (from that page to the end) or { from, to }. For
 * fonts loading, theme or user CSS changes, image loads (plan §4.7 triggers).
 */
export const REPAGINATE = 'hbRepaginate';
export type RepaginateMeta = number | { from: number; to?: number };

/** What one step did (StepResult.action). */
export type StepAction =
  | 'push' // content after the cut moved to the next (auto) page
  | 'insert' // a new auto page was created for it
  | 'pull' // content of the next auto page moved back
  | 'oversized' // overflow that nothing can fix; page flagged
  | 'settled' // this page is fine
  | 'waiting' // an image in the page's flow has no size yet: skipped, checked again once it has
  | 'blocked' // the page isn't laid out
  | 'done'; // nothing left to check

/** Payload of the PAGINATE meta. */
export interface PaginateMeta {
  dirtyFrom: number | null;
  dirtyTo: number;
  rechecked?: number | null;
  /** the page the step looked at (absent for guard, error and retry) */
  page?: number;
  /** PaginationState.parity after the step (absent: unchanged) */
  parity?: boolean;
  /** guard / error: the scheduler stopped the settle; retry: clears `blocked` (not a step) */
  action: StepAction | 'guard' | 'error' | 'retry';
  /**
   * Steps that only measured (they changed nothing in the document) and ran right before this one,
   * in order: the scheduler doesn't dispatch them one by one but sends them with the next
   * transaction (plan §4.10, P8.1). Read every step of a meta with paginateSteps().
   */
  batch?: PaginateStep[];
}

/** One pagination step: the page it checked (a page index before the transaction) and what it did. */
export interface PaginateStep {
  page: number;
  action: StepAction;
}

/**
 * Every step a PAGINATE meta stands for, in order: the measure-only steps sent with it (`batch`),
 * then its own (none for guard, error and retry).
 */
export function paginateSteps(meta: PaginateMeta): PaginateStep[] {
  const own: PaginateStep[] =
    meta.page !== undefined && meta.action !== 'guard' && meta.action !== 'error' && meta.action !== 'retry' ? [{ page: meta.page, action: meta.action }] : [];
  return meta.batch && meta.batch.length > 0 ? [...meta.batch, ...own] : own;
}

export const emptyStats = (): PaginationStats => ({
  settles: 0,
  steps: 0,
  settleSteps: 0,
  lastSettleSteps: 0,
  maxSettleSteps: 0,
  guardHits: 0,
  errors: 0,
  pushes: 0,
  inserts: 0,
  pulls: 0,
  repaginations: 0,
});

/** The pagination state of `state` (undefined without the plugin). */
export const paginationState = (state: EditorState): PaginationState | undefined => paginationKey.getState(state);

/**
 * Whether pagination has settled: every page fits (or is flagged oversized) and no page waits
 * for an image's size. Autosave waits for this. True without the pagination plugin, and while
 * pages can't be measured (hidden editor).
 */
export function isSettled(state: EditorState): boolean {
  const s = paginationKey.getState(state);
  return !s || s.blocked || (s.dirtyFrom === null && s.waiting.length === 0);
}

/** Whether a pass is running: pages are left to check (false while it only waits for images). */
export function isPaginating(state: EditorState): boolean {
  const s = paginationKey.getState(state);
  return !!s && !s.blocked && s.dirtyFrom !== null;
}
