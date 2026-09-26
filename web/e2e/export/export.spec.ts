// P6.4 "Done when" (plan §11): the exported HTML opens offline — loaded from a file:// URL in a
// context with no network, page 1 looks like the editor's page 1 — and has no <script>; printing
// it gives one brew page per sheet (Chromium: page.pdf() sheets = brew pages; Firefox: print media
// layout). The brew comes from /dev/export (a read-only canvas, as the share page shows it).
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  attachImage,
  diffImages,
  exportFromDev,
  openExportDev,
  openOffline,
  pageBoxes,
  pageShot,
  pdfSheets,
  writeExport,
} from './helpers';

test.use({ viewport: { width: 1400, height: 1300 } });

/** Largest share of differing pixels allowed between the editor's page and the file's. */
const MAX_DIFF = 0.005;

const CASES = [
  { name: 'inn (5ePHB: chrome, objects, TOC, header rows, same-origin images, brew CSS)', doc: 'inn', theme: '5ePHB' },
  { name: 'inn (Blank)', doc: 'inn', theme: 'Blank' },
  { name: 's1 (drop cap, note, stat block, table, wide, column break)', doc: 's1', theme: '5ePHB' },
  { name: 'chrome (cover page, objects, page counters)', doc: 'chrome', theme: '5ePHB' },
] as const;

for (const c of CASES) {
  test(`${c.name}: the file opens offline and every page matches the editor`, async ({ page, browser }, testInfo) => {
    await openExportDev(page, { doc: c.doc, theme: c.theme });
    const exported = await exportFromDev(page);
    const { html, report } = exported;
    await testInfo.attach('report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });

    // No scripts, not even as text; one document with the editor's DOM.
    expect(/<script/i.test(html), 'a <script> in the file').toBe(false);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.external).toEqual([]);
    expect(report.fontsSettled).toBe(true);
    const pages = await page.locator('.hb-canvas .pages > .page').count();
    expect(report.pages).toBe(pages);

    const path = writeExport(testInfo, html);
    const offline = await openOffline(browser, path);
    try {
      const file = offline.page;
      expect(offline.requests, 'network requests of the offline file').toEqual([]);
      expect(await file.locator('script').count()).toBe(0);
      await expect(file.locator('body.hb-canvas > .pages > .page')).toHaveCount(pages);
      // Every image and every font it uses is in the file.
      const broken = await file.evaluate(() => Array.from(document.images).filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.src.slice(0, 80)));
      expect(broken).toEqual([]);
      const fonts = await file.evaluate(() => Array.from(document.fonts).filter((f) => f.status === 'error').map((f) => f.family));
      expect(fonts).toEqual([]);

      for (let i = 1; i <= pages; i++) {
        await page.evaluate((n) => document.getElementById(`p${n}`)?.scrollIntoView(), i);
        await page.evaluate(async (n) => {
          const images = Array.from(document.querySelectorAll<HTMLImageElement>(`#p${n} img`));
          for (const img of images) if (img.loading === 'lazy') img.loading = 'eager';
          await Promise.all(images.filter((img) => !img.complete).map((img) => new Promise((r) => ((img.onload = r), (img.onerror = r)))));
        }, i);
        const editorShot = await pageShot(page, `.hb-canvas #p${i}`);
        const fileShot = await pageShot(file, `#p${i}`);
        const d = diffImages(editorShot, fileShot);
        if (d.ratio > 0) {
          await attachImage(testInfo, `editor-p${i}.png`, editorShot);
          await attachImage(testInfo, `file-p${i}.png`, fileShot);
          await attachImage(testInfo, `diff-p${i}.png`, d.image);
        }
        console.log(`[export] ${testInfo.project.name} ${c.doc}/${c.theme} p${i}: ${d.pixels} px (${(d.ratio * 100).toFixed(3)}%)`);
        expect(d.ratio, `page ${i} differs from the editor's`).toBeLessThanOrEqual(MAX_DIFF);
      }
    } finally {
      await offline.context.close();
    }
  });
}

