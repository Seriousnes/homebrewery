// Helpers for the performance specs (web/e2e/perf, P8.1). The page's API is window.__hbPerf
// (web/src/dev/perf/perfController.ts); the types below mirror it (the e2e project can't import
// app sources).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, type Page, type TestInfo } from '@playwright/test';
import { newWorkerPage, READY_TIMEOUT } from '../pagination/harness';
import { prng, type JsonNode } from './fixtureGen';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface PaginationSummary {
  frames: number;
  steps: number;
  docSteps: number;
  stepMs: number;
  dispatchMs: number;
  settles: number;
  msPerStep: number;
  maxFrameMs: number;
  actions: Record<string, number>;
  byAction: Record<string, { n: number; stepMs: number; dispatchMs: number }>;
  slowest: { page: number; action: string; stepMs: number; dispatchMs: number }[];
}

export interface KeySample {
  key: string;
  at: number;
  handlers: number;
  frame: number;
  paint: number;
  work: number;
  settle: number | null;
  frameSteps: number;
  frameWork: number;
  dispatch: number;
  view: number;
}

export interface TypingReport {
  keys: KeySample[];
  paint: Summary;
  work: Summary;
  frame: Summary;
  handlers: Summary;
  dispatch: Summary;
  view: Summary;
  settle: Summary;
  over16: number;
  workOver16: number;
  eventTiming: { supported: boolean; keydownOver16: number; keydownOver24: number; maxKeydown: number; entries: unknown[] };
  longFrames: { startTime: number; duration: number; blockingDuration: number; scripts: { invoker: string; source: string; duration: number }[] }[];
  pagination: PaginationSummary;
}

export interface LoadReport {
  shell: 'app' | 'canvas';
  theme: string;
  pagesIn: number;
  pages: number;
  toEditor: number;
  toFirstPaint: number;
  toReady: number;
  toSettled: number;
  paginationMs: number;
  pagination: PaginationSummary;
}

export interface ThemeSwitchReport {
  from: string;
  to: string;
  pagesBefore: number;
  pages: number;
  toReady: number;
  toRepaginate: number;
  toSettled: number;
  paginationMs: number;
  repaginations: { at: number; from: number; reason: string }[];
  pagination: PaginationSummary;
}

export interface EditReport {
  settle: number;
  pages: number;
  pagination: PaginationSummary;
}

export interface CaretReport {
  page: number;
  /** index of the caret's paragraph among the page's blocks, and the headings the page starts with */
  block: number;
  leadingHeadings: number;
  kind: string;
  pos: number;
  before: string;
  after: string;
}

/** The work since the last work() call, as counts: the same on every run (perfController.ts). */
export interface WorkReport {
  /** the pagination passes, each its steps in order (a pass ends with the scheduler run that settled) */
  passes: { page: number; action: string }[][];
  /** pagination's transactions (dispatches) */
  transactions: number;
  /** REPAGINATE transactions (theme, CSS and fonts triggers) */
  repaginations: number;
  /** pages whose text or child nodes changed in the DOM (indexes now; -1: removed since) */
  mutatedPages: number[];
  /** page elements added to and removed from the editor */
  pagesAdded: number;
  pagesRemoved: number;
  pages: number;
}

export interface EnvReport {
  userAgent: string;
  hardwareConcurrency: number;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  dev: boolean;
  eventTiming: boolean;
  longAnimationFrame: boolean;
}

export interface HbPerfApi {
  mount(doc: JsonNode, opts?: { shell?: 'app' | 'canvas'; theme?: string; style?: string }): Promise<LoadReport>;
  unmount(): Promise<void>;
  settled(): boolean;
  pages(): number;
  stats(): Record<string, number> | null;
  now(): number;
  quiet(since: number, quietMs?: number): Promise<{ settledAt: number | null; frames: number; steps: number; docSteps: number }>;
  placeCaret(page: number, where?: 'middle' | 'end'): CaretReport;
  startTyping(): void;
  stopTyping(): TypingReport;
  /** Waits until `keys` keystrokes are recorded, the last one painted, and pagination has settled. */
  afterKeys(keys: number, timeoutMs?: number): Promise<void>;
  /** The work since the last call. */
  work(): WorkReport;
  insertText(text: string): Promise<EditReport>;
  setTheme(theme: string): Promise<ThemeSwitchReport>;
  frameCount(): number;
  json(): JsonNode;
  pageKinds(): string[];
  /** Indexes of the pages with a block of type `type` at their top level. */
  pagesWith(type: string): number[];
  env(): EnvReport;
  /** Debugging: page `index`'s measurement, its pull estimate, its last block and the next page's first block. */
  inspect(index: number): unknown;
  /** Debugging: the pulls pagination found pushed back whole since the last REPAGINATE (layout.ts FailedPulls). */
  failedPulls(): { last: string | null; first: string; continuation: boolean; offset: number; measured: string }[];
}

declare global {
  interface Window {
    __hbPerf: HbPerfApi;
  }
}

/** Anonymous, no notices, static themes (the API is stubbed; nothing is saved). */
export async function stubApi(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/account/me') return route.fulfill({ status: 204 });
      if (url.pathname === '/api/notifications/active') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
    },
  );
}

/** Opens /dev/perf with no document (the API is ready once window.__hbPerf exists). */
export async function openPerf(page: Page): Promise<void> {
  await stubApi(page);
  await page.goto('/dev/perf', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hbPerf !== undefined, null, { timeout: READY_TIMEOUT });
}

