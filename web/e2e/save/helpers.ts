// Shared helpers for the save specs (P3.8) against /dev/save (web/src/dev/save).
import AxeBuilder from '@axe-core/playwright';
import type { Editor } from '@tiptap/core';
import { expect, type Locator, type Page } from '@playwright/test';

/** What /dev/save exposes (web/src/dev/save/devGlobals.ts). */
export interface StoredDraft {
  key: string;
  doc: unknown;
  baseVersion: number | null;
  pendingVersion?: number | null;
  conflict?: boolean;
  style: string;
}

export interface SaveDevGlobals {
  editor: Editor;
  state: () => { status: string; editId: string | null; baseVersion: number | null; unsaved: boolean; draftOffer: unknown };
  /** The newest stored draft of a brew (editId), or the 'new' draft. */
  draft: (key: string) => Promise<StoredDraft | null>;
  /** Every stored draft of a brew, newest first. */
  drafts: (editId: string) => Promise<StoredDraft[]>;
  snapshots: (editId: string) => Promise<{ version: number | null; title: string }[]>;
  saveNow: () => Promise<string>;
  idbRoundTrip: () => Promise<unknown>;
}

declare global {
  interface Window {
    __hbSave?: SaveDevGlobals;
  }
}

export const PASSWORD = 'Passw0rd!';

/**
 * /dev/save is ready within the navigation's budget (10 s): every /dev page loads every dev harness
 * (about 530 modules from the dev server), about 7 s in Firefox under parallel load.
 */
export const PAGE_READY = { timeout: 10_000 };

/** A save the autosave makes: its 3 s delay (AUTOSAVE_DELAY_MS), the settle check and the round trip. */
export const SAVE_TIMEOUT = { timeout: 8_000 };

/** A doc with one page holding one paragraph per text. */
export function docOf(...texts: string[]): object {
  return {
    type: 'doc',
    content: [{ type: 'page', content: texts.map((text) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' })) }],
  };
}

/** Opens /dev/save (a brew by editId, or a new brew) and waits for the canvas and editor. */
export async function openSavePage(page: Page, editId: string | null): Promise<Locator> {
  // Readiness is the canvas status, not the load event (which waits for every font and image
  // and stalled for minutes in Firefox under parallel load).
  await page.goto(editId ? `/dev/save?edit=${encodeURIComponent(editId)}` : '/dev/save', { waitUntil: 'domcontentloaded' });
  return waitForSavePage(page);
}

/** Waits until /dev/save's canvas is ready and its editor is exposed (after goto or reload). */
export async function waitForSavePage(page: Page): Promise<Locator> {
  const frame = page.getByTestId('dev-save');
  await expect(frame).toHaveAttribute('data-theme-status', 'ready', PAGE_READY);
  await page.waitForFunction(() => window.__hbSave !== undefined);
  return frame;
}

/** Puts the caret at the end of text block `index` (focusing the editor synchronously) and types. */
export async function typeAt(page: Page, text: string, index = 0): Promise<void> {
  await page.evaluate((i) => {
    const editor = window.__hbSave!.editor;
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

/** The text of every text block in the editor. */
export function editorTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    window.__hbSave!.editor.state.doc.descendants((node) => {
      if (node.isTextblock) out.push(node.textContent);
      return !node.isTextblock;
    });
    return out;
  });
}

/** Waits until a stored draft of `key` (an editId, any session's; or 'new') contains `text`. */
export async function waitForDraft(page: Page, key: string, text: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate(async (k) => JSON.stringify((await window.__hbSave!.drafts(k)).map((d) => d.doc)), key))
    .toContain(text);
}

/**
 * Every stored draft of a brew (editId), read from IndexedDB directly: works on any page (the app's
 * too) and never creates the database.
 */
export function idbDrafts(page: Page, editId: string): Promise<StoredDraft[]> {
  return page.evaluate(
    (id) =>
      new Promise<StoredDraft[]>((resolve) => {
        const open = indexedDB.open('hb-drafts');
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('drafts')) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
          all.onsuccess = () => {
            db.close();
            resolve((all.result as (StoredDraft & { editId: string | null })[]).filter((d) => d.editId === id));
          };
          all.onerror = () => {
            db.close();
            resolve([]);
          };
        };
      }),
    editId,
  );
}

/**
 * Kills the tab without letting anything it does from now on reach the server: fetch is cut
 * inside the page, then the page is closed. page.close() alone runs pagehide/visibilitychange,
 * and the keepalive save sent from there bypasses Playwright's routes and offline emulation, so
 * the text would be saved (the right behaviour for a closed tab, but not a crash). CDP
 * Page.crash would skip the unload handlers, but it wedges the context in Chromium, and Firefox
 * has no equivalent. What reaches IndexedDB before this is all a crashed tab leaves behind.
 */
export async function killTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.fetch = () => Promise.reject(new TypeError('The tab was killed'));
  });
  await page.close();
}

/** Axe violations with impact serious or critical inside `selector`. */
export async function seriousViolations(page: Page, selector?: string): Promise<string[]> {
  // Legacy mode: axe.run in the page. The default mode finishes in a new blank page, which took seconds
  // to minutes in Firefox (docs/implementation-notes.md, a11y lane); /dev/save has no iframes.
  let builder = new AxeBuilder({ page }).setLegacyMode(true);
  if (selector) builder = builder.include(selector);
  const results = await builder.analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

export const conflictDialog = (page: Page): Locator => page.getByRole('alertdialog', { name: 'This brew was changed somewhere else' });
export const statusLabel = (page: Page): Locator => page.getByTestId('save-status-label');
