// The runner scripts' fail-fast machinery (scripts/testRunner.ts): the no-progress watchdog's rules
// with a fake clock, and supervise() killing a real stalled child with its whole process tree.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeSets,
  isInteractive,
  killTreeSync,
  playwrightCli,
  progressReporter,
  ProgressWatchdog,
  type ProgressEvent,
  sleep,
  summarize,
  supervise,
  webDir,
} from './testRunner.ts';

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

describe('supervise', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hb-supervise-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('kills a stalled run with its whole process tree and says which test was running', async () => {
    const pidFile = path.join(dir, 'grandchild.pid');
    // A fake Playwright: starts a child of its own (a "browser"), reports one test, then hangs.
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(browser.pid));
      process.send({ type: 'begin', total: 1 });
      process.send({ type: 'testBegin', id: 't1', title: 'awaits forever', location: 'e2e/stall.spec.ts:3', project: 'chromium', timeout: 0, retry: 0, tags: [] });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const messages: string[] = [];
    const started = Date.now();
    const result = await supervise(child, {
      watchdog: { stallMs: 400, graceMs: 100, startupMs: 3000 },
      checkEveryMs: 50,
      onStall: (stall) => messages.push(stall.message),
    });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.stall).not.toBeNull();
    expect(messages[0]).toContain('[chromium] e2e/stall.spec.ts:3 › awaits forever');
    const browser = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 40 && alive(browser); i++) await sleep(50);
    expect(alive(browser)).toBe(false);
  });

  it('leaves a run that makes progress alone and returns its exit code', async () => {
    const script = `
      let n = 0;
      process.send({ type: 'begin', total: 5 });
      const timer = setInterval(() => {
        n += 1;
        process.send({ type: 'testBegin', id: 't' + n, title: 't', location: 'e2e/a.spec.ts:1', project: 'firefox', timeout: 15000, retry: 0, tags: [] });
        process.send({ type: 'testEnd', id: 't' + n, status: 'passed', duration: 1 });
        if (n === 5) { clearInterval(timer); process.exit(3); }
      }, 100);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const result = await supervise(child, { watchdog: { stallMs: 400, graceMs: 100, startupMs: 3000 }, checkEveryMs: 50 });
    expect(result.stall).toBeNull();
    expect(result.code).toBe(3);
    expect(result.tests.map((t) => t.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
  });
});

describe('progressReporter', () => {
  it('reaches the runner over IPC when attached with PW_TEST_REPORTER (this Playwright still supports it)', async () => {
    const child = spawn(process.execPath, [playwrightCli, 'test', '--list', 'e2e/smoke.spec.ts', '--project=chromium'], {
      cwd: webDir,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // A base URL: no web server; --list starts no browser either.
      env: { ...process.env, E2E_BASE_URL: 'http://localhost:9', PW_TEST_REPORTER: progressReporter },
    });
    const events: ProgressEvent[] = [];
    child.on('message', (m) => events.push(m as ProgressEvent));
    const code = await new Promise((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
    expect(events[0]).toEqual({ type: 'hello' });
    const begin = events.find((e) => e.type === 'begin');
    expect(begin && begin.type === 'begin' && begin.total).toBeGreaterThan(0);
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
