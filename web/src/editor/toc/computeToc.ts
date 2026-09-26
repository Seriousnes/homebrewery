// The live table of contents' entries (plan §6.5, P5.4): a port of upstream's TOC generator
// (themes/V3/Blank/snippets/tableOfContents.gen.js) that reads the document instead of the
// rendered preview.
//
// - Headings are taken in document order; empty ones, those deeper than the toc's depth and
//   those the theme excludes (computed --TOC: exclude, checked by the caller) are skipped.
// - Page numbers are upstream's mapPages: pages count from 1; a page with a resetCounting
//   marker restarts at 1, a page with skipCounting doesn't advance the count and its headings
//   are left out.
// - Nesting follows upstream's depth chain: a heading nests under the nearest earlier heading
//   of a higher level. Level 0 entries are wrapped in h3, level 1 in h4, deeper ones in nothing.
import type { Node as PMNode } from '@tiptap/pm/model';

export interface PageNumbering {
  /** The number printed for the page (counter(page-numbers) in the theme). */
  number: number;
  /** false on skipCounting pages: their headings are not listed. */
  shown: boolean;
}

const hasClass = (value: unknown, cls: string): boolean => Array.isArray(value) && (value as unknown[]).includes(cls);

/** Whether a page has a marker class anywhere (markers, a node's classes, a span mark). */
function pageHasClass(page: PMNode, cls: string): boolean {
  if (hasClass(page.attrs.markers, cls)) return true;
  let found = false;
  page.descendants((node) => {
    if (found) return false;
    if (hasClass(node.attrs.classes, cls) || node.marks.some((m) => hasClass(m.attrs.classes, cls))) found = true;
    return !found;
  });
  return found;
}

/**
 * What a page contributes to the TOC, computed once per page node (P8.1): nodes are immutable, so
 * a page the author didn't change since the last refresh is not walked again (a keystroke changes
 * one page; the TOC refreshes after every settle).
 */
interface PageTocInfo {
  skip: boolean;
  reset: boolean;
  /** headings in document order; pos is relative to the page's content start */
  headings: { rel: number; level: number; text: string; id: string | null }[];
}

const pageInfos = new WeakMap<PMNode, PageTocInfo>();

function pageTocInfo(page: PMNode): PageTocInfo {
  let info = pageInfos.get(page);
  if (info) return info;
  const headings: PageTocInfo['headings'] = [];
  page.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      headings.push({
        rel: pos,
        level: Number(node.attrs.level) || 1,
        text: node.textContent.trim(),
        id: typeof node.attrs.id === 'string' && node.attrs.id ? node.attrs.id : null,
      });
      return false;
    }
    return !node.isTextblock && !node.isAtom;
  });
  info = { skip: pageHasClass(page, 'skipCounting'), reset: pageHasClass(page, 'resetCounting'), headings };
  pageInfos.set(page, info);
  return info;
}

/** Upstream's mapPages over the document's pages. */
export function pageNumbering(doc: PMNode): PageNumbering[] {
  const out: PageNumbering[] = [];
  let mapped = 0;
  doc.forEach((page) => {
    const { skip, reset } = pageTocInfo(page);
    if (reset) mapped = 1;
    if (!skip && !reset) mapped++;
    out.push({ number: mapped, shown: !skip });
  });
  return out;
}

export interface TocHeading {
  /** Position of the heading node. */
  pos: number;
  level: number;
  /** Trimmed text. */
  text: string;
  /** The heading's id (HeadingIds plugin), or null. */
  id: string | null;
  /** 0-based page index. */
  page: number;
}

/** Every heading of the document, in order, with its page. */
export function collectHeadings(doc: PMNode): TocHeading[] {
  const out: TocHeading[] = [];
  doc.forEach((page, offset, index) => {
    for (const h of pageTocInfo(page).headings) out.push({ pos: offset + 1 + h.rel, level: h.level, text: h.text, id: h.id, page: index });
  });
  return out;
}

export interface TocEntry {
  level: number;
  /** Nesting level (0 = top). */
  nest: number;
  text: string;
  /** Link target: '#<heading id>', or the page ('#p<n>') for a heading without id. */
  href: string;
  /** The printed page number. */
  page: string;
  /** Position of the heading (for navigation). */
  pos: number;
}

export interface TocOptions {
  /** Deepest level listed (1–6). */
  depth: number;
  /** The theme's exclusion (computed --TOC: exclude). Called only for candidates. */
  isExcluded?: (heading: TocHeading) => boolean;
}

/** The entries of a table of contents over `doc`. */
export function tocEntries(doc: PMNode, { depth, isExcluded }: TocOptions): TocEntry[] {
  const numbering = pageNumbering(doc);
  const entries: TocEntry[] = [];
  const chain = [0];
  for (const heading of collectHeadings(doc)) {
    const page = numbering[heading.page];
    if (!heading.text || !page?.shown || heading.level > depth) continue;
    if (isExcluded?.(heading)) continue;
    // Upstream's depth chain: pop to the nearest higher level, then push this one.
    if (heading.level !== chain[chain.length - 1]) {
      while (chain.length > 1 && heading.level <= chain[chain.length - 1]!) chain.pop();
      chain.push(heading.level);
    }
    entries.push({
      level: heading.level,
      nest: chain.length - 2,
      text: heading.text,
      href: heading.id ? `#${heading.id}` : `#p${heading.page + 1}`,
      page: String(page.number),
      pos: heading.pos,
    });
  }
  return entries;
}

export interface TocTreeItem {
  entry: TocEntry;
  children: TocTreeItem[];
}

/**
 * The entries as the nested list upstream's markdown produced: an entry becomes a child of the
 * last entry with a smaller nesting level.
 */
export function tocTree(entries: readonly TocEntry[]): TocTreeItem[] {
  const root: TocTreeItem[] = [];
  const stack: TocTreeItem[] = [];
  for (const entry of entries) {
    const item: TocTreeItem = { entry, children: [] };
    while (stack.length && stack[stack.length - 1]!.entry.nest >= entry.nest) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.children : root).push(item);
    stack.push(item);
  }
  return root;
}

/** The value of a computed --TOC custom property, unquoted ('exclude', 'include' or ''). */
export function tocKeyword(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}
