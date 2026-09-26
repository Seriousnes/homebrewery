# Testing

What to run while working (the lean strategy), how to run each test suite, the fail-fast limits
every suite runs under, how to keep a test short when it needs a lot of coverage, and what to do
when a run stalls.

## The lean strategy

Running the whole suite locally cost far more than it found: over 2.2 days, tests ran for 18.6
hours of wall-clock time, and in the last 6 hours of runs no test failure needed a change to the
product code. So:

1. **The default loop** (people and agents): the unit tests (`npm --prefix web test`; `dotnet test`
   when `src/` changes) and the e2e specs of the area you change, by file or folder
   (`npm --prefix web run e2e -- e2e/matrix/typing.spec.ts`). Before pushing a larger change, the
   smoke set. **No full-suite runs locally**: no `run-suite.mjs` and no `npm run e2e` without a file
   or folder (both run the whole suite, set after set).
2. **The smoke set:** `npm --prefix web run e2e:smoke` (needs `docker compose up -d db`). It is
   `run-suite.mjs --project=chromium --grep=@smoke`: the tests tagged `@smoke`, in Chromium, with a
   private API and an isolated Vite. 47 tests; on 2026-09-27 (22 logical CPUs, 6 workers) the
   Playwright run took 30 to 34 s and the whole command 41 s (47 s with a first API build). It
   covers:
   - the plan §12 flow: sign up → new brew → type → autosave → reload → share read-only → print
     preview (`flows/flows.spec.ts`), and around it the welcome brew, the share page, a 409
     conflict, draft recovery, the first save of a new brew, sign-up/sign-in, theme CSS and assets
     (`flows`, `save/autosave-api`, `shell/auth`, `smoke.spec.ts`);
   - core pagination in the real `/edit` editor, the §4.11 matrix (`e2e/matrix`): typing pushes a
     line to the next page before paint, deleting pulls content back and removes empty auto pages,
     undo/redo settles to the same layout, a split paragraph re-joins and re-splits, heading
     keep-with-next, an ordered list across pages, an oversized stat block, a 1- then 2-column
     section, a `.wide` block, a cover page, an IME composition, zoom 50 %, and two fuzz seeds;
   - editing at the seams and in the app: Backspace and Enter at a seam, Mod-Enter, bold, undo/redo
     and Mod-S keys, arrow keys across pages, paste from Word, an Insert-menu snippet, the live TOC,
     dragging an object, the outline (`sections`, `toolbar/keymap`, `canvas`, `snippets`, `objects`,
     `panels`);
   - an import smoke: five fidelity fixtures (`import/fidelity.spec.ts`), four `hbfmToDoc` checks
     (`import/hbfmToDoc.spec.ts`) and a pasted brew through the import page (`import-ui`).

   The CSP walk is not in the smoke set: it needs a production `vite build` and an API in the
   Production environment of its own, which does not fit a 3-minute command beside the smoke's dev
   servers. It runs in CI (the `csp` job) and locally with `node e2e/security/run-csp.mjs` when you
   add a page or touch the CSP ([security.md](./security.md)).
3. **The full suite runs in CI only** (`.github/workflows/ci.yml`), trimmed: dev-harness copies of
   the §4.11 matrix cases were removed (the matrix runs them in the real editor), and Firefox runs
   only the editing and pagination specs (below). The full import fidelity run (every fixture,
   `scripts/fidelity-run.ts`) and the full snippet fidelity run (`SNIPPET_FIDELITY=all`) are
   local tools, not in CI: run them when you change the import or a snippet's rendering. Their
   smoke subsets run in the suite.

### Adding a test to the smoke set

Sparingly: the smoke set stays at about 50 tests and under 3 minutes for the whole command. Tag a
test only when it covers a user-facing path that no smoke test covers yet and that a change in
another area could break; prefer replacing a smoke test over adding one. Tag with the test's
details, `test('…', { tag: '@smoke' }, async (…) => …)`; for a generated test, one variant
(`{ tag: k < 2 ? '@smoke' : [] }`). Smoke tests run in Chromium; they must pass without retries
and with the private API that `run-suite.mjs` starts. Check the count with
`npx playwright test --list --project=chromium --grep=@smoke` (from `web/`) and the time that
`npm run e2e:smoke` prints.

