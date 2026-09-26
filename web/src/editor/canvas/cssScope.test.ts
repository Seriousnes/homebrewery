import { describe, expect, it, vi } from 'vitest';
import {
  absolutizeCssUrls,
  extractCssImports,
  inlineCssImports,
  scopeCss,
  scopeCssText,
  scopeSelector,
  scopeSelectorList,
  splitSelectorList,
  stripCssImports,
  type ScopeReport,
} from './cssScope';

/** Whitespace-insensitive CSS text (serializers differ in spacing). Apply to both sides. */
const squash = (css: string): string =>
  css
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();

describe('scopeSelector (same rules as web/vite/scopeThemes.ts)', () => {
  it.each([
    [':root', '.hb-canvas'],
    ['html', '.hb-canvas'],
    ['body', '.hb-canvas'],
    ['body .page', '.hb-canvas .page'],
    ['html body', '.hb-canvas'],
    ['html > body .page', '.hb-canvas .page'],
    [':root:has(.frontCover)', '.hb-canvas:has(.frontCover)'],
    ['body.dark .page', '.hb-canvas.dark .page'],
    ['html::before', '.hb-canvas::before'],
    ['.page h1', '.hb-canvas .page h1'],
    ['.page:nth-child(even) .pageNumber', '.hb-canvas .page:nth-child(even) .pageNumber'],
    ['*', '.hb-canvas *'],
    ['bodyguard', '.hb-canvas bodyguard'],
    ['.note body', '.hb-canvas .note body'],
    ['.hb-canvas .page', '.hb-canvas .page'],
    ['.page#p1', '.hb-canvas .page#p1'],
  ])('%s → %s', (input, expected) => {
    expect(scopeSelector(input)).toBe(expected);
  });
});

describe('splitSelectorList', () => {
  it('splits at top-level commas only', () => {
    expect(splitSelectorList(':is(.note, .descriptive) p, [title="a,b"], h1')).toEqual([
      ':is(.note, .descriptive) p',
      '[title="a,b"]',
      'h1',
    ]);
    expect(splitSelectorList(".a:not(.b, .c), .d[data-x='1,2']")).toEqual(['.a:not(.b, .c)', ".d[data-x='1,2']"]);
    expect(splitSelectorList('a\\,b, c')).toEqual(['a\\,b', 'c']);
  });

  it('scopes every selector of a list', () => {
    expect(scopeSelectorList('html, .a, :is(h1, h2) span')).toBe('.hb-canvas, .hb-canvas .a, .hb-canvas :is(h1, h2) span');
  });
});

