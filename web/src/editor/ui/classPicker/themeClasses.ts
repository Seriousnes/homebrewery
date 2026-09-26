// Class names for the class picker (plan §6.1 Mod-M / Shift-Mod-M, §6.2): the classes the ACTIVE
// theme stylesheets and the brew's own CSS style inside the canvas.
//
// Theme links are scoped to `.hb-canvas` at build time (web/vite/scopeThemes.ts) and user CSS at
// runtime (canvas/cssScope.ts, adopted sheets), so a rule counts when its selector mentions the
// canvas scope, or it is nested in such a rule. App chrome (CSS modules) never matches.
//
// Left out: the editor's own classes (RESERVED_CLASSES, ProseMirror-*/tiptap*, hb-*), icon fonts
// and their glyph classes (thousands of `.df.d20::before` / `.fa-dragon::before`), page chrome
// that belongs to page settings (markers, page number, footer) and classes the schema turns into
// other nodes (columnSplit, blank, toc).
import { isAuthorClass } from '../../schema/attrs';
import { ICON_FONTS } from '../../schema/nodes/inline';
import { PAGE_MARKERS } from '../../schema/nodes/page';

export const CANVAS_SCOPE_CLASS = 'hb-canvas';

/** Classes the picker never offers (page settings and schema node types). */
export const NON_AUTHOR_CLASSES: ReadonlySet<string> = new Set([...PAGE_MARKERS, 'pageNumber', 'footnote', 'columnSplit', 'blank', 'toc']);

export interface ThemeClass {
  name: string;
  /** Number of selectors that mention it (a rough measure of how much the theme styles it). */
  rules: number;
  /** Seen on a block (`div` or `.block` in the same compound). */
  block: boolean;
  /** Seen on an inline span (`span` or `.inline-block` in the same compound). */
  inline: boolean;
}

const ICON_FONT_SET: ReadonlySet<string> = new Set(ICON_FONTS);
/** A class selector's name: a CSS identifier, escapes included (non-ASCII allowed). */
const NAME_START = String.raw`(?:-?[_a-zA-Z]|[^\x00-\x7f]|\\[0-9a-fA-F]{1,6}\s?|\\[^\n0-9a-fA-F])`;
const NAME_CHAR = String.raw`(?:[-\w]|[^\x00-\x7f]|\\[0-9a-fA-F]{1,6}\s?|\\[^\n0-9a-fA-F])`;
const CLASS_TOKEN = new RegExp(String.raw`\.(${NAME_START}${NAME_CHAR}*)`, 'g');

function unescapeCss(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : (ch ?? ''),
  );
}

/** Whether a class can be offered: an author class that isn't an editor, icon or page-setting class. */
export function isSuggestableClass(name: string): boolean {
  if (!name || !isAuthorClass(name) || name.startsWith('hb-') || name === CANVAS_SCOPE_CLASS) return false;
  if (ICON_FONT_SET.has(name) || /^fa(?:-|$)/.test(name)) return false;
  return !NON_AUTHOR_CLASSES.has(name);
}

export interface SelectorClasses {
  /** Every class of the selector (icon glyphs included), unescaped. */
  classes: string[];
  /** Per class: seen next to div/.block, span/.inline-block, or with an icon font. */
  block: Set<string>;
  inline: Set<string>;
  icon: Set<string>;
}

/**
 * The classes in a selector list, with the compound each appears in: `.page .monster.frame h2`
 * gives page, monster, frame. Attribute selectors and strings are ignored.
 */
export function selectorClasses(selectorText: string): SelectorClasses {
  const out: SelectorClasses = { classes: [], block: new Set(), inline: new Set(), icon: new Set() };
  const cleaned = selectorText.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/\[[^\]]*\]/g, '[]');
  for (const compound of cleaned.split(/[\s>+~,()]+/)) {
    if (!compound.includes('.')) continue;
    const names = Array.from(compound.matchAll(CLASS_TOKEN), (m) => unescapeCss(m[1]!));
    if (names.length === 0) continue;
    const tag = /^[a-zA-Z][\w-]*/.exec(compound)?.[0]?.toLowerCase();
    const isBlock = tag === 'div' || names.includes('block');
    const isInline = tag === 'span' || names.includes('inline-block');
    const isIcon = names.some((n) => ICON_FONT_SET.has(n));
    for (const name of names) {
      out.classes.push(name);
      if (isBlock) out.block.add(name);
      if (isInline) out.inline.add(name);
      if (isIcon) out.icon.add(name);
    }
  }
  return out;
}

interface Tally {
  rules: number;
  block: boolean;
  inline: boolean;
}

