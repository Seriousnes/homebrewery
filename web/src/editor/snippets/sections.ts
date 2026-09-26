// Section and page helpers for snippets that change page settings (plan §6.3 native
// replacements). A section is a manual page plus the auto pages that follow it; SECTION_ATTRS
// are the same on all of them.
//
// setSectionAttrs is a local stand-in for the pagination-UX lane's section command (P4.6): it
// writes the attributes on every page of the section in the given transaction (AttrSteps only,
// so positions don't move and undo can map them). If a section-sync appendTransaction exists,
// writing all pages is still correct.
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { setPageAttr } from '../objects/pageAttrStep';
import { isAutoPage, sectionStartIndex } from '../pagination/boundary';
import { SECTION_ATTRS } from '../schema/nodes/page';

export type SectionAttrName = (typeof SECTION_ATTRS)[number];

/** Indexes of the first (manual) and last page of the section page `index` belongs to. */
export function sectionBounds(doc: PMNode, index: number): { first: number; last: number } {
  const first = sectionStartIndex(doc, index);
  let last = Math.max(first, Math.min(index, doc.childCount - 1));
  while (last + 1 < doc.childCount && isAutoPage(doc.child(last + 1))) last++;
  return { first, last };
}

/** Position before page `index`. */
export function pagePos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index && i < doc.childCount; i++) pos += doc.child(i).nodeSize;
  return pos;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Sets section attributes on every page of the section containing page `index`. Returns
 * whether anything changed.
 */
export function setSectionAttrs(tr: Transaction, index: number, attrs: Partial<Record<SectionAttrName, unknown>>): boolean {
  const { first, last } = sectionBounds(tr.doc, index);
  let pos = pagePos(tr.doc, first);
  let changed = false;
  for (let i = first; i <= last; i++) {
    const page = tr.doc.child(i);
    for (const [name, value] of Object.entries(attrs)) {
      if (!(SECTION_ATTRS as readonly string[]).includes(name) || same(page.attrs[name], value)) continue;
      tr.setNodeAttribute(pos, name, value);
      changed = true;
    }
    pos += page.nodeSize;
  }
  return changed;
}

/** Adds page markers (frontCover, skipCounting, …) to page `index`. Returns whether it changed. */
export function addPageMarkers(tr: Transaction, index: number, markers: readonly string[]): boolean {
  const page = tr.doc.child(index);
  const current = (page.attrs.markers as string[] | undefined) ?? [];
  const next = [...current, ...markers.filter((m) => !current.includes(m))];
  if (next.length === current.length) return false;
  setPageAttr(tr, pagePos(tr.doc, index), 'markers', next);
  return true;
}

/** Whether a page holds nothing: one empty paragraph and no markers, objects, footer or number. */
export function isBlankPage(page: PMNode): boolean {
  if (page.childCount !== 1) return false;
  const only = page.firstChild;
  if (!only || only.type.name !== 'paragraph' || only.content.size !== 0) return false;
  const a = page.attrs as { markers?: unknown[]; objects?: unknown[]; footer?: unknown; pageNumber?: unknown };
  return !a.markers?.length && !a.objects?.length && !a.footer && !a.pageNumber;
}

/** Whether a page's flow is one empty paragraph (its settings may be set). */
export function hasEmptyFlow(page: PMNode): boolean {
  const only = page.firstChild;
  return page.childCount === 1 && only?.type.name === 'paragraph' && only.content.size === 0;
}

/**
 * Whether inserted pages may replace this page: its flow is empty and it has nothing of its own
 * (markers, objects, id, attributes). Its section settings may be set: they are carried over.
 */
export function isReplaceablePage(page: PMNode): boolean {
  if (!hasEmptyFlow(page)) return false;
  const a = page.attrs as { markers?: unknown[]; objects?: unknown[]; id?: unknown; attributes?: Record<string, unknown> | null };
  return !a.markers?.length && !a.objects?.length && !a.id && Object.keys(a.attributes ?? {}).length === 0;
}