describe('scopeCss', () => {
  it('returns a constructed sheet with every style rule scoped', () => {
    const sheet = scopeCss('.page { color: red } :root { --HB_Color_Accent: blue } html, body { margin: 0 }', 'http://localhost/');
    expect(sheet).toBeInstanceOf(CSSStyleSheet);
    expect(Array.from(sheet.cssRules).map((r) => squash(r.cssText))).toEqual(
      ['.hb-canvas .page { color: red }', '.hb-canvas { --HB_Color_Accent: blue }', '.hb-canvas, .hb-canvas { margin: 0px }'].map(squash),
    );
  });

  it('recurses into @media, @supports, @layer and @container', () => {
    const css = `
      @media print { .page { color: red } body { background: none } }
      @supports (display: grid) { .note { display: grid } }
      @layer brew { .monster h2 { color: green } }
      @container (min-width: 1px) { .wide { color: blue } }
      @media screen { @supports (color: red) { .x { color: red } } }`;
    const text = squash(scopeCssText(css));
    expect(text).toContain(squash('@media print { .hb-canvas .page { color: red } .hb-canvas { background: none } }'));
    expect(text).toContain(squash('@supports (display: grid) { .hb-canvas .note { display: grid } }'));
    expect(text).toContain(squash('@layer brew { .hb-canvas .monster h2 { color: green } }'));
    expect(text).toContain(squash('.hb-canvas .wide { color: blue }'));
    expect(text).toContain(squash('@media screen { @supports (color: red) { .hb-canvas .x { color: red } } }'));
    expect(text).not.toMatch(/(^|[}{])\.(page|note|monster|wide|x)\b/);
  });

  it('leaves @font-face, @keyframes and @page alone', () => {
    const css = `@font-face { font-family: "Brew"; src: url(brew.woff2) }
      @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
      @page { margin: 0 }`;
    const text = squash(scopeCssText(css));
    expect(text).toContain(squash('@font-face { font-family: "Brew"'));
    expect(text).toContain(squash('@keyframes spin {'));
    expect(text).toMatch(/\b(from|0%)\{/);
    expect(text).toContain(squash('@page { margin: 0px }'));
    expect(text).not.toContain('.hb-canvas');
  });

  it('is idempotent and accepts a custom scope', () => {
    expect(squash(scopeCssText('.hb-canvas .page { color: red }'))).toBe(squash('.hb-canvas .page { color: red }'));
    expect(squash(scopeCssText('body .page { color: red }', 'http://localhost/', '#probe'))).toBe(squash('#probe .page { color: red }'));
  });

  it('reports what it scoped', () => {
    let report: ScopeReport | undefined;
    scopeCss('.a{} .b{} @media print { .c{} }', 'http://localhost/', { report: (r) => (report = r) });
    expect(report).toEqual({ scopedRules: 3, droppedRules: [] });
  });

  // RV-1: a nested selector with `&` inside :not()/:has() gets no implicit `& ` prefix, so it
  // could match outside the canvas (html, body, app chrome). Every nested selector's subject is
  // constrained to the canvas.
  describe('nested rules can’t match outside the canvas', () => {
    const IN = ':where(.hb-canvas, .hb-canvas *)';
    it.each([
      ['.page { :not(&) { outline: red } }', `:not(&)${IN}`],
      ['.page { :has(&) { color: red } }', `:has(&)${IN}`],
      ['.x { @media screen { :not(&) { color: red } } }', `:not(&)${IN}`],
      ['.x { @supports (color: red) { .y & { color: red } } }', `.y &${IN}`],
      ['body { & ~ * { color: red } }', `& ~ *${IN}`],
      ['.note { & p { color: blue } }', `& p${IN}`],
      ['.note { &::before { content: "x" } }', `&${IN}::before`],
      ['.note { &:hover::after { content: "x" } }', `&:hover${IN}::after`],
      ['.a { .b { :not(&) { color: red } } }', `:not(&)${IN}`],
    ])('%s', (css, selector) => {
      const text = squash(scopeCssText(css));
      expect(text).toContain(squash(`${selector} {`));
    });

    it('constrains every selector of a nested list and nested @scope roots', () => {
      const text = squash(scopeCssText('.page { :not(&), :has(&) > p { color: red } @scope (:has(&)) { :scope { color: red } } }'));
      expect(text).toContain(squash(`:not(&)${IN}, :has(&) > p${IN} {`));
      expect(text).toContain(squash(`@scope (:has(&)${IN})`));
    });

    it('reports nested rules as scoped', () => {
      let report: ScopeReport | undefined;
      scopeCss('.a { .b { color: red } @media print { .c { color: red } } }', 'http://localhost/', { report: (r) => (report = r) });
      expect(report).toEqual({ scopedRules: 3, droppedRules: [] });
    });

    it.each([
      [':root ~ p', `.hb-canvas ~ p${IN}`],
      ['body + p', `.hb-canvas + p${IN}`],
      ['html > body ~ .x .y', `.hb-canvas ~ .x .y${IN}`],
      ['.hb-canvas ~ p', `.hb-canvas ~ p${IN}`],
      ['.hb-canvas.dark+p::before', `.hb-canvas.dark+p${IN}::before`],
    ])('top level: sibling of the canvas %s → %s', (css, selector) => {
      expect(squash(scopeCssText(`${css} { color: red }`))).toBe(squash(`${selector} { color: red }`));
    });

    it('top level: @scope roots that are siblings of the canvas are constrained too', () => {
      expect(squash(scopeCssText('@scope (body ~ *) { p { color: red } }'))).toContain(squash(`@scope (.hb-canvas ~ *${IN})`));
    });
  });

  it('drops @import (constructed sheets cannot load it) without failing', () => {
    expect(squash(scopeCssText('@import url(https://fonts.googleapis.com/css2?family=Inter); .page { color: red }'))).toBe(
      squash('.hb-canvas .page { color: red }'),
    );
  });
});

describe('@import handling', () => {
  it('extracts the leading imports in every syntax', () => {
    const css = `/* fonts */ @charset "utf-8";
      @import url("https://a.test/one.css");
      @import url(https://a.test/two.css) print;
      @import 'three.css' layer(base) supports(display: grid) screen and (min-width: 10px);
      .page { color: red }
      @import url(late.css);`;
    const imports = extractCssImports(css);
    expect(imports.map((i) => [i.url, i.conditions])).toEqual([
      ['https://a.test/one.css', ''],
      ['https://a.test/two.css', 'print'],
      ['three.css', 'layer(base) supports(display: grid) screen and (min-width: 10px)'],
    ]);
    expect(stripCssImports(css)).not.toContain('one.css');
    expect(stripCssImports(css)).toContain('.page { color: red }');
  });

  it('makes relative url()s absolute', () => {
    expect(
      absolutizeCssUrls(
        'a{src:url(f/x.woff2)} b{src:url("../y.png")} c{src:url(data:x)} d{src:url(https://c.test/z)}',
        'https://a.test/css/s.css',
      ),
    ).toBe('a{src:url(https://a.test/css/f/x.woff2)} b{src:url("https://a.test/y.png")} c{src:url(data:x)} d{src:url(https://c.test/z)}');
  });

  it('inlines imports (with conditions) and reports failures', async () => {
    const responses: Record<string, string> = {
      'https://fonts.test/css?family=Brew': '@font-face { font-family: Brew; src: url(brew.woff2) }',
      'https://brew.test/print.css': '@import "nested.css"; .page { color: black }',
      'https://brew.test/nested.css': '.note { color: gray }',
    };
    const fetch = vi.fn((url: string) =>
      Promise.resolve(url in responses ? new Response(responses[url]) : new Response('nope', { status: 404 })),
    );
    const cache = new Map<string, Promise<string | null>>();
    const css = `@import url(https://fonts.test/css?family=Brew);
      @import "print.css" print;
      @import "missing.css";
      .page { font-family: Brew }`;
    const result = await inlineCssImports(css, { baseUrl: 'https://brew.test/abc', fetch, cache });
    expect(result.failed).toEqual(['https://brew.test/missing.css']);
    const text = squash(result.css);
    expect(text).toContain(squash('@font-face { font-family: Brew; src: url(https://fonts.test/brew.woff2) }'));
    expect(text).toContain(squash('@media print { .note { color: gray }'));
    expect(text).toContain(squash('.page { color: black } }'));
    expect(text.indexOf(squash('.page { font-family: Brew }'))).toBeGreaterThan(text.indexOf('@font-face'));
    expect(text).not.toContain('@import');

    // The cache avoids refetching successful imports; failures are retried.
    await inlineCssImports(css, { baseUrl: 'https://brew.test/abc', fetch, cache });
    const calls = fetch.mock.calls.map((c) => c[0]);
    expect(calls.filter((u) => u === 'https://fonts.test/css?family=Brew')).toHaveLength(1);
    expect(calls.filter((u) => u === 'https://brew.test/missing.css')).toHaveLength(2);

    // The inlined CSS scopes cleanly.
    const scoped = squash(scopeCssText(result.css));
    expect(scoped).toContain(squash('.hb-canvas .page { font-family: Brew }'));
    expect(scoped).toContain('@font-face');
  });

  // RV-3: an import from a host that never answers must not hold the brew's styles back.
  it('gives up on an import after timeoutMs (failed) and fetches it again next time', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(() => new Promise<Response>(() => {}));
      const cache = new Map<string, Promise<string | null>>();
      const css = '@import url("https://slow.test/font.css"); .page { color: red }';
      const first = inlineCssImports(css, { baseUrl: 'https://b.test/', fetch, cache });
      await vi.advanceTimersByTimeAsync(9_999);
      let settled = false;
      void first.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); // the default timeout: 10 s
      const result = await first;
      expect(result.failed).toEqual(['https://slow.test/font.css']);
      expect(squash(result.css)).toBe(squash('.page { color: red }'));
      expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true); // the request is cancelled
      expect(cache.size).toBe(0);

      const second = inlineCssImports(css, { baseUrl: 'https://b.test/', fetch, cache, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      expect((await second).failed).toEqual(['https://slow.test/font.css']);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an aborted call stops waiting at once; the fetch stays cached for the next call', async () => {
    let answer: ((r: Response) => void) | null = null;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const cache = new Map<string, Promise<string | null>>();
    const controller = new AbortController();
    const css = '@import "https://fonts.test/a.css"; .page { color: red }';
    const aborted = inlineCssImports(css, { baseUrl: 'https://b.test/', fetch, cache, signal: controller.signal });
    controller.abort();
    await aborted; // resolves without waiting for the import
    const next = inlineCssImports(css, { baseUrl: 'https://b.test/', fetch, cache });
    answer!(new Response('.a { color: blue }'));
    const result = await next;
    expect(result.failed).toEqual([]);
    expect(squash(result.css)).toContain(squash('.a { color: blue }'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('wraps layer() and supports() conditions', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('.a { color: red }')));
    const result = await inlineCssImports('@import "x.css" layer(base) supports(display: grid);', { baseUrl: 'https://b.test/', fetch });
    expect(squash(result.css)).toBe(squash('@layer base { @supports (display: grid) { .a { color: red } } }'));
  });
});

describe('scopeCss: table header rows (P5.6)', () => {
  it('rewrites thead and tbody row selectors of user CSS, top level and nested', () => {
    const text = squash(scopeCssText('thead th { color: red } tbody tr:nth-child(even) { color: blue } .x { & thead { font-weight: bold } }'));
    expect(text).toContain(squash('.hb-canvas thead th, .hb-canvas tr:where(.hb-header-row) th { color: red }'));
    expect(text).toContain(squash('.hb-canvas tbody tr:nth-child(even of :where(:not(.hb-header-row))):where(tr:not(.hb-header-row), tr:not(.hb-header-row) *) { color: blue }'));
    expect(text).toMatch(/& thead:where\(\.hb-canvas, \.hb-canvas \*\), & tr:where\(\.hb-header-row\):where\(\.hb-canvas, \.hb-canvas \*\)/);
  });
});
