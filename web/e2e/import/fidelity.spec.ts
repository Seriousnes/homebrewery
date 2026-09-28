// S3 import fidelity harness (plan §7, S3; P6.2 "Done when"): for each fixture in
// e2e/fixtures/*.hbfm.txt, screenshot every page of the upstream-style render
// (/dev/legacy-render) and of the imported document (/dev/import: hbfmToDoc, then EditorCanvas
// read-only), and diff them page by page with pixelmatch. Each test writes its result as JSON;
// scripts/fidelity-report.ts turns them into e2e/fixtures/fidelity-report.md.
//
// The whole run is one command (from web/; see scripts/fidelity-run.ts): it runs every fixture as
// several short Playwright runs (sets of about 50 fixtures, each well under the 5-minute cap), then
// writes the report:
//   pnpm exec tsx scripts/fidelity-run.ts                 # Chromium, all fixtures, writes the report
//   pnpm exec tsx scripts/fidelity-run.ts --browsers chromium,firefox
// or a few fixtures by hand:
//   E2E_PORT=5303 FIDELITY_FILTER='^md-emojis' pnpm exec playwright test e2e/import/fidelity.spec.ts --project=chromium
//   pnpm exec tsx scripts/fidelity-report.ts --results test-results/5303/fidelity-results/chromium
//
// Switches (environment):
//   FIDELITY_VIEW=plain              a bare TipTap editor instead of EditorCanvas (/dev/import?view=plain)
//   FIDELITY_VARIABLES=keep          import with hbfmToDoc({ variables: 'keep' })
//   FIDELITY_EXPERIMENT=<name>       an experimental canvas rule (/dev/import?experiment=<name>)
//   FIDELITY_OUT=<name>              results under fidelity-results/<name> instead of the project name
//   FIDELITY_FILTER=<regex>          only matching fixtures
//   FIDELITY=all                     every fixture (309; fidelity-run.ts splits them into sets)
// Without FIDELITY=all (or a filter) only a smoke subset runs, in the default e2e run. Each fixture
// is its own short test either way. The harness itself is asserted (both renders work, no page
// errors); the diffs are the report's business.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { DOM_READY, test } from './helpers';

interface FixtureInfo {
  name: string;
  kind: string;
  source: string;
  theme: string;
  note?: string;
}

const fixturesDir = path.resolve(import.meta.dirname, '..', 'fixtures');
const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'fixtures.json'), 'utf8')) as { fixtures: FixtureInfo[] };

const SMOKE =
  /^(?:welcome|md-basic-001-.*|md-mustache-syntax-00[1-3]-.*|md-variables-00[1-2]-.*|md-definition-lists-00[1-2]-.*|snippet-5ephb-phb-(?:front-cover-page|monster-stat-block)|snippet-5ephb-tables-class-tables-full-caster-class-table)$/;
// A few of them are in the e2e smoke set (@smoke, `pnpm run e2e:smoke`).
const E2E_SMOKE = /^(?:md-basic-001-.*|md-mustache-syntax-001-.*|md-variables-001-.*|md-definition-lists-001-.*|snippet-5ephb-phb-monster-stat-block)$/;
const filter = process.env.FIDELITY_FILTER ? new RegExp(process.env.FIDELITY_FILTER) : null;
const fixtures = manifest.fixtures.filter((f) => {
  if (filter) return filter.test(f.name);
  if (process.env.FIDELITY === 'all') return true;
  return SMOKE.test(f.name);
});

/** FIDELITY_VIEW=plain: a bare TipTap editor (no NodeViews) instead of EditorCanvas. */
const VIEW = process.env.FIDELITY_VIEW === 'plain' ? 'plain' : 'canvas';
/** FIDELITY_VARIABLES=keep: variables left as written instead of expanded. */
const VARIABLES = process.env.FIDELITY_VARIABLES === 'keep' ? 'keep' : 'expand';
/** FIDELITY_EXPERIMENT=<name>: /dev/import?experiment=<name> (CSS experiments, see ImportDevPage). */
const EXPERIMENT = process.env.FIDELITY_EXPERIMENT ?? '';

function importUrl(fixture: string): string {
  const q = new URLSearchParams({ fixture });
  if (VIEW !== 'canvas') q.set('view', VIEW);
  if (VARIABLES !== 'expand') q.set('variables', VARIABLES);
  if (EXPERIMENT) q.set('experiment', EXPERIMENT);
  return `/dev/import?${q.toString()}`;
}

/** Pixel difference (%) above which a page counts as different (plan S3: 2%). */
const THRESHOLD = 2;

// A fixed stand-in for external images (imgur, creativecommons.org): both renders get the same
// bytes, so the diff doesn't depend on the network.
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

async function prepare(page: Page): Promise<void> {
  // No API here: the theme bundle endpoint answers 404, so themeLoader uses /themes/themes.json.
  await page.route('**/api/themes/*/bundle', (route) =>
    route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
  );
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (route) =>
    route.request().resourceType() === 'image'
      ? route.fulfill({ status: 200, contentType: 'image/png', body: placeholder })
      : route.abort(),
  );
}

