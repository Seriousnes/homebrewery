// Pure logic of the brew list pages, ported from legacy client/homebrew/pages/basePages/listPage
// (listPage.jsx) and brewItem.jsx: the client-side sort and filter of a user's brews, tag filters,
// the list state in the URL (?sort=&dir=&filter=&tag=…) and the user page's groups. No React here,
// so the rules are unit tested on their own.
import type { BrewSummary, UserBrewList } from '@/api';

// ─── Sorting ────────────────────────────────────────────────────────────────────────────────────

/** Client-side sorts of the user page (upstream: alpha, created, updated, views; page count is new). */
export const LIST_SORTS = ['title', 'created', 'updated', 'views', 'pages'] as const;
export type ListSort = (typeof LIST_SORTS)[number];
export type SortDir = 'asc' | 'desc';

export const DEFAULT_LIST_SORT: ListSort = 'title';
export const DEFAULT_SORT_DIR: SortDir = 'asc';

export const LIST_SORT_LABELS: Record<ListSort, string> = {
  title: 'Title',
  created: 'Created',
  updated: 'Updated',
  views: 'Views',
  pages: 'Pages',
};

/** A sort value from a URL or storage; upstream's names ('alpha', 'createdAt', …) are accepted. */
export function parseListSort(value: string | null | undefined): ListSort | null {
  const v = value?.trim().toLowerCase();
  switch (v) {
    case 'title':
    case 'alpha':
      return 'title';
    case 'created':
    case 'createdat':
      return 'created';
    case 'updated':
    case 'updatedat':
      return 'updated';
    case 'views':
      return 'views';
    case 'pages':
    case 'pagecount':
      return 'pages';
    default:
      return null;
  }
}

export function parseSortDir(value: string | null | undefined): SortDir | null {
  const v = value?.trim().toLowerCase();
  return v === 'asc' || v === 'desc' ? v : null;
}

/** The direction a sort starts with when it is picked: A to Z for titles, newest/most first otherwise. */
export function defaultDirFor(sort: string): SortDir {
  return sort === 'title' ? 'asc' : 'desc';
}

/** How a direction reads for a sort ("A to Z", "newest first", …); relevance included for the vault. */
export function dirLabel(sort: string, dir: SortDir): string {
  switch (sort) {
    case 'title':
      return dir === 'asc' ? 'A to Z' : 'Z to A';
    case 'created':
    case 'updated':
      return dir === 'asc' ? 'oldest first' : 'newest first';
    case 'relevance':
      return dir === 'asc' ? 'weakest match first' : 'best match first';
    default:
      return dir === 'asc' ? 'fewest first' : 'most first';
  }
}

// lodash's deburr, without the dependency: Latin-1 Supplement and Latin Extended-A letters lose
// their accents (NFD + combining marks removed) and the ligatures and letters that don't decompose
// are spelled out.
const DEBURR_EXTRA: Record<string, string> = {
  Æ: 'Ae',
  æ: 'ae',
  Ø: 'O',
  ø: 'o',
  Œ: 'Oe',
  œ: 'oe',
  ß: 'ss',
  Þ: 'Th',
  þ: 'th',
  Ð: 'D',
  ð: 'd',
  Đ: 'D',
  đ: 'd',
  Ħ: 'H',
  ħ: 'h',
  ı: 'i',
  Ĳ: 'IJ',
  ĳ: 'ij',
  Ŀ: 'L',
  ŀ: 'l',
  Ł: 'L',
  ł: 'l',
  ŉ: "'n",
  Ŋ: 'N',
  ŋ: 'n',
  Ŧ: 'T',
  ŧ: 't',
  ſ: 's',
};
const DEBURR_EXTRA_RE = new RegExp(`[${Object.keys(DEBURR_EXTRA).join('')}]`, 'g');

/** Accents removed ('Épée' → 'Epee', 'Straße' → 'Strasse'), as lodash's deburr. */
export function deburr(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ︠-︯⃐-⃿]/g, '')
    .replace(DEBURR_EXTRA_RE, (ch) => DEBURR_EXTRA[ch] ?? ch)
    .normalize('NFC');
}

/** The title a brew is shown and sorted under. */
export const UNTITLED = 'Untitled brew';
export const displayTitle = (brew: Pick<BrewSummary, 'title'>): string => brew.title.trim() || UNTITLED;

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

function compareBy(sort: ListSort, a: BrewSummary, b: BrewSummary): number {
  switch (sort) {
    case 'title':
      return collator.compare(deburr(displayTitle(a).toLowerCase()), deburr(displayTitle(b).toLowerCase()));
    case 'created':
      return time(a.createdAt) - time(b.createdAt);
    case 'updated':
      return time(a.updatedAt) - time(b.updatedAt);
    case 'views':
      return a.views - b.views;
    case 'pages':
      return a.pageCount - b.pageCount;
  }
}

/**
 * Sorted copy (upstream: lodash orderBy on title/created/updated/views). Ties keep the most
 * recently updated first, then the share id, so the order never depends on the API's.
 */
export function sortBrews(brews: readonly BrewSummary[], sort: ListSort, dir: SortDir): BrewSummary[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...brews].sort(
    (a, b) =>
      sign * compareBy(sort, a, b) ||
      time(b.updatedAt) - time(a.updatedAt) ||
      (a.shareId < b.shareId ? -1 : a.shareId > b.shareId ? 1 : 0),
  );
}

// ─── Filtering ──────────────────────────────────────────────────────────────────────────────────

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Upstream's filter: the text must appear (accents and case ignored) in the title, the description
 * or the tags, and the brew must have every selected tag (case ignored).
 */
