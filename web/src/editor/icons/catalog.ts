// The icon catalog (P5.5, plan §6.6): every icon of the four icon fonts, from the name maps
// upstream's `:name:` emoji syntax uses (themes/fonts/iconFonts/*.js). An icon inserts as the
// schema's icon node: font = the first class, glyph = the rest ("df d12-2" → df + d12-2).
import diceFont from '@themes/fonts/iconFonts/diceFont.js';
import elderberryInn from '@themes/fonts/iconFonts/elderberryInn.js';
import fontAwesome from '@themes/fonts/iconFonts/fontAwesome.js';
import gameIcons from '@themes/fonts/iconFonts/gameIcons.js';

export type IconSetId = 'dice' | 'elderberryInn' | 'gameIcons' | 'fontAwesome';

export interface IconSet {
  id: IconSetId;
  label: string;
}

export const ICON_SETS: readonly IconSet[] = [
  { id: 'dice', label: 'Dice' },
  { id: 'elderberryInn', label: 'Elderberry Inn' },
  { id: 'gameIcons', label: 'Game Icons' },
  { id: 'fontAwesome', label: 'Font Awesome' },
];

export interface IconEntry {
  /** the `:name:` of upstream's markdown, e.g. "df_d12_2" */
  name: string;
  /** the icon font class, e.g. "df" (icon.attrs.font) */
  font: string;
  /** the other classes, e.g. "d12-2" (icon.attrs.glyph) */
  glyph: string;
  set: IconSetId;
  /** readable name, e.g. "d12 2" */
  label: string;
  /** lower-case words of the name (without the font prefix), for search */
  words: string[];
}

const PREFIXES = /^(?:df|ei|gi|fas|far|fab)_/;

function entry(name: string, classes: string, set: IconSetId): IconEntry | null {
  const parts = classes.trim().split(/\s+/);
  const font = parts[0];
  if (!font) return null;
  const bare = name.replace(PREFIXES, '');
  const words = bare.toLowerCase().split('_').filter(Boolean);
  const style = set === 'fontAwesome' ? ({ fas: ' (solid)', far: ' (regular)', fab: ' (brand)' } as Record<string, string>)[font] ?? '' : '';
  return { name, font, glyph: parts.slice(1).join(' '), set, label: `${words.join(' ')}${style}`, words };
}

function build(): IconEntry[] {
  const sources: [Record<string, string>, IconSetId][] = [
    [diceFont, 'dice'],
    [elderberryInn, 'elderberryInn'],
    [gameIcons, 'gameIcons'],
    [fontAwesome, 'fontAwesome'],
  ];
  const out: IconEntry[] = [];
  for (const [map, set] of sources) {
    for (const [name, classes] of Object.entries(map)) {
      const e = entry(name, classes, set);
      if (e) out.push(e);
    }
  }
  return out;
}

let catalog: IconEntry[] | null = null;
let byName: Map<string, IconEntry> | null = null;

/** Every icon, dice first, then Elderberry Inn, Game Icons and Font Awesome (map order). */
export function iconCatalog(): readonly IconEntry[] {
  catalog ??= build();
  return catalog;
}

/** The icon for a `:name:` (without the colons), or undefined. */
export function iconByName(name: string): IconEntry | undefined {
  byName ??= new Map(iconCatalog().map((e) => [e.name, e]));
  return byName.get(name);
}

/** The icon's CSS classes ("df d12-2"). */
export const iconClasses = (e: Pick<IconEntry, 'font' | 'glyph'>): string => (e.glyph ? `${e.font} ${e.glyph}` : e.font);

/** Search words of a query: "D12 2", "d12-2" and "df_d12_2" all give ["d12", "2"]. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/^:+|:+$/g, '')
    .replace(PREFIXES, '')
    .split(/[\s_\-:]+/)
    .filter(Boolean);
}

/**
 * Rank of an icon for query words (lower is better), or null when it doesn't match:
 *   0  the exact name ("df_d12_2")
 *   1  the icon's name starts with the query words ("d12 2" → d12-2, d12-20)
 *   2  every query word starts one of the icon's words ("shield wolf")
 *   3  every query word is somewhere in the name ("ragon" → dragon)
 */
function rank(e: IconEntry, words: string[], raw: string): number | null {
  if (words.length === 0) return 3;
  if (e.name === raw) return 0;
  if (words.every((w, i) => e.words[i]?.startsWith(w) && (i === words.length - 1 || e.words[i] === w))) return 1;
  if (words.every((w) => e.words.some((x) => x.startsWith(w)))) return 2;
  const joined = e.words.join('_');
  return words.every((w) => joined.includes(w)) ? 3 : null;
}

export interface IconSearchOptions {
  /** only this set */
  set?: IconSetId | null;
  /** at most this many results (default 200) */
  limit?: number;
}

export interface IconSearchResult {
  results: IconEntry[];
  /** how many icons matched in total (results is cut at `limit`) */
  total: number;
}

/** Icons matching `query` across the four fonts, best first (see rank). */
export function searchIcons(query: string, { set = null, limit = 200 }: IconSearchOptions = {}): IconSearchResult {
  const words = queryWords(query);
  const raw = query.trim().replace(/^:+|:+$/g, '').toLowerCase();
  const scored: [number, number, IconEntry][] = [];
  iconCatalog().forEach((e, i) => {
    if (set && e.set !== set) return;
    const r = rank(e, words, raw);
    if (r !== null) scored.push([r, i, e]);
  });
  scored.sort((a, b) => a[0] - b[0] || a[2].words.length - b[2].words.length || a[1] - b[1]);
  return { results: scored.slice(0, limit).map((s) => s[2]), total: scored.length };
}
