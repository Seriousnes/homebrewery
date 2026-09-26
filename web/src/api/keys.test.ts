import { describe, expect, it } from 'vitest';
import { parseUpstreamShareId } from './importUpstream';
import { normalizeHandle, normalizeVaultParams, queryKeys } from './keys';

describe('query keys', () => {
  it('normalises vault params so equivalent searches share a key', () => {
    expect(queryKeys.vault.search({})).toEqual(queryKeys.vault.search({ q: '  ', page: 1 }));
    expect(normalizeVaultParams({ q: ' dragon ', author: ' Bob ', page: 3, sort: 'title', dir: 'asc', pageSize: 40 })).toEqual({
      q: 'dragon',
      author: 'bob',
      page: 3,
      sort: 'title',
      dir: 'asc',
      pageSize: 40,
    });
  });

  it('normalises handles', () => {
    expect(normalizeHandle('  Alice ')).toBe('alice');
    expect(queryKeys.users.brews('Alice')).toEqual(['users', 'alice', 'brews']);
  });

  it('nests admin keys under prefixes used for invalidation', () => {
    expect(queryKeys.admin.reviewQueue().slice(0, 2)).toEqual([...queryKeys.admin.locks()]);
    expect(queryKeys.admin.brew('x').slice(0, 2)).toEqual([...queryKeys.admin.brews]);
    expect(queryKeys.admin.notification('n').slice(0, 2)).toEqual([...queryKeys.admin.notifications]);
    expect(queryKeys.brews.edit('e')[0]).toBe(queryKeys.brews.all[0]);
  });
});

describe('parseUpstreamShareId', () => {
  it('accepts bare ids and upstream URLs', () => {
    expect(parseUpstreamShareId('abcDEF12345')).toBe('abcDEF12345');
    expect(parseUpstreamShareId(' https://homebrewery.naturalcrit.com/share/abcDEF12345 ')).toBe('abcDEF12345');
    expect(parseUpstreamShareId('https://homebrewery.naturalcrit.com/download/a_b-c1234567')).toBe('a_b-c1234567');
    expect(parseUpstreamShareId('homebrewery.naturalcrit.com/source/abcDEF12345')).toBe('abcDEF12345');
  });

  it('rejects ids of the wrong length or charset and other paths', () => {
    expect(parseUpstreamShareId('short')).toBeNull();
    expect(parseUpstreamShareId('x'.repeat(15))).toBeNull();
    expect(parseUpstreamShareId('https://homebrewery.naturalcrit.com/edit/abcDEF12345')).toBeNull();
    expect(parseUpstreamShareId('https://homebrewery.naturalcrit.com/share/abc DEF12345')).toBeNull();
    expect(parseUpstreamShareId('')).toBeNull();
  });
});
