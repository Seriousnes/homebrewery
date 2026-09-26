// Unsaved-changes drafts in IndexedDB (plan §9): every change, throttled to 1 s, goes to a draft
// with the baseVersion it was edited from. A new brew has one draft, key 'new' (/new loads it). An
// existing brew's drafts are keyed per editor session, `${editId}:${session}`, so a session never
// writes over a draft another tab or an earlier visit left (SAVE-10); a successful save deletes
// only the session's own. On load, every stored draft of the brew that differs from the server
// version is offered: as a plain restore when it was made on that version, else as a conflict
// (draftOfferKind). Nothing is dropped because the server moved on (SAVE-2).
import type { Schema } from '@tiptap/pm/model';
import type { BrewMetaInput } from '@/api';
import { jsonEqual } from './jsonEqual';
import { fallbackStore, hasIndexedDb, idbStore, memoryStore, type KeyValueStore } from './kvStore';
import type { BrewBaseline, BrewContent } from './types';

export const DRAFT_DB = 'hb-drafts';
export const DRAFT_STORE = 'drafts';
/** Draft key of a brew that has no editId yet (/new). */
export const NEW_DRAFT_KEY = 'new';
export const DRAFT_FORMAT = 1;

export interface Draft extends BrewContent {
  v: typeof DRAFT_FORMAT;
  /** 'new', or `${editId}:${session}` (drafts written before per-session keys: the editId). */
  key: string;
  editId: string | null;
  /** The server version these changes were made on (null: never saved). */
  baseVersion: number | null;
  /**
   * baseVersion + 1 while a save whose outcome is unknown was in flight when the draft was written
   * (the page closed mid-request, a network error), else null. With `pending`, what that save
   * sent: when the server holds exactly that at pendingVersion, the save got through and the draft
   * (which also holds what was typed after it started) is a plain restore on that version (SAVE-1).
   */
  pendingVersion?: number | null;
  /** The content of that in-flight save (see pendingVersion). */
  pending?: BrewContent | null;
  /** Written while the brew was in conflict: offered as a conflict, never as a plain restore. */
  conflict?: boolean;
  /**
   * A new brew's create chain (SAVE-8): the Idempotency-Key its POSTs send. With `pending` (and no
   * pendingVersion), what a POST whose outcome is unknown sent: the next attempt, in this session
   * or in the one that loads this draft, sends exactly that again with the key, so a POST that did
   * create the brew is answered with it instead of creating a second one.
   */
  createKey?: string | null;
  /**
   * The signed-in user who wrote the draft (useAutosave's userKey; it stays after the session
   * expires), or null for an anonymous visitor's. /new loads a draft only for its owner, and an
   * anonymous one for anyone (the visitor may sign in: it becomes theirs). SAVE-12.
   */
  ownerId?: string | null;
  docSchemaVersion: number;
  /** When it was written (epoch ms). */
  updatedAt: number;
}

/** A stored draft offered back: 'restore' (made on the loaded version) or 'conflict'. */
export type DraftOfferKind = 'restore' | 'conflict';

export interface DraftOffer extends Draft {
  kind: DraftOfferKind;
}

/** A draft store; persistent() is false when drafts last only as long as the page (SAVE-11). */
export type DraftStore = KeyValueStore<Draft> & { persistent?: () => boolean };

/** 'new' for a new brew; else `${editId}:${session}`, or the bare editId without a session. */
export const draftKey = (editId: string | null, session?: string): string => {
  if (editId === null) return NEW_DRAFT_KEY;
  return session ? `${editId}:${session}` : editId;
};

/**
 * IndexedDB, with an in-memory fallback for the page's life when IndexedDB fails (site data
 * blocked, quota: persistent() turns false), or in memory only where there is no IndexedDB (jsdom).
 */
