// A Playwright reporter for the runner scripts' no-progress watchdog (scripts/testRunner.ts): it
// sends every test and step, as it begins and ends, to the parent process over IPC. The runner
// attaches it with PW_TEST_REPORTER (an extra reporter next to the configured or --reporter ones),
// so it prints nothing and needs no change to playwright.config.ts. Without an IPC channel (a plain
// `pnpm exec playwright test PW_TEST_REPORTER=…`) it does nothing.
import path from 'node:path';
import type { FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import type { ProgressEvent } from './testRunner.ts';

// The runners start Playwright in web/: locations relative to it, as the guard and the notes write them.
const webDir = process.cwd();

function sendToRunner(event: ProgressEvent): void {
  if (!process.send || !process.connected) return;
  try {
    process.send(event);
  } catch {
    // the runner is gone
  }
}

const key = (test: TestCase, result: TestResult) => `${test.id}#${result.retry}`;
// Playwright's own steps and hooks count too: a stuck page.goto or fixture teardown shows as the
// open step.
const STEP_CATEGORIES = new Set(['test.step', 'pw:api', 'expect', 'hook', 'fixture', 'test.attach']);

export default class ProgressReporter implements Reporter {
  private readonly send: (event: ProgressEvent) => void;

  /** Playwright passes its reporter options (unused); tests pass `send` to see the events. */
  constructor(_options?: unknown, send: (event: ProgressEvent) => void = sendToRunner) {
    this.send = send;
    this.send({ type: 'hello' });
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: unknown, suite: Suite): void {
    this.send({ type: 'begin', total: suite.allTests().length });
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.send({
      type: 'testBegin',
      id: key(test, result),
      title: test.titlePath().slice(3).join(' › ') || test.title,
      location: `${path.relative(webDir, test.location.file).replace(/\\/g, '/')}:${test.location.line}`,
      project: test.parent.project()?.name ?? '',
      timeout: test.timeout,
      retry: result.retry,
      tags: test.tags,
    });
  }

  onStepBegin(test: TestCase, result: TestResult, step: TestStep): void {
    if (STEP_CATEGORIES.has(step.category)) this.send({ type: 'step', id: key(test, result), title: step.title, open: true });
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep): void {
    if (STEP_CATEGORIES.has(step.category)) this.send({ type: 'step', id: key(test, result), title: step.title, open: false });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.send({ type: 'testEnd', id: key(test, result), status: result.status, duration: result.duration });
  }

  onEnd(result: FullResult): void {
    this.send({ type: 'end', status: result.status });
  }
}
