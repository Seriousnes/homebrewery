#!/usr/bin/env node
// Runs the import page's end-to-end tests (web/e2e/import-ui) through the flows runner
// (e2e/flows/run-flows.mjs: a private API with its own database and an isolated Vite, started or
// reused, then stopped; fail-fast limits and the no-progress watchdog: docs/testing.md), with this
// lane's ports and database, in this process:
//
//   node e2e/import-ui/run-import-ui.mjs [playwright args…]     (from web/; needs Docker: the run starts its own PostgreSQL container)
//   node e2e/import-ui/run-import-ui.mjs --project=chromium
//
// Defaults (each can be set in the environment): FLOWS_API_PORT 5470, E2E_PORT 5370, FLOWS_API_DB
// hb_e2e_import_ui, HB_ARTIFACTS <tmp>/hb-artifacts-import-ui. Without a spec path in the
// arguments, e2e/import-ui is run (never the whole suite by accident); give flags their values
// with '=' (--workers=2), since a bare word counts as a spec path.
import { runFlows } from '../flows/run-flows.mjs';
import { slotPort, slotTmp } from '../../scripts/worktree.ts';

const args = process.argv.slice(2);
const hasSpec = args.some((arg) => !arg.startsWith('-'));
await runFlows({
  name: 'import-ui',
  apiPort: process.env.FLOWS_API_PORT ?? slotPort(5470),
  e2ePort: process.env.E2E_PORT ?? slotPort(5370),
  database: process.env.FLOWS_API_DB ?? 'hb_e2e_import_ui',
  artifacts: process.env.HB_ARTIFACTS ?? slotTmp('hb-artifacts-import-ui'),
  args: hasSpec ? args : ['e2e/import-ui', ...args],
});
