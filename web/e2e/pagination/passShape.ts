// The shape of a pagination pass, checked against the rules of step.ts. The perf and S2 specs
// assert it instead of time budgets: which pages a pass checks, and how often, is the same on every
// run (it depends on the layout and the edit, not on how fast the machine is), while its time and
// its frames are not (the scheduler slices the pass by time, plugin.ts budgetMs).
//
// step.ts: "the work only moves forward: a page is checked again only after a pull onto it or once
// after a push". Each step is one measurement of one page (plan §4.10: each page costs one
// measurement, a page whose boundary moves one dispatch more), and after it the pass
//
//   settled, oversized, waiting   moves on to the next page
//   push, insert                  checks the page once more (its one re-check), or moves on when
//                                 that re-check pushed again
//   pull                          measures the page again (or, after a pull onto a page kept only
//                                 for its objects, the page before it)
//
// So a pass that visits V pages takes at most 2 × V steps plus one per pull.

export interface PassStep {
  page: number;
  action: string;
}

export interface PassShape {
  steps: number;
  pulls: number;
  pushes: number;
  inserts: number;
  /** runs of steps on one page (a page checked again after a pull onto the page after it counts again) */
  visits: number;
  /** pages the pass stepped back to (after a pull onto a page kept only for its objects) */
  backs: number;
  /** the first and last page the pass checked */
  first: number | null;
  last: number | null;
  /** where the pass broke the rules above (empty: none) */
  violations: string[];
}

const MOVES_ON = new Set(['settled', 'oversized', 'waiting', 'done']);
const PUSHES = new Set(['push', 'insert']);

/** The shape of `steps`, one pass that starts at page `from`. */
export function passShape(steps: readonly PassStep[], from: number): PassShape {
  const violations: string[] = [];
  const count = (action: string) => steps.filter((s) => s.action === action).length;
  if (steps.length > 0 && steps[0]!.page !== from) violations.push(`the pass starts at page ${steps[0]!.page}, not ${from}`);
  let visits = steps.length > 0 ? 1 : 0;
  let backs = 0;
  // The page whose one re-check after a push was taken (step.ts PaginationProgress.rechecked).
  let rechecked: number | null = null;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1]!;
    const step = steps[i]!;
    const at = `step ${i} (${prev.action} on page ${prev.page}, then ${step.action} on page ${step.page})`;
    let expected: 'stay' | 'next' | 'stay or back';
    if (MOVES_ON.has(prev.action)) expected = 'next';
    else if (PUSHES.has(prev.action)) expected = rechecked === prev.page ? 'next' : 'stay';
    else if (prev.action === 'pull') expected = 'stay or back';
    else {
      violations.push(`${at}: unknown action ${prev.action}`);
      continue;
    }
    if (step.page === prev.page + 1 && expected === 'next') visits += 1;
    else if (step.page === prev.page && expected !== 'next') {
      if (PUSHES.has(prev.action)) rechecked = prev.page;
    } else if (step.page === prev.page - 1 && expected === 'stay or back') {
      visits += 1;
      backs += 1;
    } else violations.push(`${at}: expected ${expected === 'next' ? `page ${prev.page + 1}` : `page ${prev.page} again`}`);
  }
  return {
    steps: steps.length,
    pulls: count('pull'),
    pushes: count('push'),
    inserts: count('insert'),
    visits,
    backs,
    first: steps[0]?.page ?? null,
    last: steps.at(-1)?.page ?? null,
    violations,
  };
}

/** The most steps a pass of `shape`'s visits and pulls can take (the rules above). */
export const passStepLimit = (shape: Pick<PassShape, 'visits' | 'pulls'>): number => 2 * shape.visits + shape.pulls;
