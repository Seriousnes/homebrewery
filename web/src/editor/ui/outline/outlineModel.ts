// The outline (P3.9, plan §6.2): pages and headings read from the document, not the DOM, with the
// labels of upstream's header navigation (legacy/client/homebrew/brewRenderer/headerNav/
// headerNav.jsx:20-37).
//
// Upstream rules, in document terms:
// - Every page is an entry, "Page N". A page that contains a cover marker (frontCover,
//   insideCover, partCover, backCover) or a table of contents is a top-level page: its label says
//   so (with the text of its first h1 for covers) and its headings are not listed.
// - On other pages: the blocks directly on the page that have an id (headings: depth = level;
//   anything else with an id: depth 7), and h2 headings anywhere on the page (e.g. the title of a
//   monster stat block).
// Heading ids come from the HeadingIds plugin; a heading continued from the previous page has no
// id and is skipped.
import type { Node as PMNode } from '@tiptap/pm/model';

export type TopLevelPageType = 'frontCover' | 'insideCover' | 'partCover' | 'backCover' | 'toc';

/** Checked in upstream's order: the first type a page contains names it. */
export const TOP_LEVEL_PAGE_TYPES: readonly TopLevelPageType[] = ['frontCover', 'insideCover', 'partCover', 'backCover', 'toc'];

const TOP_LEVEL_LABELS: Record<TopLevelPageType, (h1: string) => string> = {
  frontCover: (text) => (text ? `Cover: ${text}` : 'Cover Page'),
  insideCover: (text) => (text ? `Interior: ${text}` : 'Interior Cover Page'),
  partCover: (text) => (text ? `Section: ${text}` : 'Section Cover Page'),
  backCover: (text) => (text ? `Back: ${text}` : 'Rear Cover Page'),
  toc: () => 'Table of Contents',
};

export interface OutlineEntry {
  kind: 'heading' | 'block';
  /** The DOM id (heading slug, or the block's id attribute). */
  id: string;
  /** Position of the node when the outline was built (re-resolve by id before using it). */
  pos: number;
  /** 1-6 for headings, 7 for other blocks with an id (upstream). */
  depth: number;
  /** The first line of the text. */
  text: string;
  nodeType: string;
}

export interface OutlinePage {
  kind: 'page';
  /** 0-based. */
  index: number;
  /** 1-based. */
  number: number;
  /** The page's DOM id, p{number}. */
  id: string;
  pos: number;
  pageType: TopLevelPageType | null;
  /** "Page 3", "Page 1 - Cover: The Wandering Inn". */
  label: string;
  entries: OutlineEntry[];
}

/** The first non-empty line, trimmed. */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * Upstream's trimString: the first line, at most 40 - prefixLength characters, then '...'. The
 * outline shows the full first line with CSS ellipsis instead; this is kept for callers that need
 * a short plain-text label (e.g. a tooltip-less menu).
 */
export function shortLabel(text: string, prefixLength = 0, maxLength = 40): string {
  const line = firstLine(text);
  const max = maxLength - prefixLength;
  return line.length > max ? `${line.slice(0, max).trim()}...` : line;
}

/** A node's text with block separators and hard breaks as newlines (like upstream's textContent). */
export function nodeText(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));
}

function classesOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
}

interface PageScan {
  types: Set<TopLevelPageType>;
  firstH1: string | null;
}

/** Which top-level page types `page` contains (markers, page objects, classes of nodes and spans, toc nodes). */
function scanPage(page: PMNode): PageScan {
  const types = new Set<TopLevelPageType>();
  const add = (classes: readonly string[]) => {
    for (const c of classes) if ((TOP_LEVEL_PAGE_TYPES as readonly string[]).includes(c)) types.add(c as TopLevelPageType);
  };
  add(classesOf(page.attrs.markers));
  const objects: unknown = page.attrs.objects;
  if (Array.isArray(objects)) for (const o of objects as unknown[]) if (o && typeof o === 'object') add(classesOf((o as { classes?: unknown }).classes));
  let firstH1: string | null = null;
  page.descendants((node) => {
    if (node.type.name === 'toc') types.add('toc');
    add(classesOf(node.attrs.classes));
    for (const mark of node.marks) add(classesOf(mark.attrs.classes));
    if (firstH1 === null && node.type.name === 'heading' && node.attrs.level === 1) firstH1 = firstLine(nodeText(node));
    return !node.isAtom;
  });
  return { types, firstH1 };
}

