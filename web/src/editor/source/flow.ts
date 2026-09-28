// The document as the source editor sees it: sections, each one flow of blocks.
//
// A section is a manual page and the auto pages pagination made after it (plan §4.1). Auto-page
// boundaries are layout, not content, so the source never shows them: a block that pagination
// split over two pages (a head and its `continuation` fragments) is one flow item here, merged
// the way rejoinContinuations (pagination/boundary.ts) joins fragments. Each item remembers the
// document range its fragments cover, so an edit can replace exactly those.
//
// Pure ProseMirror (no DOM): runs in Vitest on plain nodes.
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { isAutoPage, isPlaceholderPage } from '../pagination/boundary';

/** One block of a section's flow: the fragments of a split block merged into one node. */
export interface FlowItem {
  /** The block (merged when pagination split it; the head's attributes). */
  node: PMNode;
  /** Position before its first fragment. */
  from: number;
  /** Position after its last fragment. */
  to: number;
}

export interface Section {
  /** Index of the section's first page. */
  first: number;
  /** Index of its last page. */
  last: number;
  /** Its first page (the section settings, markers and objects the source shows). */
  page: PMNode;
  /** Position before its first page. */
  pos: number;
  /** Position after its last page. */
  end: number;
  items: FlowItem[];
}

/**
 * `b` joined onto `a` (b is a's continuation: same type, `continuation: true`), level by level
 * down their seam, as rejoinContinuations does: the head keeps its attributes, and an empty filler
 * textblock pagination added at the start of a fragment (splitFilled) goes. null when the joined
 * content would be invalid (a stale flag: kept as two blocks).
 */
export function joinFragments(a: PMNode, b: PMNode): PMNode | null {
  let content = a.content;
  let rest = b.content;
  const last = content.lastChild;
  let first = rest.firstChild;
  if (first && first.isTextblock && first.content.size === 0 && first.attrs.continuation === true && last?.type !== first.type) {
    rest = rest.cut(first.nodeSize);
    first = rest.firstChild;
  }
  if (last && first && !last.isText && !first.isText && first.attrs.continuation === true && first.type === last.type) {
    const joined = joinFragments(last, first);
    if (joined) {
      content = content.replaceChild(content.childCount - 1, joined);
      rest = rest.cut(first.nodeSize);
    }
  }
  const merged = content.append(rest);
  return a.type.validContent(merged) ? a.copy(merged) : null;
}

/** Whether `next` continues `prev` across a page seam (same type, flagged). */
const continues = (prev: PMNode, next: PMNode): boolean => !next.isText && next.attrs.continuation === true && next.type === prev.type;

/** The document's sections, in order, with their merged flows. */
export function sectionsOf(doc: PMNode): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  /** The last child of the page before (the seam a continuation must continue). */
  let lastOfPrevPage: PMNode | null = null;
  let pos = 0;
  doc.forEach((page, _offset, index) => {
    const auto = index > 0 && isAutoPage(page);
    if (!auto || !current) {
      current = { first: index, last: index, page, pos, end: pos + page.nodeSize, items: [] };
      sections.push(current);
      lastOfPrevPage = null;
    }
    const section: Section = current;
    section.last = index;
    section.end = pos + page.nodeSize;
    // A page kept alive only for its objects or markers holds one empty paragraph: not content.
    if (auto && isPlaceholderPage(page)) {
      lastOfPrevPage = null;
    } else {
      page.forEach((block, blockOffset, blockIndex) => {
        const from = pos + 1 + blockOffset;
        const to = from + block.nodeSize;
        const prevItem = section.items.at(-1);
        if (auto && blockIndex === 0 && prevItem && lastOfPrevPage && continues(lastOfPrevPage, block)) {
          const joined = joinFragments(prevItem.node, block);
          if (joined) {
            prevItem.node = joined;
            prevItem.to = to;
            return;
          }
        }
        section.items.push({ node: block, from, to });
      });
      lastOfPrevPage = page.lastChild;
    }
    pos += page.nodeSize;
  });
  return sections;
}

/** Index of the section that contains page `pageIndex`. */
export function sectionIndexOfPage(sections: readonly Section[], pageIndex: number): number {
  for (let i = sections.length - 1; i >= 0; i--) if (sections[i]!.first <= pageIndex) return i;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// comparing blocks the way the source sees them

/** Structural equality of attribute values (JSON data: key order doesn't matter). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => sameValue(v, (b as unknown[])[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Whether two blocks are the same content as far as the source can tell: `continuation` flags
 * (layout) are ignored, and so are generated heading ids (the headingIds plugin assigns them; the
 * source only shows ids an author chose).
 */
export function sameBlock(a: PMNode, b: PMNode): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.isText) return a.eq(b);
  if (a.marks.length !== b.marks.length || !a.marks.every((m, i) => m.eq(b.marks[i]!))) return false;
  const heading = a.type.name === 'heading';
  const customIds = a.attrs.customId === true || b.attrs.customId === true;
  for (const key of Object.keys(a.attrs)) {
    if (key === 'continuation') continue;
    if (heading && key === 'id' && !customIds) continue;
    if (!sameValue(a.attrs[key], b.attrs[key])) return false;
  }
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) if (!sameBlock(a.child(i), b.child(i))) return false;
  return true;
}

/** The page attributes the source shows for a section (not pid, kind or layout state). */
export const SOURCE_PAGE_ATTRS = ['columns', 'markers', 'pageNumber', 'footer', 'objects', 'classes', 'style', 'id', 'attributes'] as const;

export function samePageAttrs(a: PMNode, b: PMNode): boolean {
  return SOURCE_PAGE_ATTRS.every((key) => sameValue(a.attrs[key], b.attrs[key]));
}

/** `node` with every `continuation` flag cleared (a merged or parsed block is one block). */
export function withoutContinuations(node: PMNode): PMNode {
  if (node.isText || node.isLeaf) return node;
  let changed = false;
  const children: PMNode[] = [];
  node.forEach((child) => {
    const clean = withoutContinuations(child);
    if (clean !== child) changed = true;
    children.push(clean);
  });
  const flagged = node.attrs.continuation === true;
  if (!changed && !flagged) return node;
  return node.type.create(flagged ? { ...node.attrs, continuation: false } : node.attrs, changed ? Fragment.fromArray(children) : node.content, node.marks);
}