async function waitReady(target: Page, what: string): Promise<Locator> {
  const frame = target.locator('[data-render-status]').first();
  // As long as a navigation (playwright.config.ts): goto resolves at DOMContentLoaded (DOM_READY),
  // and the render (a 12-page fixture included) follows within a few seconds.
  await expect(frame, `${what} did not finish`).toHaveAttribute('data-render-status', /ready|error/, { timeout: 10_000 });
  const status = await frame.getAttribute('data-render-status');
  if (status !== 'ready') {
    const bar = (await target.locator('header').first().textContent()) ?? '';
    const error = (await target.locator('pre').first().textContent().catch(() => '')) ?? '';
    throw new Error(`${what}: ${bar} ${error}`.trim());
  }
  return frame;
}

/** The dev pages' sticky header bar would cover the top of the first page. */
const HIDE_BARS = 'header { display: none !important; }';

async function shoot(pages: Locator): Promise<Buffer[]> {
  const count = await pages.count();
  const shots: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    shots.push(await pages.nth(i).screenshot({ animations: 'disabled', caret: 'hide' }));
  }
  return shots;
}

interface PageDiff {
  page: number;
  diffPercent: number;
  size: string;
  note?: string;
}

function diffPage(a: Buffer | undefined, b: Buffer | undefined, index: number, saveTo: string | null): PageDiff {
  if (!a || !b) return { page: index + 1, diffPercent: 100, size: '-', note: a ? 'missing in import' : 'missing upstream' };
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
    writeFileSync(path.join(saveTo, `p${index + 1}-import.png`), b);
    writeFileSync(path.join(saveTo, `p${index + 1}-diff.png`), PNG.sync.write(diff));
  }
  const size = pa.width === pb.width && pa.height === pb.height ? `${width}x${height}` : `${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`;
  return { page: index + 1, diffPercent: Math.round(diffPercent * 1000) / 1000, size };
}

test.describe('S3 import fidelity', () => {
  test.describe.configure({ mode: 'parallel' });

  for (const fixture of fixtures) {
    test(fixture.name, { tag: E2E_SMOKE.test(fixture.name) ? '@smoke' : [] }, async ({ page }, testInfo) => {
      // Two full dev page loads (the upstream render, then the import) and a screenshot of every
      // page of both. Firefox loads each dev page's ~520 modules in 3-5 s, so a 1-page fixture took
      // 6-13 s and the 12-page welcome brew 10-21 s, depending on the machine's load.
      test.setTimeout(30_000);
      // One page after the other, in the same page: loading both at once in two pages was slower in
      // Firefox (the render in the page without focus stalled past its 10 s wait).
      await prepare(page);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto(`/dev/legacy-render?fixture=${encodeURIComponent(fixture.name)}`, DOM_READY);
      await waitReady(page, 'legacy render');
      await page.addStyleTag({ content: HIDE_BARS });
      const upstreamShots = await shoot(page.frameLocator('iframe[title="Upstream render"]').locator('.pages > .page'));

      await page.goto(importUrl(fixture.name), DOM_READY);
      await waitReady(page, 'import');
      await page.addStyleTag({ content: HIDE_BARS });
      const report = await page.evaluate(() => (window as unknown as { __hbImport?: { report: unknown } }).__hbImport?.report ?? null);
      const importShots = await shoot(page.locator('.hb-canvas .ProseMirror > .page'));

      const saveDir = testInfo.outputPath('pages');
      const count = Math.max(upstreamShots.length, importShots.length);
      const pages: PageDiff[] = [];
      for (let i = 0; i < count; i++) pages.push(diffPage(upstreamShots[i], importShots[i], i, saveDir));
      const maxDiff = pages.reduce((m, p) => Math.max(m, p.diffPercent), 0);

      const result = {
        fixture: fixture.name,
        kind: fixture.kind,
        source: fixture.source,
        project: testInfo.project.name,
        view: VIEW,
        variables: VARIABLES,
        experiment: EXPERIMENT || null,
        upstreamPages: upstreamShots.length,
        importPages: importShots.length,
        maxDiff,
        meanDiff: pages.length ? Math.round((pages.reduce((s, p) => s + p.diffPercent, 0) / pages.length) * 1000) / 1000 : 0,
        pages,
        report,
        errors,
        artifacts: path.relative(path.resolve(import.meta.dirname, '..', '..'), saveDir).replaceAll('\\', '/'),
      };
      const outDir = path.join(testInfo.project.outputDir, 'fidelity-results', process.env.FIDELITY_OUT ?? testInfo.project.name);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, `${fixture.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
      await testInfo.attach('fidelity.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });

      // The harness itself must work; the diff is the report's business (plan S3).
      expect(upstreamShots.length, 'upstream pages').toBeGreaterThan(0);
      expect(importShots.length, 'imported pages').toBeGreaterThan(0);
      expect(errors, 'page errors').toEqual([]);
      if (maxDiff >= THRESHOLD) testInfo.annotations.push({ type: 'fidelity', description: `max page diff ${maxDiff}%` });
    });
  }
});
