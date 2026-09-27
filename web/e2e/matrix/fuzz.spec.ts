// §4.11 row 14 in the app's editor (/edit): random edits on a 20-page document. After every
// settle no page overflows (DOM truth, not measurePage), the flow text is what the edits made it
// (pagination never changes it), and no pass hits the loop guard. The edits are the harness's
// seeded mix (text inserts and deletes, block inserts and deletes, splits, joins, undo, redo,
// sometimes several before one settle), dispatched to the app's editor with every plugin the app
// runs (autosave, outline, TOC, objects …).
//
// 1,000 edits per browser as 20 short, independent tests (CLAUDE.md "Tests fail fast"): 50 edits
// each on a fresh copy of the document, each with its own seed (SEED + k), so they run in parallel
// and a failure names its seed. HB_FUZZ_SEED moves every seed (to explore more of the space).
import type { Page, TestInfo } from '@playwright/test';
import type { FuzzReport } from '../pagination/harness';
import { expect, expectClean, mixed20, openEditor, pages, test, watchErrors } from './helpers';

const SEED = Number(process.env.HB_FUZZ_SEED) || 20260926;
const RUNS = 20;
const EDITS = 50;

async function fuzz(page: Page, testInfo: TestInfo, seed: number, edits: number): Promise<void> {
  const errors = watchErrors(page);
  const saves = await openEditor(page, { doc: mixed20() });
  expect((await pages(page)).length).toBeGreaterThanOrEqual(18);
  await expectClean(page);

  const report: FuzzReport = await page.evaluate(([s, n]) => window.__hbPagination.fuzz({ seed: s, edits: n }), [seed, edits] as const);
  await testInfo.attach('fuzz.json', { body: JSON.stringify({ seed, ...report }, null, 2), contentType: 'application/json' });
  console.log(`[matrix fuzz ${testInfo.project.name}] seed ${seed}: ${JSON.stringify(report)}`);

  expect(report.edits).toBe(edits);
  expect(report.overflowAfterSettle, 'settles that left a page overflowing').toEqual([]);
  expect(report.textChanged, 'settles that changed the flow text').toEqual([]);
  expect(report.guardHits, 'passes that hit the loop guard').toBe(0);
  expect(report.errors, 'failed pagination steps').toBe(0);
  expect(report.pagesAfter).toBeGreaterThan(1);
  await expectClean(page, errors);
  // The app kept working under it: the edits are saved (Mod-S, as an author would).
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => saves.saves).toBeGreaterThan(0);
}

for (let k = 0; k < RUNS; k++) {
  const seed = SEED + k;
  // The first two seeds are in the smoke set.
  test(`fuzz ${k + 1}/${RUNS}: ${EDITS} random edits on a 20-page document (seed ${seed}), no overflow and no loop guard`, { tag: k < 2 ? '@smoke' : [] }, async ({ page }, testInfo) => {
    await fuzz(page, testInfo, seed, EDITS);
  });
}
