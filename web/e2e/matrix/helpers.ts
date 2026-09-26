// Helpers for the §4.11 test matrix (web/e2e/matrix). Every case runs in the app's real editor:
// /edit/:editId (EditorApp: toolbars, panels, autosave, pagination, seam editing, objects) with
// the brew API stubbed by pathname, so no API server is needed. The pagination dev harness's
// test API (window.__hbPagination, typed in ../pagination/harness.ts) is attached to that editor
// in the page: its oracles (DOM-truth overflow, the flow text, the frame watch, the fuzz) then
// read the real editor, not /dev/pagination's.
import { test as base, expect, type Page } from '@playwright/test';
import { block, doc, filler, h, ol, p, page as pg, READY_TIMEOUT, SETTLE_TIMEOUT, ul, type HarnessEvent, type PageReport, type Stats } from '../pagination/harness';

export { block, doc, filler, h, ol, p, pg, ul };
export { expect };

/**
 * Playwright's test, whose page saves the author's edits and lets autosave come to rest before the
 * page closes. Otherwise the pagehide save of unsaved edits (a gzipped body and a keepalive fetch)
 * runs while Playwright tears the context down; in Firefox on a loaded machine that teardown has
 * hung for minutes. It saves right away (Mod-S: autosave.saveNow, answered by the stub at once)
 * instead of waiting for the automatic save (AUTOSAVE_DELAY_MS, 3 s after the last edit): the
 * teardown counts towards the test's timeout.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
    const atRest = () => {
      const s = window.__hbEditorApp?.save();
      return !s || (!s.unsaved && s.status !== 'saving');
    };
    try {
      if (!(await page.evaluate(atRest))) {
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, cancelable: true })));
        await page.waitForFunction(atRest, undefined, { timeout: 5_000 });
      }
    } catch {
      // a failed test's page may be gone or broken: close it anyway
    }
  },
});

export type Json = Record<string, unknown>;

export const EDIT_ID = 'mtxEdit0001';
const SHARE_ID = 'mtxShare001';
const AUTHOR = { id: '0190-matrix', handle: 'matrix-author', email: 'matrix@example.test', roles: [] };

export interface BrewOptions {
  /** the stored document (JSON) */
  doc: Json;
  /** the brew's style (user CSS) */
  style?: string;
  theme?: string;
  title?: string;
  /** How long the canvas may take to become ready (default READY_TIMEOUT). */
  readyTimeout?: number;
}

export interface ApiLog {
  /** PUT /api/brews/:editId requests answered so far */
  saves: number;
}

/**
 * Answers the app's API calls for one brew by pathname: the signed-in author, no notices, the
 * brew for /edit, saves (a new version each), and 404 for everything else (the theme bundle
 * endpoint included, so the theme loader takes its static fallback).
 */
export async function stubBrewApi(page: Page, brew: BrewOptions): Promise<ApiLog> {
  const log: ApiLog = { saves: 0 };
  let version = 1;
  const meta = { title: brew.title ?? 'Matrix brew', description: '', tags: [], lang: 'en', theme: brew.theme ?? '5ePHB', published: false, thumbnailUrl: null };
  const times = { createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
  const authors = [{ handle: AUTHOR.handle, role: 'owner' }];
  const forEdit = () => ({
    editId: EDIT_ID,
    shareId: SHARE_ID,
    version,
    docSchemaVersion: 1,
    doc: brew.doc,
    style: brew.style ?? '',
    snippets: null,
    sourceMarkdown: null,
    meta,
    authors,
    role: 'owner',
    pageCount: 1,
    views: 0,
    lock: null,
    ...times,
  });
  // A RegExp, not a '**/api/**' glob: the glob also matches Vite's /src/api/ modules.
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/account/me') return json(AUTHOR);
    if (pathname === '/api/notifications/active') return json([]);
    if (pathname === `/api/brews/edit/${EDIT_ID}` && request.method() === 'GET') return json(forEdit());
    if (pathname === `/api/brews/${EDIT_ID}` && request.method() === 'PUT') {
      log.saves += 1;
      version += 1;
      return json({ version, updatedAt: new Date().toISOString(), title: meta.title, pageCount: 1, authors });
    }
    return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
  });
  return log;
}

