// Local brews (issue #4): brews kept in this browser, for anyone, signed in or not. Saving to the
// cloud, publishing and sharing need an account; creating, editing and downloading a PDF don't. A
// signed-in user uploads local brews to their account when they choose (upload.ts); nothing is
// uploaded by itself.
//
// Storage: IndexedDB (localStorage holds about 5 MB per site, and there is no limit on the number
// of brews). Two databases (idb-keyval opens one object store per database):
//   hb-local-brews       id → LocalBrew (the whole brew)
//   hb-local-brew-index  id → LocalBrewSummary (what the list shows, so it never reads documents)
// A brew is written before its summary; list() repairs the index from the brews' keys (a summary
// missing after a crash is rebuilt, one without its brew is dropped). The first brew asks the
// browser to keep the site's storage (requestPersistentStorage).
//
// Kept small: the navbar and the sign-in prompt import it, so it must not pull in the editor.
import type { JSONContent } from '@tiptap/core';
import { type DraftStore, NEW_DRAFT_KEY, readDraft } from '../save/drafts';
import { fallbackStore, hasIndexedDb, idbStore, type KeyValueStore, memoryStore } from '../save/kvStore';
import { DOC_SCHEMA_VERSION } from '../schema/version';

export const LOCAL_BREW_DB = 'hb-local-brews';
export const LOCAL_BREW_STORE = 'brews';
export const LOCAL_INDEX_DB = 'hb-local-brew-index';
export const LOCAL_INDEX_STORE = 'summaries';
export const LOCAL_BREW_FORMAT = 1;

/** Local brew ids: URL-safe, as /local/:localId shows them. */
export const LOCAL_BREW_ID = /^[\w-]{1,64}$/;

export const LOCAL_DEFAULT_THEME = '5ePHB';
export const LOCAL_DEFAULT_LANG = 'en';

/** The metadata a local brew keeps (publishing and authors need the cloud). */
export interface LocalBrewMeta {
  title: string;
  description: string;
  tags: string[];
  lang: string;
  theme: string;
}

export interface LocalBrew {
  v: typeof LOCAL_BREW_FORMAT;
  id: string;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  docSchemaVersion: number;
  doc: JSONContent;
  style: string;
  snippets: unknown;
  meta: LocalBrewMeta;
  /** An imported brew's original Homebrewery text; sent along when it is uploaded. */
  sourceMarkdown?: string | null;
}

/** What "Brews on this device" lists. */
export interface LocalBrewSummary {
  id: string;
  title: string;
  theme: string;
  /** Brew pages (top-level page nodes). */
  pages: number;
  createdAt: number;
  updatedAt: number;
}

export interface LocalBrewLibrary {
  /** Newest first. */
  list(): Promise<LocalBrewSummary[]>;
  count(): Promise<number>;
  /** Null when there is no such brew (or it is unreadable). */
  get(id: string): Promise<LocalBrew | null>;
  save(brew: LocalBrew): Promise<void>;
  remove(id: string): Promise<void>;
  /** false when the brews last only as long as the page (site data blocked, no IndexedDB). */
  persistent(): boolean;
}

type BrewStore = KeyValueStore<LocalBrew> & { persistent?: () => boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Storage is outside our control (older formats, other tabs, extensions): check the shape. */
export function isLocalBrew(value: unknown): value is LocalBrew {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.doc)) return false;
  const meta = value.meta;
  return (
    value.v === LOCAL_BREW_FORMAT &&
    typeof value.id === 'string' &&
    LOCAL_BREW_ID.test(value.id) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.docSchemaVersion === 'number' &&
    value.doc.type === 'doc' &&
    typeof value.style === 'string' &&
    typeof meta.title === 'string' &&
    typeof meta.theme === 'string' &&
    typeof meta.lang === 'string'
  );
}

/** Brew pages in a document: its top-level page nodes. */
export function countPages(doc: JSONContent): number {
  return (doc.content ?? []).filter((node) => node.type === 'page').length;
}

export function summaryOf(brew: LocalBrew): LocalBrewSummary {
  return {
    id: brew.id,
    title: brew.meta.title,
    theme: brew.meta.theme,
    pages: countPages(brew.doc),
    createdAt: brew.createdAt,
    updatedAt: brew.updatedAt,
  };
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A new random id (16 characters, about 95 bits). */
export function newLocalBrewId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

/** Metadata from a partial or stored value, with the defaults of a new brew. */
export function localMeta(meta: Partial<Record<keyof LocalBrewMeta, unknown>> | null | undefined): LocalBrewMeta {
  const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
  return {
    title: text(meta?.title, ''),
    description: text(meta?.description, ''),
    tags: Array.isArray(meta?.tags) ? meta.tags.filter((t): t is string => typeof t === 'string') : [],
    lang: text(meta?.lang, '') || LOCAL_DEFAULT_LANG,
    theme: text(meta?.theme, '') || LOCAL_DEFAULT_THEME,
  };
}

// ─── Change notifications ─────────────────────────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

/** Called after every save or removal in this tab. Returns the unsubscribe function. */
export function onLocalBrewsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[local brews] listener failed', error);
    }
  }
}

