#!/usr/bin/env node
// The dev stack of this worktree's branch (README "Running locally"). Run it as ./stack (sh) or
// .\stack (PowerShell, cmd) from the repository root:
//
//   ./stack up [-d --wait]     the branch's stack: compose project hb-<branch>, on http://<branch>.homebrewery.dev.localhost
//                              (master: http://homebrewery.dev.localhost) and http://localhost:<8080 + slot>
//   ./stack <compose args…>    any other compose command for that project: logs -f api, ps, restart api, stop, down …
//   ./stack --prod up -d --build   the production image instead of the dev servers (compose.prod.yml)
//   ./stack db <compose args…>     the shared project (deploy/stack/shared.yml: PostgreSQL and the router): up -d, logs, stop …
//   ./stack info               branch, slot, project, URLs, database, test ports
//   ./stack ls                 every branch stack and the shared project, with their state
//   ./stack slot               this worktree's slot (for scripts)
//
// Every branch gets its own containers, networks and build volumes (dotnet bin/obj, node_modules), a name
// (web/scripts/worktree.ts stackHost: the branch, lower case, [a-z0-9-]) that the shared router serves as
// http://<name>.homebrewery.dev.localhost (master: http://homebrewery.dev.localhost; stackUrl), and every worktree
// its own port (8080 for the main checkout, 8080 + n for worktree slot n; HB_HTTP_PORT in the environment or .env
// overrides it). All of them use ONE PostgreSQL, in the
// homebrewery-shared project, so every stack sees the same data. Commands that start containers start the database
// first (and, once, copy the data of the old single-stack volume homebrewery_pgdata into it; one ./stack at a time,
// and an interrupted copy is redone) and the router (a warning only when it can't start: the port still works), stop
// this worktree's stack of the branch checked out before, which holds the same port, and stop the containers of the
// other mode (app and backup of --prod in dev mode, api and web in --prod mode).
//
// The web container works on a copy of the sources; a file sync (`docker compose watch`, started detached after
// `up -d`, `start` and `restart`, stopped with web) copies edits into it (docker-compose.yml web). A foreground `up`
// runs with --watch instead.
//
// Plain `docker compose up` still works: it runs docker-compose.yml alone, a stack with a database of its own
// (add --watch for the file sync).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SLOT, slotPort, stackHost, stackName, stackUrl, worktreeInfo } from '../../web/scripts/worktree.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED_PROJECT = 'homebrewery-shared';
const SHARED_VOLUME = 'homebrewery-shared-pgdata';
const SHARED_FILE = 'deploy/stack/shared.yml';
/** The router and the stacks' fronts (web, or app with --prod) meet on this network (deploy/stack/shared.yml). */
const ROUTER_NETWORK = 'homebrewery-router';
/** The volume of the single stack that docker-compose.yml ran before per-branch stacks (project "homebrewery"). */
const OLD_VOLUME = 'homebrewery_pgdata';
/** In the root of SHARED_VOLUME (next to PostgreSQL's 18/ folder) while the copy from OLD_VOLUME is not finished. */
const COPYING = '.hb-copy-incomplete';
/** Held (mkdir is atomic; it holds the owner's pid) while a ./stack prepares the shared database. */
const LOCK = path.join(os.tmpdir(), 'homebrewery-shared-db.lock');
/** A lock this old is stale even if its pid is alive again (a reused pid). */
const LOCK_STALE_MS = 15 * 60_000;
const STARTS = new Set(['up', 'start', 'restart', 'run', 'create', 'exec', 'watch']);

const say = (message) => console.error(`[stack] ${message}`);
const fail = (message) => {
  say(message);
  process.exit(1);
};

/** Runs docker; `inherit` shows its output, otherwise it is returned (trimmed). */
function docker(args, { inherit = false, env, allowFail = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) fail(`docker could not run (${result.error.message}). Is Docker installed and running?`);
  if (result.status !== 0 && !allowFail) {
    if (!inherit) process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }
  return { status: result.status ?? 1, out: (result.stdout ?? '').trim() };
}

const lines = (text) => text.split(/\r?\n/).filter(Boolean);

/** HB_HTTP_PORT from the environment, else from .env, else 8080 + slot. */
function httpPort(slot) {
  if (process.env.HB_HTTP_PORT) return process.env.HB_HTTP_PORT;
  try {
    const match = /^\s*HB_HTTP_PORT\s*=\s*"?(\d+)"?\s*$/m.exec(fs.readFileSync(path.join(repo, '.env'), 'utf8'));
    if (match) return match[1];
  } catch {
    // no .env
  }
  return String(8080 + slot);
}

