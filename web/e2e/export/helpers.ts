// Helpers of the export and print specs (P6.4): /dev/export, the exported file opened offline,
// screenshots compared with pixelmatch, PDF sheets.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type Browser, type BrowserContext, expect, type Page, type TestInfo } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * From the end of a navigation to the canvas ready and paginated (a few seconds; the most for a
 * cold Firefox), or an export or print to finish.
 */
export const LOAD_TIMEOUT = { timeout: 10_000 };

/** What window.__hbExport.exportHtml returns (editor/export/exportHtml.ts ExportResult). */
export interface ExportedFile {
  html: string;
  filename: string;
  report: {
    pages: number;
    bytes: number;
    inlined: number;
    inlinedBytes: number;
    external: string[];
    failed: string[];
    removed: number;
    pageSize: string | null;
    fontsSettled: boolean;
  };
}

/** The API answers nothing (static themes, no account): no API server needed. */
export async function stubApi(page: Page): Promise<void> {
  // Match the path, not a glob: `**/api/**` would also catch Vite's /src/api/ modules.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/api/account/me') return route.fulfill({ status: 204 });
      if (pathname === '/api/notifications/active') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
    },
  );
}

/** Other sites never answer (the specs never depend on the internet). */
export async function blockOtherSites(page: Page | BrowserContext): Promise<void> {
  await page.route(
    (url) => /^https?:$/.test(url.protocol) && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
    (route) => route.abort('blockedbyclient'),
  );
}

export interface DevExportOptions {
  doc?: string;
  theme?: string;
  css?: string;
  fixture?: string;
  editable?: boolean;
}

/** Opens /dev/export and waits until the canvas is ready, paginated, and page 1's images loaded. */
export async function openExportDev(page: Page, options: DevExportOptions = {}): Promise<void> {
  await stubApi(page);
  await blockOtherSites(page);
  const params = new URLSearchParams();
  if (options.doc) params.set('doc', options.doc);
  if (options.theme) params.set('theme', options.theme);
  if (options.css !== undefined) params.set('css', options.css);
  if (options.fixture) params.set('fixture', options.fixture);
  if (options.editable) params.set('editable', '1');
  await page.goto(`/dev/export?${params}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-theme-status="ready"]')).toBeAttached(LOAD_TIMEOUT);
  await page.waitForFunction(() => window.__hbExport?.settled() === true, undefined, LOAD_TIMEOUT);
  await settleFonts(page);
}

/**
 * Every page shown once (a browser may load a font or a lazy image only when its page is on
 * screen, and repaginate after it), every image loaded (or failed), fonts settled, pagination
 * settled again: the layout no longer changes while a spec compares it.
 */
export async function settleFonts(page: Page): Promise<void> {
  const count = await page.locator('.hb-canvas .pages > .page').count();
  for (let i = 1; i <= count; i++) {
    await page.evaluate((n) => document.getElementById(`p${n}`)?.scrollIntoView(), i);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('.hb-canvas img'));
    for (const img of images) if (img.loading === 'lazy') img.loading = 'eager';
    await Promise.all(images.filter((img) => !img.complete).map((img) => new Promise((resolve) => ((img.onload = resolve), (img.onerror = resolve)))));
    await document.fonts.ready;
  });
  await page.waitForFunction(() => window.__hbExport?.settled() === true, undefined, LOAD_TIMEOUT);
  await page.evaluate(() => document.getElementById('p1')?.scrollIntoView());
}

/** Exports the brew of /dev/export (the app bar button's code path). */
export async function exportFromDev(page: Page, options: { separators?: boolean } = {}): Promise<ExportedFile> {
  return page.evaluate(async (opts) => {
    const result = await window.__hbExport!.exportHtml(opts);
    return { html: result.html, filename: result.filename, report: result.report };
  }, options);
}

/** Writes `html` into the test's output folder and returns its path. */
export function writeExport(testInfo: TestInfo, html: string, name = 'export.html'): string {
  const path = testInfo.outputPath(name);
  writeFileSync(path, html, 'utf8');
  return path;
}

export interface OfflinePage {
  context: BrowserContext;
  page: Page;
  /** http(s) requests the file made (there must be none, apart from other sites' images). */
  requests: string[];
}

/**
 * Opens the exported file from a file:// URL in a fresh context that has no network at all.
 * Waits for its fonts and images.
 */
export async function openOffline(browser: Browser, path: string, viewport = { width: 1400, height: 1300 }): Promise<OfflinePage> {
  const context = await browser.newContext({ offline: true, viewport });
  const requests: string[] = [];
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await context.route(
    (url) => /^https?:$/.test(url.protocol),
    (route) => route.abort('internetdisconnected'),
  );
  const page = await context.newPage();
  await page.goto(pathToFileURL(path).href, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map((img) => new Promise((resolve) => ((img.onload = resolve), (img.onerror = resolve)))),
    );
    await document.fonts.ready;
  });
  return { context, page, requests };
}

export interface ImageDiff {
  ratio: number;
  pixels: number;
  image: Buffer;
}

/** pixelmatch of two screenshots (sizes may differ by a rounding pixel: the overlap is compared). */
export function diffImages(a: Buffer, b: Buffer): ImageDiff {
  const ra = PNG.sync.read(a);
  const rb = PNG.sync.read(b);
  expect(Math.abs(ra.width - rb.width), 'screenshot widths').toBeLessThanOrEqual(1);
  expect(Math.abs(ra.height - rb.height), 'screenshot heights').toBeLessThanOrEqual(1);
  const width = Math.min(ra.width, rb.width);
  const height = Math.min(ra.height, rb.height);
  const crop = (png: PNG) => {
    if (png.width === width && png.height === height) return png;
    const out = new PNG({ width, height });
    PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
    return out;
  };
  const pa = crop(ra);
  const pb = crop(rb);
  const out = new PNG({ width, height });
  const pixels = pixelmatch(pa.data, pb.data, out.data, width, height, { threshold: 0.1 });
  return { ratio: pixels / (width * height), pixels, image: PNG.sync.write(out) };
}

/** Attaches an image and keeps it in the test's output folder. */
export async function attachImage(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(name);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** Screenshot of one brew page (no caret, no animations). */
export function pageShot(page: Page, selector: string): Promise<Buffer> {
  return page.locator(selector).screenshot({ animations: 'disabled', caret: 'hide' });
}

/** The sheets of a PDF: one MediaBox (points) per /Type /Page object. */
export function pdfSheets(pdf: Buffer): { width: number; height: number }[] {
  const text = pdf.toString('latin1');
  const sheets: { width: number; height: number }[] = [];
  const pageObject = /\/Type\s*\/Page(?![s\w])[\s\S]*?(?=endobj)/g;
  for (const match of text.matchAll(pageObject)) {
    const box = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(match[0]);
    sheets.push(box ? { width: Number(box[3]) - Number(box[1]), height: Number(box[4]) - Number(box[2]) } : { width: NaN, height: NaN });
  }
  return sheets;
}

/** Page boxes under the current media: document position, size, margins, shadow. */
export async function pageBoxes(page: Page): Promise<{ top: number; left: number; width: number; height: number; margin: string; shadow: string }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.hb-canvas .pages > .page')).map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
        height: rect.height,
        margin: `${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}`,
        shadow: style.boxShadow,
      };
    }),
  );
}

declare global {
  interface Window {
    __hbExport?: {
      settled: () => boolean;
      exportHtml: (options?: { separators?: boolean }) => Promise<ExportedFile>;
      print: () => Promise<void>;
    };
    __hbPrintLog?: { images: number; complete: number; broken: number }[];
  }
}
