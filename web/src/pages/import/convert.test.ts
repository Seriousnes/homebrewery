import { describe, expect, it, vi } from 'vitest';
import { ThemeLoadError, type ThemeChain } from '@/editor/canvas/themeLoader';
import type { HbfmImportResult } from '@/editor/import';
import { convertBrewText, metadataTags, resolveImportTheme, storedSnippets } from './convert';

const chain = (theme: string, name = theme): ThemeChain => ({ theme, name, author: null, styles: [], snippets: [], source: 'static' });

function fakeResult(meta: HbfmImportResult['meta'] = {}): HbfmImportResult {
  return {
    doc: { type: 'doc', content: [{ type: 'page', attrs: { kind: 'manual' }, content: [{ type: 'paragraph' }] }] },
    style: '.x { color: red }',
    meta,
    html: '',
    report: {
      pages: 1,
      theme: '5ePHB',
      clippedPages: [],
      variables: { mode: 'expand', definitions: [], unresolved: [] },
      paginated: null,
      rawHtml: { count: 0, samples: [] },
      commentsDropped: 0,
      styleTagsLifted: 0,
      unknownClasses: [],
      sanitizer: { elements: {}, attributes: {} },
      transparentElements: {},
      lifted: { markers: 0, footers: 0, pageNumbers: 0, objects: 0 },
      positionedInFlow: [],
      lost: [],
      warnings: [],
    },
  };
}

const withMetadata = (yaml: string, body = '# Body\n') => `\`\`\`metadata\n${yaml}\n\`\`\`\n\n${body}`;

describe('metadataTags', () => {
  it('reads tags from the metadata block', () => {
    expect(metadataTags(withMetadata('title: X\ntags:\n  - one\n  - two\n  - 3'))).toEqual(['one', 'two', '3']);
    expect(metadataTags(withMetadata('tags: single'))).toEqual(['single']);
    expect(metadataTags(withMetadata('tags: single').replaceAll('\n', '\r\n'))).toEqual(['single']);
  });

  it('is empty without a block, tags or valid YAML', () => {
    expect(metadataTags('# No metadata')).toEqual([]);
    expect(metadataTags(withMetadata('title: X'))).toEqual([]);
    expect(metadataTags(withMetadata('tags: [unclosed'))).toEqual([]);
    expect(metadataTags('```metadata\ntags: [a]\n')).toEqual([]);
    expect(metadataTags(withMetadata('- a list'))).toEqual([]);
    expect(metadataTags(withMetadata('tags: {a: 1}'))).toEqual([]);
  });
});

describe('storedSnippets', () => {
  it('turns \\snippet text into the stored shape', () => {
    expect(storedSnippets('\\snippet First\n# Hello\n\\snippet Second\nText\n')).toEqual([
      { name: 'First', gen: '# Hello' },
      { name: 'Second', gen: 'Text' },
    ]);
  });

  it('is null without snippets', () => {
    expect(storedSnippets(undefined)).toBeNull();
    expect(storedSnippets('  ')).toBeNull();
    expect(storedSnippets('no snippet header')).toBeNull();
  });
});

describe('resolveImportTheme', () => {
  it('keeps a theme that loads', async () => {
    await expect(resolveImportTheme('5eDMG', (t) => Promise.resolve(chain(t, '5e DMG')))).resolves.toEqual({ theme: '5eDMG', name: '5e DMG', note: null });
    await expect(resolveImportTheme(undefined, (t) => Promise.resolve(chain(t, '5e PHB')))).resolves.toEqual({ theme: '5ePHB', name: '5e PHB', note: null });
  });

  it('falls back to 5ePHB for an unknown theme, with a note', async () => {
    const load = vi.fn((t: string) => (t === '5ePHB' ? Promise.resolve(chain(t, '5e PHB')) : Promise.reject(new ThemeLoadError(`Unknown theme "${t}"`, 404))));
    const resolved = await resolveImportTheme('someUserTheme1', load);
    expect(resolved.theme).toBe('5ePHB');
    expect(resolved.note).toMatch(/“someUserTheme1” isn’t available here, so 5e PHB is used/);
  });

  it('keeps the theme when loading failed for another reason', async () => {
    await expect(
      resolveImportTheme('5eDMG', () => Promise.reject(new TypeError('offline'))),
    ).resolves.toEqual({ theme: '5eDMG', name: '5eDMG', note: null });
  });
});

describe('convertBrewText', () => {
  it('converts with the resolved theme and cleans the metadata', async () => {
    const hbfm = vi.fn(() => Promise.resolve(fakeResult({ title: 'My brew', description: 'd', lang: 'fr', snippets: '\\snippet S\nbody\n' })));
    const text = withMetadata('title: My brew\ntheme: 5eDMG\ntags: [x, y]');
    const result = await convertBrewText(text, { hbfmToDoc: hbfm, loadThemeChain: (t) => Promise.resolve(chain(t, '5e DMG')) });
    expect(hbfm).toHaveBeenCalledWith(text, { theme: '5eDMG' });
    expect(result.meta).toEqual({ title: 'My brew', description: 'd', tags: ['x', 'y'], lang: 'fr', theme: '5eDMG' });
    expect(result.snippets).toEqual([{ name: 'S', gen: 'body' }]);
    expect(result.theme).toBe('5eDMG');
    expect(result.themeName).toBe('5e DMG');
    expect(result.notes).toEqual([]);
  });

  it('reports the theme fallback', async () => {
    const result = await convertBrewText(withMetadata('theme: gone'), {
      hbfmToDoc: () => Promise.resolve(fakeResult()),
      loadThemeChain: (t) => (t === 'gone' ? Promise.reject(new ThemeLoadError('Unknown', 404)) : Promise.resolve(chain(t, '5e PHB'))),
    });
    expect(result.theme).toBe('5ePHB');
    expect(result.meta.theme).toBe('5ePHB');
    expect(result.notes[0]).toMatch(/isn’t available here/);
  });

  it('lets hbfmToDoc reject legacy brews without loading a theme', async () => {
    const load = vi.fn();
    const error = Object.assign(new Error('legacy'), { code: 'legacy-renderer' });
    await expect(
      convertBrewText(withMetadata('renderer: legacy'), {
        hbfmToDoc: () => Promise.reject(error),
        loadThemeChain: load,
      }),
    ).rejects.toBe(error);
    expect(load).not.toHaveBeenCalled();
  });
});
