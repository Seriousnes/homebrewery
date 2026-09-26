// Snippet groups flattened for a searchable menu: every snippet with a generator becomes one
// entry, filed under a section (the group plus its submenu trail, e.g. "License › Creative
// Commons › Text Declarations"). As in upstream's snippet bar, an entry with subsnippets is a
// submenu only: its own generator (the "default" one) is not offered.
import { describeNativeAction, nativeActionOf, type NativeSnippetAction } from './native';
import type { ThemeSnippet, ThemeSnippetGenerator, ThemeSnippetGroup } from './themeSnippets';

export interface SnippetEntry {
  /** Stable id within the tree ("s12"), for DOM ids. */
  id: string;
  name: string;
  /** Font Awesome classes from the theme (not rendered by the app chrome). */
  icon: string;
  /** Group name then submenu names, then the snippet's own name. */
  path: string[];
  view: 'text' | 'style';
  gen: ThemeSnippetGenerator;
  native: NativeSnippetAction | null;
  /** A hint for the menu (native actions). */
  hint: string | null;
  experimental: boolean;
  disabled: boolean;
}

export interface SnippetSection {
  id: string;
  /** Group name then submenu names. */
  path: string[];
  /** path joined with " › ". */
  label: string;
  entries: SnippetEntry[];
}

export const PATH_SEPARATOR = ' › ';
export const pathLabel = (path: readonly string[]): string => path.join(PATH_SEPARATOR);

/** The sections of `groups` (in menu order); sections without entries are left out. */
export function snippetSections(groups: readonly ThemeSnippetGroup[]): SnippetSection[] {
  const sections: SnippetSection[] = [];
  let n = 0;
  const walk = (snippets: readonly ThemeSnippet[], trail: string[], view: 'text' | 'style') => {
    const section: SnippetSection = { id: `sec${sections.length}`, path: trail, label: pathLabel(trail), entries: [] };
    sections.push(section);
    for (const snippet of snippets) {
      if (!snippet || typeof snippet.name !== 'string') continue;
      if (snippet.subsnippets) {
        walk(snippet.subsnippets, [...trail, snippet.name], view);
        continue;
      }
      if (!snippet.gen) continue;
      const native = nativeActionOf(snippet.gen);
      section.entries.push({
        id: `s${n++}`,
        name: snippet.name,
        icon: snippet.icon ?? '',
        path: [...trail, snippet.name],
        view,
        gen: snippet.gen,
        native,
        hint: native ? describeNativeAction(native) : null,
        experimental: Boolean(snippet.experimental),
        disabled: Boolean(snippet.disabled),
      });
    }
  };
  for (const group of groups) walk(group.snippets ?? [], [group.groupName], group.view);
  return sections.filter((s) => s.entries.length > 0);
}

/** Case- and accent-insensitive text for matching. */
const fold = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Sections whose entries match every word of `query` (in the entry's name or its section path).
 * An empty query returns `sections` unchanged.
 */
export function filterSections(sections: readonly SnippetSection[], query: string): SnippetSection[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...sections];
  const out: SnippetSection[] = [];
  for (const section of sections) {
    const entries = section.entries.filter((entry) => {
      const haystack = fold(`${entry.path.join(' ')}`);
      return words.every((w) => haystack.includes(w));
    });
    if (entries.length) out.push({ ...section, entries });
  }
  return out;
}

/** Finds an entry by its path (e.g. ['PHB', 'Monster Stat Block']). */
export function findSnippet(sections: readonly SnippetSection[], path: readonly string[]): SnippetEntry | null {
  const label = pathLabel(path);
  for (const section of sections) for (const entry of section.entries) if (pathLabel(entry.path) === label) return entry;
  return null;
}