export function createDraftStore(): DraftStore {
  return hasIndexedDb() ? fallbackStore(idbStore<Draft>(DRAFT_DB, DRAFT_STORE)) : memoryStore<Draft>();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isDocRecord = (v: unknown): boolean => isRecord(v) && v.type === 'doc';

/** Storage is outside our control (older formats, other tabs, extensions): check the shape. */
export function isDraft(value: unknown): value is Draft {
  if (!isRecord(value)) return false;
  const pending = value.pending;
  return (
    value.v === DRAFT_FORMAT &&
    typeof value.key === 'string' &&
    (value.editId === null || typeof value.editId === 'string') &&
    (value.baseVersion === null || (typeof value.baseVersion === 'number' && Number.isInteger(value.baseVersion))) &&
    (value.pendingVersion == null || typeof value.pendingVersion === 'number') &&
    (pending == null || (isRecord(pending) && isDocRecord(pending.doc))) &&
    (value.conflict == null || typeof value.conflict === 'boolean') &&
    (value.createKey == null || typeof value.createKey === 'string') &&
    (value.ownerId == null || typeof value.ownerId === 'string') &&
    isDocRecord(value.doc) &&
    typeof value.style === 'string' &&
    (value.meta === null || isRecord(value.meta)) &&
    typeof value.updatedAt === 'number' &&
    typeof value.docSchemaVersion === 'number'
  );
}

/**
 * Whether /new may load the draft for `userId` (null: nobody signed in): its owner's, or an
 * anonymous visitor's (SAVE-12). Another user's draft is never shown.
 */
export function draftOwnedBy(draft: Pick<Draft, 'ownerId'>, userId: string | null): boolean {
  return draft.ownerId == null || draft.ownerId === userId;
}

/** Reads a draft; anything malformed counts as none. Storage errors are rethrown. */
export async function readDraft(store: DraftStore, key: string): Promise<Draft | null> {
  const value: unknown = await store.get(key);
  return isDraft(value) ? value : null;
}

/**
 * Every stored draft of a brew, whichever session wrote it, newest first; for a new brew (null)
 * the 'new' draft. Storage errors are rethrown.
 */
export async function readDraftsFor(store: DraftStore, editId: string | null): Promise<Draft[]> {
  if (editId === null) {
    const draft = await readDraft(store, NEW_DRAFT_KEY);
    return draft ? [draft] : [];
  }
  const drafts: Draft[] = [];
  for (const [, value] of await store.entries()) {
    if (isDraft(value) && value.editId === editId) drafts.push(value);
  }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

const emptyToNull = (v: unknown): unknown => (v === '' || v === undefined ? null : v);

function docsEqual(a: unknown, b: unknown, schema?: Schema): boolean {
  if (schema) {
    try {
      // Through the schema: default attributes filled in, key order irrelevant.
      return schema.nodeFromJSON(a).eq(schema.nodeFromJSON(b));
    } catch {
      return false;
    }
  }
  return jsonEqual(a, b);
}

function metaEqual(draft: BrewMetaInput | null, server: BrewBaseline['meta']): boolean {
  if (!draft || !server) return true;
  for (const [field, value] of Object.entries(draft) as [keyof BrewMetaInput, unknown][]) {
    // null / missing fields keep the stored value; authors are the owner's business.
    if (value === null || value === undefined || field === 'authors') continue;
    if (!(field in server)) continue;
    if (!jsonEqual(emptyToNull(value), emptyToNull(server[field]))) return false;
  }
  return true;
}

/** Whether the draft holds something the server version doesn't (doc, style, snippets or meta). */
export function draftDiffers(draft: BrewContent, baseline: BrewBaseline, schema?: Schema): boolean {
  if (!docsEqual(draft.doc, baseline.doc, schema)) return true;
  if ('style' in baseline && (draft.style ?? '') !== (baseline.style ?? '')) return true;
  if ('snippets' in baseline && !jsonEqual(emptyToNull(draft.snippets), emptyToNull(baseline.snippets))) return true;
  return 'meta' in baseline && !metaEqual(draft.meta, baseline.meta);
}

/**
 * How a stored draft is offered against the loaded version (plan §9, SAVE-1, SAVE-2): null when
 * it holds nothing the server doesn't. 'restore' when it was made on exactly the loaded version,
 * or on the version its in-flight save produced (pendingVersion) and the server holds exactly what
 * that save sent. Anything else (written in conflict, made on another version, or an in-flight
 * save that can't be shown to be the one the server has) is a 'conflict': restoring it must not
 * overwrite the server version unless the author chooses to.
 */
export function draftOfferKind(draft: Draft, baseVersion: number | null, baseline: BrewBaseline, schema?: Schema): DraftOfferKind | null {
  if (!draftDiffers(draft, baseline, schema)) return null;
  if (draft.conflict) return 'conflict';
  if (draft.baseVersion === baseVersion) return 'restore';
  const pendingMatches =
    baseVersion !== null && draft.pendingVersion === baseVersion && draft.pending != null && !draftDiffers(draft.pending, baseline, schema);
  return pendingMatches ? 'restore' : 'conflict';
}

/** Whether the draft is offered as a plain "Restore unsaved changes" (draftOfferKind 'restore'). */
export function shouldOfferDraft(draft: Draft, baseVersion: number | null, baseline: BrewBaseline, schema?: Schema): boolean {
  return draftOfferKind(draft, baseVersion, baseline, schema) === 'restore';
}