/** The router's URL for stack name `host` (HB_ROUTER_PORT, default 80). */
function routerUrl(host) {
  return stackUrl(host, process.env.HB_ROUTER_PORT || '80');
}

/** Whether the lock's owner still runs (or has not written its pid yet). */
function lockHeld() {
  let age;
  try {
    age = Date.now() - fs.statSync(LOCK).mtimeMs;
  } catch {
    return false; // released meanwhile
  }
  if (age > LOCK_STALE_MS) return false;
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'));
  } catch {
    // not written yet
  }
  if (!Number.isInteger(pid) || pid <= 0) return age < 10_000; // the owner has not written its pid yet
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // ESRCH: the owner died
  }
}

/** Runs `fn` holding LOCK, so two ./stack runs (of any worktree) never prepare the shared database at the same time. */
function withSharedDbLock(fn) {
  let waiting = false;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!lockHeld()) {
        fs.rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
      if (!waiting) say(`waiting for another ./stack that prepares the shared database (lock ${LOCK})…`);
      waiting = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  const release = () => fs.rmSync(LOCK, { recursive: true, force: true });
  process.on('exit', release); // fail() exits without running finally blocks
  try {
    fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
    return fn();
  } finally {
    process.off('exit', release);
    release();
  }
}

/** Starts the shared database (after the one-time copy of the old stack's data) and waits until it is healthy. */
function ensureSharedDb() {
  withSharedDbLock(prepareSharedDb);
}

/** A copy from OLD_VOLUME that did not finish (Ctrl+C, a crash) left its marker in SHARED_VOLUME. */
function copyInterrupted() {
  // A running database is never overwritten; it only starts after a finished copy.
  if (docker(['ps', '-q', '--filter', `volume=${SHARED_VOLUME}`]).out) return false;
  return docker(['run', '--rm', '-v', `${SHARED_VOLUME}:/to:ro`, 'postgres:18', 'test', '-e', `/to/${COPYING}`], { allowFail: true }).status === 0;
}

function prepareSharedDb() {
  // No other container may have the shared data volume mounted.
  const users = lines(docker(['ps', '-a', '--filter', `volume=${SHARED_VOLUME}`, '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}']).out).filter(
    (row) => row.split('\t')[1] !== SHARED_PROJECT,
  );
  if (users.length) fail(`${SHARED_VOLUME} is mounted by ${users.map((r) => r.split('\t')[0]).join(', ')}; only the ${SHARED_PROJECT} database may use it. Remove those containers first.`);

  const volumes = new Set(lines(docker(['volume', 'ls', '--format', '{{.Name}}']).out));
  if (volumes.has(OLD_VOLUME) && (!volumes.has(SHARED_VOLUME) || copyInterrupted())) {
    const running = lines(docker(['ps', '--filter', `volume=${OLD_VOLUME}`, '--format', '{{.Names}}']).out);
    if (running.length) {
      fail(
        `the old single stack's database (${running.join(', ')}) still runs on ${OLD_VOLUME}. Stop that stack once, keeping its data:\n` +
          `  docker compose -p homebrewery down\n` +
          `then run this again: its data is copied into the shared database (${SHARED_VOLUME}); ${OLD_VOLUME} is kept.`,
      );
    }
    say(`copying the data of ${OLD_VOLUME} (the old single stack's database) into ${SHARED_VOLUME}; ${OLD_VOLUME} is kept…`);
    docker(['volume', 'create', SHARED_VOLUME]);
    // The marker comes first and goes last, so the next run redoes a copy that did not finish (into an emptied volume).
    const script = `touch /to/${COPYING} && find /to -mindepth 1 -maxdepth 1 ! -name ${COPYING} -exec rm -rf {} + && cp -a /from/. /to/ && rm /to/${COPYING}`;
    const copy = docker(['run', '--rm', '-v', `${OLD_VOLUME}:/from:ro`, '-v', `${SHARED_VOLUME}:/to`, 'postgres:18', 'sh', '-c', script], { inherit: true, allowFail: true });
    if (copy.status !== 0) {
      docker(['volume', 'rm', SHARED_VOLUME], { allowFail: true });
      fail(`the copy failed; ${OLD_VOLUME} is unchanged. Run this again to retry.`);
    }
  }
  // External in deploy/stack/shared.yml. Created only here, after the copy check: an empty volume would skip the copy.
  docker(['volume', 'create', SHARED_VOLUME]);
  docker(['compose', '-f', SHARED_FILE, 'up', '-d', '--wait', '--wait-timeout', '120', 'db'], { inherit: true });
}

