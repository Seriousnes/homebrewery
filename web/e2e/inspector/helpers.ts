// Helpers for the inspector and Style drawer specs (P3.5, P3.6) against /dev/inspector.
import AxeBuilder from '@axe-core/playwright';
import type { Editor } from '@tiptap/core';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * The specs' `test`: one browser context per worker, reset between tests (Playwright's
 * reuseContext: cookies, cache, storage, routes and init scripts cleared, viewport and colour
 * scheme applied again). /dev/inspector is a harness page that keeps no other state, and a new
 * context per test cost Firefox 2-3 s of every test (module loading of a cold context).
 */
export const test = base.extend({ reuseContext: true });

/** What /dev/inspector exposes (web/src/dev/inspector/InspectorDevPage.tsx). */
export interface InspectorDevGlobals {
  editor: Editor;
  handle: { repaginate: (from?: number) => void };
  style: () => { getValue: () => string; view: unknown } | null;
  repaginations: { from: number; reason: string }[];
  selectedObjects: { pageIndex: number; id: string }[];
  settled: () => boolean;
  selectedObject: () => { pagePos: number; id: string } | null;
  lastCssEdit: number;
}

declare global {
  interface Window {
    __hbInspector?: InspectorDevGlobals;
  }
}

export const IDS = {
  intro: 'p-intro',
  note: 'p-note',
  span: 'p-span',
  flow: 'p-flow',
  statName: 'p-stat',
  cell: 'p-cell',
  item: 'p-item',
  second: 'p-second',
} as const;

export interface OpenOptions {
  theme?: string;
  scheme?: 'system' | 'light' | 'dark';
  /** Open the Style drawer too (default true). */
  style?: boolean;
}

/**
 * Opens /dev/inspector with both drawers open and waits until theme, CSS and fonts are applied
 * and pagination has settled. The API isn't running: the theme bundle endpoint answers 404, so
 * the static theme catalog is used.
 */
export async function openInspector(page: Page, options: OpenOptions = {}): Promise<void> {
  await page.route('**/api/themes/*/bundle', (route) =>
    route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  const panels = { outline: { open: false, size: 260 }, inspector: { open: true, size: 340 }, style: { open: options.style ?? true, size: 420 } };
  await page.addInitScript((value) => {
    try {
      if (!sessionStorage.getItem('hb-e2e-init')) {
        localStorage.setItem('hb-ui', JSON.stringify({ state: value, version: 1 }));
        sessionStorage.setItem('hb-e2e-init', '1');
      }
    } catch {
      // storage blocked: defaults
    }
  }, { zoom: 1, spread: 'single', startOnRight: true, pageShadows: true, panels, inspectorTab: 'node' });
  const params = new URLSearchParams();
  if (options.theme) params.set('theme', options.theme);
  if (options.scheme) params.set('scheme', options.scheme);
  // The DOM, then the page's own readiness signal: the load event is none (Firefox holds it until
  // the lazy route's whole module graph is in, Chromium doesn't), and waiting for it put all of
  // Firefox's loading inside the navigation timeout. The readiness wait is as long as a navigation.
  await page.goto(`/dev/inspector${params.size ? `?${params.toString()}` : ''}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-theme-status="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => window.__hbInspector !== undefined);
  await settled(page);
}

/** Waits until pagination has nothing left to do (a whole-document reflow takes about a second). */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__hbInspector?.settled() === true);
}

/**
 * Waits until no CSS transition runs (a colour scheme switch fades colours; axe's contrast check
 * must see the final ones). getAnimations() flushes styles, so transitions that a change just
 * started are included.
 */
export async function transitionsDone(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'));
}

/** The canvas block with data-testid `testId`. */
export function block(page: Page, testId: string): Locator {
  return page.locator(`.hb-canvas [data-testid="${testId}"]`).first();
}

/** Puts the caret inside the block with `testId` (a click near its start). */
export async function clickIn(page: Page, testId: string): Promise<void> {
  const target = block(page, testId);
  await target.scrollIntoViewIfNeeded();
  // Chromium skips offscreen pages (content-visibility: auto, P8.1 offscreen.ts): a page just scrolled into view
  // is hit-tested as an empty box until the next frame, so a click right away would land on the page itself.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + Math.min(24, box.width / 2), box.y + Math.min(8, box.height / 2));
  await expect(page.getByTestId('inspector-target')).toBeVisible();
}

/** Attributes of every page, in order. */
export function pages(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => window.__hbInspector!.editor.state.doc.content.content.map((p) => ({ ...p.attrs })));
}

/** Indexes of pages whose flow overflows its box (content in overflow columns). */
export function overflowing(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.hb-canvas .page > .columnWrapper')).flatMap((wrapper, i) =>
      wrapper.scrollWidth > wrapper.clientWidth + 1 ? [i] : [],
    ),
  );
}

/** Focuses the editor (the canvas) without moving its selection. */
export async function focusCanvas(page: Page): Promise<void> {
  await page.evaluate(() => window.__hbInspector!.editor.view.focus());
}

export const mod = (browserName: string): string => (process.platform === 'darwin' && browserName !== 'firefox' ? 'Meta' : 'Control');

/**
 * Axe in legacy mode: it runs in the page itself. The default mode finishes every run in a new
 * blank page, which costs seconds per scan in Firefox (and under load sometimes never returned);
 * /dev/inspector has no iframes to miss.
 */
const axe = (page: Page) => new AxeBuilder({ page }).setLegacyMode(true);

/** Axe violations (serious or critical) in the app chrome: the canvas (theme content) is left out. */
export async function chromeViolations(page: Page): Promise<string[]> {
  const results = await axe(page).exclude('.hb-canvas').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** All axe violations inside `selector`. */
export async function violationsIn(page: Page, selector: string): Promise<string[]> {
  const results = await axe(page).include(selector).exclude('.hb-canvas').analyze();
  return results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
