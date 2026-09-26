// Class-name suggestions for the inspector's class fields and the Style drawer's completion (plan
// §6.2: "suggested from the class names in the active theme's stylesheets").
//
// The theme's classes come from the class picker lane (web/src/editor/ui/classPicker:
// collectThemeClasses reads the canvas-scoped rules of the theme links and the adopted user CSS,
// and suggestClasses ranks them). This file adds a cache (a scan reads every rule of every
// sheet), the classes the document already uses, and the plain-list filter for suggestions given
// from outside.
import type { Node as PMNode } from '@tiptap/pm/model';
import { collectThemeClasses, isSuggestableClass, suggestClasses, type ClassPickerMode, type ThemeClass } from '../classPicker/themeClasses';

/** Suggestions for a class field: (typed text, classes already applied) → class names, best first. */
export type ClassSuggester = (query: string, applied: readonly string[]) => readonly string[];

export const MAX_CLASS_SUGGESTIONS = 50;

let cache: { sheets: readonly unknown[]; classes: ThemeClass[] } | null = null;

/**
 * The canvas theme's classes (collectThemeClasses), most used first. Cached while the document's
 * stylesheets are the same objects: theme sheets don't change once loaded, and a brew CSS edit
 * adopts a new sheet.
 */
export function themeClasses(doc: Document = document): ThemeClass[] {
  const sheets: unknown[] = [...Array.from(doc.styleSheets), ...(doc.adoptedStyleSheets ?? [])];
  if (cache && cache.sheets.length === sheets.length && cache.sheets.every((s, i) => s === sheets[i])) return cache.classes;
  const classes = collectThemeClasses({ document: doc });
  cache = { sheets, classes };
  return classes;
}

/** Class names the document already uses (nodes, span marks, page objects), sorted. */
export function documentClassNames(doc: PMNode): string[] {
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (Array.isArray(value)) for (const name of value) if (typeof name === 'string' && isSuggestableClass(name)) out.add(name);
  };
  doc.descendants((node) => {
    add(node.attrs.classes);
    if (Array.isArray(node.attrs.objects)) for (const o of node.attrs.objects as { classes?: unknown }[]) add(o?.classes);
    for (const mark of node.marks) add(mark.attrs.classes);
    return true;
  });
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Theme classes ranked for `query` by the class picker's rules (exact, prefix, word start, then
 * anywhere; classes seen on the mode's element first, then the most used), followed by classes
 * only the document uses. Applied classes are left out.
 */
export function rankClassSuggestions(
  theme: readonly ThemeClass[],
  documentNames: readonly string[],
  query: string,
  mode: ClassPickerMode,
  applied: readonly string[],
  limit = MAX_CLASS_SUGGESTIONS,
): string[] {
  const q = query.trim().replace(/^\./, '');
  const known = new Set(theme.map((c) => c.name));
  const all: ThemeClass[] = [...theme, ...documentNames.filter((name) => !known.has(name)).map((name) => ({ name, rules: 0, block: false, inline: false }))];
  return suggestClasses(all, q, mode, applied)
    .slice(0, limit)
    .map((c) => c.name);
}

/**
 * Suggestions from a plain list of names: those containing `query` (case-insensitive), names
 * starting with it first, list order otherwise, without the applied ones.
 */
export function filterClassSuggestions(names: readonly string[], query: string, applied: readonly string[], limit = MAX_CLASS_SUGGESTIONS): string[] {
  const q = query.trim().replace(/^\./, '').toLowerCase();
  const skip = new Set(applied);
  const starts: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    if (skip.has(name)) continue;
    const lower = name.toLowerCase();
    if (q === '' || lower.startsWith(q)) starts.push(name);
    else if (lower.includes(q)) contains.push(name);
  }
  return [...starts, ...contains].slice(0, limit);
}
