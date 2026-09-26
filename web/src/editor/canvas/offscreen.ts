// Offscreen pages and content-visibility (P8.1, plan §4.2, §4.10).
//
// Pages skip rendering while offscreen (content-visibility: auto) only where a layout query inside
// skipped content (getClientRects, getBoundingClientRect, Range rects: everything pagination's
// measurements read) first brings that content up to date. Chromium does, for whole pages
// (e2e/canvas/multicol.spec.ts compares every box of skipped pages with fully laid out ones: no
// difference). Firefox (as of 2026) lays out a small skipped element for a query, but answers with
// empty boxes for parts of a skipped page: its column wrapper, or its page number and footnote
// chrome. A synthetic probe can't vouch for the real page structure, so skipping is limited to
// Chromium-based browsers (navigator.userAgentData with a Chromium brand; a feature only they
// have), and the probe must still agree. EditorCanvas asks once and marks .hb-canvas with
// OFFSCREEN_ATTR="skip"; canvas.css switches pages to content-visibility: auto only under that mark,
// and pages stay `visible` everywhere else (the plan's §4.2 default), including until the answer.
//
// Why it matters where it works: a skipped page costs nothing until something reads it, so adding
// or removing a page no longer restyles every page after it (the themes' .page:nth-child rules),
// and the browser's own editing work per keystroke stops walking the whole brew.

/** Attribute on .hb-canvas: "skip" when offscreen pages may skip rendering. */
export const OFFSCREEN_ATTR = 'data-hb-offscreen';

/** How long the probe waits for the browser to skip its element before answering no (ms). */
export const OFFSCREEN_PROBE_TIMEOUT_MS = 2000;

let answer: boolean | null = null;
let pending: Promise<boolean> | null = null;

/** The probe's answer once it has one (null before). */
export const skippedLayoutAnswer = (): boolean | null => answer;

/** Whether the browser is Chromium-based: navigator.userAgentData lists a Chromium brand. */
export function isChromiumEngine(nav: Navigator | undefined = globalThis.navigator): boolean {
  const data = (nav as (Navigator & { userAgentData?: { brands?: readonly { brand: string }[] } }) | undefined)?.userAgentData;
  return data?.brands?.some((b) => b.brand === 'Chromium') === true;
}

/**
 * Whether offscreen pages may skip rendering: a Chromium-based browser (see the top) that brings
 * content content-visibility: auto skipped up to date when script reads its geometry. The probe
 * is an element far offscreen with content-visibility: auto; once the browser reports it skipped
 * (contentvisibilityautostatechange), its child's height changes and is read back: the new height
 * means yes. No answer within OFFSCREEN_PROBE_TIMEOUT_MS, no DOM, no content-visibility, or
 * another engine: no. Asked once per page load.
 */
export function probeSkippedLayout(doc: Document | undefined = globalThis.document): Promise<boolean> {
  if (answer !== null) return Promise.resolve(answer);
  if (pending) return pending;
  if (
    !doc?.body ||
    !isChromiumEngine() ||
    typeof CSS === 'undefined' ||
    typeof CSS.supports !== 'function' ||
    !CSS.supports('content-visibility', 'auto')
  ) {
    answer = false;
    return Promise.resolve(false);
  }
  const body = doc.body;
  pending = new Promise<boolean>((resolve) => {
    const outer = doc.createElement('div');
    outer.setAttribute('aria-hidden', 'true');
    outer.style.cssText =
      'position:absolute;left:-10000px;top:-10000px;width:20px;height:20px;overflow:hidden;contain:strict;content-visibility:auto;pointer-events:none';
    const inner = doc.createElement('div');
    inner.style.cssText = 'width:10px;height:7px';
    outer.appendChild(inner);
    const finish = (value: boolean) => {
      if (answer !== null) return;
      clearTimeout(timer);
      outer.remove();
      answer = value;
      pending = null;
      resolve(value);
    };
    outer.addEventListener('contentvisibilityautostatechange', (event) => {
      if (!(event as Event & { skipped?: boolean }).skipped) return;
      inner.style.height = '9px';
      finish(inner.getBoundingClientRect().height > 8.5);
    });
    // Read by finish, which only runs later (the skip event or this timer).
    const timer = setTimeout(() => finish(false), OFFSCREEN_PROBE_TIMEOUT_MS);
    body.appendChild(outer);
  });
  return pending;
}

/** Forgets the probe's answer (tests). */
export function resetOffscreenProbe(): void {
  answer = null;
  pending = null;
}
