// S1 go/no-go (f): page 1 of the S1 document in the editor canvas against the old renderer.
// /dev/canvas?view=legacy renders the same content as Homebrewery markdown with marked-hbfm in
// an iframe set up like upstream's preview (reset + core CSS, unscoped theme files, the
// renderer's column-fill hack), so the comparison covers the whole editor stack: PageView and
// table NodeView DOM, scoped theme CSS, canvas.css and EditorCanvas.
//
// The two renders are compared with each other, in one run on one machine, so the host's fonts
// and anti-aliasing affect both alike.
//
// Also a regression baseline per browser in baseline/, on CI's Linux image only (written there
// with HB_UPDATE_BASELINE=1), matched exactly.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { expect, type Locator, type TestInfo } from '@playwright/test';
import { openCanvas, test } from './helpers';

test.use({ viewport: { width: 1400, height: 1300 } });

/**
 * Waits until every image the element and its descendants draw (CSS images of the elements and
 * their ::before/::after, <img>) is loaded and decoded, so a screenshot shows them: the canvas's
 * ready state covers stylesheets and fonts, not the textures a first load paints in later.
 */
async function imagesDecoded(root: Locator): Promise<void> {
  await root.evaluate(async (el) => {
    const win = el.ownerDocument.defaultView!;
    const urls = new Set<string>();
    const properties = ['background-image', 'border-image-source', 'mask-image', '-webkit-mask-image', 'list-style-image', 'content'];
    for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
      for (const pseudo of [null, '::before', '::after']) {
        const cs = win.getComputedStyle(node, pseudo);
        for (const property of properties) for (const m of cs.getPropertyValue(property).matchAll(/url\("([^"]+)"\)/g)) urls.add(m[1]!);
      }
    }
    const decode = (img: HTMLImageElement) => img.decode().catch(() => undefined); // a broken image draws nothing either way
    await Promise.all([
      ...Array.from(urls, (url) => {
        const img = new win.Image();
        img.src = url;
        return decode(img);
      }),
      ...Array.from(el.querySelectorAll('img'), decode),
    ]);
  });
}

interface Diff {
  ratio: number;
  pixels: number;
  image: Buffer;
  /** Differing pixels per 100 px band of the page height (where the differences are). */
  bands: number[];
}

/** The top-left w × h pixels of an image (element screenshots can differ by a rounding pixel). */
function crop(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
  return out;
}

/** Pixels that differ (pixelmatch; `threshold` 0 counts every change of colour). */
function diff(a: Buffer, b: Buffer, threshold = 0.1): Diff {
  const ra = PNG.sync.read(a);
  const rb = PNG.sync.read(b);
  expect(Math.abs(ra.width - rb.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(ra.height - rb.height)).toBeLessThanOrEqual(1);
  const [width, height] = [Math.min(ra.width, rb.width), Math.min(ra.height, rb.height)];
  const pa = crop(ra, width, height);
  const pb = crop(rb, width, height);
  const out = new PNG({ width: pa.width, height: pa.height });
  // (pixelmatch leaves out anti-aliased pixels unless includeAA: an exact comparison counts them.)
  const pixels = pixelmatch(pa.data, pb.data, out.data, pa.width, pa.height, { threshold, includeAA: threshold === 0 });
  const bands: number[] = [];
  for (let y = 0; y < pa.height; y++) {
    for (let x = 0; x < pa.width; x++) {
      const i = (y * pa.width + x) * 4;
      // pixelmatch paints differences red (255, 0, 0).
      if (out.data[i] === 255 && out.data[i + 1] === 0 && out.data[i + 2] === 0) {
        const band = Math.floor(y / 100);
        bands[band] = (bands[band] ?? 0) + 1;
      }
    }
  }
  return { ratio: pixels / (pa.width * pa.height), pixels, image: PNG.sync.write(out), bands: Array.from(bands, (v) => v ?? 0) };
}

/** Attaches the image and keeps it in the test's output folder (test-results/<port>/…). */
async function attach(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  const path = testInfo.outputPath(name);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('S1 (f) page 1 matches the old renderer (marked-hbfm) for the same content', async ({ page }, testInfo) => {
  await openCanvas(page);
  await imagesDecoded(page.locator('#p1'));
  const canvas = await page.locator('#p1').screenshot({ animations: 'disabled', caret: 'hide' });
  await openCanvas(page, { view: 'legacy' });
  const legacyPage = page.frameLocator('[data-testid="legacy-frame"]').locator('#p1');
  await imagesDecoded(legacyPage);
  const legacy = await legacyPage.screenshot({ animations: 'disabled', caret: 'hide' });
  const d = diff(canvas, legacy);
  await attach(testInfo, 'canvas-p1.png', canvas);
  await attach(testInfo, 'legacy-p1.png', legacy);
  await attach(testInfo, 'diff-p1.png', d.image);
  const report = { browser: testInfo.project.name, ratio: +d.ratio.toFixed(4), pixels: d.pixels, bandsOf100px: d.bands };
  console.log(`[canvas-vs-legacy] ${JSON.stringify(report)}`);
  await testInfo.attach('diff.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  // Known difference (P3.1 notes, S1 report): header rows are in <tbody> in the editor, so the
  // theme's `thead` (bold) and `tbody tr:nth-child(odd)` striping differ in the two tables.
  // Everything else — line breaks, column split, stat block, drop cap, chrome — must match.
  expect(d.ratio).toBeLessThan(0.006);
});

// The baseline is pinned to CI's machine: its Playwright image fixes the browsers, the fonts and the
// software rasterizer, so the same build draws the same pixels there, every run (node
// e2e/run-linux.mjs runs it locally). Elsewhere the host's fonts, GPU and display settings change
// the anti-aliasing, and no stored image can be matched exactly.
const PINNED_MACHINE = Boolean(process.env.CI) && process.platform === 'linux';

test('S1 (f) page 1 regression baseline', async ({ page }, testInfo) => {
  test.skip(!PINNED_MACHINE, 'the baseline is pinned to CI’s Linux image: node e2e/run-linux.mjs e2e/canvas/screenshot.spec.ts');
  await openCanvas(page);
  await imagesDecoded(page.locator('#p1'));
  const shot = await page.locator('#p1').screenshot({ animations: 'disabled', caret: 'hide' });
  await attach(testInfo, 'canvas-p1.png', shot);
  const dir = new URL('./baseline/', import.meta.url);
  const file = new URL(`s1-p1-${testInfo.project.name}-linux.png`, dir);
  if (process.env.HB_UPDATE_BASELINE === '1') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, shot);
    testInfo.annotations.push({ type: 'baseline', description: `written ${file.pathname}` });
    return;
  }
  expect(existsSync(file), `a baseline for ${testInfo.project.name} (HB_UPDATE_BASELINE=1 writes one)`).toBe(true);
  const d = diff(readFileSync(file), shot, 0);
  await attach(testInfo, 'diff-baseline.png', d.image);
  expect(d.pixels, 'pixels that differ from the baseline').toBe(0);
});
