import { describe, expect, it, vi } from 'vitest';
import { type Draft, NEW_DRAFT_KEY } from '../save/drafts';
import { memoryStore } from '../save/kvStore';
import { draftOf } from '../save/testing';
import {
  countPages,
  createLocalBrewLibrary,
  isLocalBrew,
  LOCAL_BREW_FORMAT,
  type LocalBrew,
  type LocalBrewSummary,
  localMeta,
  migrateAnonymousNewDraft,
  newLocalBrewId,
  onLocalBrewsChanged,
  requestPersistentStorage,
} from './localBrews';

const page = (text: string) => ({ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function brew(id: string, updatedAt: number, pages = 1): LocalBrew {
  return {
    v: LOCAL_BREW_FORMAT,
    id,
    createdAt: 1,
    updatedAt,
    docSchemaVersion: 1,
    doc: { type: 'doc', content: Array.from({ length: pages }, (_, i) => page(`p${i}`)) },
    style: '.page {}',
    snippets: null,
    meta: localMeta({ title: `Brew ${id}` }),
  };
}

function library() {
  const brews = memoryStore<LocalBrew>();
  const index = memoryStore<LocalBrewSummary>();
  return { brews, index, lib: createLocalBrewLibrary(brews, index) };
}

describe('the local brew library', () => {
  it('stores, reads, lists newest first and removes brews; the list reads summaries, not documents', async () => {
    const { brews, lib } = library();
    await lib.save(brew('a', 10, 2));
    await lib.save(brew('b', 30));
    await lib.save(brew('c', 20));
    expect((await lib.get('a'))?.meta.title).toBe('Brew a');
    const getMany = vi.spyOn(brews, 'getMany');
    const list = await lib.list();
    expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(list.at(-1)).toMatchObject({ id: 'a', title: 'Brew a', theme: '5ePHB', pages: 2, updatedAt: 10 });
    expect(getMany).not.toHaveBeenCalled();
    await lib.remove('c');
    expect(await lib.get('c')).toBeNull();
    expect(await lib.count()).toBe(2);
  });

  it('repairs the index: a missing summary is rebuilt, one without its brew is dropped', async () => {
    const { brews, index, lib } = library();
    await brews.set('lost', brew('lost', 5)); // written, but the summary never was
    await index.set('gone', { id: 'gone', title: 'Gone', theme: '5ePHB', pages: 1, createdAt: 1, updatedAt: 99 });
    expect((await lib.list()).map((s) => s.id)).toEqual(['lost']);
    expect(await index.get('lost')).toMatchObject({ title: 'Brew lost' });
    expect(await index.get('gone')).toBeUndefined();
  });

  it('reads unreadable records as missing', async () => {
    const { brews, lib } = library();
    await brews.set('junk', { v: 99 } as unknown as LocalBrew);
    expect(await lib.get('junk')).toBeNull();
    expect(isLocalBrew({ ...brew('x', 1), id: 'no/slashes' })).toBe(false);
    expect(isLocalBrew(brew('x', 1))).toBe(true);
  });

  it('tells listeners about saves and removals', async () => {
    const { lib } = library();
    const heard = vi.fn();
    const stop = onLocalBrewsChanged(heard);
    await lib.save(brew('a', 1));
    await lib.remove('a');
    stop();
    await lib.save(brew('b', 1));
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('helpers', () => {
  it('makes URL-safe random ids', () => {
    const ids = new Set(Array.from({ length: 50 }, newLocalBrewId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('fills metadata defaults and counts pages', () => {
    expect(localMeta({ title: 'T', tags: ['a', 3], lang: '' })).toEqual({ title: 'T', description: '', tags: ['a'], lang: 'en', theme: '5ePHB' });
    expect(countPages({ type: 'doc', content: [page('a'), { type: 'paragraph' }, page('b')] })).toBe(2);
  });

  it('asks for persistent storage once per storage, and copes without the API', async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    const storage = { persist, persisted: () => Promise.resolve(false) } as unknown as StorageManager;
    expect(await requestPersistentStorage(storage)).toBe(true);
    expect(await requestPersistentStorage(storage)).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    const kept = { persist: vi.fn(), persisted: () => Promise.resolve(true) } as unknown as StorageManager;
    expect(await requestPersistentStorage(kept)).toBe(true);
    expect(await requestPersistentStorage({} as StorageManager)).toBeNull();
  });
});

describe('migrateAnonymousNewDraft', () => {
  const draft = (overrides: Partial<Draft>) =>
    draftOf({ key: NEW_DRAFT_KEY, editId: null, baseVersion: null, doc: { type: 'doc', content: [page('Old words')] }, updatedAt: 1_700_000_000_000, ...overrides });

  it("turns an anonymous visitor's /new draft into a local brew and deletes the draft", async () => {
    const drafts = memoryStore<Draft>();
    await drafts.set(NEW_DRAFT_KEY, draft({ ownerId: null, meta: { title: 'Old title', theme: '5eDMG' } }));
    const { lib } = library();
    const id = await migrateAnonymousNewDraft(drafts, lib);
    expect(id).toBe(`draft-${(1_700_000_000_000).toString(36)}`);
    const stored = await lib.get(id!);
    expect(stored?.meta).toMatchObject({ title: 'Old title', theme: '5eDMG' });
    expect(JSON.stringify(stored?.doc)).toContain('Old words');
    expect(await drafts.get(NEW_DRAFT_KEY)).toBeUndefined();
    // Two tabs migrating the same draft write one brew.
    await lib.save(stored!);
    expect(await lib.count()).toBe(1);
  });

  it("leaves a signed-in user's draft, one with a create chain, and none at all", async () => {
    const { lib } = library();
    for (const overrides of [{ ownerId: 'user-1' }, { ownerId: null, createKey: 'k1' }]) {
      const drafts = memoryStore<Draft>();
      await drafts.set(NEW_DRAFT_KEY, draft(overrides));
      expect(await migrateAnonymousNewDraft(drafts, lib)).toBeNull();
      expect(await drafts.get(NEW_DRAFT_KEY)).toBeDefined();
    }
    expect(await migrateAnonymousNewDraft(memoryStore<Draft>(), lib)).toBeNull();
    expect(await lib.count()).toBe(0);
  });
});
