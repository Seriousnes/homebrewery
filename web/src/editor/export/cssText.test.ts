import { describe, expect, it } from 'vitest';
import {
  cssForStyleElement,
  cssUrlToken,
  cssUrls,
  cssUrlTokens,
  dedupeFontFaces,
  elementSelector,
  fontFaceBlocks,
  replaceCssUrls,
  stripCssComments,
  unescapeCss,
} from './cssText';

describe('url() tokens', () => {
  it('finds quoted and unquoted urls with escapes resolved', () => {
    const css = `a { background: url("/a b.png") } b { src: url('/c\\'d.woff2') format('woff2'), url( /e.png ) } c { x: url(/f\\(1\\).png) }`;
    expect(cssUrls(css)).toEqual(['/a b.png', "/c'd.woff2", '/e.png', '/f(1).png']);
    const tokens = cssUrlTokens(css);
    expect(css.slice(tokens[0]!.start, tokens[0]!.end)).toBe('url("/a b.png")');
  });

  it('unescapes hex escapes and escaped newlines', () => {
    expect(unescapeCss('\\2f a\\\nb\\"')).toBe('/ab"');
    expect(unescapeCss('\\0 x')).toBe('�x');
  });

  it('writes a url() that reads back as the same url', () => {
    for (const url of ['/plain.png', 'a"b', 'c\\d', 'data:image/png;base64,AAA=', 'e\nf']) {
      expect(cssUrls(`x { y: ${cssUrlToken(url)} }`)).toEqual([url]);
    }
  });

  it('replaces the urls a callback maps and keeps the others as written', () => {
    const css = `a { background: url(/a.png) } b { background: url('/b.png') }`;
    expect(replaceCssUrls(css, (url) => (url === '/a.png' ? 'data:image/png;base64,QQ==' : null))).toBe(
      `a { background: url("data:image/png;base64,QQ==") } b { background: url('/b.png') }`,
    );
    expect(replaceCssUrls(css, () => null)).toBe(css);
  });
});

describe('stripCssComments', () => {
  it('removes comments but not comment-like text in strings', () => {
    expect(stripCssComments('a/* x */{ content: "/* y */" } /* z')).toBe('a { content: "/* y */" } ');
    expect(stripCssComments('a/**/b')).toBe('a b');
  });
});

describe('cssForStyleElement', () => {
  it('turns every < into a CSS escape', () => {
    expect(cssForStyleElement('a::after { content: "</style><script>" }')).toBe('a::after { content: "\\3c /style>\\3c script>" }');
  });
});

describe('@font-face blocks', () => {
  const face = (url: string) => `@font-face { font-family: X; src: url(${url}); }`;

  it('finds top-level blocks only', () => {
    const css = `${face('/a.woff2')} @media print { ${face('/b.woff2')} } p { content: "@font-face {" }`;
    const blocks = fontFaceBlocks(css);
    expect(blocks).toHaveLength(1);
    expect(css.slice(blocks[0]!.start, blocks[0]!.end)).toBe(face('/a.woff2'));
  });

  it('removes repeated identical blocks, across stylesheets with a shared set', () => {
    const seen = new Set<string>();
    const first = dedupeFontFaces(`${face('/a.woff2')}\n${face('/b.woff2')}\n${face('/a.woff2')}`, seen);
    expect(first.removed).toBe(1);
    expect(cssUrls(first.css)).toEqual(['/a.woff2', '/b.woff2']);
    const second = dedupeFontFaces(`${face('/b.woff2')} p { color: red }`, seen);
    expect(second.removed).toBe(1);
    expect(second.css.trim()).toBe('p { color: red }');
    expect(dedupeFontFaces('p {}').css).toBe('p {}');
  });
});

describe('elementSelector', () => {
  it('drops pseudo-elements and user-action states', () => {
    expect(elementSelector('.page .note::before:hover')).toBe('.page .note');
    expect(elementSelector('a:visited')).toBe('a');
    expect(elementSelector('.page > ::marker')).toBe('.page > *');
    expect(elementSelector('p:first-letter')).toBe('p');
    expect(elementSelector('::selection')).toBe('*');
    expect(elementSelector('li:first-child')).toBe('li:first-child');
  });
});
