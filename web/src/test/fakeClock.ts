// Helpers for tests on a fake clock (vi.useFakeTimers): a delay runs out exactly when the test
// says so, and "nothing happened" is checked after advancing past the delay that would make it
// happen, never after a real sleep. waitFor and findBy* poll on timers: on a fake clock they
// stall, or (after useFakeClockForUser) move the clock 50 ms per poll. Use tickUntil for what they
// would wait for.
import { act } from '@testing-library/react';
import { expect, vi } from 'vitest';

/** Advances the fake clock by `ms` in act: the timers due run, and promises settle between them (0: only that). */
export const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/**
 * Ticks without moving the fake clock until `reached()`: each tick lets promises and one real
 * macrotask settle (a mocked request or load takes a few). Fails after `ticks` ticks.
 */
export async function tickUntil(reached: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks && !reached(); i++) await advance(0);
  expect(reached(), 'the awaited condition, on the fake clock').toBe(true);
}

/**
 * vi.useFakeTimers for a test that drives user-event, set up with
 * `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`. user-event settles through
 * Testing Library's asyncWrapper, whose own 0 ms wait moves a fake clock only when it is Jest's:
 * a `jest` global tells it (vi.unstubAllGlobals removes it).
 */
export function useFakeClockForUser(): void {
  vi.useFakeTimers();
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
}
