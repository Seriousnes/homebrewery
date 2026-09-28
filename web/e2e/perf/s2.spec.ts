// S2 go/no-go (plan §11) on /dev/pagination with 5ePHB: an edit on page 1 of a 30-page section
// settles in one forward pass through the section. S2's other cases (typing at the end of a full
// page, deleting, undo/redo, editing a split paragraph, 1,000 fuzzed edits, zoom, sections) run in
// the app's /edit editor as the §4.11 matrix (web/e2e/matrix: typing, delete, undo, splitParagraph,
// fuzz, zoom and sections.spec.ts); their dev-harness copies were removed.
//
// S2's target is a time ("settles in under 500 ms"). The test asserts the work instead, which is
// the same on every run: the pass's steps (passShape.ts: forward only from page 1, at most two
// steps per page plus one per pull), no other pass, and boundaries moved (on after the inserts,
// back after the delete). The time, measured in the page from a performance mark right before
// the edit to the settle, is reported (console and timings.json), never asserted: it depends on how
// fast and how busy the machine is. A performance test (e2e/perf: local, run by hand with
// run-perf.mjs, never in CI), tagged @serial (the serial projects, one worker) so the reported
// times come from a run with nothing beside it; the assertions don't need it.
import { expect, section, SETTLE_TIMEOUT, test, useHarness } from '../pagination/harness';
import { passShape, passStepLimit } from './passShape';

test('a 30-page section settles in one forward pass after an edit on page 1 @serial', async ({ page }, testInfo) => {
  await useHarness(page);
  const r = await page.evaluate(async ([json, settleMs]) => {
    const api = window.__hbPagination;
    const view = api.editor.view as unknown as {
      state: { tr: { insertText(t: string, pos: number): unknown; delete(a: number, b: number): unknown }; doc: { child(i: number): { child(j: number): { nodeSize: number } } } };
      dispatch(tr: unknown): void;
    };
    // The edit's pagination steps and REPAGINATEs, and the time from a mark right before the edit
    // to the first frame that sees pagination settled (the report).
    const run = async (name: string, edit: () => void) => {
      const pagesBefore = api.pages().length;
      api.events(); // from here
      performance.mark(`s2-${name}-edit`);
      edit();
      const s = await api.settled(settleMs);
      performance.mark(`s2-${name}-settled`);
      const measure = performance.measure(`s2-${name}`, `s2-${name}-edit`, `s2-${name}-settled`);
      const events = api.events();
      return {
        ms: Math.round(measure.duration),
        frames: s.frames,
        pagesBefore,
        pages: api.pages().length,
        steps: events.flatMap((e) => (e.kind === 'step' && e.page !== null ? [{ page: e.page, action: e.action }] : [])),
        repaginations: events.filter((e) => e.kind === 'repaginate').length,
      };
    };
    const initial = await run('initial', () => api.load(json));
    const firstPara = api.posOf('Travelers speak of an inn');
    const line = await run('line', () => view.dispatch(view.state.tr.insertText('A sentence long enough to fill more than one whole line on the page, pushing everything on. ', firstPara)));
    const paragraph = await run('paragraph', () =>
      view.dispatch(view.state.tr.insertText(`${'The road forks at the old mill, and both ways lead back to the inn. '.repeat(6)}`, firstPara)),
    );
    const heading = 1 + view.state.doc.child(0).child(0).nodeSize; // after the h1
    const del = await run('delete', () => view.dispatch(view.state.tr.delete(heading, heading + view.state.doc.child(0).child(1).nodeSize)));
    return { initial, line, paragraph, del, overflowing: api.overflowing(), stats: api.state()!.stats };
  }, [section(31), SETTLE_TIMEOUT] as const);
  const edits = { line: r.line, paragraph: r.paragraph, delete: r.del };
  const shapes = Object.fromEntries(Object.entries(edits).map(([name, e]) => [name, passShape(e.steps, 0)]));
  await testInfo.attach('timings.json', { body: JSON.stringify({ ...r, shapes }, null, 2), contentType: 'application/json' });
  const line = (name: string, e: { ms: number; frames: number; pagesBefore: number; pages: number }) =>
    `${name} ${e.ms} ms, ${e.frames} frames, ${shapes[name]?.steps ?? '-'} steps (${e.pagesBefore}→${e.pages} pages)`;
  console.log(`[S2 30-page ${testInfo.project.name}] initial load ${r.initial.ms} ms; ${Object.entries(edits).map(([name, e]) => line(name, e)).join('; ')}`);

  expect(r.initial.pages).toBeGreaterThanOrEqual(30);
  for (const [name, e] of Object.entries(edits)) {
    const shape = shapes[name]!;
    expect(shape.violations, `${name}: the pass`).toEqual([]);
    expect(shape.steps, `${name}: steps`).toBeLessThanOrEqual(passStepLimit(shape));
    expect(e.repaginations, `${name}: repaginations`).toBe(0);
  }
  // Page 1 grew by a line, then by a paragraph: boundaries after it moved on (how far depends on
  // the gaps pages keep, which differ between engines). The delete took a paragraph off page 1:
  // content moved back.
  for (const name of ['line', 'paragraph']) expect(shapes[name]!.pushes + shapes[name]!.inserts, `${name}: boundaries moved on`).toBeGreaterThan(0);
  expect(shapes.delete!.pulls, 'delete: boundaries moved back').toBeGreaterThan(0);
  expect(r.overflowing).toEqual([]);
  expect(r.stats).toMatchObject({ guardHits: 0, errors: 0 });
});
