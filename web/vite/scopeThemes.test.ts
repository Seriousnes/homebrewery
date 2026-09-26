import { describe, expect, it } from 'vitest';
import { scopeCss, scopeSelector } from './scopeThemes.ts';

/**
 * Collapses whitespace around braces and semicolons so assertions don't depend on postcss
 * formatting. Whitespace inside selectors is significant (descendant combinator) and is kept.
 */
function squash(css: string): string {
  return css.replace(/\s+/g, ' ').replace(/\s*([{};])\s*/g, '$1').trim();
}

describe('scopeSelector', () => {
  it.each([
    [':root', '.hb-canvas'],
    ['html', '.hb-canvas'],
    ['body', '.hb-canvas'],
    ['body .page', '.hb-canvas .page'],
    ['html body', '.hb-canvas'],
    ['html > body .page', '.hb-canvas .page'],
    [':root:has(.frontCover)', '.hb-canvas:has(.frontCover)'],
    ['body.dark .page', '.hb-canvas.dark .page'],
    ['body > .page', '.hb-canvas > .page'],
    ['html::before', '.hb-canvas::before'],
    ['.page h1', '.hb-canvas .page h1'],
    ['.page:nth-child(even) .pageNumber', '.hb-canvas .page:nth-child(even) .pageNumber'],
    ['*', '.hb-canvas *'],
    ['bodyguard', '.hb-canvas bodyguard'],
    ['body-text', '.hb-canvas body-text'],
    ['.note body', '.hb-canvas .note body'],
    ['.hb-canvas .page', '.hb-canvas .page'],
  ])('%s → %s', (input, expected) => {
    expect(scopeSelector(input)).toBe(expected);
  });

  it('accepts a custom scope', () => {
    expect(scopeSelector('body .page', '#probe')).toBe('#probe .page');
    expect(scopeSelector('.page', '#probe')).toBe('#probe .page');
  });
});

describe('scopeCss', () => {
  it('rewrites :root to the canvas', () => {
    expect(squash(scopeCss(':root{--x:1}'))).toBe('.hb-canvas{--x:1}');
  });

  it('rewrites body as the start of a complex selector', () => {
    expect(squash(scopeCss('body .page{color:red}'))).toBe('.hb-canvas .page{color:red}');
  });

  it('prefixes ordinary selectors', () => {
    expect(squash(scopeCss('.page h1{margin:0}'))).toBe('.hb-canvas .page h1{margin:0}');
  });

  it('handles selector lists', () => {
    expect(squash(scopeCss('html, .a{color:red}'))).toBe('.hb-canvas, .hb-canvas .a{color:red}');
  });

  it('does not split selector lists inside parentheses', () => {
    expect(squash(scopeCss(':is(.note, .descriptive) p{color:red}'))).toBe(
      '.hb-canvas :is(.note, .descriptive) p{color:red}',
    );
  });

  it('prefixes rules inside @media, @supports, @layer and @container', () => {
    const out = squash(
      scopeCss(
        '@media print{.page{margin:0}body{counter-reset:page-numbers}}' +
          '@supports (display:grid){.a{display:grid}}' +
          '@layer theme{.b{color:red}}' +
          '@container (min-width:10px){.c{color:blue}}',
      ),
    );
    expect(out).toContain('@media print{.hb-canvas .page{margin:0}.hb-canvas{counter-reset:page-numbers}}');
    expect(out).toContain('@supports (display:grid){.hb-canvas .a{display:grid}}');
    expect(out).toContain('@layer theme{.hb-canvas .b{color:red}}');
    expect(out).toContain('@container (min-width:10px){.hb-canvas .c{color:blue}}');
  });

  it('leaves @font-face untouched', () => {
    const css = "@font-face{font-family:\"Book\";src:url('../../../fonts/5e/Book.woff2')}";
    expect(squash(scopeCss(css))).toBe(squash(css));
  });

  it('leaves @page untouched', () => {
    const css = '@page{size:8.5in 11in;margin:0}@page :first{margin-top:1in}';
    expect(squash(scopeCss(css))).toBe(squash(css));
  });

  it('leaves @keyframes steps untouched', () => {
    const css = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' +
      '@-webkit-keyframes fade{0%{opacity:0}100%{opacity:1}}';
    expect(squash(scopeCss(css))).toBe(squash(css));
  });

  it('is idempotent', () => {
    const once = scopeCss(':root{--x:1}body .page{color:red}.a,.b{color:blue}');
    expect(scopeCss(once)).toBe(once);
  });
});

describe('scopeCss: table header rows (P5.6)', () => {
  it('lets thead rules style the editor header rows and keeps striping on body rows', () => {
    const css = '.page table thead{font-weight:800}.page table thead th{vertical-align:bottom}.page table tbody tr:nth-child(odd){background:red}';
    const out = squash(scopeCss(css));
    expect(out).toContain('.hb-canvas .page table thead, .hb-canvas .page table tr:where(.hb-header-row){font-weight:800}');
    expect(out).toContain('.hb-canvas .page table thead th, .hb-canvas .page table tr:where(.hb-header-row) th{vertical-align:bottom}');
    expect(out).toContain(
      '.hb-canvas .page table tbody tr:nth-child(odd of :where(:not(.hb-header-row))):where(tr:not(.hb-header-row), tr:not(.hb-header-row) *){background:red}',
    );
  });

  it('leaves other rules alone and stays idempotent', () => {
    const css = '.page table + *{margin-top:1px}.page td{padding:0}';
    expect(squash(scopeCss(css))).toBe('.hb-canvas .page table + *{margin-top:1px}.hb-canvas .page td{padding:0}');
    const once = scopeCss('.page thead th{color:red}');
    expect(scopeCss(once)).toBe(once);
  });
});
