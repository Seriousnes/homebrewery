import { describe, expect, it } from 'vitest';
import { clearImportSession, IMPORT_SESSION_KEY, type ImportSession, parseImportSession, readImportSession, writeImportSession } from './importSession';

function memoryStore(limit = Infinity) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new DOMException('full', 'QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  };
}

const session: ImportSession = {
  tab: 'file',
  paste: '# Pasted',
  link: 'abcdefghij',
  loaded: { kind: 'file', text: '# From a file', label: 'brew.txt', note: 'Windows-1252' },
};

describe('import session', () => {
  it('round-trips', () => {
    const store = memoryStore();
    expect(writeImportSession(session, store)).toBe(true);
    expect(readImportSession(store)).toEqual(session);
    clearImportSession(store);
    expect(readImportSession(store)).toBeNull();
  });

  it('stores a loaded paste only once', () => {
    const store = memoryStore();
    const pasted: ImportSession = { tab: 'paste', paste: '# Big text', link: '', loaded: { kind: 'paste', text: '# Big text', label: 'Pasted text' } };
    writeImportSession(pasted, store);
    expect(store.map.get(IMPORT_SESSION_KEY)?.match(/# Big text/g)).toHaveLength(1);
    expect(readImportSession(store)).toEqual(pasted);
  });

  it('drops the loaded text when the session does not fit, then everything', () => {
    const store = memoryStore(200);
    const big: ImportSession = { ...session, loaded: { kind: 'file', text: 'x'.repeat(500), label: 'big.txt' } };
    expect(writeImportSession(big, store)).toBe(true);
    expect(readImportSession(store)).toEqual({ ...big, loaded: null });
    const huge: ImportSession = { ...big, paste: 'y'.repeat(500) };
    expect(writeImportSession(huge, store)).toBe(false);
    expect(readImportSession(store)).toBeNull();
  });

  it('survives blocked storage and bad data', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readImportSession(blocked)).toBeNull();
    expect(writeImportSession(session, blocked)).toBe(false);
    expect(() => clearImportSession(blocked)).not.toThrow();
    expect(writeImportSession(session, null)).toBe(false);
    expect(parseImportSession('not json')).toBeNull();
    expect(parseImportSession('{"v":2}')).toBeNull();
    expect(parseImportSession('null')).toBeNull();
    expect(parseImportSession('{"v":1,"tab":"evil","paste":5,"loaded":{"kind":"x","text":"t"}}')).toEqual({ tab: 'paste', paste: '', link: '', loaded: null });
  });
});
