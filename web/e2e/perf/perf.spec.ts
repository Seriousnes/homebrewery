// P8.1 performance (plan §4.10, §11 P8.1) on /dev/perf (window.__hbPerf, web/src/dev/perf): what
// typing, pasting and theme switches cost on the big fixtures. The tests assert the work, as counts
// that are the same on every run: pagination's steps (the pages it checked and what it did on each,
// e2e/pagination/passShape.ts), its transactions, and the pages whose DOM changed. The timings are
// measured beside the work and reported (record(): a line, an attachment, HB_PERF_OUT), never
// asserted: they depend on how fast and how busy the machine is, and pagination is sliced by time
// (plugin.ts budgetMs), so even its frame counts do.
//
//   typing on the visible page       a keystroke that moves no boundary checks its own page, in one
//                                    step and one pagination transaction, and changes no other
//                                    page's DOM; one that moves boundaries runs one forward pass
//                                    from its page. Reported: work per keystroke (its input
//                                    processing plus the next frame's work; the §4.10 target is
//                                    16 ms at p95) and event to next paint. On the 153-page brew
//                                    and on a 10-page one (its first pages).
//   page 1 of a 50-page section      typed and pasted: every edit is one forward pass from page 1
//                                    (at most two steps per page, plus one per pull), and a pasted
//                                    paragraph moves every boundary of the section. Reported: edit
//                                    to settled (the §4.10 target is 1 s).
//   theme switch, 150-page brew      5ePHB → Blank → 5ePHB: exactly one theme repagination per
//                                    switch, one forward pass over every page (then the contents
//                                    page again when its table of contents changed height), and no
//                                    page element re-created. Reported: switch to settled (P8.1's
//                                    target is 3 s).
//   load, 150-page brew              reported: mount to settled, stored layout
//
// Keys are typed one at a time at a person's pace, each once pagination has settled after the key
// before (typeKeyByKey): a key typed while a pass runs joins that pass, by as much as the machine's
// speed decides. The tests on the big fixtures are tagged @serial (chromium-serial / firefox-serial, one
// worker): nothing they assert needs it, but their timings are only worth reading from a run with
// nothing beside it. Each on a fresh page, well under a minute (CLAUDE.md "Tests fail fast"). On
// their own, with the timings: `node e2e/perf/run-perf.mjs` (from web/; an isolated Vite without
// HMR, E2E_PORT 5375; `--prod` for a production build). HB_PERF_GENERATE=1 regenerates the
// fixtures (Chromium, one test per fixture): the generated documents after pagination settled,
// auto pages included, as a saved brew stores them.
//
// The default run has a smoke test of the same measurements on a small generated brew (about 30
// pages) and a 5-page section: the probe, the reports and the pagination they record; and that a
// theme switch that removes pages keeps the elements of the pages after them (a P8.1 fix:
// ProseMirror had re-created every later page). Each smoke test takes ≤ 6 s.
//
// With HB_PERF_OUT=<file>, every result is also appended to that file as one JSON line.
import { expect, test, type Page } from '@playwright/test';
import { passShape, passStepLimit, type PassShape } from '../pagination/passShape';
import { rawBrew150, rawSection50, textLength, type JsonNode } from './fixtureGen';
import {
  machineContext,
  openPerf,
  readFixture,
  record,
  smokeTest,
  typeKeyByKey,
  typeRealistically,
  writeFixture,
  type EditReport,
  type ThemeSwitchReport,
  type TypingReport,
  type WorkReport,
} from './helpers';

/** Scales of the generated documents that give ~150 and ~50 pages in 5ePHB. */
const SCALE_150 = 1;
const SCALE_50 = 1.04;

const mount = (page: Page, doc: JsonNode, opts: { shell?: 'app' | 'canvas'; theme?: string } = {}) =>
  page.evaluate(([d, o]) => window.__hbPerf.mount(d, o), [doc, opts] as const);

/** p50, p95 and max of `values` (for the reports). */
function stat(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return { p50: pct(50), p95: pct(95), max: sorted.at(-1) ?? 0 };
}

