// S2 go/no-go (plan §11): a 30-page section settles in under 500 ms after an edit on page 1, on
// /dev/pagination with 5ePHB. S2's other cases (typing at the end of a full page, deleting,
// undo/redo, editing a split paragraph, 1,000 fuzzed edits, zoom, sections) run in the app's /edit
// editor as the §4.11 matrix (web/e2e/matrix: typing, delete, undo, splitParagraph, fuzz, zoom and
// sections.spec.ts); their dev-harness copies were removed.
//
// The budget is tagged @serial: it runs in the serial projects (one worker; after the parallel
// projects in a full run, see playwright.config.ts), because other workers' load would eat it. It
// is measured in the page, from a performance mark right before the edit to the settle, so page
// loads and test-runner round trips never count.
import { expect, section, SETTLE_TIMEOUT, test, useHarness } from './harness';

test('a 30-page section settles in under 500 ms after an edit on page 1 @serial', async ({ page }, testInfo) => {
  await useHarness(page);
  const r = await page.evaluate(async ([json, settleMs]) => {
    const api = window.__hbPagination;
    const view = api.editor.view as unknown as {
      state: { tr: { insertText(t: string, pos: number): unknown; delete(a: number, b: number): unknown }; doc: { child(i: number): { child(j: number): { nodeSize: number } } } };
      dispatch(tr: unknown): void;
    };
    // From a mark right before the edit to the first frame that sees pagination settled.
    const time = async (name: string, edit: () => void) => {
      performance.mark(`s2-${name}-edit`);
      edit();
      const s = await api.settled(settleMs);
      performance.mark(`s2-${name}-settled`);
      const measure = performance.measure(`s2-${name}`, `s2-${name}-edit`, `s2-${name}-settled`);
      return { ms: Math.round(measure.duration), frames: s.frames, steps: api.state()!.stats.lastSettleSteps, pages: api.pages().length };
    };
    const initial = await time('initial', () => api.load(json));
    const pages = api.pages().length;
    const firstPara = api.posOf('Travelers speak of an inn');
    const line = await time('line', () => view.dispatch(view.state.tr.insertText('A sentence long enough to fill more than one whole line on the page, pushing everything on. ', firstPara)));
    const paragraph = await time('paragraph', () =>
      view.dispatch(view.state.tr.insertText(`${'The road forks at the old mill, and both ways lead back to the inn. '.repeat(6)}`, firstPara)),
    );
    const heading = 1 + view.state.doc.child(0).child(0).nodeSize; // after the h1
    const del = await time('delete', () => view.dispatch(view.state.tr.delete(heading, heading + view.state.doc.child(0).child(1).nodeSize)));
    return { pages, initial, line, paragraph, del, overflowing: api.overflowing(), stats: api.state()!.stats };
  }, [section(31), SETTLE_TIMEOUT] as const);
  await testInfo.attach('timings.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  console.log(`[S2 30-page ${testInfo.project.name}] ${JSON.stringify({ pages: r.pages, initial: r.initial, line: r.line, paragraph: r.paragraph, delete: r.del })}`);
  expect(r.pages).toBeGreaterThanOrEqual(30);
  for (const edit of [r.line, r.paragraph, r.del]) expect(edit.ms).toBeLessThan(500);
  expect(r.overflowing).toEqual([]);
  expect(r.stats).toMatchObject({ guardHits: 0, errors: 0 });
});
