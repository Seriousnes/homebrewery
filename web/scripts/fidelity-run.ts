// The S3 import fidelity run in one command (plan §7 S3, P6.2). From web/:
//
//   pnpm exec tsx scripts/fidelity-run.ts                       # Chromium, every fixture, report written
//   pnpm exec tsx scripts/fidelity-run.ts --browsers chromium,firefox --variants keep,trailing-break
//                                                         # what e2e/fixtures/fidelity-report.md was made with
//
// Options:
//   --browsers <list>   Playwright projects, comma-separated (default chromium). The first is the main run.
//   --variants <list>   extra Chromium runs shown as report columns (default none):
//                         keep            hbfmToDoc({ variables: 'keep' }) instead of expanding variables
//                         trailing-break  the canvas.css rule proposed in fidelity-findings.md
//                         plain           a bare TipTap editor instead of EditorCanvas
//   --port <n>          E2E_PORT for the dev server (default $E2E_PORT or 5303 + 1000 × slot). One isolated Vite
//                       (e2e/matrix/vite.isolated.config.mjs) serves every run; one already there is reused.
//   --filter <regex>    only matching fixtures (FIDELITY_FILTER)
//   --workers <n>       Playwright workers (default: playwright.config.ts's). On a busy machine
//                       Firefox needs fewer (e.g. 4), or pages time out while the dev modules load.
//   --out <file>        report file (default e2e/fixtures/fidelity-report.md)
//   --set=<n>[,<n>…]    only those sets (numbered from 1 across the runs; an invalid number lists them).
//                       A run's saved results are replaced when its first set runs; later sets add
//                       to them, so a full run can be made one set per command, then the report.
//   --no-report         run only
//   --report-only       no runs: rebuild the report from test-results/fidelity-runs (same --browsers/--variants)
//
// Every run (a browser or a variant) is split into short SETS (CLAUDE.md "Tests fail fast"): one
// Playwright run per SET_SIZE fixtures (`--shard=k/n`), each well under the 5-minute cap and under
// the runners' no-progress watchdog (scripts/testRunner.ts); every fixture is its
// own short test. The sets run one after the other and the script stops at the first set that
// fails, then prints each set's wall time. Playwright empties test-results/<port> on every run, so
// each set's JSON results are copied to test-results/fidelity-runs/<run> before the next set
// starts; the report is built from there (after a failure too, from what ran).
// Exits non-zero when a set failed (a harness error, not a diff over the threshold).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pickSets, type PlaywrightSet, takeSetArg, TestRunner, webDir } from './testRunner.ts';
import { slotPort } from './worktree.ts';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const list = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean);

const port = arg('--port', process.env.E2E_PORT ?? slotPort(5303));
const browsers = list(arg('--browsers', 'chromium'));
const variants = list(arg('--variants', ''));
const filter = arg('--filter', '');
const workers = arg('--workers', '');
const out = arg('--out', 'e2e/fixtures/fidelity-report.md');
const { only } = takeSetArg(process.argv.slice(2));
const runsDir = path.join(webDir, 'test-results', 'fidelity-runs');
/** Fixtures per set: about a minute in Chromium at 6 workers. */
const SET_SIZE = 50;

const VARIANTS: Record<string, { env: Record<string, string>; label: string }> = {
  keep: { env: { FIDELITY_VARIABLES: 'keep' }, label: 'variables=keep' },
  'trailing-break': { env: { FIDELITY_EXPERIMENT: 'trailing-break' }, label: 'canvas.css trailing-break proposal' },
  plain: { env: { FIDELITY_VIEW: 'plain' }, label: 'plain TipTap view' },
};
for (const v of variants) {
  if (!VARIANTS[v]) {
    console.error(`Unknown variant "${v}" (known: ${Object.keys(VARIANTS).join(', ')}).`);
    process.exit(2);
  }
}
if (!browsers.length) {
  console.error('No browsers given.');
  process.exit(2);
}

