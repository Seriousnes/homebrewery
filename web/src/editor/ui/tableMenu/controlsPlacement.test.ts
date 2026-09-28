// Where the table controls go (placeTableControls): under the table, above it, pinned, hidden.
import { describe, expect, it } from 'vitest';
import { CONTROLS_GAP, placeTableControls } from './controlsPlacement';

const clip = { top: 100, left: 0, bottom: 900, right: 1000 };
const size = { width: 400, height: 30 };
const box = (top: number, bottom: number, left = 200, right = 600) => ({ top, bottom, left, right });

describe('placeTableControls', () => {
  it('goes under the table, aligned with its left edge', () => {
    expect(placeTableControls(box(200, 400), clip, size)).toEqual({ top: 400 + CONTROLS_GAP, left: 200, hidden: false });
  });

  it('goes above the table when there is no room under it', () => {
    expect(placeTableControls(box(300, 880), clip, size)).toEqual({ top: 300 - CONTROLS_GAP - 30, left: 200, hidden: false });
  });

  it('is pinned to the bottom of the visible area over a table taller than it', () => {
    expect(placeTableControls(box(50, 1200), clip, size)).toEqual({ top: 900 - CONTROLS_GAP - 30, left: 200, hidden: false });
  });

  it('is hidden while the table is scrolled out', () => {
    expect(placeTableControls(box(0, 90), clip, size).hidden).toBe(true);
    expect(placeTableControls(box(950, 1200), clip, size).hidden).toBe(true);
  });

  it('stays inside the visible area horizontally', () => {
    expect(placeTableControls(box(200, 400, 800, 990), clip, size).left).toBe(1000 - 400 - CONTROLS_GAP);
    expect(placeTableControls(box(200, 400, -50, 300), clip, size).left).toBe(CONTROLS_GAP);
  });
});
