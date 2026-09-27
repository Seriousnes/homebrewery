// Which git worktree this checkout is, and the names and ports that keep its stacks apart from the
// other worktrees' (docs/testing.md "Worktrees", README "Running locally").
//
// Every worktree of the repository gets a SLOT: the main checkout is slot 0, every other worktree
// the lowest free slot from 1, kept in <git common dir>/hb-worktree-slots.json (shared by all
// worktrees, so two never get the same slot; entries of removed worktrees are dropped). Slot 0 keeps
// the historical defaults (Caddy :8080, the runners' 5174/5374/5474 …), slot n moves them by n × 1000
// (test ports) or n (the dev stack's Caddy port). HB_SLOT forces a slot. Without git (CI container
// jobs refuse the checkout's owner) the checkout counts as the main one.
//
// Plain Node (type stripping only): deploy/stack/stack.mjs imports this file too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Slots from 1 up to this; test port bases (5174…5478) + 40 × 1000 stay below the ephemeral range (49152). */
export const MAX_SLOT = 40;
const REGISTRY = 'hb-worktree-slots.json';
const here = path.dirname(fileURLToPath(import.meta.url));

export interface WorktreeInfo {
  /** The worktree's top-level directory (forward slashes). */
  root: string;
  /** The repository's shared git directory, or null without git. */
  commonDir: string | null;
  /** The main checkout (not a linked worktree). */
  main: boolean;
  /** The checked-out branch, or null (detached HEAD, no git). */
  branch: string | null;
  slot: number;
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/');
const sameDir = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function git(cwd: string, args: string[]): string[] | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .trim()
      .split(/\r?\n/);
  } catch {
    return null;
  }
}

/** Takes <dir>.lock (mkdir is atomic), runs `fn`, releases it. A lock older than 10 s is stale. */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = path.join(dir, `${REGISTRY}.lock`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // released meanwhile
      }
      if (Date.now() > deadline) throw new Error(`could not lock ${lock}; remove it if no other run holds it`, { cause: error });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** The slot of `root` in the registry under `commonDir`: its entry, or the lowest free slot (then stored). */
export function registerSlot(commonDir: string, root: string): number {
  return withLock(commonDir, () => {
    const file = path.join(commonDir, REGISTRY);
    let slots: Record<string, number> = {};
    try {
      slots = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>;
    } catch {
      // none yet, or unreadable: start over
    }
    // Worktrees that no longer exist give their slots back.
    for (const dir of Object.keys(slots)) if (!fs.existsSync(dir)) delete slots[dir];
    const key = Object.keys(slots).find((dir) => sameDir(dir, root));
    let slot = key ? slots[key] : undefined;
    if (slot === undefined) {
      const used = new Set(Object.values(slots));
      slot = 1;
      while (used.has(slot)) slot++;
      if (slot > MAX_SLOT) throw new Error(`more than ${MAX_SLOT} worktrees have slots (${file}); remove unused worktrees`);
      slots[root] = slot;
    }
    fs.writeFileSync(file, `${JSON.stringify(slots, null, 2)}\n`);
    return slot;
  });
}

let cached: WorktreeInfo | undefined;

/** This checkout's worktree, branch and slot (cached per process). */
export function worktreeInfo(cwd = here): WorktreeInfo {
  if (cached) return cached;
  const forced = process.env.HB_SLOT !== undefined && process.env.HB_SLOT !== '' ? Number(process.env.HB_SLOT) : null;
  if (forced !== null && !(Number.isInteger(forced) && forced >= 0 && forced <= MAX_SLOT)) {
    throw new Error(`HB_SLOT must be a whole number from 0 to ${MAX_SLOT}`);
  }
  const out = git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD']);
  const [top, common, head] = out ?? [];
  if (!top || !common) {
    // No git (or a checkout git refuses): the main checkout, in the repository this file is in.
    cached = { root: norm(path.resolve(here, '..', '..')), commonDir: null, main: true, branch: null, slot: forced ?? 0 };
    return cached;
  }
  const root = norm(top);
  const commonDir = norm(path.resolve(root, common));
  const main = sameDir(commonDir, `${root}/.git`);
  const branch = head && head !== 'HEAD' ? head : null;
  const slot = forced ?? (main ? 0 : registerSlot(commonDir, root));
  cached = { root, commonDir, main, branch, slot };
  return cached;
}

/** `base` for slot 0, else base + slot × 1000: a test port that no other worktree's runs use. */
export function slotPort(base: number, slot = worktreeInfo().slot): string {
  return String(slot === 0 ? base : base + slot * 1000);
}

/** A temp-dir path of this worktree: <tmp>/<name> for slot 0, else <tmp>/<name>-<slot>. */
export function slotTmp(name: string, slot = worktreeInfo().slot): string {
  return path.join(os.tmpdir(), slot === 0 ? name : `${name}-${slot}`);
}

/** A name for docker (compose projects, containers): lower case, [a-z0-9-], at most 40 characters. */
export function dockerSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'detached';
}

/** The dev stack's compose project: hb-<branch> (hb-<worktree folder> on a detached HEAD). */
export function stackName(info: WorktreeInfo = worktreeInfo()): string {
  return `hb-${dockerSlug(info.branch ?? path.basename(info.root))}`;
}
