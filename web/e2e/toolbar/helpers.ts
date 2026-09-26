// Helpers for the /dev/toolbar specs (P3.4). The page's test API is window.__hbToolbar
// (web/src/dev/toolbar/harness.ts); this file mirrors the part the specs use.
import { expect, type Page } from '@playwright/test';

export interface ToolbarApi {
  requests: string[];
  toolbarRenders: number;
  settled(): boolean;
  select(text: string, offset?: number, n?: number): { from: number; to: number };
  json(): unknown;
  pages(): number;
  undoDepth(): number;
  pageTexts(): string[];
  marksAt(text: string): { type: string; attrs: Record<string, unknown> }[];
  blockOf(text: string): { type: string; attrs: Record<string, unknown>; ancestors: string[] };
  handle: { repaginate(from?: number): void };
  editor: { getText(): string; state: { doc: { childCount: number } }; view: { hasFocus(): boolean } };
}

type Win = Window & { __hbToolbar: ToolbarApi; __lastKey?: { key: string; prevented: boolean } };

/**
 * A /dev page is ready when its canvas is (data-theme-status): the navigation's budget (10 s) covers
 * it. Every /dev page loads every dev harness (about 530 modules from the dev server), which takes
 * about 7 s in Firefox under parallel load, so the 'load' event plus the default 5 s is too tight.
 */
export const PAGE_READY = { timeout: 10_000 };

/** Opens /dev/toolbar, waits for the theme, fonts and a settled layout. No API server needed. */
export async function openToolbar(page: Page, opts: { doc?: 'basic' | 'long'; theme?: string } = {}): Promise<void> {
  // Only the API at the origin root: a glob like **/api/** would also catch Vite's /src/api/*.ts modules.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  await page.goto(`/dev/toolbar?doc=${opts.doc ?? 'basic'}&theme=${opts.theme ?? '5ePHB'}`, { waitUntil: 'domcontentloaded' });
  await waitForToolbarPage(page);
}

/** Waits until /dev/toolbar (after goto or reload) has its theme, test API, toolbar and a settled layout. */
export async function waitForToolbarPage(page: Page): Promise<void> {
  await expect(page.locator('[data-theme-status="ready"]')).toBeAttached(PAGE_READY);
  await page.waitForFunction(() => Boolean((window as unknown as Win).__hbToolbar));
  await expect(page.getByRole('toolbar', { name: 'Editing' })).toBeVisible();
  await settle(page);
  // Record whether the page (ProseMirror) prevented each key's default.
  await page.evaluate(() => {
    window.addEventListener('keydown', (event) => {
      (window as unknown as Win).__lastKey = { key: event.key, prevented: event.defaultPrevented };
    });
  });
}

/** Waits until pagination is idle (two checks a frame apart). */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const api = (window as unknown as Win).__hbToolbar;
        if (!api.settled()) return resolve(false);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(api.settled())));
      }),
  );
}

/** Selects `text` (or puts the cursor `offset` characters into it) and focuses the editor. */
export async function select(page: Page, text: string, offset?: number, n?: number): Promise<void> {
  await page.evaluate(([t, o, k]) => (window as unknown as Win).__hbToolbar.select(t, o, k), [text, offset, n] as const);
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__hbToolbar.editor.view.hasFocus())).toBe(true);
}

export const docJson = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbToolbar.json());
export const marksAt = (page: Page, text: string) => page.evaluate((t) => (window as unknown as Win).__hbToolbar.marksAt(t), text);
export const markTypes = async (page: Page, text: string) => (await marksAt(page, text)).map((m) => m.type);
export const blockOf = (page: Page, text: string) => page.evaluate((t) => (window as unknown as Win).__hbToolbar.blockOf(t), text);
export const pageCount = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbToolbar.pages());
export const undoDepth = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbToolbar.undoDepth());
export const requests = (page: Page) => page.evaluate(() => [...(window as unknown as Win).__hbToolbar.requests]);
export const toolbarRenders = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbToolbar.toolbarRenders);
export const lastKey = (page: Page) => page.evaluate(() => (window as unknown as Win).__lastKey ?? null);
export const pageTexts = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbToolbar.pageTexts());
export const editorHasFocus = (page: Page) => page.evaluate(() => (window as unknown as Win).__hbToolbar.editor.view.hasFocus());

/**
 * Presses `keys` and checks that one undo (Mod-Z) restores the document exactly, pagination
 * settled before and after.
 */
export async function pressUndoable(page: Page, keys: string, check: () => Promise<void>): Promise<void> {
  await settle(page);
  const before = await docJson(page);
  const depth = await undoDepth(page);
  await page.keyboard.press(keys);
  await check();
  await settle(page);
  expect(await undoDepth(page)).toBe(depth + 1);
  await page.keyboard.press('ControlOrMeta+z');
  await settle(page);
  expect(await docJson(page)).toEqual(before);
}

/** The canvas's ProseMirror root. */
export const pagesRoot = (page: Page) => page.locator('.hb-canvas .pages');
