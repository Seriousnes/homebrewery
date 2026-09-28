// Issue #2 and P6.4 in the app: "Download PDF" next to Print on the share page and in the editor
// (home page), and printing from the app: lazy images loaded before the print dialog, one brew page
// per sheet with no app chrome, the brew's @page size honoured. The API is stubbed (page.route):
// POST /api/export/pdf is rendered by the test browser (stubPdfEndpoint), so this runs without an
// API server.
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
  attachImage,
  blockOtherSites,
  diffImages,
  LOAD_TIMEOUT,
  openOffline,
  pageBoxes,
  pageShot,
  pdfSheets,
  READER,
  stubPdfEndpoint,
  writeExport,
} from './helpers';

test.use({ viewport: { width: 1400, height: 1300 } });

const SHARE_ID = 'shareExp123';
const LAZY_IMAGE = '/assets/redTriangle.png';
const FILLER = 'The road runs past the inn and the inn runs past the road; nobody remembers which one moved first. ';

const t = (text: string) => ({ type: 'text', text });
const p = (text: string) => ({ type: 'paragraph', content: [t(text)] });
const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const page = (content: unknown[]) => ({ type: 'page', attrs: { pageNumber: true, footer: 'Shared brew' }, content });
const cell = (type: string, text: string) => ({ type, content: [p(text)] });

const doc = {
  type: 'doc',
  content: [
    page([
      h(1, 'A Shared Brew'),
      p(FILLER.repeat(3)),
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'd2'), cell('tableHeader', 'Weather')] },
          { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', 'Rain that never lands')] },
          { type: 'tableRow', content: [cell('tableCell', '2'), cell('tableCell', 'Fog with opinions')] },
        ],
      },
      p(FILLER.repeat(2)),
    ]),
    page([h(2, 'The Second Page'), p(FILLER.repeat(4))]),
    page([h(2, 'The Third Page'), { type: 'paragraph', content: [t('A picture far down: '), { type: 'image', attrs: { src: LAZY_IMAGE, alt: 'A red triangle' } }] }]),
  ],
};

const meta = (title: string) => ({ title, description: '', tags: [], lang: 'en', theme: '5ePHB', published: true, thumbnailUrl: null });
const times = { createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
const shareBrew = (style: string, title = 'A Shared Brew') => ({ shareId: SHARE_ID, editId: null, docSchemaVersion: 1, doc, style, meta: meta(title), authors: ['bob'], pageCount: 3, views: 7, ...times });

/** Holds back the lazy image's file: `requested` turns true when the browser asks for it; it answers once `open` resolves. */
interface ImageGate {
  open: Promise<void>;
  requested: boolean;
}

interface ShareOptions {
  /** The brew's CSS. */
  style?: string;
  /** The lazy image answers once it opens. */
  imageGate?: ImageGate;
}

/** The share page of a brew, for a reader who is not signed in. */
async function openShare(page: Page, { style = '', imageGate }: ShareOptions = {}): Promise<void> {
  await blockOtherSites(page);
  await page.route(
    (url) => url.pathname.startsWith('/share/'),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch({ url: new URL('/', route.request().url()).href });
      return route.fulfill({ response });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (pathname === '/api/account/me') return route.fulfill({ status: 204 });
      if (pathname === '/api/notifications/active') return json([]);
      if (pathname === `/api/brews/share/${SHARE_ID}`) return json(shareBrew(style));
      return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
    },
  );
  if (imageGate) {
    await page.route(
      (url) => url.pathname === LAZY_IMAGE,
      async (route) => {
        imageGate.requested = true;
        await imageGate.open;
        await route.fallback();
      },
    );
  }
  await page.goto(`/share/${SHARE_ID}`, { waitUntil: 'domcontentloaded' });
  await waitForApp(page);
}

/** The editor app is ready: canvas ready, pagination settled, fonts loaded. */
async function waitForApp(page: Page): Promise<void> {
  await expect(page.locator('[data-mode][data-canvas-status="ready"]').first()).toBeAttached(LOAD_TIMEOUT);
  await page.waitForFunction(() => (window as unknown as { __hbEditorApp?: { settled: () => boolean } }).__hbEditorApp?.settled() === true, undefined, LOAD_TIMEOUT);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('download-pdf')).toBeEnabled(LOAD_TIMEOUT);
}

