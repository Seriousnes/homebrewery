#!/usr/bin/env node
// Runs the save specs against a private API (P3.8): builds and starts src/Homebrewery.Api on :5425
// with its own database (hb_e2e_autosave on the run's own PostgreSQL container, migrated on start), starts an
// isolated Vite on E2E_PORT (5325; e2e/matrix/vite.isolated.config.mjs, proxying /api to that API),
// runs `playwright test e2e/save`, then stops both. Never uses the humans' ports (5080, 5173, 8080).
// Fail-fast limits and the no-progress watchdog: docs/testing.md.
//
//   node e2e/save/run-with-api.mjs [playwright args…]      (from web/; needs Docker: the run starts its own PostgreSQL container)
//
// Environment: SAVE_API_PORT (5425), E2E_PORT (5325), HB_ARTIFACTS (dotnet --artifacts-path, default
// <tmp>/hb-artifacts-autosave), SAVE_API_DB (hb_e2e_autosave), HB_API_NO_BUILD=1.
import { TestRunner } from '../../scripts/testRunner.ts';
import { slotPort, slotTmp } from '../../scripts/worktree.ts';

const runner = new TestRunner('save e2e');
const apiPort = process.env.SAVE_API_PORT ?? slotPort(5425);
const e2ePort = process.env.E2E_PORT ?? slotPort(5325);
runner.refuseHumanPorts(apiPort, e2ePort);

let status = 1;
try {
  const { url: apiUrl } = await runner.startApi({
    port: apiPort,
    database: process.env.SAVE_API_DB ?? 'hb_e2e_autosave',
    artifacts: process.env.HB_ARTIFACTS ?? slotTmp('hb-artifacts-autosave'),
    noBuild: process.env.HB_API_NO_BUILD === '1',
  });
  const { url: baseUrl } = await runner.startVite({ port: e2ePort, config: 'e2e/matrix/vite.isolated.config.mjs', env: { HB_API_URL: apiUrl } });
  const result = await runner.runPlaywright(['e2e/save', ...process.argv.slice(2)], {
    env: { E2E_PORT: e2ePort, E2E_BASE_URL: baseUrl, HB_API_URL: apiUrl },
  });
  status = result.status;
} catch (error) {
  runner.error(error instanceof Error ? error.message : String(error));
}
await runner.exit(status);