test("the file's DOM is the read-only editor's DOM (header rows in <thead>)", async ({ page, browser, browserName }, testInfo) => {
  await openExportDev(page, { doc: 'inn' });
  // The file carries Chromium's form of ProseMirror's hacks; compare Firefox with its own.
  const { html } = await exportFromDev(page, { separators: browserName !== 'firefox' });
  const normalize = (root: Element, editor: boolean): string => {
    const clone = root.cloneNode(true) as Element;
    if (editor) {
      for (const el of Array.from(clone.querySelectorAll('*'))) {
        // Editor-only: chrome markers, object ids, lazy loading, the objects' JSON, and the page
        // pagination is measuring (pagination/layout.ts MEASURING_ATTR).
        for (const name of ['data-hb-chrome', 'data-object-id', 'draggable', 'loading', 'data-objects', 'data-hb-measuring']) el.removeAttribute(name);
        el.classList.remove('ProseMirror-selectednode');
      }
      for (const table of Array.from(clone.querySelectorAll('table'))) {
        const tbody = table.querySelector(':scope > tbody');
        const rows = Array.from(tbody?.children ?? []).filter((r) => r.classList.contains('hb-header-row'));
        if (!tbody || rows.length === 0) continue;
        const thead = document.createElement('thead');
        for (const row of rows) {
          row.classList.remove('hb-header-row');
          thead.append(row);
        }
        table.insertBefore(thead, tbody);
      }
    }
    for (const el of Array.from(clone.querySelectorAll('*'))) {
      if (el.getAttribute('class') === '') el.removeAttribute('class');
      const attrs = Array.from(el.attributes)
        .map((a) => [a.name, a.value] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      for (const [name] of attrs) el.removeAttribute(name);
      for (const [name, value] of attrs) el.setAttribute(name, value);
    }
    return clone.innerHTML;
  };
  // (Passed to evaluate as is: the file's CSP allows no eval.)
  const editorDom = await page.locator('.hb-canvas .pages').evaluate(normalize, true);
  const offline = await openOffline(browser, writeExport(testInfo, html));
  try {
    const fileDom = await offline.page.locator('body > .pages').evaluate(normalize, false);
    // Same-origin files are data: URIs in the file (url() tokens quoted): put both in one form.
    const urls = (dom: string, file: RegExp) => dom.replace(file, 'FILE').replace(/url\((?:"|&quot;)?FILE(?:"|&quot;)?\)/g, 'url(FILE)');
    const fileSide = urls(fileDom, /data:[a-z+/.-]+;base64,[A-Za-z0-9+/=]+/g);
    const editorSide = urls(editorDom, /\/assets\/[A-Za-z0-9_.-]+/g);
    if (fileSide !== editorSide) {
      await testInfo.attach('file-dom.html', { body: fileSide, contentType: 'text/plain' });
      await testInfo.attach('editor-dom.html', { body: editorSide, contentType: 'text/plain' });
      writeFileSync(testInfo.outputPath('file-dom.html'), fileSide);
      writeFileSync(testInfo.outputPath('editor-dom.html'), editorSide);
    }
    expect(fileSide).toBe(editorSide);
  } finally {
    await offline.context.close();
  }
});

test('the file carries the TOC, page ids, header rows and links of the editor', async ({ page, browser }, testInfo) => {
  await openExportDev(page, { doc: 'inn' });
  const { html } = await exportFromDev(page);
  const offline = await openOffline(browser, writeExport(testInfo, html));
  try {
    const file = offline.page;
    // Page ids p1…pN, as in the editor.
    const ids = await file.locator('.pages > .page').evaluateAll((els) => els.map((el) => el.id));
    expect(ids).toEqual(ids.map((_, i) => `p${i + 1}`));
    // The TOC lists the chapters with their page numbers; the stat block's heading (5ePHB:
    // `.monster { --TOC: exclude }`) is left out, as in the editor.
    const editorToc = await page.locator('.hb-canvas .toc').first().innerText();
    const fileToc = await file.locator('.toc').first().innerText();
    expect(fileToc).toBe(editorToc);
    expect(fileToc).toContain('Chapter One: Arrival');
    expect(fileToc).not.toContain('Innkeeper');
    // Header rows are a real <thead>.
    await expect(file.locator('table thead tr th')).toHaveCount(2);
    await expect(file.locator('table tbody tr')).toHaveCount(4);
    // Links to pages and headings still work inside the file.
    await expect(file.locator('a[href="#p3"]')).toHaveCount(1);
    const tocHref = await file.locator('.toc a').first().getAttribute('href');
    expect(tocHref).toMatch(/^#/);
    await expect(file.locator(tocHref!)).toHaveCount(1);
    // No editor state and no app chrome.
    await expect(file.locator('[data-hb-chrome], [data-object-id], .hb-oversized-badge, [data-objects]')).toHaveCount(0);
    await expect(file.locator('.pages')).toHaveAttribute('contenteditable', 'false');
    await expect(file.locator('html')).toHaveAttribute('lang', 'en');
    await expect(file).toHaveTitle('Export test (inn)');
  } finally {
    await offline.context.close();
  }
});

test("other sites' images stay links and are listed in the report", async ({ page }, testInfo) => {
  await openExportDev(page, { doc: 'external' });
  const { html, report } = await exportFromDev(page);
  expect(report.external).toEqual(['https://images.example.invalid/export-test/map.png']);
  expect(report.failed).toEqual([]);
  expect(html.includes('src="https://images.example.invalid/export-test/map.png"'), 'the external image stays a link').toBe(true);
  // Same-origin files are still written in.
  expect(report.inlined).toBeGreaterThan(0);
  expect(/url\("?http:\/\/localhost[^)]*\/assets\/discord\.png/.test(html), 'the badge image is written in').toBe(false);
  writeExport(testInfo, html);
});

test('printing the file gives one brew page per sheet', async ({ page, browser, browserName }, testInfo) => {
  await openExportDev(page, { doc: 'inn' });
  const { html, report } = await exportFromDev(page);
  expect(report.pageSize).toBe('816px 1056px');
  const offline = await openOffline(browser, writeExport(testInfo, html));
  try {
    const file = offline.page;
    await file.emulateMedia({ media: 'print' });
    const boxes = await pageBoxes(file);
    expect(boxes).toHaveLength(report.pages);
    // Stacked edge to edge from the top of the first sheet: no margins, shadows or backdrop.
    boxes.forEach((box, i) => {
      expect(box.top).toBeCloseTo(i * box.height, 0);
      expect(box.left).toBeCloseTo(0, 0);
      expect(box.margin).toBe('0px 0px 0px 0px');
      expect(box.shadow).toBe('none');
    });
    const backdrop = await file.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    expect(backdrop).toBe('rgba(0, 0, 0, 0)');
    if (browserName === 'chromium') {
      const sheets = pdfSheets(await file.pdf({ preferCSSPageSize: true }));
      expect(sheets).toHaveLength(report.pages);
      for (const sheet of sheets) {
        expect(sheet.width).toBeCloseTo(612, 0);
        expect(sheet.height).toBeCloseTo(792, 0);
      }
      // The default paper (Letter) too.
      expect(pdfSheets(await file.pdf())).toHaveLength(report.pages);
    }
  } finally {
    await offline.context.close();
  }
});

test('A5 pages print on A5 sheets (the default @page size follows the pages)', async ({ page, browser, browserName }, testInfo) => {
  await openExportDev(page, { doc: 'a5' });
  const { html, report } = await exportFromDev(page);
  // 148 mm × 210 mm in CSS px (the layout's own values, unrounded).
  // (Chromium lays 210 mm out as 793.6875 px, Firefox as 793.7 px: exact binary fractions.)
  const [width, height] = (report.pageSize ?? '').split(' ').map((v) => parseFloat(v));
  expect(width).toBeCloseTo((148 / 25.4) * 96, 1);
  expect(height).toBeCloseTo((210 / 25.4) * 96, 1);
  expect(report.pageSize).toMatch(/^\d+(\.\d+)?px \d+(\.\d+)?px$/);
  const offline = await openOffline(browser, writeExport(testInfo, html));
  try {
    const file = offline.page;
    await file.emulateMedia({ media: 'print' });
    const boxes = await pageBoxes(file);
    expect(boxes).toHaveLength(report.pages);
    boxes.forEach((box, i) => expect(box.top).toBeCloseTo(i * box.height, 0));
    if (browserName === 'chromium') {
      // Whatever the dialog's paper: the file's @page size wins.
      const sheets = pdfSheets(await file.pdf({ preferCSSPageSize: true }));
      expect(sheets).toHaveLength(report.pages);
      for (const sheet of sheets) {
        expect(sheet.width).toBeCloseTo((148 / 25.4) * 72, 0);
        expect(sheet.height).toBeCloseTo((210 / 25.4) * 72, 0);
      }
    }
  } finally {
    await offline.context.close();
  }
});

test('the file has no active content and a CSP without scripts', async ({ page }, testInfo) => {
  await openExportDev(page, { doc: 'inn' });
  const { html } = await exportFromDev(page);
  const path = writeExport(testInfo, html);
  const text = readFileSync(path, 'utf8');
  // (Booleans, not the text: a failure must not print a file full of data: URIs.)
  expect(text.includes(`<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`), 'the CSP').toBe(true);
  expect(/<[^>]*\son[a-z]+\s*=/i.test(text), 'an event handler attribute').toBe(false);
  expect(/javascript:/i.test(text), 'a javascript: URL').toBe(false);
  // Theme fonts and images are data: URIs, not links back to the site.
  expect(/url\("data:font\/woff2;base64,/.test(text), 'a font written in').toBe(true);
  expect(/src="data:image\/jpeg;base64,/.test(text), 'an image written in').toBe(true);
});
