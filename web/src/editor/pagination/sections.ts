// Section settings on auto pages (plan §4.1): an auto page copies the section settings
// (SECTION_ATTRS: columns, pageNumber, footer, classes, style) of its section's first page, the
// manual page before it. This appendTransaction keeps the copies in sync whenever a
// transaction changed page attributes or added or removed pages: the section's first page wins.
//
// The copies are written outside the undo history (addToHistory false): undoing the author's
// change of the first page is one step, and the sync then copies the restored value again.
// Commands that change which page starts a section write that page's settings themselves, in
// the history (commands/sections.ts), so an undo restores them.
//
// Pagination's own transactions (and the appended fragment fixes) are skipped: they create auto
// pages with copied settings and never change a section's first page.
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { SECTION_ATTRS } from '../schema/nodes/page';
import { isAutoPage } from './boundary';
import { isAuthorChange } from './fragments';
import { SECTION_SYNC } from './state';

export { SECTION_SYNC };

export const sectionSyncKey = new PluginKey('hbSectionSync');

/** Equality of section attribute values (null, booleans, numbers, strings, string arrays). */
export function sameSectionValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return false;
}

const copyValue = (value: unknown): unknown => (Array.isArray(value) ? [...(value as unknown[])] : value);

/**
 * Adds to `tr` the attribute steps that make every auto page's section settings equal to its
 * section's first page (tr.doc). Returns the number of steps added.
 */
export function syncSectionAttrs(tr: Transaction): number {
  const before = tr.steps.length;
  let head: PMNode | null = null;
  let pos = 0;
  const doc = tr.doc;
  for (let i = 0; i < doc.childCount; i++) {
    const page = doc.child(i);
    if (i === 0 || !isAutoPage(page) || head === null) head = page;
    else {
      for (const key of SECTION_ATTRS) {
        const value = head.attrs[key] as unknown;
        if (!sameSectionValue(page.attrs[key], value)) tr.setNodeAttribute(pos, key, copyValue(value));
      }
    }
    pos += page.nodeSize;
  }
  return tr.steps.length - before;
}

/** Whether `doc`'s pages differ from `old`'s in count or in any page's attributes (by identity). */
function pagesChanged(old: PMNode, doc: PMNode): boolean {
  if (old.childCount !== doc.childCount) return true;
  for (let i = 0; i < doc.childCount; i++) if (old.child(i).attrs !== doc.child(i).attrs) return true;
  return false;
}

/** The section sync (see the top of this file). The Pagination extension includes it. */
export function sectionSyncPlugin(): Plugin {
  return new Plugin({
    key: sectionSyncKey,
    appendTransaction(trs: readonly Transaction[], oldState: EditorState, state: EditorState) {
      // A page node's attrs object is kept while only its content changes: typing is cheap.
      if (!trs.some(isAuthorChange) || !pagesChanged(oldState.doc, state.doc)) return null;
      const tr = state.tr;
      if (syncSectionAttrs(tr) === 0) return null;
      return tr.setMeta(SECTION_SYNC, true).setMeta('addToHistory', false);
    },
  });
}
