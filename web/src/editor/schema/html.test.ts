// The client's URL and raw HTML policies must not be looser than the server's (UrlPolicy,
// RawHtmlSanitizer, plan §8.5): what the editor shows before saving is what is stored (RV-14).
// The URL cases are the ones tests/Homebrewery.Api.Tests/Documents/DocInspectorTests.cs uses.
import { describe, expect, it } from 'vitest';
import { hrefProblem } from '../commands/marks';
import { isSafeHref, isSafeSrc, sanitizeRawHtml, urlScheme } from './html';
import { docWith, fromHtml, node, p, text, toHtml } from './testing';

describe('isSafeHref (server UrlPolicy.IsSafeHref)', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'tel:+123',
    'blob:http://x/1',
  ])('rejects %j', (url) => {
    expect(isSafeHref(url)).toBe(false);
  });

  it.each(['https://example.com/a?b=c#d', 'http://example.com', 'mailto:someone@example.com', '/share/abc123def456', 'relative/page', '#p3', '//cdn.example.com/x', '?q=1', ''])(
    'accepts %j',
    (url) => {
      expect(isSafeHref(url)).toBe(true);
    },
  );
});

describe('isSafeSrc (server UrlPolicy.IsSafeSrc)', () => {
  it.each([
    ['javascript:alert(1)', false],
    ['data:text/html;base64,PHNjcmlwdD4=', false],
    ['mailto:a@example.com', false],
    ['file:///C:/Users/x/clip_image002.png', false],
    ['blob:http://x/1', false],
    ['ftp://x/a.png', false],
    [' data:image/png;base64,iVBORw0KGgo=', true],
    ['DATA:IMAGE/SVG+XML;utf8,<svg/>', true],
    ['https://i.imgur.com/x.png', true],
    ['/assets/frameBorder.png', true],
  ] as const)('%j → %s', (url, safe) => {
    expect(isSafeSrc(url)).toBe(safe);
  });
});

// SEC-2: the scheme was read from url.slice(0, 256) and data:image/ from url.slice(0, 64), both
// cut before the ignored characters were removed. Ignored characters must be skipped wherever
// they are, however many there are, as the server's UrlPolicy does.
describe('ignored characters before and inside the scheme (server UrlPolicy.SchemeOf)', () => {
  it('the link dialog refuses javascript: behind 256 control characters (String.trim keeps them)', () => {
    const url = `${'\u0001'.repeat(256)}javascript:alert(1)`;
    expect(urlScheme(url)).toBe('javascript');
    expect(hrefProblem(url)).not.toBeNull();
  });

  it.each([
    [`${' '.repeat(5000)}javascript:alert(1)`, 'javascript'],
    [`${'\u2028\uFEFF\u0000'.repeat(1000)}JAVA\tSCRIPT:x`, 'javascript'],
    [`${'a'.repeat(300)}:x`, 'a'.repeat(300)],
    ['h t t p s://example.com', 'https'],
    ['x'.repeat(300), null],
    [`${'x'.repeat(300)}/y:z`, null],
    ['1http://x', null],
    [':x', null],
    ['', null],
  ])('urlScheme case %#', (url, scheme) => {
    expect(urlScheme(url)).toBe(scheme);
  });

  it('skips exactly the characters IGNORED_URL_CHARS removes (C0, DEL, JavaScript \\s)', () => {
    // eslint-disable-next-line no-control-regex -- the client's definition, one character at a time
    const ignored = /^[\u0000-\u001F\u007F\s]$/;
    const wrong: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if ((urlScheme(`${ch}javascript:x`) === 'javascript') !== ignored.test(ch)) wrong.push(c.toString(16));
    }
    expect(wrong).toEqual([]);
  });

  it('data:image/ is matched on significant characters only, and only as a prefix', () => {
    expect(isSafeSrc(`data:${' '.repeat(70)}image/png;base64,iVBORw0KGgo=`)).toBe(true);
    expect(isSafeSrc(`${'\u0001'.repeat(300)}d\ta\nta:Image/png;base64,iVBORw0KGgo=`)).toBe(true);
    expect(isSafeSrc('data:imag')).toBe(false);
    expect(isSafeSrc('data:text/image/png')).toBe(false);
    expect(isSafeSrc('data:image\\/png')).toBe(false);
  });
});

