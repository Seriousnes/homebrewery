// S1 go/no-go (f): page 1 of the S1 document in the editor canvas against the old renderer.
// /dev/canvas?view=legacy renders the same content as Homebrewery markdown with marked-hbfm in
// an iframe set up like upstream's preview (reset + core CSS, unscoped theme files, the
// renderer's column-fill hack), so the comparison covers the whole editor stack: PageView and
// table NodeView DOM, scoped theme CSS, canvas.css and EditorCanvas.
//
// Also a regression baseline per browser and platform in baseline/ (written with
// HB_UPDATE_BASELINE=1; skipped where none exists yet, e.g. a new CI platform).
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { expect, test, type TestInfo } from '@playwright/test';
import { openCanvas } from './helpers';

test.use({ viewport: { width: 1400, height: 1300 } });

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

function diff(a: Buffer, b: Buffer): Diff {
  const ra = PNG.sync.read(a);
  const rb = PNG.sync.read(b);
  expect(Math.abs(ra.width - rb.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(ra.height - rb.height)).toBeLessThanOrEqual(1);
  const [width, height] = [Math.min(ra.width, rb.width), Math.min(ra.height, rb.height)];
  const pa = crop(ra, width, height);
  const pb = crop(rb, width, height);
  const out = new PNG({ width: pa.width, height: pa.height });
  const pixels = pixelmatch(pa.data, pb.data, out.data, pa.width, pa.height, { threshold: 0.1 });
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
  const canvas = await page.locator('#p1').screenshot({ animations: 'disabled', caret: 'hide' });
  await openCanvas(page, { view: 'legacy' });
  const legacy = await page
    .frameLocator('[data-testid="legacy-frame"]')
    .locator('#p1')
    .screenshot({ animations: 'disabled', caret: 'hide' });
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

test('S1 (f) page 1 regression baseline', async ({ page }, testInfo) => {
  await openCanvas(page);
  const shot = await page.locator('#p1').screenshot({ animations: 'disabled', caret: 'hide' });
  await attach(testInfo, 'canvas-p1.png', shot);
  const dir = new URL('./baseline/', import.meta.url);
  const file = new URL(`s1-p1-${testInfo.project.name}-${process.platform}.png`, dir);
  if (process.env.HB_UPDATE_BASELINE === '1') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, shot);
    testInfo.annotations.push({ type: 'baseline', description: `written ${file.pathname}` });
    return;
  }
  test.skip(!existsSync(file), `no baseline for ${testInfo.project.name} on ${process.platform} (HB_UPDATE_BASELINE=1 writes one)`);
  const d = diff(readFileSync(file), shot);
  await attach(testInfo, 'diff-baseline.png', d.image);
  expect(d.ratio).toBeLessThan(0.002);
});
