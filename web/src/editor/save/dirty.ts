// Which transactions make the brew dirty (plan §9 useAutosave: "Dirty = a transaction with
// docChanged && !tr.getMeta(PAGINATE), or a style/meta edit").
import type { Transaction } from '@tiptap/pm/state';
import { PAGINATE } from '../pagination/state';
import { LAYOUT_NEUTRAL_META } from '../schema/plugins/meta';

/**
 * Meta on transactions that make the editor match the server (the sanitized document after a
 * create, "Load the saved version"): they change the document but leave nothing to save.
 */
export const SERVER_DOC_META = 'hbServerDoc';

/**
 * True when `tr` is an author's change that needs saving. Not dirty: pagination (PAGINATE: page
 * boundaries, oversized flags), the pid and heading-id bookkeeping (LAYOUT_NEUTRAL_META, which
 * also runs once on mount) and server syncs (SERVER_DOC_META). Undo and redo are dirty.
 */
export function isDirtyTransaction(tr: Transaction): boolean {
  return (
    tr.docChanged &&
    tr.getMeta(PAGINATE) === undefined &&
    tr.getMeta(LAYOUT_NEUTRAL_META) === undefined &&
    tr.getMeta(SERVER_DOC_META) === undefined
  );
}

/** A transaction the author didn't make: pagination, id bookkeeping or a server sync. */
function isMachineTransaction(tr: Transaction): boolean {
  return tr.getMeta(PAGINATE) !== undefined || tr.getMeta(LAYOUT_NEUTRAL_META) !== undefined || tr.getMeta(SERVER_DOC_META) !== undefined;
}

/**
 * A dispatch with its appended transactions (TipTap's 'transaction' event). Appended
 * transactions belong to their root: the fragment-attribute sync pagination appends to an
 * author's edit is part of that edit, and whatever is appended to a pagination step or a server
 * sync is not an author's change either.
 */
export function isDirtyDispatch(transaction: Transaction, appended: readonly Transaction[] = []): boolean {
  if (isMachineTransaction(transaction)) return false;
  return isDirtyTransaction(transaction) || appended.some(isDirtyTransaction);
}
