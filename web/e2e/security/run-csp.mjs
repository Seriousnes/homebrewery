#!/usr/bin/env node
// Runs the CSP walk (web/e2e/security, P8.3) against the app as production serves it:
//   1. `vite build` into a private directory (never the shared src/Homebrewery.Api/wwwroot), unless
//      SECURITY_WEBROOT points at an existing build;
//   2. src/Homebrewery.Api on :5477 in the Production environment, serving that build (ASPNETCORE_WEBROOT)
//      with its own database (hb_e2e_security on the compose Postgres, migrated on start), the enforced
//      Content-Security-Policy and every other production default, except: generous rate limits (the walk
//      signs in many times from one IP) and an admin account that needs no confirmed email;
//   3. `playwright test e2e/security` with E2E_BASE_URL at that API (no Vite) and HB_CSP_E2E=1;
// then stops the API. Never uses the humans' ports (5080, 5173, 8080). Fail-fast limits and the
// no-progress watchdog: docs/testing.md.
//
//   node e2e/security/run-csp.mjs [playwright args…]      (from web/; needs `docker compose up -d db`)
//   node e2e/security/run-csp.mjs -g import
// The walk runs in Chromium (Firefox runs only the editing specs, playwright.config.ts FIREFOX_SPECS).
//
// Environment: SECURITY_API_PORT (5477), E2E_PORT (5377, only names test-results/<port>), SECURITY_API_DB
// (hb_e2e_security), HB_E2E_DB_HOST (localhost; `db` in CI's container job), HB_E2E_DB_PORT (5432),
// SECURITY_WEBROOT (reuse a build), HB_ARTIFACTS (dotnet --artifacts-path, default
// <tmp>/hb-artifacts-security), HB_API_NO_BUILD=1, SECURITY_SHOW_API_LOG=1 (print the API's output
// after a failed walk).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answers, TestRunner, viteBin } from '../../scripts/testRunner.ts';

const runner = new TestRunner('csp e2e');
const apiPort = process.env.SECURITY_API_PORT ?? '5477';
const e2ePort = process.env.E2E_PORT ?? '5377';
const adminEmail = 'security-admin@e2e.test';
runner.refuseHumanPorts(apiPort, e2ePort);

let status = 1;
try {
  if (await answers(`http://localhost:${apiPort}/healthz`)) {
    throw new Error(`something already answers on http://localhost:${apiPort}; stop it first (the walk needs its own production host).`);
  }

  // 1. The production bundle.
  let webRoot = process.env.SECURITY_WEBROOT;
  if (!webRoot) {
    webRoot = path.join(os.tmpdir(), 'hb-security-wwwroot');
    await runner.runCommand(`vite build into ${webRoot}`, process.execPath, [viteBin, 'build', '--outDir', webRoot, '--emptyOutDir']);
  }
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) throw new Error(`no index.html in ${webRoot}`);

  // 2. The API in Production.
  const { child: api, url: apiUrl } = await runner.startApi({
    port: apiPort,
    database: process.env.SECURITY_API_DB ?? 'hb_e2e_security',
    dbHost: process.env.HB_E2E_DB_HOST,
    dbPort: process.env.HB_E2E_DB_PORT,
    artifacts: process.env.HB_ARTIFACTS ?? path.join(os.tmpdir(), 'hb-artifacts-security'),
    noBuild: process.env.HB_API_NO_BUILD === '1',
    environment: 'Production',
    reuse: false,
    env: {
      ASPNETCORE_WEBROOT: webRoot,
      DataProtection__KeysPath: path.join(os.tmpdir(), 'hb-security-keys'),
      Admin__Emails__0: adminEmail,
      Admin__RequireConfirmedEmail: 'false',
      RateLimits__Auth__PermitLimit: '1000',
      RateLimits__Writes__PermitLimit: '10000',
      RateLimits__Import__PermitLimit: '100',
    },
  });
  let apiLog = '';
  const keep = (chunk) => (apiLog = (apiLog + chunk).slice(-40_000));
  api?.stdout?.on('data', keep);
  api?.stderr?.on('data', keep);

  // 3. The walk. The pages are heavy (whole brews with theme fonts, the import probe): a few workers keep both
  // browsers within their timeouts on a loaded machine (--workers=… overrides).
  const args = process.argv.slice(2);
  const workers = args.some((a) => /^(--workers|-j)(=|$)/.test(a)) ? [] : ['--workers=3'];
  const result = await runner.runPlaywright(['e2e/security', ...workers, ...args], {
    env: { E2E_PORT: e2ePort, E2E_BASE_URL: apiUrl, HB_CSP_E2E: '1', SECURITY_ADMIN_EMAIL: adminEmail, SECURITY_WEBROOT: webRoot },
  });
  status = result.status;
  if (status !== 0 && process.env.SECURITY_SHOW_API_LOG) console.error(apiLog);
} catch (error) {
  runner.error(error instanceof Error ? error.message : String(error));
}
await runner.exit(status);