/** The keystrokes' timings, for the report. */
function latency(typed: TypingReport[]) {
  const keys = typed.flatMap((r) => r.keys);
  return {
    keys: keys.length,
    work: stat(keys.map((k) => k.work)),
    paint: stat(keys.map((k) => k.paint)),
    handlers: stat(keys.map((k) => k.handlers)),
    dispatch: stat(keys.map((k) => k.dispatch)),
    settle: stat(keys.flatMap((k) => (k.settle === null ? [] : [k.settle]))),
    longFrames: typed.reduce((n, r) => n + r.longFrames.length, 0),
  };
}

/** toc/tocPlugin.ts MAX_TOC_REPAGINATIONS (the e2e project can't import app sources). */
const MAX_TOC_REPAGINATIONS = 3;

/**
 * Checks the work of one edit or theme switch: one pagination pass from page `from` as step.ts
 * runs it (passShape.ts: forward only, at most two steps per page plus one per pull); after it, at
 * most MAX_TOC_REPAGINATIONS passes from a table of contents' page, each started by a REPAGINATE
 * (toc/tocPlugin.ts: a toc whose height changed with its page numbers has its page checked again);
 * `restyles` REPAGINATEs besides (a theme switch: its own); no page changed in the DOM but those the
 * passes checked (and the page after each: a boundary move changes both) and the tocs' pages; and
 * no page element re-created. `pagesBefore`: the page count before. Returns the shape of each pass.
 */
function expectWork(work: WorkReport, opts: { from: number; pagesBefore: number; tocPages: number[]; restyles?: number; label: string }): PassShape[] {
  const { from, pagesBefore, tocPages, label } = opts;
  expect(work.passes.length, `${label}: passes`).toBeGreaterThan(0);
  const shapes = work.passes.map((steps, i) => {
    const start = i === 0 ? from : steps[0]!.page;
    if (i > 0) expect(tocPages, `${label}: pass ${i + 1} starts at a toc's page`).toContain(start);
    const shape = passShape(steps, start);
    expect(shape.violations, `${label}: pass ${i + 1}`).toEqual([]);
    expect(shape.steps, `${label}: pass ${i + 1}, steps`).toBeLessThanOrEqual(passStepLimit(shape));
    return shape;
  });
  expect(work.passes.length - 1, `${label}: passes after the first (tocs)`).toBeLessThanOrEqual(MAX_TOC_REPAGINATIONS);
  expect(work.repaginations, `${label}: repaginations`).toBe((opts.restyles ?? 0) + work.passes.length - 1);
  const touched = new Set([from, ...tocPages, ...work.passes.flat().flatMap((s) => [s.page, s.page + 1])]);
  const outside = work.mutatedPages.filter((p) => (p === -1 ? work.pagesRemoved === 0 : !touched.has(p)));
  expect(outside, `${label}: pages changed in the DOM outside the passes`).toEqual([]);
  const inserts = shapes.reduce((n, s) => n + s.inserts, 0);
  expect(work.pagesAdded, `${label}: page elements added`).toBeLessThanOrEqual(inserts);
  expect(work.pagesRemoved, `${label}: page elements removed`).toBe(pagesBefore + inserts - work.pages);
  return shapes;
}

/** Whether an edit's work only measured (moved no boundary). */
const measuredOnly = (work: WorkReport) => work.passes.flat().every((s) => s.action === 'settled');

/** Pages holding a table of contents (it may ask for its page to be checked again). */
const tocPagesOf = (page: Page) => page.evaluate(() => window.__hbPerf.pagesWith('toc'));

/**
 * Before typing at a place: the pages scrolled into view have rendered, the fonts they started
 * loading (if any) have loaded, and pagination is settled and idle.
 */
async function quietAfterScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts.ready;
    await window.__hbPerf.quiet(window.__hbPerf.now(), 500);
  });
}

/** A small brew of the same recipe as perf-150 (cover, contents, 12 chapters, appendix): about 20 pages. */
const SMALL_BREW = 0.1;
/** A section of the same recipe as perf-50: about 5 pages. */
const SMALL_SECTION = 0.1;

