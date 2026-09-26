import { describe, expect, it } from 'vitest';
import { parseUpstreamLink, upstreamShareUrl } from './upstreamLink';

const ID = 'aBc123_-xYz9'; // 12 characters
const GOOGLE = `1${'a'.repeat(32)}${ID}`; // a 33-character Drive id + the brew id

const problem = (input: string) => {
  const result = parseUpstreamLink(input);
  return result.ok ? null : result.problem;
};

describe('parseUpstreamLink', () => {
  it('accepts bare share ids of 10 to 14 characters', () => {
    expect(parseUpstreamLink(ID)).toEqual({ ok: true, shareId: ID });
    expect(parseUpstreamLink('  abcdefghij  ')).toEqual({ ok: true, shareId: 'abcdefghij' });
    expect(parseUpstreamLink('abcdefghijklmn')).toEqual({ ok: true, shareId: 'abcdefghijklmn' });
  });

  it('accepts share, download, source and print links, with or without the scheme', () => {
    for (const route of ['share', 'download', 'source', 'print', 'SHARE']) {
      expect(parseUpstreamLink(`https://homebrewery.naturalcrit.com/${route}/${ID}`)).toEqual({ ok: true, shareId: ID });
    }
    expect(parseUpstreamLink(`homebrewery.naturalcrit.com/share/${ID}`)).toEqual({ ok: true, shareId: ID });
    expect(parseUpstreamLink(`http://www.homebrewery.naturalcrit.com/share/${ID}/`)).toEqual({ ok: true, shareId: ID });
    expect(parseUpstreamLink(`https://homebrewery.naturalcrit.com/share/${ID}?x=1#p3`)).toEqual({ ok: true, shareId: ID });
    expect(parseUpstreamLink(`HTTPS://HomeBrewery.NaturalCrit.com/share/${ID}`)).toEqual({ ok: true, shareId: ID });
  });

  it('recognises edit links and explains that the share link is needed', () => {
    const result = parseUpstreamLink(`https://homebrewery.naturalcrit.com/edit/${ID}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('edit-link');
      expect(result.message).toMatch(/share link/);
    }
    expect(problem(`homebrewery.naturalcrit.com/edit/${GOOGLE}`)).toBe('edit-link');
  });

  it('explains 7-9 character legacy ids', () => {
    expect(problem('abcdefg')).toBe('legacy-id');
    expect(problem('abcdefghi')).toBe('legacy-id');
    expect(problem('https://homebrewery.naturalcrit.com/share/abcdefgh')).toBe('legacy-id');
    const result = parseUpstreamLink('abcdefg');
    if (!result.ok) expect(result.message).toMatch(/7 to 9/);
  });

  it('explains Google Drive ids', () => {
    expect(problem(GOOGLE)).toBe('google-drive');
    expect(problem(`https://homebrewery.naturalcrit.com/share/${GOOGLE}`)).toBe('google-drive');
    expect(problem(`1${'a'.repeat(43)}${ID}`)).toBe('google-drive');
    const result = parseUpstreamLink(GOOGLE);
    if (!result.ok) expect(result.message).toMatch(/Google Drive/);
  });

  it('refuses other sites, other upstream pages and junk', () => {
    expect(problem('')).toBe('empty');
    expect(problem('   ')).toBe('empty');
    expect(problem(`https://example.com/share/${ID}`)).toBe('other-site');
    expect(problem(`https://homebrewery.naturalcrit.com.evil.test/share/${ID}`)).toBe('other-site');
    expect(problem(`https://naturalcrit.com/share/${ID}`)).toBe('other-site');
    expect(problem('https://homebrewery.naturalcrit.com/')).toBe('not-a-brew-link');
    expect(problem('https://homebrewery.naturalcrit.com/user/someone')).toBe('not-a-brew-link');
    expect(problem(`https://homebrewery.naturalcrit.com/share/${ID}/extra`)).toBe('not-a-brew-link');
    expect(problem(`javascript:alert(1)`)).toBe('invalid');
    expect(problem(`ftp://homebrewery.naturalcrit.com/share/${ID}`)).toBe('invalid');
    expect(problem('abc')).toBe('invalid');
    expect(problem('has space in it')).toBe('invalid');
    expect(problem('abcdefghij!')).toBe('invalid');
    expect(problem('a'.repeat(20))).toBe('invalid');
    expect(problem(`https://homebrewery.naturalcrit.com/share/abc%2Fdefghijkl`)).toBe('invalid');
  });

  it('builds the share URL of an id', () => {
    expect(upstreamShareUrl(ID)).toBe(`https://homebrewery.naturalcrit.com/share/${ID}`);
  });
});
