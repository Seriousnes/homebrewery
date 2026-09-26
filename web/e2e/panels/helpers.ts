// Shared helpers for the panels specs (P3.7, P3.9) against /dev/panels.
import AxeBuilder from '@axe-core/playwright';
import type { Editor } from '@tiptap/core';
import { test as base, expect, type Page } from '@playwright/test';

/**
 * The specs' `test`: one browser context per worker, reset between tests (Playwright's
 * reuseContext: cookies, cache, storage, routes and init scripts cleared, viewport and colour
 * scheme applied again). /dev/panels is a harness page that keeps no other state, and a new
 * context per test cost Firefox 2-3 s of every test (module loading of a cold context).
 */
export const test = base.extend({ reuseContext: true });

/** What /dev/panels exposes (web/src/dev/panels/PanelsDevPage.tsx). */
export interface PanelsDevGlobals {
  editor: Editor;
  handle: { viewport: HTMLElement | null };
  tracker: { getState: () => { current: number; total: number; visible: readonly number[] } } | null;
  changes: { field: string; meta: Record<string, unknown> }[];
}

declare global {
  interface Window {
    __hbPanels?: PanelsDevGlobals;
  }
}

export interface OpenOptions {
  theme?: string;
  zoom?: number;
  spread?: 'single' | 'facing' | 'flow';
  doc?: 'panels' | 'long';
  role?: 'owner' | 'author' | 'invited';
  lock?: '1' | 'review';
  edit?: string;
  /** Stub the brew/theme API (default true); false talks to the real API through Vite's proxy. */
  stubApi?: boolean;
}

/** GET /api/themes as the stubbed API answers it: two static themes and three user themes. */
export const STUB_THEMES = {
  static: [
    { key: '5ePHB', name: '5e PHB', renderer: 'V3', baseTheme: 'Blank', baseSnippets: null, path: '5ePHB', style: '/themes/V3/5ePHB/style.css', scopedStyle: '/themes/V3/5ePHB/style.scoped.css', preview: null, texture: null, hasSnippets: true },
    { key: 'Blank', name: 'Blank', renderer: 'V3', baseTheme: null, baseSnippets: null, path: 'Blank', style: '/themes/V3/Blank/style.css', scopedStyle: '/themes/V3/Blank/style.scoped.css', preview: null, texture: null, hasSnippets: true },
  ],
  user: [
    { shareId: 'mineTheme001', name: 'My Parchment', author: 'alice', baseTheme: '5ePHB', thumbnailUrl: null, published: false, mine: true, updatedAt: '2026-09-01T00:00:00Z' },
    { shareId: 'devShareId01', name: 'This brew', author: 'alice', baseTheme: '5ePHB', thumbnailUrl: null, published: true, mine: true, updatedAt: '2026-09-01T00:00:00Z' },
    { shareId: 'otherTheme01', name: 'Starry', author: 'dave', baseTheme: 'Blank', thumbnailUrl: null, published: true, mine: false, updatedAt: '2026-09-01T00:00:00Z' },
  ],
};

/**
 * Opens /dev/panels and waits until theme, CSS and fonts are applied. Theme bundles answer 404 so
 * the canvas uses the static theme files; with stubApi the theme list, delete and lock review are
 * answered here.
 */
export async function openPanels(page: Page, options: OpenOptions = {}): Promise<void> {
  const { stubApi = true, ...query } = options;
  await page.route('**/api/themes/*/bundle', (route) =>
    route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  if (stubApi) {
    await page.route('**/api/themes', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUB_THEMES) }));
    await page.route('**/api/brews/devEditId001', (route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"brewDeleted":false}' })
        : route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
    );
    await page.route('**/api/brews/devEditId001/lock/review', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 455, message: 'This brew copies copyrighted text.', applied: '2026-09-01T12:00:00Z', reviewRequested: '2026-09-25T10:00:00Z' }),
      }),
    );
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  // The DOM, then the page's own readiness signal: the load event is none (Firefox holds it until
  // the lazy route's whole module graph is in, Chromium doesn't), and waiting for it put all of
  // Firefox's loading inside the navigation timeout. The readiness wait is as long as a navigation.
  await page.goto(`/dev/panels${params.size ? `?${params.toString()}` : ''}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-theme-status="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean(window.__hbPanels?.tracker));
  await expect(page.getByTestId('page-total')).toContainText(/\d/);
  // The outline panel is closed by default (UI store); open it.
  const toggle = page.getByTestId('toggle-outline');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(page.getByRole('navigation', { name: 'Outline' })).toBeVisible();
}

/** The canvas viewport's box on the page. */
export async function viewportBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const r = window.__hbPanels!.handle.viewport!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** Top of the page element `n` (1-based) or of `selector`, relative to the canvas viewport's top, in screen px. */
export function offsetInViewport(page: Page, target: number | string): Promise<{ top: number; left: number; right: number; viewportWidth: number }> {
  return page.evaluate((t) => {
    const viewport = window.__hbPanels!.handle.viewport!;
    const el = typeof t === 'number' ? viewport.querySelectorAll('.pages > .page')[t - 1] : viewport.querySelector(t);
    if (!el) throw new Error(`no element ${String(t)}`);
    const v = viewport.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { top: r.top - v.top - viewport.clientTop, left: r.left - v.left, right: r.right - v.left, viewportWidth: viewport.clientWidth };
  }, target);
}

/**
 * Waits until no CSS transition runs (a colour scheme switch fades colours; axe's contrast check
 * must see the final ones). getAnimations() flushes styles, so transitions that a change just
 * started are included.
 */
export async function transitionsDone(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'));
}

/** Current page number shown by the page navigation. */
export async function expectCurrentPage(page: Page, n: number): Promise<void> {
  await expect(page.getByRole('textbox', { name: 'Current page' })).toHaveValue(String(n));
  await expect(page.getByRole('navigation', { name: 'Outline' }).locator(`[data-page="${n}"]`)).toHaveAttribute('aria-current', 'location');
}

/**
 * Axe violations (all rules), as readable strings. Legacy mode runs axe in the page itself: the
 * default mode finishes every run in a new blank page, which costs seconds per scan in Firefox (and
 * under load sometimes never returned); /dev/panels has no iframes to miss.
 */
export async function axeViolations(page: Page, impacts: readonly string[] = ['serious', 'critical']): Promise<string[]> {
  const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  return results.violations
    .filter((v) => impacts.includes(v.impact ?? ''))
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
