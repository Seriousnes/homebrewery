// Aggregates the S3 fidelity results (JSON written by e2e/import/fidelity.spec.ts) into
// web/e2e/fixtures/fidelity-report.md. Usually run by scripts/fidelity-run.ts; by hand:
//
//   E2E_PORT=5303 FIDELITY_FILTER='^md-emojis' pnpm exec playwright test e2e/import/fidelity.spec.ts --project=chromium
//   pnpm exec tsx scripts/fidelity-report.ts [--results test-results/5303/fidelity-results/chromium] [--out e2e/fixtures/fidelity-report.md]
//     [--threshold 2] [--alt <results dir> --alt-label <label>]…   other runs (Firefox, variables=keep, …) as extra columns
//
// A fixture passes when every page is under the threshold and the page counts match. A fixture
// over the threshold only on pages the import report lists as clipped upstream counts as
// "clipped upstream (expected)": upstream cut that content off, the editor paginates it onto new
// pages, so those pages are meant to differ (the harness itself renders without pagination).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slotPort } from './worktree.ts';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const port = process.env.E2E_PORT ?? slotPort(5303);
const resultsDir = path.resolve(webDir, arg('--results', `test-results/${port}/fidelity-results/chromium`));
const outFile = path.resolve(webDir, arg('--out', 'e2e/fixtures/fidelity-report.md'));
const THRESHOLD = Number(arg('--threshold', '2'));

interface PageDiff {
  page: number;
  diffPercent: number;
  size: string;
  note?: string;
}
interface Report {
  pages: number;
  clippedPages: Array<{ page: number; estimatedPages: number }>;
  variables: { mode?: 'expand' | 'keep'; definitions: Array<{ name: string }>; unresolved: Array<{ page: number; call: string }> };
  rawHtml: { count: number; samples: string[] };
  commentsDropped: number;
  styleTagsLifted: number;
  unknownClasses: Array<{ name: string; count: number }> | null;
  sanitizer: { elements: Record<string, number>; attributes: Record<string, number> };
  transparentElements: Record<string, number>;
  lifted: { markers: number; footers: number; pageNumbers: number; objects: number };
  positionedInFlow: Array<{ page: number; tag: string; classes: string[] }>;
  lost: string[];
  warnings: string[];
}
interface Result {
  fixture: string;
  kind: string;
  source: string;
  project: string;
  view?: string;
  variables?: string;
  experiment?: string | null;
  upstreamPages: number;
  importPages: number;
  maxDiff: number;
  meanDiff: number;
  pages: PageDiff[];
  report: Report | null;
  errors: string[];
  artifacts: string;
}
type Status = 'pass' | 'expected' | 'fail';

const altDirs: Array<{ dir: string; label: string }> = [];
process.argv.forEach((a, i) => {
  if (a === '--alt' && process.argv[i + 1]) {
    const label = process.argv[i + 2] === '--alt-label' ? (process.argv[i + 3] ?? '') : '';
    altDirs.push({ dir: path.resolve(webDir, process.argv[i + 1]!), label: label || path.basename(process.argv[i + 1]!) });
  }
});

if (!existsSync(resultsDir)) {
  console.error(`No results in ${resultsDir}. Run the Playwright spec first (see the header of this file).`);
  process.exit(1);
}
const load = (dir: string): Result[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Result)
    .sort((a, b) => a.fixture.localeCompare(b.fixture));

/** pass: under the threshold with matching page counts; expected: over only on pages upstream clipped. */
function statusOf(r: Result | undefined): Status {
  if (!r) return 'fail';
  if (r.upstreamPages !== r.importPages) return 'fail';
  const over = r.pages.filter((p) => p.diffPercent >= THRESHOLD).map((p) => p.page);
  if (!over.length) return 'pass';
  const clipped = new Set((r.report?.clippedPages ?? []).map((c) => c.page));
  return over.every((p) => clipped.has(p)) ? 'expected' : 'fail';
}
const STATUS_TEXT: Record<Status, string> = { pass: 'pass', expected: 'clipped upstream (expected)', fail: 'fail' };