// ─── The library ─────────────────────────────────────────────────────────────────────────────

export function createLocalBrewLibrary(brews: BrewStore, index: KeyValueStore<LocalBrewSummary>): LocalBrewLibrary {
  const get = async (id: string): Promise<LocalBrew | null> => {
    const value: unknown = await brews.get(id);
    return isLocalBrew(value) ? value : null;
  };
  return {
    async list() {
      const [ids, stored] = await Promise.all([brews.keys(), index.entries()]);
      const present = new Set(ids);
      const summaries = new Map(stored.filter(([id]) => present.has(id)).map(([id, s]) => [id, s]));
      // Repair the index: rebuild missing summaries, drop those whose brew is gone.
      const missing = ids.filter((id) => !summaries.has(id));
      if (missing.length) {
        const rebuilt = (await brews.getMany(missing)).filter(isLocalBrew).map(summaryOf);
        for (const summary of rebuilt) summaries.set(summary.id, summary);
        await index.setMany(rebuilt.map((s) => [s.id, s] as [string, LocalBrewSummary])).catch(() => undefined);
      }
      const orphans = stored.map(([id]) => id).filter((id) => !present.has(id));
      if (orphans.length) await index.delMany(orphans).catch(() => undefined);
      return [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    },
    count: async () => (await brews.keys()).length,
    get,
    async save(brew) {
      await brews.set(brew.id, brew);
      await index.set(brew.id, summaryOf(brew)).catch(() => undefined);
      notify();
    },
    async remove(id) {
      await brews.del(id);
      await index.del(id).catch(() => undefined);
      notify();
    },
    persistent: () => brews.persistent?.() ?? true,
  };
}

let library: LocalBrewLibrary | null = null;

/**
 * The browser's library: IndexedDB, with an in-memory fallback for the page's life when IndexedDB
 * fails (persistent() turns false), or in memory only where there is no IndexedDB (jsdom).
 */
export function defaultLocalBrews(): LocalBrewLibrary {
  if (!library) {
    library = hasIndexedDb()
      ? createLocalBrewLibrary(
          fallbackStore(idbStore<LocalBrew>(LOCAL_BREW_DB, LOCAL_BREW_STORE)),
          fallbackStore(idbStore<LocalBrewSummary>(LOCAL_INDEX_DB, LOCAL_INDEX_STORE)),
        )
      : createLocalBrewLibrary(Object.assign(memoryStore<LocalBrew>(), { persistent: () => false }), memoryStore<LocalBrewSummary>());
  }
  return library;
}

/** Tests: replace the browser's library (null: a fresh one on next use). */
export function setDefaultLocalBrews(next: LocalBrewLibrary | null): void {
  library = next;
}

const persistRequests = new WeakMap<object, Promise<boolean | null>>();
const NO_STORAGE = {};

/**
 * Asks the browser to keep this site's storage when disk space runs low (once per page). Resolves
 * true when it will, false when it declined, null when the browser has no such API.
 */
export function requestPersistentStorage(storage: StorageManager | undefined = globalThis.navigator?.storage): Promise<boolean | null> {
  const key = storage ?? NO_STORAGE;
  let request = persistRequests.get(key);
  if (request) return request;
  request = (async () => {
    try {
      if (!storage?.persist) return null;
      if (await storage.persisted?.()) return true;
      return await storage.persist();
    } catch {
      return null;
    }
  })();
  persistRequests.set(key, request);
  return request;
}

// ─── The anonymous /new draft of earlier versions ────────────────────────────────────────────

/**
 * Before local brews, a signed-out visitor's new brew was the /new draft (hb-drafts, key 'new',
 * no ownerId), saved to the cloud when they signed in. It becomes a local brew: returns its id,
 * or null when there is no such draft. A signed-in user's draft and one with a create chain
 * (SAVE-8, a POST may have created it) stay for /new. The id comes from the draft, so two tabs
 * migrating at once write one brew.
 */
export async function migrateAnonymousNewDraft(drafts: DraftStore, brews: LocalBrewLibrary = defaultLocalBrews()): Promise<string | null> {
  const draft = await readDraft(drafts, NEW_DRAFT_KEY).catch(() => null);
  if (!draft || draft.ownerId != null || draft.createKey != null) return null;
  if (!Number.isInteger(draft.docSchemaVersion) || draft.docSchemaVersion < 1 || draft.docSchemaVersion > DOC_SCHEMA_VERSION) return null;
  const id = `draft-${Math.trunc(draft.updatedAt).toString(36)}`;
  await brews.save({
    v: LOCAL_BREW_FORMAT,
    id,
    createdAt: draft.updatedAt,
    updatedAt: draft.updatedAt,
    docSchemaVersion: draft.docSchemaVersion,
    doc: draft.doc,
    style: draft.style,
    snippets: draft.snippets ?? null,
    meta: localMeta(draft.meta),
  });
  await drafts.del(NEW_DRAFT_KEY);
  return id;
}
