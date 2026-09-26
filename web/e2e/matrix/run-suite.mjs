#!/usr/bin/env node
// Runs the end-to-end suite the way CI does (.github/workflows/ci.yml): with a private API, so
// the specs that need one (flows, accounts, autosave against the server …) run instead of
// skipping, and an isolated Vite (no HMR or file watching: edits to the tree can't reload a page
// mid-test).
//   - src/Homebrewery.Api on :SUITE_API_PORT (5474) with its own database (hb_e2e_suite, migrated
//     on start), admins flows-admin@e2e.test and shell-admin@e2e.test (plus HB_E2E_ADMIN_EMAILS),
//     and the share shell's index.html taken from this Vite;
//   - Vite on :E2E_PORT (5374) with e2e/matrix/vite.isolated.config.mjs, proxying /api and /share
//     to that API;
// then `playwright test` with HB_API_URL, E2E_BASE_URL, FLOWS_ADMIN_EMAIL and E2E_SUITE=1 (scratch
// specs named _*.spec.ts are ignored), and stops what it started. Servers already answering on
// those ports are reused. Never uses the humans' ports (5080, 5173, 8080).
//
//   node e2e/matrix/run-suite.mjs [playwright args…]          (from web/; needs `docker compose up -d db`)
//   node e2e/matrix/run-suite.mjs e2e/matrix --workers=4      (a filter; options go to every set: use --opt=value)
//
// The suite runs as several short SETS, one Playwright run each, one after the other: every
// Playwright run is capped at 5 minutes (playwright.config.ts globalTimeout), so a big suite is
// never one run (CLAUDE.md "Tests fail fast"). First the parallel projects (chromium, firefox) in
// groups of folders (SETS in e2e/suiteSets.mjs), then the @serial tests (time budgets: one worker,
// nothing else running) in chromium-serial and in firefox-serial. It stops at the first set that
// fails and prints each set's wall time and test time per folder; a set over 4 minutes is flagged:
// split it (move folders to another set). A folder no set names runs in the last parallel set.
//   - With a file or folder filter: one parallel set with the filter, then the two serial sets.
//   - With --set=<n>[,<n>…]: only those sets (numbered from 1 in the order they run), e.g. to rerun
//     the set that failed.
//   - With --project: one run, as given (CI shards do that).
//
// Fail fast (docs/testing.md, scripts/testRunner.ts): the API is built first, then must answer
// within 60 s, Vite within 30 s; a Playwright run with no test progress for 60 s is killed with its
// browsers and the tests that were running are printed (exit 124); everything started here is
// stopped on exit, Ctrl+C or error, and by a reaper when this script itself is killed.
//
// Environment: SUITE_API_PORT (5474), E2E_PORT (5374), SUITE_API_DB (hb_e2e_suite), HB_E2E_DB_HOST
// (localhost; `db` in CI's container job), HB_E2E_DB_PORT (5432), HB_E2E_ADMIN_EMAILS (more admin
// accounts, comma-separated), HB_ARTIFACTS (dotnet --artifacts-path, default
// <tmp>/hb-artifacts-suite), HB_API_CONFIGURATION (Debug), HB_API_NO_BUILD=1 (no `dotnet build`,
// after a build with the same artifacts path and configuration).
import os from 'node:os';
import path from 'node:path';
import { takeSetArg, TestRunner } from '../../scripts/testRunner.ts';
import { planSets, timePerFolder } from '../suiteSets.mjs';

const runner = new TestRunner('suite');
const apiPort = process.env.SUITE_API_PORT ?? '5474';
const e2ePort = process.env.E2E_PORT ?? '5374';
const adminEmail = 'flows-admin@e2e.test';
const admins = [adminEmail, 'shell-admin@e2e.test', ...(process.env.HB_E2E_ADMIN_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
runner.refuseHumanPorts(apiPort, e2ePort);

const { only, args } = takeSetArg(process.argv.slice(2));
const oneRun = args.some((a) => a === '--project' || a.startsWith('--project='));
let sets = [];
try {
  if (!oneRun) sets = planSets(args, { port: e2ePort, only, log: (m) => runner.log(m) });
} catch (error) {
  runner.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

let status = 1;
try {
  const vite = `http://localhost:${e2ePort}`;
  const { url: apiUrl } = await runner.startApi({
    port: apiPort,
    database: process.env.SUITE_API_DB ?? 'hb_e2e_suite',
    dbHost: process.env.HB_E2E_DB_HOST,
    dbPort: process.env.HB_E2E_DB_PORT,
    artifacts: process.env.HB_ARTIFACTS ?? path.join(os.tmpdir(), 'hb-artifacts-suite'),
    configuration: process.env.HB_API_CONFIGURATION,
    noBuild: process.env.HB_API_NO_BUILD === '1',
    env: { Admin__Emails: admins.join(','), Spa__DevServerUrls: vite },
  });
  const { url: baseUrl } = await runner.startVite({ port: e2ePort, config: 'e2e/matrix/vite.isolated.config.mjs', env: { HB_API_URL: apiUrl } });
  const env = { E2E_PORT: e2ePort, E2E_BASE_URL: baseUrl, HB_API_URL: apiUrl, FLOWS_ADMIN_EMAIL: adminEmail, E2E_SUITE: '1' };

  if (oneRun) {
    status = (await runner.runPlaywright(args, { env })).status;
  } else {
    const result = await runner.runSets(sets, {
      env,
      afterSet: (set) => {
        if (set.tests.length) runner.log(`${set.name}: test time per folder: ${timePerFolder(set.tests)}`);
      },
    });
    status = result.status;
  }
} catch (error) {
  runner.error(error instanceof Error ? error.message : String(error));
}
await runner.exit(status);
