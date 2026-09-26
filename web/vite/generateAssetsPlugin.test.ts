import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateThemeOutputs, type ThemeCatalog, type ThemeOutputs } from './generateAssetsPlugin.ts';

const themesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../themes');

function content(outputs: ThemeOutputs, rel: string): string {
  const output = outputs.files.get(rel);
  if (output?.kind !== 'content') throw new Error(`${rel} is not generated content`);
  return output.data;
}

// Compiles the real themes/ directory.
describe('generateThemeOutputs', () => {
  let outputs: ThemeOutputs;

  beforeAll(async () => {
    outputs = await generateThemeOutputs({ themesDir });
  });

  it('builds style.css and style.scoped.css for every V3 theme', () => {
    const keys = outputs.catalog.themes.map((theme) => theme.key);
    expect(keys).toEqual(['5eDMG', '5ePHB', 'Blank', 'Journal', 'UnearthedArcana']);
    for (const key of keys) {
      const css = content(outputs, `themes/V3/${key}/style.css`);
      const scoped = content(outputs, `themes/V3/${key}/style.scoped.css`);
      expect(css.length).toBeGreaterThan(0);
      expect(scoped).toContain('.hb-canvas');
    }
  });

  it('scopes theme selectors and keeps @font-face and @page', () => {
    const scoped = content(outputs, 'themes/V3/5ePHB/style.scoped.css');
    expect(scoped).toMatch(/\.hb-canvas \.page\b/);
    expect(scoped).not.toMatch(/(^|[},]\s*)(:root|html|body)\s*[{,]/m);
    const blank = content(outputs, 'themes/V3/Blank/style.scoped.css');
    expect(blank).toContain('@font-face');
    expect(blank).toMatch(/@page\s*\{/);
    expect(blank).toMatch(/\.hb-canvas\s*\{[^}]*counter-reset/);
  });

  it('writes a themes.json catalog for the server', () => {
    const catalog = JSON.parse(content(outputs, 'themes/themes.json')) as ThemeCatalog;
    expect(catalog).toEqual(outputs.catalog);
    const phb = catalog.themes.find((theme) => theme.key === '5ePHB');
    expect(phb).toEqual({
      key: '5ePHB',
      name: '5e PHB',
      renderer: 'V3',
      baseTheme: 'Blank',
      baseSnippets: null,
      path: '5ePHB',
      style: '/themes/V3/5ePHB/style.css',
      scopedStyle: '/themes/V3/5ePHB/style.scoped.css',
      preview: '/themes/V3/5ePHB/dropdownPreview.png',
      texture: '/themes/V3/5ePHB/dropdownTexture.png',
      hasSnippets: true,
    });
    const dmg = catalog.themes.find((theme) => theme.key === '5eDMG');
    expect(dmg?.baseTheme).toBe('5ePHB');
    expect(dmg?.baseSnippets).toBe('5ePHB');
    expect(catalog.themes.find((theme) => theme.key === 'UnearthedArcana')?.hasSnippets).toBe(false);
  });

  it('skips Legacy-renderer themes', () => {
    expect(outputs.skippedLegacy).toEqual(['5ePHB']);
    expect([...outputs.files.keys()].some((rel) => rel.startsWith('themes/Legacy/'))).toBe(false);
  });

  it('copies fonts and assets without LESS or JS sources', () => {
    expect(outputs.files.get('fonts/5e/Bookinsanity.woff2')?.kind).toBe('file');
    expect(outputs.files.get('fonts/iconFonts/diceFont.woff2')?.kind).toBe('file');
    expect(outputs.files.get('assets/parchmentBackground.jpg')?.kind).toBe('file');
    const rels = [...outputs.files.keys()];
    expect(rels.filter((rel) => /\.(less|js)$/.test(rel))).toEqual([]);
  });

  it('resolves every font and image url() in the compiled CSS', () => {
    expect(outputs.unresolvedUrls).toEqual([]);
  });
});
