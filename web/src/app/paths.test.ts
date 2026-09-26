import { describe, expect, it } from 'vitest';
import { isAuthPath, locationPath, paths, safeReturnTo } from './paths';

describe('paths', () => {
  it('encodes ids and handles', () => {
    expect(paths.edit('a/b?c')).toBe('/edit/a%2Fb%3Fc');
    expect(paths.share('abc_-1')).toBe('/share/abc_-1');
    expect(paths.user('my handle')).toBe('/user/my%20handle');
  });

  it('adds a safe returnTo to the sign-in pages', () => {
    expect(paths.login()).toBe('/login');
    expect(paths.login('/')).toBe('/login');
    expect(paths.login('/edit/abc?x=1#p2')).toBe('/login?returnTo=%2Fedit%2Fabc%3Fx%3D1%23p2');
    expect(paths.register('/account')).toBe('/register?returnTo=%2Faccount');
    expect(paths.login('https://evil.example/')).toBe('/login');
    expect(paths.login('/login?returnTo=/x')).toBe('/login');
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/edit/abc', '/edit/abc'],
    ['/share/abc?print=1#p3', '/share/abc?print=1#p3'],
    ['/user/%C3%A9', '/user/%C3%A9'],
  ])('keeps same-site path %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    'edit/abc',
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example',
    '/\u0000x',
    '/a\nb',
    'javascript:alert(1)',
    '/login',
    '/register?returnTo=/x',
    '/LOGIN/',
    `/${'x'.repeat(2001)}`,
  ])('refuses %s', (input) => {
    expect(safeReturnTo(input)).toBe('/');
    expect(safeReturnTo(input, '')).toBe('');
  });

  it('normalises dot segments without leaving the site', () => {
    expect(safeReturnTo('/a/../../b')).toBe('/b');
  });
});

describe('isAuthPath and locationPath', () => {
  it('recognises the sign-in pages', () => {
    expect(isAuthPath('/login')).toBe(true);
    expect(isAuthPath('/register/')).toBe(true);
    expect(isAuthPath('/loginx')).toBe(false);
    expect(isAuthPath('/account')).toBe(false);
  });

  it('joins a location', () => {
    expect(locationPath({ pathname: '/edit/a', search: '?q=1', hash: '#p2' })).toBe('/edit/a?q=1#p2');
  });
});