/** The top-level type of a page (upstream's order), or null. */
export function topLevelPageType(page: PMNode): TopLevelPageType | null {
  const { types } = scanPage(page);
  return TOP_LEVEL_PAGE_TYPES.find((t) => types.has(t)) ?? null;
}

const idOf = (node: PMNode): string | null => (typeof node.attrs.id === 'string' && node.attrs.id !== '' ? node.attrs.id : null);

function entriesOf(page: PMNode, pagePos: number): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const contentStart = pagePos + 1;
  page.forEach((block, offset) => {
    const pos = contentStart + offset;
    const id = idOf(block);
    if (id) {
      const isHeading = block.type.name === 'heading';
      const level = Number(block.attrs.level);
      entries.push({
        kind: isHeading ? 'heading' : 'block',
        id,
        pos,
        depth: isHeading && level >= 1 && level <= 6 ? level : 7,
        text: firstLine(nodeText(block)),
        nodeType: block.type.name,
      });
    }
    if (block.isTextblock || block.isAtom) return;
    // h2 headings nested anywhere inside this block (stat block titles and the like).
    block.descendants((node, rel) => {
      if (node.type.name === 'heading') {
        const nestedId = idOf(node);
        if (node.attrs.level === 2 && nestedId) {
          entries.push({ kind: 'heading', id: nestedId, pos: pos + 1 + rel, depth: 2, text: firstLine(nodeText(node)), nodeType: 'heading' });
        }
        return false;
      }
      return !node.isTextblock && !node.isAtom;
    });
  });
  return entries.filter((e) => e.text !== '');
}

/** The outline of `doc` (a doc › page+ document). */
export function buildOutline(doc: PMNode): OutlinePage[] {
  const pages: OutlinePage[] = [];
  doc.forEach((page, pos, index) => {
    const number = index + 1;
    const { types, firstH1 } = scanPage(page);
    const pageType = TOP_LEVEL_PAGE_TYPES.find((t) => types.has(t)) ?? null;
    const label = pageType ? `Page ${number} - ${TOP_LEVEL_LABELS[pageType](firstH1 ?? '')}` : `Page ${number}`;
    pages.push({
      kind: 'page',
      index,
      number,
      id: `p${number}`,
      pos,
      pageType,
      label,
      entries: pageType ? [] : entriesOf(page, pos),
    });
  });
  return pages;
}

/** True when two outlines would render the same (positions are ignored). */
export function sameOutline(a: readonly OutlinePage[], b: readonly OutlinePage[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((page, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      page.label === other.label &&
      page.entries.length === other.entries.length &&
      page.entries.every((e, j) => {
        const o = other.entries[j];
        return o !== undefined && e.id === o.id && e.text === o.text && e.depth === o.depth && e.kind === o.kind;
      })
    );
  });
}

/**
 * The position of the block with DOM id `id` now: a heading (or other block) with that id,
 * preferring the one nearest `hint`. Null when it is gone.
 */
export function findBlockById(doc: PMNode, id: string, hint = 0): number | null {
  let best: number | null = null;
  doc.descendants((node, pos) => {
    if (node.attrs.id === id && node.isBlock && node.type.name !== 'page') {
      if (best === null || Math.abs(pos - hint) < Math.abs(best - hint)) best = pos;
    }
    return !node.isTextblock && !node.isAtom;
  });
  return best;
}
