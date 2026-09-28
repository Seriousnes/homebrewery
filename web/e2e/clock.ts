// Playwright's fake clock (page.clock) for the specs' timing checks: a debounce, a delay, "nothing
// happens before N ms" are asserted in the page's own time, never with a real sleep.
//
// page.clock.install() (before the page's first navigation) replaces the page's timers, animation
// frames, idle callbacks, Date and performance.now; time still flows as usual (timers fire as their
// time comes, animation frames every 16 ms). pauseClock() stops it: from then on nothing timed runs
// until page.clock.runFor(ms) (fires every timer and frame due within ms, in order) or
// page.clock.resume(). Paused, pagination (animation frames) and the harnesses' settled() waits
// (animation frames too) stand still: resume the clock before waiting for a settle. The clock is the
// context's: every page of the context shares it. Network, IndexedDB, MessageChannel tasks (React's
// scheduler) and rendering (ResizeObserver) are not faked.
import type { Page } from '@playwright/test';

/**
 * How far ahead of the page's time pauseClock stops the clock: page.clock.pauseAt(t) fast-forwards
 * to t (every timer due before t fires once), and t must not be in the page's past when the call
 * reaches the page. The page is idle when it is paused (the callers make sure), so the jump only
 * shows as time having passed.
 */
const PAUSE_AHEAD_MS = 1000;

/** Stops the page's installed clock (page.clock.install) about PAUSE_AHEAD_MS after its current time. */
export async function pauseClock(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + PAUSE_AHEAD_MS);
      return;
    } catch (error) {
      // The call took longer than PAUSE_AHEAD_MS to reach the page (a loaded machine): the clock is
      // paused already (pauseAt pauses, then fast-forwards), so the second reading is exact.
      if (attempt >= 2 || !/past/i.test(String(error))) throw error;
    }
  }
}

/**
 * One task turn in the page after everything queued so far (React renders scheduled from a timer,
 * a securitypolicyviolation event …): a MessageChannel message, which the fake clock doesn't hold.
 */
export async function nextTask(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(null);
      }),
  );
}
