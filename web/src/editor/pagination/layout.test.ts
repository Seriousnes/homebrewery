// layout.ts FailedPulls (P8.1): a pull whose content all came back is not tried again while what it
// was decided on is unchanged. The DOM parts of layout.ts run in web/e2e/pagination.
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { pageAt } from './boundary';
import { FailedPulls } from './layout';
import type { PageMeasure } from './measure';
import { AUTO, DOC, P, PAGE } from './testing';

/** A measurement with `free` px left in the second column. */
function measured(free: number): PageMeasure {
  return {
    box: { left: 0, top: 0, right: 600, bottom: 900, width: 600, height: 900 },
    scale: 1,
    eps: 0.5,
    columns: 2,
    gap: 20,
    columnWidth: 290,
    rtl: false,
    overflow: false,
    first: null,
    rowTop: 0,
    lastColumn: 1,
    lastBottom: 900 - free,
    lastMarginBottom: 0,
    columnFree: [0, free],
    freeSpace: free,
  };
}

const before = () => DOC(PAGE({ pid: 'aaaaaaaa' }, P('alpha'), P('last block')), AUTO(null, P('first block'), P('more')));
/** Page 0 after pulling "first block" onto it. */
const pulled = () => DOC(PAGE({ pid: 'aaaaaaaa' }, P('alpha'), P('last block'), P('first block')), AUTO(null, P('more')));

function tryPull(memo: FailedPulls, doc: PMNode, free: number, generation = 0): number | null {
  const page = pageAt(doc, 0)!;
  const next = pageAt(doc, 1)!;
  return memo.allow(page, measured(free), next, next.contentStart + next.node.child(0).nodeSize, generation);
}

describe('FailedPulls', () => {
  it('remembers a pull that was pushed back whole, and refuses the same pull again', () => {
    const memo = new FailedPulls();
    const doc = before();
    expect(tryPull(memo, doc, 20)).not.toBeNull();
    memo.judge(pulled(), 0); // the measurement after the pull: page 0 grew
    memo.judge(before(), 0); // then pushed back: page 0 is as before (another node, equal)
    expect(memo.list()).toEqual([expect.objectContaining({ last: 'paragraph', first: 'paragraph', continuation: false })]);
    expect(tryPull(memo, before(), 20)).toBeNull();
    // Anything the estimate depends on changed: tried again.
    expect(tryPull(memo, before(), 40)).not.toBeNull();
    const typed = DOC(PAGE({ pid: 'aaaaaaaa' }, P('alpha'), P('last block!')), AUTO(null, P('first block'), P('more')));
    expect(tryPull(memo, typed, 20)).not.toBeNull();
  });

  it('keeps a pull that gained something, and forgets everything on a new generation (REPAGINATE)', () => {
    const memo = new FailedPulls();
    expect(tryPull(memo, before(), 20)).not.toBeNull();
    for (let k = 0; k < 3; k++) memo.judge(pulled(), 0); // stayed: judged, then forgotten
    memo.judge(before(), 0);
    expect(memo.list()).toEqual([]);

    expect(tryPull(memo, before(), 20)).not.toBeNull();
    memo.judge(pulled(), 0);
    memo.judge(before(), 0);
    expect(tryPull(memo, before(), 20)).toBeNull();
    expect(tryPull(memo, before(), 20, 1)).not.toBeNull(); // theme, CSS or fonts changed
    expect(memo.list()).toEqual([]);
  });

  it('a pull that changed nothing (no step) is no failure', () => {
    const memo = new FailedPulls();
    const doc = before();
    expect(tryPull(memo, doc, 20)).not.toBeNull();
    memo.judge(doc, 0); // the very same page node
    expect(memo.list()).toEqual([]);
  });
});