smokeTest.describe('performance smoke (P8.1)', () => {
  smokeTest('load and typing: the probe measures them', async ({ page }, testInfo) => {
    const load = await mount(page, rawBrew150(SMALL_BREW));
    expect(load.pages).toBeGreaterThan(load.pagesIn); // paginated from the manual pages
    expect(load.toSettled).toBeGreaterThanOrEqual(load.toReady);
    expect(load.pagination.steps).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.querySelectorAll('.hb-oversized').length)).toBe(0);

    const caret = await page.evaluate(() => window.__hbPerf.placeCaret(2)); // chapter 1
    expect(caret.page).toBe(2);
    await page.evaluate(() => window.__hbPerf.startTyping());
    await typeRealistically(page, 'the quiet lantern keeps ', { meanMs: 60, jitterMs: 20 });
    await page.evaluate(() => window.__hbPerf.quiet(window.__hbPerf.now(), 300));
    const typing = await page.evaluate(() => window.__hbPerf.stopTyping());
    expect(typing.keys.length).toBe('the quiet lantern keeps '.length);
    for (const k of typing.keys) {
      expect(k.work, `key "${k.key}"`).toBeGreaterThan(0);
      expect(k.paint).toBeGreaterThan(0);
    }
    expect(typing.work.p95).toBeGreaterThanOrEqual(typing.work.p50);
    await record(testInfo, 'smoke-typing', { load, typing: { work: typing.work, paint: typing.paint } }, `${load.pages} pages settled in ${load.toSettled} ms; typing work p50 ${typing.work.p50} / p95 ${typing.work.p95} ms`);
  });

  smokeTest('a pasted paragraph on page 1 of a section: every boundary moves, and the probe times the settle', async ({ page }, testInfo) => {
    const section = await mount(page, rawSection50(SMALL_SECTION));
    expect(section.pages).toBeGreaterThanOrEqual(4);
    await page.evaluate(() => window.__hbPerf.placeCaret(0));
    const pasted = await page.evaluate(() => window.__hbPerf.insertText('the patient warden measures each crooked causeway before the storm, and the old ferry answers the bell '.repeat(3)));
    // Page 1 grew: every boundary of the section after it moved.
    expect(pasted.pagination.steps).toBeGreaterThanOrEqual(section.pages - 1);
    expect(pasted.settle).toBeGreaterThan(0);
    await record(testInfo, 'smoke-section', { pages: section.pages, pasted }, `${section.pages} pages: pasted paragraph settled in ${pasted.settle} ms (${pasted.pagination.steps} steps)`);
  });

  smokeTest('a theme switch: the probe records the repagination, and the page count comes back', async ({ page }, testInfo) => {
    const load = await mount(page, rawBrew150(SMALL_BREW), { shell: 'canvas', theme: '5ePHB' });
    const switches: ThemeSwitchReport[] = [];
    for (const theme of ['Blank', '5ePHB']) switches.push(await page.evaluate((t) => window.__hbPerf.setTheme(t), theme));
    for (const s of switches) {
      expect(s.repaginations.length).toBeGreaterThan(0);
      expect(s.toSettled).toBeGreaterThanOrEqual(s.toRepaginate);
      expect(s.pagination.steps).toBeGreaterThan(0);
    }
    expect(switches[0]!.pages).not.toBe(load.pages); // Blank lays the brew out on a different number of pages
    expect(Math.abs(switches[1]!.pages - load.pages)).toBeLessThanOrEqual(1);
    await record(testInfo, 'smoke-theme', { switches }, switches.map((s) => `${s.from}→${s.to} settled in ${s.toSettled} ms (${s.pagesBefore}→${s.pages} pages)`).join('; '));
  });
  smokeTest('a theme switch that removes pages keeps the elements of the pages after them', async ({ page }) => {
    // Page ids (p1…pN) are written on the elements, not decorations: after a removed page,
    // ProseMirror matched the later pages by position and re-created every one of them (P8.1).
    await mount(page, rawBrew150(SMALL_BREW), { shell: 'canvas', theme: '5ePHB' });
    await page.evaluate((t) => window.__hbPerf.setTheme(t), 'Blank');
    await page.evaluate(() => {
      const root = document.querySelector('.hb-canvas .ProseMirror')!;
      const w = window as unknown as { __pageChurn: { added: number; removed: number }; __pageChurnObserver?: MutationObserver };
      w.__pageChurn = { added: 0, removed: 0 };
      w.__pageChurnObserver?.disconnect();
      w.__pageChurnObserver = new MutationObserver((records) => {
        for (const r of records) {
          w.__pageChurn.added += r.addedNodes.length;
          w.__pageChurn.removed += r.removedNodes.length;
        }
      });
      w.__pageChurnObserver.observe(root, { childList: true });
    });
    const s = await page.evaluate((t) => window.__hbPerf.setTheme(t), '5ePHB');
    const churn = await page.evaluate(() => {
      const w = window as unknown as { __pageChurn: { added: number; removed: number }; __pageChurnObserver?: MutationObserver };
      w.__pageChurnObserver?.disconnect();
      return w.__pageChurn;
    });
    expect(s.pages).toBeLessThan(s.pagesBefore);
    const inserts = s.pagination.actions.insert ?? 0;
    expect(churn.added).toBeLessThanOrEqual(inserts);
    expect(churn.removed).toBe(s.pagesBefore - s.pages + inserts);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('.hb-canvas .ProseMirror > .page')).every((el, i) => el.id === `p${i + 1}`))).toBe(true);
  });
});

