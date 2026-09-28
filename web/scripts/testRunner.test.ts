// The runner scripts' fail-fast machinery (scripts/testRunner.ts): the no-progress watchdog's rules
// with a fake clock, supervise() killing a real stalled child with its whole process tree, and the
// progress reporter.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import type { FullResult, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { describe, expect, it } from 'vitest';
import ProgressReporter from './progressReporter.ts';
import { describeSets, isInteractive, killTreeSync, playwrightCli, ProgressWatchdog, type ProgressEvent, summarize, supervise } from './testRunner.ts';

const OPTIONS = { stallMs: 60_000, graceMs: 30_000, startupMs: 90_000 };

const testBegin = (id: string, extra: Partial<Extract<ProgressEvent, { type: 'testBegin' }>> = {}): ProgressEvent => ({
  type: 'testBegin',
  id,
  title: `test ${id}`,
  location: `e2e/x.spec.ts:${id.length}`,
  project: 'chromium',
  timeout: 15_000,
  retry: 0,
  tags: [],
  ...extra,
});

describe('ProgressWatchdog', () => {
  it('before the run begins, allows start-up time, then reports that no test started', () => {
    const w = new ProgressWatchdog(0, OPTIONS);
    w.event({ type: 'hello' }, 1000);
    expect(w.check(90_000)).toBeNull();
    const stall = w.check(91_000);
    expect(stall?.limitMs).toBe(90_000);
    expect(stall?.message).toMatch(/started no test in 90 s/);
  });

  it('is not stalled while tests begin and end; is after 60 s of nothing, and names what ran', () => {
    const w = new ProgressWatchdog(0, OPTIONS);
    w.event({ type: 'begin', total: 3 }, 1000);
    w.event(testBegin('a'), 2000);
    w.event({ type: 'testEnd', id: 'a', status: 'passed', duration: 1000 }, 3000);
    w.event(testBegin('bb', { title: 'suite › hangs' }), 4000);
    w.event({ type: 'step', id: 'bb', title: 'page.goto(/edit/x)', open: true }, 5000);
    expect(w.check(64_999)).toBeNull();
    const stall = w.check(65_000);
    expect(stall).not.toBeNull();
    expect(stall!.idleMs).toBe(60_000);
    expect(stall!.running.map((t) => t.id)).toEqual(['bb']);
    expect(stall!.message).toContain('no test began, finished or took a step for 60 s (limit 60 s)');
    expect(stall!.message).toContain('[chromium] e2e/x.spec.ts:2 › suite › hangs  — running 61 s, timeout 15 s, in step "page.goto(/edit/x)"');
    expect(stall!.message).toContain('Last finished: [chromium] e2e/x.spec.ts:1 › test a (passed) 62 s ago.');
    expect(stall!.message).toContain('1 of 3 tests finished.');
  });

  it('counts steps as progress, and shows the innermost open step', () => {
    const w = new ProgressWatchdog(0, OPTIONS);
    w.event(testBegin('a'), 0);
    for (let t = 10_000; t <= 100_000; t += 10_000) {
      w.event({ type: 'step', id: 'a', title: `step ${t}`, open: true }, t);
      w.event({ type: 'step', id: 'a', title: `step ${t}`, open: false }, t + 1);
    }
    expect(w.check(150_000)).toBeNull();
    w.event({ type: 'step', id: 'a', title: 'outer', open: true }, 150_000);
    w.event({ type: 'step', id: 'a', title: 'inner', open: true }, 150_001);
    expect(w.check(210_001)?.message).toContain('in step "inner"');
    w.event({ type: 'step', id: 'a', title: 'inner', open: false }, 210_002);
    expect(w.check(270_002)?.message).toContain('in step "outer"');
  });

  it('lets a running test use its own timeout plus the grace before calling the run stalled', () => {
    const w = new ProgressWatchdog(0, OPTIONS);
    w.event(testBegin('a', { timeout: OPTIONS.stallMs }), 0); // a test that raised its own timeout to 60 s
    // 60 s without progress, but the test may run 60 s and tear down for 30 s more.
    expect(w.check(89_999)).toBeNull();
    expect(w.check(90_000)?.message).toContain('timeout 60 s');
  });

  it('a test without a timeout gets no extension', () => {
    const w = new ProgressWatchdog(0, OPTIONS);
    w.event(testBegin('a', { timeout: 0 }), 0);
    expect(w.check(60_000)?.message).toContain('timeout none, in no step');
  });

  it('has one window for every test: no tag or project gets a longer one', () => {
    for (const extra of [{ tags: ['@serial'] }, { tags: ['@slow'] }, { project: 'firefox-serial' }]) {
      const w = new ProgressWatchdog(0, OPTIONS);
      w.event(testBegin('a', extra), 0);
      expect(w.check(59_999), JSON.stringify(extra)).toBeNull();
      expect(w.check(60_000)?.limitMs, JSON.stringify(extra)).toBe(60_000);
    }
  });

  it('records every test that ended, for the timing summary', () => {
    const w = new ProgressWatchdog(0, OPTIONS);
    w.event(testBegin('a', { title: 'first' }), 0);
    w.event(testBegin('bb', { title: 'second', project: 'firefox' }), 0);
    w.event({ type: 'testEnd', id: 'bb', status: 'failed', duration: 9000 }, 9000);
    w.event({ type: 'testEnd', id: 'a', status: 'passed', duration: 12_000 }, 12_000);
    expect(w.results).toEqual([
      { title: 'second', location: 'e2e/x.spec.ts:2', project: 'firefox', retry: 0, status: 'failed', duration: 9000 },
      { title: 'first', location: 'e2e/x.spec.ts:1', project: 'chromium', retry: 0, status: 'passed', duration: 12_000 },
    ]);
  });

  it('with nothing running after the run began, says it is stuck between tests', () => {
    const w = new ProgressWatchdog(0, OPTIONS);
    w.event({ type: 'begin', total: 1 }, 0);
    w.event(testBegin('a'), 0);
    w.event({ type: 'testEnd', id: 'a', status: 'failed', duration: 15_000 }, 15_000);
    expect(w.check(74_999)).toBeNull();
    expect(w.check(75_000)?.message).toMatch(/No test was running[\s\S]*1 of 1 tests finished/);
  });
});

