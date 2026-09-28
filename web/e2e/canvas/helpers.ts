// Shared helpers for the canvas specs (S1, P3.2, P3.3) against /dev/canvas.
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { type Browser, expect, type Page, test as base, type TestInfo } from '@playwright/test';

/**
 * The specs' `test`: one browser context per worker, reset between tests (Playwright's
 * reuseContext: cookies, cache, storage, routes, init scripts and the clock cleared, viewport and
 * colour scheme applied again). /dev/canvas is a harness page that keeps no other state, and a new
 * context per test cost Firefox seconds of every test (module loading of a cold context).
 */
export const test = base.extend({ reuseContext: true });

/**
 * A page for a group of tests that only read one loaded document: the group opens it once, in
 * beforeAll (with `test.describe.configure({ mode: 'default' })` its tests run in order in one
 * worker; after a failure the next worker runs beforeAll again). Same base URL and action and
 * navigation timeouts as the page fixture.
 */
export async function newSharedPage(browser: Browser, testInfo: TestInfo, viewport = { width: 1400, height: 1300 }): Promise<Page> {
  const { baseURL, actionTimeout, navigationTimeout } = testInfo.project.use;
  const page = await browser.newPage({ baseURL, viewport });
  if (actionTimeout) page.setDefaultTimeout(actionTimeout);
  if (navigationTimeout) page.setDefaultNavigationTimeout(navigationTimeout);
  return page;
}

/** What /dev/canvas exposes (web/src/dev/canvas/CanvasDevPage.tsx). */
export interface CanvasDevGlobals {
  editor: Editor;
  repaginations: { from: number; reason: string }[];
  statuses: { state: string; theme: string }[];
  scopeCssText: (css: string, baseURL?: string, scope?: string) => string;
  transformPastedHtml: (html: string) => string;
}

declare global {
  interface Window {
    __editor?: Editor;
    __hbCanvas?: CanvasDevGlobals;
  }
}

export interface OpenOptions {
  theme?: string;
  zoom?: number;
  spread?: 'single' | 'facing' | 'flow';
  doc?: 's1' | 'chrome' | 'blank' | 'tall' | 'continued';
  view?: 'legacy';
  css?: string;
}

/**
 * From the DOM (domcontentloaded) to theme, CSS and fonts applied, as long as a navigation: a few
 * seconds, the most for a cold Firefox. (A font that never arrives holds the ready state for the fonts gate's 10 s: that
 * shows up here as a timeout.)
 */
export const READY_TIMEOUT = { timeout: 10_000 };

/**
 * Opens /dev/canvas and waits until theme, CSS and fonts are applied. The API isn't running in
 * these tests: the theme bundle endpoint answers 404, so themeLoader takes its static fallback.
 */
