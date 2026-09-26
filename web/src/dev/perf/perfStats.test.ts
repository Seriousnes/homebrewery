// perfStats.ts: the percentiles and summaries the P8.1 performance page reports.
import { describe, expect, it } from 'vitest';
import { percentile, shareAbove, summarize } from './perfStats';

describe('percentile (nearest rank)', () => {
  it('is the smallest sample with at least p % of the samples at or below it', () => {
    const samples = [15, 20, 35, 40, 50];
    expect(percentile(samples, 5)).toBe(15);
    expect(percentile(samples, 30)).toBe(20);
    expect(percentile(samples, 40)).toBe(20);
    expect(percentile(samples, 50)).toBe(35);
    expect(percentile(samples, 100)).toBe(50);
    // p95 of 100 samples 1…100 is the 95th.
    expect(percentile(Array.from({ length: 100 }, (_, i) => 100 - i), 95)).toBe(95);
  });

  it('clamps p, does not reorder its input, and is NaN without samples', () => {
    const samples = [3, 1, 2];
    expect(percentile(samples, -5)).toBe(1);
    expect(percentile(samples, 250)).toBe(3);
    expect(samples).toEqual([3, 1, 2]);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe('summarize and shareAbove', () => {
  it('summarizes samples to 0.1 ms', () => {
    expect(summarize([1.04, 2, 3, 4, 10.26])).toEqual({ n: 5, min: 1, p50: 3, p90: 10.3, p95: 10.3, p99: 10.3, max: 10.3, mean: 4.1 });
  });

  it('gives NaN statistics for no samples', () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.p95).toBeNaN();
  });

  it('shareAbove is the share of samples strictly above the limit', () => {
    expect(shareAbove([10, 16, 17, 40], 16)).toBe(0.5);
    expect(shareAbove([], 16)).toBe(0);
  });
});