function addSelector(tallies: Map<string, Tally>, selectorText: string): void {
  const found = selectorClasses(selectorText);
  const seen = new Set<string>();
  for (const name of found.classes) {
    if (seen.has(name) || found.icon.has(name) || !isSuggestableClass(name)) continue;
    seen.add(name);
    const tally = tallies.get(name) ?? { rules: 0, block: false, inline: false };
    tally.rules += 1;
    tally.block ||= found.block.has(name);
    tally.inline ||= found.inline.has(name);
    tallies.set(name, tally);
  }
}

/** Minimal CSSOM shapes, so tests can pass plain objects and jsdom sheets alike. */
interface RuleLike {
  selectorText?: string;
  cssRules?: ArrayLike<RuleLike>;
}
interface SheetLike {
  cssRules: ArrayLike<RuleLike>;
}

function walkRules(rules: ArrayLike<RuleLike>, inScope: boolean, tallies: Map<string, Tally>, scopeToken: RegExp): void {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    let scoped = inScope;
    if (typeof rule.selectorText === 'string') {
      scoped = inScope || scopeToken.test(rule.selectorText);
      if (scoped) addSelector(tallies, rule.selectorText);
    }
    let children: ArrayLike<RuleLike> | undefined;
    try {
      children = rule.cssRules;
    } catch {
      children = undefined;
    }
    if (children && children.length) walkRules(children, scoped, tallies, scopeToken);
  }
}

function readRules(sheet: SheetLike): ArrayLike<RuleLike> | null {
  try {
    return sheet.cssRules;
  } catch {
    return null; // cross-origin sheet
  }
}

export interface CollectThemeClassesOptions {
  /** The document whose sheets are read (default: the global document). */
  document?: Document;
  /** Sheets to read instead of the document's (tests). */
  sheets?: readonly SheetLike[];
  /** The scope class every theme and user selector carries (default 'hb-canvas'). */
  scopeClass?: string;
}

/**
 * Every class the canvas-scoped rules of the document's stylesheets (links, style elements and
 * adopted sheets) mention, most used first. Unreadable (cross-origin) sheets are skipped.
 */
export function collectThemeClasses(options: CollectThemeClassesOptions = {}): ThemeClass[] {
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
  const sheets: SheetLike[] = options.sheets
    ? [...options.sheets]
    : doc
      ? ([...Array.from(doc.styleSheets), ...('adoptedStyleSheets' in doc ? doc.adoptedStyleSheets : [])] as unknown as SheetLike[])
      : [];
  const scope = options.scopeClass ?? CANVAS_SCOPE_CLASS;
  const scopeToken = new RegExp(`\\.${scope.replace(/[-]/g, '\\-')}(?![-\\w])`);
  const tallies = new Map<string, Tally>();
  for (const sheet of sheets) {
    const rules = readRules(sheet);
    if (rules) walkRules(rules, false, tallies, scopeToken);
  }
  return Array.from(tallies, ([name, t]) => ({ name, rules: t.rules, block: t.block, inline: t.inline })).sort(
    (a, b) => b.rules - a.rules || a.name.localeCompare(b.name),
  );
}

export type ClassPickerMode = 'span' | 'themeBlock';

/**
 * The suggestions for a query: classes containing it (case-insensitive), exact match first, then
 * prefix, then word-start (after '-' or a lower-to-upper case change), then anywhere; within a
 * rank, classes seen on the mode's element (spans for 'span', blocks for 'themeBlock') first,
 * then the most used. `exclude` (already chosen) is left out.
 */
export function suggestClasses(all: readonly ThemeClass[], query: string, mode: ClassPickerMode, exclude: readonly string[] = []): ThemeClass[] {
  const q = query.trim().toLowerCase();
  const skip = new Set(exclude);
  const rank = (name: string): number => {
    if (!q) return 0;
    const lower = name.toLowerCase();
    if (lower === q) return 0;
    if (lower.startsWith(q)) return 1;
    const words = name.split(/-|(?<=[a-z0-9])(?=[A-Z])/).map((w) => w.toLowerCase());
    if (words.some((w) => w.startsWith(q))) return 2;
    return lower.includes(q) ? 3 : -1;
  };
  const affinity = (c: ThemeClass) => (mode === 'span' ? c.inline : c.block) ? 1 : 0;
  return all
    .filter((c) => !skip.has(c.name))
    .map((c) => ({ c, r: rank(c.name) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || affinity(b.c) - affinity(a.c) || b.c.rules - a.c.rules || a.c.name.localeCompare(b.c.name))
    .map(({ c }) => c);
}
