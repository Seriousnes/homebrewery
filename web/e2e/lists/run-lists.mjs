#!/usr/bin/env node
// Runs the list page specs (web/e2e/lists: /user/:handle and /vault) against a private API and an
// isolated Vite:
//   - src/Homebrewery.Api on :5472 with its own database (hb_e2e_lists on the run's own PostgreSQL container,
//     migrated on start) and test rate limits (every spec registers accounts and seeds brews);
//   - Vite on :5372 with e2e/lists/vite.isolated.config.mjs (no HMR, its own dependency cache),
//     proxying /api and /share to that API;
// then `playwright test` with HB_API_URL, E2E_PORT and E2E_BASE_URL set, and stops what it started
// (servers already running on those ports are reused). Never uses the humans' ports. Fail-fast
// limits and the no-progress watchdog: docs/testing.md.
//
//   node e2e/lists/run-lists.mjs [playwright args…]     (from web/; needs Docker: the run starts its own PostgreSQL container)
//   node e2e/lists/run-lists.mjs --workers=2             (flags alone still run only e2e/lists)
//
// Environment: LISTS_API_PORT (5472), E2E_PORT (5372), LISTS_API_DB (hb_e2e_lists), HB_ARTIFACTS
// (dotnet --artifacts-path, default <tmp>/hb-artifacts-lists), HB_API_NO_BUILD=1.
import { TestRunner } from '../../scripts/testRunner.ts';
import { slotPort, slotTmp } from '../../scripts/worktree.ts';

const runner = new TestRunner('lists');
const apiPort = process.env.LISTS_API_PORT ?? slotPort(5472);
const e2ePort = process.env.E2E_PORT ?? slotPort(5372);
runner.refuseHumanPorts(apiPort, e2ePort);

let status = 1;
try {
  const { url: apiUrl } = await runner.startApi({
    port: apiPort,
    database: process.env.LISTS_API_DB ?? 'hb_e2e_lists',
    artifacts: process.env.HB_ARTIFACTS ?? slotTmp('hb-artifacts-lists'),
    noBuild: process.env.HB_API_NO_BUILD === '1',
    env: {
      Spa__DevServerUrls: `http://localhost:${e2ePort}`,
      // Both browsers register accounts and seed brews in parallel from one IP.
      RateLimits__Auth__PermitLimit: '2000',
      RateLimits__Writes__PermitLimit: '10000',
    },
  });
  const { url: baseUrl } = await runner.startVite({ port: e2ePort, config: 'e2e/lists/vite.isolated.config.mjs', env: { HB_API_URL: apiUrl } });
  // Flags alone (--workers=4, --project=firefox, -g …) keep the default path: only a path-like
  // argument (e2e/…, a spec file) replaces it, so a flag never runs the whole suite by accident.
  const args = process.argv.slice(2);
  const hasPath = args.some((arg) => !arg.startsWith('-') && (arg.includes('/') || arg.includes('\\') || arg.endsWith('.spec.ts')));
  const result = await runner.runPlaywright(hasPath ? args : ['e2e/lists', ...args], {
    env: { E2E_PORT: e2ePort, E2E_BASE_URL: baseUrl, HB_API_URL: apiUrl },
  });
  status = result.status;
} catch (error) {
  runner.error(error instanceof Error ? error.message : String(error));
}
await runner.exit(status);
