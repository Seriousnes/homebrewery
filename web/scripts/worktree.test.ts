import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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
    const old = new Date('2026-09-28T12:00:00Z');
    fs.utimesSync(lock, old, old);
    expect(registerSlot(common, tempDir(), () => old.getTime() + 60_000)).toBe(1); // a minute later
  });
});

describe('readWorktreeInfo', () => {
  // git prints real paths (macOS /private/var, Windows drive letter case).
  const real = (dir: string) => {
    const p = fs.realpathSync.native(dir).replace(/\\/g, '/');
    return process.platform === 'win32' ? p.toLowerCase() : p;
  };
  const lower = (p: string | null) => (p && process.platform === 'win32' ? p.toLowerCase() : p);
  const fwd = (p: string) => path.resolve(p).replace(/\\/g, '/');
  const summary = (info: ReturnType<typeof readWorktreeInfo>) => [lower(info.root), lower(info.commonDir), info.main, info.branch, info.slot];

  /**
   * A repository with one empty commit on master and a linked worktree on feature/x, written in
   * git's on-disk format instead of by git init, commit and worktree add: the only git processes
   * are the rev-parse calls under test.
   */
  function fixtureRepo(): { main: string; linked: string } {
    const main = path.join(tempDir(), 'repo');
    const linked = path.join(path.dirname(main), 'linked');
    const gitDir = path.join(main, '.git');
    const write = (file: string, text: string | Buffer) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    const object = (type: string, body: string): string => {
      const data = Buffer.concat([Buffer.from(`${type} ${Buffer.byteLength(body)}\0`), Buffer.from(body)]);
      const id = createHash('sha1').update(data).digest('hex');
      write(path.join(gitDir, 'objects', id.slice(0, 2), id.slice(2)), zlib.deflateSync(data));
      return id;
    };
    const commit = object('commit', `tree ${object('tree', '')}\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\n\ninit\n`);
    write(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
    write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/master\n');
    write(path.join(gitDir, 'refs', 'heads', 'master'), `${commit}\n`);
    write(path.join(gitDir, 'refs', 'heads', 'feature', 'x'), `${commit}\n`);
    fs.mkdirSync(path.join(gitDir, 'refs', 'tags'), { recursive: true });
    const admin = path.join(gitDir, 'worktrees', 'linked');
    write(path.join(admin, 'HEAD'), 'ref: refs/heads/feature/x\n');
    write(path.join(admin, 'commondir'), '../..\n');
    write(path.join(admin, 'gitdir'), `${fwd(linked)}/.git\n`);
    write(path.join(linked, '.git'), `gitdir: ${fwd(admin)}\n`);
    fs.mkdirSync(path.join(main, 'web', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(linked, 'web', 'scripts'), { recursive: true });
    return { main, linked };
  }

  it('finds the main checkout and a linked worktree from a subfolder, with real git', () => {
    vi.stubEnv('HB_SLOT', '');
    const { main, linked } = fixtureRepo();
    // From a subfolder of the main checkout git prints a relative --git-common-dir (../../.git): relative to the cwd.
    expect(summary(readWorktreeInfo(path.join(main, 'web', 'scripts')))).toEqual([real(main), `${real(main)}/.git`, true, 'master', 0]);
    expect(summary(readWorktreeInfo(path.join(linked, 'web', 'scripts')))).toEqual([real(linked), `${real(main)}/.git`, false, 'feature/x', 1]);
  });

  // What git prints, recorded: the rules on top of it without running git.
  it('reads a relative common dir against the cwd, and gives the main checkout slot 0', () => {
    vi.stubEnv('HB_SLOT', '');
    const top = fwd(tempDir());
    const info = readWorktreeInfo(`${top}/web/scripts`, () => [top, '../../.git', 'master']);
    expect(summary(info)).toEqual([lower(top), lower(`${top}/.git`), true, 'master', 0]);
  });

  it('registers a linked worktree for a slot, and reads a detached HEAD as no branch', () => {
    vi.stubEnv('HB_SLOT', '');
    const common = fwd(tempDir());
    const linked = fwd(tempDir());
    expect(summary(readWorktreeInfo(linked, () => [linked, common, 'HEAD']))).toEqual([lower(linked), lower(common), false, null, 1]);
    expect(readWorktreeInfo(linked, () => [linked, common, 'feature/x']).slot).toBe(1); // kept
  });

  it('without git, is the main checkout of this repository', () => {
    vi.stubEnv('HB_SLOT', '');
    const info = readWorktreeInfo(tempDir(), () => null);
    expect([info.commonDir, info.main, info.branch, info.slot]).toEqual([null, true, null, 0]);
    expect(lower(info.root)).toBe(lower(fwd(path.join(import.meta.dirname, '..', '..'))));
  });

  it('takes HB_SLOT over the registry, and refuses one out of range', () => {
    const linked = fwd(tempDir());
    const rev = () => [linked, fwd(tempDir()), 'x'];
    vi.stubEnv('HB_SLOT', '3');
    expect(readWorktreeInfo(linked, rev).slot).toBe(3);
    vi.stubEnv('HB_SLOT', '41');
    expect(() => readWorktreeInfo(linked, rev)).toThrow(/HB_SLOT must be a whole number from 0 to 40/);
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
