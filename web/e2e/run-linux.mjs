#!/usr/bin/env node
// E2E specs on CI's machine, locally: the CI e2e job's Playwright container image (Linux, its
// fonts and browsers), CI=true (2 workers, retries, forbidOnly), a main checkout with LF line
// endings, a postgres:18 next to it as CI's service container, and e2e/matrix/run-suite.mjs, as
// .github/workflows/ci.yml runs them. A spec that passes here and fails in CI is rare; one that
// passes on Windows only is not (fonts, line endings, speed).
//
//   node e2e/run-linux.mjs e2e/canvas/canvas.spec.ts --project=chromium    (from web/; Docker only)
//   node e2e/run-linux.mjs --project=chromium --shard=2/7                  a CI shard, as CI runs it
//   node e2e/run-linux.mjs verify       the web and unit lanes of scripts/verify.mjs (CI's web and
//                                       unit jobs) on Linux in a main checkout
//
// Arguments go to run-suite.mjs; a filter or --shard is required (no whole-suite run here: that is
// CI's). The working tree is what runs, uncommitted changes included: the files git would commit
// (tracked and untracked, not ignored) are streamed into the container. The image
// (deploy/e2e-linux/Dockerfile) is rebuilt when package-lock.json changes, the first build takes
// a few minutes (image pull, .NET SDK, npm ci); NuGet packages persist in the volume
// hb-e2e-linux-nuget. The container gets 4 CPUs and 16 GB, as CI's runner (HB_LINUX_CPUS,
// HB_LINUX_MEMORY). On a failure, test-results/ (traces, screenshots) is copied to
// web/test-results-linux/.
//
// Fail fast: the image build is killed when it prints nothing for 2 minutes; run-suite.mjs runs
// its own watchdogs in the container, and the run is killed when it prints nothing for 3 minutes.
// Its containers and network carry the worktree's slot and are removed at the end (and by the
// reaper when this script is killed).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dockerSync, killTreeSync, removeContainerSync, repoRoot, sleep, TestRunner, webDir } from '../scripts/testRunner.ts';
import { worktreeInfo } from '../scripts/worktree.ts';

const runner = new TestRunner('e2e-linux');
const args = process.argv.slice(2);
const verify = args[0] === 'verify';
if (!verify && !args.some((a) => !a.startsWith('-') || a.startsWith('--shard'))) {
  runner.error('give a spec, a folder or --shard=<n>/<total> (the whole suite runs in CI only)');
  process.exit(2);
}

// The CI job's image, and the @playwright/test it must match (its browsers are the image's).
const ci = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const images = [...new Set(Array.from(ci.matchAll(/mcr\.microsoft\.com\/playwright:v([\w.-]+?)-noble/g), (m) => m[0]))];
if (images.length !== 1) {
  runner.error(`ci.yml should name one Playwright image, it names ${images.length ? images.join(', ') : 'none'}`);
  process.exit(2);
}
const image = images[0];
const imageVersion = /:v([\w.-]+?)-noble/.exec(image)[1];
const lock = JSON.parse(readFileSync(path.join(webDir, 'package-lock.json'), 'utf8'));
const playwrightVersion = lock.packages?.['node_modules/@playwright/test']?.version;
if (playwrightVersion !== imageVersion) {
  runner.error(`CI's image is Playwright ${imageVersion} but package-lock.json has @playwright/test ${playwrightVersion}: update ci.yml's images (CI can't launch the browsers otherwise).`);
  process.exit(2);
}

const { slot } = worktreeInfo();
const tag = `hb-e2e-linux:slot${slot}`;
const network = `hb-e2e-linux-${slot}`;
const db = `hb-e2e-linux-${slot}-db`;
const run = `hb-e2e-linux-${slot}-run`;
const resultsDir = path.join(webDir, 'test-results-linux');
const cpus = process.env.HB_LINUX_CPUS ?? '4';
const memory = process.env.HB_LINUX_MEMORY ?? '16g';