describe('the schema applies them', () => {
  it('images: a Word paste’s file: source is dropped, data:image sources are kept', () => {
    const word = fromHtml('<div class="page"><div class="columnWrapper"><p>a<img src="file:///C:/Users/x/clip_image002.png">b</p></div></div>');
    expect(JSON.stringify(word)).not.toContain('file:');
    const data = fromHtml('<div class="page"><div class="columnWrapper"><p><img src="data:image/png;base64,iVBORw0KGgo="></p></div></div>');
    expect(data.content?.[0]?.content?.[0]?.content?.[0]).toMatchObject({ type: 'image', attrs: { src: 'data:image/png;base64,iVBORw0KGgo=' } });
  });

  it('links: only http, https, mailto, relative and #anchors', () => {
    const html = toHtml(
      docWith(
        node('paragraph', {}, [
          text('ftp', [{ type: 'link', attrs: { href: 'ftp://example.com/x' } }]),
          text(' web', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        ]),
      ),
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('ftp:');
    const parsed = fromHtml('<div class="page"><div class="columnWrapper"><p><a href="tel:+123">call</a> <a href="#p3">page 3</a></p></div></div>');
    const runs = parsed.content?.[0]?.content?.[0]?.content?.map((t): [string | undefined, unknown] => [t.text, t.marks?.[0]?.attrs?.href ?? null]);
    expect(runs).toEqual([
      ['call ', null], // the tel: link is dropped, its text kept
      ['page 3', '#p3'],
    ]);
  });

  it('page objects: unsafe image sources are dropped', () => {
    const objects = [
      { id: 'o1', kind: 'image', classes: [], style: '', src: 'file:///x.png' },
      { id: 'o2', kind: 'image', classes: [], style: '', src: '/assets/bird.webp' },
    ];
    const html = toHtml({ type: 'doc', content: [{ type: 'page', attrs: { objects }, content: [p('x')] }] });
    expect(html).not.toContain('file:');
    expect(html).toContain('src="/assets/bird.webp"');
  });
});

describe('sanitizeRawHtml (server RawHtmlSanitizer)', () => {
  it('removes forms and form controls, tabindex and formaction', () => {
    const clean = sanitizeRawHtml(
      '<form action="https://collector.example/login" method="post"><input type="password" name="pw"><input type="submit" value="Sign in"><button formaction="https://x.example" tabindex="1">b</button><select><option>o</option></select><textarea>t</textarea></form><p tabindex="2">kept</p>',
    );
    expect(clean).not.toMatch(/<form|<input|<button|<select|<option|<textarea|tabindex|formaction|collector/);
    expect(clean).toContain('<p>kept</p>');
  });

  it('removes SVG use, foreignObject and animation; keeps static SVG', () => {
    const clean = sanitizeRawHtml(
      '<svg viewBox="0 0 10 10"><use href="#x"></use><foreignObject><p>f</p></foreignObject><circle cx="5" cy="5" r="5"><animate attributeName="r" to="1"></animate><set attributeName="r" to="2"></set></circle></svg>',
    );
    expect(clean).not.toMatch(/<use|foreignobject|<animate|<set/i);
    expect(clean).toContain('<circle cx="5" cy="5" r="5">');
  });

  it('keeps only http, https, mailto and relative URLs (data:image in img src)', () => {
    const clean = sanitizeRawHtml(
      '<a href="ftp://x/a">ftp</a><a href="tel:+1">tel</a><a href="https://example.com">web</a><a href="mailto:a@b.c">mail</a><img src="data:image/png;base64,iVBORw0KGgo="><img src="file:///x.png">',
    );
    expect(clean).not.toMatch(/ftp:|tel:|file:/);
    expect(clean).toContain('href="https://example.com"');
    expect(clean).toContain('href="mailto:a@b.c"');
    expect(clean).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });
});
