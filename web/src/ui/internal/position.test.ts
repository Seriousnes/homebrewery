import { describe, expect, it } from 'vitest';
import { computePosition, parsePlacement } from './position';

const viewport = { width: 1000, height: 800 };
const anchor = { top: 100, left: 200, width: 100, height: 30 }; // bottom 130, right 300
const floating = { width: 160, height: 200 };

describe('computePosition', () => {
  it('places bottom-start below the anchor, aligned to its left edge', () => {
    expect(computePosition({ anchor, floating, viewport, placement: 'bottom-start', offset: 4 })).toMatchObject({
      top: 134,
      left: 200,
      placement: 'bottom-start',
      maxHeight: 800 - 130 - 4 - 8,
    });
  });

  it('aligns end and center', () => {
    expect(computePosition({ anchor, floating, viewport, placement: 'bottom-end', offset: 4 }).left).toBe(140);
    expect(computePosition({ anchor, floating, viewport, placement: 'bottom', offset: 4 }).left).toBe(170);
    // 88px above the anchor: a 50px panel fits on top, a 200px one flips below.
    expect(computePosition({ anchor, floating: { width: 160, height: 50 }, viewport, placement: 'top', offset: 4 })).toMatchObject({ placement: 'top', top: 46 });
    expect(computePosition({ anchor, floating, viewport, placement: 'top', offset: 4 }).placement).toBe('bottom');
  });

  it('flips to the other side when there is no room', () => {
    const low = { top: 700, left: 200, width: 100, height: 30 };
    const result = computePosition({ anchor: low, floating, viewport, placement: 'bottom-start', offset: 4 });
    expect(result.placement).toBe('top-start');
    expect(result.top).toBe(700 - 4 - 200);
    const high = { top: 10, left: 200, width: 100, height: 30 };
    expect(computePosition({ anchor: high, floating, viewport, placement: 'top', offset: 4 }).placement).toBe('bottom');
  });

  it('keeps the preferred side when neither side fits better, and limits the height', () => {
    const tall = { width: 160, height: 2000 };
    const result = computePosition({ anchor, floating: tall, viewport, placement: 'bottom-start', offset: 4 });
    expect(result.placement).toBe('bottom-start');
    expect(result.maxHeight).toBe(658);
  });

  it('shifts along the cross axis to stay inside the viewport', () => {
    const nearRight = { top: 100, left: 950, width: 40, height: 20 };
    expect(computePosition({ anchor: nearRight, floating, viewport, placement: 'bottom-start' }).left).toBe(1000 - 8 - 160);
    const nearLeft = { top: 100, left: 0, width: 40, height: 20 };
    expect(computePosition({ anchor: nearLeft, floating, viewport, placement: 'bottom-end' }).left).toBe(8);
  });

  it('places left and right, flipping horizontally', () => {
    expect(computePosition({ anchor, floating, viewport, placement: 'right-start', offset: 4 })).toMatchObject({ left: 304, top: 100 });
    const nearLeft = { top: 100, left: 20, width: 40, height: 20 };
    expect(computePosition({ anchor: nearLeft, floating, viewport, placement: 'left', offset: 4 }).placement).toBe('right');
  });

  it('parsePlacement', () => {
    expect(parsePlacement('top')).toEqual({ side: 'top', align: 'center' });
    expect(parsePlacement('left-end')).toEqual({ side: 'left', align: 'end' });
  });
});
