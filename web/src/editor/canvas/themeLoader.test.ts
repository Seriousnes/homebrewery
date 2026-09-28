import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  applyThemeStyles,
  disposeThemeSlot,
  loadThemeChain,
  staticThemeChain,
  ThemeLoadError,
  waitForFonts,
  type ThemeCatalog,
  type ThemeCatalogEntry,
} from './themeLoader';

const entry = (key: string, baseTheme: string | null): ThemeCatalogEntry => ({
  key,
  name: key,
  renderer: 'V3',
  baseTheme,
  baseSnippets: null,
  path: key,
  style: `/themes/V3/${key}/style.css`,
  scopedStyle: `/themes/V3/${key}/style.scoped.css`,
  preview: null,
  texture: null,
  hasSnippets: true,
});

const catalog: ThemeCatalog = {
  themes: [entry('5eDMG', '5ePHB'), entry('5ePHB', 'Blank'), entry('Blank', null), entry('Journal', 'Blank'), entry('LoopA', 'LoopB'), entry('LoopB', 'LoopA')],
};

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

function fakeFetch(api: (() => Promise<Response>) | null) {
  return vi.fn((url: string) => {
    if (url.startsWith('/api/themes/')) return api ? api() : Promise.reject(new TypeError('Failed to fetch'));
    if (url === '/themes/themes.json') return json(200, catalog);
    return json(404, {});
  });
}

describe('staticThemeChain', () => {
  it('walks baseTheme and returns the chain root first', () => {
    const chain = staticThemeChain(catalog, '5eDMG');
    expect(chain.styles).toEqual([
      { kind: 'url', href: '/themes/V3/Blank/style.scoped.css' },
      { kind: 'url', href: '/themes/V3/5ePHB/style.scoped.css' },
      { kind: 'url', href: '/themes/V3/5eDMG/style.scoped.css' },
    ]);
    expect(chain.snippets).toEqual(['V3_Blank', 'V3_5ePHB', 'V3_5eDMG']);
    expect(chain.source).toBe('static');
  });

  it('rejects unknown themes (404) and cycles (422)', () => {
    expect(() => staticThemeChain(catalog, 'Nope')).toThrow(expect.objectContaining({ status: 404 }) as Error);
    expect(() => staticThemeChain(catalog, 'LoopA')).toThrow(expect.objectContaining({ status: 422 }) as Error);
  });
});

describe('loadThemeChain', () => {
  it('uses the API bundle when available', async () => {
    const fetch = fakeFetch(() =>
      json(200, {
        name: 'My theme',
        author: 'someone',
        styles: [{ kind: 'url', href: '/themes/V3/Blank/style.scoped.css' }, { kind: 'css', css: '.page{color:red}' }],
        snippets: ['V3_Blank', { name: 'My theme', snippets: [] }],
      }),
    );
    const chain = await loadThemeChain('abc123', { fetch });
    expect(fetch).toHaveBeenCalledWith('/api/themes/abc123/bundle', expect.anything());
    expect(chain).toMatchObject({ source: 'api', name: 'My theme', author: 'someone', theme: 'abc123' });
    expect(chain.styles[1]).toEqual({ kind: 'css', css: '.page{color:red}' });
  });

  it('falls back to /themes/themes.json when the API is missing or down', async () => {
    for (const api of [null, () => json(404, { title: 'Not Found' }), () => json(502, {}), () => json(200, '<html>')]) {
      const chain = await loadThemeChain('5ePHB', { fetch: fakeFetch(api) });
      expect(chain.source).toBe('static');
      expect(chain.styles.map((s) => (s.kind === 'url' ? s.href : ''))).toEqual([
        '/themes/V3/Blank/style.scoped.css',
        '/themes/V3/5ePHB/style.scoped.css',
      ]);
    }
  });

  it('does not mask an invalid chain (422) and honours source', async () => {
    await expect(loadThemeChain('x', { fetch: fakeFetch(() => json(422, {})) })).rejects.toMatchObject({ status: 422 });
    await expect(loadThemeChain('5ePHB', { fetch: fakeFetch(null), source: 'api' })).rejects.toBeInstanceOf(ThemeLoadError);
    const fetch = fakeFetch(() => json(200, { styles: [] }));
    expect((await loadThemeChain('5ePHB', { fetch, source: 'static' })).source).toBe('static');
    expect(fetch).not.toHaveBeenCalledWith('/api/themes/5ePHB/bundle', expect.anything());
  });
});

