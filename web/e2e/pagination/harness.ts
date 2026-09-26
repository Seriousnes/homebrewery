// Helpers for the /dev/pagination specs. The page's test API is window.__hbPagination
// (web/src/dev/pagination/harness.ts); the types below mirror it (the e2e project can't import
// app sources).
import { test as base, expect, type Browser, type Page, type WorkerInfo } from '@playwright/test';

export { expect };

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Measure {
  box: Rect;
  scale: number;
  eps: number;
  columns: number;
  gap: number;
  columnWidth: number;
  rtl: boolean;
  overflow: boolean;
  first: { index: number; pos: number; rect: Rect; startsInside: boolean; type: string } | null;
  rowTop: number;
  lastColumn: number;
  lastBottom: number;
  lastMarginBottom: number;
  columnFree: number[];
  freeSpace: number;
}

export interface PosReport {
  pos: number;
  page: number;
  depth: number;
  parent: string;
  before: string;
  after: string;
  nodeBefore: string | null;
  nodeAfter: string | null;
  coords: Rect | null;
  coordsBefore: Rect | null;
  beforeRects: Rect[] | null;
  afterRects: Rect[] | null;
}

export interface Cut {
  pos: number | null;
  oversized: boolean;
  rule: string;
  at: PosReport | null;
}

export interface PageReport {
  index: number;
  kind: string;
  pid: string | null;
  columns: number | null;
  oversized: boolean;
  blocks: string[];
  overflow: boolean | null;
  freeSpace: number | null;
  measuredColumns: number | null;
}

export interface Stats {
  settles: number;
  steps: number;
  settleSteps: number;
  lastSettleSteps: number;
  maxSettleSteps: number;
  guardHits: number;
  errors: number;
  pushes: number;
  inserts: number;
  pulls: number;
}

export interface FrameReport {
  frames: number;
  overflowFrames: { frame: number; pages: number[]; settled: boolean }[];
}

export interface FuzzReport {
  edits: number;
  pagesBefore: number;
  pagesAfter: number;
  settleMs: { max: number; avg: number; p95: number };
  maxSettleSteps: number;
  overflowAfterSettle: { edit: number; pages: number[] }[];
  textChanged: { edit: number; lengthBefore: number; lengthAfter: number; firstDifference: number }[];
  oversizedPages: number;
  guardHits: number;
  errors: number;
  durationMs: number;
  kinds: Record<string, number>;
}

/** Page overflow read straight from the DOM (the harness oracle, independent of measure.ts). */
export interface DomTruth {
  box: Rect;
  rtl: boolean;
  overflow: boolean;
  outside: { tag: string; className: string; rect: Rect }[];
}

type Json = Record<string, unknown>;

/** The subset of the TipTap editor the specs touch. */
interface EditorLike {
  state: { doc: { childCount: number }; tr: unknown; selection: { head: number } };
  view: { dom: HTMLElement; dispatch(tr: unknown): void; composing: boolean; state: { tr: { insertText(text: string, from?: number): unknown } } };
  commands: { undo(): boolean; redo(): boolean; focus(): boolean };
}

/** An entry of the harness's event log: a pagination step or a repagination trigger. */
export type HarnessEvent =
  | { kind: 'step'; page: number | null; action: string }
  | { kind: 'repaginate'; from: number; to: number | null; source: 'canvas' | 'meta'; reason?: string };

export interface HarnessApi {
  editor: EditorLike;
  isSettled(): boolean;
  state(): { dirtyFrom: number | null; dirtyTo: number; blocked: boolean; waiting: number[]; stats: Stats } | null;
  /** pagination steps and repagination triggers since the last call (clears the log) */
  events(): HarnessEvent[];
  /** EditorCanvas's userCss (applied after its debounce; the repagination comes up to 300 ms later) */
  setUserCss(css: string): void;
  setTheme(theme: string): void;
  parityMatters(): boolean;
  /** the caret's block (fragments on other pages joined): its text and the caret's offset in it */
  caretInBlock(): { text: string; offset: number; fragments: number; page: number; fragment: number } | null;
  lastSettle(): { steps: number; ms: number } | null;
  settled(timeoutMs?: number): Promise<{ ms: number; frames: number }>;
  load(content: Json | string): void;
  setPaginate(on: boolean): void;
  measure(i: number): Measure | null;
  cut(i: number): Cut | null;
  describe(pos: number): PosReport;
  pages(): PageReport[];
  texts(): string[][];
  /** pages that overflow (DOM truth) and aren't flagged oversized */
  overflowing(): number[];
  domTruth(i: number): DomTruth | null;
  flowText(): string;
  selection(): { head: number; anchor: number; page: number };
  select(anchor: number, head?: number): void;
  endOfPage(i: number): number;
  blockPos(i: number, k: number): number;
  posOf(text: string): number;
  docJSON(): Json;
  repaginate(from?: number): void;
  settleNow(): boolean;
  setZoom(zoom: number): void;
  grow(i: number, until: { column: number; fraction: number }, chunk?: number): Measure | null;
  insertBlock(i: number, json: Json): void;
  frameWatch(): { stop(): FrameReport };
  fuzz(opts: { seed: number; edits: number; burst?: number }): Promise<FuzzReport>;
}