### Firefox scope

The `firefox` project runs only the specs where the browser engine changes the result
(`FIREFOX_SPECS` in `web/playwright.config.ts`):

| Specs | Why Firefox |
| --- | --- |
| `e2e/matrix`, `e2e/pagination`, `e2e/sections`, `e2e/perf/pagination-work.spec.ts` | Pagination measures real line boxes, floats and multi-column layout, which differ between engines (the plan §12 runs the §4.11 matrix in both); `sections` also holds the seam editing (`seams.spec.ts`) |
| `e2e/canvas` | Multi-column page structure, caret movement across columns and pages, drag selection, click-to-caret under zoom, paste, per-browser screenshot baselines |
| `e2e/toolbar/keymap.spec.ts` | Key handling (Mod-Z/Y, Mod-., Tab, Mod-Enter …) and the browser's default actions differ between engines |

Everything else (app pages, panels, the inspector, objects, snippets, import, export, save, lists,
admin, a11y, the CSP walk) is engine-neutral application logic and runs in Chromium only. The
`firefox-serial` project keeps the `@serial` time budgets (the S2 30-page settle, the §4.10
budgets): pagination speed differs most in Firefox. `E2E_FIREFOX=all` lifts the restriction for a
local cross-browser check (`scripts/fidelity-run.ts` sets it for its Firefox runs).

## The rule: tests fail fast

