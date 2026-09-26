// The create signal (newBrewCreates.ts) and the create chain helpers (createChain.ts), SAVE-8.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainOf, newCreateKey } from './createChain';
import { createdFromDraft, pendingNewBrewCreates, resetNewBrewCreates, trackNewBrewCreate } from './newBrewCreates';
import { docOf, draftOf } from './testing';

afterEach(() => {
  resetNewBrewCreates();
  vi.unstubAllGlobals();
});

describe('the create signal', () => {
  it('tracks a create until it is settled, once', async () => {
    const handle = trackNewBrewCreate('k1', 1000);
    const [create] = pendingNewBrewCreates();
    expect(create).toMatchObject({ key: 'k1', startedAt: 1000, status: 'pending', editId: null });
    handle.created('brew-1');
    handle.failed(); // too late: settled already
    await create!.settled;
    expect(create).toMatchObject({ status: 'created', editId: 'brew-1' });
    expect(pendingNewBrewCreates()).toEqual([]);
  });

  it('a retry with the same key replaces the earlier attempt', () => {
    trackNewBrewCreate('k1', 1000).failed();
    trackNewBrewCreate('k1', 2000);
    expect(pendingNewBrewCreates()).toMatchObject([{ key: 'k1', startedAt: 2000 }]);
  });

  it('a draft was turned into a brew when a created brew sent its key or started after it was written', () => {
    trackNewBrewCreate('k1', 5000).created('brew-1');
    trackNewBrewCreate('k2', 9000).failed();
    const newDraft = (createKey: string | null, updatedAt: number) =>
      draftOf({ key: 'new', editId: null, baseVersion: null, createKey, updatedAt });
    expect(createdFromDraft(newDraft('k1', 7000))?.editId).toBe('brew-1'); // its key
    expect(createdFromDraft(newDraft(null, 5000))?.editId).toBe('brew-1'); // written before the POST
    expect(createdFromDraft(newDraft(null, 5001))).toBeNull(); // written after it started
    expect(createdFromDraft(newDraft('k2', 1000))?.editId).toBe('brew-1'); // older than a created brew
    expect(createdFromDraft(newDraft('k2', 9500))).toBeNull(); // its own create failed
  });

  it('keeps a bounded number of settled creates, never dropping a pending one', () => {
    const running = trackNewBrewCreate('running', 1);
    for (let i = 0; i < 40; i++) trackNewBrewCreate(`k${i}`, 10 + i).failed();
    expect(pendingNewBrewCreates().map((c) => c.key)).toEqual(['running']);
    running.created('b');
    expect(createdFromDraft({ createKey: 'running', updatedAt: Number.MAX_SAFE_INTEGER })?.editId).toBe('b');
  });
});

describe('create chains', () => {
  const newDraft = draftOf({ key: 'new', editId: null, baseVersion: null, createKey: 'k1', doc: docOf('Now') });

  it("a new brew's draft with a key is a chain; its pending body (no pendingVersion) goes with it", () => {
    expect(createChainOf(newDraft)).toEqual({ key: 'k1', pending: null, docSchemaVersion: newDraft.docSchemaVersion });
    const pending = { doc: docOf('Sent'), style: '', snippets: null, meta: null };
    expect(createChainOf({ ...newDraft, pending })).toMatchObject({ key: 'k1', pending });
  });

  it('no key, an existing brew, or no draft: no chain', () => {
    expect(createChainOf(null)).toBeNull();
    expect(createChainOf({ ...newDraft, createKey: null })).toBeNull();
    expect(createChainOf(draftOf({ createKey: 'k1' }))).toBeNull();
  });

  it('keys are UUIDs, with a fallback where randomUUID is missing (insecure origins)', () => {
    expect(newCreateKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newCreateKey()).not.toBe(newCreateKey());
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
    expect(newCreateKey()).toBe('07'.repeat(16));
    vi.stubGlobal('crypto', undefined);
    expect(newCreateKey()).toMatch(/^[0-9a-f]{32}$/);
  });
});
