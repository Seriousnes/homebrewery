import { defineConfig, devices } from '@playwright/test';
import { slotPort } from './scripts/worktree';

// Target selection:
//   default            starts the Vite dev server on E2E_PORT (5174 in the main checkout,
//                      5174 + 1000 × slot in other worktrees: scripts/worktree.ts) — no build needed
//   E2E_PREVIEW=1      serves the existing build (src/Homebrewery.Api/wwwroot) with `vite preview`
//   E2E_BASE_URL=…     runs against an already running server (e.g. the API host on :5080)
// Parallel agents in one working tree: give each its own E2E_PORT; results go to test-results/<port>.
// The whole suite as CI runs it, with a private API (specs that need one skip without it) and an
// isolated Vite (no HMR): `node e2e/matrix/run-suite.mjs [playwright args…]`.
//
// Projects:
//   chromium                          every test except those tagged @serial, in parallel
//   firefox                           the same, but only the editing and pagination specs
//                                     (FIREFOX_SPECS; E2E_FIREFOX=all runs every spec in Firefox)
//   chromium-serial, firefox-serial   the @serial tests (time budgets: S2's 30-page settle, the
//                                     §4.10 perf budgets): one worker per project, so they never
//                                     run beside each other.
// The smoke set (tests tagged @smoke, Chromium, about 50 tests in under 3 minutes) is
// `npm run e2e:smoke` (docs/testing.md).
// In a bare full run (`npx playwright test`, no file, --grep, --project, --shard … filter) the
// serial projects run after the parallel ones (project dependencies), so no other test competes
// with their budgets; a failure in the parallel projects then skips them. With a filter there are
// no dependencies: Playwright runs a dependency project unfiltered, so a filtered run that selects
// one @serial test would otherwise run the whole suite first. run-suite.mjs runs the suite as short
// sets one after the other (groups of folders in chromium + firefox, then each serial project).
// There is no long-test tier (CLAUDE.md "Tests fail fast"): large coverage is many short tests, and a
// big suite runs as several short sets (e2e/matrix/run-suite.mjs), each under globalTimeout.
const port = Number(process.env.E2E_PORT ?? slotPort(5174));
const externalBaseURL = process.env.E2E_BASE_URL;
const preview = process.env.E2E_PREVIEW === '1';
const isCI = Boolean(process.env.CI);
const SERIAL = /@serial/;

// Firefox runs only the specs where the engine changes the result: pagination measures real line
// boxes and multi-column layout (matrix, pagination, sections, canvas, pagination-work), and caret
// movement, selection, IME, paste and key handling differ between engines (canvas, sections/seams,
// toolbar/keymap). Everything else (app pages, panels, a11y, import, export, save, lists …) is
// engine-neutral and runs in Chromium only. E2E_FIREFOX=all lifts this (a local cross-browser check,
// e.g. scripts/fidelity-run.ts --browsers chromium,firefox). docs/testing.md.
const FIREFOX_SPECS =
  process.env.E2E_FIREFOX === 'all'
    ? undefined
    : [
        'e2e/matrix/**/*.spec.ts',
        'e2e/pagination/**/*.spec.ts',
        'e2e/sections/**/*.spec.ts',
        'e2e/canvas/**/*.spec.ts',
        'e2e/toolbar/keymap.spec.ts',
        'e2e/perf/pagination-work.spec.ts',
      ];

/** A bare `playwright test` run in the runner process: no test filter of any kind on the command line. */
function bareFullRun(): boolean {
  const i = process.argv.indexOf('test');
  if (i < 0 || !/playwright/.test(process.argv[i - 1] ?? '')) return false; // a worker, `show-report`, the VS Code extension …
  return process.argv.slice(i + 1).every((arg) => {
    if (!arg.startsWith('-')) return false; // a file filter (or an option's value: no dependencies then, which is safe)
    return !/^(-g|--grep|--grep-invert|--project|--shard|--last-failed|--only-changed|--test-list|--test-list-invert|--ui|--list)(=|$)/.test(arg);
  });
}
const serialLast = bareFullRun();

export default defineConfig({
  testDir: './e2e',
  // Scratch specs (_debug.spec.ts, _explore.spec.ts …) never run in CI or in a suite run.
  testIgnore: isCI || process.env.E2E_SUITE === '1' ? ['**/_*'] : [],
  outputDir: `test-results/${port}`,
  fullyParallel: true,
  // Both browsers run at once; on a loaded dev machine the default (half the cores) makes Firefox
  // time out. E2E_WORKERS overrides (also in CI).
  workers: Number(process.env.E2E_WORKERS) || (isCI ? 2 : 6),
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Fail fast (CLAUDE.md "Tests fail fast"): a stalled test or set surfaces in seconds. There are no
  // long tests: an explicit per-test timeout may go up to 60 s at most (scripts/testTimeouts.test.ts),
  // and a test that needs more is split into several short tests.
  timeout: Number(process.env.E2E_TEST_TIMEOUT) || 15_000,
  expect: { timeout: 5_000 },
  // Every invocation (a "set") is capped at 5 minutes, and bails out after a few failures. A bigger
  // suite runs as several sets (e2e/matrix/run-suite.mjs), each under this cap.
  globalTimeout: Math.min(Number(process.env.E2E_GLOBAL_TIMEOUT) || 5 * 60_000, 5 * 60_000),
  maxFailures: process.env.E2E_MAX_FAILURES !== undefined ? Number(process.env.E2E_MAX_FAILURES) : isCI ? 25 : 5,
  // CI jobs write blob reports, merged into one HTML report by the workflow's report job.
  reporter: isCI ? [['github'], ['blob', { outputDir: 'blob-report' }], ['list']] : [['list']],
  use: {
    baseURL: externalBaseURL ?? `http://localhost:${port}`,
    trace: 'on-first-retry',
    // Without these, a stuck click or page load waits for the whole test timeout.
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: SERIAL },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grepInvert: SERIAL, ...(FIREFOX_SPECS ? { testMatch: FIREFOX_SPECS } : {}) },
    {
      name: 'chromium-serial',
      use: { ...devices['Desktop Chrome'] },
      grep: SERIAL,
      workers: 1,
      ...(serialLast ? { dependencies: ['chromium', 'firefox'] } : {}),
    },
    {
      name: 'firefox-serial',
      use: { ...devices['Desktop Firefox'] },
      grep: SERIAL,
      workers: 1,
      ...(serialLast ? { dependencies: ['chromium-serial'] } : {}),
    },
  ],
  ...(externalBaseURL
    ? {}
    : {
        webServer: {
          command: preview
            ? `npx vite preview --port ${port} --strictPort`
            : `npx vite --port ${port} --strictPort`,
          url: `http://localhost:${port}/`,
          reuseExistingServer: !isCI && process.env.E2E_PORT === undefined,
          // Vite is up in a few seconds; a minute means it's stuck (port in use, config error).
          timeout: 60_000,
        },
      }),
});