describe('summarize', () => {
  it('gives the wall time, the test time per project and the slowest tests', () => {
    const test = (title: string, project: string, duration: number, status = 'passed') => ({ title, location: `e2e/${title}.spec.ts:1`, project, retry: 0, status, duration });
    const text = summarize([test('a', 'chromium', 2000), test('b', 'firefox', 7400, 'failed'), test('c', 'chromium', 3000), test('d', 'firefox', 600)], 65_000, 2);
    expect(text.split('\n')).toEqual([
      '4 tests (3 passed, 1 failed) in 65 s',
      'test time per project: chromium 5 s, firefox 8 s',
      'slowest 2:',
      '  7.4 s  [firefox] e2e/b.spec.ts:1 › b (failed)',
      '  3.0 s  [chromium] e2e/c.spec.ts:1 › c (passed)',
    ]);
    expect(summarize([], 1000)).toBe('0 tests in 1 s');
  });

  it('lists each set with its wall time, flags one close to the cap, and names the sets not run', () => {
    const set = (name: string, ms: number, status = 0, stalled = false) => ({ name, ms, status, stalled, tests: [] });
    expect(describeSets([set('a11y', 150_000), set('canvas', 245_000), set('shell', 20_000, 1)], [{ name: 'a11y' }, { name: 'canvas' }, { name: 'shell' }, { name: 'serial' }]).split('\n')).toEqual([
      'sets:',
      '  a11y: 150 s, 0 tests, passed',
      '  canvas: 245 s, 0 tests, passed — over 240 s, close to the 5-minute cap: split this set',
      '  shell: 20 s, 0 tests, failed (exit 1)',
      '  not run (an earlier set failed): serial',
      '  total 415 s',
    ]);
    expect(describeSets([set('x', 61_000, 124, true)], [{ name: 'x' }])).toContain('x: 61 s, 0 tests, stalled');
  });
});

