#!/usr/bin/env node
// `playwright test` under the runners' no-progress watchdog, with no servers of its own: Playwright
// starts the Vite dev server itself (playwright.config.ts webServer) unless E2E_BASE_URL is set.
// A run where no test begins, ends or takes a step for 60 s is killed with its workers and
// browsers, and the tests that were running are printed (exit 124).
//
//   node e2e/run-playwright.mjs [playwright args…]      (from web/)
//   E2E_PORT=5405 node e2e/run-playwright.mjs e2e/smoke.spec.ts --project=chromium --reporter=line
//
// With no file or folder filter and no --project (`pnpm run e2e`, the whole suite) it runs the
// suite as short sets, one Playwright run each (e2e/suiteSets.mjs; --set=<n>[,<n>…] for some of
// them): every Playwright run is capped at 5 minutes. Otherwise it is one run, as given.
import { takeSetArg, TestRunner } from '../scripts/testRunner.ts';
import { slotPort } from '../scripts/worktree.ts';
import { planSets } from './suiteSets.mjs';

const runner = new TestRunner('playwright');
// This worktree's Vite port (playwright.config.ts computes the same default).
const port = process.env.E2E_PORT ?? slotPort(5174);
runner.refuseHumanPorts(port);
const { only, args } = takeSetArg(process.argv.slice(2));
// One run: a filter, a project, or a mode that isn't a suite run (UI, debug, list, shard …).
const oneRun = args.some((a) => !a.startsWith('-') || /^--(project|shard|ui|debug|list|last-failed|only-changed|test-list|help)(=|$)/.test(a));
let status = 1;
if (oneRun && !only) {
  status = (await runner.runPlaywright(args)).status;
} else {
  try {
    status = (await runner.runSets(planSets(args, { port, only, log: (m) => runner.log(m) }))).status;
  } catch (error) {
    runner.error(error instanceof Error ? error.message : String(error));
  }
}
await runner.exit(status);