A stalled test or test run must surface in seconds, never after minutes of waiting. A timeout is a
bug report: when a test needs more time, find out why (a wait without a readiness signal, work the
test doesn't need, a first import or page load inside the test) and fix that. Raising the timeout
hides the problem and makes every future stall slower to notice. (This rule was made after an agent
waited 10 minutes on a test set that had obviously stalled.)

There are **no long tests** and no long test runs: no opt-in long tier, no nightly long jobs, no
exceptions. Coverage that takes minutes is many short tests (see [Splitting a slow test](#splitting-a-slow-test)),
and a big suite runs as several short sets.

| Where | Limit | Set in |
| --- | --- | --- |
| Vitest | 5 s per test, 10 s per hook | `web/vite.config.ts` (`test.testTimeout`, `hookTimeout`) |
| Testing Library | `findBy*` / `waitFor` give up after 1 s (3 s in files that use `src/app/testing.tsx`) | their `configure()` calls |
| Playwright | 15 s per test (`E2E_TEST_TIMEOUT`), 5 s per `expect` and action, 10 s per navigation | `web/playwright.config.ts` |
| Playwright, one run (a "set") | 5 minutes (`globalTimeout`; `E2E_GLOBAL_TIMEOUT` can only lower it); stops after 5 failures locally, 25 in CI (`E2E_MAX_FAILURES`) | `web/playwright.config.ts` |
| Playwright web server | 60 s to start | `web/playwright.config.ts` |
| Runner scripts | no test progress for 60 s: the run is killed; API ready within 60 s, Vite within 30 s | `web/scripts/testRunner.ts` |
| `dotnet test` | whole run 5 min; any test running over 10 s is reported | `tests/Homebrewery.Api.Tests` (csproj, `xunit.runner.json`) |
| CI jobs | every job 15 min at most (setup included); every Playwright run in them fits the 5-minute cap | `.github/workflows/ci.yml` |

Explicit timeouts in test code are capped by a guard that runs with the unit tests,
`web/scripts/testTimeouts.test.ts`: at most 60 s in `web/e2e/**` and 15 s in unit tests and their
helper modules, with no exemption. It finds `test.setTimeout(…)`, `timeout:` options (describe,
test, expect, waitFor, poll), `testTimeout` / `hookTimeout` (`vi.setConfig`), `asyncUtilTimeout`,
`actionTimeout` / `navigationTimeout`, `setDefaultTimeout(…)`, and trailing timeout arguments such
as `it('…', fn, 20_000)` or `beforeAll(fn, 180_000)`. It also fails on any long-tier marker (an
`@long` tag, an `E2E_LONG` / `HB_LONG` switch, a `*-long` project) in `web/` and `.github/`.

## Running the suites

From the repository root unless noted. Run tests in the foreground; for agents: always with a hard
command timeout of 5 minutes at most (for example `timeout 300 …`), your own `E2E_PORT`,
`E2E_WORKERS` (6 at most) and `--reporter=line`. Never use the ports people use (5080, 5173,
8080). A command that runs several sets (the whole suite, `run-perf.mjs`, `fidelity-run.ts`) takes
longer than 5 minutes in total: run its sets one command at a time with `--set=<n>` where the
script has it.

| Suite | Command | Notes |
| --- | --- | --- |
| Unit (Vitest) | `npm --prefix web test` | projects `web` (jsdom, `src/**`) and `node` (`vite/**`, `scripts/**`). About a minute. |
| One unit file | `npx vitest run src/editor/toc/tocView.test.ts` (from `web/`) | `--project node` for `scripts/` and `vite/` |
| E2E, the specs of an area | `npm --prefix web run e2e -- <file or folder> [args]` | `node e2e/run-playwright.mjs`: Playwright starts Vite; specs that need an API skip. With a file, folder or `--project` it is one run; without, the whole suite as sets (below: CI only) |
| E2E smoke set | `npm --prefix web run e2e:smoke` | the `@smoke` tests in Chromium with a private API, one run of about a minute ([the lean strategy](#the-lean-strategy)). Needs `docker compose up -d db` |
| E2E, whole suite as CI | `node e2e/matrix/run-suite.mjs [args]` (from `web/`) | CI runs it; locally rarely needed. Private API (:5474, database `hb_e2e_suite`) and isolated Vite (:5374); the suite as short sets (below). Needs `docker compose up -d db` |
| E2E lanes | `node e2e/flows/run-flows.mjs`, `e2e/admin/run-admin.mjs`, `e2e/lists/run-lists.mjs`, `e2e/save/run-with-api.mjs`, `e2e/import-ui/run-import-ui.mjs` (from `web/`) | each with its own API port, database and Vite; the header of each script lists its variables |
| Production build under the CSP | `node e2e/security/run-csp.mjs` (from `web/`) | Chromium; the `csp` job in CI. See [security.md](./security.md) |
| Performance | `node e2e/perf/run-perf.mjs [--prod]` (from `web/`) | one worker, three sets: the smoke tests (Firefox: `pagination-work.spec.ts` only), then the time budgets in `chromium-serial`, then in `firefox-serial` (about 2 minutes each) |
| Snippet fidelity (every fixture) | `SNIPPET_FIDELITY=all node e2e/run-playwright.mjs e2e/snippets/snippetFidelity.spec.ts --project=chromium` (from `web/`) | local only, when a snippet's rendering changes: 25 tests of up to 8 fixtures, about 1 minute at 6 workers (Firefox with `E2E_FIREFOX=all`, 1.5 minutes). The suite has an 11-fixture smoke |
| Import fidelity (every fixture) | `npx tsx scripts/fidelity-run.ts` (from `web/`) | local only, when the import changes: 309 fixtures, one short test each, as sets of 50 (`--shard`); writes `e2e/fixtures/fidelity-report.md` (`--out` elsewhere). The suite has a 12-fixture smoke subset (CI's `fidelity` job) |
| .NET | `dotnet test` | Testcontainers starts its own PostgreSQL (Docker) |

The runner scripts start (or reuse) the servers they need, run Playwright, and stop everything
they started. Arguments after the script name go to `playwright test`; give options their values
with `=` (`--workers=2`). Every Playwright run prints its wall time, the test time per project and
its slowest tests (`HB_SLOWEST=<n>` lists more).

### The suite in sets

Every Playwright run is capped at 5 minutes, so the whole suite never runs as one.
`e2e/matrix/run-suite.mjs` and `e2e/run-playwright.mjs` (without a filter) run it as sets, one
Playwright run each, one after the other (`web/e2e/suiteSets.mjs`):

1. to 4. the parallel projects (`chromium` and `firefox` together, 6 workers; Firefox only on its
   specs, [Firefox scope](#firefox-scope)) on groups of folders: `a11y, snippets, objects,
   inspector, panels` (Chromium only); `shell, toolbar, ui-kit, save, flows, lists, admin, export`
   (Firefox: `toolbar/keymap`); `canvas, pagination, sections`; `matrix, import, import-ui, perf,
   security`. A folder no set names runs in the last one.
5. and 6. the `@serial` tests (time budgets) alone, one worker: `chromium-serial`, then
   `firefox-serial`.

Before the trim (2026-09-26: 22 logical CPUs, 6 workers, private API, both browsers on every spec,
six parallel sets) the suite took about 19 minutes: 902 s for the parallel sets, 109 and 121 s for
the serial ones. The four parallel sets are sized for about 2 minutes each from that measurement
less the Firefox runs and the tests removed; not yet measured.

The run stops at the first set that fails (fail fast) and prints each set's wall time, and for the
suite the test time per folder. A set over 4 minutes is flagged: move folders to another set (or a
new one) before it reaches the cap. `--set=<n>[,<n>…]` runs only those sets (to rerun the one that
failed, or to run the suite one set per command). With a file or folder filter, the filter is one
parallel set, followed by the two serial sets.

`@serial` tests are time budgets (the S2 30-page settle, the §4.10 performance budgets): they run in
`chromium-serial` / `firefox-serial` with one worker, after the parallel sets, so no other test
competes for the CPU. They are short like every other test.

In CI (`.github/workflows/ci.yml`) each e2e job is one Playwright run: a shard of one browser's
parallel project (7 Chromium shards, 6 Firefox shards), one browser's serial project, the import
fidelity smoke (Chromium) or the CSP walk (Chromium, production build). The shard counts keep each
run well under 5 minutes at CI's 2 workers: the parallel projects take about 1,500 s of test time
in Chromium (559 tests) and an estimated 1,100 s in Firefox (166 tests) locally, so about 2.3 and 2
minutes per shard at 2 workers and 1.3 times slower. When the suite grows, raise them (every run
prints its test time per project: a shard costs about that divided by the shard count and the
workers).

## Splitting a slow test

When a test needs more than its limit, make it several short tests; never raise a timeout past the
caps, and never add an opt-in "long" variant.

- **Fuzzing and other repeated checks:** many independent tests, each with its own seed. The §4.11
  fuzz (1,000 edits per browser, S2's fuzz too) is 20 tests of 50 edits each, seeds `SEED + k`, on
  a fresh document in the app's editor (`web/e2e/matrix/fuzz.spec.ts`); the line-model
  fuzz is 4 unit tests of 250 edits (`web/src/editor/pagination/step.test.ts`). A failure names its
  seed.
- **Many fixtures:** one test per fixture, or small chunks
  (`web/e2e/import/fidelity.spec.ts`, `web/e2e/snippets/snippetFidelity.spec.ts`). A selection
  switch (`FIDELITY=all`, `SNIPPET_FIDELITY=all`) may choose more fixtures, but every test stays
  short and a runner splits a big selection into sets (`scripts/fidelity-run.ts`).
- **Budgets:** one budget per test, each on a fresh page (`web/e2e/perf/perf.spec.ts`), tagged
  `@serial`.
- Keep per-test setup out of the test's time where it can be shared: a worker-scoped page
  (`web/e2e/pagination/harness.ts`, `smokeTest` in `web/e2e/perf/helpers.ts`) loads the dev page
  once per worker.

## The runners' watchdog

Every runner script (`web/e2e/**/run-*.mjs`, `e2e/run-playwright.mjs`, `scripts/fidelity-run.ts`)
runs Playwright through `web/scripts/testRunner.ts`:

- **No-progress watchdog.** A reporter (`web/scripts/progressReporter.ts`, attached with
  `PW_TEST_REPORTER`, so it works with any `--reporter`) sends every test and step to the runner.
  Progress means a test began or ended or a step began or ended. The run is stalled when nothing
  progressed for 60 s (the same for every test; 90 s before the first test, which covers
  Playwright's own web server start-up) **and** no running test is still inside its declared
  timeout plus 30 s. Then the runner prints what was running and kills the Playwright process tree
  (runner, workers, browsers); the exit status is 124. This catches what Playwright's own timeouts
  can't: a worker blocked in a synchronous loop, a teardown or browser close that never returns, a
  test that switched its timeout off.
- **Sets.** `runSets` runs several Playwright runs one after the other, stops at the first that
  fails and prints each one's wall time (flagging one over 4 minutes).
- **Start-up caps.** The API is built first (`dotnet build`, stopped when it prints nothing for
  2 minutes), then `dotnet run --no-build` must answer `/healthz` within 60 s; Vite must answer
  within 30 s. Builds of the web app (`vite build`) have the same 2-minute quiet limit.
- **Cleanup.** Every child is killed by process tree on exit, on Ctrl+C / SIGINT / SIGTERM and on
  errors (Windows: `taskkill /T /F`; POSIX: every descendant, browsers included). A detached reaper
  (`web/scripts/processReaper.ts`) kills them when the runner itself is killed hard (a tool's
  command timeout, Task Manager, SIGKILL).
- Interactive runs (`--ui`, `--debug`, `PWDEBUG`) have no watchdog.

A stall report looks like this:

```
[suite] STALLED: no test began, finished or took a step for 61 s (limit 60 s).
[suite] Running when it stalled (1):
[suite]   [firefox] e2e/matrix/fuzz.spec.ts:43 › fuzz 7/20: 50 random edits …  — running 75 s, timeout 15 s, in step "page.evaluate"
[suite] Last finished: [chromium] e2e/matrix/zoom.spec.ts:12 › … (passed) 61 s ago.
[suite] 37 of 120 tests finished.
[suite] Killing the Playwright run (pid 1234) with its workers and browsers. How to debug a stall: docs/testing.md.
```

Variables for testing the watchdog itself: `HB_STALL_MS`, `HB_STALL_GRACE_MS`, `HB_STARTUP_MS`
(milliseconds), and `HB_WATCHDOG_DEBUG=1` (prints every progress event).

## Debugging a stall

1. Read the report: the test (`file:line`), the project, how long it ran against its timeout, and the
   step it was in. "In no step" means test code between Playwright calls, a hook or a fixture (a
   `new Promise` that never settles, a synchronous loop).
2. Run that test alone, in the foreground with a hard timeout:

   ```
   timeout 120 node e2e/run-playwright.mjs e2e/matrix/fuzz.spec.ts:43 --project=firefox --reporter=line --trace=on
   ```

   Then open the trace (`npx playwright show-trace test-results/<port>/…/trace.zip`) to see the last
   actions, console messages and network requests. In a suite run, each set writes to its own
   folder, `test-results/<port>-<set>`.
3. The usual causes: a wait for something that never happens (use a readiness signal the app sets,
   and `expect.poll` / `toPass` with the default timeouts), a page load that triggers a Vite
   dependency re-optimization (restart the isolated Vite), a server that died (the runner prints its
   last output), autosave or a dialog blocking the page close.
4. A unit test over 5 s: look for real timers (make the delays small or inject them), repeated
   editor construction or first imports inside the test (move them into `beforeAll`), or a heavy
   dependency the test isn't about (mock it). `npx vitest run <file> --reporter=verbose` shows each
   test's time.
5. Leave nothing running: check your ports (`netstat -ano | findstr :<port>` on Windows,
   `lsof -i :<port>` elsewhere). Runner scripts clean up after themselves, even when killed.
