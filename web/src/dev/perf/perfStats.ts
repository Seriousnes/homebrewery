// Statistics for the P8.1 performance probe (plan §4.10): percentiles and summaries of samples.
// Pure functions (unit-tested in perfStats.test.ts).

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * The p-th percentile (0–100) by the nearest-rank method: the smallest sample with at least p %
 * of the samples at or below it. NaN for no samples.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

const round = (value: number): number => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value);

/** n, min, p50, p90, p95, p99, max and mean of `samples` (ms, rounded to 0.1). */
export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) return { n: 0, min: Number.NaN, p50: Number.NaN, p90: Number.NaN, p95: Number.NaN, p99: Number.NaN, max: Number.NaN, mean: Number.NaN };
  return {
    n: samples.length,
    min: round(Math.min(...samples)),
    p50: round(percentile(samples, 50)),
    p90: round(percentile(samples, 90)),
    p95: round(percentile(samples, 95)),
    p99: round(percentile(samples, 99)),
    max: round(Math.max(...samples)),
    mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
  };
}

/** The share (0–1) of `samples` above `limit`. */
export function shareAbove(samples: readonly number[], limit: number): number {
  return samples.length === 0 ? 0 : samples.filter((s) => s > limit).length / samples.length;
}
