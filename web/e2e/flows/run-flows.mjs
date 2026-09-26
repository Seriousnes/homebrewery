#!/usr/bin/env node
// Runs the app-page flows (web/e2e/flows) against a private API and an isolated Vite:
//   - src/Homebrewery.Api on :5429 with its own database (hb_e2e_flows on the compose Postgres,
//     migrated on start), admins flows-admin@e2e.test and shell-admin@e2e.test, and the share
//     shell's index.html taken from this Vite;
//   - Vite on :5329 with e2e/flows/vite.isolated.config.mjs (no HMR, its own dependency cache),
//     proxying /api and /share to that API;
// then `playwright test` with HB_API_URL, E2E_PORT and E2E_BASE_URL set, and stops what it started
// (servers already running on those ports are reused). Never uses the humans' ports. Fail-fast
// limits and the no-progress watchdog: docs/testing.md.
//
//   node e2e/flows/run-flows.mjs [playwright args…]      (from web/; needs `docker compose up -d db`)
//   node e2e/flows/run-flows.mjs e2e/save --workers=4    (other specs on these servers; the whole
//                                                        suite: e2e/matrix/run-suite.mjs, in short sets)
//
// Environment: FLOWS_API_PORT (5429), E2E_PORT (5329), FLOWS_API_DB (hb_e2e_flows), HB_ARTIFACTS
// (dotnet --artifacts-path, default <tmp>/hb-artifacts-flows), HB_API_NO_BUILD=1. Other runners
// (e2e/import-ui/run-import-ui.mjs) call runFlows() with their own defaults.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner } from '../../scripts/testRunner.ts';

/**
 * @param {{ name?: string, apiPort?: string, e2ePort?: string, database?: string, artifacts?: string, defaultArgs?: string[], args?: string[] }} [options]
 */
export async function runFlows(options = {}) {
  const runner = new TestRunner(options.name ?? 'flows');
  const apiPort = options.apiPort ?? process.env.FLOWS_API_PORT ?? '5429';
  const e2ePort = options.e2ePort ?? process.env.E2E_PORT ?? '5329';
  const adminEmail = 'flows-admin@e2e.test';
  runner.refuseHumanPorts(apiPort, e2ePort);

  let status = 1;
  try {
    const { url: apiUrl } = await runner.startApi({
      port: apiPort,
      database: options.database ?? process.env.FLOWS_API_DB ?? 'hb_e2e_flows',
      artifacts: options.artifacts ?? process.env.HB_ARTIFACTS ?? path.join(os.tmpdir(), 'hb-artifacts-flows'),
      noBuild: process.env.HB_API_NO_BUILD === '1',
      env: { Admin__Emails: `${adminEmail},shell-admin@e2e.test`, Spa__DevServerUrls: `http://localhost:${e2ePort}` },
    });
    const { url: baseUrl } = await runner.startVite({ port: e2ePort, config: 'e2e/flows/vite.isolated.config.mjs', env: { HB_API_URL: apiUrl } });
    const args = options.args ?? process.argv.slice(2);
    const result = await runner.runPlaywright(args.length ? args : (options.defaultArgs ?? ['e2e/flows']), {
      env: { E2E_PORT: e2ePort, E2E_BASE_URL: baseUrl, HB_API_URL: apiUrl, FLOWS_ADMIN_EMAIL: adminEmail },
    });
    status = result.status;
  } catch (error) {
    runner.error(error instanceof Error ? error.message : String(error));
  }
  return runner.exit(status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runFlows();