export function filterBrews(brews: readonly BrewSummary[], filter: string, tags: readonly string[]): BrewSummary[] {
  const needle = deburr(filter.trim()).toLowerCase();
  return brews.filter((brew) => {
    if (needle) {
      const haystack = deburr([brew.title, brew.description, brew.tags.join(',')].join('\n').toLowerCase());
      if (!haystack.includes(needle)) return false;
    }
    return tags.every((tag) => brew.tags.some((own) => sameTag(own, tag)));
  });
}

/** Adds the tag, or removes it (every case variant) when it is already selected. Keeps click order. */
export function toggleTag(tags: readonly string[], tag: string): string[] {
  const clean = tag.trim();
  if (!clean) return [...tags];
  return tags.some((t) => sameTag(t, clean)) ? tags.filter((t) => !sameTag(t, clean)) : [...tags, clean];
}

export const hasTag = (tags: readonly string[], tag: string): boolean => tags.some((t) => sameTag(t, tag));

/** Upstream's tag order: plain tags first, then by the position of ':', then alphabetically. */
export function sortTags(tags: readonly string[]): string[] {
  return tags
    .filter((tag) => tag.trim() !== '')
    .sort((a, b) => a.indexOf(':') - b.indexOf(':') || a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** A tag's prefix and value ('type:Adventure' → { prefix: 'type', value: 'Adventure' }); upstream's regex. */
export function tagParts(tag: string): { prefix: string | null; value: string } {
  const match = /^(?:([^:]+):)?([^:]+)$/.exec(tag);
  if (!match) return { prefix: null, value: tag };
  return { prefix: match[1]?.trim() || null, value: match[2]!.trim() };
}

// ─── The list state in the URL ──────────────────────────────────────────────────────────────────

export interface ListState {
  /** Free text (upstream ?filter=). */
  filter: string;
  /** Selected tags in click order (upstream ?tag=a&tag=b). */
  tags: string[];
  sort: ListSort;
  dir: SortDir;
}

export interface SortPrefs {
  sort: ListSort;
  dir: SortDir;
}

export const LIST_QUERY_KEYS = ['sort', 'dir', 'filter', 'tag'] as const;

/** The state a URL asks for; sort and dir fall back to the stored preference. */
export function readListQuery(params: URLSearchParams, prefs: SortPrefs): ListState {
  const tags: string[] = [];
  for (const tag of params.getAll('tag')) if (tag.trim() && !hasTag(tags, tag.trim())) tags.push(tag.trim());
  return {
    filter: params.get('filter') ?? '',
    tags,
    sort: parseListSort(params.get('sort')) ?? prefs.sort,
    dir: parseSortDir(params.get('dir')) ?? prefs.dir,
  };
}

/** `params` with the list state written in (other parameters kept); upstream always writes sort and dir. */
export function writeListQuery(params: URLSearchParams, state: ListState): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of LIST_QUERY_KEYS) next.delete(key);
  next.set('sort', state.sort);
  next.set('dir', state.dir);
  if (state.filter.trim()) next.set('filter', state.filter);
  for (const tag of state.tags) next.append('tag', tag);
  return next;
}

// ─── Groups (user page) ─────────────────────────────────────────────────────────────────────────

export const GROUP_IDS = ['published', 'unpublished', 'invited'] as const;
export type GroupId = (typeof GROUP_IDS)[number];

export interface BrewGroup {
  id: GroupId;
  title: string;
  brews: BrewSummary[];
  /** What the group says when it has no brews at all. */
  empty: string;
}

/** "alice’s", "james’" (upstream's rule). */
export function possessive(handle: string): string {
  return handle + (handle.endsWith('s') ? '’' : '’s');
}

/**
 * The user page's groups. Other people see the published brews; the user also sees the
 * unpublished ones and (when there are any) the brews they are invited to edit.
 */
export function groupUserBrews(list: Pick<UserBrewList, 'handle' | 'own' | 'items'>): BrewGroup[] {
  const whose = possessive(list.handle);
  if (!list.own) {
    return [{ id: 'published', title: `${whose} published brews`, brews: [...list.items], empty: `${list.handle} has no published brews.` }];
  }
  const mine = list.items.filter((b) => b.role !== 'invited');
  const invited = list.items.filter((b) => b.role === 'invited');
  const groups: BrewGroup[] = [
    { id: 'published', title: 'Your published brews', brews: mine.filter((b) => b.published), empty: 'No published brews.' },
    { id: 'unpublished', title: 'Your unpublished brews', brews: mine.filter((b) => !b.published), empty: 'No unpublished brews.' },
  ];
  if (invited.length > 0) groups.push({ id: 'invited', title: 'Brews you are invited to edit', brews: invited, empty: 'No invitations.' });
  return groups;
}

const countFormat = new Intl.NumberFormat('en');
export const formatCount = (n: number): string => countFormat.format(n);

/** "1 brew", "12 brews". */
export const brewCount = (n: number): string => `${formatCount(n)} ${n === 1 ? 'brew' : 'brews'}`;

/** The result line: "12 brews" or, while filtering, "Showing 3 of 12 brews". */
export function countSummary(shown: number, total: number, filtering = shown !== total): string {
  return filtering ? `Showing ${formatCount(shown)} of ${brewCount(total)}` : brewCount(total);
}

/** The groups after the filter and sort (what the user page shows). */
export function visibleGroups(groups: readonly BrewGroup[], state: ListState): BrewGroup[] {
  return groups.map((group) => ({ ...group, brews: sortBrews(filterBrews(group.brews, state.filter, state.tags), state.sort, state.dir) }));
}
