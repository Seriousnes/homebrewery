// P8.1 performance (plan §4.10, §11 P8.1), measured in the page by /dev/perf (window.__hbPerf,
// web/src/dev/perf). Targets, each asserted with tolerance() for slower hardware:
//
//   typing on the visible page       work per keystroke < 16 ms at p95: its input processing plus
//                                    the next frame's work (pagination, style, layout, paint), so
//                                    the keystroke shows in the first frame after it. Event to
//                                    next paint is recorded too; it adds the wait for that frame.
//                                    On the 153-page brew and on a 10-page one (its first pages).
//   page 1 of a 50-page section      an edit that moves every boundary of the section settles
//                                    within 1 s (typed at a realistic rate, and pasted)
//   theme switch, 150-page brew      5ePHB → Blank → 5ePHB: each switch settles within 3 s
//   load, 150-page brew              recorded (no target): mount to settled, stored layout
//
// The budgets on the big fixtures are time budgets, so they are tagged @serial: they run in the
// serial projects (chromium-serial / firefox-serial, one worker, after the parallel projects in a
// full run), so no other test competes for the CPU. One budget per test, each on a fresh page and
// well under a minute (CLAUDE.md "Tests fail fast"). On their own: `node e2e/perf/run-perf.mjs`
// (from web/; an isolated Vite without HMR, E2E_PORT 5375; `--prod` for a production build).
// HB_PERF_GENERATE=1 regenerates the fixtures (Chromium, one test per fixture): the generated
// documents after pagination settled, auto pages included, as a saved brew stores them.
//
// The default run has a smoke test of the same measurements on a small generated brew (about 30
// pages) and a 5-page section: the probe, the reports and the pagination they record, with no
// time budget; and that a theme switch that removes pages keeps the elements of the pages after
// them (a P8.1 fix: ProseMirror had re-created every later page). Each smoke test takes ≤ 6 s.
//
// With HB_PERF_OUT=<file>, every result is also appended to that file as one JSON line.
import { expect, test, type Page } from '@playwright/test';
import { rawBrew150, rawSection50, textLength, type JsonNode } from './fixtureGen';
import {
  machineContext,
  openPerf,
  readFixture,
  record,
  smokeTest,
  tolerance,
  typeRealistically,
  writeFixture,
  type EditReport,
  type ThemeSwitchReport,
  type TypingReport,
} from './helpers';

/** Scales of the generated documents that give ~150 and ~50 pages in 5ePHB. */
const SCALE_150 = 1;
const SCALE_50 = 1.04;

const mount = (page: Page, doc: JsonNode, opts: { shell?: 'app' | 'canvas'; theme?: string } = {}) =>
  page.evaluate(([d, o]) => window.__hbPerf.mount(d, o), [doc, opts] as const);

/** Types a sentence (130 keys at ~9 a second) at each page of `places`; the keystrokes' summary. */
async function typeAndSummarize(page: Page, places: number[]) {
  const reports: TypingReport[] = [];
  for (const at of places) {
    const caret = await page.evaluate((i) => window.__hbPerf.placeCaret(i), at);
    expect(caret.page).toBe(at);
    await page.evaluate(() => window.__hbPerf.startTyping());
    // 130 keystrokes (letters and spaces) at ~9 keys a second: several lines, so boundaries move.
    await typeRealistically(page, 'the quiet lantern keeps an old promise beyond the northern ridge while every traveler waits for the tide to turn at dawn ', {
      seed: at,
    });
    await page.evaluate(() => window.__hbPerf.quiet(window.__hbPerf.now(), 500));
    reports.push(await page.evaluate(() => window.__hbPerf.stopTyping()));
  }
  const keys = reports.flatMap((r) => r.keys);
  const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * values.length) - 1)]!;
  const stat = (values: number[]) => ({ p50: pct(values, 50), p95: pct(values, 95), max: Math.max(...values) });
  const summary = {
    keys: keys.length,
    work: stat(keys.map((k) => k.work)),
    paint: stat(keys.map((k) => k.paint)),
    handlers: stat(keys.map((k) => k.handlers)),
    dispatch: stat(keys.map((k) => k.dispatch)),
    framesWithPagination: keys.filter((k) => k.frameSteps > 0).length,
    pushes: reports.reduce((n, r) => n + (r.pagination.actions.push ?? 0) + (r.pagination.actions.insert ?? 0), 0),
    eventTiming: reports.map((r) => ({ supported: r.eventTiming.supported, over16: r.eventTiming.keydownOver16, over24: r.eventTiming.keydownOver24, max: r.eventTiming.maxKeydown })),
    longFrames: reports.reduce((n, r) => n + r.longFrames.length, 0),
  };
  return { summary, reports };
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