/** Replaces window.print: records, at the moment of printing, how many images had loaded. */
async function recordPrints(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__hbPrintLog = [];
    window.print = () => {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>('.hb-canvas .page img:not(.ProseMirror-separator)'));
      window.__hbPrintLog!.push({ images: images.length, complete: images.filter((i) => i.complete && i.naturalWidth > 0).length, broken: images.filter((i) => i.complete && i.naturalWidth === 0).length });
    };
  });
}

/** App chrome still rendered under print media (there must be none). */
async function visibleChrome(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const chrome: [string, string][] = [
      ['navbar', 'nav[aria-label="Main"]'],
      ['app bar', '[data-testid="editor-app-bar"]'],
      ['toolbars', '[role="toolbar"]'],
      ['download button', '[data-testid="download-pdf"]'],
      ['skip link', 'a[href="#main-content"]'],
    ];
    return chrome.filter(([, selector]) => Array.from(document.querySelectorAll(selector)).some(visible)).map(([name]) => name);
  });
}

test('share page: a reader who is not signed in downloads the PDF, one sheet per page', async ({ page, browser }, testInfo) => {
  await openShare(page);
  const endpoint = await stubPdfEndpoint(page, browser);
  const button = page.getByTestId('download-pdf');
  await expect(button).toHaveAccessibleName('Download PDF');
  // Right after Print, in the viewing bar.
  const order = await page.getByTestId('editor-app-bar').evaluate((bar) => Array.from(bar.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')));
  expect(order.indexOf('download-pdf')).toBe(order.indexOf('print') + 1);

  const [download] = await Promise.all([page.waitForEvent('download', LOAD_TIMEOUT), button.click()]);
  expect(download.suggestedFilename()).toBe('A Shared Brew.pdf');
  await expect(page.getByText('Downloaded “A Shared Brew.pdf”', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Sign in' })).toHaveCount(0);
  const pages = await page.locator('.hb-canvas .pages > .page').count();
  const sheets = pdfSheets(readFileSync(await download.path()));
  expect(sheets).toHaveLength(pages);
  for (const sheet of sheets) {
    expect(sheet.width).toBeCloseTo(612, 0); // 816 px = 8.5 in
    expect(sheet.height).toBeCloseTo(792, 0);
  }

  // What the API renders: the page's HTML export, without scripts, which looks like the page.
  expect(endpoint.requests).toHaveLength(1);
  const html = endpoint.requests[0]!;
  expect(/<script/i.test(html), 'a <script> in the file').toBe(false);
  const offline = await openOffline(browser, writeExport(testInfo, html, 'A Shared Brew.html'));
  try {
    expect(offline.requests).toEqual([]);
    await expect(offline.page.locator('.pages > .page')).toHaveCount(pages);
    await expect(offline.page).toHaveTitle('A Shared Brew');
    await expect(offline.page.locator('table thead th')).toHaveCount(2);
    const appShot = await pageShot(page, '.hb-canvas #p1');
    const fileShot = await pageShot(offline.page, '#p1');
    const d = diffImages(appShot, fileShot);
    if (d.ratio > 0) {
      await attachImage(testInfo, 'app-p1.png', appShot);
      await attachImage(testInfo, 'file-p1.png', fileShot);
      await attachImage(testInfo, 'diff-p1.png', d.image);
    }
    expect(d.ratio).toBeLessThanOrEqual(0.005);
  } finally {
    await offline.context.close();
  }
});

test('share page: Print waits for lazy images, then prints only the pages, one per sheet', async ({ page, browserName }) => {
  let release: () => void = () => undefined;
  const imageGate: ImageGate = { open: new Promise<void>((resolve) => (release = resolve)), requested: false };
  await openShare(page, { imageGate });
  await recordPrints(page);
  // The picture on page 3 (lazy) is not there: its file answers only once released.
  const loaded = () => page.locator(`.hb-canvas img[src="${LAZY_IMAGE}"]`).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(await loaded()).toBe(false);
  // Print's preparation (printCanvas, web/src/editor/canvas/print.ts) announces its start and end.
  await page.evaluate(() => {
    const prep: string[] = [];
    (window as unknown as { __hbPrintPrep: string[] }).__hbPrintPrep = prep;
    for (const type of ['print:startprep', 'print:finishedprep']) document.addEventListener(type, () => prep.push(type));
  });
  const prep = () => page.evaluate(() => (window as unknown as { __hbPrintPrep: string[] }).__hbPrintPrep);
  await page.getByTestId('print').click();
  // Print waits for it: the preparation has started, the file is asked for (Print loads lazy
  // images first; the browser may have asked earlier), and while it is held back the preparation
  // goes on and nothing is printed (after the release, the print log shows the image loaded).
  await expect.poll(prep).toEqual(['print:startprep']);
  await expect.poll(() => imageGate.requested, { message: 'the lazy image is requested' }).toBe(true);
  expect(await page.evaluate(() => window.__hbPrintLog!.length)).toBe(0);
  expect(await prep()).toEqual(['print:startprep']);
  release();
  // Printed with the image loaded (so after the release: the check above is not a matter of timing).
  await page.waitForFunction(() => (window.__hbPrintLog?.length ?? 0) > 0, undefined, LOAD_TIMEOUT);
  const log = await page.evaluate(() => window.__hbPrintLog!);
  expect(log).toEqual([{ images: 1, complete: 1, broken: 0 }]);
  expect(await prep()).toEqual(['print:startprep', 'print:finishedprep']);

  await page.emulateMedia({ media: 'print' });
  expect(await visibleChrome(page)).toEqual([]);
  const boxes = await pageBoxes(page);
  expect(boxes).toHaveLength(3);
  boxes.forEach((box, i) => {
    expect(box.top).toBeCloseTo(i * box.height, 0);
    expect(box.width).toBeCloseTo(816, 0);
    expect(box.height).toBeCloseTo(1056, 0);
    expect(box.margin).toBe('0px 0px 0px 0px');
    expect(box.shadow).toBe('none');
  });
  if (browserName === 'chromium') {
    const sheets = pdfSheets(await page.pdf());
    expect(sheets).toHaveLength(3);
  }
});

test("share page: the brew's @page size is honoured when printing", async ({ page, browserName }) => {
  await openShare(page, { style: '@page { size: A5; }\n.page { width: 148mm; height: 210mm; padding: 1cm 1.2cm; }' });
  await page.emulateMedia({ media: 'print' });
  const boxes = await pageBoxes(page);
  expect(boxes.length).toBeGreaterThanOrEqual(3);
  boxes.forEach((box, i) => expect(box.top).toBeCloseTo(i * box.height, 0));
  const pageRule = await page.evaluate(() => {
    const rules: string[] = [];
    const visit = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSPageRule) rules.push(rule.style.getPropertyValue('size'));
        else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of [...Array.from(document.styleSheets), ...document.adoptedStyleSheets]) {
      try {
        visit(sheet.cssRules);
      } catch {
        // another origin
      }
    }
    return rules;
  });
  expect(pageRule.map((size) => size.toLowerCase())).toContain('a5');
  if (browserName === 'chromium') {
    const sheets = pdfSheets(await page.pdf({ preferCSSPageSize: true }));
    expect(sheets).toHaveLength(boxes.length);
    for (const sheet of sheets) {
      expect(sheet.width).toBeCloseTo((148 / 25.4) * 72, 0);
      expect(sheet.height).toBeCloseTo((210 / 25.4) * 72, 0);
    }
  }
});

test('home page (signed in): "Download PDF" is in the Brew toolbar, keyboard operable, and axe-clean', async ({ page, browser }) => {
  await blockOtherSites(page);
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/api/account/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(READER) });
      if (pathname === '/api/notifications/active') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
    },
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  const endpoint = await stubPdfEndpoint(page, browser);

  // Roving focus: from Print, ArrowRight reaches Download PDF; Enter exports.
  const print = page.getByTestId('print');
  await print.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('download-pdf')).toBeFocused();
  const [download] = await Promise.all([page.waitForEvent('download', LOAD_TIMEOUT), page.keyboard.press('Enter')]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const pages = await page.locator('.hb-canvas .pages > .page').count();
  expect(pdfSheets(readFileSync(await download.path()))).toHaveLength(pages);
  // (Booleans, not the text: a failure must not print a file full of data: URIs.)
  expect(endpoint.requests).toHaveLength(1);
  expect(/<script/i.test(endpoint.requests[0]!)).toBe(false);

  // Legacy mode: axe in the page (the default mode's extra blank page is slow to open in Firefox).
  const results = await new AxeBuilder({ page }).setLegacyMode(true).include('[data-testid="editor-app-bar"]').analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});
