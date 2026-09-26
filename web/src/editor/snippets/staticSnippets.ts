// The static themes' snippet modules (themes/V3/*/snippets.js), loaded on demand by snippet
// group id ("V3_5ePHB", as in the theme bundle's `snippets`). Each module is its own chunk: the
// Blank one carries the license texts. footer.gen.js and tableOfContents.gen.js are replaced by
// ./shims at build time (web/vite/themeSnippetShims.ts).
import type { ThemeSnippetGroup } from './themeSnippets';

const modules = import.meta.glob<ThemeSnippetGroup[]>('@themes/V3/*/snippets.js', { import: 'default' });

/** Snippet group id ("V3_<theme>") → module loader. */
export const STATIC_SNIPPET_LOADERS: Readonly<Record<string, () => Promise<ThemeSnippetGroup[]>>> = Object.fromEntries(
  Object.entries(modules).flatMap(([file, load]) => {
    const key = /\/V3\/([^/]+)\/snippets\.js$/.exec(file)?.[1];
    return key ? [[`V3_${key}`, load] as const] : [];
  }),
);

/** Whether `ref` names a static theme's snippets that this build can load. */
export const hasStaticSnippets = (ref: string): boolean => Object.hasOwn(STATIC_SNIPPET_LOADERS, ref);

/**
 * The snippet groups of a static theme ("V3_5ePHB"), or [] for a theme without snippets
 * (UnearthedArcana) or an unknown / legacy id ("Legacy_5ePHB": legacy brews aren't supported).
 */
export async function loadStaticSnippets(ref: string): Promise<ThemeSnippetGroup[]> {
  const load = hasStaticSnippets(ref) ? STATIC_SNIPPET_LOADERS[ref] : undefined;
  if (!load) return [];
  const groups = await load();
  return Array.isArray(groups) ? groups : [];
}