/** postgres:18 on the run's network as `db`, like the e2e job's service container. */
async function startDatabase() {
  const started = dockerSync([
    'run', '-d', '--name', db, '--network', network, '--network-alias', 'db',
    '-e', 'POSTGRES_USER=homebrewery', '-e', 'POSTGRES_PASSWORD=homebrewery', '-e', 'POSTGRES_DB=homebrewery',
    '--tmpfs', '/var/lib/postgresql',
    'postgres:18', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
  ]);
  if (started.status !== 0) throw new Error(`PostgreSQL could not start: ${started.output}`);
  runner.trackContainer(db);
  const deadline = Date.now() + 60_000;
  while (dockerSync(['exec', db, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'homebrewery', '-d', 'homebrewery']).status !== 0) {
    if (Date.now() > deadline) throw new Error(`PostgreSQL (${db}) did not accept connections within 60 s`);
    await sleep(250);
  }
}

const cleanup = () => {
  removeContainerSync(run);
  removeContainerSync(db);
  dockerSync(['network', 'rm', network]);
};
cleanup(); // a killed run's leftovers

let status;
try {
  await runner.runCommand(
    `building ${tag} (${image})`,
    'docker',
    ['build', '--progress=plain', '-f', 'deploy/e2e-linux/Dockerfile', '--build-arg', `PLAYWRIGHT_IMAGE=${image}`, '-t', tag, '.'],
    { cwd: repoRoot, maxMs: 15 * 60_000 },
  );

  const created = dockerSync(['network', 'create', network]);
  if (created.status !== 0) throw new Error(`docker network create ${network}: ${created.output}`);
  if (!verify) await startDatabase();

  // The working tree as git would commit it.
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const files = [...new Set(listed.stdout.split('\0'))].filter((f) => f && existsSync(path.join(repoRoot, f)));
  const command = verify ? ['verify'] : ['suite', ...args];
  runner.log(`${files.length} files into ${run} (${cpus} CPUs, ${memory}): ${verify ? 'verify.mjs web unit' : `run-suite.mjs ${args.join(' ')}`}`);

  const docker = runner.spawn(
    'docker',
    [
      // --init: a PID 1 that reaps orphans, as on a runner (the runners' tree kills check for leftover processes).
      'run', '-i', '--init', '--name', run, '--network', network, '--ipc=host',
      '--cpus', cpus, '--memory', memory,
      '-e', 'HB_E2E_DB_HOST=db', '-e', 'HB_ARTIFACTS=.artifacts',
      '-v', 'hb-e2e-linux-nuget:/root/.nuget/packages',
      tag, ...command,
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  runner.trackContainer(run);
  const tar = runner.spawn('tar', ['--null', '-T', '-', '-cf', '-'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] });
  tar.stdin.end(files.join('\0') + '\0');
  tar.stdout.pipe(docker.stdin);

  let lastOutput = Date.now();
  const echo = (stream) => (chunk) => {
    lastOutput = Date.now();
    stream.write(chunk);
  };
  docker.stdout.on('data', echo(process.stdout));
  docker.stderr.on('data', echo(process.stderr));
  let stalled = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastOutput > 3 * 60_000) {
      stalled = true;
      runner.error('the run printed nothing for 3 minutes: stopping it.');
      removeContainerSync(run);
      killTreeSync(docker.pid);
    }
  }, 1000);
  status = await new Promise((resolve) => docker.once('exit', (code) => resolve(code ?? 1)));
  clearInterval(watchdog);
  if (stalled) status = 124;

  rmSync(resultsDir, { recursive: true, force: true });
  if (status !== 0 && dockerSync(['cp', `${run}:/repo/web/test-results`, resultsDir]).status === 0) {
    runner.log(`test results (traces: npx playwright show-trace <trace.zip>) in ${path.relative(repoRoot, resultsDir)}`);
  }
} catch (error) {
  runner.error(error instanceof Error ? error.message : String(error));
  status = 1;
} finally {
  cleanup();
}
await runner.exit(status);
