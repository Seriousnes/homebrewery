#!/usr/bin/env node
// The dev stack of this worktree's branch (README "Running locally"). Run it as ./stack (sh) or
// .\stack (PowerShell, cmd) from the repository root:
//
//   ./stack up [-d --wait]     the branch's stack: compose project hb-<branch>, Caddy on http://localhost:<8080 + slot>
//   ./stack <compose args…>    any other compose command for that project: logs -f api, ps, restart api, stop, down …
//   ./stack --prod up -d --build   the production image instead of the dev servers (compose.prod.yml)
//   ./stack db <compose args…>     the shared PostgreSQL (deploy/stack/shared-db.yml): up -d, logs, stop …
//   ./stack info               branch, slot, project, URL, database, test ports
//   ./stack ls                 every branch stack and the shared database, with their state
//   ./stack slot               this worktree's slot (for scripts)
//
// Every branch gets its own containers, networks and build volumes (dotnet bin/obj, node_modules), and every
// worktree its own Caddy port (web/scripts/worktree.ts: 8080 for the main checkout, 8080 + n for worktree slot n;
// HB_HTTP_PORT in the environment or .env overrides it). All of them use ONE PostgreSQL, the homebrewery-shared
// project, so every stack sees the same data. Commands that start containers start it first (and, once, copy the
// data of the old single-stack volume homebrewery_pgdata into it), and stop this worktree's stack of the branch
// checked out before, which holds the same port.
//
// Plain `docker compose up` still works: it runs docker-compose.yml alone, a stack with a database of its own.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SLOT, slotPort, stackName, worktreeInfo } from '../../web/scripts/worktree.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED_PROJECT = 'homebrewery-shared';
const SHARED_VOLUME = 'homebrewery-shared-pgdata';
const SHARED_FILE = 'deploy/stack/shared-db.yml';
/** The volume of the single stack that docker-compose.yml ran before per-branch stacks (project "homebrewery"). */
const OLD_VOLUME = 'homebrewery_pgdata';
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

/** Starts the shared database (after the one-time copy of the old stack's data) and waits until it is healthy. */
function ensureSharedDb() {
  // No other container may have the shared data volume mounted.
  const users = lines(docker(['ps', '-a', '--filter', `volume=${SHARED_VOLUME}`, '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}']).out).filter(
    (row) => row.split('\t')[1] !== SHARED_PROJECT,
  );
  if (users.length) fail(`${SHARED_VOLUME} is mounted by ${users.map((r) => r.split('\t')[0]).join(', ')}; only the ${SHARED_PROJECT} database may use it. Remove those containers first.`);

  const volumes = new Set(lines(docker(['volume', 'ls', '--format', '{{.Name}}']).out));
  if (!volumes.has(SHARED_VOLUME) && volumes.has(OLD_VOLUME)) {
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
    const copy = docker(['run', '--rm', '-v', `${OLD_VOLUME}:/from:ro`, '-v', `${SHARED_VOLUME}:/to`, 'postgres:18', 'cp', '-a', '/from/.', '/to/'], { inherit: true, allowFail: true });
    if (copy.status !== 0) {
      docker(['volume', 'rm', SHARED_VOLUME], { allowFail: true });
      fail('the copy failed; nothing was changed.');
    }
  }
  docker(['compose', '-f', SHARED_FILE, 'up', '-d', '--wait', '--wait-timeout', '120'], { inherit: true });
}

/** Stops this worktree's stacks of other branches: they hold the same Caddy port. */
function stopOtherBranches(root, project) {
  const projects = new Set(
    lines(docker(['ps', '--filter', `label=hb.worktree=${root}`, '--format', '{{.Label "com.docker.compose.project"}}']).out).filter((p) => p && p !== project),
  );
  for (const other of projects) {
    say(`stopping ${other}, this worktree's stack of the branch checked out before (docker compose -p ${other} down removes it)…`);
    docker(['compose', '-p', other, 'stop'], { inherit: true, allowFail: true });
  }
}

const argv = process.argv.slice(2);
const info = worktreeInfo(repo);
const project = stackName(info);
const port = httpPort(info.slot);

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
  console.log(`stack       ${project} → http://localhost:${port}`);
  console.log(`database    ${SHARED_PROJECT} (localhost:${process.env.HB_DB_PORT ?? 5432}, volume ${SHARED_VOLUME})`);
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
  ensureSharedDb();
  stopOtherBranches(info.root, project);
  say(`${project} (branch ${info.branch ?? 'detached'}, slot ${info.slot}) → http://localhost:${port}`);
}

const files = ['-f', 'docker-compose.yml', '-f', 'deploy/stack/dev.yml', ...(prod ? ['-f', 'compose.prod.yml', '-f', 'deploy/stack/prod.yml'] : [])];
const result = docker(['compose', '-p', project, ...files, ...args], {
  inherit: true,
  allowFail: true,
  env: { HB_HTTP_PORT: port, HB_WORKTREE: info.root },
});
process.exit(result.status);
