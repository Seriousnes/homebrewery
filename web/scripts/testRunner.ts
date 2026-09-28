// Shared support for the end-to-end runner scripts (web/e2e/**/run-*.mjs, scripts/fidelity-run.ts,
// scripts/welcome-doc.ts): fail-fast process handling (CLAUDE.md "Tests fail fast").
//
//   - Playwright runs under a no-progress watchdog. The progress reporter (scripts/progressReporter.ts,
//     attached through PW_TEST_REPORTER) reports every test and step over IPC. When nothing moves for
//     LIMITS.stallMs (60 s) and no running test is still inside its own timeout, the whole Playwright
//     process tree (runner, workers, browsers) is killed and the tests that were running are printed.
//   - Server start-up is capped: the API must answer /healthz within 60 s of `dotnet run --no-build`
//     (it is built first, as its own step), Vite within 30 s.
//   - Builds (dotnet build, vite build) are killed when they print nothing for 2 minutes.
//   - Every child process is killed by process tree on exit, on SIGINT/SIGTERM and on errors; a
//     detached reaper (scripts/processReaper.ts) kills them when the runner itself is killed hard.
//   - Worktrees never share a run's servers or data: the default ports,
//     temp folders and database container names carry the worktree's slot (scripts/worktree.ts), and
//     every run that needs PostgreSQL starts a throwaway one of its own (startDatabase).
//
// Plain erasable TypeScript: the .mjs runners import it directly (Node 24 strips the types).
import { type ChildProcess, spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerSlug, MAX_SLOT, slotTmp, worktreeInfo } from './worktree.ts';

export const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(webDir, '..');
export const playwrightCli = path.join(webDir, 'node_modules', '@playwright', 'test', 'cli.js');
export const viteBin = path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
export const progressReporter = path.join(webDir, 'scripts', 'progressReporter.ts');
const reaperScript = path.join(webDir, 'scripts', 'processReaper.ts');

const envMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** The fail-fast limits. The HB_* variables exist to test the watchdog itself. */
export const LIMITS = {
  /** No test began, finished or took a step for this long: the run is stuck. The same for every test. */
  stallMs: envMs('HB_STALL_MS', 60_000),
  /** A running test may take its own declared timeout plus this (teardown after a timeout). */
  graceMs: envMs('HB_STALL_GRACE_MS', 30_000),
  /** Before the first test: config, global setup and Playwright's own webServer (60 s cap). */
  startupMs: envMs('HB_STARTUP_MS', 90_000),
  apiReadyMs: 60_000,
  viteReadyMs: 30_000,
  /** A throwaway PostgreSQL container (startDatabase) must accept connections within this. */
  dbReadyMs: 60_000,
  /** A build (dotnet build, vite build) that prints nothing for this long. */
  buildQuietMs: 120_000,
  /** And a build that takes longer than this in total. */
  buildMaxMs: 10 * 60_000,
};

export const HUMAN_PORTS = ['5080', '5173', '8080'];

/** A port of a person's stack: the host-run API and Vite, or a dev stack's port (8080 + worktree slot, deploy/stack). */
export function isHumanPort(port: string | number): boolean {
  const n = Number(port);
  return HUMAN_PORTS.includes(String(n)) || (n >= 8080 && n <= 8080 + MAX_SLOT);
}

// ---------------------------------------------------------------------------------------------
// The watchdog (pure: the clock is passed in; unit-tested in testRunner.test.ts)

/** What scripts/progressReporter.ts sends over IPC. */
export type ProgressEvent =
  | { type: 'hello' }
  | { type: 'begin'; total: number }
  | { type: 'testBegin'; id: string; title: string; location: string; project: string; timeout: number; retry: number; tags: string[] }
  | { type: 'step'; id: string; title: string; open: boolean }
  | { type: 'testEnd'; id: string; status: string; duration: number }
  | { type: 'end'; status: string };

export interface RunningTest {
  id: string;
  title: string;
  location: string;
  project: string;
  timeout: number;
  retry: number;
  startedAt: number;
  /** Open steps, innermost last. */
  steps: string[];
}

export interface Stall {
  idleMs: number;
  limitMs: number;
  running: RunningTest[];
  message: string;
}

/** A test that ended (one attempt: a retry is its own entry). */
export interface FinishedTest {
  title: string;
  location: string;
  project: string;
  retry: number;
  status: string;
  /** Playwright's own duration of the attempt (ms). */
  duration: number;
}

