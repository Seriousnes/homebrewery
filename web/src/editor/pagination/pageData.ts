// Pages that carry data of their own (page objects, page markers; boundary.ts carriesPageData) and
// the author's edits (plan §4.9: page objects are page content; a page that carries objects is
// never deleted by a pull).
//
//   restoreJoinedPages   appendTransaction part: a selection deleted (or typed or pasted over)
//                        across a page boundary joins the pages the ProseMirror way, keeping the
//                        first page's attributes, so a later page's objects and markers would
//                        vanish (review finding PGR-8). Such a page comes back after the block
//                        that received the join, in the author's undo event (restorePageAt, a
//                        PageBreakStep: undo removes exactly that page again). A page whose whole
//                        flow was deleted goes with its data, as a deleted page does.
//   dropEmptiedPlaceholders
//                        appendTransaction part: an auto page kept only for its data
//                        (isPlaceholderPage) whose last object or marker the author removed is
//                        deleted in the same undo event. Left alone, pagination would pull its
//                        empty paragraph into the page before it (a stray blank line).
//
// Undo and redo (history transactions) are exact inverses of earlier events: both leave them alone.
import { isHistoryTransaction } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Selection, type Transaction } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { carriesPageData, isAutoPage, isPlaceholderPage, mapToken } from './boundary';
import { isAuthorChange } from './fragments';
import { restorePageAt } from './pageSteps';

const sameJSON = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether `doc` still has page `page` (by pid, or by its objects and markers when it has none). */
function stillThere(doc: PMNode, page: PMNode): boolean {
  const pid = page.attrs.pid as unknown;
  let found = false;
  doc.forEach((other) => {
    if (found) return;
    if (typeof pid === 'string' && pid !== '') found = other.attrs.pid === pid;
    else found = sameJSON(other.attrs.objects, page.attrs.objects) && sameJSON(other.attrs.markers, page.attrs.markers);
  });
  return found;
}

/** The mapping of `trs` followed by the steps `tr` has so far. */
function mappingOf(trs: readonly Transaction[], tr: Transaction): Mapping {
  const mapping = new Mapping();
  for (const t of trs) mapping.appendMapping(t.mapping);
  mapping.appendMapping(tr.mapping);
  return mapping;
}

const authoredOnly = (trs: readonly Transaction[]): boolean => trs.some(isAuthorChange) && !trs.some((t) => isHistoryTransaction(t));

/**
 * See the top of this file. `tr` is a transaction on the state after `trs` (it may hold steps
 * already); `oldDoc` is the document before `trs`.
 */
export function restoreJoinedPages(tr: Transaction, trs: readonly Transaction[], oldDoc: PMNode): void {
  if (!authoredOnly(trs)) return;
  const mapping = mappingOf(trs, tr);
  const lost: { at: number; attrs: PMNode['attrs'] }[] = [];
  let pos = 0;
  oldDoc.forEach((page, _offset, index) => {
    const pagePos = pos;
    pos += page.nodeSize;
    if (index === 0 || !carriesPageData(page)) return;
    // The page's opening token was deleted (joined into the page before it) …
    if (mapToken(mapping, pagePos) !== null) return;
    // … but not its whole flow (the closing token of its last block survived) …
    if (mapToken(mapping, pagePos + page.nodeSize - 2) === null) return;
    // … and no command brought it back.
    if (stillThere(tr.doc, page)) return;
    lost.push({ at: mapping.map(pagePos + 1, 1), attrs: page.attrs });
  });
  // Last first: restoring a page changes nothing before it.
  for (let k = lost.length - 1; k >= 0; k--) restorePageAt(tr, lost[k]!.at, lost[k]!.attrs);
}

/** See the top of this file (same arguments as restoreJoinedPages). */
export function dropEmptiedPlaceholders(tr: Transaction, trs: readonly Transaction[], oldDoc: PMNode): void {
  if (!authoredOnly(trs)) return;
  const mapping = mappingOf(trs, tr);
  const drop: number[] = [];
  let pos = 0;
  oldDoc.forEach((page, _offset, index) => {
    const pagePos = pos;
    pos += page.nodeSize;
    if (index === 0 || !isAutoPage(page) || !isPlaceholderPage(page)) return;
    const mapped = mapToken(mapping, pagePos);
    if (mapped === null) return;
    const now = tr.doc.nodeAt(mapped);
    if (!now || now.type !== page.type || tr.doc.resolve(mapped).depth !== 0 || !isAutoPage(now) || carriesPageData(now)) return;
    const only = now.firstChild;
    if (now.childCount !== 1 || !only || only.type.name !== 'paragraph' || only.content.size > 0 || only.attrs.continuation === true) return;
    drop.push(mapped);
  });
  for (let k = drop.length - 1; k >= 0; k--) {
    const at = drop[k]!;
    const page = tr.doc.nodeAt(at)!;
    const inside = tr.selection.from > at && tr.selection.to < at + page.nodeSize;
    tr.delete(at, at + page.nodeSize);
    if (inside) tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size)), -1));
  }
}
