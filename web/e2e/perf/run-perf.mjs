#!/usr/bin/env node
// Runs the performance e2e (web/e2e/perf, plan §4.10 / P8.1) on its own: one worker (the specs
// report timings, which other work beside them would skew; they assert counts, never times),
// against a server nobody edits under it.
//
//   node e2e/perf/run-perf.mjs [playwright args…]          (from web/) Vite dev server, no HMR
//   node e2e/perf/run-perf.mjs --prod [playwright args…]   a production build with the dev routes
//                                                          (VITE_HB_DEV_ROUTES=1) in a temp
//                                                          directory, served by `vite preview`
//
// Three short sets (each its own Playwright run, under the 5-minute cap; the next runs only when
// one passed): 1, the smoke tests and pagination-work.spec.ts (chromium; firefox runs only
// pagination-work.spec.ts, playwright.config.ts FIREFOX_SPECS); 2, the performance work on the big
// fixtures (@serial) in chromium-serial; 3, the same in firefox-serial (about 2 minutes each).
// The timings are the output: one line per result, attachments, HB_PERF_OUT (perf.spec.ts).
// --set=<n>[,<n>…] runs only those. With a --project argument it runs once, as given.
//
// Environment: E2E_PORT (5375). The API is stubbed by the specs (no account, static themes).
// Servers already running on the port are reused. Never uses the humans' ports. Fail-fast limits
// and the no-progress watchdog: scripts/testRunner.ts.
import { pickSets, takeSetArg, TestRunner, viteBin } from '../../scripts/testRunner.ts';
import { slotPort, slotTmp } from '../../scripts/worktree.ts';

const runner = new TestRunner('perf');
const port = process.env.E2E_PORT ?? slotPort(5375);
runner.refuseHumanPorts(port);

const { only, args: argv } = takeSetArg(process.argv.slice(2));
const prod = argv.includes('--prod');
const args = argv.filter((a) => a !== '--prod');

let status = 1;
try {
  let baseUrl;
  if (prod) {
    const outDir = slotTmp('hb-perf-build');
    await runner.runCommand(`vite build (production, dev routes on) into ${outDir}`, process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
      env: { ...process.env, VITE_HB_DEV_ROUTES: '1' },
    });
    ({ url: baseUrl } = await runner.startVite({ name: 'preview server', port, args: ['preview', '--outDir', outDir, '--port', port, '--strictPort'] }));
  } else {
    ({ url: baseUrl } = await runner.startVite({ port, config: 'e2e/perf/vite.perf.config.mjs' }));
  }
  const env = { E2E_PORT: port, E2E_BASE_URL: baseUrl, HB_PERF_BUILD: prod ? 'production' : 'development' };
  const base = ['e2e/perf', '--workers=1', ...args];
  if (args.some((a) => a === '--project' || a.startsWith('--project='))) {
    status = (await runner.runPlaywright(base, { env })).status;
  } else {
    // Each set its own output folder: a run empties its folder first.
    const sets = [
      { name: 'smoke', args: ['--project=chromium', '--project=firefox', `--output=test-results/${port}-smoke`, ...base] },
      { name: 'budgets chromium', args: ['--project=chromium-serial', `--output=test-results/${port}-chromium-serial`, ...base] },
      { name: 'budgets firefox', args: ['--project=firefox-serial', `--output=test-results/${port}-firefox-serial`, ...base] },
    ];
    status = (await runner.runSets(pickSets(sets, only), { env })).status;
  }
} catch (error) {
  runner.error(error instanceof Error ? error.message : String(error));
}
await runner.exit(status);
