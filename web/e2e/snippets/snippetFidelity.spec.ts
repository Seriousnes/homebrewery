// P5.1 "Done when": every V3 snippet inserts and renders like its S3 fixture.
//
// For every snippet fixture in e2e/fixtures (scripts/fidelity-fixtures.ts wrote one per theme
// generator), the upstream render (/dev/legacy-render) is compared page by page with the snippet
// inserted through the Insert menu's pipeline into an empty, paginated document
// (/dev/snippets): pixelmatch, 2% per page, same page count.
//
// - Generators run in the browser with the fixture script's seeded Math.random (mulberry32,
//   reseeded from sha256("<theme>/<group>/<names>")), so their output must equal the fixture
//   text (asserted; theme modules write location.origin into image URLs, the script had '').
//   Generators that are plain strings built when the theme module loads (monster and class
//   table blocks: lodash randomness at import time) can't be replayed; for them the fixture's
//   text goes through the same pipeline.
// - Native snippets (page numbers, markers, new page) run their editor command.
// - Style snippets: the fixture's sample body is imported, the generated CSS added to the style.
// - The empty line an inserted block leaves for the cursor at the end of the page is removed
//   before comparing (it is the user's empty paragraph, not part of the snippet).
//
// Two selections of the same check, both made of short tests (CLAUDE.md "Tests fail fast"):
// - the smoke (default run): the first fixture of every theme and group (11), SMOKE_CHUNK per test;
// - every fixture (149) with SNIPPET_FIDELITY=all (or a SNIPPET_FILTER): CHUNK fixtures per test,
//   each test well under a minute; about a minute and a half per browser at 6 workers, one
//   Playwright run per browser. A local tool, not in CI; Firefox needs
//   E2E_FIREFOX=all:
//     SNIPPET_FIDELITY=all E2E_PORT=5327 pnpm exec playwright test e2e/snippets/snippetFidelity.spec.ts --project=chromium
// The upstream render page is loaded once per test; each next fixture is a route change (upstreamShots).
//
// Run: E2E_PORT=5327 pnpm exec playwright test e2e/snippets/snippetFidelity.spec.ts
// SNIPPET_FILTER=<regex> limits the fixtures. Results: test-results/<port>/snippet-fidelity/<project>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, expect, type Page, test, type TestInfo } from '@playwright/test';
import {
  diffPage,
  pageKinds,
  installSeededRandom,
  openSnippets,
  pagesLocator,
  seedOf,
  settleCssImages,
  shoot,
  stubNetwork,
  THRESHOLD,
  upstreamShots,
  waitSettled,
  type PageDiff,
  type RawSnippetInfo,
} from './helpers';

interface FixtureInfo {
  name: string;
  kind: string;
  source: string;
}

const fixturesDir = path.resolve(import.meta.dirname, '..', 'fixtures');
const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'fixtures.json'), 'utf8')) as { fixtures: FixtureInfo[] };
const filter = process.env.SNIPPET_FILTER ? new RegExp(process.env.SNIPPET_FILTER) : null;

interface SnippetFixture extends FixtureInfo {
  theme: string;
  group: string;
  names: string[];
  text: string;
}

const snippets: SnippetFixture[] = manifest.fixtures
  .filter((f) => f.kind === 'snippet' && (!filter || filter.test(f.name)))
  .map((f) => {
    const [file = '', group = '', ...names] = f.source.split(' › ');
    const theme = /themes\/V3\/([^/]+)\//.exec(file)?.[1] ?? '';
    return { ...f, theme, group, names, text: readFileSync(path.join(fixturesDir, `${f.name}.hbfm.txt`), 'utf8') };
  });

/**
 * Fixtures over the threshold for a cause outside the snippet pipeline, with a ceiling that
 * still catches regressions. The S3 import report (e2e/fixtures/fidelity-findings.md) also had
 * the class tables (header rows in <tbody>) and the GNU FDL (empty <dt>) here; both are at 0%
 * now, so they get the normal 2%.
 */
const KNOWN: Record<string, { limit: number; cause: string }> = {
  'snippet-blank-license-orc-notice': { limit: 4, cause: 'empty <dt> trailing break (canvas.css)' },
};

const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\s+$/, '');

/** The CSS of a style fixture and the sample body after it. */
function splitStyleFixture(text: string): { css: string; body: string } {
  const match = /^```css\n([\s\S]*?)\n```\n\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  return match ? { css: match[1]!, body: match[2]! } : { css: '', body: text };
}

