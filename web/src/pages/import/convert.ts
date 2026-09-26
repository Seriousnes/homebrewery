// The conversion step of /import (plan §7, P6.1): brew text → document, CSS, snippets, metadata and
// the import report. Loaded on demand (the page imports it with import()): it pulls in the HBFM
// renderer, the sanitizer, the probe and the schema.
//
// Before hbfmToDoc runs, the brew's theme is checked: a theme this site doesn't have (an upstream
// user theme, a typo) would leave the probe without stylesheets and the brew unopenable, so the
// import falls back to 5ePHB and says so.
import { load } from 'js-yaml';
import { loadThemeChain, ThemeLoadError, type LoadThemeChainOptions, type ThemeChain } from '@/editor/canvas/themeLoader';
import { brewSnippetsToJSON, DEFAULT_IMPORT_THEME, hbfmToDoc, splitTextStyleAndMetadata, type HbfmImportResult, type HbfmToDocOptions } from '@/editor/import';
import { cleanImportMeta, type StoredSnippet } from './importBrew';

export interface ImportConversion {
  /** hbfmToDoc's result: doc (one manual page per source page), style, metadata, report. */
  result: HbfmImportResult;
  /** The metadata to create the brew with (cleaned for the API). */
  meta: ReturnType<typeof cleanImportMeta>['meta'];
  /** The brew's own snippets in the stored shape, or null. */
  snippets: StoredSnippet[] | null;
  /** The theme used, and its display name. */
  theme: string;
  themeName: string;
  /** What the import page changed besides the conversion (theme fallback, shortened title, …). */
  notes: string[];
}

export interface ConvertDeps {
  hbfmToDoc?: (text: string, options?: HbfmToDocOptions) => Promise<HbfmImportResult>;
  loadThemeChain?: (theme: string, options?: LoadThemeChainOptions) => Promise<ThemeChain>;
}

const BLOCK_END = '\n```\n\n';

/**
 * The tags in the ```metadata block. Upstream writes them there (homebrew.api.js mergeBrewText),
 * but its splitTextStyleAndMetadata doesn't read them back (tags live beside the text upstream).
 */
export function metadataTags(raw: string): string[] {
  const text = raw.replaceAll('\r\n', '\n');
  if (!text.startsWith('```metadata')) return [];
  const end = text.indexOf(BLOCK_END);
  if (end < 0) return [];
  let meta: unknown;
  try {
    meta = load(text.slice(11, end + 1));
  } catch {
    return [];
  }
  const tags = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>).tags : undefined;
  if (typeof tags === 'string') return tags.trim() ? [tags] : [];
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string | number => typeof t === 'string' || typeof t === 'number').map(String);
}

/** `\snippet name` text (hbfmToDoc's meta.snippets) → the stored shape, in order. */
export function storedSnippets(text: string | undefined): StoredSnippet[] | null {
  if (!text?.trim()) return null;
  const groups = brewSnippetsToJSON('', text, null, false).snippets;
  const list = groups.flatMap((g) => g.subsnippets.map((s) => ({ name: s.name, gen: s.gen })));
  return list.length ? list : null;
}

/** The theme to import with: the brew's own when this site has it, else 5ePHB (with a note). */
export async function resolveImportTheme(
  wanted: string | undefined,
  load: NonNullable<ConvertDeps['loadThemeChain']> = loadThemeChain,
): Promise<{ theme: string; name: string; note: string | null }> {
  const theme = wanted?.trim() || DEFAULT_IMPORT_THEME;
  try {
    const chain = await load(theme);
    return { theme, name: chain.name, note: null };
  } catch (error) {
    // Only "no such theme" falls back; a network failure keeps the theme (the report warns).
    const unknown = error instanceof ThemeLoadError && (error.status === 404 || error.status === 422 || error.status === 423);
    if (!unknown || theme === DEFAULT_IMPORT_THEME) return { theme, name: theme, note: null };
    let name = DEFAULT_IMPORT_THEME;
    try {
      name = (await load(DEFAULT_IMPORT_THEME)).name;
    } catch {
      // The default theme's name is only for display.
    }
    return {
      theme: DEFAULT_IMPORT_THEME,
      name,
      note: `The brew’s theme “${theme.slice(0, 64)}” isn’t available here, so ${name} is used. You can pick another theme in the brew’s Properties.`,
    };
  }
}

/** Converts a brew text for /import. Throws ImportError('legacy-renderer') for legacy brews. */
export async function convertBrewText(text: string, deps: ConvertDeps = {}): Promise<ImportConversion> {
  const convert = deps.hbfmToDoc ?? hbfmToDoc;
  // The metadata alone (cheap): which theme to lay the pages out with.
  const split = splitTextStyleAndMetadata({ text });
  const resolved =
    split.renderer === 'legacy' ? { theme: DEFAULT_IMPORT_THEME, name: DEFAULT_IMPORT_THEME, note: null } : await resolveImportTheme(split.theme, deps.loadThemeChain);
  const result = await convert(text, { theme: resolved.theme });
  const cleaned = cleanImportMeta({
    title: result.meta.title,
    description: result.meta.description,
    tags: metadataTags(text),
    lang: result.meta.lang,
    theme: resolved.theme,
  });
  return {
    result,
    meta: cleaned.meta,
    snippets: storedSnippets(result.meta.snippets),
    theme: resolved.theme,
    themeName: resolved.name,
    notes: [...(resolved.note ? [resolved.note] : []), ...cleaned.notes],
  };
}
