// Helpers for the end-to-end flows of the app pages (web/e2e/flows): /, /new, /edit/:editId and
// /share/:shareId against a real API (see run-flows.mjs), plus the print checks.
import AxeBuilder from '@axe-core/playwright';
import type { Editor } from '@tiptap/core';
import { type APIRequestContext, expect, type Locator, type Page } from '@playwright/test';

/** What the editor pages expose in dev builds (web/src/editor/EditorApp/devApi.ts). */
export interface EditorAppDevApi {
  editor: Editor;
  settled: () => boolean;
  save: () => { status: string; editId: string | null; baseVersion: number | null; unsaved: boolean } | null;
}

declare global {
  interface Window {
    __hbEditorApp?: EditorAppDevApi;
    __hbPrints?: number;
  }
}

export const PASSWORD = 'Passw0rd!';
/** A save to reach the server and the status to show it: the 3 s autosave delay plus the request. */
export const SAVE_TIMEOUT = { timeout: 10_000 };
/** From the end of a navigation to the editor ready and paginated (a few seconds; the most for a cold Firefox). */
export const LOAD_TIMEOUT = { timeout: 10_000 };

const apiUrl = process.env.HB_API_URL ?? '';
/** A private API behind the Vite proxy (never the humans' :5080 or :8080). */
export const privateApi = /^https?:\/\/[^/]+:\d+/.test(apiUrl) && !/:(5080|8080)(\/|$)/.test(apiUrl);
/** An admin account of that API (Admin__Emails), for the lock tests. */
export const adminEmail = process.env.FLOWS_ADMIN_EMAIL ?? '';

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@e2e.test`;
}

export const nav = (page: Page): Locator => page.getByRole('navigation', { name: 'Main' });

/** A one-page document with one paragraph per text. */
export function docOf(...texts: string[]): object {
  return {
    type: 'doc',
    content: [{ type: 'page', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) }],
  };
}

/** Registers (a new email) and signs in through `request` (a page's request shares its cookies). */
export async function signUpApi(request: APIRequestContext, baseURL: string, email = uniqueEmail('flows')): Promise<string> {
  const headers = { Origin: baseURL };
  const registered = await request.post('/api/auth/register', { data: { email, password: PASSWORD }, headers });
  expect(registered.status(), await registered.text()).toBe(200);
  await signInApi(request, baseURL, email);
  return email;
}

export async function signInApi(request: APIRequestContext, baseURL: string, email: string): Promise<void> {
  const login = await request.post('/api/auth/login?useCookies=true', { data: { email, password: PASSWORD }, headers: { Origin: baseURL } });
  expect(login.status(), await login.text()).toBe(200);
}

/** Registers an account without signing anyone in (its own request context). */
export async function registerOnly(request: APIRequestContext, baseURL: string, email = uniqueEmail('flows')): Promise<string> {
  const registered = await request.post('/api/auth/register', { data: { email, password: PASSWORD }, headers: { Origin: baseURL } });
  expect(registered.status(), await registered.text()).toBe(200);
  return email;
}

export interface CreatedBrew {
  editId: string;
  shareId: string;
  version: number;
}

export async function createBrewApi(request: APIRequestContext, baseURL: string, text: string, title = 'Flows e2e'): Promise<CreatedBrew> {
  const res = await request.post('/api/brews', { data: { doc: docOf(text), meta: { title } }, headers: { Origin: baseURL } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as CreatedBrew;
}

export async function storedBrew(request: APIRequestContext, editId: string): Promise<{ version: number; views: number; doc: unknown; meta: { title: string; theme: string } }> {
  const res = await request.get(`/api/brews/edit/${editId}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { version: number; views: number; doc: unknown; meta: { title: string; theme: string } };
}

/** The editor root of the page (edit, new, share or home). */
export const editorRoot = (page: Page): Locator => page.locator('.hb-canvas .ProseMirror');

/** Waits until the page's editor is mounted, its canvas ready and pagination settled. */
export async function waitForEditor(page: Page): Promise<void> {
  await expect(page.locator('[data-canvas-status="ready"]').first()).toBeVisible(LOAD_TIMEOUT);
  await page.waitForFunction(() => window.__hbEditorApp?.settled() === true, undefined, LOAD_TIMEOUT);
}

/** Goes to `path` and waits for its editor. */
export async function openEditorPage(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
}

/** Puts the caret at the end of text block `index` (the editor gets the focus) and types. */
export async function typeAt(page: Page, text: string, index = 0): Promise<void> {
  await page.evaluate((i) => {
    const editor = window.__hbEditorApp!.editor;
    let target = -1;
    let seen = 0;
    editor.state.doc.descendants((node, pos) => {
      if (target >= 0) return false;
      if (node.isTextblock) {
        if (seen++ === i) target = pos + 1 + node.content.size;
        return false;
      }
      return true;
    });
    editor.view.focus();
    editor.commands.setTextSelection(target);
  }, index);
  await page.keyboard.type(text);
}