declare global {
  interface Window {
    __hbPagination: HarnessApi;
    __hbFrameWatch?: () => FrameReport;
  }
}

export interface OpenOptions {
  theme?: string;
  doc?: string;
  zoom?: number;
  paginate?: boolean;
  /** brew CSS (EditorCanvas userCss) */
  css?: string;
  /** ms before the layout status shows "Laying out pages…" */
  busyDelay?: number;
  /** /dev/sections (toolbar and layout status) instead of /dev/pagination */
  sections?: boolean;
}

/**
 * How long a page may take to become ready after its navigation (theme, CSS and fonts applied:
 * the page's own readiness signal), and how long pagination may take to settle after a load or an
 * edit. Both stay inside the 15 s test timeout (CLAUDE.md "Tests fail fast"): a load or a
 * pagination pass that stalls fails at the wait that stalled, with its own message.
 */
export const READY_TIMEOUT = 10_000;
export const SETTLE_TIMEOUT = 10_000;

/**
 * Waits in the page until pagination has settled (window.__hbPagination.settled, checked once per
 * frame): rejects with "pagination not settled after … ms" when it doesn't within SETTLE_TIMEOUT.
 */
export function settled(page: Page): Promise<{ ms: number; frames: number }> {
  return page.evaluate((ms) => window.__hbPagination.settled(ms), SETTLE_TIMEOUT);
}

type Variant = 'pagination' | 'sections';
const DEFAULT_DOC: Record<Variant, string> = { pagination: 'sample', sections: 'sections' };

/** What each page was opened with that the harness API can't change in place (its URL's). */
const opened = new WeakMap<Page, { variant: Variant; busyDelay: number | undefined; css: string }>();

/**
 * No API in these runs: answer the theme bundle endpoint like an API without it, so the theme
 * loader takes its static fallback (/themes/themes.json) and the Vite proxy stays quiet.
 */
async function stubThemeBundle(page: Page): Promise<void> {
  await page.route('**/api/themes/*/bundle', (route) => route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }));
}