const results = load(resultsDir);
const alts = altDirs.map((a) => ({ ...a, byFixture: new Map(load(a.dir).map((r) => [r.fixture, r])) }));
const pct = (n: number): string => `${n.toFixed(2)}%`;
const share = (n: number, of: number): string => `${n} / ${of} (${of ? ((n / of) * 100).toFixed(1) : '0'}%)`;
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const altCells = (fixture: string): string =>
  alts
    .map((a) => {
      const r = a.byFixture.get(fixture);
      return ` ${r ? pct(r.maxDiff) : '—'} |`;
    })
    .join('');
const altHead = alts.map((a) => ` Max (${a.label}) |`).join('');
const altRule = alts.map(() => '---:|').join('');

const manifestFile = path.join(webDir, 'e2e', 'fixtures', 'fixtures.json');
const manifest = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, 'utf8')) as { fixtures: Array<{ name: string }>; skipped: string[] }) : null;

const statuses = new Map(results.map((r) => [r.fixture, statusOf(r)]));
const count = (list: Result[], s: Status) => list.filter((r) => statuses.get(r.fixture) === s).length;
const byKind = new Map<string, Result[]>();
for (const r of results) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);

/** How a run was made (view, variables mode, experiment). */
function runLabel(list: Result[]): string {
  const r = list[0];
  if (!r) return '?';
  const parts = [`browser ${r.project}`, `view ${r.view ?? 'plain'}`, `variables ${r.variables ?? 'expand'}`];
  if (r.experiment) parts.push(`experiment ${r.experiment}`);
  return parts.join(', ');
}

