import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dockerSlug, registerSlot, slotPort, slotTmp, stackName } from './worktree';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-worktree-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
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
    expect(stackName({ root: 'D:/p/homebrewery.x', commonDir: null, main: false, branch: null, slot: 2 })).toBe('hb-homebrewery-x');
  });
});
