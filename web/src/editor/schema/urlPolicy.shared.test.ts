// RV-14: the client's URL policy against shared/url-policy-cases.json, the cases the server's UrlPolicy
// (tests/Homebrewery.Api.Tests/Documents/UrlPolicyTests.cs) runs too, so the editor never shows a URL that saving
// refuses, and never keeps one the server would drop.
// - isSafeHref decides link.href, isSafeSrc image.src and page object src (html.ts).
// - A case with `clientGap` is a known client disagreement: it runs with it.fails, so it stays green while html.ts
//   still disagrees and turns red once html.ts is fixed. Then delete `clientGap` from the case in the JSON file.
import { describe, expect, it } from 'vitest';
import fixture from '../../../../shared/url-policy-cases.json';
import { isSafeHref, isSafeSrc, MAX_URL_LENGTH } from './html';

interface UrlCasePart {
  text: string;
  repeat?: number;
}

interface UrlCase {
  url?: string;
  parts?: UrlCasePart[];
  href: boolean;
  src: boolean;
  why: string;
  clientGap?: string;
}

interface UrlCaseFile {
  maxLength: number;
  cases: UrlCase[];
}

const file: UrlCaseFile = fixture;

function urlOf(c: UrlCase): string {
  return c.url ?? (c.parts ?? []).map((p) => p.text.repeat(p.repeat ?? 1)).join('');
}

/** The URL for a test name: JSON-escaped (controls stay visible), long ones shortened. */
function shown(url: string): string {
  return JSON.stringify(url.length > 80 ? `${url.slice(0, 40)}…(${url.length} chars)` : url);
}

describe('shared URL policy cases (server UrlPolicy)', () => {
  it('the length limit is the server’s', () => {
    expect(MAX_URL_LENGTH).toBe(file.maxLength);
  });

  it('the fixture has cases for every answer', () => {
    const answers = new Set(file.cases.map((c) => `${c.href}/${c.src}`));
    expect([...answers].sort()).toEqual(['false/false', 'false/true', 'true/false', 'true/true']);
    for (const c of file.cases) expect(c.url === undefined).toBe(c.parts !== undefined);
  });

  file.cases.forEach((c, i) => {
    const url = urlOf(c);
    const name = `#${i} ${c.why}: ${shown(url)} → href ${c.href}, src ${c.src}`;
    const check = () => {
      expect({ href: isSafeHref(url), src: isSafeSrc(url) }).toEqual({ href: c.href, src: c.src });
    };
    if (c.clientGap === undefined) it(name, check);
    else it.fails(`${name} (known client gap)`, check);
  });
});