describe('applyThemeStyles', () => {
  afterEach(() => {
    document.head.innerHTML = '';
  });

  const loadAll = () => {
    for (const link of Array.from(document.head.querySelectorAll('link'))) link.dispatchEvent(new Event('load'));
  };
  const themeLinks = () =>
    Array.from(document.head.querySelectorAll('link[data-hb-theme-slot]')).map((l) => l.getAttribute('data-hb-theme-href'));

  it('inserts the chain in order in front of the app stylesheets and resolves when loaded', async () => {
    document.head.innerHTML = '<meta charset="utf-8"><style id="app">.x{}</style>';
    const pending = applyThemeStyles(staticThemeChain(catalog, '5eDMG'));
    loadAll();
    const applied = await pending;
    expect(applied.failed).toEqual([]);
    expect(Array.from(document.head.children).map((c) => c.getAttribute('data-hb-theme-href') ?? c.localName)).toEqual([
      'meta',
      '/themes/V3/Blank/style.scoped.css',
      '/themes/V3/5ePHB/style.scoped.css',
      '/themes/V3/5eDMG/style.scoped.css',
      'style',
    ]);
  });

  it('is idempotent and replaces the previous chain of the same slot', async () => {
    const first = applyThemeStyles(staticThemeChain(catalog, '5ePHB'));
    loadAll();
    const a = await first;
    const again = applyThemeStyles(staticThemeChain(catalog, '5ePHB'), null, { timeoutMs: 50 });
    const b = await again;
    expect(b.links).toEqual(a.links); // same elements, not re-created
    const journal = applyThemeStyles(staticThemeChain(catalog, 'Journal'), null, { timeoutMs: 50 });
    const c = await journal;
    expect(themeLinks()).toEqual(['/themes/V3/Blank/style.scoped.css', '/themes/V3/Journal/style.scoped.css']);
    expect(c.links[0]).toBe(a.links[0]); // Blank kept
    expect(c.failed).toEqual(['/themes/V3/Journal/style.scoped.css']); // never loaded in jsdom → timed out
    // Another slot is independent.
    const probe = applyThemeStyles(staticThemeChain(catalog, 'Blank'), null, { slot: 'probe', timeoutMs: 10 });
    await probe;
    expect(themeLinks()).toHaveLength(3);
    c.dispose();
    expect(themeLinks()).toEqual(['/themes/V3/Blank/style.scoped.css']);
  });

  it('switches atomically: the previous theme stays applied until the new links have loaded', async () => {
    const first = applyThemeStyles(staticThemeChain(catalog, '5ePHB'), null, { slot: 'x' });
    // Every theme link loads with media "not all" and keeps it: the switch applies its sheet
    // through the CSSOM and marks the link (changing the attribute would make Firefox reload it).
    const applied = () => Array.from(document.head.querySelectorAll('link')).map((l) => [l.getAttribute('media'), l.hasAttribute('data-hb-theme-applied')]);
    expect(applied()).toEqual([['not all', false], ['not all', false]]); // loading, not applied
    loadAll();
    await first;
    expect(applied()).toEqual([['not all', true], ['not all', true]]);

    const sheet = new CSSStyleSheet();
    const journal = applyThemeStyles(staticThemeChain(catalog, 'Journal'), '.page{}', { slot: 'x', scopeCss: () => sheet });
    await Promise.resolve();
    // 5ePHB still applied; Journal loading inert after the reused Blank; the CSS text not yet adopted.
    expect(themeLinks()).toEqual(['/themes/V3/Blank/style.scoped.css', '/themes/V3/5ePHB/style.scoped.css', '/themes/V3/Journal/style.scoped.css']);
    expect(applied()).toEqual([['not all', true], ['not all', true], ['not all', false]]);
    expect(document.adoptedStyleSheets).not.toContain(sheet);
    document.head.querySelector('link:not([data-hb-theme-applied])')!.dispatchEvent(new Event('load'));
    await journal;
    expect(themeLinks()).toEqual(['/themes/V3/Blank/style.scoped.css', '/themes/V3/Journal/style.scoped.css']);
    expect(applied()).toEqual([['not all', true], ['not all', true]]);
    expect(document.adoptedStyleSheets).toContain(sheet);
    disposeThemeSlot('x');
  });

  it('replaces a loaded link that is out of place instead of moving it (a move re-creates its sheet)', async () => {
    const chain = (...hrefs: string[]) => ({ styles: hrefs.map((href) => ({ kind: 'url' as const, href })) });
    const first = applyThemeStyles(chain('/a.css', '/b.css'), null, { slot: 'r' });
    loadAll();
    const a = await first;
    const reordered = applyThemeStyles(chain('/b.css', '/a.css'), null, { slot: 'r' });
    await Promise.resolve();
    // b stays where it is; a new /a.css loads after it while the old one still applies.
    expect(themeLinks()).toEqual(['/a.css', '/b.css', '/a.css']);
    expect(a.links[0]!.hasAttribute('data-hb-theme-applied')).toBe(true);
    document.head.querySelector('link:not([data-hb-theme-applied])')!.dispatchEvent(new Event('load'));
    const b = await reordered;
    expect(themeLinks()).toEqual(['/b.css', '/a.css']);
    expect(b.links[0]).toBe(a.links[1]);
    expect(b.links[1]).not.toBe(a.links[0]);
    expect(a.links[0]!.isConnected).toBe(false);
    disposeThemeSlot('r');
  });

  it('only the latest apply of a slot switches it', async () => {
    const first = applyThemeStyles(staticThemeChain(catalog, 'Blank'), null, { slot: 'y' });
    loadAll();
    await first;
    const stale = applyThemeStyles(staticThemeChain(catalog, 'Journal'), null, { slot: 'y' });
    const latest = applyThemeStyles(staticThemeChain(catalog, '5ePHB'), null, { slot: 'y' });
    const journalLink = document.head.querySelector('link[data-hb-theme-href$="Journal/style.scoped.css"]')!;
    journalLink.dispatchEvent(new Event('load'));
    await stale; // superseded: switches nothing
    expect(journalLink.hasAttribute('data-hb-theme-applied')).toBe(false);
    loadAll();
    await latest;
    expect(themeLinks()).toEqual(['/themes/V3/Blank/style.scoped.css', '/themes/V3/5ePHB/style.scoped.css']);
    expect(document.head.querySelector('link:not([data-hb-theme-applied])')).toBeNull();
    // A disposed slot is not switched back in by an apply still pending.
    const pending = applyThemeStyles(staticThemeChain(catalog, 'Journal'), null, { slot: 'y', timeoutMs: 10 });
    disposeThemeSlot('y');
    await pending;
    expect(themeLinks()).toEqual([]);
  });

  it('disposeThemeSlot removes every link and sheet of the slot, and only of that slot', async () => {
    const sheet = new CSSStyleSheet();
    const scopeCss = () => sheet;
    await applyThemeStyles(staticThemeChain(catalog, 'Journal'), '.page{}', { slot: 'a', timeoutMs: 10, scopeCss });
    await applyThemeStyles(staticThemeChain(catalog, '5ePHB'), null, { slot: 'a', timeoutMs: 10 }); // replaces Journal
    await applyThemeStyles(staticThemeChain(catalog, 'Blank'), null, { slot: 'b', timeoutMs: 10 });
    expect(themeLinks()).toHaveLength(3);
    disposeThemeSlot('a');
    expect(themeLinks()).toEqual(['/themes/V3/Blank/style.scoped.css']);
    expect(document.head.querySelector('link[data-hb-theme-slot="a"]')).toBeNull();
    expect(document.adoptedStyleSheets).not.toContain(sheet);
  });

  it('applies CSS text only through the scopeCss hook', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chain = { styles: [{ kind: 'css' as const, css: '.page{color:red}' }] };
    const skipped = await applyThemeStyles(chain, '.page{color:blue}');
    expect(skipped.skippedCss).toBe(2);
    expect(warn).toHaveBeenCalled();
    const scoped: string[] = [];
    const scopeCss = (css: string) => {
      scoped.push(css);
      return {} as CSSStyleSheet;
    };
    const applied = await applyThemeStyles(chain, '.page{color:blue}', { scopeCss });
    expect(scoped).toEqual(['.page{color:red}', '.page{color:blue}']); // theme first, then user CSS
    expect(applied.sheets).toHaveLength(2);
    warn.mockRestore();
  });

  it("reuses a user theme's sheet while its CSS is unchanged, so only the brew CSS is scoped again", async () => {
    // jsdom has no adoptedStyleSheets.
    Object.defineProperty(document, 'adoptedStyleSheets', { value: [], writable: true, configurable: true });
    onTestFinished(() => void Reflect.deleteProperty(document, 'adoptedStyleSheets'));
    const scoped: string[] = [];
    const scopeCss = (css: string) => {
      scoped.push(css);
      return new CSSStyleSheet();
    };
    const chain = { styles: [{ kind: 'css' as const, css: '.page{color:red}', baseUrl: 'http://localhost/t/' }] };
    const a = await applyThemeStyles(chain, '.page{color:blue}', { slot: 'u', scopeCss });
    const b = await applyThemeStyles(chain, '.page{color:green}', { slot: 'u', scopeCss });
    expect(scoped).toEqual(['.page{color:red}', '.page{color:blue}', '.page{color:green}']);
    expect(b.sheets[0]).toBe(a.sheets[0]);
    expect(document.adoptedStyleSheets).toEqual(b.sheets);
    // A changed theme CSS is a new sheet.
    const c = await applyThemeStyles({ styles: [{ kind: 'css', css: '.page{color:teal}' }] }, null, { slot: 'u', scopeCss });
    expect(c.sheets[0]).not.toBe(a.sheets[0]);
    expect(document.adoptedStyleSheets).toEqual(c.sheets);
    disposeThemeSlot('u');
  });
});

describe('waitForFonts', () => {
  it('resolves true without the FontFaceSet API (jsdom)', async () => {
    expect(await waitForFonts()).toBe(true);
  });
});