export interface WatchdogOptions {
  stallMs?: number;
  graceMs?: number;
  startupMs?: number;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/**
 * Tracks a Playwright run's progress and says when it is stuck. Progress is any test beginning or
 * ending and any step beginning or ending (a test that keeps interacting is alive). The run is
 * stalled when, at `now`:
 *   - nothing progressed for `stallMs` (`startupMs` before the run began), and
 *   - no running test is still inside its declared timeout plus `graceMs` (Playwright ends such a
 *     test itself; the watchdog is for the hangs Playwright can't end: a blocked worker, a stuck
 *     teardown, a browser that never closes, a stuck runner).
 */
export class ProgressWatchdog {
  readonly stallMs: number;
  readonly graceMs: number;
  readonly startupMs: number;
  readonly running = new Map<string, RunningTest>();
  began = false;
  /** The reporter said hello: PW_TEST_REPORTER works with this Playwright. */
  connected = false;
  total: number | null = null;
  finished = 0;
  lastProgress: number;
  lastFinished: { title: string; status: string; at: number } | null = null;
  /** Every test that ended, in order (the runner's timing summary). */
  readonly results: FinishedTest[] = [];

  constructor(now: number, options: WatchdogOptions = {}) {
    this.stallMs = options.stallMs ?? LIMITS.stallMs;
    this.graceMs = options.graceMs ?? LIMITS.graceMs;
    this.startupMs = options.startupMs ?? LIMITS.startupMs;
    this.lastProgress = now;
  }

  event(e: ProgressEvent, now: number): void {
    switch (e.type) {
      case 'hello':
        this.connected = true;
        break;
      case 'begin':
        this.began = true;
        this.total = e.total;
        break;
      case 'testBegin':
        this.began = true;
        this.running.set(e.id, {
          id: e.id,
          title: e.title,
          location: e.location,
          project: e.project,
          timeout: e.timeout,
          retry: e.retry,
          startedAt: now,
          steps: [],
        });
        break;
      case 'step': {
        const test = this.running.get(e.id);
        if (test) {
          if (e.open) test.steps.push(e.title);
          else {
            const i = test.steps.lastIndexOf(e.title);
            if (i >= 0) test.steps.splice(i, 1);
          }
        }
        break;
      }
      case 'testEnd': {
        const test = this.running.get(e.id);
        this.running.delete(e.id);
        this.finished += 1;
        this.lastFinished = { title: test ? describeTest(test) : e.id, status: e.status, at: now };
        if (test) this.results.push({ title: test.title, location: test.location, project: test.project, retry: test.retry, status: e.status, duration: e.duration });
        break;
      }
      case 'end':
        break;
    }
    this.lastProgress = now;
  }

  /** How long the run may go without progress: start-up, or the one window for every test. */
  private window(): number {
    return this.began ? this.stallMs : this.startupMs;
  }

  /** The moment the run counts as stalled, given what is known now. */
  deadline(): number {
    let deadline = this.lastProgress + this.window();
    for (const test of this.running.values()) deadline = Math.max(deadline, test.startedAt + test.timeout + this.graceMs);
    return deadline;
  }

  check(now: number): Stall | null {
    const deadline = this.deadline();
    if (now < deadline) return null;
    const idleMs = now - this.lastProgress;
    const running = [...this.running.values()].sort((a, b) => a.startedAt - b.startedAt);
    const limitMs = this.window();
    const extendedMs = deadline - this.lastProgress > limitMs ? deadline - this.lastProgress : null;
    return { idleMs, limitMs, running, message: this.describe(now, idleMs, limitMs, extendedMs, running) };
  }