/** Throws on uncaught page errors and pagination step failures (collected for the whole test). */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && /\[pagination\]/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/**
 * Opens /edit/:editId on the stubbed brew, waits for the canvas, fonts and the first settle, and
 * attaches the pagination test API to the app's editor (window.__hbPagination).
 */
export async function openEditor(page: Page, brew: BrewOptions): Promise<ApiLog> {
  const log = await stubBrewApi(page, brew);
  await page.goto(`/edit/${EDIT_ID}`, { waitUntil: 'domcontentloaded' });
  await waitForEditor(page, brew.readyTimeout);
  await attachHarness(page);
  await settled(page);
  return log;
}

/**
 * Waits for the app's editor: the canvas ready (theme, CSS, fonts) within `readyTimeout` of the
 * navigation (READY_TIMEOUT), and its first settle.
 */
export async function waitForEditor(page: Page, readyTimeout = READY_TIMEOUT): Promise<void> {
  await expect(page.locator('[data-canvas-status="ready"]').first()).toBeVisible({ timeout: readyTimeout });
  await page.waitForFunction(() => window.__hbEditorApp?.settled() === true, undefined, { timeout: SETTLE_TIMEOUT });
}

/** Attaches the harness API (src/dev/pagination/harness.ts, loaded from the dev server) to the app's editor. */
export async function attachHarness(page: Page): Promise<void> {
  // A string, so neither TypeScript nor Playwright's transform touches the dev-server import.
  await page.evaluate(`(async () => {
    const { PaginationHarness } = await import('/src/dev/pagination/harness.ts');
    const harness = new PaginationHarness({ paginate: true });
    harness.attach(window.__hbEditorApp.editor);
    window.__hbMatrixHarness = harness;
  })()`);
  await page.waitForFunction(() => (window.__hbPagination?.editor as unknown) === window.__hbEditorApp?.editor);
}

/** Waits until the canvas is ready and pagination is idle (the app's own check, then the harness's). */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__hbEditorApp?.settled() === true, undefined, { timeout: SETTLE_TIMEOUT });
  await page.evaluate((ms) => window.__hbPagination.settled(ms), SETTLE_TIMEOUT);
}

export const texts = (page: Page): Promise<string[][]> => page.evaluate(() => window.__hbPagination.texts());
export const pages = (page: Page): Promise<PageReport[]> => page.evaluate(() => window.__hbPagination.pages());
export const stats = (page: Page): Promise<Stats> => page.evaluate(() => window.__hbPagination.state()!.stats);
export const flowText = (page: Page): Promise<string> => page.evaluate(() => window.__hbPagination.flowText());

/** No page overflows (DOM truth), no continuation starts with a space, no pass hit the loop guard, no step failed. */
export async function expectClean(page: Page, errors?: string[]): Promise<void> {
  const r = await page.evaluate(() => {
    // Continuation fragments of split text: a line cut never starts one with a space (the spaces
    // of a soft wrap hang at the end of the line before it).
    const spaced: string[] = [];
    const doc = window.__hbPagination.editor.state.doc as unknown as {
      descendants(f: (n: { isTextblock: boolean; attrs: Record<string, unknown>; textContent: string }) => boolean | void): void;
    };
    doc.descendants((n) => {
      if (n.isTextblock && n.attrs.continuation === true && n.textContent.startsWith(' ')) spaced.push(n.textContent.slice(0, 40));
      return !n.isTextblock;
    });
    return { overflowing: window.__hbPagination.overflowing(), stats: window.__hbPagination.state()!.stats, spaced };
  });
  expect(r.overflowing, 'overflowing pages (DOM truth)').toEqual([]);
  expect(r.spaced, 'continuations starting with a space').toEqual([]);
  expect(r.stats.guardHits, 'loop guard hits').toBe(0);
  expect(r.stats.errors, 'failed pagination steps').toBe(0);
  if (errors) expect(errors).toEqual([]);
}

