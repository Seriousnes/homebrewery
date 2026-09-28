import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockerSlug, readWorktreeInfo, registerSlot, slotPort, slotTmp, stackHost, stackName, stackUrl } from './worktree';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-worktree-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('registerSlot', () => {
  it('gives each worktree the lowest free slot from 1 and keeps it', () => {
    const common = tempDir();
    const a = tempDir();
    const b = tempDir();
    expect(registerSlot(common, a)).toBe(1);
    expect(registerSlot(common, b)).toBe(2);
    expect(registerSlot(common, a)).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(common, 'hb-worktree-slots.json'), 'utf8'))).toEqual({ [a]: 1, [b]: 2 });
  });

  it('gives the slot of a removed worktree back', () => {
    const common = tempDir();
    const a = tempDir();
    const b = tempDir();
    registerSlot(common, a);
    registerSlot(common, b);
    fs.rmSync(a, { recursive: true });
    const c = tempDir();
    expect(registerSlot(common, c)).toBe(1);
    expect(registerSlot(common, b)).toBe(2);
  });

  it('starts over from an unreadable registry and leaves no lock behind', () => {
    const common = tempDir();
    fs.writeFileSync(path.join(common, 'hb-worktree-slots.json'), '{not json');
    expect(registerSlot(common, tempDir())).toBe(1);
    expect(fs.existsSync(path.join(common, 'hb-worktree-slots.json.lock'))).toBe(false);
  });

  it('takes over a stale lock', () => {
    const common = tempDir();
    const lock = path.join(common, 'hb-worktree-slots.json.lock');
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(registerSlot(common, tempDir())).toBe(1);
  });
});

describe('readWorktreeInfo', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  // git prints real paths (macOS /private/var, Windows drive letter case).
  const real = (dir: string) => {
    const p = fs.realpathSync.native(dir).replace(/\\/g, '/');
    return process.platform === 'win32' ? p.toLowerCase() : p;
  };
  const lower = (p: string | null) => (p && process.platform === 'win32' ? p.toLowerCase() : p);

  it('finds the main checkout and a linked worktree from a subfolder', () => {
    vi.stubEnv('HB_SLOT', '');
    const main = path.join(tempDir(), 'repo');
    fs.mkdirSync(path.join(main, 'web', 'scripts'), { recursive: true });
    git(main, 'init', '-q', '-b', 'master');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    const linked = path.join(path.dirname(main), 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'feature/x', linked);
    fs.mkdirSync(path.join(linked, 'web', 'scripts'), { recursive: true });

    // From a subfolder of the main checkout git prints a relative --git-common-dir (../../.git): relative to the cwd.
    const fromMain = readWorktreeInfo(path.join(main, 'web', 'scripts'));
    expect([lower(fromMain.root), lower(fromMain.commonDir), fromMain.main, fromMain.branch, fromMain.slot]).toEqual([real(main), `${real(main)}/.git`, true, 'master', 0]);
    const fromLinked = readWorktreeInfo(path.join(linked, 'web', 'scripts'));
    expect([lower(fromLinked.root), lower(fromLinked.commonDir), fromLinked.main, fromLinked.branch, fromLinked.slot]).toEqual([real(linked), `${real(main)}/.git`, false, 'feature/x', 1]);
  });
});

describe('ports, folders and names', () => {
  it('keeps the historical defaults in slot 0 and moves them by 1000 per slot', () => {
    expect(slotPort(5474, 0)).toBe('5474');
    expect(slotPort(5474, 1)).toBe('6474');
    expect(slotPort(5174, 12)).toBe('17174');
  });

  it('suffixes temp folders outside slot 0', () => {
    expect(slotTmp('hb-artifacts-suite', 0)).toBe(path.join(os.tmpdir(), 'hb-artifacts-suite'));
    expect(slotTmp('hb-artifacts-suite', 3)).toBe(path.join(os.tmpdir(), 'hb-artifacts-suite-3'));
  });

  it('makes docker-safe stack names from branches', () => {
    expect(dockerSlug('feature/UI Consistency_2')).toBe('feature-ui-consistency-2');
    expect(dockerSlug('///')).toBe('detached');
    expect(dockerSlug('x'.repeat(60))).toHaveLength(40);
    expect(stackName({ root: 'D:/p/homebrewery.pdf-export', commonDir: null, main: false, branch: 'pdf-export', slot: 2 })).toBe('hb-pdf-export');
  });

  it('keeps stack names of different branches and detached worktrees apart', () => {
    const info = (branch: string | null, root = 'D:/p/homebrewery.x') => ({ root, commonDir: null, main: false, branch, slot: 2 });
    expect(stackName(info('pdf-export'))).toBe('hb-pdf-export');
    expect(stackName(info('feature/foo'))).toMatch(/^hb-feature-foo-[0-9a-f]{8}$/);
    expect(stackName(info('feature/foo'))).toBe(stackName(info('feature/foo')));
    expect(stackName(info('feature/foo'))).not.toBe(stackName(info('feature-foo')));
    expect(stackName(info('Feature-Foo'))).not.toBe(stackName(info('feature-foo')));
    const long = 'x'.repeat(40);
    expect(stackName(info(`${long}-a`))).not.toBe(stackName(info(`${long}-b`)));
    expect(stackName(info(null, 'D:/a/homebrewery'))).toMatch(/^hb-homebrewery-[0-9a-f]{8}$/);
    expect(stackName(info(null, 'D:/a/homebrewery'))).not.toBe(stackName(info(null, 'D:/b/homebrewery')));
    expect(stackName(info(null, 'D:/a/homebrewery'))).not.toBe(stackName(info('homebrewery')));
  });

  it('names stacks for the router after the branch, as one DNS label', () => {
    const info = (branch: string | null, root = 'D:/p/homebrewery.x') => ({ root, commonDir: null, main: false, branch, slot: 2 });
    expect(stackHost(info('master'))).toBe('master');
    expect(stackHost(info('claude/Fix Pagination_2'))).toBe('claude-fix-pagination-2');
    expect(stackHost(info(null, 'D:/a/homebrewery.pdf'))).toBe('homebrewery-pdf');
    expect(stackHost(info('x'.repeat(80)))).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  });

  it('serves master without a branch in the URL and other branches under homebrewery', () => {
    expect(stackUrl('master')).toBe('http://homebrewery.dev.localhost');
    expect(stackUrl('claude-fix-x')).toBe('http://claude-fix-x.homebrewery.dev.localhost');
    expect(stackUrl('claude-fix-x', '8000')).toBe('http://claude-fix-x.homebrewery.dev.localhost:8000');
  });
});