/** The text of every text block in the editor (null while no editor is mounted). */
export function editorTexts(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const editor = window.__hbEditorApp?.editor;
    if (!editor || editor.isDestroyed) return null;
    const out: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isTextblock) out.push(node.textContent);
      return !node.isTextblock;
    });
    return out;
  });
}

/** The save status label in the toolbar ("Saved", "Sign in to save", …). */
export const saveStatus = (page: Page): Locator => page.getByTestId('save-status-label');

/** The editor app's root (data-save-status, data-edit-id, data-share-id). */
export const appRoot = (page: Page): Locator => page.locator('[data-mode]').first();

/** Waits until IndexedDB's /new draft (hb-drafts/drafts 'new') contains `text`. */
export function waitForNewDraft(page: Page, text: string): Promise<void> {
  return waitForDraft(page, 'new', text);
}

/** Waits until the IndexedDB draft under `key` (an editId, or 'new') contains `text`. */
export async function waitForDraft(page: Page, key: string, text: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (draftKey) =>
            new Promise<string>((resolve) => {
              const open = indexedDB.open('hb-drafts');
              // Never create the database here (the app's store creates it with its object store).
              open.onupgradeneeded = () => open.transaction?.abort();
              open.onerror = () => resolve('');
              open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('drafts')) {
                  db.close();
                  resolve('');
                  return;
                }
                // An edit draft's key is `${editId}:${session}` (save lane, SAVE-10): match every
                // draft of the brew by its key or editId.
                const get = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
                get.onsuccess = () => {
                  db.close();
                  const drafts = (get.result as { key?: string; editId?: string | null; doc?: unknown }[]).filter(
                    (d) => d.key === draftKey || d.editId === draftKey,
                  );
                  resolve(JSON.stringify(drafts.map((d) => d.doc ?? '')));
                };
                get.onerror = () => {
                  db.close();
                  resolve('');
                };
              };
            }),
          key,
        ),
      SAVE_TIMEOUT,
    )
    .toContain(text);
}

/** Replaces window.print with a counter (print() still waits for images first). */
export async function stubPrint(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__hbPrints = 0;
    window.print = () => {
      window.__hbPrints = (window.__hbPrints ?? 0) + 1;
    };
  });
}

export const printCount = (page: Page): Promise<number> => page.evaluate(() => window.__hbPrints ?? 0);

/** Every axe violation outside the brew's own pages (their content is the author's). */
export async function chromeViolations(page: Page): Promise<string[]> {
  // Legacy mode: axe in the page itself. The default mode finishes in a new blank page, which
  // Firefox can take minutes to open (e2e/a11y/helpers.ts); the app has no iframes.
  const results = await new AxeBuilder({ page }).setLegacyMode(true).exclude('.hb-canvas .ProseMirror > .page').analyze();
  return results.violations.map((v) => `${v.id} (${v.impact ?? 'unknown'}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

export interface PrintLayout {
  pages: number;
  /** Chrome still rendered in print (should be none). */
  visibleChrome: string[];
  /** Page boxes in document coordinates (px). */
  boxes: { top: number; height: number; width: number; marginTop: number; marginBottom: number; shadow: string }[];
  /** Height of the whole printed document (px). */
  documentHeight: number;
}

/** The layout under print media: which chrome is still visible, and where the pages are. */
export async function printLayout(page: Page): Promise<PrintLayout> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const chrome = [
      ['navbar', 'nav[aria-label="Main"]'],
      ['editor toolbar', '[data-testid="editor-toolbar"]'],
      ['app bar', '[data-testid="editor-app-bar"]'],
      ['toolbars', '[role="toolbar"]'],
      ['drawers', 'aside'],
      ['banners', '[data-testid="draft-offer"], [data-testid="lock-banner"], [data-testid="new-draft-notice"]'],
      ['skip link', 'a[href="#main-content"]'],
    ] as const;
    const visibleChrome = chrome.filter(([, selector]) => Array.from(document.querySelectorAll(selector)).some(visible)).map(([name]) => name);
    const scrollY = window.scrollY;
    const pages = Array.from(document.querySelectorAll('.hb-canvas .page'));
    const boxes = pages.map((p) => {
      const r = p.getBoundingClientRect();
      const s = getComputedStyle(p);
      return { top: r.top + scrollY, height: r.height, width: r.width, marginTop: parseFloat(s.marginTop), marginBottom: parseFloat(s.marginBottom), shadow: s.boxShadow };
    });
    return { pages: pages.length, visibleChrome, boxes, documentHeight: document.documentElement.scrollHeight };
  });
}

/** Number of pages in a PDF (count of /Type /Page objects). */
export function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}