/**
 * Playwright's test for the smoke tests: one /dev/perf page per worker, shared by the smoke tests
 * that run in it (each mounts its own document; the mount is unmounted after the test). Loading
 * /dev/perf is most of such a test's time in Firefox; the worker's one load is kept out of the
 * tests' own time. The tests on the big fixtures take fresh pages (openPerf): their timings are reported.
 */
export const smokeTest = base.extend<object, { perfPage: Page }>({
  perfPage: [
    async ({ browser }, use, workerInfo) => {
      const page = await newWorkerPage(browser, workerInfo);
      page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
      await openPerf(page);
      await use(page);
      await page.context().close();
    },
    // One page load: its navigation (10 s) and readiness (READY_TIMEOUT) waits.
    { scope: 'worker', timeout: 20_000 },
  ],
  page: async ({ perfPage }, use) => {
    await use(perfPage);
    await perfPage.evaluate(() => window.__hbPerf.unmount()).catch(() => undefined);
  },
});

export function readFixture(name: 'perf-150' | 'perf-50'): JsonNode {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8')) as JsonNode;
}

export function writeFixture(name: string, doc: JsonNode): string {
  const file = path.join(FIXTURES_DIR, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return file;
}

/**
 * Types `text` one key at a time at a realistic rate: `meanMs` between keys (±`jitterMs`,
 * seeded), paced by the wall clock so slow key round trips don't slow the rate down.
 */
export async function typeRealistically(page: Page, text: string, opts: { meanMs?: number; jitterMs?: number; seed?: number } = {}): Promise<void> {
  const { meanMs = 110, jitterMs = 40, seed = 8101 } = opts;
  const rand = prng(seed);
  let next = Date.now();
  for (const ch of text) {
    const wait = next - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await page.keyboard.type(ch);
    next += meanMs + (rand() * 2 - 1) * jitterMs;
  }
}

/** Share (0–1) of CPU time spent busy on this machine over `ms` (all cores; the load other work puts on it). */
export async function cpuBusy(ms = 1000): Promise<number> {
  const sample = () => os.cpus().reduce((acc, c) => {
    const t = c.times;
    acc.busy += t.user + t.nice + t.sys + t.irq;
    acc.all += t.user + t.nice + t.sys + t.irq + t.idle;
    return acc;
  }, { busy: 0, all: 0 });
  const a = sample();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const b = sample();
  return b.all > a.all ? Math.round(((b.busy - a.busy) / (b.all - a.all)) * 100) / 100 : 0;
}

export interface MachineContext {
  cpus: number;
  model: string;
  /** share of CPU time busy over one second before the measurement (other processes included) */
  cpuBusy: number;
  freeMemGb: number;
  totalMemGb: number;
  /** development (Vite dev server, React development build) or production (vite build) */
  build: string;
}

/** Load context of this machine for the report (the specs run beside other work in development). */
export async function machineContext(): Promise<MachineContext> {
  const cpus = os.cpus();
  return {
    cpus: cpus.length,
    model: cpus[0]?.model.trim() ?? '',
    cpuBusy: await cpuBusy(),
    freeMemGb: Math.round((os.freemem() / 2 ** 30) * 10) / 10,
    totalMemGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    build: process.env.HB_PERF_BUILD ?? 'development',
  };
}

/**
 * Attaches a JSON result and prints a one-line summary (the numbers the notes record). With
 * HB_PERF_OUT (a file path), the result is also appended to that file as one JSON line (the line
 * reporter doesn't keep attachments).
 */
export async function record(testInfo: TestInfo, name: string, data: unknown, line: string): Promise<void> {
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
  console.log(`[perf ${testInfo.project.name}] ${name}: ${line}`);
  const out = process.env.HB_PERF_OUT;
  if (out) fs.appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), project: testInfo.project.name, name, line, data })}\n`);
}

/**
 * Types `text` at the caret one key at a time, each once pagination has settled after the key
 * before (and that key was painted): so each keystroke's work is its own, the same on every run
 * however fast the machine is (a key typed while a pass runs would join it). Keys are at least
 * `meanMs` (±`jitterMs`, seeded) apart, a person's pace, for the timings: keys sent the moment the
 * page is idle again arrive while it still produces frames, and Chromium then holds input for the
 * next frame. Returns each key's work and the recording of the keystrokes (their timings: the
 * report, never asserted).
 */
export async function typeKeyByKey(
  page: Page,
  text: string,
  opts: { meanMs?: number; jitterMs?: number; seed?: number } = {},
): Promise<{ keys: { key: string; work: WorkReport }[]; typing: TypingReport }> {
  const { meanMs = 110, jitterMs = 40, seed = 8101 } = opts;
  const rand = prng(seed);
  await page.evaluate(() => {
    window.__hbPerf.work(); // count from here
    window.__hbPerf.startTyping();
  });
  const keys: { key: string; work: WorkReport }[] = [];
  let next = Date.now();
  for (const key of text) {
    const wait = next - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    next = Date.now() + meanMs + (rand() * 2 - 1) * jitterMs;
    await page.keyboard.type(key);
    keys.push({ key, work: await page.evaluate((n) => window.__hbPerf.afterKeys(n).then(() => window.__hbPerf.work()), keys.length + 1) });
  }
  return { keys, typing: await page.evaluate(() => window.__hbPerf.stopTyping()) };
}