/** Lossy constructs of one fixture, as short phrases. */
function lossy(r: Result): string[] {
  const rep = r.report;
  if (!rep) return ['(no import report)'];
  const out: string[] = [];
  if (r.upstreamPages !== r.importPages) out.push(`pages ${r.upstreamPages} → ${r.importPages}`);
  if (rep.rawHtml.count) out.push(`rawHtml ×${rep.rawHtml.count}`);
  if (rep.positionedInFlow.length) out.push(`positioned kept in flow: ${rep.positionedInFlow.map((p) => `${p.tag}${p.classes.map((c) => `.${c}`).join('')}`).join(', ')}`);
  if (rep.lifted.objects) out.push(`objects ×${rep.lifted.objects}`);
  if (rep.lifted.markers) out.push(`markers ×${rep.lifted.markers}`);
  if (rep.lifted.footers) out.push(`footer ×${rep.lifted.footers}`);
  if (rep.lifted.pageNumbers) out.push(`page number ×${rep.lifted.pageNumbers}`);
  const transparent = Object.entries(rep.transparentElements);
  if (transparent.length) out.push(`dropped tags/attrs: ${transparent.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  const removed = Object.entries(rep.sanitizer.elements);
  if (removed.length) out.push(`sanitizer removed: ${removed.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  const attrs = Object.entries(rep.sanitizer.attributes);
  if (attrs.length) out.push(`sanitizer attrs: ${attrs.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  if (rep.commentsDropped) out.push(`comments ×${rep.commentsDropped}`);
  if (rep.styleTagsLifted) out.push(`<style> lifted ×${rep.styleTagsLifted}`);
  const keep = rep.variables.mode === 'keep';
  if (rep.variables.definitions.length) out.push(`variables ${keep ? 'kept as written' : 'inlined'}: ${rep.variables.definitions.map((d) => d.name).join(', ')}`);
  if (rep.variables.unresolved.length) out.push(`${keep ? 'calls kept' : 'unresolved'}: ${rep.variables.unresolved.map((u) => u.call).join(' ')}`);
  if (rep.clippedPages.length) out.push(`clipped upstream: ${rep.clippedPages.map((c) => `p${c.page}→~${c.estimatedPages}`).join(', ')}`);
  if (rep.unknownClasses?.length) out.push(`unknown classes: ${rep.unknownClasses.map((c) => c.name).join(' ')}`);
  if (rep.lost.length) out.push(`lost: ${rep.lost.map((l) => l.replace(/^page \d+: /, '')).join('; ')}`);
  if (rep.warnings.length) out.push(`warnings: ${rep.warnings.join('; ')}`);
  if (r.errors.length) out.push(`page errors: ${r.errors.join('; ')}`);
  return out;
}

const lines: string[] = [];
lines.push('# S3 import fidelity report');
lines.push('');
lines.push('Generated by `web/scripts/fidelity-run.ts` (Playwright `web/e2e/import/fidelity.spec.ts`, then `web/scripts/fidelity-report.ts`; plan §7 S3, P6.2).');
lines.push('Each fixture is rendered the upstream way (`/dev/legacy-render`: marked-hbfm, safeHTML, the trailing column hack, in an');
lines.push('iframe) and imported (`/dev/import`: hbfmToDoc, then the editor\'s EditorCanvas, read-only, no pagination), both with the');
lines.push('same scoped theme CSS and fonts; every page is screenshotted and diffed with pixelmatch (threshold 0.1). Diff % = differing');
lines.push(`pixels / page pixels. A fixture passes when every page is under ${THRESHOLD}% and the page counts match; one that is over only`);
lines.push('on pages upstream clipped counts as "clipped upstream (expected)" (the editor paginates that content onto new pages).');
lines.push('');
const under = count(results, 'pass');
const expected = count(results, 'expected');
lines.push(`- Main run: ${runLabel(results)}; fixtures run: **${results.length}**${manifest ? ` of ${manifest.fixtures.length}` : ''}`);
lines.push(`- Under ${THRESHOLD}%: **${share(under, results.length)}** — target ≥ 90%`);
lines.push(`- Clipped upstream (expected): ${expected}; failures: ${results.length - under - expected}`);
for (const [kind, list] of byKind) lines.push(`  - ${kind}: ${count(list, 'pass')} / ${list.length}${count(list, 'expected') ? ` (+${count(list, 'expected')} expected)` : ''}`);
for (const a of alts) {
  const list = [...a.byFixture.values()];
  const altStatus = new Map(list.map((r) => [r.fixture, statusOf(r)]));
  const pass = list.filter((r) => altStatus.get(r.fixture) === 'pass').length;
  const better = list.filter((r) => altStatus.get(r.fixture) === 'pass' && statuses.get(r.fixture) !== 'pass' && statuses.has(r.fixture)).map((r) => r.fixture);
  const worse = list.filter((r) => altStatus.get(r.fixture) !== 'pass' && statuses.get(r.fixture) === 'pass').map((r) => r.fixture);
  const names = (l: string[]) => (l.length ? `: ${l.slice(0, 12).map((n) => `\`${n}\``).join(', ')}${l.length > 12 ? ', …' : ''}` : '');
  lines.push(`- **${a.label}** (${runLabel(list)}): under ${THRESHOLD}% ${share(pass, list.length)}; passes where the main run doesn't: ${better.length}${names(better)}; fails where the main run passes: ${worse.length}${names(worse)}`);
}
const all = results.flatMap((r) => r.pages.map((p) => p.diffPercent));
all.sort((a, b) => a - b);
if (all.length) lines.push(`- Pages: ${all.length}; median diff ${pct(all[Math.floor(all.length / 2)]!)}, 90th percentile ${pct(all[Math.floor(all.length * 0.9)]!)}, max ${pct(all[all.length - 1]!)}`);
if (manifest?.skipped.length) lines.push(`- Generators not turned into fixtures (they fail outside upstream's editor): ${manifest.skipped.map((s) => `\`${esc(s)}\``).join(', ')}`);
lines.push('');

// Hand-written analysis (causes of the remaining failures, needed changes), kept next to the report.
const findingsFile = path.join(path.dirname(outFile), 'fidelity-findings.md');
if (existsSync(findingsFile)) {
  lines.push(readFileSync(findingsFile, 'utf8').trim());
  lines.push('');
}

// Lossy constructs across all fixtures: how many fixtures have each, and their worst diff.
const constructs = new Map<string, { fixtures: number; worst: number }>();
const bumpConstruct = (key: string, r: Result) => {
  const c = constructs.get(key) ?? { fixtures: 0, worst: 0 };
  c.fixtures++;
  c.worst = Math.max(c.worst, r.maxDiff);
  constructs.set(key, c);
};
for (const r of results) {
  const rep = r.report;
  if (!rep) continue;
  const keys = new Set<string>();
  if (rep.rawHtml.count) keys.add('rawHtml node kept');
  for (const p of rep.positionedInFlow) keys.add(`positioned element kept in the flow (${p.tag}${p.classes.map((c) => `.${c}`).join('')})`);
  if (rep.lifted.objects) keys.add('page objects lifted');
  if (rep.lifted.markers) keys.add('page markers lifted');
  if (rep.lifted.footers) keys.add('footer lifted');
  if (rep.lifted.pageNumbers) keys.add('page number lifted');
  for (const k of Object.keys(rep.transparentElements)) keys.add(`tag/attributes dropped by the parser: ${k}`);
  for (const k of Object.keys(rep.sanitizer.elements)) keys.add(`sanitizer removed <${k}>`);
  for (const k of Object.keys(rep.sanitizer.attributes)) keys.add(`sanitizer removed [${k}]`);
  if (rep.commentsDropped) keys.add('HTML comments dropped');
  if (rep.styleTagsLifted) keys.add('<style> moved into the brew CSS');
  if (rep.variables.definitions.length) keys.add(rep.variables.mode === 'keep' ? 'variables kept as written' : 'variables inlined');
  if (rep.variables.unresolved.length) keys.add(rep.variables.mode === 'keep' ? '$[…] calls kept as written' : 'unresolved $[…] calls kept as text');
  if (rep.clippedPages.length) keys.add('page clipped content upstream');
  if (rep.unknownClasses?.length) keys.add('classes not in the theme stylesheets');
  for (const l of rep.lost) keys.add(`lost: ${l.replace(/^page \d+: /, '').replace(/".*"/, '"…"').replace(/ \.[\w.-]+:/, ':')}`);
  for (const k of keys) bumpConstruct(k, r);
}
lines.push('## Lossy constructs across fixtures');
lines.push('');
lines.push('| Construct | Fixtures | Worst fixture diff |');
lines.push('|---|---:|---:|');
for (const [k, c] of [...constructs].sort((a, b) => b[1].fixtures - a[1].fixtures || a[0].localeCompare(b[0]))) {
  lines.push(`| ${esc(k)} | ${c.fixtures} | ${pct(c.worst)} |`);
}
lines.push('');

const over = results.filter((r) => statuses.get(r.fixture) !== 'pass').sort((a, b) => b.maxDiff - a.maxDiff);
lines.push(`## Over the threshold (${over.length})`);
lines.push('');
if (over.length) {
  lines.push(`| Fixture | Status | Max page diff |${altHead} Pages (upstream → import) | Per page | Lossy constructs |`);
  lines.push(`|---|---|---:|${altRule}---|---|---|`);
  for (const r of over) {
    lines.push(`| \`${r.fixture}\` | ${STATUS_TEXT[statuses.get(r.fixture)!]} | ${pct(r.maxDiff)} |${altCells(r.fixture)} ${r.upstreamPages} → ${r.importPages} | ${r.pages.map((p) => pct(p.diffPercent)).join(', ')} | ${esc(lossy(r).join('; ')) || '—'} |`);
  }
} else lines.push('None.');
lines.push('');

lines.push(`## All fixtures (${results.length})`);
lines.push('');
lines.push(`| Fixture | Source | Status | Max | Mean |${altHead} Pages | Lossy constructs |`);
lines.push(`|---|---|---|---:|---:|${altRule}---|---|`);
for (const r of results) {
  lines.push(`| \`${r.fixture}\` | ${esc(r.source)} | ${STATUS_TEXT[statuses.get(r.fixture)!]} | ${pct(r.maxDiff)} | ${pct(r.meanDiff)} |${altCells(r.fixture)} ${r.upstreamPages} → ${r.importPages} | ${esc(lossy(r).join('; ')) || '—'} |`);
}
lines.push('');

writeFileSync(outFile, `${lines.join('\n')}\n`);
console.log(`${under}/${results.length} fixtures under ${THRESHOLD}% (+${expected} clipped upstream, expected) → ${path.relative(webDir, outFile)}`);