// supervise() on real child processes, with the watchdog on a clock of the test's own: the clock
// moves only when the test moves it (on the child's events), so whether a run stalls never
// depends on how fast this machine runs the children.
describe('supervise', () => {
  it('kills a stalled run with its whole process tree and says which test was running', async () => {
    // The "browser" holds a connection to this server: the OS closes it when the browser dies (on
    // every platform, zombie or not), so its end is an event, not something to poll for. A kill
    // that missed the browser leaves it open, and the test timeout fails the test.
    const server = net.createServer();
    const browserGone = new Promise((resolve) => {
      server.once('connection', (socket) => {
        socket.on('error', () => {}); // a reset, on Windows
        socket.once('close', resolve);
        socket.resume();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const browser = `require('node:net').connect(${port}, '127.0.0.1', () => process.stdout.write('up')); setInterval(() => {}, 1000);`;
      // A fake Playwright: starts a child of its own (a "browser"; detached: its own process group,
      // as browsers are, and on Windows outside the job that would end it with its parent, so only
      // a kill of the whole tree ends it), and once that is connected reports one test,
      // then hangs.
      const script = `
        const { spawn } = require('node:child_process');
        const browser = spawn(process.execPath, ['-e', ${JSON.stringify(browser)}], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
        browser.stdout.once('data', () => {
          process.send({ type: 'begin', total: 1 });
          process.send({ type: 'testBegin', id: 't1', title: 'awaits forever', location: 'e2e/stall.spec.ts:3', project: 'chromium', timeout: 0, retry: 0, tags: [] });
        });
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      let clock = 0;
      const messages: string[] = [];
      const result = await supervise(child, {
        now: () => clock,
        watchdog: OPTIONS,
        checkEveryMs: 10,
        // Once the test began, nothing happens for the whole stall window.
        onEvent: (event) => {
          if (event.type === 'testBegin') clock += OPTIONS.stallMs;
        },
        onStall: (stall) => messages.push(stall.message),
      });
      expect(result.stall).not.toBeNull();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('[chromium] e2e/stall.spec.ts:3 › awaits forever');
      await browserGone;
    } finally {
      server.close();
    }
  });

  it('leaves a run that makes progress alone and returns its exit code', async () => {
    // Five tests, then it exits when told to (so every event is in before the exit).
    const script = `
      process.send({ type: 'begin', total: 5 });
      for (let n = 1; n <= 5; n++) {
        process.send({ type: 'testBegin', id: 't' + n, title: 't', location: 'e2e/a.spec.ts:1', project: 'firefox', timeout: 15000, retry: 0, tags: [] });
        process.send({ type: 'testEnd', id: 't' + n, status: 'passed', duration: 1 });
      }
      process.on('message', () => process.exit(3));
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let clock = 0;
    let ended = 0;
    const result = await supervise(child, {
      now: () => clock,
      watchdog: OPTIONS,
      checkEveryMs: 10,
      onEvent: (event) => {
        // Each event comes just inside the stall window after the one before: in all, the run
        // takes ten times that window.
        clock += OPTIONS.stallMs - 1;
        if (event.type === 'testEnd' && ++ended === 5) child.send('exit');
      },
    });
    expect(clock).toBeGreaterThan(10 * OPTIONS.stallMs);
    expect(result.stall).toBeNull();
    expect(result.code).toBe(3);
    expect(result.tests.map((t) => t.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
  });
});

// The reporter in-process, fed what Playwright passes it. (Spawning the Playwright CLI to see it
// load the reporter took 2 s of start-up alone, more on a busy machine: every runner run shows
// that, and names a reporter that never said hello when a run stalls.)
describe('progressReporter', () => {
  const location = { file: path.join(process.cwd(), 'e2e', 'x.spec.ts'), line: 7, column: 1 };
  const testCase = {
    id: 'abc',
    title: 'opens',
    titlePath: () => ['', 'chromium', 'e2e/x.spec.ts', 'suite', 'opens'],
    location,
    parent: { project: () => ({ name: 'chromium' }) },
    timeout: 15_000,
    tags: ['@smoke'],
  } as unknown as TestCase;
  const result = { retry: 1, status: 'passed', duration: 1234 } as unknown as TestResult;
  const step = (title: string, category: string) => ({ title, category }) as unknown as TestStep;

  it('sends hello, the test count, each test and its steps (Playwright’s own ones too), and the end', () => {
    const events: ProgressEvent[] = [];
    const reporter = new ProgressReporter(undefined, (e) => events.push(e));
    reporter.onBegin({}, { allTests: () => [testCase, testCase] } as unknown as Suite);
    reporter.onTestBegin(testCase, result);
    reporter.onStepBegin(testCase, result, step('page.goto(/edit/x)', 'pw:api'));
    reporter.onStepBegin(testCase, result, step('internal', 'test.attach.internal'));
    reporter.onStepEnd(testCase, result, step('page.goto(/edit/x)', 'pw:api'));
    reporter.onTestEnd(testCase, result);
    reporter.onEnd({ status: 'passed' } as FullResult);
    expect(reporter.printsToStdio()).toBe(false);
    expect(events).toEqual([
      { type: 'hello' },
      { type: 'begin', total: 2 },
      { type: 'testBegin', id: 'abc#1', title: 'suite › opens', location: 'e2e/x.spec.ts:7', project: 'chromium', timeout: 15_000, retry: 1, tags: ['@smoke'] },
      { type: 'step', id: 'abc#1', title: 'page.goto(/edit/x)', open: true },
      { type: 'step', id: 'abc#1', title: 'page.goto(/edit/x)', open: false },
      { type: 'testEnd', id: 'abc#1', status: 'passed', duration: 1234 },
      { type: 'end', status: 'passed' },
    ]);
  });

  it('is attached by this Playwright through PW_TEST_REPORTER (the runner adds it that way)', () => {
    const runner = createRequire(playwrightCli).resolve('playwright/lib/runner');
    expect(readFileSync(runner, 'utf8')).toContain('process.env.PW_TEST_REPORTER');
  });
});

describe('killTreeSync', () => {
  it('ignores a missing pid', () => {
    expect(() => killTreeSync(undefined)).not.toThrow();
  });
});

describe('isInteractive', () => {
  it('lets UI mode, the inspector and --debug run without the watchdog', () => {
    expect(isInteractive(['--ui'], {})).toBe(true);
    expect(isInteractive(['e2e/x.spec.ts', '--ui-port=0'], {})).toBe(true);
    expect(isInteractive(['--debug'], {})).toBe(true);
    expect(isInteractive([], { PWDEBUG: '1' })).toBe(true);
    expect(isInteractive(['e2e/ui-kit', '--project=chromium', '--reporter=line'], {})).toBe(false);
  });
});
