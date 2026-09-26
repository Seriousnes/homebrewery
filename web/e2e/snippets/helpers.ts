// Helpers for the snippets lane's specs (P5.1, P5.2, P5.4): /dev/snippets and its test API
// (window.__hbSnippets, web/src/dev/snippets/SnippetsDevPage.tsx), plus the S3 harness's
// screenshot diff (e2e/import/fidelity.spec.ts) for comparing with /dev/legacy-render.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** Mirror of SnippetsDevApi (src/dev/snippets/SnippetsDevPage.tsx), the parts specs call. */
export interface SnippetOutcome {
  kind: 'blocks' | 'pages' | 'nothing' | 'native';
  message: string;
  style: string;
}
export interface RawSnippetInfo {
  group: string;
  view: 'text' | 'style';
  names: string[];
  kind: 'function' | 'string';
  native: string | null;
}
export interface SnippetsDevApi {
  editor: {
    state: { doc: { childCount: number; toJSON(): unknown } };
    view: { dom: HTMLElement; focus(): void };
    commands: Record<string, (...args: unknown[]) => boolean>;
    getJSON(): { content?: Array<{ attrs?: Record<string, unknown>; content?: Array<{ type: string; attrs?: Record<string, unknown> }> }> };
  };
  ready(): boolean;
  settled(): boolean;
  entries(view?: 'text' | 'style'): { path: string[]; native: string | null }[];
  rawEntries(theme: string): Promise<RawSnippetInfo[]>;
  generate(theme: string, group: string, names: string[], seed?: number): Promise<string>;
  runRawNative(theme: string, group: string, names: string[]): Promise<SnippetOutcome | null>;
  insertMarkdown(markdown: string): Promise<SnippetOutcome>;
  insertEntry(path: string[]): Promise<SnippetOutcome>;
  dropCursorLine(): boolean;
  cssApplied(): number;
  reset(doc?: unknown): void;
  loadMarkdown(markdown: string): Promise<void>;
  setUserCss(css: string): void;
  userCss(): string;
  appendStyleSnippet(css: string): void;
  prepareScreenshot(): Promise<void>;
  tocRows(): string[][][];
  overlay(): { visible: boolean; label: string | null; classes: string[] };
}

declare global {
  interface Window {
    __hbSnippets?: SnippetsDevApi;
    __hbReseed?: (seed: number) => void;
  }
}

// ---------------------------------------------------------------------------------------------
// Deterministic randomness, as scripts/fidelity-fixtures.ts: mulberry32 seeded from sha256.
// ---------------------------------------------------------------------------------------------

export const seedOf = (text: string): number => createHash('sha256').update(text).digest().readUInt32LE(0);

/**
 * Installs a seedable Math.random before any page script runs (lodash captures Math.random when
 * it loads, so the wrapper must be first). window.__hbReseed(seed) restarts the sequence.
 */