interface Run {
  name: string;
  project: string;
  env: Record<string, string>;
  label: string;
}
const runs: Run[] = [
  ...browsers.map((b) => ({ name: b, project: b, env: {}, label: b })),
  ...variants.map((v) => ({ name: `${browsers[0]}-${v}`, project: browsers[0]!, env: VARIANTS[v]!.env, label: VARIANTS[v]!.label })),
];

let failed = false;
mkdirSync(runsDir, { recursive: true });
const runner = new TestRunner('fidelity');
runner.refuseHumanPorts(port);
const toRun = process.argv.includes('--report-only') ? [] : runs;
if (toRun.length) {
  // As many sets per run as SET_SIZE needs for the fixtures selected (fidelity.spec.ts: FIDELITY=all or FIDELITY_FILTER).
  const manifest = JSON.parse(readFileSync(path.join(webDir, 'e2e', 'fixtures', 'fixtures.json'), 'utf8')) as { fixtures: { name: string }[] };
  const selected = manifest.fixtures.filter((f) => !filter || new RegExp(filter).test(f.name)).length;
  const count = Math.max(1, Math.ceil(selected / SET_SIZE));
  const runOf = new Map<string, { run: Run; first: boolean }>();
  const all: PlaywrightSet[] = toRun.flatMap((run) =>
    Array.from({ length: count }, (_, i) => {
      const name = `${run.name} ${i + 1}/${count}`;
      runOf.set(name, { run, first: i === 0 });
      return {
        name,
        args: ['e2e/import/fidelity.spec.ts', `--project=${run.project}`, `--shard=${i + 1}/${count}`, ...(workers ? [`--workers=${workers}`] : [])],
        // E2E_FIREFOX=all: the firefox project runs only the editing specs otherwise (playwright.config.ts).
        env: { FIDELITY: 'all', E2E_FIREFOX: 'all', ...(filter ? { FIDELITY_FILTER: filter } : {}), FIDELITY_OUT: run.name, ...run.env },
      };
    }),
  );
  let sets: PlaywrightSet[] = [];
  try {
    sets = pickSets(all, only);
  } catch (error) {
    runner.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  runner.log(`${selected} fixtures per run in ${count} set(s) of at most ${SET_SIZE}; runs: ${toRun.map((r) => `${r.name} (${r.label})`).join(', ')}; port ${port}`);
  let baseUrl = '';
  try {
    ({ url: baseUrl } = await runner.startVite({ port, config: 'e2e/matrix/vite.isolated.config.mjs' }));
  } catch (error) {
    runner.error(error instanceof Error ? error.message : String(error));
    await runner.exit(1);
  }
  // A run's saved results are replaced when its first set runs (with --set, later sets add to them).
  for (const set of sets) {
    const { run, first } = runOf.get(set.name)!;
    if (first) rmSync(path.join(runsDir, run.name), { recursive: true, force: true });
  }
  const result = await runner.runSets(sets, {
    env: { E2E_PORT: port, E2E_BASE_URL: baseUrl },
    // Keep the set's results: the next set's run empties test-results/<port> first.
    afterSet: (set) => {
      const { run } = runOf.get(set.name)!;
      const from = path.join(webDir, 'test-results', port, 'fidelity-results', run.name);
      if (existsSync(from)) cpSync(from, path.join(runsDir, run.name), { recursive: true });
      else {
        console.error(`No results for ${set.name} in ${from}.`);
        failed = true;
      }
    },
  });
  if (result.status !== 0) failed = true;
}

if (!process.argv.includes('--no-report')) {
  const [main, ...others] = runs;
  const alts = others.flatMap((r) => ['--alt', path.join(runsDir, r.name), '--alt-label', r.label]);
  const report = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/fidelity-report.ts', '--results', path.join(runsDir, main!.name), '--out', out, ...alts], {
    cwd: webDir,
    stdio: 'inherit',
  });
  if (report.status !== 0) failed = true;
}
await runner.exit(failed ? 1 : 0);