test.describe('performance work (P8.1) @serial', () => {
  // A fresh /dev/perf page, a big fixture mounted and one scenario.
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
    await openPerf(page);
  });

  for (const [name, raw] of [
    ['perf-150', () => rawBrew150(SCALE_150)],
    ['perf-50', () => rawSection50(SCALE_50)],
  ] as const) {
    test(`fixtures: regenerate ${name} (HB_PERF_GENERATE=1)`, async ({ page, browserName }, testInfo) => {
      test.skip(process.env.HB_PERF_GENERATE !== '1' || browserName !== 'chromium', 'set HB_PERF_GENERATE=1 (Chromium) to regenerate');
      const load = await mount(page, raw());
      const doc = await page.evaluate(() => window.__hbPerf.json());
      const file = writeFixture(name, doc);
      await record(testInfo, `generate-${name}`, { load, file }, `${load.pages} pages, ${textLength(doc)} characters, raw load settled in ${load.toSettled} ms`);
    });
  }

  test('load: 150-page brew with its stored layout, mount to settled', async ({ page }, testInfo) => {
    const doc = readFixture('perf-150');
    const machine = await machineContext();
    const load = await mount(page, doc);
    const env = await page.evaluate(() => window.__hbPerf.env());
    await record(
      testInfo,
      'load-150',
      { machine, env, load },
      `${load.pages} pages: editor ${load.toEditor} ms, first paint ${load.toFirstPaint} ms, ready ${load.toReady} ms, settled ${load.toSettled} ms ` +
        `(${load.pagination.steps} steps, ${load.pagination.docSteps} changed the document) [cpu busy ${machine.cpuBusy}]`,
    );
    expect(load.pages).toBeGreaterThanOrEqual(140);
    expect(await page.evaluate(() => document.querySelectorAll('.hb-oversized').length)).toBe(0);
  });

  /** 31 keys (letters and spaces) at each place: half a line, so a key may move a boundary. */
  const SENTENCE = 'the quiet lantern keeps an old ';

  // The 150-page brew (stored layout), and a 10-page brew: its cover, contents and the first 8
  // pages of chapter 1. Two places each: the middle of a chapter, and near the end of the brew.
  for (const { size, places } of [
    { size: 150, places: [40, 120] },
    { size: 10, places: [4, 8] },
  ]) {
    test(`typing on the visible page (${size}-page brew): a keystroke that moves nothing checks its page only, in one step and one transaction`, async ({ page }, testInfo) => {
      const full = readFixture('perf-150');
      await mount(page, size === 150 ? full : { ...full, content: full.content!.slice(0, size) });
      const typed: TypingReport[] = [];
      const moved: { at: number; key: number; steps: string; actions: string }[] = [];
      let pages = await page.evaluate(() => window.__hbPerf.pages());
      const tocPages = await tocPagesOf(page);
      for (const at of places) {
        const caret = await page.evaluate((i) => window.__hbPerf.placeCaret(i), at);
        expect(caret.page).toBe(at);
        // The middle of a paragraph past what the page before could pull back (plugin.ts
        // reachesPreviousPage): every keystroke's pass starts at the caret's page (P8.1).
        expect(caret.kind === 'manual' || caret.block > caret.leadingHeadings, `page ${at}: the caret's paragraph follows the page's first block`).toBe(true);
        await quietAfterScroll(page);
        const { keys, typing } = await typeKeyByKey(page, SENTENCE, { seed: at });
        typed.push(typing);
        for (const [i, { key, work }] of keys.entries()) {
          const label = `page ${at}, key ${i} "${key}"`;
          const shapes = expectWork(work, { from: at, pagesBefore: pages, tocPages, label });
          pages = work.pages;
          if (measuredOnly(work)) {
            // Nothing moved: one measurement of its page, sent in one transaction, and only that
            // page's DOM changed.
            expect(work.passes, label).toEqual([[{ page: at, action: 'settled' }]]);
            expect(work.transactions, `${label}: pagination transactions`).toBe(1);
            expect(work.mutatedPages, `${label}: pages changed in the DOM`).toEqual([at]);
          } else {
            const steps = shapes.map((s) => s.steps).join(' + ');
            moved.push({ at, key: i, steps, actions: work.passes.map((pass) => pass.map((s) => `${s.page}:${s.action}`).join(' ')).join(' | ') });
          }
        }
      }
      const summary = latency(typed);
      const machine = await machineContext();
      await record(
        testInfo,
        `typing-${size}`,
        { machine, summary, moved, reports: typed },
        `${summary.keys} keys (${moved.length} moved boundaries: ${moved.map((m) => `${m.steps} steps`).join(', ') || 'none'}): ` +
          `work p50 ${summary.work.p50} / p95 ${summary.work.p95} / max ${summary.work.max} ms; event to next paint p50 ${summary.paint.p50} / p95 ${summary.paint.p95} ms; ` +
          `input handling p50 ${summary.handlers.p50} / p95 ${summary.handlers.p95} ms, its dispatch p50 ${summary.dispatch.p50} / p95 ${summary.dispatch.p95} ms [cpu busy ${machine.cpuBusy}]`,
      );
      expect(summary.keys).toBe(places.length * SENTENCE.length);
    });
  }

  /** The 50-page section (one manual page, the rest auto pages), with the caret on page 1. */
  async function mountSection(page: Page) {
    const load = await mount(page, readFixture('perf-50'));
    expect(load.pages).toBeGreaterThanOrEqual(45);
    const kinds = await page.evaluate(() => window.__hbPerf.pageKinds());
    expect(kinds.filter((k) => k === 'manual')).toHaveLength(1);
    await page.evaluate(() => window.__hbPerf.placeCaret(0));
    await quietAfterScroll(page);
    return load;
  }

  test('typing on page 1 of a 50-page section: every keystroke is one forward pass through the section', async ({ page }, testInfo) => {
    const load = await mountSection(page);
    // 66 keys: past the end of a line on page 1, so some keys move boundaries (the paste test
    // moves all of them).
    const { keys, typing } = await typeKeyByKey(page, 'amber lanterns gather where the hollow river crosses under ancient ');
    let pages = load.pages;
    const tocPages = await tocPagesOf(page);
    const cascades: { key: number; steps: number; pushes: number; pulls: number; settle: number | null }[] = [];
    for (const [i, { key, work }] of keys.entries()) {
      const [shape] = expectWork(work, { from: 0, pagesBefore: pages, tocPages, label: `key ${i} "${key}"` });
      pages = work.pages;
      if (!measuredOnly(work)) cascades.push({ key: i, steps: shape!.steps, pushes: shape!.pushes + shape!.inserts, pulls: shape!.pulls, settle: typing.keys[i]?.settle ?? null });
    }
    const summary = latency([typing]);
    const machine = await machineContext();
    await record(
      testInfo,
      'section-50-typed',
      { machine, pages: load.pages, summary, cascades },
      `${load.pages} pages: typed ${summary.keys} keys, key to settled p50 ${summary.settle.p50} / max ${summary.settle.max} ms ` +
        `(${cascades.length} keys moved boundaries: ${cascades.map((c) => `${c.settle} ms/${c.steps} steps`).join(', ')}) [cpu busy ${machine.cpuBusy}]`,
    );
    expect(cascades.length, 'some keystrokes moved boundaries after page 1').toBeGreaterThan(0);
  });

  test('a paragraph pasted on page 1 of a 50-page section: one forward pass that moves every boundary', async ({ page }, testInfo) => {
    const load = await mountSection(page);
    // A paragraph's worth of text (about 11 lines) at once, three times: every boundary of the
    // section moves (the short gaps a page keeps before a heading or a paragraph's last lines
    // can't absorb it).
    const paragraph =
      'the patient warden measures each crooked causeway before the storm, and the old ferry answers the bell while every lantern of the hollow harbor ' +
      'keeps its quiet watch over the salted tide; beyond the northern ridge the courier records each oath in a weathered ledger, and the envoy of ' +
      'Greywater trades a silver key for a map that remembers the ancient roads, where the sunken shrine still shelters pilgrims from the frost and ' +
      'the restless caravan gathers its banners before the long road north ';
    const pasted: (EditReport & { shape: PassShape })[] = [];
    let pages = load.pages;
    const tocPages = await tocPagesOf(page);
    await page.evaluate(() => window.__hbPerf.work()); // count from here
    for (let k = 0; k < 3; k++) {
      const report = await page.evaluate((text) => window.__hbPerf.insertText(text), paragraph);
      await page.evaluate(() => window.__hbPerf.quiet(window.__hbPerf.now(), 300));
      const work = await page.evaluate(() => window.__hbPerf.work());
      const [shape] = expectWork(work, { from: 0, pagesBefore: pages, tocPages, label: `paste ${k + 1}` });
      expect(shape!.pushes + shape!.inserts, `paste ${k + 1}: every boundary moves`).toBeGreaterThanOrEqual(pages - 1);
      pages = work.pages;
      pasted.push({ ...report, shape: shape! });
    }
    const machine = await machineContext();
    await record(
      testInfo,
      'section-50-pasted',
      { machine, pages: load.pages, pasted },
      `${load.pages} pages: pasted paragraph settles ${pasted.map((p) => `${p.settle} ms/${p.shape.steps} steps`).join(', ')} [cpu busy ${machine.cpuBusy}]`,
    );
  });

  test('theme switch on the 150-page brew: one repagination, one forward pass over every page', async ({ page }, testInfo) => {
    const load = await mount(page, readFixture('perf-150'), { shell: 'canvas', theme: '5ePHB' });
    const switches: (ThemeSwitchReport & { shapes: PassShape[] })[] = [];
    const tocPages = await tocPagesOf(page);
    await page.evaluate(() => window.__hbPerf.work()); // count from here
    for (const theme of ['Blank', '5ePHB']) {
      const s = await page.evaluate((t) => window.__hbPerf.setTheme(t), theme);
      const work = await page.evaluate(() => window.__hbPerf.work());
      const label = `${s.from} → ${s.to}`;
      expect(s.repaginations.map((r) => [r.from, r.reason]), `${label}: repaginations`).toEqual([[0, 'theme']]);
      const shapes = expectWork(work, { from: 0, pagesBefore: s.pagesBefore, tocPages, restyles: 1, label });
      expect(shapes[0]!.visits, `${label}: every page checked`).toBeGreaterThanOrEqual(s.pages);
      switches.push({ ...s, shapes });
    }
    const machine = await machineContext();
    await record(
      testInfo,
      'theme-150',
      { machine, pagesLoaded: load.pages, switches },
      switches
        .map((s) => `${s.from}→${s.to}: ready ${s.toReady} ms, repaginate ${s.toRepaginate} ms, settled ${s.toSettled} ms (${s.pagesBefore}→${s.pages} pages, ${s.shapes.map((x) => `${x.steps} steps, ${x.pulls} pulls`).join(' + ')})`)
        .join('; ') + ` [cpu busy ${machine.cpuBusy}]`,
    );
    // Back in 5ePHB, the brew has the page count it was saved with.
    expect(Math.abs(switches[1]!.pages - load.pages)).toBeLessThanOrEqual(1);
  });
});