export async function openCanvas(page: Page, options: OpenOptions = {}): Promise<void> {
  await page.route('**/api/themes/*/bundle', (route) =>
    route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
  // The DOM, then the page's own readiness signal: the load event is none (Firefox holds it until
  // the lazy route's whole module graph is in, Chromium doesn't), and waiting for it put all of
  // Firefox's loading inside the navigation timeout.
  await page.goto(`/dev/canvas${params.size ? `?${params.toString()}` : ''}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-theme-status="ready"]')).toBeVisible(READY_TIMEOUT);
  if (options.view !== 'legacy') await page.waitForFunction(() => window.__editor !== undefined);
}

/**
 * Shows another document in the open /dev/canvas with its doc menu (no page load: the page mounts
 * a new EditorCanvas for it) and waits until the new editor is there and its canvas is ready.
 */
export async function switchDoc(page: Page, doc: NonNullable<OpenOptions['doc']>): Promise<void> {
  const before = await page.evaluateHandle(() => window.__editor);
  await page.getByTestId('doc-select').selectOption(doc);
  // The new canvas's own element (the old one is gone once the new editor is reported).
  await page.waitForFunction((old) => window.__editor !== undefined && window.__editor !== old && !window.__editor.isDestroyed, before);
  await before.dispose();
  await expect(page.locator('[data-canvas-status="ready"]')).toBeVisible(READY_TIMEOUT);
  await expect(page.locator('[data-theme-status="ready"]')).toBeVisible(READY_TIMEOUT);
}

export interface Range {
  from: number;
  to: number;
}

/** Content range of the paragraph with data-testid `testId`. */
export function paragraphRange(page: Page, testId: string): Promise<Range> {
  return page.evaluate((id) => {
    const editor = window.__editor!;
    let found: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
      const attributes = node.attrs.attributes as Record<string, string> | undefined;
      if (!found && attributes?.['data-testid'] === id) found = { from: pos + 1, to: pos + node.nodeSize - 1 };
    });
    if (!found) throw new Error(`no paragraph ${id}`);
    return found;
  }, testId);
}

export interface Caret {
  from: number;
  to: number;
  head: number;
  anchor: number;
  empty: boolean;
  /** Page index (0-based) of the head. */
  page: number;
  left: number;
  top: number;
  bottom: number;
}

export function caret(page: Page): Promise<Caret> {
  return page.evaluate(() => {
    const editor = window.__editor!;
    const { selection } = editor.state;
    const c = editor.view.coordsAtPos(selection.head, 1);
    return {
      from: selection.from,
      to: selection.to,
      head: selection.head,
      anchor: selection.anchor,
      empty: selection.empty,
      page: editor.state.doc.resolve(selection.head).index(0),
      left: c.left,
      top: c.top,
      bottom: c.bottom,
    };
  });
}

/**
 * Focuses the editor with the caret at `pos` (scrolled into view), and waits until the DOM
 * selection is there too. When the editor gains focus, ProseMirror puts its selection back into
 * the DOM 20 ms later if the DOM's differs from the last one it read (prosemirror-view
 * handlers.focus), which would undo a caret move made before then (a key press, a click): the call
 * returns after that timer, from a longer timer set after it (timers of a page fire in order of
 * their due time).
 */
export async function setCaret(page: Page, pos: number): Promise<void> {
  await page.evaluate(async (p) => {
    const editor = window.__editor!;
    editor.view.focus();
    editor.chain().setTextSelection(p).scrollIntoView().run();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }, pos);
  await page.waitForFunction((p) => {
    const view = window.__editor!.view;
    const dom = document.getSelection();
    if (!dom?.focusNode || !view.hasFocus()) return false;
    return view.posAtDOM(dom.focusNode, dom.focusOffset) === p;
  }, pos);
}

/** Caret coordinates of `pos` (viewport px). */
export function coordsAt(page: Page, pos: number): Promise<{ left: number; top: number; bottom: number }> {
  return page.evaluate((p) => {
    const c = window.__editor!.view.coordsAtPos(p, 1);
    return { left: c.left, top: c.top, bottom: c.bottom };
  }, pos);
}

export interface ColumnBoundary {
  /** Last position in the first column fragment of the paragraph. */
  lastInColumn: number;
  /** First position in the next column. */
  firstInNext: number;
}

/** Where the paragraph `testId` continues from one column to the next. */
export function columnBoundary(page: Page, testId: string): Promise<ColumnBoundary> {
  return page.evaluate((id) => {
    const editor = window.__editor!;
    let range: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
      const attributes = node.attrs.attributes as Record<string, string> | undefined;
      if (!range && attributes?.['data-testid'] === id) range = { from: pos + 1, to: pos + node.nodeSize - 1 };
    });
    if (!range) throw new Error(`no paragraph ${id}`);
    const r: { from: number; to: number } = range;
    let prev = editor.view.coordsAtPos(r.from, 1);
    for (let pos = r.from + 1; pos <= r.to; pos++) {
      const c = editor.view.coordsAtPos(pos, 1);
      if (c.top < prev.top - 100) return { lastInColumn: pos - 1, firstInNext: pos };
      prev = c;
    }
    throw new Error(`${id} does not cross a column`);
  }, testId);
}

/** Positions of the line containing `pos` (start and end, within its textblock). */
export function lineOf(page: Page, pos: number): Promise<Range> {
  return page.evaluate((p) => {
    const editor = window.__editor!;
    const $pos = editor.state.doc.resolve(p);
    const top = editor.view.coordsAtPos(p, 1).top;
    const same = (q: number) => Math.abs(editor.view.coordsAtPos(q, 1).top - top) < 2;
    let from = p;
    while (from > $pos.start() && same(from - 1)) from--;
    let to = p;
    while (to < $pos.end() && same(to + 1)) to++;
    return { from, to };
  }, pos);
}

/**
 * The screen rect of the `nth` occurrence (-1: the last) of `word` in the paragraph `testId`,
 * and its positions.
 */
export function wordBox(
  page: Page,
  testId: string,
  word: string,
  nth = 0,
): Promise<{ from: number; to: number; left: number; top: number; right: number; bottom: number }> {
  return page.evaluate(
    ([id, w, n]) => {
      const editor = window.__editor!;
      let found: { node: PMNode; pos: number } | null = null;
      editor.state.doc.descendants((node, pos) => {
        const attributes = node.attrs.attributes as Record<string, string> | undefined;
        if (!found && attributes?.['data-testid'] === id) found = { node, pos };
      });
      if (!found) throw new Error(`no paragraph ${id}`);
      const { node, pos } = found as { node: PMNode; pos: number };
      const text = node.textContent;
      let index = n < 0 ? text.lastIndexOf(w) : -1;
      for (let k = 0; n >= 0 && k <= n; k++) index = text.indexOf(w, index + 1);
      if (index < 0) throw new Error(`no "${w}" in ${id}`);
      const from = pos + 1 + index;
      const to = from + w.length;
      const start = editor.view.domAtPos(from);
      const end = editor.view.domAtPos(to);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const rect = range.getBoundingClientRect();
      return { from, to, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    },
    [testId, word, nth] as const,
  );
}

/** Scrolls the canvas viewport so that the screen point (x, y) moves to the viewport's middle. */
export async function centerInViewport(page: Page, y: number, x?: number): Promise<void> {
  await page.evaluate(
    ([py, px]) => {
      const viewport = document.querySelector<HTMLElement>('[data-canvas-status]')!;
      const r = viewport.getBoundingClientRect();
      viewport.scrollTop += py - (r.top + r.height / 2);
      if (px !== null) viewport.scrollLeft += px - (r.left + r.width / 2);
    },
    [y, x ?? null] as const,
  );
}

/**
 * Presses `key` and lets ProseMirror read the result: native caret moves reach it through the
 * asynchronous selectionchange event.
 */
export async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await settle(page);
}

/** prosemirror-view internals that settle reads (DOMObserver). */
interface ObservedView {
  hasFocus(): boolean;
  domSelectionRange(): unknown;
  domObserver: { currentSelection: { eq(selection: unknown): boolean } };
}

/**
 * Waits until ProseMirror has read the DOM selection as it is now: after a native caret move (an
 * arrow key, a click, a drag) it does so on the selectionchange event that follows, and then
 * records that selection (DOMObserver.currentSelection). Without focus there is nothing to read.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const view = window.__editor!.view as unknown as ObservedView;
    return !view.hasFocus() || view.domObserver.currentSelection.eq(view.domSelectionRange());
  });
}
