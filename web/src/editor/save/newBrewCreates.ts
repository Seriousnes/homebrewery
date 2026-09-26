// The create signal of new brews (SAVE-8, the /new race): every POST /api/brews that autosave
// sends for a new brew (the 'new' draft) is tracked here, per browser tab, until it answers. "New
// brew" from a /new page with typed text unmounts that session, whose unmount save POSTs while the
// fresh /new mounts; the fresh page waits for such a create, and doesn't load a draft that a
// created brew holds (its key, or written before the create started). Framework-free.
import type { Draft } from './drafts';

export type NewBrewCreateStatus = 'pending' | 'created' | 'failed';

export interface NewBrewCreate {
  /** The Idempotency-Key the POST sent (one per create chain; retries reuse it). */
  key: string;
  /** When the POST's body was taken (epoch ms): a draft written before then is in it. */
  startedAt: number;
  status: NewBrewCreateStatus;
  /** The brew it created. */
  editId: string | null;
  /** Resolves once the status left 'pending'. */
  settled: Promise<void>;
}

export interface NewBrewCreateHandle {
  /** The brew exists now; call it once the 'new' draft is deleted. */
  created: (editId: string) => void;
  /** No answer, or an error: the 'new' draft (written by then) keeps the changes. */
  failed: () => void;
}

/** The latest attempt per key, oldest first. */
const creates = new Map<string, NewBrewCreate>();
const MAX_TRACKED = 20;

/** A create of a new brew started (its body taken at `startedAt`). Settle it with the handle. */
export function trackNewBrewCreate(key: string, startedAt: number): NewBrewCreateHandle {
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  const entry: NewBrewCreate = { key, startedAt, status: 'pending', editId: null, settled };
  creates.delete(key);
  creates.set(key, entry);
  for (const [old, create] of creates) {
    if (creates.size <= MAX_TRACKED) break;
    if (create.status !== 'pending') creates.delete(old);
  }
  const finish = (status: NewBrewCreateStatus, editId: string | null) => {
    if (entry.status !== 'pending') return;
    entry.status = status;
    entry.editId = editId;
    resolve();
  };
  return { created: (editId) => finish('created', editId), failed: () => finish('failed', null) };
}

/** The creates of new brews still waiting for an answer in this tab. */
export function pendingNewBrewCreates(): NewBrewCreate[] {
  return [...creates.values()].filter((create) => create.status === 'pending');
}

/**
 * The brew a stored 'new' draft was turned into in this tab, or null: a create that succeeded and
 * sent the draft's key, or that started after the draft was written (everything in the draft
 * went into it). Such a draft must not be loaded again: it would become a second brew.
 */
export function createdFromDraft(draft: Pick<Draft, 'createKey' | 'updatedAt'>): NewBrewCreate | null {
  let found: NewBrewCreate | null = null;
  for (const create of creates.values()) {
    if (create.status !== 'created') continue;
    if ((draft.createKey != null && create.key === draft.createKey) || create.startedAt >= draft.updatedAt) found = create;
  }
  return found;
}

/** Forgets every tracked create (tests). */
export function resetNewBrewCreates(): void {
  creates.clear();
}