/** Creates ROUTER_NETWORK unless it exists (external in every compose file, so no project owns or removes it). */
function ensureRouterNetwork() {
  if (docker(['network', 'inspect', ROUTER_NETWORK], { allowFail: true }).status === 0) return;
  // A ./stack running at the same time may create it first.
  if (docker(['network', 'create', ROUTER_NETWORK], { allowFail: true }).status !== 0) docker(['network', 'inspect', ROUTER_NETWORK]);
}

/** Starts the router. A stack works without it (on its port), so a router that can't start is only a warning. */
function ensureRouter(fallbackUrl) {
  const up = docker(['compose', '-f', SHARED_FILE, 'up', '-d', 'router'], { inherit: true, allowFail: true });
  if (up.status !== 0) {
    say(`the router could not start (is port ${process.env.HB_ROUTER_PORT || 80} taken? HB_ROUTER_PORT picks another); the stack still answers on ${fallbackUrl}`);
  }
}

/** Fails when a running stack of another branch has the same name (feature/foo and feature-foo): the router would mix them. */
function checkHostFree(host, project) {
  const others = lines(docker(['ps', '--filter', `label=hb.host=${host}`, '--format', '{{.Label "com.docker.compose.project"}}']).out).filter((p) => p !== project);
  if (others.length) {
    fail(`${[...new Set(others)].join(', ')} already runs as ${routerUrl(host)}. Stop it first (./stack stop in its worktree, or docker compose -p <project> stop).`);
  }
}

/**
 * Stops the running containers of compose project `name`, or only those of `services`, found by their compose labels:
 * the compose files of this checkout may not define them all (app and backup exist only with --prod).
 */
function stopContainers(name, services) {
  const ids = lines(docker(['ps', '--filter', `label=com.docker.compose.project=${name}`, '--format', '{{.ID}}\t{{.Label "com.docker.compose.service"}}']).out)
    .map((row) => row.split('\t'))
    .filter(([, service]) => !services || services.includes(service))
    .map(([id]) => id);
  if (ids.length && docker(['stop', ...ids], { allowFail: true }).status !== 0) say(`could not stop every container of ${name}`);
}

/** Stops this worktree's stacks of other branches: they hold the same port (and would serve this checkout's files). */
function stopOtherBranches(root, project) {
  const projects = new Set(
    lines(docker(['ps', '--filter', `label=hb.worktree=${root}`, '--format', '{{.Label "com.docker.compose.project"}}']).out).filter((p) => p && p !== project),
  );
  for (const other of projects) {
    say(`stopping ${other}, this worktree's stack of the branch checked out before (docker compose -p ${other} down removes it)…`);
    stopWatcher(other);
    stopContainers(other);
  }
}

// The file sync (docker-compose.yml web: develop.watch): `docker compose watch` on the host copies each changed file
// into web's container. A detached process per project; its pid and log are in the temp folder.
const watchFile = (name, ext) => path.join(os.tmpdir(), `homebrewery-watch-${name}.${ext}`);

/** The pid of `name`'s running file sync, or 0. Checks the process is still docker (pids get reused). */
function watcherPid(name) {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(watchFile(name, 'pid'), 'utf8'));
  } catch {
    return 0;
  }
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  const check =
    process.platform === 'win32'
      ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      : spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return /docker/i.test(check.stdout ?? '') ? pid : 0;
}

/** Stops `name`'s file sync, if it runs. */
function stopWatcher(name) {
  const pid = watcherPid(name);
  if (pid) {
    // The docker CLI runs compose as a child process: stop the whole tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else {
      try {
        process.kill(-pid, 'SIGTERM'); // detached: its own process group
      } catch {
        // already gone
      }
    }
  }
  fs.rmSync(watchFile(name, 'pid'), { force: true });
}

/** Starts `name`'s file sync unless it runs (web must be running: `watch --no-up`). */
function startWatcher(name, files, env) {
  if (watcherPid(name)) return;
  const running = docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${name}`, '--filter', 'label=com.docker.compose.service=web']).out;
  if (!running) return;
  const log = watchFile(name, 'log');
  const out = fs.openSync(log, 'w');
  const child = spawn('docker', ['compose', '-p', name, ...files, 'watch', '--no-up', '--quiet', 'web'], {
    cwd: repo,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  fs.closeSync(out);
  if (!child.pid) fail(`the file sync (docker compose watch) could not start; see ${log}`);
  fs.writeFileSync(watchFile(name, 'pid'), String(child.pid));
  child.unref();
  // A sync that can't start (an old Compose, a bad develop.watch) exits at once.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  if (!watcherPid(name)) {
    say(`the file sync (docker compose watch) stopped right away, so edits won't reach the dev server:\n${fs.readFileSync(log, 'utf8').trim()}`);
    return;
  }
  say(`file sync running (docker compose watch, pid ${child.pid}; log ${log})`);
}