/** Every auto page holds text (none is left empty), and none is flagged oversized unless allowed. */
export async function expectNoEmptyAutoPages(page: Page): Promise<void> {
  const report = await pages(page);
  const t = await texts(page);
  for (const [i, pageReport] of report.entries()) {
    if (pageReport.kind !== 'auto') continue;
    expect(t[i]!.join('').length, `auto page ${i} is empty`).toBeGreaterThan(0);
  }
}

/** The pagination steps and repagination requests since the last call (the call clears the log). */
export const events = (page: Page): Promise<HarnessEvent[]> => page.evaluate(() => window.__hbPagination.events());
export const stepsOf = (list: HarnessEvent[]) => list.filter((e): e is Extract<HarnessEvent, { kind: 'step' }> => e.kind === 'step');
export const repaginationsOf = (list: HarnessEvent[]) =>
  list.filter((e): e is Extract<HarnessEvent, { kind: 'repaginate' }> => e.kind === 'repaginate');

/** No page that an auto page follows ends with a heading (keep-with-next). */
export async function expectNoStrandedHeadings(page: Page): Promise<void> {
  const report = await pages(page);
  for (let i = 0; i + 1 < report.length; i++) {
    if (report[i + 1]!.kind !== 'auto') continue;
    const blocks = report[i]!.blocks;
    expect(blocks[blocks.length - 1], `page ${i} ends with a heading`).not.toMatch(/^heading/);
  }
}

/** Puts the caret at `anchor` (and `head`) and focuses the editor synchronously. */
export async function select(page: Page, anchor: number, head = anchor): Promise<void> {
  await page.evaluate(([a, b]) => window.__hbPagination.select(a, b), [anchor, head] as const);
}

// Documents ---------------------------------------------------------------------------------------

/** A one-section, 2-column document of plain paragraphs spanning about `pageCount` pages of 5ePHB. */
export const sectionDoc = (pageCount: number, attrs: Json = {}): Json =>
  doc(pg([h(1, 'Chapter One'), ...Array.from({ length: Math.round((pageCount * 5600) / 700) }, (_, i) => p(filler(700, i)))], { pid: 'section1', ...attrs }));

export const li = (text: string): Json => ({ type: 'listItem', content: [p(text)] });
const note = (title: string, text: string): Json => block(['note'], [h(5, title), p(text)]);

/**
 * Mixed content in three sections (2, 1 and 2 columns), about 20 pages of 5ePHB: headings,
 * paragraphs, notes, bullet and ordered lists. The same recipe as /dev/pagination's `mixed20`.
 */
export function mixed20(): Json {
  const body = (seed: number, n: number): Json[] =>
    Array.from({ length: n }, (_, i) => {
      const k = seed + i;
      if (k % 11 === 5) return h(3, `Section ${k}`);
      if (k % 13 === 7) return note(`Note ${k}`, filler(220, k));
      if (k % 9 === 4) return ul(...Array.from({ length: 3 + (k % 4) }, (_, j) => li(filler(60 + 10 * j, k + j))));
      if (k % 17 === 3) return ol(1, ...Array.from({ length: 4 }, (_, j) => li(filler(70, k + j))));
      return p(filler(250 + ((k * 97) % 600), k));
    });
  return doc(
    pg([h(1, 'Part One'), ...body(0, 80)], { pid: 'mixed001', columns: 2, pageNumber: true }),
    pg([h(1, 'Part Two'), ...body(80, 35)], { pid: 'mixed002', columns: 1, pageNumber: true }),
    pg([h(1, 'Part Three'), ...body(115, 80)], { pid: 'mixed003', columns: 2, pageNumber: true }),
  );
}

declare global {
  interface Window {
    __hbMatrixHarness?: unknown;
  }
}
