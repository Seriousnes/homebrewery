// Stable page ids (plan §3.4): every page gets a random `pid` when it has none, and pages whose
// pid duplicates another page's (copy/paste, split) get a new one. The page that had the pid
// before the change keeps it, so a copy pasted in front of its original doesn't take over the
// original's identity; on mount (no earlier state), the first page in document order keeps it.
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { customAlphabet } from 'nanoid';
import { LAYOUT_NEUTRAL_META } from './meta';
import { runOnceAfterInit } from './runOnce';
import { withinPages } from './stepScope';
import { survivors, type Survives } from './survivors';

export const pageIdsKey = new PluginKey('hbPageIds');

/** 8 characters of [0-9a-z], e.g. "k3f9a1qe" (36^8 ≈ 2.8e12 ids). */
export const newPageId: () => string = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

const validPid = (pid: unknown): pid is string => typeof pid === 'string' && pid !== '';

/**
 * Positions of pages that need a new pid (missing or duplicate), in document order. A duplicate
 * pid stays on the first page that has it, unless `keeps(pos, pid)` names another one (the page
 * that had it before the change).
 */
export function pagesNeedingIds(doc: PMNode, keeps?: Survives): number[] {
  const owners = new Map<string, number>();
  doc.forEach((page, pos) => {
    const pid = page.attrs.pid as unknown;
    if (page.type.name !== 'page' || !validPid(pid)) return;
    const owner = owners.get(pid);
    if (owner === undefined || (keeps?.(pos, pid) && !keeps(owner, pid))) owners.set(pid, pos);
  });
  const positions: number[] = [];
  doc.forEach((page, pos) => {
    if (page.type.name !== 'page') return;
    const pid = page.attrs.pid as unknown;
    if (!validPid(pid) || owners.get(pid) !== pos) positions.push(pos);
  });
  return positions;
}

/** Assigns fresh pids where needed. Returns false when nothing changed. */
export function assignPageIds(tr: Transaction, generate: () => string = newPageId, keeps?: Survives): boolean {
  const positions = pagesNeedingIds(tr.doc, keeps);
  if (positions.length === 0) return false;
  const taken = new Set<string>();
  tr.doc.forEach((page) => {
    if (typeof page.attrs.pid === 'string') taken.add(page.attrs.pid);
  });
  for (const pos of positions) {
    let pid = generate();
    while (taken.has(pid)) pid = generate();
    taken.add(pid);
    tr.setNodeAttribute(pos, 'pid', pid);
  }
  return true;
}

function fixTransaction(state: EditorState, keeps?: Survives): Transaction | null {
  const tr = state.tr;
  if (!assignPageIds(tr, newPageId, keeps)) return null;
  return tr.setMeta('addToHistory', false).setMeta(LAYOUT_NEUTRAL_META, true).setMeta(pageIdsKey, true);
}

/** The pids of the pages in `doc`, by position. */
function pagePids(doc: PMNode): Map<number, string> {
  const pids = new Map<number, string>();
  doc.forEach((page, pos) => {
    if (validPid(page.attrs.pid)) pids.set(pos, page.attrs.pid);
  });
  return pids;
}

export const PageIds = Extension.create({
  name: 'hbPageIds',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pageIdsKey,
        appendTransaction: (transactions, oldState, newState) => {
          const changed = transactions.filter((tr) => tr.docChanged);
          if (changed.length === 0) return null;
          // Changes inside pages (typing) add no page and change no pid (P8.1).
          if (oldState.doc.childCount === newState.doc.childCount && withinPages(changed)) return null;
          return fixTransaction(newState, survivors(transactions, () => pagePids(oldState.doc)));
        },
        view: runOnceAfterInit((state) => fixTransaction(state)),
      }),
    ];
  },
});
