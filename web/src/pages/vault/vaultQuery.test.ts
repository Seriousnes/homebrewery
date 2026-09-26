import { describe, expect, it } from 'vitest';
import { effectiveDir, effectiveSort, pageWindow, readVaultQuery, totalPages, vaultSearchParams, writeVaultQuery } from './vaultQuery';

const read = (search: string) => readVaultQuery(new URLSearchParams(search));

describe('vault URL state', () => {
  it('reads the query with defaults', () => {
    expect(read('')).toEqual({ q: '', author: '', sort: null, dir: null, page: 1, pageSize: 20 });
    expect(read('q=dragon&author=Alice&sort=Views&dir=ASC&page=3&pageSize=40')).toEqual({
      q: 'dragon',
      author: 'Alice',
      sort: 'views',
      dir: 'asc',
      page: 3,
      pageSize: 40,
    });
  });

  it("reads upstream's vault links (title, count, createdAt)", () => {
    expect(read('title=giant&author=bob&count=10&v3=true&legacy=false&page=2&sort=createdAt&dir=desc')).toEqual({
      q: 'giant',
      author: 'bob',
      sort: 'created',
      dir: 'desc',
      page: 2,
      pageSize: 10,
    });
    expect(read('sort=updatedAt').sort).toBe('updated');
  });

  it('ignores or clamps bad numbers and names', () => {
    expect(read('page=0&pageSize=-5&sort=best&dir=up')).toMatchObject({ page: 1, pageSize: 20, sort: null, dir: null });
    expect(read('page=2.5&pageSize=1e3')).toMatchObject({ page: 1, pageSize: 20 });
    expect(read('page=99999999&pageSize=500')).toMatchObject({ page: 10000, pageSize: 60 });
  });

  it('writes a canonical query without defaults', () => {
    expect(writeVaultQuery(read('title=giant&count=20&page=1&v3=true')).toString()).toBe('q=giant');
    expect(writeVaultQuery({ q: ' a b ', author: 'x', sort: 'title', dir: 'desc', page: 4, pageSize: 60 }).toString()).toBe(
      'q=a+b&author=x&sort=title&dir=desc&page=4&pageSize=60',
    );
  });

  it('builds the API parameters', () => {
    expect(vaultSearchParams(read(''))).toEqual({ page: 1, pageSize: 20 });
    expect(vaultSearchParams(read('q=%20x%20&author=a&sort=title'))).toEqual({ q: 'x', author: 'a', sort: 'title', page: 1, pageSize: 20 });
  });
});

describe('sorting defaults (as the API applies them)', () => {
  it('uses relevance only with a search', () => {
    expect(effectiveSort({ q: 'x', sort: null })).toBe('relevance');
    expect(effectiveSort({ q: '', sort: null })).toBe('updated');
    expect(effectiveSort({ q: ' ', sort: 'relevance' })).toBe('updated');
    expect(effectiveSort({ q: '', sort: 'views' })).toBe('views');
  });

  it('defaults title to A to Z and the rest to descending', () => {
    expect(effectiveDir('title', null)).toBe('asc');
    expect(effectiveDir('views', null)).toBe('desc');
    expect(effectiveDir('title', 'desc')).toBe('desc');
  });
});

describe('pages', () => {
  it('counts pages', () => {
    expect(totalPages(0, 20)).toBe(1);
    expect(totalPages(20, 20)).toBe(1);
    expect(totalPages(21, 20)).toBe(2);
  });

  it("shows upstream's window of ten pages", () => {
    expect(pageWindow(1, 3)).toEqual({ start: 1, end: 3 });
    expect(pageWindow(6, 50)).toEqual({ start: 1, end: 10 });
    expect(pageWindow(7, 50)).toEqual({ start: 2, end: 11 });
    expect(pageWindow(48, 50)).toEqual({ start: 41, end: 50 });
    expect(pageWindow(60, 50)).toEqual({ start: 41, end: 50 });
  });
});
