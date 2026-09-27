#!/usr/bin/env node
// Runs the admin e2e (web/e2e/admin) against a private API and an isolated Vite:
//   - src/Homebrewery.Api on :5473 (Development: Admin:RequireConfirmedEmail is false) with its own
//     database (hb_e2e_admin on the run's own PostgreSQL container, migrated on start) and the admin account
//     admin-e2e@e2e.test (Admin__Emails), which this script registers once before the tests;
//   - Vite on :5373 with e2e/admin/vite.isolated.config.mjs (no HMR, its own dependency cache),
//     proxying /api and /share to that API;
// then `playwright test e2e/admin` with HB_API_URL, E2E_PORT, E2E_BASE_URL and ADMIN_E2E_EMAIL set,
// and stops what it started (servers already running on those ports are reused). Never uses the
// humans' ports (5080, 5173, 8080). Fail-fast limits and the no-progress watchdog: docs/testing.md.
//
//   node e2e/admin/run-admin.mjs [playwright args…]     (from web/; needs Docker: the run starts its own PostgreSQL container)
//
// Environment: ADMIN_API_PORT (5473), E2E_PORT (5373), ADMIN_API_DB (hb_e2e_admin), HB_ARTIFACTS
// (dotnet --artifacts-path, default <tmp>/hb-artifacts-admin), HB_API_NO_BUILD=1.
import { TestRunner } from '../../scripts/testRunner.ts';
import { slotPort, slotTmp } from '../../scripts/worktree.ts';

const runner = new TestRunner('admin');
const apiPort = process.env.ADMIN_API_PORT ?? slotPort(5473);
const e2ePort = process.env.E2E_PORT ?? slotPort(5373);
const adminEmail = 'admin-e2e@e2e.test';
// The spec's shared password (e2e/admin/admin.spec.ts PASSWORD).
const adminPassword = 'Passw0rd!';
runner.refuseHumanPorts(apiPort, e2ePort);

/** Registers the admin account once (the API answers 200 when it already exists). */
async function registerAdmin(apiUrl) {
  const response = await fetch(`${apiUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: apiUrl },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`registering ${adminEmail} failed: ${response.status} ${await response.text()}`);
}

let status = 1;
try {
  const { url: apiUrl } = await runner.startApi({
    port: apiPort,
    database: process.env.ADMIN_API_DB ?? 'hb_e2e_admin',
    artifacts: process.env.HB_ARTIFACTS ?? slotTmp('hb-artifacts-admin'),
    noBuild: process.env.HB_API_NO_BUILD === '1',
    env: { Admin__Emails: adminEmail, Admin__RequireConfirmedEmail: 'false', Spa__DevServerUrls: `http://localhost:${e2ePort}` },
  });
  await registerAdmin(apiUrl);
  const { url: baseUrl } = await runner.startVite({ port: e2ePort, config: 'e2e/admin/vite.isolated.config.mjs', env: { HB_API_URL: apiUrl } });
  const args = process.argv.slice(2);
  const result = await runner.runPlaywright(args.length ? args : ['e2e/admin'], {
    env: { E2E_PORT: e2ePort, E2E_BASE_URL: baseUrl, HB_API_URL: apiUrl, ADMIN_E2E_EMAIL: adminEmail },
  });
  status = result.status;
} catch (error) {
  runner.error(error instanceof Error ? error.message : String(error));
}
await runner.exit(status);