test.describe('performance budgets (P8.1) @serial', () => {
  // A fresh /dev/perf page, a big fixture mounted and one measurement.
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

  // The 150-page brew (stored layout), and a 10-page brew: its cover, contents and the first 8
  // pages of chapter 1. Two places each: the middle of a chapter, and near the end of the brew.
  for (const { size, places } of [
    { size: 150, places: [40, 120] },
    { size: 10, places: [4, 8] },
  ]) {
    test(`typing latency on the visible page (${size}-page brew): < 16 ms at p95`, async ({ page }, testInfo) => {
      const full = readFixture('perf-150');
      await mount(page, size === 150 ? full : { ...full, content: full.content!.slice(0, size) });
      const { summary, reports } = await typeAndSummarize(page, places);
      const machine = await machineContext();
      await record(
        testInfo,
        `typing-${size}`,
        { machine, summary, reports },
        `${summary.keys} keys: work p50 ${summary.work.p50} / p95 ${summary.work.p95} / max ${summary.work.max} ms; ` +
          `event to next paint p50 ${summary.paint.p50} / p95 ${summary.paint.p95} ms; input handling p50 ${summary.handlers.p50} / p95 ${summary.handlers.p95} ms, ` +
          `its dispatch p50 ${summary.dispatch.p50} / p95 ${summary.dispatch.p95} ms; ${summary.pushes} boundary moves [cpu busy ${machine.cpuBusy}]`,
      );
      expect(summary.keys).toBeGreaterThanOrEqual(200);
      expect.soft(summary.work.p95, 'work per keystroke, p95 (ms)').toBeLessThan(16 * tolerance());
      // Shown in the first frame after the key (one 60 Hz frame interval of waiting at most).
      expect.soft(summary.paint.p95, 'event to next paint, p95 (ms)').toBeLessThan((16.7 + 16) * tolerance());
    });
  }

  /** The 50-page section (one manual page, the rest auto pages), with the caret on page 1. */
  async function mountSection(page: Page) {
    const load = await mount(page, readFixture('perf-50'));
    expect(load.pages).toBeGreaterThanOrEqual(45);
    const kinds = await page.evaluate(() => window.__hbPerf.pageKinds());
    expect(kinds.filter((k) => k === 'manual')).toHaveLength(1);
    await page.evaluate(() => window.__hbPerf.placeCaret(0));
    return load;
  }

  test('typing on page 1 of a 50-page section settles within 1 s', async ({ page }, testInfo) => {
    const load = await mountSection(page);
    // Typed: words at ~9 keys a second on page 1. Each key's settle is the time from the key to
    // the next settle (later keys typed before it included); a key whose line moved the section
    // shows the cascade.
    const typed: { word: string; maxSettle: number; steps: number }[] = [];
    const words = 'amber lanterns gather where the hollow river crosses under ancient bridges and the wary courier records every oath before dawn'.split(' ');
    for (const word of words) {
      await page.evaluate(() => window.__hbPerf.startTyping());
      await typeRealistically(page, `${word} `, { seed: word.length });
      await page.evaluate(() => window.__hbPerf.quiet(window.__hbPerf.now(), 300));
      const r = await page.evaluate(() => window.__hbPerf.stopTyping());
      typed.push({ word, maxSettle: Math.max(...r.keys.map((k) => k.settle ?? Infinity)), steps: r.pagination.steps });
    }
    const cascades = typed.filter((t) => t.steps > 10);
    const maxTyped = Math.max(...typed.map((t) => t.maxSettle));
    const machine = await machineContext();
    await record(
      testInfo,
      'section-50-typed',
      { machine, pages: load.pages, typed },
      `${load.pages} pages: typed, worst key to settled ${maxTyped} ms (${cascades.length} of ${typed.length} words moved boundaries: ` +
        `${cascades.map((c) => `${c.maxSettle} ms/${c.steps} steps`).join(', ')}) [cpu busy ${machine.cpuBusy}]`,
    );
    expect(cascades.length, 'some typed words moved boundaries after page 1').toBeGreaterThan(0);
    expect.soft(maxTyped, 'typing on page 1: worst key to settled (ms)').toBeLessThan(1000 * tolerance());
  });

  test('a paragraph pasted on page 1 of a 50-page section settles within 1 s', async ({ page }, testInfo) => {
    const load = await mountSection(page);
    // Pasted: a paragraph's worth of text (about 11 lines) at once, three times: every boundary of
    // the section moves (the short gaps a page keeps before a heading or a paragraph's last lines
    // can't absorb it).
    const pasted: EditReport[] = [];
    const paragraph =
      'the patient warden measures each crooked causeway before the storm, and the old ferry answers the bell while every lantern of the hollow harbor ' +
      'keeps its quiet watch over the salted tide; beyond the northern ridge the courier records each oath in a weathered ledger, and the envoy of ' +
      'Greywater trades a silver key for a map that remembers the ancient roads, where the sunken shrine still shelters pilgrims from the frost and ' +
      'the restless caravan gathers its banners before the long road north ';
    for (let k = 0; k < 3; k++) {
      pasted.push(await page.evaluate((text) => window.__hbPerf.insertText(text), paragraph));
      await page.evaluate(() => window.__hbPerf.quiet(window.__hbPerf.now(), 300));
    }
    const maxPasted = Math.max(...pasted.map((p) => p.settle));
    const machine = await machineContext();
    await record(
      testInfo,
      'section-50-pasted',
      { machine, pages: load.pages, pasted },
      `${load.pages} pages: pasted paragraph settles ${pasted.map((p) => `${p.settle} ms/${p.pagination.steps} steps`).join(', ')} [cpu busy ${machine.cpuBusy}]`,
    );
    expect(Math.min(...pasted.map((p) => p.pagination.steps)), 'a pasted paragraph moves every boundary').toBeGreaterThanOrEqual(load.pages - 1);
    expect.soft(maxPasted, 'pasted paragraph on page 1: to settled (ms)').toBeLessThan(1000 * tolerance());
  });

  test('theme switch on the 150-page brew settles within 3 s', async ({ page }, testInfo) => {
    const load = await mount(page, readFixture('perf-150'), { shell: 'canvas', theme: '5ePHB' });
    const switches: ThemeSwitchReport[] = [];
    for (const theme of ['Blank', '5ePHB']) switches.push(await page.evaluate((t) => window.__hbPerf.setTheme(t), theme));
    const machine = await machineContext();
    await record(
      testInfo,
      'theme-150',
      { machine, pagesLoaded: load.pages, switches },
      switches
        .map((s) => `${s.from}→${s.to}: ready ${s.toReady} ms, repaginate ${s.toRepaginate} ms, settled ${s.toSettled} ms (${s.pagesBefore}→${s.pages} pages, ${s.pagination.steps} steps)`)
        .join('; ') + ` [cpu busy ${machine.cpuBusy}]`,
    );
    for (const s of switches) {
      expect(s.repaginations.length).toBeGreaterThan(0);
      expect.soft(s.toSettled, `${s.from} → ${s.to}: switch to settled (ms)`).toBeLessThan(3000 * tolerance());
    }
    // Back in 5ePHB, the brew has the page count it was saved with.
    expect(Math.abs(switches[1]!.pages - load.pages)).toBeLessThanOrEqual(1);
  });
});
