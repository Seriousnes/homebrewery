#!/usr/bin/env node
// Everything CI checks except the e2e jobs, the same commands as .github/workflows/ci.yml, so a
// green run here means the "Web (lint, typecheck, schema, build)", "Web unit tests" and ".NET"
// jobs pass (CLAUDE.md "Tests"). Run it before every push.
//
//   pnpm -C web run verify              all three lanes (about 2 minutes)
//   pnpm -C web run verify web unit     some of them (web, unit, dotnet)
//
// The lanes run in parallel, each step in order and stopping at its lane's first failure, like
// the CI jobs. A step's output is printed only when it fails. Every step is capped at 5 minutes
// and killed when it prints nothing for 2 (CLAUDE.md "Tests fail fast"). CI=true, as in CI.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { killTreeSync, repoRoot, TestRunner, webDir } from './testRunner.ts';

// The build writes to a folder of its own, not the API's wwwroot: the dotnet lane's Release build
// compresses the files in wwwroot while it runs, and a build emptying it meanwhile fails that
// build (CI runs the two jobs on separate machines).
const BUILD_OUT = path.join(repoRoot, '.artifacts', 'verify-wwwroot');

const LANES = {
  web: [
    ['lint', 'pnpm run lint', webDir],
    ['typecheck', 'pnpm run typecheck', webDir],
    ['schema manifest', 'pnpm run schema --check', webDir],
    ['build', `pnpm run build --outDir "${BUILD_OUT}" --emptyOutDir`, webDir],
  ],
  unit: [['unit tests', 'pnpm test', webDir]],
  dotnet: [
    ['dotnet build (Release, warnings as errors)', 'dotnet build Homebrewery.slnx --configuration Release', repoRoot],
    // Microsoft.Testing.Platform prints little until the end: only the 5-minute cap applies (the test app has its own).
    ['dotnet test', 'dotnet test --solution Homebrewery.slnx --no-build --configuration Release', repoRoot, { quiet: false }],
  ],
};
const STEP_MAX_MS = 5 * 60_000;
const STEP_QUIET_MS = 2 * 60_000;
const TAIL_BYTES = 40_000;

const runner = new TestRunner('verify');
const named = process.argv.slice(2).flatMap((a) => a.split(','));
const lanes = named.length ? named : Object.keys(LANES);
const unknown = lanes.filter((lane) => !(lane in LANES));
if (unknown.length) {
  runner.error(`unknown lane ${unknown.join(', ')} (lanes: ${Object.keys(LANES).join(', ')})`);
  process.exit(2);
}

// CI installs exactly pnpm-lock.yaml: other dependencies lint and build differently. pnpm checks
// node_modules against the lockfile before it runs anything (verifyDepsBeforeRun in
// pnpm-workspace.yaml); once here, so a stale install fails before the lanes start.
const deps = spawnSync('pnpm exec node -e 0', { cwd: webDir, shell: true, encoding: 'utf8' });
if (deps.status !== 0) {
  runner.error(`web/node_modules doesn't match pnpm-lock.yaml: run \`pnpm -C web install\` first.\n${deps.stdout}${deps.stderr}`);
  process.exit(2);
}

const seconds = (ms) => `${Math.round(ms / 1000)} s`;

/** Runs one step with its output kept; resolves with null or the reason it failed. */
function runStep(label, command, cwd, { quiet = true } = {}) {
  const started = Date.now();
  const child = runner.spawn(command, [], { cwd, shell: true, env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let lastOutput = Date.now();
  const keep = (chunk) => {
    lastOutput = Date.now();
    output = (output + chunk.toString()).slice(-TAIL_BYTES);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let stopped = null;
  const timer = setInterval(() => {
    const now = Date.now();
    if (quiet && now - lastOutput > STEP_QUIET_MS) stopped = `printed nothing for ${seconds(now - lastOutput)}`;
    else if (now - started > STEP_MAX_MS) stopped = `ran for ${seconds(now - started)} (limit ${seconds(STEP_MAX_MS)})`;
    if (stopped) {
      clearInterval(timer);
      killTreeSync(child.pid);
    }
  }, 1000);
  return new Promise((resolve) => {
    const done = (code) => {
      clearInterval(timer);
      const ms = Date.now() - started;
      if (!stopped && code === 0) {
        runner.log(`ok    ${label} (${seconds(ms)})`);
        resolve(null);
        return;
      }
      const reason = stopped ?? `exit code ${code}`;
      runner.error(`FAIL  ${label} (${seconds(ms)}): ${reason}\n\n$ ${command}\n${output.trimEnd()}\n`);
      resolve(reason);
    };
    child.once('exit', done);
    child.once('error', () => done(1));
  });
}

const started = Date.now();
runner.log(`lanes: ${lanes.join(', ')}`);
const failures = (
  await Promise.all(
    lanes.map(async (lane) => {
      for (const [label, command, cwd, options] of LANES[lane]) {
        if (await runStep(label, command, cwd, options)) return [label];
      }
      return [];
    }),
  )
).flat();
if (failures.length) {
  runner.error(`${failures.length} failed after ${seconds(Date.now() - started)}: ${failures.join(', ')}. CI would fail too.`);
  await runner.exit(1);
}
runner.log(`all passed after ${seconds(Date.now() - started)}. Before pushing, also run the e2e specs your change can reach (CLAUDE.md "Tests").`);
await runner.exit(0);