  private describe(now: number, idleMs: number, limitMs: number, extendedMs: number | null, running: RunningTest[]): string {
    const lines: string[] = [];
    const limit = `limit ${seconds(limitMs)}${extendedMs ? `, ${seconds(extendedMs)} here: a running test's timeout plus ${seconds(this.graceMs)}` : ''}`;
    if (!this.began) {
      lines.push(`STALLED: Playwright started no test in ${seconds(idleMs)} (${limit}): stuck loading the config, in global setup or starting its web server.`);
      if (!this.connected) {
        lines.push('The progress reporter never said hello: if every run ends here, check that this Playwright still loads PW_TEST_REPORTER (scripts/progressReporter.ts).');
      }
    } else {
      lines.push(`STALLED: no test began, finished or took a step for ${seconds(idleMs)} (${limit}).`);
    }
    if (running.length) {
      lines.push(`Running when it stalled (${running.length}):`);
      for (const test of running) {
        const step = test.steps.at(-1);
        lines.push(
          `  ${describeTest(test)}  — running ${seconds(now - test.startedAt)}, timeout ${test.timeout ? seconds(test.timeout) : 'none'}` +
            (step ? `, in step "${step}"` : ', in no step (test code, a hook or a fixture)'),
        );
      }
    } else if (this.began) {
      lines.push('No test was running: stuck between tests (worker start-up, teardown) or after the last one (reporters, global teardown).');
    }
    if (this.lastFinished) lines.push(`Last finished: ${this.lastFinished.title} (${this.lastFinished.status}) ${seconds(now - this.lastFinished.at)} ago.`);
    lines.push(`${this.finished}${this.total !== null ? ` of ${this.total}` : ''} tests finished.`);
    return lines.join('\n');
  }
}

export function describeTest(test: Pick<RunningTest, 'project' | 'location' | 'title' | 'retry'>): string {
  return `[${test.project}] ${test.location} › ${test.title}${test.retry ? ` (retry #${test.retry})` : ''}`;
}

/**
 * A run's timing in a few lines: its wall time, the test time per project (what a CI shard of that
 * project costs, divided by its workers) and the slowest tests, to find what to split or speed up.
 */
export function summarize(results: readonly FinishedTest[], wallMs: number, slowest = 5): string {
  const statuses = new Map<string, number>();
  const perProject = new Map<string, number>();
  for (const r of results) {
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    perProject.set(r.project, (perProject.get(r.project) ?? 0) + r.duration);
  }
  const counts = [...statuses].map(([status, n]) => `${n} ${status}`).join(', ');
  const lines = [`${results.length} tests${counts ? ` (${counts})` : ''} in ${seconds(wallMs)}`];
  if (perProject.size) lines.push(`test time per project: ${[...perProject].map(([project, ms]) => `${project} ${seconds(ms)}`).join(', ')}`);
  const top = [...results].sort((a, b) => b.duration - a.duration).slice(0, slowest);
  if (top.length) {
    lines.push(`slowest ${top.length}:`);
    for (const r of top) lines.push(`  ${(r.duration / 1000).toFixed(1)} s  ${describeTest(r)} (${r.status})`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Process trees

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Every descendant of `pid` (POSIX; children before grandchildren). */
function descendants(pid: number): number[] {
  const parents = new Map<number, number[]>();
  const add = (child: number, parent: number) => {
    if (!parents.has(parent)) parents.set(parent, []);
    parents.get(parent)!.push(child);
  };
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        // "pid (comm) state ppid …": comm may contain spaces and parentheses.
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        add(Number(entry), ppid);
      } catch {
        // gone meanwhile
      }
    }
  } else {
    const ps = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' });
    for (const line of (ps.stdout ?? '').split('\n')) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (child && parent !== undefined) add(child, parent);
    }
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    for (const child of parents.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * Kills `pid` and everything it started, at once (no grace). Windows: taskkill /T /F. POSIX: the
 * descendants are collected first (browsers run in their own process groups), then SIGKILLed.
 */
export function killTreeSync(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  for (const p of [pid, ...descendants(pid)]) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Runs `docker <args>` to completion (30 s at most); `output` is stdout and stderr, trimmed. */
export function dockerSync(args: string[]): { status: number; output: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { status: result.error ? 1 : (result.status ?? 1), output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** Removes a container (running or not) if it exists. */
export function removeContainerSync(name: string): void {
  dockerSync(['rm', '-f', '-v', name]);
}

/** Stops a process tree: SIGTERM first on POSIX, SIGKILL after `graceMs`; Windows kills at once. */
export async function stopTree(pid: number | undefined, graceMs = 3000): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') return killTreeSync(pid);
  const tree = [pid, ...descendants(pid)];
  for (const p of tree) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && tree.some(alive)) await sleep(100);
  for (const p of tree.filter(alive)) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Readiness

/**
 * Whether `url` answers 2xx within `timeoutMs`. `localhost` is tried as 127.0.0.1 and [::1] too: in
 * the Playwright Linux image Node resolves localhost to ::1 first and fetch doesn't fall back, while
 * Vite listens on 127.0.0.1 only (browsers and curl try both).
 */
export async function answers(url: string, timeoutMs = 3000): Promise<boolean> {
  const u = new URL(url);
  const hosts = u.hostname === 'localhost' ? ['localhost', '127.0.0.1', '[::1]'] : [u.hostname];
  for (const host of hosts) {
    try {
      u.hostname = host;
      const response = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      if (response.ok) return true;
    } catch {
      // not this address (or no answer in time)
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The runner

export interface ServerOptions {
  /** Shown in messages: "API", "Vite dev server" … */
  name: string;
  /** Ready when this answers 2xx. */
  url: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readyMs: number;
  /** Reuse a server that already answers on `url` (default true). */
  reuse?: boolean;
}

export interface ApiOptions {
  port: string;
  /** Database name (created by the API's migrations). */
  database: string;
  /** dotnet --artifacts-path (default <tmp>/hb-artifacts-<runner name>). */
  artifacts?: string;
  /** Debug (default) or Release. */
  configuration?: string;
  /** Skip `dotnet build` (HB_API_NO_BUILD=1: built before with the same artifacts path and configuration). */
  noBuild?: boolean;
  environment?: string;
  /** An existing PostgreSQL (default HB_E2E_DB_HOST / HB_E2E_DB_PORT); without one the run starts its own. */
  dbHost?: string;
  dbPort?: string;
  env?: NodeJS.ProcessEnv;
  reuse?: boolean;
}

export interface DatabaseOptions {
  /** Container name suffix (default: the runner's name). */
  name?: string;
}

export interface Database {
  host: string;
  port: string;
  /** The container this runner started (removed on exit), or null for an external server. */
  container: string | null;
}

export interface ViteOptions {
  port: string;
  /** --config (relative to web/). */
  config?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  name?: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill it when it prints nothing for this long (default LIMITS.buildQuietMs). */
  quietMs?: number;
  /** Kill it when it takes longer than this (default LIMITS.buildMaxMs). */
  maxMs?: number;
}

export interface PlaywrightResult {
  status: number;
  stalled: boolean;
  /** Wall time of the run (ms). */
  ms: number;
  /** Every test attempt that ended, as the progress reporter saw it (empty in an interactive run). */
  tests: FinishedTest[];
}

/** Exit status of a run the watchdog killed (as timeout(1)). */
export const STALLED_STATUS = 124;

export class TestRunner {
  readonly name: string;
  private readonly children = new Set<ChildProcess>();
  private readonly containers = new Set<string>();
  private reaper: ChildProcess | null = null;
  private exiting = false;

  constructor(name: string) {
    this.name = name;
    const hardStop = (signal: string, code: number) => () => {
      if (this.exiting) return;
      this.exiting = true;
      this.error(`${signal}: stopping everything this runner started.`);
      this.killAllSync();
      process.exit(code);
    };
    process.on('SIGINT', hardStop('SIGINT', 130));
    process.on('SIGTERM', hardStop('SIGTERM', 143));
    if (process.platform !== 'win32') process.on('SIGHUP', hardStop('SIGHUP', 129));
    process.on('uncaughtException', (error) => {
      this.error(`unexpected error: ${error.stack ?? error.message}`);
      this.killAllSync();
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      this.error(`unexpected error: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
      this.killAllSync();
      process.exit(1);
    });
    // Last resort (process.exit from anywhere): synchronous kills only.
    process.on('exit', () => this.killAllSync());
  }

  log(message: string): void {
    console.log(`[${this.name}] ${message}`);
  }

  error(message: string): void {
    console.error(`[${this.name}] ${message}`);
  }

  refuseHumanPorts(...ports: string[]): void {
    if (ports.some((p) => isHumanPort(p))) {
      this.error(`Refusing to use a port humans use (5080, 5173, the dev stacks' 8080-${8080 + MAX_SLOT}).`);
      process.exit(2);
    }
  }

  /** Spawns a child that is killed (as a tree) with the runner. */
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
    const child = spawn(command, args, { windowsHide: true, ...options });
    this.children.add(child);
    child.once('exit', () => {
      this.children.delete(child);
      if (this.reaper?.connected) this.reaper.send({ remove: child.pid });
    });
    // A command that can't start (not installed): the caller sees it exit.
    child.on('error', (error) => this.error(`${command}: ${error.message}`));
    if (child.pid) this.watchWithReaper(child.pid);
    return child;
  }

  /**
   * The reaper outlives a runner that is killed hard (TerminateProcess, SIGKILL, a tool timeout)
   * and then kills the process trees registered here.
   */
  private watchWithReaper(pid: number | undefined): void {
    if (!this.reaper) {
      try {
        this.reaper = spawn(process.execPath, [reaperScript, String(process.pid)], {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        });
        this.reaper.unref();
        this.reaper.channel?.unref();
        this.reaper.on('error', () => (this.reaper = null));
      } catch {
        this.reaper = null;
      }
    }
    if (pid && this.reaper?.connected) this.reaper.send({ add: pid });
  }

  /** Kills every child tree and removes every container now (exit, signals, errors). */
  killAllSync(): void {
    for (const child of this.children) if (child.exitCode === null && child.signalCode === null) killTreeSync(child.pid);
    this.children.clear();
    for (const name of this.containers) removeContainerSync(name);
    this.containers.clear();
    if (this.reaper?.connected) {
      try {
        this.reaper.send({ done: true });
        this.reaper.disconnect();
      } catch {
        // gone
      }
    }
    this.reaper = null;
  }

  /** Stops one child (tree), gracefully where the platform allows. */
  async stop(child: ChildProcess | null | undefined): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await stopTree(child.pid);
    this.children.delete(child);
  }

  /** Stops every child, then tells the reaper it is done. */
  async cleanup(): Promise<void> {
    for (const child of [...this.children].reverse()) await this.stop(child);
    this.killAllSync();
  }

  /** Cleans up, then exits with `status`. */
  async exit(status: number): Promise<never> {
    this.exiting = true;
    await this.cleanup();
    process.exit(status);
  }

  /**
   * Starts a server and waits (at most `readyMs`) until `url` answers; reuses one that already
   * does. Its output is kept (last 20 kB) and printed when it fails to start or dies mid-run.
   */
  async startServer(options: ServerOptions): Promise<ChildProcess | null> {
    const { name, url, readyMs } = options;
    if (options.reuse !== false && (await answers(url))) {
      this.log(`using the ${name} already running at ${url}`);
      return null;
    }
    this.log(`starting the ${name} (${url}; must answer within ${seconds(readyMs)})…`);
    const started = Date.now();
    const child = this.spawn(options.command, options.args, { cwd: options.cwd ?? webDir, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const keep = (chunk: Buffer) => (log = (log + chunk.toString()).slice(-20_000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let ready = false;
    child.once('exit', (code, signal) => {
      if (ready && !this.exiting) this.error(`the ${name} exited during the run (${signal ?? `code ${code}`}). Its last output:\n${log.slice(-4000)}`);
    });
    let spawnError: Error | null = null;
    child.once('error', (error) => (spawnError = error));
    const deadline = started + readyMs;
    for (;;) {
      if (spawnError) throw new Error(`the ${name} could not start: ${(spawnError as Error).message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`the ${name} exited before it answered ${url} (${child.signalCode ?? `code ${child.exitCode}`}). Its output:\n${log}`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        await this.stop(child);
        throw new Error(`the ${name} did not answer ${url} within ${seconds(readyMs)} (stopped it). Its output:\n${log}`);
      }
      if (await answers(url, Math.min(3000, left))) break;
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
    ready = true;
    this.log(`${name} ready after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return child;
  }

  /**
   * The PostgreSQL for this run. With HB_E2E_DB_HOST (CI's service container) that server
   * (HB_E2E_DB_PORT, default 5432); otherwise a throwaway postgres:18 container of this runner,
   * hb-test-<slot>-<name>: data in tmpfs, durability off, published on a free loopback port, removed
   * on exit (and by the reaper when the runner is killed hard; a leftover of a killed run is replaced).
   * No other worktree's run, and not the dev stacks' shared database, is ever touched.
   */
  async startDatabase(options: DatabaseOptions = {}): Promise<Database> {
    if (process.env.HB_E2E_DB_HOST) {
      return { host: process.env.HB_E2E_DB_HOST, port: process.env.HB_E2E_DB_PORT ?? '5432', container: null };
    }
    const name = `hb-test-${worktreeInfo().slot}-${dockerSlug(options.name ?? this.name)}`;
    const started = Date.now();
    this.log(`starting PostgreSQL (container ${name}; must accept connections within ${seconds(LIMITS.dbReadyMs)})…`);
    removeContainerSync(name);
    const run = dockerSync([
      'run', '-d', '--rm', '--name', name,
      '--label', `hb.test-runner=${this.name}`,
      '-e', 'POSTGRES_USER=homebrewery', '-e', 'POSTGRES_PASSWORD=homebrewery', '-e', 'POSTGRES_DB=homebrewery',
      '-p', '127.0.0.1::5432',
      '--tmpfs', '/var/lib/postgresql',
      'postgres:18',
      '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
    ]);
    if (run.status !== 0) throw new Error(`PostgreSQL could not start (docker run: ${run.output || 'is Docker running?'})`);
    this.containers.add(name);
    this.watchContainerWithReaper(name);
    const deadline = started + LIMITS.dbReadyMs;
    // pg_isready over TCP: the image's first-start initialisation listens on the socket only.
    while (dockerSync(['exec', name, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'homebrewery', '-d', 'homebrewery']).status !== 0) {
      if (Date.now() > deadline) {
        const logs = dockerSync(['logs', '--tail', '40', name]).output;
        throw new Error(`PostgreSQL (${name}) did not accept connections within ${seconds(LIMITS.dbReadyMs)}. Its log:\n${logs}`);
      }
      await sleep(250);
    }
    const port = /:(\d+)\s*$/m.exec(dockerSync(['port', name, '5432/tcp']).output)?.[1];
    if (!port) throw new Error(`could not read the port of ${name}`);
    this.log(`PostgreSQL ready after ${((Date.now() - started) / 1000).toFixed(1)} s (localhost:${port})`);
    return { host: 'localhost', port, container: name };
  }

  private watchContainerWithReaper(name: string): void {
    this.watchWithReaper(undefined);
    if (this.reaper?.connected) this.reaper.send({ container: name });
  }

  /**
   * Builds (unless noBuild), then runs src/Homebrewery.Api on `port`; ready = /healthz answers.
   * Its database is on `dbHost` (or HB_E2E_DB_HOST) when given, otherwise on a throwaway
   * PostgreSQL of this run (startDatabase, container hb-test-<slot>-<runner>-<port>: two runs of one runner on
   * different API ports keep their own). An API already answering on the port is reused only
   * with an external database server: with a throwaway one it would belong to an earlier run's.
   */
  async startApi(options: ApiOptions): Promise<{ child: ChildProcess | null; url: string }> {
    const url = `http://localhost:${options.port}`;
    const configuration = options.configuration ?? 'Debug';
    const artifacts = options.artifacts ?? slotTmp(`hb-artifacts-${this.name}`);
    const dbHost = options.dbHost ?? process.env.HB_E2E_DB_HOST;
    if (dbHost && options.reuse !== false && (await answers(`${url}/healthz`))) {
      this.log(`using the API already running at ${url}`);
      return { child: null, url };
    }
    if (!dbHost && (await answers(`${url}/healthz`))) {
      throw new Error(`something already answers on ${url}; stop it first (this run's API needs the port)`);
    }
    const db = dbHost ? { host: dbHost, port: options.dbPort ?? process.env.HB_E2E_DB_PORT ?? '5432' } : await this.startDatabase({ name: `${this.name}-${options.port}` });
    if (!options.noBuild) {
      await this.runCommand('dotnet build', 'dotnet', ['build', 'src/Homebrewery.Api', '--configuration', configuration, '--artifacts-path', artifacts, '--nologo'], {
        cwd: repoRoot,
      });
    }
    const child = await this.startServer({
      name: 'API',
      url: `${url}/healthz`,
      command: 'dotnet',
      args: ['run', '--project', 'src/Homebrewery.Api', '--no-build', '--no-launch-profile', '--configuration', configuration, '--artifacts-path', artifacts, '--urls', url],
      cwd: repoRoot,
      readyMs: LIMITS.apiReadyMs,
      reuse: false,
      env: {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: options.environment ?? 'Development',
        ConnectionStrings__Homebrewery: `Host=${db.host};Port=${db.port};Database=${options.database};Username=homebrewery;Password=homebrewery`,
        Database__MigrateOnStartup: 'true',
        ...options.env,
      },
    });
    return { child, url };
  }

  /** Vite (dev server by default) on `port`; ready = / answers, within LIMITS.viteReadyMs. */
  async startVite(options: ViteOptions): Promise<{ child: ChildProcess | null; url: string }> {
    const url = `http://localhost:${options.port}`;
    const args = options.args ?? [...(options.config ? ['--config', options.config] : []), '--port', options.port, '--strictPort'];
    const child = await this.startServer({
      name: options.name ?? 'Vite dev server',
      url: `${url}/`,
      command: process.execPath,
      args: [viteBin, ...args],
      cwd: webDir,
      env: { ...process.env, ...options.env },
      readyMs: LIMITS.viteReadyMs,
    });
    return { child, url };
  }

  /**
   * Runs a command to completion (builds): its output is shown; it is killed when it prints nothing
   * for `quietMs` or runs longer than `maxMs`. Throws when it fails.
   */
  async runCommand(label: string, command: string, args: string[], options: CommandOptions = {}): Promise<void> {
    const quietMs = options.quietMs ?? LIMITS.buildQuietMs;
    const maxMs = options.maxMs ?? LIMITS.buildMaxMs;
    this.log(`${label}…`);
    const started = Date.now();
    const child = this.spawn(command, args, { cwd: options.cwd ?? webDir, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let lastOutput = Date.now();
    const echo = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      lastOutput = Date.now();
      stream.write(chunk);
    };
    child.stdout?.on('data', echo(process.stdout));
    child.stderr?.on('data', echo(process.stderr));
    const stopped: { reason: string | null } = { reason: null };
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - lastOutput > quietMs) stopped.reason = `it printed nothing for ${seconds(now - lastOutput)} (limit ${seconds(quietMs)})`;
      else if (now - started > maxMs) stopped.reason = `it ran for ${seconds(now - started)} (limit ${seconds(maxMs)})`;
      if (stopped.reason) {
        clearInterval(timer);
        killTreeSync(child.pid);
      }
    }, 1000);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once('exit', (c, s) => resolve([c, s]));
      child.once('error', () => resolve([1, null]));
    });
    clearInterval(timer);
    if (stopped.reason) throw new Error(`${label} was stopped: ${stopped.reason}.`);
    if (code !== 0) throw new Error(`${label} failed (${signal ?? `exit code ${code}`}).`);
    this.log(`${label} done after ${seconds(Date.now() - started)}`);
  }

  /**
   * `playwright test <args>` under the no-progress watchdog (see ProgressWatchdog). Output goes
   * straight to this terminal. Resolves with the exit status (STALLED_STATUS when the watchdog
   * killed the run).
   */
  async runPlaywright(args: string[], options: { env?: NodeJS.ProcessEnv; watchdog?: WatchdogOptions } = {}): Promise<PlaywrightResult> {
    this.log(`playwright test ${args.join(' ')}`);
    const started = Date.now();
    const env = { ...process.env, ...options.env };
    if (isInteractive(args, env)) {
      // UI mode, the inspector or a paused test wait for a person, not for progress: no watchdog.
      this.log('interactive run (--ui, --debug or PWDEBUG): no watchdog.');
      const child = this.spawn(process.execPath, [playwrightCli, 'test', ...args], { cwd: webDir, stdio: 'inherit', env });
      const code = await new Promise<number>((resolve) => {
        child.once('exit', (c) => resolve(c ?? 1));
        child.once('error', () => resolve(1));
      });
      return { status: code, stalled: false, ms: Date.now() - started, tests: [] };
    }
    const child = this.spawn(process.execPath, [playwrightCli, 'test', ...args], {
      cwd: webDir,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...env, PW_TEST_REPORTER: progressReporter },
    });
    const result = await supervise(child, {
      watchdog: options.watchdog,
      onEvent: process.env.HB_WATCHDOG_DEBUG === '1' ? (event) => this.log(`progress: ${JSON.stringify(event)}`) : undefined,
      onStall: (stall) => {
        this.error(stall.message.split('\n').join(`\n[${this.name}] `));
        this.error(`Killing the Playwright run (pid ${child.pid}) with its workers and browsers.`);
      },
    });
    const ms = Date.now() - started;
    // HB_SLOWEST=<n>: list the n slowest tests (default 5).
    this.log(summarize(result.tests, ms, Number(process.env.HB_SLOWEST) || 5).split('\n').join(`\n[${this.name}] `));
    if (result.stall) return { status: STALLED_STATUS, stalled: true, ms, tests: result.tests };
    return { status: result.code ?? 1, stalled: false, ms, tests: result.tests };
  }

  /**
   * Runs a big run as several short Playwright invocations ("sets"), one after the other, each
   * under the 5-minute cap (playwright.config.ts globalTimeout) and the watchdog. Fails fast: stops
   * at the first set that fails. Then prints each set's wall time. `afterSet` runs after each set
   * (e.g. to keep its results before the next set's run empties an output folder).
   */
  async runSets(
    sets: readonly PlaywrightSet[],
    options: { env?: NodeJS.ProcessEnv; afterSet?: (result: SetResult) => void | Promise<void> } = {},
  ): Promise<{ status: number; stalled: boolean; sets: SetResult[] }> {
    const done: SetResult[] = [];
    for (const [i, set] of sets.entries()) {
      this.log(`set ${i + 1}/${sets.length}: ${set.name}`);
      const result: SetResult = { name: set.name, ...(await this.runPlaywright(set.args, { env: { ...options.env, ...set.env } })) };
      done.push(result);
      await options.afterSet?.(result);
      if (result.status !== 0) break;
    }
    this.log(describeSets(done, sets).split('\n').join(`\n[${this.name}] `));
    const failed = done.find((r) => r.status !== 0);
    return { status: failed?.status ?? 0, stalled: failed?.stalled ?? false, sets: done };
  }
}

/** One Playwright invocation of a run made of several (TestRunner.runSets). */
export interface PlaywrightSet {
  name: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SetResult extends PlaywrightResult {
  name: string;
}

/** `--set=<n>[,<n>…]` on a runner's command line: the set numbers (from 1), and the other arguments. */
export function takeSetArg(argv: readonly string[]): { only: number[] | null; args: string[] } {
  const setArg = argv.find((a) => a.startsWith('--set='));
  return { only: setArg ? setArg.slice('--set='.length).split(',').map(Number) : null, args: argv.filter((a) => a !== setArg) };
}

/** The sets `only` names (all without it); throws, listing the sets, on a number that names none. */
export function pickSets<T extends Pick<PlaywrightSet, 'name'>>(sets: readonly T[], only: readonly number[] | null): T[] {
  if (!only) return [...sets];
  if (only.some((n) => !Number.isInteger(n) || n < 1 || n > sets.length)) {
    throw new Error(`--set takes set numbers from 1 to ${sets.length}: ${sets.map((s, i) => `${i + 1} = ${s.name}`).join('; ')}`);
  }
  return sets.filter((_, i) => only.includes(i + 1));
}

/** A set that took longer than this is close to the 5-minute cap: split it. */
export const SET_WARN_MS = 4 * 60_000;

/** Each set's wall time and outcome, and the sets a failure kept from running. */
export function describeSets(done: readonly SetResult[], sets: readonly Pick<PlaywrightSet, 'name'>[]): string {
  const lines = ['sets:'];
  for (const r of done) {
    const outcome = r.status === 0 ? 'passed' : r.stalled ? 'stalled' : `failed (exit ${r.status})`;
    const warning = r.ms > SET_WARN_MS ? ` — over ${seconds(SET_WARN_MS)}, close to the 5-minute cap: split this set` : '';
    lines.push(`  ${r.name}: ${seconds(r.ms)}, ${r.tests.length} tests, ${outcome}${warning}`);
  }
  const notRun = sets.slice(done.length);
  if (notRun.length) lines.push(`  not run (an earlier set failed): ${notRun.map((s) => s.name).join(', ')}`);
  lines.push(`  total ${seconds(done.reduce((ms, r) => ms + r.ms, 0))}`);
  return lines.join('\n');
}

/** A run that waits for a person (UI mode, the inspector, --debug): the watchdog stays out of it. */
export function isInteractive(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PWDEBUG) || args.some((a) => /^--(ui|ui-host|ui-port|debug)(=|$)/.test(a));
}

export interface SuperviseOptions {
  watchdog?: WatchdogOptions;
  /** How often the watchdog looks (default 1 s). */
  checkEveryMs?: number;
  /** Called once, right before the child's process tree is killed. */
  onStall?: (stall: Stall) => void;
  /** Every progress event as it arrives (HB_WATCHDOG_DEBUG=1 prints them). */
  onEvent?: (event: ProgressEvent) => void;
}

/**
 * Watches a child that reports ProgressEvents over IPC (Playwright with scripts/progressReporter.ts)
 * until it exits, and kills its whole process tree when the watchdog says it stalled.
 */
export async function supervise(
  child: ChildProcess,
  options: SuperviseOptions = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stall: Stall | null; tests: FinishedTest[] }> {
  const watchdog = new ProgressWatchdog(Date.now(), options.watchdog);
  child.on('message', (message) => {
    watchdog.event(message as ProgressEvent, Date.now());
    options.onEvent?.(message as ProgressEvent);
  });
  let stall: Stall | null = null;
  const timer = setInterval(() => {
    stall = watchdog.check(Date.now());
    if (!stall) return;
    clearInterval(timer);
    options.onStall?.(stall);
    killTreeSync(child.pid);
  }, options.checkEveryMs ?? 1000);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve([child.exitCode, child.signalCode]);
    child.once('exit', (c, s) => resolve([c, s]));
    child.once('error', () => resolve([1, null]));
  });
  clearInterval(timer);
  return { code, signal, stall, tests: watchdog.results };
}
