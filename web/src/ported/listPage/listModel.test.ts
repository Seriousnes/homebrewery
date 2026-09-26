import { describe, expect, it } from 'vitest';
import type { BrewSummary } from '@/api';
import {
  countSummary,
  deburr,
  defaultDirFor,
  dirLabel,
  filterBrews,
  groupUserBrews,
  parseListSort,
  possessive,
  readListQuery,
  sortBrews,
  sortTags,
  tagParts,
  toggleTag,
  visibleGroups,
  writeListQuery,
} from './listModel';
import { summary } from './testing';

const ids = (brews: BrewSummary[]) => brews.map((b) => b.shareId);

describe('deburr', () => {
  it('drops accents and spells out ligatures, like lodash', () => {
    expect(deburr('Épée déjà vu')).toBe('Epee deja vu');
    expect(deburr('Straße Æsir Øre œuvre Łódź')).toBe('Strasse Aesir Ore oeuvre Lodz');
    expect(deburr('plain')).toBe('plain');
  });
});

describe('sortBrews', () => {
  const a = summary('a', { title: 'Épée', createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', views: 5, pageCount: 2 });
  const b = summary('b', { title: 'dragon 10', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z', views: 50, pageCount: 1 });
  const c = summary('c', { title: 'Dragon 9', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', views: 0, pageCount: 30 });
  const d = summary('d', { title: '   ', createdAt: '2026-01-04T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z', views: 5, pageCount: 2 });

  it('sorts titles ignoring case and accents, numbers naturally; blank titles as "Untitled brew"', () => {
    expect(ids(sortBrews([a, b, c, d], 'title', 'asc'))).toEqual(['c', 'b', 'a', 'd']);
    expect(ids(sortBrews([a, b, c, d], 'title', 'desc'))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('sorts by dates, views and page count; ties go to the most recently updated', () => {
    expect(ids(sortBrews([a, b, c, d], 'created', 'asc'))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(sortBrews([a, b, c, d], 'updated', 'desc'))).toEqual(['b', 'a', 'd', 'c']);
    expect(ids(sortBrews([a, b, c, d], 'views', 'desc'))).toEqual(['b', 'a', 'd', 'c']);
    expect(ids(sortBrews([a, b, c, d], 'views', 'asc'))).toEqual(['c', 'a', 'd', 'b']);
    expect(ids(sortBrews([a, b, c, d], 'pages', 'desc'))).toEqual(['c', 'a', 'd', 'b']);
  });

  it('does not change its input', () => {
    const input = [a, b, c];
    sortBrews(input, 'title', 'desc');
    expect(ids(input)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterBrews', () => {
  const brews = [
    summary('a', { title: 'The Épée Guild', tags: ['type:Adventure', 'Fighters'] }),
    summary('b', { title: 'Sea', description: 'A coastal EPEE duel', tags: ['type:adventure'] }),
    summary('c', { title: 'Nothing', tags: ['system:D&D 5e'] }),
  ];

  it('matches title, description and tags, ignoring case and accents', () => {
    expect(ids(filterBrews(brews, 'epee', []))).toEqual(['a', 'b']);
    expect(ids(filterBrews(brews, 'd&d', []))).toEqual(['c']);
    expect(ids(filterBrews(brews, '  fighters ', []))).toEqual(['a']);
    expect(ids(filterBrews(brews, '', []))).toEqual(['a', 'b', 'c']);
  });

  it('keeps brews that have every selected tag (case ignored)', () => {
    expect(ids(filterBrews(brews, '', ['TYPE:ADVENTURE']))).toEqual(['a', 'b']);
    expect(ids(filterBrews(brews, '', ['type:Adventure', 'fighters']))).toEqual(['a']);
    expect(ids(filterBrews(brews, 'sea', ['type:Adventure']))).toEqual(['b']);
  });
});

describe('tags', () => {
  it('toggles case-insensitively and keeps click order', () => {
    expect(toggleTag(['a', 'B'], 'c')).toEqual(['a', 'B', 'c']);
    expect(toggleTag(['a', 'B'], 'b')).toEqual(['a']);
    expect(toggleTag(['a'], '  ')).toEqual(['a']);
  });

  it("sorts like upstream: plain tags first, then by the colon's position, then alphabetically", () => {
    expect(sortTags(['type:x', 'zeta', 'meta:theme', 'Alpha', '', 'system:D&D 5e'])).toEqual(['Alpha', 'zeta', 'meta:theme', 'type:x', 'system:D&D 5e']);
  });

  it('splits prefix and value', () => {
    expect(tagParts('type:Adventure')).toEqual({ prefix: 'type', value: 'Adventure' });
    expect(tagParts('plain')).toEqual({ prefix: null, value: 'plain' });
    expect(tagParts('a:b:c')).toEqual({ prefix: null, value: 'a:b:c' });
  });
});

describe('the URL query', () => {
  const prefs = { sort: 'views', dir: 'desc' } as const;

  it('reads sort, dir, filter and tags; falls back to the stored preference', () => {
    const state = readListQuery(new URLSearchParams('sort=alpha&dir=ASC&filter=dragon&tag=a&tag=A&tag=b&tag=%20'), prefs);
    expect(state).toEqual({ filter: 'dragon', tags: ['a', 'b'], sort: 'title', dir: 'asc' });
    expect(readListQuery(new URLSearchParams('sort=nonsense&dir=up'), prefs)).toEqual({ filter: '', tags: [], sort: 'views', dir: 'desc' });
  });

  it('writes the state and keeps other parameters', () => {
    const out = writeListQuery(new URLSearchParams('x=1&filter=old&tag=old'), { filter: 'new', tags: ['t2', 't1'], sort: 'pages', dir: 'asc' });
    expect(out.toString()).toBe('x=1&sort=pages&dir=asc&filter=new&tag=t2&tag=t1');
    expect(writeListQuery(new URLSearchParams(), { filter: '  ', tags: [], sort: 'title', dir: 'desc' }).toString()).toBe('sort=title&dir=desc');
  });

  it('accepts upstream sort names', () => {
    expect(parseListSort('alpha')).toBe('title');
    expect(parseListSort('createdAt')).toBe('created');
    expect(parseListSort('updatedAt')).toBe('updated');
    expect(parseListSort('pageCount')).toBe('pages');
    expect(parseListSort('latest')).toBeNull();
  });

  it('names directions per sort', () => {
    expect(defaultDirFor('title')).toBe('asc');
    expect(defaultDirFor('views')).toBe('desc');
    expect(dirLabel('title', 'asc')).toBe('A to Z');
    expect(dirLabel('updated', 'desc')).toBe('newest first');
    expect(dirLabel('pages', 'asc')).toBe('fewest first');
    expect(dirLabel('relevance', 'desc')).toBe('best match first');
  });
});

describe('groups', () => {
  it("shows other people only the published group, named with upstream's possessive", () => {
    const groups = groupUserBrews({ handle: 'james', own: false, items: [summary('a')] });
    expect(groups.map((g) => [g.id, g.title, ids(g.brews)])).toEqual([['published', 'james’ published brews', ['a']]]);
    expect(possessive('alice')).toBe('alice’s');
  });

  it('splits the owner’s list into published, unpublished and invited (only when invited)', () => {
    const items = [
      summary('p', { role: 'owner', published: true, editId: 'ep' }),
      summary('u', { role: 'author', published: false, editId: 'eu' }),
      summary('i', { role: 'invited', published: true, editId: 'ei' }),
    ];
    const groups = groupUserBrews({ handle: 'alice', own: true, items });
    expect(groups.map((g) => [g.id, ids(g.brews)])).toEqual([
      ['published', ['p']],
      ['unpublished', ['u']],
      ['invited', ['i']],
    ]);
    expect(groupUserBrews({ handle: 'alice', own: true, items: items.slice(0, 2) }).map((g) => g.id)).toEqual(['published', 'unpublished']);
  });

  it('filters and sorts every group', () => {
    const groups = groupUserBrews({ handle: 'alice', own: true, items: [summary('b', { role: 'owner' }), summary('a', { role: 'owner' }), summary('x', { role: 'owner', published: false })] });
    const shown = visibleGroups(groups, { filter: '', tags: [], sort: 'title', dir: 'asc' });
    expect(shown.map((g) => ids(g.brews))).toEqual([['a', 'b'], ['x']]);
    expect(visibleGroups(groups, { filter: 'a', tags: [], sort: 'title', dir: 'asc' }).map((g) => ids(g.brews))).toEqual([['a'], []]);
  });

  it('summarises counts', () => {
    expect(countSummary(1, 1)).toBe('1 brew');
    expect(countSummary(1200, 1200)).toBe('1,200 brews');
    expect(countSummary(3, 12)).toBe('Showing 3 of 12 brews');
    expect(countSummary(12, 12, true)).toBe('Showing 12 of 12 brews');
  });
});