const groupKeys = [...new Set(snippets.map((s) => `${s.theme}/${s.group}`))];
const inGroup = (key: string) => snippets.filter((s) => `${s.theme}/${s.group}` === key);
const chunked = (list: SnippetFixture[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** Every fixture (SNIPPET_FIDELITY=all or a filter): chunks of fixtures per theme and group, so tests run in parallel. */
const FULL = process.env.SNIPPET_FIDELITY === 'all' || Boolean(filter);
const CHUNK = 8;
const chunks: SnippetFixture[][] = groupKeys.flatMap((key) => chunked(inGroup(key), CHUNK));

/** The smoke (default run): the first fixture of every theme and group, SMOKE_CHUNK per test. */
const SMOKE_CHUNK = 3;
const smokeChunks: SnippetFixture[][] = chunked(
  groupKeys.map((key) => inGroup(key)[0]!),
  SMOKE_CHUNK,
);

interface SnippetResult {
  fixture: string;
  source: string;
  how: string;
  generatorMatchesFixture: boolean | null;
  upstreamPages: number;
  editorPages: number;
  autoPages: number;
  clippedUpstream: boolean;
  maxDiff: number;
  pages: PageDiff[];
  known: string | null;
  errors: string[];
}

async function insertFixture(editor: Page, fixture: SnippetFixture, raw: RawSnippetInfo | undefined, origin: string): Promise<{ how: string; matches: boolean | null }> {
  await editor.evaluate(() => window.__hbSnippets!.reset());
  await waitSettled(editor);
  if (!raw) throw new Error(`generator not found: ${fixture.source}`);
  const key = `${fixture.theme}/${fixture.group}/${fixture.names.join('/')}`;
  const args = [fixture.theme, fixture.group, fixture.names] as const;

  if (raw.view === 'style') {
    const { css, body } = splitStyleFixture(fixture.text);
    const generated = await editor.evaluate(([t, g, n, seed]) => window.__hbSnippets!.generate(t, g, n, seed), [...args, seedOf(key)] as const);
    const matches = normalize(generated.replaceAll(origin, '')) === normalize(css);
    await editor.evaluate((md) => window.__hbSnippets!.loadMarkdown(md), body);
    await waitSettled(editor);
    const before = await editor.evaluate(() => window.__hbSnippets!.cssApplied());
    await editor.evaluate((c) => window.__hbSnippets!.appendStyleSnippet(c), generated);
    await expect.poll(() => editor.evaluate(() => window.__hbSnippets!.cssApplied())).toBeGreaterThan(before);
    return { how: 'style snippet added to the brew CSS', matches };
  }

  if (raw.native) {
    const outcome = await editor.evaluate(([t, g, n]) => window.__hbSnippets!.runRawNative(t, g, n), args);
    return { how: `native ${raw.native}: ${outcome?.message ?? 'no change'}`, matches: null };
  }

  const generated = await editor.evaluate(([t, g, n, seed]) => window.__hbSnippets!.generate(t, g, n, seed), [...args, seedOf(key)] as const);
  const matches = normalize(generated.replaceAll(origin, '')) === normalize(fixture.text);
  // A string built at theme-module load time (random values fixed then): the fixture's text.
  const markdown = matches || raw.kind === 'function' ? generated : fixture.text;
  const outcome = await editor.evaluate((md) => window.__hbSnippets!.insertMarkdown(md), markdown);
  await editor.evaluate(() => window.__hbSnippets!.dropCursorLine());
  const how = `${raw.kind === 'function' ? 'generator' : 'string'}${markdown === generated ? '' : ' (fixture text: generated at theme load)'}: ${outcome.message}`;
  return { how, matches: raw.kind === 'string' && !matches ? null : matches };
}

/** Renders each fixture of `chunk` upstream and in the editor, and compares them page by page. */
async function checkChunk(page: Page, context: BrowserContext, testInfo: TestInfo, chunk: SnippetFixture[]): Promise<void> {
  const upstream = await context.newPage();
  const errors: string[] = [];
  for (const p of [page, upstream]) {
    p.on('pageerror', (e) => errors.push(e.message));
    await stubNetwork(p);
  }
  await installSeededRandom(page);
  await openSnippets(page, { theme: '5ePHB' });
  // The dev page's sticky bar would cover the top of a page in screenshots.
  await page.addStyleTag({ content: 'header { display: none !important; }' });
  const origin = new URL(page.url()).origin;
  const raws = new Map<string, RawSnippetInfo[]>();
  const outDir = path.join(testInfo.project.outputDir, 'snippet-fidelity', testInfo.project.name);
  mkdirSync(outDir, { recursive: true });

  for (const fixture of chunk) {
    if (!raws.has(fixture.theme)) raws.set(fixture.theme, await page.evaluate((t) => window.__hbSnippets!.rawEntries(t), fixture.theme));
    const raw = raws.get(fixture.theme)!.find((r) => r.group === fixture.group && r.names.join('\u0000') === fixture.names.join('\u0000'));
    const before = errors.length;

    const upstreamRender = await upstreamShots(upstream, fixture.name);
    const { how, matches } = await insertFixture(page, fixture, raw, origin);
    await waitSettled(page);
    await page.evaluate(() => window.__hbSnippets!.prepareScreenshot());
    await settleCssImages(pagesLocator(page), page);
    const allShots = await shoot(pagesLocator(page));
    const kinds = await pageKinds(page);
    // Upstream page i is the editor's i-th manual page; auto pages hold what upstream clipped.
    const editorPng = allShots.filter((_, i) => kinds[i] !== 'auto');
    const autoPages = kinds.filter((k) => k === 'auto').length;
    const clippedUpstream = upstreamRender.clipped.some(Boolean);

    const saveDir = testInfo.outputPath(fixture.name);
    const count = Math.max(upstreamRender.shots.length, editorPng.length);
    const pages: PageDiff[] = [];
    for (let i = 0; i < count; i++) {
      const diff = diffPage(upstreamRender.shots[i], editorPng[i], i, saveDir);
      if (upstreamRender.clipped[i]) diff.note = 'overflowed upstream (clipped there; the editor paginates it)';
      pages.push(diff);
    }
    const maxDiff = pages.reduce((m, p) => Math.max(m, p.diffPercent), 0);
    const known = KNOWN[fixture.name] ?? null;
    const result: SnippetResult = {
      fixture: fixture.name,
      source: fixture.source,
      how,
      generatorMatchesFixture: matches,
      upstreamPages: upstreamRender.shots.length,
      editorPages: editorPng.length,
      autoPages,
      clippedUpstream,
      maxDiff,
      pages,
      known: known ? known.cause : null,
      errors: errors.slice(before),
    };
    writeFileSync(path.join(outDir, `${fixture.name}.json`), `${JSON.stringify(result, null, 2)}\n`);

    expect.soft(raw, `${fixture.name}: generator found`).toBeTruthy();
    if (matches !== null) expect.soft(matches, `${fixture.name}: generator output equals the fixture text`).toBe(true);
    expect.soft(editorPng.length, `${fixture.name}: manual page count`).toBe(upstreamRender.shots.length);
    // Overflow onto auto pages only where upstream's content overflowed its page too.
    if (!clippedUpstream) expect.soft(autoPages, `${fixture.name}: auto pages (upstream didn't overflow)`).toBe(0);
    expect.soft(maxDiff, `${fixture.name}: max page diff % (${how})`).toBeLessThan(known ? known.limit : THRESHOLD);
    if (known && maxDiff >= THRESHOLD) testInfo.annotations.push({ type: 'known', description: `${fixture.name}: ${maxDiff}% (${known.cause})` });
    if (clippedUpstream) testInfo.annotations.push({ type: 'clipped upstream', description: `${fixture.name}: ${autoPages} auto page(s)` });
  }
  expect(errors, 'page errors').toEqual([]);
  await upstream.close();
}

const titleOf = (chunk: SnippetFixture[]) => `${chunk[0]!.theme} › ${chunk[0]!.group} (${chunk.map((f) => f.names.join(' › ')).join('; ')})`;

test.describe('snippets render like their S3 fixtures', () => {
  test.describe.configure({ mode: 'parallel' });

  for (const chunk of FULL ? [] : smokeChunks) {
    test(`smoke: ${chunk.map((f) => `${f.theme} › ${f.group} › ${f.names.join(' › ')}`).join('; ')}`, async ({ page, context }, testInfo) => {
      // Two dev page loads (/dev/snippets and /dev/legacy-render, about 7 s each in Firefox under
      // load), then three fixtures rendered both ways and screenshotted.
      test.setTimeout(30_000);
      await checkChunk(page, context, testInfo, chunk);
    });
  }

  for (const chunk of FULL ? chunks : []) {
    test(titleOf(chunk), async ({ page, context }, testInfo) => {
      // Two dev page loads, then up to 8 fixtures rendered both ways (29 s at most, Firefox, loaded machine).
      test.setTimeout(60_000);
      await checkChunk(page, context, testInfo, chunk);
    });
  }
});
