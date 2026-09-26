// offscreen.ts: whether pages may skip rendering offscreen (P8.1). The real answers come from the
// browsers (e2e/perf/pagination-work.spec.ts: Chromium yes, Firefox no); here the probe's logic,
// with the browser's skip event and layout faked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFSCREEN_PROBE_TIMEOUT_MS, isChromiumEngine, probeSkippedLayout, resetOffscreenProbe, skippedLayoutAnswer } from './offscreen';

afterEach(() => {
  resetOffscreenProbe();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** navigator of a Chromium-based browser (userAgentData brands), or of another engine. */
function engine(chromium: boolean) {
  vi.stubGlobal('navigator', { ...navigator, userAgentData: chromium ? { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }] } : undefined });
}

/** The probe element the browser would skip (the last child of body). */
const probeElement = () => document.body.lastElementChild as HTMLElement;

/** Fires the browser's state change event on the probe element. */
function skip(el: HTMLElement, skipped = true) {
  el.dispatchEvent(Object.assign(new Event('contentvisibilityautostatechange'), { skipped }));
}

describe('isChromiumEngine', () => {
  it('is true only with a Chromium brand in navigator.userAgentData', () => {
    expect(isChromiumEngine({ userAgentData: { brands: [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }] } } as unknown as Navigator)).toBe(true);
    expect(isChromiumEngine({ userAgentData: { brands: [{ brand: 'Other' }] } } as unknown as Navigator)).toBe(false);
    expect(isChromiumEngine({} as Navigator)).toBe(false); // Firefox, Safari: no userAgentData
    expect(isChromiumEngine(undefined)).toBe(false);
  });
});

describe('probeSkippedLayout', () => {
  it('is no in other engines, whatever the probe would say (Firefox lays out a small skipped element, not skipped pages)', async () => {
    engine(false);
    vi.stubGlobal('CSS', { supports: () => true });
    await expect(probeSkippedLayout()).resolves.toBe(false);
  });

  it('is no without content-visibility support (jsdom has no CSS.supports)', async () => {
    engine(true);
    vi.stubGlobal('CSS', undefined);
    await expect(probeSkippedLayout()).resolves.toBe(false);
    expect(skippedLayoutAnswer()).toBe(false);
  });

  it('is yes when a skipped element reports its new size, and removes its element', async () => {
    engine(true);
    vi.stubGlobal('CSS', { supports: (property: string, value: string) => property === 'content-visibility' && value === 'auto' });
    // A browser that lays out skipped content for queries: the child's current height.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, 10, parseFloat(this.style.height) || 0);
    });
    const before = document.body.childElementCount;
    const answer = probeSkippedLayout();
    expect(probeSkippedLayout()).toBe(answer); // one probe per page load
    const el = probeElement();
    expect(el.style.contentVisibility).toBe('auto');
    skip(el, false); // not skipped yet: nothing to ask
    expect(skippedLayoutAnswer()).toBeNull();
    skip(el);
    await expect(answer).resolves.toBe(true);
    expect(skippedLayoutAnswer()).toBe(true);
    expect(document.body.childElementCount).toBe(before);
    await expect(probeSkippedLayout()).resolves.toBe(true);
  });

  it('is no when the skipped element reports a stale or empty box', async () => {
    engine(true);
    vi.stubGlobal('CSS', { supports: () => true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 0, 0));
    const answer = probeSkippedLayout();
    skip(probeElement());
    await expect(answer).resolves.toBe(false);
  });

  it('is no when the browser never reports the element skipped', async () => {
    vi.useFakeTimers();
    engine(true);
    vi.stubGlobal('CSS', { supports: () => true });
    const before = document.body.childElementCount;
    const answer = probeSkippedLayout();
    vi.advanceTimersByTime(OFFSCREEN_PROBE_TIMEOUT_MS);
    await expect(answer).resolves.toBe(false);
    expect(document.body.childElementCount).toBe(before);
  });
});
