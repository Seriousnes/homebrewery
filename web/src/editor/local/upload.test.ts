import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { memoryStore } from '../save/kvStore';
import { createLocalBrewLibrary, LOCAL_BREW_FORMAT, type LocalBrew, type LocalBrewSummary, localMeta } from './localBrews';
import { uploadKey, uploadLocalBrew, uploadLocalBrews, uploadProblem } from './upload';

afterEach(() => {
  vi.unstubAllGlobals();
});

const brew = (id: string, extra: Partial<LocalBrew> = {}): LocalBrew => ({
  v: LOCAL_BREW_FORMAT,
  id,
  createdAt: 1,
  updatedAt: 1_700_000_000_000,
  docSchemaVersion: 1,
  doc: { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph' }] }] },
  style: '.page { color: red; }',
  snippets: [{ name: 'S', gen: 'x' }],
  meta: localMeta({ title: `Brew ${id}`, tags: ['t'], theme: '5eDMG', lang: 'fr' }),
  ...extra,
});

async function libraryWith(...brews: LocalBrew[]) {
  const lib = createLocalBrewLibrary(memoryStore<LocalBrew>(), memoryStore<LocalBrewSummary>());
  for (const b of brews) await lib.save(b);
  return lib;
}

const created = (editId: string) => ({ editId, shareId: `s-${editId}`, version: 1, meta: { title: 'x' } });

describe('uploadLocalBrew', () => {
  it('creates the brew (unpublished, with its import text) under a key made from the brew, then removes the local copy', async () => {
    const api = mockApi(() => jsonResponse(created('e1'), 201));
    const library = await libraryWith(brew('a', { sourceMarkdown: '# Imported' }));

    const result = await uploadLocalBrew('a', { library });

    expect(result.editId).toBe('e1');
    const request = api.last();
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/brews');
    expect(request.headers.get('Idempotency-Key')).toBe(uploadKey(brew('a')));
    expect(request.json).toMatchObject({
      docSchemaVersion: 1,
      style: '.page { color: red; }',
      snippets: [{ name: 'S', gen: 'x' }],
      sourceMarkdown: '# Imported',
      meta: { title: 'Brew a', tags: ['t'], theme: '5eDMG', lang: 'fr', published: false },
    });
    expect(await library.get('a')).toBeNull();
  });

  it('keeps the brew when the upload fails, and says why', async () => {
    mockApi(() => problemResponse(429, { title: 'Too many requests', detail: 'Try again in 30 seconds.' }));
    const library = await libraryWith(brew('a'));
    const error = await uploadLocalBrew('a', { library }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(uploadProblem(error)).toContain('Too many requests');
    expect(await library.get('a')).not.toBeNull();
    await expect(uploadLocalBrew('missing', { library })).rejects.toThrow('no longer on this device');
  });

  it('a changed brew gets a new key; the same content keeps it', () => {
    expect(uploadKey(brew('a'))).toBe(uploadKey(brew('a')));
    expect(uploadKey({ id: 'a', updatedAt: 2 })).not.toBe(uploadKey({ id: 'a', updatedAt: 3 }));
    expect(uploadKey({ id: 'x'.repeat(64), updatedAt: Date.now() }).length).toBeLessThanOrEqual(128);
  });
});

describe('uploadLocalBrews', () => {
  it('uploads one at a time and reports the ones that failed (they stay)', async () => {
    let n = 0;
    mockApi(() => (++n === 2 ? problemResponse(500, { title: 'Server error' }) : jsonResponse(created(`e${n}`), 201)));
    const library = await libraryWith(brew('a'), brew('b'), brew('c'));

    const result = await uploadLocalBrews(['a', 'b', 'c'], { library });

    expect(result.uploaded.map((b) => b.editId)).toEqual(['e1', 'e3']);
    expect(result.failed.map((f) => f.id)).toEqual(['b']);
    expect((await library.list()).map((s) => s.id)).toEqual(['b']);
  });
});