const argv = process.argv.slice(2);
const info = worktreeInfo(repo);
const project = stackName(info);
const host = stackHost(info);
const port = httpPort(info.slot);
const portUrl = `http://localhost:${port}`;

if (argv[0] === 'slot') {
  console.log(info.slot);
  process.exit(0);
}

if (argv[0] === 'info') {
  const testPorts = [
    ['Playwright Vite (E2E_PORT)', 5174],
    ['run-suite API / Vite', 5474, 5374],
    ['run-csp API / name', 5477, 5377],
  ];
  console.log(`branch      ${info.branch ?? '(detached HEAD)'}`);
  console.log(`worktree    ${info.root} (${info.main ? 'main checkout' : 'linked worktree'}, slot ${info.slot} of ${MAX_SLOT})`);
  console.log(`stack       ${project} → ${routerUrl(host)} or ${portUrl}`);
  console.log(`database    ${SHARED_PROJECT} (localhost:${process.env.HB_DB_PORT ?? 5432}, volume ${SHARED_VOLUME})`);
  const syncPid = watcherPid(project);
  console.log(`file sync   ${syncPid ? `running (pid ${syncPid}; log ${watchFile(project, 'log')})` : 'not running (./stack up -d starts it)'}`);
  for (const [label, ...bases] of testPorts) console.log(`test ports  ${label}: ${bases.map((b) => slotPort(b, info.slot)).join(' / ')}`);
  process.exit(0);
}

if (argv[0] === 'ls') {
  docker(['compose', 'ls', '--all', '--filter', 'name=hb-'], { inherit: true });
  docker(['compose', 'ls', '--all', '--filter', `name=${SHARED_PROJECT}`], { inherit: true });
  process.exit(0);
}

if (argv[0] === 'db') {
  const rest = argv.slice(1);
  ensureRouterNetwork(); // compose refuses the project's files while an external network is missing
  if (rest[0] === 'up') {
    ensureSharedDb();
    process.exit(0);
  }
  process.exit(docker(['compose', '-f', SHARED_FILE, ...rest], { inherit: true, allowFail: true }).status);
}

const prod = argv[0] === '--prod';
const args = prod ? argv.slice(1) : argv;
if (!args.length) fail('usage: ./stack [--prod] <compose command …> | ./stack db <compose command …> | ./stack info | ls | slot');

const command = args.find((a) => !a.startsWith('-'));
if (command && STARTS.has(command)) {
  checkHostFree(host, project);
  ensureSharedDb();
  ensureRouterNetwork();
  ensureRouter(portUrl);
  stopOtherBranches(info.root, project);
  // The other mode's services are not in this mode's compose files, so compose would leave them running.
  stopContainers(project, prod ? ['api', 'web'] : ['app', 'backup']);
  say(`${project} (branch ${info.branch ?? 'detached'}, slot ${info.slot}) → ${routerUrl(host)} or ${portUrl}`);
}

const files = ['-f', 'docker-compose.yml', '-f', 'deploy/stack/dev.yml', ...(prod ? ['-f', 'compose.prod.yml', '-f', 'deploy/stack/prod.yml'] : [])];
const env = { HB_HTTP_PORT: port, HB_WORKTREE: info.root, HB_HOST: host };

// The file sync follows web: it stops with it, and starts once web runs in the background. A foreground
// `up` watches by itself (--watch) and stops watching with it.
const at = args.indexOf(command);
const services = at < 0 ? [] : args.slice(at + 1).filter((a) => !a.startsWith('-'));
const touchesWeb = services.length === 0 || !services.every((s) => ['api', 'db'].includes(s));
const detached = args.some((a) => a === '-d' || a === '--detach' || a.startsWith('--wait'));
let composeArgs = args;
if (prod || (touchesWeb && ['stop', 'down', 'kill', 'rm', 'pause'].includes(command))) stopWatcher(project);
if (!prod && command === 'up' && touchesWeb) {
  stopWatcher(project); // a recreated web container gets a fresh sync
  if (!detached) composeArgs = [...args.slice(0, at + 1), '--watch', ...args.slice(at + 1)];
}

const result = docker(['compose', '-p', project, ...files, ...composeArgs], { inherit: true, allowFail: true, env });
if (result.status === 0 && !prod && touchesWeb && ['up', 'start', 'restart', 'unpause'].includes(command) && (command !== 'up' || detached)) {
  startWatcher(project, files, env);
}
process.exit(result.status);
