// Helpers for the objects lane specs (/dev/objects; web/src/dev/objects). Port 5328.
import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * The specs' `test`: one browser context per worker, reset between tests (Playwright's
 * reuseContext: cookies, cache, storage, routes and init scripts cleared, viewport and colour
 * scheme applied again). /dev/objects is a harness page that keeps no other state, and a new
 * context per test cost Firefox 2-3 s of every test (median 6.1 s → 3.3 s with reuse).
 */
export const test = base.extend({ reuseContext: true });

export interface PageObjectJson {
  id: string;
  kind: 'image' | 'text';
  classes: string[];
  style: string;
  src?: string;
  text?: string;
}

/** Mirror of ObjectsDevApi (src/dev/objects/ObjectsDevPage.tsx), the parts the specs use. */
interface ObjectsApi {
  settled(): boolean;
  doc(): unknown;
  pages(): number;
  objects(pageIndex: number): PageObjectJson[];
  markers(pageIndex: number): string[];
  selected(): { pagePos: number; id: string } | null;
  undo(): boolean;
  redo(): boolean;
  editor: {
    state: { doc: { textContent: string; childCount: number; child(i: number): { textContent: string; attrs: Record<string, unknown> } } };
    commands: { focus(pos?: unknown): boolean; setTextSelection(pos: number | { from: number; to: number }): boolean };
    view: { focus(): void };
  };
}

declare global {
  interface Window {
    __hbObjects?: ObjectsApi;
  }
}

/**
 * Navigations wait for the DOM, then for the page's own readiness signal (data-theme-status). The
 * load event is no readiness signal here: Firefox holds it until the lazy route's whole module graph
 * (about 520 requests) is in, Chromium fires it after the entry's (about 130), so a goto waiting for
 * it did all of Firefox's loading inside the navigation timeout. The readiness wait gets as long as a
 * navigation (playwright.config.ts).
 */
export const DOM_READY = { waitUntil: 'domcontentloaded' } as const;
export const LOAD = { timeout: 10_000 };

/** Opens /dev/objects and waits for the theme, fonts and a settled pagination. */
export async function openObjects(page: Page, params: Record<string, string> = {}): Promise<void> {
  // No API in these runs: the theme bundle answers 404 (static theme fallback), other calls too.
  // (Only the API: a glob like **/api/** would also catch the /src/api/ modules.)
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }));
  await page.goto(`/dev/objects?${new URLSearchParams(params).toString()}`, DOM_READY);
  await expect(page.locator('[data-theme-status="ready"]')).toBeVisible(LOAD);
  await settle(page);
}

/** Waits until pagination has settled (the dev documents settle within a second). */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__hbObjects?.settled() === true);
}

export const objectsOf = (page: Page, pageIndex: number) => page.evaluate((i) => window.__hbObjects!.objects(i), pageIndex);
export const markersOf = (page: Page, pageIndex: number) => page.evaluate((i) => window.__hbObjects!.markers(i), pageIndex);
export const pageCount = (page: Page) => page.evaluate(() => window.__hbObjects!.pages());
export const selected = (page: Page) => page.evaluate(() => window.__hbObjects!.selected());
export const undo = (page: Page) => page.evaluate(() => window.__hbObjects!.undo());
export const redo = (page: Page) => page.evaluate(() => window.__hbObjects!.redo());

/** Text of every page (for "pagination moved nothing" checks). */
export const pageTexts = (page: Page) =>
  page.evaluate(() => {
    const doc = window.__hbObjects!.editor.state.doc;
    return Array.from({ length: doc.childCount }, (_, i) => doc.child(i).textContent);
  });

/** A page element of the canvas (0-based). */
export const pageEl = (page: Page, index: number): Locator => page.locator('.hb-canvas .pages > .page').nth(index);
export const objectEl = (page: Page, pageIndex: number, id: string): Locator => pageEl(page, pageIndex).locator(`> [data-object-id="${id}"]`);
export const frame = (page: Page): Locator => page.getByTestId('object-frame');
export const objectToolbar = (page: Page): Locator => page.getByTestId('object-toolbar');

/** A style property of a stored object, as written in its style attribute. */
export function styleProp(object: PageObjectJson | undefined, name: string): string | null {
  if (!object) return null;
  for (const decl of object.style.split(';')) {
    const [k, ...v] = decl.split(':');
    if (k?.trim() === name) return v.join(':').trim();
  }
  return null;
}

export const px = (value: string | null): number => Number((value ?? '').replace(/px$/, ''));

export type MenuRole = 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';

/** Opens the BlockMenu and activates an item. */
export async function blockMenu(page: Page, name: string | RegExp, role: MenuRole = 'menuitem'): Promise<void> {
  await page.getByTestId('block-menu').click();
  await page.getByRole('menu').getByRole(role, { name }).click();
}

/** Opens the TableMenu and activates an item. */
export async function tableMenu(page: Page, name: string | RegExp, role: MenuRole = 'menuitem'): Promise<void> {
  await page.getByTestId('table-menu').click();
  await page.getByRole('menu').getByRole(role, { name }).click();
}

/** Puts the caret at the end of the text `needle` (first match) in the editor. */
export async function caretAfter(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const editor = window.__hbObjects!.editor as unknown as {
      state: { doc: { descendants(f: (n: { isText: boolean; text?: string }, pos: number) => boolean | void): void } };
      view: { focus(): void; dispatch(tr: unknown): void; state: { tr: { setSelection(sel: unknown): unknown }; selection: { constructor: { create(doc: unknown, pos: number): unknown } }; doc: unknown } };
      commands: { setTextSelection(pos: number): boolean };
    };
    let found = -1;
    editor.state.doc.descendants((n, pos) => {
      if (found >= 0) return false;
      if (n.isText && n.text && n.text.includes(text)) found = pos + n.text.indexOf(text) + text.length;
      return true;
    });
    if (found < 0) throw new Error(`no text ${text}`);
    editor.view.focus();
    editor.commands.setTextSelection(found);
  }, needle);
}

/**
 * Clicks the middle of an object with the mouse. (Objects often lie behind the text layer,
 * which a locator click would refuse as 'intercepting pointer events'.)
 */
export async function clickObject(page: Page, pageIndex: number, id: string, modifiers: ('Alt' | 'Shift')[] = []): Promise<void> {
  await objectEl(page, pageIndex, id).scrollIntoViewIfNeeded();
  const box = (await objectEl(page, pageIndex, id).boundingBox())!;
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  for (const m of modifiers) await page.keyboard.up(m);
}

/**
 * Clicks into the text. ProseMirror re-syncs the DOM selection 20 ms after it gets focus
 * (prosemirror-view handlers.focus), which undoes a click that arrives right after focus came from
 * a menu: focus it first, then wait until that timer has run (a longer timer set after it fires
 * after it: timers of a page fire in order of their due time).
 */
export async function clickInText(page: Page, target: Locator, options: { modifiers?: ('Shift' | 'Alt')[] } = {}): Promise<void> {
  await page.evaluate(async () => {
    window.__hbObjects!.editor.view.focus();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await target.click(options);
}

/** Center of a locator's box (client px). */
export async function center(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A mouse drag in client px, in steps (pointer events fire for each). */
export async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await page.mouse.up();
}