export async function installSeededRandom(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mulberry32 = (seed: number) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    let rng = mulberry32(1);
    Math.random = () => rng();
    window.__hbReseed = (seed: number) => {
      rng = mulberry32(seed);
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Network: no API (static theme catalog), fixed bytes for external images
// ---------------------------------------------------------------------------------------------

const placeholder = (() => {
  const png = new PNG({ width: 240, height: 120 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      const on = ((x >> 4) + (y >> 4)) % 2 === 0;
      png.data[i] = on ? 120 : 200;
      png.data[i + 1] = on ? 150 : 210;
      png.data[i + 2] = on ? 190 : 230;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
})();

export async function stubNetwork(page: Page): Promise<void> {
  await page.route('**/api/themes/*/bundle', (route) =>
    route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (route) =>
    route.request().resourceType() === 'image'
      ? route.fulfill({ status: 200, contentType: 'image/png', body: placeholder })
      : route.abort(),
  );
}

// ---------------------------------------------------------------------------------------------
// /dev/snippets
// ---------------------------------------------------------------------------------------------

/**
 * A /dev page is ready when its canvas is (data-theme-status): the navigation's budget (10 s) covers
 * it. Every /dev page loads every dev harness (about 550 modules from the dev server), which takes
 * about 7 s in Firefox under parallel load, so the 'load' event plus the default 5 s is too tight.
 */
export const PAGE_READY = { timeout: 10_000 };

export async function openSnippets(page: Page, opts: { theme?: string; doc?: string } = {}): Promise<void> {
  const q = new URLSearchParams({ theme: opts.theme ?? '5ePHB', doc: opts.doc ?? 'empty' });
  await page.goto(`/dev/snippets?${q.toString()}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-theme-status]')).toHaveAttribute('data-theme-status', 'ready', PAGE_READY);
  await expect(page.locator('[data-snippets-status]')).toHaveAttribute('data-snippets-status', 'ready');
  await waitSettled(page);
}

/**
 * Waits until theme, fonts and pagination have settled (checked every frame). `timeout` (default:
 * the action timeout, 5 s) is for callers that paginate many pages at once.
 */
export async function waitSettled(page: Page, timeout?: number): Promise<void> {
  const options = timeout ? { timeout } : {};
  await page.waitForFunction(() => window.__hbSnippets?.settled() ?? false, undefined, options);
  // One more frame: pagination may queue a re-check (an image load, a toc resize).
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => window.__hbSnippets?.settled() ?? false, undefined, options);
}

export const pagesLocator = (page: Page): Locator => page.locator('.hb-canvas .ProseMirror > .page');

// ---------------------------------------------------------------------------------------------
// Screenshots and diffs (as e2e/import/fidelity.spec.ts)
// ---------------------------------------------------------------------------------------------

/** Pixel difference (%) above which a page counts as different (plan S3: 2%). */
export const THRESHOLD = 2;

export async function shoot(pages: Locator): Promise<Buffer[]> {
  const count = await pages.count();
  const shots: Buffer[] = [];
  for (let i = 0; i < count; i++) shots.push(await pages.nth(i).screenshot({ animations: 'disabled', caret: 'hide' }));
  return shots;
}

export interface PageDiff {
  page: number;
  diffPercent: number;
  note?: string;
}

export function diffPage(a: Buffer | undefined, b: Buffer | undefined, index: number, saveTo: string | null): PageDiff {
  if (!a || !b) return { page: index + 1, diffPercent: 100, note: a ? 'missing in editor' : 'missing upstream' };
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  const width = Math.max(pa.width, pb.width);
  const height = Math.max(pa.height, pb.height);
  const pad = (p: PNG) => {
    if (p.width === width && p.height === height) return p;
    const out = new PNG({ width, height, fill: true });
    out.data.fill(255);
    PNG.bitblt(p, out, 0, 0, p.width, p.height, 0, 0);
    return out;
  };
  const A = pad(pa);
  const B = pad(pb);
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(A.data, B.data, diff.data, width, height, { threshold: 0.1 });
  const diffPercent = (pixels / (width * height)) * 100;
  if (saveTo && diffPercent >= 0.05) {
    mkdirSync(saveTo, { recursive: true });
    writeFileSync(path.join(saveTo, `p${index + 1}-upstream.png`), a);
    writeFileSync(path.join(saveTo, `p${index + 1}-editor.png`), b);
    writeFileSync(path.join(saveTo, `p${index + 1}-diff.png`), PNG.sync.write(diff));
  }
  return { page: index + 1, diffPercent: Math.round(diffPercent * 1000) / 1000 };
}

export interface UpstreamRender {
  shots: Buffer[];
  /** Per page: content overflowed the page (upstream clipped it; the editor paginates it). */
  clipped: boolean[];
}

/**
 * Waits until the CSS images (mask, background, border images: the watercolor masks, page
 * textures) under the matched elements have loaded and a frame has been painted. Both harness
 * pages only wait for <img> elements. The URLs are collected synchronously (the upstream render
 * is a sandboxed frame without scripts: no timers or load events run there) and preloaded in
 * `host`, which shares the HTTP cache.
 */
export async function settleCssImages(pages: Locator, host: Page): Promise<void> {
  const urls = await pages.evaluateAll((els) => {
    const found = new Set<string>();
    const props = ['mask-image', '-webkit-mask-image', 'background-image', 'border-image-source'];
    for (const root of els) {
      const win = root.ownerDocument.defaultView!;
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const style = win.getComputedStyle(el);
        for (const prop of props) for (const m of style.getPropertyValue(prop).matchAll(/url\("?([^")]+)"?\)/g)) found.add(m[1]!);
      }
    }
    return [...found];
  });
  await host.evaluate(async (list) => {
    await Promise.all(
      list.map(
        (src) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            setTimeout(() => resolve(), 5000); // a stalled image shows as a diff, not a hang
            img.src = src;
          }),
      ),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, urls);
}

/**
 * Moves the app to `url` through its router (no page load): pushState, then the popstate the data
 * router listens to.
 */
async function routerNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }, url);
  await expect(page).toHaveURL((u) => `${u.pathname}${u.search}` === url);
}

/**
 * Screenshots of an S3 fixture's upstream render (/dev/legacy-render). The first fixture loads the
 * page; the next ones go through the router (via /dev, so the render page mounts afresh with its
 * status 'loading'): a dev page load takes about 7 s in Firefox, a route change milliseconds.
 */
export async function upstreamShots(page: Page, fixture: string): Promise<UpstreamRender> {
  const url = `/dev/legacy-render?fixture=${encodeURIComponent(fixture)}`;
  if (new URL(page.url()).pathname === '/dev/legacy-render') {
    await routerNavigate(page, '/dev');
    await expect(page.locator('[data-render-status]')).toHaveCount(0);
    await routerNavigate(page, url);
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: 'header { display: none !important; }' });
  }
  const frame = page.locator('[data-render-status]').first();
  await expect(frame).toHaveAttribute('data-render-status', /ready|error/, PAGE_READY);
  expect(await frame.getAttribute('data-render-status'), `legacy render of ${fixture}`).toBe('ready');
  const pages = page.frameLocator('iframe[title="Upstream render"]').locator('.pages > .page');
  await settleCssImages(pages, page);
  // In-flow content past the page's content box: a column right of it, or a block below it.
  // The harness's own `&nbsp; \column &nbsp;` tail (upstream's column hack) doesn't count.
  const clipped = await pages.evaluateAll((els) =>
    els.map((pageEl) => {
      const wrap = pageEl.querySelector(':scope > .columnWrapper');
      if (!wrap) return false;
      const box = wrap.getBoundingClientRect();
      const win = pageEl.ownerDocument.defaultView!;
      return [...wrap.children].some((child) => {
        if (child.classList.contains('columnSplit') || win.getComputedStyle(child).position === 'absolute') return false;
        // \s includes the no-break space of the tail's &nbsp;.
        if (child.children.length === 0 && !(child.textContent ?? '').replace(/\s+/g, '')) return false;
        return [...child.getClientRects()].some((r) => r.width > 1 && r.height > 1 && (r.left >= box.right + 1 || r.bottom > box.bottom + 1));
      });
    }),
  );
  return { shots: await shoot(pages), clipped };
}

/** Kinds of the editor's pages ('manual' | 'auto'), in order. */
export const pageKinds = (page: Page): Promise<string[]> => pagesLocator(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-kind') ?? 'manual'));
