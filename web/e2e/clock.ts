// Playwright's fake clock (page.clock) for the specs whose subject is a timer (a debounce, a
// delay, a timeout): once paused, the page's timers (setTimeout, setInterval,
// requestAnimationFrame, idle callbacks) and clocks (Date, performance.now) move only when the
// test moves them (page.clock.runFor), so a timer fires exactly when the test says, however long
// anything else takes. Install it before the page loads (page.clock.install()); until paused it
// runs with real time. Paused, pagination (animation frames) and the harnesses' settled() waits
// (animation frames too) stand still: run the clock (runClockUntil) or resume it before waiting
// for a settle. The clock is the context's: every page of the context shares it. Network,
// IndexedDB, MessageChannel tasks (React's scheduler) and rendering (ResizeObserver) are not faked.
import type { Page } from '@playwright/test';

/**
 * Stops the page's clock. pauseAt takes a time that the page's clock must not have passed yet, so
 * it jumps 60 s ahead of the page's time: more than any test may take (scripts/testTimeouts.test.ts
 * caps them at 60 s), so never in the past. Timers due in those 60 s fire once, as after a long
 * pause: pause when nothing the test checks is pending.
 */
export async function pauseClock(page: Page): Promise<void> {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 60_000);
}

/**
 * With the clock paused: moves it on a frame (16 ms) at a time until `done()` holds, at most
 * `maxMs` of the page's time (then it throws). Returns the page time it moved.
 */
export async function runClockUntil(page: Page, done: () => Promise<boolean>, maxMs: number): Promise<number> {
  let ms = 0;
  while (!(await done())) {
    if (ms >= maxMs) throw new Error(`not done after ${ms} ms of the page's time`);
    await page.clock.runFor(16);
    ms += 16;
  }
  return ms;
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