/** Opens /dev/pagination (or /dev/sections) and waits for the theme, fonts and (when on) the first settle. */
export async function openHarness(page: Page, opts: OpenOptions = {}): Promise<void> {
  if (!opened.has(page)) await stubThemeBundle(page);
  const params = new URLSearchParams({
    theme: opts.theme ?? '5ePHB',
    doc: opts.doc ?? (opts.sections ? 'sections' : 'sample'),
    zoom: String(opts.zoom ?? 1),
    paginate: opts.paginate === false ? '0' : '1',
    ...(opts.css ? { css: opts.css } : {}),
    ...(opts.busyDelay ? { busyDelay: String(opts.busyDelay) } : {}),
  });
  // domcontentloaded, not load: the page's readiness signal is what counts, and waiting for every
  // subresource as well only adds time.
  await page.goto(`/dev/${opts.sections ? 'sections' : 'pagination'}?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  opened.set(page, { variant: opts.sections ? 'sections' : 'pagination', busyDelay: opts.busyDelay, css: opts.css ?? '' });
  await expect(page.locator('[data-theme-status="ready"]')).toBeVisible({ timeout: READY_TIMEOUT });
  if (opts.paginate !== false) await settled(page);
}

/**
 * Playwright's test for the /dev/pagination and /dev/sections specs: its `page` is one harness
 * page per worker, shared by the tests that run in that worker, and each test puts it into the
 * state it needs with useHarness instead of loading it again. A page load is most of such a test's
 * time (Firefox: about 5 s on a quiet machine, up to 11 s beside other Firefox runs); the worker's
 * one load is kept out of the tests' own time. The variant is a worker option: a /dev/sections spec
 * sets `test.use({ harnessVariant: 'sections' })` at its top level. After a failed test Playwright
 * starts a new worker, so a broken page is never reused.
 */
export const test = base.extend<object, { harnessVariant: Variant; harnessPage: Page }>({
  harnessVariant: ['pagination', { scope: 'worker', option: true }],
  harnessPage: [
    async ({ browser, harnessVariant }, use, workerInfo) => {
      const page = await newWorkerPage(browser, workerInfo);
      await openHarness(page, { sections: harnessVariant === 'sections' });
      await use(page);
      await page.context().close();
    },
    // One page load: its navigation (10 s) and readiness (READY_TIMEOUT) waits.
    { scope: 'worker', timeout: 20_000 },
  ],
  page: async ({ harnessPage }, use) => {
    await use(harnessPage);
    // Routes a test added (held images …) go; the theme bundle stub stays.
    await harnessPage.unrouteAll({ behavior: 'ignoreErrors' });
    await stubThemeBundle(harnessPage);
  },
});

/**
 * A page in a context of its own for a worker-scoped fixture, with the project's browser options
 * (base URL, viewport, device) and the config's action and navigation timeouts, as the built-in
 * `page` fixture gets them.
 */
export async function newWorkerPage(browser: Browser, workerInfo: WorkerInfo): Promise<Page> {
  const o = workerInfo.project.use;
  const context = await browser.newContext({
    baseURL: o.baseURL,
    viewport: o.viewport,
    deviceScaleFactor: o.deviceScaleFactor,
    userAgent: o.userAgent,
    isMobile: o.isMobile,
    hasTouch: o.hasTouch,
  });
  context.setDefaultTimeout(o.actionTimeout || 5_000);
  context.setDefaultNavigationTimeout(o.navigationTimeout || 10_000);
  return context.newPage();
}

/**
 * Puts the page into the state openHarness(page, opts) gives: on a page the harness is already
 * open in (the shared page of `test`), in place through the harness API (theme, zoom, pagination,
 * the fixture document, scrolled to the top), otherwise, or when the variant, busyDelay or brew CSS
 * differ, by opening it.
 */
export async function useHarness(page: Page, opts: OpenOptions = {}): Promise<void> {
  const at = opened.get(page);
  const variant: Variant = opts.sections ? 'sections' : 'pagination';
  if (!at || at.variant !== variant || at.busyDelay !== opts.busyDelay || at.css !== (opts.css ?? '')) {
    await openHarness(page, opts);
    return;
  }
  const theme = opts.theme ?? '5ePHB';
  const switched = await page.evaluate(
    ([t, zoom]) => {
      const api = window.__hbPagination;
      api.setPaginate(false);
      api.setZoom(zoom);
      api.events(); // a fresh log, as on a fresh page
      (window as unknown as { __hbResetLog: HarnessEvent[] }).__hbResetLog = [];
      const switching = document.querySelector('[data-canvas-theme]')?.getAttribute('data-canvas-theme') !== t;
      if (switching) api.setTheme(t);
      for (let el = document.querySelector('.hb-canvas'); el; el = el.parentElement) el.scrollTop = el.scrollLeft = 0;
      window.scrollTo(0, 0);
      return switching;
    },
    [theme, opts.zoom ?? 1] as const,
  );
  await expect(page.locator(`[data-canvas-theme="${theme}"][data-canvas-status="ready"]`)).toBeVisible({ timeout: READY_TIMEOUT });
  // The canvas re-checks every page after a theme change once it is 300 ms old (debounced), which
  // can be after it reports ready: wait for that trigger here, not in the test.
  if (switched) {
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __hbResetLog: HarnessEvent[] };
        w.__hbResetLog.push(...window.__hbPagination.events());
        return w.__hbResetLog.some((e) => e.kind === 'repaginate' && e.source === 'canvas' && e.reason === 'theme');
      },
      undefined,
      { timeout: READY_TIMEOUT },
    );
  }
  await page.evaluate(
    async ([doc, paginate, ms]) => {
      const api = window.__hbPagination;
      api.load(doc);
      // Fonts the theme or the document uses for the first time load now (a fresh page loads them
      // behind the canvas's fonts gate), and the canvas re-checks every page a frame after each
      // load ('fonts'): let that happen here, with pagination off, not in the test.
      document.querySelector('.hb-canvas .ProseMirror')?.getBoundingClientRect();
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!paginate) return;
      api.setPaginate(true);
      await api.settled(ms);
    },
    [opts.doc ?? DEFAULT_DOC[variant], opts.paginate !== false, SETTLE_TIMEOUT] as const,
  );
}

/** Loads a document (JSON or fixture name) and, when pagination is on, waits for the settle. */
export async function load(page: Page, content: Json | string, settle = true): Promise<void> {
  await page.evaluate(
    async ([c, s, ms]) => {
      window.__hbPagination.load(c);
      if (s) await window.__hbPagination.settled(ms);
    },
    [content, settle, SETTLE_TIMEOUT] as const,
  );
}

// Document builders (JSON) -----------------------------------------------------------------------

const SENTENCES = [
  'Travelers speak of an inn that is never in the same place twice.',
  'The common room smells of cedar, pipe smoke and rain that never falls outside.',
  'Its keeper greets every guest by name, though none remember telling it.',
  'Doors on the upper floor open onto corridors that were not there the night before.',
  'Those who pay in silver sleep soundly; those who pay in secrets sleep longer.',
  'On the longest night of the year the cellar door stands open, and something below hums.',
  'A bard once tried to map the halls and was found, years later, humming the same tune.',
  'The stew is always exactly warm enough, and nobody has ever seen the cook.',
];

export function filler(chars: number, seed = 0): string {
  let text = '';
  for (let i = seed; text.length < chars; i++) text += (text ? ' ' : '') + SENTENCES[i % SENTENCES.length]!;
  return text;
}

export const txt = (text: string): Json => ({ type: 'text', text });
export const p = (text: string, attrs?: Json): Json => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), ...(text ? { content: [txt(text)] } : {}) });
export const h = (level: number, text: string): Json => ({ type: 'heading', attrs: { level }, content: [txt(text)] });
export const li = (text: string): Json => ({ type: 'listItem', content: [p(text)] });
export const liOf = (...content: Json[]): Json => ({ type: 'listItem', content });
export const ul = (...items: Json[]): Json => ({ type: 'bulletList', content: items });
export const ol = (start: number, ...items: Json[]): Json => ({ type: 'orderedList', attrs: { start }, content: items });
export const dl = (...pairs: [string, string][]): Json => ({
  type: 'definitionList',
  content: pairs.flatMap(([term, desc]) => [
    { type: 'definitionTerm', content: [txt(term)] },
    { type: 'definitionDesc', content: [txt(desc)] },
  ]),
});
export const block = (classes: string[], content: Json[], style?: string): Json => ({
  type: 'themeBlock',
  attrs: { classes, ...(style ? { style } : {}) },
  content,
});
export const columnBreak = (): Json => ({ type: 'columnBreak' });
/** A paragraph holding one image (and nothing else). */
export const imageParagraph = (attrs: Json): Json => ({
  type: 'paragraph',
  content: [{ type: 'image', attrs: { src: '/assets/catwarrior.jpg', ...attrs } }],
});

/**
 * An image whose own size is `width` × `height` (an SVG data URI): it lays out the same before and
 * after it loads. catwarrior.jpg is 600 × 556: sized by attributes, it changes size when it loads
 * where the theme's CSS lets its natural size win, and on a page that loaded it before (a shared
 * page's image cache) that happens at once.
 */
export const sizedImage = (width: number, height: number): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#a33"/></svg>`)}`;

/** catwarrior.jpg at a URL of its own, so a page that loaded the image before (its image cache) requests it again. */
export const uncachedImage = (): string => `/assets/catwarrior.jpg?n=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const page = (content: Json[], attrs: Json = {}): Json => ({ type: 'page', attrs: { columns: 2, ...attrs }, content });
export const doc = (...pages: Json[]): Json => ({ type: 'doc', content: pages });
export const paragraphs = (count: number, chars: number, seed = 0): Json[] =>
  Array.from({ length: count }, (_, i) => p(filler(chars, seed + i)));

/** A one-section document of plain paragraphs spanning about `pages` pages of 5ePHB. */
export const section = (pages: number, attrs: Json = {}): Json =>
  doc(page([h(1, 'Chapter One'), ...paragraphs(Math.round((pages * 5600) / 700), 700)], { pid: 'section1', ...attrs }));
