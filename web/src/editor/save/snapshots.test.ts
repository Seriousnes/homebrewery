// snapshots.ts: the rolling local history ported from legacy versionHistory.js (plan §9).
import { describe, expect, it } from 'vitest';
import { DOC_SCHEMA_VERSION } from '../schema/version';
import { SNAPSHOT_SLOT_MINUTES, snapshotKey, type SnapshotInput } from './snapshots';
import { docOf, memorySnapshots } from './testing';

const MINUTE = 60_000;

function input(text: string, version: number, brewKey = 'edit-1'): SnapshotInput {
  return { brewKey, title: text, version, docSchemaVersion: DOC_SCHEMA_VERSION, doc: docOf(text), style: '', snippets: null, meta: null };
}

function setup() {
  const clock = { t: Date.parse('2026-09-25T10:00:00.000Z') };
  const { store, history } = memorySnapshots(() => clock.t);
  const titles = async (brewKey = 'edit-1') => (await history.load(brewKey)).map((s) => s?.title ?? null);
  return { clock, store, history, titles };
}

describe('snapshot history', () => {
  it('fills the five slots with the first five saves, newest first', async () => {
    const { history, titles } = setup();
    for (let v = 1; v <= 5; v++) expect(await history.update(input(`v${v}`, v))).toBe(true);
    expect(await titles()).toEqual(['v5', 'v4', 'v3', 'v2', 'v1']);
    expect((await history.list('edit-1')).map((s) => s.version)).toEqual([5, 4, 3, 2, 1]);
  });

  it('skips a save while every slot is still fresh (slot 1 keeps its place for 2 minutes)', async () => {
    const { clock, history, titles } = setup();
    for (let v = 1; v <= 5; v++) await history.update(input(`v${v}`, v));
    clock.t += MINUTE;
    expect(await history.update(input('v6', 6))).toBe(false);
    expect(await titles()).toEqual(['v5', 'v4', 'v3', 'v2', 'v1']);
  });

  it('overwrites the highest expired slot and shifts the newer ones up', async () => {
    const { clock, history, titles } = setup();
    for (let v = 1; v <= 5; v++) await history.update(input(`v${v}`, v));
    // After 11 minutes slots 1 (2 min) and 2 (10 min) have expired, 3 (1 h) has not: slot 2 is
    // the highest expired one, so v4 (in slot 2) is dropped and v5 moves to slot 2.
    clock.t += 11 * MINUTE;
    expect(await history.update(input('v6', 6))).toBe(true);
    expect(await titles()).toEqual(['v6', 'v5', 'v3', 'v2', 'v1']);
  });

  it('gives a moved snapshot the expiry of its new slot and keeps its savedAt', async () => {
    const { clock, history } = setup();
    const start = clock.t;
    await history.update(input('v1', 1));
    clock.t += 3 * MINUTE;
    await history.update(input('v2', 2));
    const [first, second] = await history.load('edit-1');
    expect(first).toMatchObject({ title: 'v2', slot: 1, expireAt: clock.t + SNAPSHOT_SLOT_MINUTES[1]! * MINUTE });
    expect(second).toMatchObject({ title: 'v1', slot: 2, savedAt: start, expireAt: clock.t + SNAPSHOT_SLOT_MINUTES[2]! * MINUTE });
  });

  it('stores anyway with force (dropping the oldest), for the version a conflict replaces', async () => {
    const { history, titles } = setup();
    for (let v = 1; v <= 5; v++) await history.update(input(`v${v}`, v));
    expect(await history.update(input('mine', 0), { force: true })).toBe(true);
    expect(await titles()).toEqual(['mine', 'v5', 'v4', 'v3', 'v2']);
  });

  it('keeps brews apart and stores JSON documents', async () => {
    const { store, history } = setup();
    await history.update(input('a', 1, 'brew-a'));
    await history.update(input('b', 1, 'brew-b'));
    expect((await history.list('brew-a')).map((s) => s.title)).toEqual(['a']);
    expect(store.map.get(snapshotKey('brew-b', 1))?.doc).toEqual(docOf('b'));
  });

  it('garbage-collects snapshots saved more than 28 days ago', async () => {
    const { clock, store, history } = setup();
    await history.update(input('old', 1, 'brew-a'));
    clock.t += 20 * 24 * 60 * MINUTE;
    await history.update(input('recent', 1, 'brew-b'));
    clock.t += 9 * 24 * 60 * MINUTE;
    expect(await history.collectGarbage()).toBe(1);
    expect([...store.map.keys()]).toEqual([snapshotKey('brew-b', 1)]);
  });

  it('ignores malformed entries', async () => {
    const { store, history } = setup();
    await store.set(snapshotKey('edit-1', 1), { nonsense: true } as never);
    expect(await history.list('edit-1')).toEqual([]);
    expect(await history.update(input('v1', 1))).toBe(true);
  });
});
