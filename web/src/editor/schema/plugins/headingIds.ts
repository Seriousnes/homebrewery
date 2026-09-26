// Heading ids (plan §3.4): every heading gets a slug of its text as `id`, unique across the
// document, the way upstream's marked-gfm-heading-id (globalSlugs) numbered them: the TOC and
// #links use these ids. Headings with `customId: true` keep the id the author chose; generated
// slugs avoid those ids and the page ids p1…pN (PageIndexIds), so `#p2` stays a page link.
// A custom id that another heading already has (a pasted copy) is given up by the newcomer: it
// gets a generated id. Re-run after every document change.
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { HeadingSlugger, headingSlugSource } from '../slug';
import { LAYOUT_NEUTRAL_META } from './meta';
import { pageDomId } from './pageIndexIds';
import { runOnceAfterInit } from './runOnce';
import { touchesNode } from './stepScope';
import { survivors, type Survives } from './survivors';

export const headingIdsKey = new PluginKey('hbHeadingIds');

export interface HeadingIdUpdate {
  pos: number;
  id: string | null;
  /** Set (false) when a heading gives up a custom id another heading keeps. */
  customId?: false;
}

/**
 * The id changes needed so every heading in `doc` has a unique id (document order). A custom id
 * held by several headings stays with the first, unless `keeps(pos, id)` names another one (the
 * heading that had it before the change); the others get generated ids.
 */
export function headingIdUpdates(doc: PMNode, keeps?: Survives): HeadingIdUpdate[] {
  const slugger = new HeadingSlugger();
  for (let i = 0; i < doc.childCount; i++) slugger.reserve(pageDomId(i));
  const headings: { node: PMNode; pos: number; customId: string | null }[] = [];
  /** Custom id → position of the heading that keeps it. */
  const owners = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const id = node.attrs.customId === true && typeof node.attrs.id === 'string' && node.attrs.id !== '' ? node.attrs.id : null;
      headings.push({ node, pos, customId: id });
      if (id !== null) {
        const owner = owners.get(id);
        if (owner === undefined || (keeps?.(pos, id) && !keeps(owner, id))) owners.set(id, pos);
      }
      return false;
    }
    return !node.isTextblock && !node.isAtom;
  });
  for (const id of owners.keys()) slugger.reserve(id);

  const updates: HeadingIdUpdate[] = [];
  for (const { node, pos, customId } of headings) {
    if (node.attrs.customId === true && (customId === null || owners.get(customId) === pos)) continue;
    const id = slugger.slug(headingSlugSource(node));
    if (customId !== null) updates.push({ pos, id, customId: false });
    else if (node.attrs.id !== id) updates.push({ pos, id });
  }
  return updates;
}

/** Applies headingIdUpdates to `tr`. Returns false when nothing changed. */
export function assignHeadingIds(tr: Transaction, keeps?: Survives): boolean {
  const updates = headingIdUpdates(tr.doc, keeps);
  for (const { pos, id, customId } of updates) {
    tr.setNodeAttribute(pos, 'id', id);
    if (customId === false) tr.setNodeAttribute(pos, 'customId', false);
  }
  return updates.length > 0;
}

function fixTransaction(state: EditorState, keeps?: Survives): Transaction | null {
  const tr = state.tr;
  if (!assignHeadingIds(tr, keeps)) return null;
  return tr.setMeta('addToHistory', false).setMeta(LAYOUT_NEUTRAL_META, true).setMeta(headingIdsKey, true);
}

/** Custom ids of the headings in `doc`, by position. */
function customIds(doc: PMNode): Map<number, string> {
  const ids = new Map<number, string>();
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      if (node.attrs.customId === true && typeof node.attrs.id === 'string' && node.attrs.id !== '') ids.set(pos, node.attrs.id);
      return false;
    }
    return !node.isTextblock && !node.isAtom;
  });
  return ids;
}

/**
 * Pagination's own transactions (meta 'hbPaginate', pagination/state.ts PAGINATE) that keep the
 * page count: they move whole headings between pages (join + split) and never change their text,
 * attributes or order, so no id can change; only the page count can (generated slugs avoid the
 * page ids p1…pN). Skipping them saves a walk over every heading per pagination step (P8.1).
 */
function layoutOnly(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState): boolean {
  return oldState.doc.childCount === newState.doc.childCount && transactions.every((tr) => tr.getMeta('hbPaginate') !== undefined);
}

const isHeading = (node: PMNode): boolean => node.type.name === 'heading';

/**
 * Whether the ids can have changed: a heading was touched (added, removed, its text or attributes
 * changed) or the page count changed (generated slugs avoid p1…pN). Otherwise the headings and
 * their order are what they were, and so are their ids: typing in a paragraph doesn't walk every
 * heading of the brew (P8.1).
 */
function idsMayChange(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState): boolean {
  if (oldState.doc.childCount !== newState.doc.childCount) return true;
  return touchesNode(
    transactions.filter((tr) => tr.docChanged),
    isHeading,
  );
}

export const HeadingIds = Extension.create({
  name: 'hbHeadingIds',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: headingIdsKey,
        appendTransaction: (transactions, oldState, newState) =>
          transactions.some((tr) => tr.docChanged) && !layoutOnly(transactions, oldState, newState) && idsMayChange(transactions, oldState, newState)
            ? fixTransaction(newState, survivors(transactions, () => customIds(oldState.doc)))
            : null,
        // Documents loaded without ids (hand-built, older saves) are fixed once after mount.
        view: runOnceAfterInit((state) => fixTransaction(state)),
      }),
    ];
  },
});
