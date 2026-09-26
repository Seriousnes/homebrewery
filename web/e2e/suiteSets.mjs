// The whole e2e suite as several short Playwright runs ("sets"), for e2e/matrix/run-suite.mjs
// (private API, as CI) and e2e/run-playwright.mjs (`npm run e2e`, no API). Every Playwright run is
// capped at 5 minutes (playwright.config.ts globalTimeout; CLAUDE.md "Tests fail fast"), so a big
// suite is never one run: first the parallel projects (chromium, firefox) in groups of folders
// (SETS), then the @serial tests (time budgets: one worker, nothing else running) in
// chromium-serial and in firefox-serial. Firefox runs only the editing and pagination specs
// (playwright.config.ts FIREFOX_SPECS), so most sets are Chromium only. The runner stops at the
// first set that fails and prints each set's wall time; a set over 4 minutes is flagged: split it
// (move folders to another set). The full suite runs in CI; locally, run the unit tests, the specs
// of the area you change and `npm run e2e:smoke` (docs/testing.md).
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickSets } from '../scripts/testRunner.ts';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The parallel projects' sets: folders (and top-level specs) of web/e2e, grouped so each set takes
 * about 2 minutes at 6 workers (estimated from the sets measured on 2026-09-26, before the Firefox
 * restriction and the removed harness duplicates; run-suite.mjs prints each set's time and its test
 * time per folder, to rebalance when a set grows). The first set is Chromium only; the second has
 * one Firefox spec (toolbar/keymap), the last two most of them. A folder no set names runs in the
 * last set (and is reported).
 */
export const SETS = [
  { name: 'a11y, snippets, objects, inspector, panels', paths: ['e2e/a11y', 'e2e/smoke.spec.ts', 'e2e/dev-schema.spec.ts', 'e2e/snippets', 'e2e/snippets-editor', 'e2e/objects', 'e2e/inspector', 'e2e/panels'] },
  { name: 'shell, toolbar, save, flows, lists, admin, export', paths: ['e2e/shell', 'e2e/toolbar', 'e2e/ui-kit', 'e2e/save', 'e2e/flows', 'e2e/lists', 'e2e/admin', 'e2e/export'] },
  { name: 'canvas, pagination, sections', paths: ['e2e/canvas', 'e2e/pagination', 'e2e/sections'] },
  { name: 'matrix, import, perf', paths: ['e2e/matrix', 'e2e/import', 'e2e/import-ui', 'e2e/perf', 'e2e/security'] },
];

/** Top-level entries of web/e2e with specs: folders holding a *.spec.ts, and *.spec.ts files (not _scratch ones). */
export function specEntries() {
  const isSpec = (name) => /^[^_].*\.spec\.ts$/.test(name);
  const hasSpec = (dir) => readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasSpec(path.join(dir, e.name)) : isSpec(e.name)));
  return readdirSync(path.join(webDir, 'e2e'), { withFileTypes: true })
    .filter((e) => (e.isDirectory() ? hasSpec(path.join(webDir, 'e2e', e.name)) : isSpec(e.name)))
    .map((e) => `e2e/${e.name}`);
}

/** Test time per top-level folder of web/e2e, largest first (from TestRunner's finished tests). */
export function timePerFolder(tests) {
  const byFolder = new Map();
  for (const t of tests) {
    const folder = t.location.split('/').slice(0, 2).join('/').replace(/:\d+$/, '');
    byFolder.set(folder, (byFolder.get(folder) ?? 0) + t.duration);
  }
  return [...byFolder]
    .sort((a, b) => b[1] - a[1])
    .map(([folder, ms]) => `${folder} ${Math.round(ms / 1000)} s`)
    .join(', ');
}

/**
 * The sets for `args` (playwright arguments; give options their values with `=`):
 *   - no file or folder filter: SETS, then the two serial sets;
 *   - a filter: one parallel set with it, then the two serial sets with it.
 * Options go to every set (--workers not to the serial ones). Each set gets its own output folder
 * test-results/<port>-<set>: a run empties its folder first, which would drop the traces of the
 * sets before it. A --grep may select nothing in a set: that is not a failure.
 * `only` (set numbers from 1, e.g. from --set=2,6) keeps just those sets.
 */
export function planSets(args, { port, only = null, log = console.log }) {
  const filters = args.filter((a) => !a.startsWith('-'));
  const options = args.filter((a) => a.startsWith('-'));
  let groups = [{ name: 'parallel', paths: filters }];
  if (!filters.length) {
    const named = new Set(SETS.flatMap((s) => s.paths));
    const unnamed = specEntries().filter((p) => !named.has(p));
    if (unnamed.length) log(`not in a set in e2e/suiteSets.mjs, so run in the last parallel set: ${unnamed.join(', ')}`);
    groups = SETS.map((s, i) => (i === SETS.length - 1 ? { ...s, paths: [...s.paths, ...unnamed] } : s));
  }
  const slug = (name) => name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const sets = [
    ...groups.map((g) => ({
      name: g.name,
      args: ['--project=chromium', '--project=firefox', '--pass-with-no-tests', `--output=test-results/${port}-${slug(g.name)}`, ...g.paths, ...options],
    })),
    ...['chromium', 'firefox'].map((browser) => ({
      name: `serial ${browser}`,
      args: [
        `--project=${browser}-serial`,
        '--workers=1',
        '--pass-with-no-tests',
        `--output=test-results/${port}-${browser}-serial`,
        ...filters,
        ...options.filter((a) => !a.startsWith('--workers')),
      ],
    })),
  ];
  return pickSets(sets, only);
}
