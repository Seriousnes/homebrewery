// The autosave state machine (plan §9 useAutosave behaviour spec), framework-free so it can be
// tested with a real editor and fake timers. useAutosave.ts wraps it for React.
//
//   Dirty     = an author's transaction (dirty.ts: docChanged and not pagination, id bookkeeping or
//               a server sync), or a style / snippets / meta change (markDirty, externalChanged).
//   Save when = 3 s after the last change AND isSettled(state) (pagination idle; after
//               settleTimeoutMs it saves anyway), or saveNow (Mod-S), flush('hidden')
//               (visibilitychange → hidden, pagehide) and flush('unmount') (route change).
//   Request   = PUT /api/brews/{editId} { baseVersion, doc, style, snippets, meta, docSchemaVersion },
//               gzip-compressed by the API client from 8 KiB (hidden / unmount: always gzip, and
//               fetch keepalive when the compressed body fits the 64 KiB keepalive quota).
//               A brew without an editId (/new) is created with POST /api/brews instead; while the
//               page knows nobody is signed in (signedOut) it isn't sent at all: the draft keeps it.
//               Every POST of one new brew sends the same Idempotency-Key (SAVE-8), and a POST
//               whose outcome is unknown is sent again exactly (the server answers a replay with
//               the brew it created), then the changes typed since are PUT. The 'new' draft keeps
//               the key and that body (createKey, pending), for the page that loads it next.
//               A request without an answer after SAVE_TIMEOUT_MS is aborted and counts as offline.
//   200       → baseVersion = response.version; the draft is deleted (or rewritten on the new
//               version when changes came in meanwhile); a local snapshot is recorded; "Saved".
//               The local document is kept: the save response has no document, and replacing
//               the editor's content would cost the caret and undo history for no visible gain
//               (the server only re-serializes raw HTML and drops invalid attributes; the next
//               load shows its version). After a create (new brew, "Save mine as a copy") the
//               returned sanitized document is applied, outside the history and only the range
//               that differs (applyDoc.ts), when no change came in meanwhile.
//   409       → autosave stops; the conflict dialog offers: load the saved version (an undoable
//               step; the author's version is kept as a local snapshot first), overwrite with
//               mine (PUT with baseVersion = serverVersion), or save mine as a copy (POST).
//   401       → "Sign in to save": the draft is kept; retried on saveNow, when the page becomes
//               visible again, and when the signed-in user changes (useAutosave's userKey).
//   network   → "offline": retried with back-off (2, 5, 15, 30, 60 s) and on the online event.
//   403/404/410 → "lost" (removed as an author, brew deleted): no retries; "Save as a new brew"
//               (saveAsCopy) keeps the work on the server.
//   other     → "error": 408/429/5xx retried with back-off (Retry-After honoured); 400/413 wait
//               for the next change or saveNow.
//   Drafts    = every change, throttled to draftThrottleMs (1 s; leading and trailing), goes to
//               IndexedDB drafts/{`${editId}:${session}` | 'new'} with baseVersion (drafts.ts). An
//               HTTP answer means the save was not applied: only a save whose outcome is unknown
//               (network error, page closed mid-request) leaves pendingVersion and what it sent in
//               the draft. On start, every stored draft of the brew that differs from `baseline`
//               is offered (draftOffer): 'restore' when made on the loaded version, else
//               'conflict', whose restore opens the conflict dialog instead of saving over it.
//   Snapshots = snapshots.ts (5 rolling local versions per brew), after each successful save.
import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import {
  createBrew,
  describeApiError,
  encodeJsonBody,
  fetchBrewForEdit,
  isAbortError,
  isApiError,
  isTransientError,
  saveBrew,
  type BrewForEdit,
  type BrewMetaInput,
  type CreateBrewRequest,
  type GzipMode,
  type SaveBrewRequest,
  type SaveBrewResponse,
} from '@/api';
import { isSettled as paginationSettled } from '../pagination/state';
import { migrateDoc } from '../schema/migrations';
import { DOC_SCHEMA_VERSION } from '../schema/version';
import { replaceDocument } from './applyDoc';
import { newCreateKey, type CreateChain } from './createChain';
import { isDirtyDispatch } from './dirty';
import { draftKey, draftOfferKind, readDraftsFor, type Draft, type DraftOffer, type DraftStore } from './drafts';
import { trackNewBrewCreate, type NewBrewCreateHandle } from './newBrewCreates';
import type { Snapshot, SnapshotHistory } from './snapshots';
import type { BrewBaseline, BrewContent } from './types';

/**
 * 'lost': the brew can't be saved any more (403, 404, 410: removed as an author, deleted); only a
 * copy (saveAsCopy) keeps the work on the server.
 */
export type AutosaveStatus = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict' | 'error' | 'signedOut' | 'lost';

/**
 * What leaving means for shouldWarnOnUnload: 'page' (the tab closes or reloads) or 'app' (an
 * in-app navigation: the page, and a draft kept in memory, stay).
 */
export type LeaveScope = 'page' | 'app';

/** What started a save. */
export type SaveTrigger = 'auto' | 'now' | 'hidden' | 'unmount' | 'retry' | 'overwrite';

export type ConflictAction = 'load' | 'overwrite' | 'copy';

/** Result of saveNow() and of the conflict actions. */
export type SaveOutcome = 'saved' | 'unchanged' | 'queued' | 'conflict' | 'failed' | 'disabled';

export const AUTOSAVE_DELAY_MS = 3000;
export const DRAFT_THROTTLE_MS = 1000;
/** A save that waits for pagination goes ahead anyway after this long. */
export const SETTLE_TIMEOUT_MS = 10_000;
/** saveNow waits this long at most for pagination. */
export const SAVE_NOW_SETTLE_MS = 1000;
export const RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 15_000, 30_000, 60_000];
/** Browsers refuse keepalive bodies over 64 KiB (shared by all pending keepalive requests). */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
/** A save or create without an answer after this long is aborted and retried (offline). */
export const SAVE_TIMEOUT_MS = 60_000;
/** A save in flight this long counts as stuck: leaving the page warns. */
export const STALLED_SAVE_MS = 10_000;

export interface AutosaveConflict {
  /** The server's version (409 SaveConflict.serverVersion); null when the response had none. */
  serverVersion: number | null;
  /** A conflict action in progress. */
  busy: ConflictAction | null;
  /** Why the last conflict action failed (shown in the dialog), or null. */
  actionError: string | null;
}

export interface AutosaveState {
  status: AutosaveStatus;
  /** The brew being saved; null until a new brew's first save created it. */
  editId: string | null;
  /** The version the next save sends as baseVersion (null for a new brew). */
  baseVersion: number | null;
  /** Changes that are not on the server yet. */
  unsaved: boolean;
  /** When the last save succeeded (epoch ms), or the loaded brew's updatedAt, or null. */
  lastSavedAt: number | null;
  conflict: AutosaveConflict | null;
  /** Whether the conflict dialog should be showing (it can be dismissed and reopened). */
  conflictOpen: boolean;
  /** The failure behind 'offline', 'signedOut', 'error' and 'lost'. */
  error: Error | null;
  /** When the next automatic retry runs (epoch ms), or null. */
  retryAt: number | null;
  /**
   * A stored draft to offer back, or null: kind 'restore' ("Restore unsaved changes") or
   * 'conflict' (made on an older version or in a conflict: restoring opens the conflict dialog).
   * One at a time, newest first; answering one shows the next.
   */
  draftOffer: DraftOffer | null;
  /** false when drafts only last as long as the page (this browser refuses IndexedDB). */
  draftsPersistent: boolean;
  /** What started the last successful save, and how many saves succeeded (for announcements). */
  lastTrigger: SaveTrigger | null;
  saveCount: number;
  /** Bumped when the brew was replaced by the server's or a restored version (useAutosave re-reads style/meta). */
  externalEpoch: number;
}

/** The API calls autosave makes (default: the '@/api' functions). */
export interface AutosaveApi {
  /** `signal` aborts a request that got no answer in SAVE_TIMEOUT_MS. */
  saveBrew(editId: string, body: SaveBrewRequest, options: { gzip?: GzipMode; keepalive?: boolean; signal?: AbortSignal }): Promise<SaveBrewResponse>;
  /** `idempotencyKey`: a new brew's create chain (SAVE-8); copies send none. */
  createBrew(body: CreateBrewRequest, options: { gzip?: GzipMode; signal?: AbortSignal; idempotencyKey?: string }): Promise<BrewForEdit>;
  fetchBrewForEdit(editId: string): Promise<BrewForEdit>;
}

export const defaultAutosaveApi: AutosaveApi = {
  saveBrew: (editId, body, options) => saveBrew(editId, body, options),
  createBrew: (body, options) => createBrew(body, options),
  fetchBrewForEdit: (editId) => fetchBrewForEdit(editId),
};

export interface AutosaveOptions {
  /** null: a new brew (/new); the first save POSTs. */
  editId: string | null;
  /** The loaded version (BrewForEdit.version); null for a new brew. */
  baseVersion: number | null;
  getStyle: () => string | null | undefined;
  getSnippets: () => unknown;
  /** Metadata to send; include `authors` only when the owner edited the list (else 403). */
  getMeta: () => BrewMetaInput | null | undefined;
  api?: Partial<AutosaveApi>;
  /** Draft store (default: IndexedDB); null turns drafts off. */
  drafts?: DraftStore | null;
  /** Local snapshots (default: IndexedDB); null turns them off. */
  snapshots?: SnapshotHistory | null;
  /** What the server holds for the loaded brew: enables the "Restore unsaved changes" offer. */
  baseline?: BrewBaseline | null;
  /** When the loaded brew was last saved (BrewForEdit.updatedAt). */
  lastSavedAt?: string | number | null;
  /** false: never save or write drafts (read-only views). Default true. */
  enabled?: boolean;
  /**
   * true when the page knows nobody is signed in (GET /me said so). A new brew (no editId) is
   * then not sent (its POST would get a 401): status 'signedOut', the changes stay in the draft,
   * and the brew is created as soon as this turns false. An existing brew still saves (its 401
   * is how autosave learns that the session ended).
   */
  signedOut?: boolean;
  /**
   * The signed-in user (useAutosave: userKey), written into drafts as Draft.ownerId (SAVE-12). The
   * last one seen stays while it is null (an expired session), so /new never shows the draft
   * to a visitor who isn't its author.
   */
  ownerId?: string | null;
  /**
   * A new brew's create chain from the 'new' draft the page loaded (SAVE-8; read once, at
   * creation): its first POST sends the chain's pending body again with its key, before anything
   * newer (see CreateChain).
   */
  createChain?: CreateChain | null;
  delayMs?: number;
  draftThrottleMs?: number;
  settleTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  /** Abort a save or create that got no answer after this long (default SAVE_TIMEOUT_MS). */
  requestTimeoutMs?: number;
  /** Pagination idle? Default: pagination's isSettled (true without the plugin). */
  isSettled?: (state: EditorState) => boolean;
  now?: () => number;
  /** A brew was created: the first save of a new brew, or "Save mine as a copy". Navigate to it. */
  onCreated?: (brew: BrewForEdit, reason: 'new' | 'copy') => void;
  onSaved?: (response: SaveBrewResponse, request: SaveBrewRequest) => void;
  /** "Load the saved version" loaded this brew: apply its style, snippets and meta. */
  onServerBrew?: (brew: BrewForEdit) => void;
  /** A draft or snapshot was restored (the document already is): apply its style, snippets and meta. */
  onRestore?: (content: BrewContent, source: 'draft' | 'snapshot') => void;
  logger?: Pick<Console, 'warn'>;
}

export interface AutosaveController {
  getState: () => AutosaveState;
  subscribe: (listener: () => void) => () => void;
  /** Replace the options (getters, callbacks, stores). editId/baseVersion go through setSession. */
  update: (options: AutosaveOptions) => void;
  /** The editor to watch (null while it isn't mounted). */
  attach: (editor: Editor | null) => void;
  /**
   * The brew changed. The same editId as the one tracked is ignored (e.g. the id a create just
   * returned): autosave keeps its own version bookkeeping. Another id starts over, after
   * flushing unsaved changes of the previous brew.
   */
  setSession: (editId: string | null, baseVersion: number | null) => void;
  start: () => void;
  /** Flushes unsaved changes (keepalive) and stops timers; start() resumes. */
  stop: () => void;
  /** Style, snippets or meta changed: always dirty. */
  markDirty: () => void;
  /** Style, snippets or meta may have changed: dirty when they differ from what was last saved or loaded. */
  externalChanged: () => void;
  saveNow: () => Promise<SaveOutcome>;
  /** Save right away with keepalive, and write the draft (visibilitychange → hidden, pagehide, unmount). */
  flush: (trigger?: 'hidden' | 'unmount') => void;
  /** Retry after a failure (online event, page visible again, signed in). */
  retry: () => void;
  openConflict: () => void;
  closeConflict: () => void;
  loadSavedVersion: () => Promise<SaveOutcome>;
  overwriteWithMine: () => Promise<SaveOutcome>;
  /** POST the brew as a new one (no authors): in a conflict, or when the brew is 'lost'. */
  saveAsCopy: () => Promise<SaveOutcome>;
  /** Restores the offered draft; a 'conflict' offer opens the conflict instead of saving over the server. */
  restoreDraft: () => boolean;
  discardDraft: () => Promise<void>;
  listSnapshots: () => Promise<Snapshot[]>;
  restoreSnapshot: (snapshot: Snapshot) => boolean;
  /**
   * Whether leaving now would lose changes, or leave them unsaved where the author may not expect
   * it: a conflict, a failure, a save stuck for STALLED_SAVE_MS. A new brew waiting for a sign-in
   * is kept in its draft (which /new loads again), so it warns only when the draft can't keep it
   * (for 'page': a draft only in memory). Starts the draft write of the latest changes if needed.
   */
  shouldWarnOnUnload: (scope?: LeaveScope) => boolean;
}

type Failure = { kind: 'offline' | 'signedOut' | 'error' | 'lost'; error: Error };

/** A new brew's POST whose outcome is unknown: what it sent, and the change (rev) that holds. */
type PendingCreate = { content: BrewContent; docSchemaVersion: number; rev: number };

/**
 * Whether a failed POST /api/brews certainly created nothing, so its body needn't be sent again:
 * an HTTP 4xx answer other than 401 (the retry after signing in may be the same user's replay),
 * 408 and 429. A network error, a timeout or a 5xx may have come after the brew was stored.
 */
function createRefused(e: unknown): boolean {
  if (!isApiError(e) || e.kind !== 'http') return false;
  return e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429;
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** The abort reason of a request that got no answer in time (fetch rejects with it). */
const isTimeout = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'TimeoutError';

/** Tells this controller's drafts from other tabs' and earlier visits' (drafts.ts keys). */
const newDraftSession = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function parseTime(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const TRIGGER_RANK: Record<SaveTrigger, number> = { auto: 0, retry: 1, now: 2, overwrite: 2, hidden: 3, unmount: 3 };

export function createAutosave(initial: AutosaveOptions): AutosaveController {
  let opts = initial;
  const now = () => (opts.now ?? Date.now)();
  const enabled = () => opts.enabled !== false;
  const callApi = (): AutosaveApi => ({ ...defaultAutosaveApi, ...opts.api });
  const warn = (message: string, error?: unknown) => (opts.logger ?? console).warn(`[autosave] ${message}`, error ?? '');

  // Session: which brew, which version.
  let editId = initial.editId;
  let baseVersion = initial.baseVersion;
  let session = 0;
  let lastSavedAt = parseTime(initial.lastSavedAt);
  // This controller's drafts: `${editId}:${draftSession}` ('new' for a new brew).
  const draftSession = newDraftSession();
  const keyFor = (id: string | null): string => draftKey(id, draftSession);
  const ownKey = (): string => keyFor(editId);
  /** A new brew while the page knows nobody is signed in: nothing is sent (options.signedOut). */
  const waitingForSignIn = (): boolean => opts.signedOut === true && editId === null;

  // The editor, and its latest state (kept for a flush after the editor was destroyed).
  let editor: Editor | null = null;
  let lastState: EditorState | null = null;

  // Changes: rev counts dirty changes; savedRev is the rev the server has.
  let rev = 0;
  let savedRev = 0;
  let externalBaseline: string | null = null;
  let rebaselineExternal = false;
  let externalEpoch = 0;

  // Saving.
  let started = false;
  let inFlight = false;
  // The request in flight: its base version (null for a create), what it sent, when it started.
  let inFlightBase: number | null = null;
  let inFlightContent: BrewContent | null = null;
  let inFlightSince: number | null = null;
  let queued: SaveTrigger | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceToken = 0;
  // An automatic save is due (its delay, then the wait for pagination, is running).
  let debouncePending = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  let retryAt: number | null = null;
  let failure: Failure | null = null;
  let conflict: AutosaveConflict | null = null;
  let conflictOpen = false;
  let lastTrigger: SaveTrigger | null = null;
  let saveCount = 0;
  const settleWaiters = new Set<() => void>();

  // A new brew's create chain (SAVE-8): the Idempotency-Key of its POSTs, and the POST whose
  // outcome is unknown (in flight, or no HTTP answer, or 408/429/5xx). The next attempt sends that
  // body again, exactly, with the key: if it did create the brew, the server answers with that
  // brew, and what was typed since goes in the PUT that follows. `rev` = the change it holds (0
  // for a chain loaded from a draft: older than anything typed on this page).
  let createKey: string | null = initial.editId === null ? (initial.createChain?.key ?? null) : null;
  let pendingCreate: PendingCreate | null =
    initial.editId === null && initial.createChain?.pending
      ? { content: initial.createChain.pending, docSchemaVersion: initial.createChain.docSchemaVersion, rev: 0 }
      : null;
  // Draft.ownerId (SAVE-12): the signed-in user; kept while the session is gone.
  let draftOwner: string | null = initial.ownerId ?? null;

  // Drafts.
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDraftWrite = Number.NEGATIVE_INFINITY;
  let draftChain: Promise<void> = Promise.resolve();
  let draftReady: Promise<void> = Promise.resolve();
  let draftChecked = false;
  let draftWrittenThisSession = false;
  // The rev the last completed draft write holds, and whether the last write failed.
  let storedRev = -1;
  let draftWriteFailed = false;
  let draftOffers: DraftOffer[] = [];
  let snapshotGcDone = false;

  // ─── State for subscribers ──────────────────────────────────────────────────────────────────

  const listeners = new Set<() => void>();
  const unsaved = () => rev !== savedRev;

  function status(): AutosaveStatus {
    if (conflict) return 'conflict';
    if (inFlight) return 'saving';
    if (!unsaved()) return 'saved';
    if (failure) return failure.kind;
    return waitingForSignIn() ? 'signedOut' : 'dirty';
  }

  function compute(): AutosaveState {
    return {
      status: status(),
      editId,
      baseVersion,
      unsaved: unsaved(),
      lastSavedAt,
      conflict,
      conflictOpen: conflict !== null && conflictOpen,
      error: failure && unsaved() ? failure.error : null,
      retryAt: failure && unsaved() ? retryAt : null,
      draftOffer: draftOffers[0] ?? null,
      draftsPersistent: opts.drafts?.persistent?.() ?? true,
      lastTrigger,
      saveCount,
      externalEpoch,
    };
  }

  let snapshot = compute();

  function emit(): void {
    const next = compute();
    const changed = (Object.keys(next) as (keyof AutosaveState)[]).some((key) => !Object.is(next[key], snapshot[key]));
    if (!changed) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  // ─── Editor ─────────────────────────────────────────────────────────────────────────────────

  const liveEditor = (): Editor | null => (editor && !editor.isDestroyed ? editor : null);
  const currentState = (): EditorState | null => liveEditor()?.state ?? lastState;
  const settledNow = (): boolean => {
    const state = currentState();
    return !state || (opts.isSettled ?? paginationSettled)(state);
  };

  function onTransaction({ editor: source, transaction, appendedTransactions }: { editor: Editor; transaction: Transaction; appendedTransactions: Transaction[] }): void {
    lastState = source.state;
    if (isDirtyDispatch(transaction, appendedTransactions)) change();
    if (settleWaiters.size && settledNow()) {
      for (const resolve of [...settleWaiters]) resolve();
    }
  }

  /** Resolves when pagination is settled, or after `timeoutMs`. */
  function waitForSettle(timeoutMs: number): Promise<void> {
    if (settledNow()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        settleWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      settleWaiters.add(done);
    });
  }

  // ─── External (style, snippets, meta) ───────────────────────────────────────────────────────

  function readExternal(): { style: string; snippets: unknown; meta: BrewMetaInput | null } {
    return { style: opts.getStyle() ?? '', snippets: opts.getSnippets() ?? null, meta: opts.getMeta() ?? null };
  }

  function fingerprint(content: { style: string; snippets: unknown; meta: BrewMetaInput | null }): string {
    return JSON.stringify([content.style, content.snippets, content.meta]);
  }

  function safeFingerprint(): string | null {
    try {
      return fingerprint(readExternal());
    } catch (e) {
      warn('reading style/snippets/meta failed', e);
      return null;
    }
  }

  // ─── Changes and scheduling ─────────────────────────────────────────────────────────────────

  function clearDebounce(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    debounceToken++;
    debouncePending = false;
  }

  function clearRetry(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryAt = null;
  }

  /**
   * Autosave waits on its own: a conflict, a sign-in, the network (retries run on a timer), or a
   * brew it can't reach any more.
   */
  const paused = () =>
    conflict !== null || failure?.kind === 'signedOut' || failure?.kind === 'offline' || failure?.kind === 'lost' || waitingForSignIn();

  function change(): void {
    rev++;
    scheduleDraft();
    if (enabled() && started && !paused()) scheduleSave();
    emit();
  }

  function scheduleSave(): void {
    clearDebounce();
    const token = debounceToken;
    debouncePending = true;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void waitForSettle(opts.settleTimeoutMs ?? SETTLE_TIMEOUT_MS).then(() => {
        if (token !== debounceToken) return;
        debouncePending = false;
        void run('auto');
      });
    }, opts.delayMs ?? AUTOSAVE_DELAY_MS);
  }

  function scheduleRetry(retryAfterSeconds: number | null): void {
    clearRetry();
    const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    const delay = retryAfterSeconds != null ? retryAfterSeconds * 1000 : (delays[Math.min(retryIndex, delays.length - 1)] ?? 60_000);
    retryIndex++;
    retryAt = now() + delay;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryAt = null;
      void run('retry');
    }, delay);
  }

  // ─── Drafts ─────────────────────────────────────────────────────────────────────────────────

  function draftPayload(): Draft | null {
    const state = currentState();
    if (!state) return null;
    let external;
    try {
      external = readExternal();
    } catch (e) {
      warn('reading style/snippets/meta for the draft failed', e);
      return null;
    }
    // A save in flight (outcome unknown until it answers; handleFailure clears it for an HTTP
    // answer): if it got through, the server has base + 1 holding exactly what it sent.
    const pending = inFlight && inFlightBase !== null;
    // A new brew: its create chain, and the POST the next attempt sends again (SAVE-8).
    const creating = editId === null ? pendingCreate : null;
    return {
      v: 1,
      key: ownKey(),
      editId,
      baseVersion,
      pendingVersion: pending && inFlightBase !== null ? inFlightBase + 1 : null,
      pending: pending ? inFlightContent : (creating?.content ?? null),
      conflict: conflict !== null,
      createKey: editId === null ? createKey : null,
      ownerId: draftOwner,
      doc: state.doc.toJSON() as JSONContent,
      ...external,
      docSchemaVersion: DOC_SCHEMA_VERSION,
      updatedAt: now(),
    };
  }

  function clearDraftTimer(): void {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
  }

  function writeDraftNow(): void {
    clearDraftTimer();
    const store = opts.drafts;
    if (!store || !enabled() || !unsaved()) return;
    const draft = draftPayload();
    if (!draft) return;
    lastDraftWrite = now();
    draftWrittenThisSession = true;
    const ready = draftReady;
    const writtenRev = rev;
    const mySession = session;
    draftChain = draftChain
      .then(() => ready)
      .then(() => store.set(draft.key, draft))
      .then(
        () => {
          if (mySession !== session) return;
          storedRev = writtenRev;
          draftWriteFailed = false;
        },
        (e: unknown) => {
          if (mySession === session) draftWriteFailed = true;
          warn('writing the draft failed', e);
        },
      )
      .then(emit); // draftsPersistent may have changed
  }

  /**
   * Whether the draft keeps the latest changes past leaving: drafts on, the last write worked,
   * and (for the page closing) stored beyond memory. Starts writing what isn't stored yet.
   */
  function draftKeeps(scope: LeaveScope): boolean {
    const store = opts.drafts;
    if (!store || draftWriteFailed) return false;
    if (scope === 'page' && store.persistent?.() === false) return false;
    if (storedRev !== rev) writeDraftNow();
    return true;
  }

  function scheduleDraft(): void {
    if (!opts.drafts || !enabled() || draftTimer) return;
    const wait = lastDraftWrite + (opts.draftThrottleMs ?? DRAFT_THROTTLE_MS) - now();
    if (wait <= 0) {
      writeDraftNow();
      return;
    }
    draftTimer = setTimeout(() => {
      draftTimer = null;
      writeDraftNow();
    }, wait);
  }

  function deleteDraft(key: string): void {
    const store = opts.drafts;
    if (!store) return;
    if (key === ownKey()) clearDraftTimer();
    draftChain = draftChain.then(() => store.del(key)).catch((e: unknown) => warn('deleting the draft failed', e));
  }

  /**
   * Reads every stored draft of the brew (any tab's, any earlier visit's) and offers those that
   * differ from the server version, newest first; drafts with nothing new are deleted. Draft
   * writes wait for this, and never use another session's key.
   */
  function checkDraft(): void {
    const store = opts.drafts;
    const baseline = opts.baseline;
    // Needs the editor's schema, to compare documents with default attributes filled in.
    const schema = currentState()?.schema;
    if (draftChecked || !started || !store || !baseline || !schema || !enabled()) return;
    draftChecked = true;
    const id = editId;
    const version = baseVersion;
    const mySession = session;
    draftReady = (async () => {
      try {
        const drafts = await readDraftsFor(store, id);
        if (mySession !== session) return;
        const offers: DraftOffer[] = [];
        const empty: string[] = [];
        for (const draft of drafts) {
          const kind = draftOfferKind(draft, version, baseline, schema);
          if (kind) offers.push({ ...draft, kind });
          else if (id !== null) empty.push(draft.key); // /new's draft is the page's to manage
        }
        if (empty.length) await store.delMany(empty).catch((e: unknown) => warn('deleting old drafts failed', e));
        if (mySession !== session || !offers.length) return;
        draftOffers = offers;
        emit();
      } catch (e) {
        warn('reading the draft failed', e);
      }
    })();
  }

  // ─── Snapshots ──────────────────────────────────────────────────────────────────────────────

  function recordSnapshot(content: BrewContent, key: string, title: string, version: number | null, force = false): void {
    const history = opts.snapshots;
    if (!history) return;
    void history
      .update({ brewKey: key, title, version, docSchemaVersion: DOC_SCHEMA_VERSION, ...content }, { force })
      .then(() => {
        if (snapshotGcDone) return;
        snapshotGcDone = true;
        return history.collectGarbage();
      })
      .catch((e: unknown) => warn('recording a local snapshot failed', e));
  }

  const titleOf = (meta: BrewMetaInput | null, doc: JSONContent): string => {
    if (meta?.title) return meta.title;
    const heading = findFirstHeading(doc);
    return heading || 'Untitled brew';
  };

  // ─── Saving ─────────────────────────────────────────────────────────────────────────────────

  function transportFor(trigger: SaveTrigger, body: unknown): { gzip: GzipMode; keepalive: boolean } {
    if (trigger !== 'hidden' && trigger !== 'unmount') return { gzip: 'auto', keepalive: false };
    try {
      const encoded = encodeJsonBody(body, { gzip: 'always' });
      return { gzip: 'always', keepalive: encoded.sentBytes <= KEEPALIVE_MAX_BYTES };
    } catch {
      return { gzip: 'auto', keepalive: false };
    }
  }

  function applyServerDoc(sent: JSONContent, brew: BrewForEdit, sentRev: number): void {
    const target = liveEditor();
    if (!target || rev !== sentRev) return; // changes came in meanwhile: keep them
    try {
      const doc = migrateDoc(brew.doc as JSONContent, brew.docSchemaVersion);
      const schema = target.state.schema;
      if (schema.nodeFromJSON(doc).eq(schema.nodeFromJSON(sent))) return;
      replaceDocument(target, doc, { undoable: false, dirty: false });
    } catch (e) {
      warn('applying the server document failed', e);
    }
  }

  /**
   * Resolves or rejects as `request` does, or rejects with a TimeoutError (aborting `abort`) when
   * it has no answer after requestTimeoutMs: a request that hangs must not block autosave.
   */
  function timed<T>(request: Promise<T>, abort: AbortController): Promise<T> {
    const ms = opts.requestTimeoutMs ?? SAVE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const reason = new DOMException(`The server didn't answer in ${Math.round(ms / 1000)} s.`, 'TimeoutError');
        abort.abort(reason);
        reject(reason);
      }, ms);
    });
    return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
  }

  /** `creating`: the request was a POST (a new brew), which a 403/404 doesn't make 'lost'. */
  function handleFailure(e: unknown, trigger: SaveTrigger, creating: boolean): SaveOutcome {
    if (isAbortError(e)) return 'failed';
    if (creating && createRefused(e)) {
      // Nothing was created: the next attempt sends the changes as they are then. A 422 means the
      // key already holds another request (a different body): start a new chain (SAVE-8).
      pendingCreate = null;
      if (isApiError(e) && e.status === 422) createKey = null;
    }
    const error = toError(e);
    const httpStatus = isApiError(e) ? e.status : -1;
    // An HTTP answer means the server didn't apply the save: drafts from here on must not claim
    // the version it would have made (pendingVersion). A network error or a timeout leaves the
    // outcome unknown, and the draft written below keeps it with what was sent.
    if (isApiError(e) && e.kind === 'http') {
      inFlight = false;
      inFlightBase = null;
      inFlightContent = null;
    }
    if (httpStatus === 409 && isApiError(e)) {
      conflict = { serverVersion: e.serverVersion, busy: null, actionError: null };
      conflictOpen = true;
      failure = null;
      clearDebounce();
      clearRetry();
      writeDraftNow();
      return 'conflict';
    }
    if (httpStatus === 401) {
      failure = { kind: 'signedOut', error };
      clearDebounce();
      clearRetry();
    } else if ((isApiError(e) && e.kind === 'network') || isTimeout(e)) {
      failure = { kind: 'offline', error };
      if (trigger !== 'unmount') scheduleRetry(null);
    } else if (!creating && (httpStatus === 403 || httpStatus === 404 || httpStatus === 410)) {
      // Removed as an author, or the brew was deleted: saving again can't work.
      failure = { kind: 'lost', error };
      clearDebounce();
      clearRetry();
    } else {
      failure = { kind: 'error', error };
      if (isTransientError(e) && trigger !== 'unmount') scheduleRetry(isApiError(e) ? e.retryAfter : null);
      else clearRetry();
    }
    writeDraftNow();
    return 'failed';
  }

  /**
   * One save request. `baseOverride`: the version to overwrite (conflict "Overwrite with mine").
   * Everything about the session is read before the first await.
   */
  async function performSave(trigger: SaveTrigger, baseOverride?: number): Promise<SaveOutcome> {
    const state = currentState();
    if (!state) return 'failed';
    let external;
    try {
      external = readExternal();
    } catch (e) {
      failure = { kind: 'error', error: toError(e) };
      emit();
      return 'failed';
    }
    const doc = state.doc.toJSON() as JSONContent;
    const content: BrewContent = { doc, ...external };
    const sentRev = rev;
    const mySession = session;
    const id = editId;
    const base = baseOverride ?? baseVersion;
    clearDebounce();
    clearRetry();
    inFlight = true;
    inFlightBase = id === null ? null : base;
    inFlightContent = content;
    inFlightSince = now();
    emit();
    const abort = new AbortController();
    // A new brew's POST, for the create signal (newBrewCreates.ts); settled once the draft is.
    let signal: NewBrewCreateHandle | null = null;

    try {
      if (id === null) {
        // One Idempotency-Key per new brew (SAVE-8). A POST whose outcome is unknown goes again,
        // exactly as it was, before anything newer; the draft holds both before the POST leaves.
        const key = (createKey ??= newCreateKey());
        const attempt: PendingCreate = pendingCreate ?? { content, docSchemaVersion: DOC_SCHEMA_VERSION, rev: sentRev };
        pendingCreate = attempt;
        inFlightContent = attempt.content;
        const body: CreateBrewRequest = { ...attempt.content, docSchemaVersion: attempt.docSchemaVersion };
        signal = trackNewBrewCreate(key, now());
        writeDraftNow();
        const options = { gzip: transportFor(trigger, body).gzip, signal: abort.signal, idempotencyKey: key };
        const brew = await timed(callApi().createBrew(body, options), abort);
        const created = signal;
        if (mySession !== session) {
          void draftChain.then(() => created.created(brew.editId));
          return 'saved';
        }
        pendingCreate = null;
        createKey = null;
        const oldKey = keyFor(null);
        editId = brew.editId;
        baseVersion = brew.version;
        savedRev = attempt.rev;
        const sent = attempt.content;
        afterSuccess(trigger, { style: sent.style, snippets: sent.snippets, meta: sent.meta }, brew.updatedAt);
        applyServerDoc(sent.doc, brew, attempt.rev);
        deleteDraft(oldKey);
        // A /new page that mounts meanwhile waits for this: the 'new' draft is gone by then.
        void draftChain.then(() => created.created(brew.editId));
        if (unsaved()) writeDraftNow();
        recordSnapshot(sent, brew.editId, titleOf(sent.meta, sent.doc), brew.version);
        opts.onCreated?.(brew, 'new');
        return 'saved';
      }

      if (base === null) throw new Error('No baseVersion for the save');
      const body: SaveBrewRequest = { baseVersion: base, ...content, docSchemaVersion: DOC_SCHEMA_VERSION };
      const response = await timed(callApi().saveBrew(id, body, { ...transportFor(trigger, body), signal: abort.signal }), abort);
      // Another brew is open now. Its draft (written when it closed) stays: it may hold more
      // than this request did, and pendingVersion lets a later visit offer it.
      if (mySession !== session) return 'saved';
      baseVersion = response.version;
      savedRev = sentRev;
      afterSuccess(trigger, external, response.updatedAt);
      if (unsaved()) writeDraftNow();
      else deleteDraft(keyFor(id));
      recordSnapshot(content, id, response.title || titleOf(content.meta, doc), response.version);
      opts.onSaved?.(response, body);
      return 'saved';
    } catch (e) {
      const failed = signal;
      if (mySession !== session) {
        failed?.failed();
        return 'failed';
      }
      const outcome = handleFailure(e, trigger, id === null);
      // After the draft (written by handleFailure) that keeps the changes and the chain.
      if (failed) void draftChain.then(() => failed.failed());
      return outcome;
    } finally {
      clearInFlight();
      emit();
      afterAttempt(); // for the current session, whichever brew this request was for
    }
  }

  function clearInFlight(): void {
    inFlight = false;
    inFlightBase = null;
    inFlightContent = null;
    inFlightSince = null;
  }

  function afterSuccess(trigger: SaveTrigger, external: { style: string; snippets: unknown; meta: BrewMetaInput | null }, updatedAt: string): void {
    clearInFlight(); // drafts written from here on are based on the new version
    failure = null;
    conflict = null;
    conflictOpen = false;
    retryIndex = 0;
    clearRetry();
    externalBaseline = fingerprint(external);
    lastSavedAt = parseTime(updatedAt) ?? now();
    lastTrigger = trigger;
    saveCount++;
  }

  /**
   * After a request: run the save that was requested while it ran. Changes made meanwhile have
   * scheduled their own save (change()), unless autosave was waiting then (a retry after a
   * failure, an overwrite in a conflict): after a success those get their save here (SAVE-3).
   * After a failure, automatic saves wait for the retry timer, and only an explicit request
   * (saveNow, hidden, unmount) goes ahead.
   */
  function afterAttempt(): void {
    const next = queued;
    queued = null;
    if (next && runQueued(next)) return;
    if (started && enabled() && !inFlight && !failure && !paused() && unsaved() && !debouncePending && !retryTimer) scheduleSave();
  }

  function runQueued(next: SaveTrigger): boolean {
    if (conflict || !enabled() || !unsaved()) return false;
    if (!started && next !== 'unmount' && next !== 'hidden') return false;
    if (failure && (next === 'auto' || next === 'retry')) return false;
    if (failure?.kind === 'signedOut' || failure?.kind === 'lost' || waitingForSignIn()) return false;
    void run(next);
    return true;
  }

  async function run(trigger: SaveTrigger): Promise<SaveOutcome> {
    if (!enabled()) return 'disabled';
    if (conflict) return 'conflict';
    if (waitingForSignIn()) return 'failed'; // the draft keeps it; "Sign in to save"
    if (inFlight) {
      if (!queued || TRIGGER_RANK[trigger] > TRIGGER_RANK[queued]) queued = trigger;
      return 'queued';
    }
    if (!unsaved()) return 'unchanged';
    return performSave(trigger);
  }

  // ─── Conflict actions ───────────────────────────────────────────────────────────────────────

  function setBusy(action: ConflictAction | null, actionError: string | null = null): void {
    if (!conflict) return;
    conflict = { ...conflict, busy: action, actionError };
    emit();
  }

  async function loadSavedVersion(): Promise<SaveOutcome> {
    if (!conflict || conflict.busy || editId === null) return 'failed';
    const id = editId;
    const mySession = session;
    setBusy('load');
    try {
      const brew = await callApi().fetchBrewForEdit(id);
      if (mySession !== session) return 'failed';
      const doc = migrateDoc(brew.doc as JSONContent, brew.docSchemaVersion);
      // Keep the author's version on this device before replacing it.
      const state = currentState();
      if (state) {
        try {
          const mine: BrewContent = { doc: state.doc.toJSON() as JSONContent, ...readExternal() };
          recordSnapshot(mine, id, `${titleOf(mine.meta, mine.doc)} (your unsaved version)`, null, true);
        } catch (e) {
          warn('keeping your version as a snapshot failed', e);
        }
      }
      const target = liveEditor();
      if (target) replaceDocument(target, doc, { undoable: true, dirty: false });
      baseVersion = brew.version;
      savedRev = rev;
      conflict = null;
      conflictOpen = false;
      failure = null;
      retryIndex = 0;
      clearRetry();
      lastSavedAt = parseTime(brew.updatedAt);
      rebaselineExternal = true;
      externalEpoch++;
      deleteDraft(keyFor(id));
      opts.onServerBrew?.(brew);
      emit();
      return 'saved';
    } catch (e) {
      setBusy(null, `Couldn't load the saved version. ${describeApiError(e)}`);
      return 'failed';
    }
  }

  async function overwriteWithMine(): Promise<SaveOutcome> {
    if (!conflict || conflict.busy || editId === null || inFlight) return 'failed';
    const id = editId;
    setBusy('overwrite');
    let target = conflict.serverVersion;
    try {
      target ??= (await callApi().fetchBrewForEdit(id)).version;
    } catch (e) {
      setBusy(null, `Couldn't reach the saved version. ${describeApiError(e)}`);
      return 'failed';
    }
    // The conflict stays (busy) while the request runs; success clears it, a 409 replaces it.
    const held = conflict;
    const outcome = await performSave('overwrite', target);
    if (outcome === 'saved') return 'saved';
    const current = conflict as AutosaveConflict | null;
    if (outcome === 'conflict' && current) {
      conflict = { ...current, actionError: 'The brew was saved again elsewhere in the meantime. Choose again.' };
      conflictOpen = true;
      emit();
      return 'conflict';
    }
    // Failed for another reason: back to the conflict, with the reason.
    const reason = failure ? describeApiError(failure.error) : 'Something went wrong.';
    failure = null;
    clearRetry();
    conflict = { ...held, busy: null, actionError: `Couldn't overwrite the saved version. ${reason}` };
    conflictOpen = true;
    emit();
    return 'failed';
  }

  /**
   * "Save mine as a copy" (conflict) or "Save as a new brew" (the brew is 'lost'). In a conflict
   * the dialog shows the progress (busy); for a lost brew the status is 'saving', and a failure
   * keeps 'lost' with the reason.
   */
  async function saveAsCopy(): Promise<SaveOutcome> {
    const lost = conflict === null && failure?.kind === 'lost';
    if ((!conflict && !lost) || conflict?.busy || inFlight) return 'failed';
    const state = currentState();
    if (!state) return 'failed';
    const oldId = editId;
    const mySession = session;
    if (lost) {
      inFlight = true;
      inFlightSince = now();
      emit();
    } else {
      setBusy('copy');
    }
    const abort = new AbortController();
    try {
      const external = readExternal();
      const doc = state.doc.toJSON() as JSONContent;
      const sentRev = rev;
      // The copy belongs to the caller: don't carry the author list (it would invite people).
      const meta = external.meta ? { ...external.meta, authors: null } : null;
      const body: CreateBrewRequest = { doc, style: external.style, snippets: external.snippets, meta, docSchemaVersion: DOC_SCHEMA_VERSION };
      const brew = await timed(callApi().createBrew(body, { gzip: 'auto', signal: abort.signal }), abort);
      if (mySession !== session) return 'failed';
      editId = brew.editId;
      baseVersion = brew.version;
      savedRev = sentRev;
      afterSuccess('now', external, brew.updatedAt);
      applyServerDoc(doc, brew, sentRev);
      if (oldId !== null) deleteDraft(keyFor(oldId));
      if (unsaved()) writeDraftNow();
      recordSnapshot({ doc, ...external }, brew.editId, titleOf(external.meta, doc), brew.version);
      opts.onCreated?.(brew, 'copy');
      emit();
      afterAttempt();
      return 'saved';
    } catch (e) {
      if (!lost) setBusy(null, `Couldn't save a copy. ${describeApiError(e)}`);
      else if (mySession === session) failure = { kind: 'lost', error: new Error(`Couldn't save a copy. ${describeApiError(e)}`) };
      return 'failed';
    } finally {
      // The lost brew's copy ran as the request in flight (as performSave's finally does).
      if (lost && inFlight) {
        clearInFlight();
        emit();
      }
    }
  }

  // ─── Restoring ──────────────────────────────────────────────────────────────────────────────

  function restoreContent(content: BrewContent, docSchemaVersion: number, source: 'draft' | 'snapshot'): boolean {
    const target = liveEditor();
    if (!target) return false;
    try {
      const doc = migrateDoc(content.doc, docSchemaVersion);
      replaceDocument(target, doc, { undoable: true, dirty: true });
      opts.onRestore?.({ ...content, doc }, source);
    } catch (e) {
      warn(`restoring the ${source} failed`, e);
      return false;
    }
    externalEpoch++;
    change(); // style or meta may be all that differs
    return true;
  }

  // ─── Controller ─────────────────────────────────────────────────────────────────────────────

  /**
   * The loaded version arrives after the hook mounted (editId from the URL first, the brew
   * later): take it, as long as this session hasn't saved anything itself.
   */
  function adoptVersion(nextEditId: string | null, nextBaseVersion: number | null): void {
    if (nextEditId === null || nextEditId !== editId || baseVersion !== null || nextBaseVersion === null || saveCount > 0) return;
    baseVersion = nextBaseVersion;
    lastSavedAt ??= parseTime(opts.lastSavedAt);
  }

  function flush(trigger: 'hidden' | 'unmount' = 'hidden'): void {
    if (!enabled() || !unsaved()) return;
    writeDraftNow();
    if (conflict || failure?.kind === 'signedOut' || failure?.kind === 'lost' || waitingForSignIn()) return;
    void run(trigger);
  }

  return {
    getState: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    update(next) {
      const waited = waitingForSignIn();
      opts = next;
      if (next.ownerId) draftOwner = next.ownerId;
      adoptVersion(next.editId, next.baseVersion);
      if (!enabled()) {
        clearDebounce();
        clearRetry();
        clearDraftTimer();
      }
      checkDraft();
      emit();
      // Someone signed in: the new brew the draft kept is created now.
      if (waited && !waitingForSignIn() && started && enabled() && unsaved() && !paused()) void run('retry');
    },

    attach(next) {
      if (editor === next) return;
      editor?.off('transaction', onTransaction);
      editor = next;
      if (next && !next.isDestroyed) {
        lastState = next.state;
        next.on('transaction', onTransaction);
      }
      checkDraft();
    },

    setSession(nextEditId, nextBaseVersion) {
      if (nextEditId === editId) {
        adoptVersion(nextEditId, nextBaseVersion);
        emit();
        return;
      }
      if (unsaved()) flush('unmount');
      session++;
      editId = nextEditId;
      baseVersion = nextBaseVersion;
      createKey = null;
      pendingCreate = null;
      rev = 0;
      savedRev = 0;
      queued = null;
      failure = null;
      conflict = null;
      conflictOpen = false;
      retryIndex = 0;
      clearDebounce();
      clearRetry();
      clearDraftTimer();
      lastDraftWrite = Number.NEGATIVE_INFINITY;
      draftChecked = false;
      draftWrittenThisSession = false;
      storedRev = -1;
      draftWriteFailed = false;
      draftOffers = [];
      draftReady = Promise.resolve();
      lastSavedAt = parseTime(opts.lastSavedAt);
      externalBaseline = safeFingerprint();
      checkDraft();
      emit();
    },

    start() {
      if (started) return;
      started = true;
      externalBaseline ??= safeFingerprint();
      checkDraft();
      if (unsaved() && !paused() && enabled()) scheduleSave();
      emit();
    },

    stop() {
      if (!started) return;
      flush('unmount');
      started = false;
      clearDebounce();
      clearRetry();
      for (const resolve of [...settleWaiters]) resolve();
    },

    markDirty() {
      change();
    },

    externalChanged() {
      const current = safeFingerprint();
      if (current === null) return;
      if (rebaselineExternal || externalBaseline === null) {
        rebaselineExternal = false;
        externalBaseline = current;
        return;
      }
      if (current !== externalBaseline) {
        externalBaseline = current;
        change();
      }
    },

    async saveNow() {
      if (!enabled()) return 'disabled';
      if (conflict) {
        conflictOpen = true;
        emit();
        return 'conflict';
      }
      if (inFlight) return run('now');
      if (!unsaved()) return 'unchanged';
      clearDebounce();
      await waitForSettle(SAVE_NOW_SETTLE_MS);
      return run('now');
    },

    flush,

    retry() {
      // A lost brew can't be saved again; saveNow still tries when the author asks.
      if (!enabled() || conflict || !unsaved() || !failure || failure.kind === 'lost') return;
      void run('retry');
    },

    openConflict() {
      if (!conflict) return;
      conflictOpen = true;
      emit();
    },

    closeConflict() {
      conflictOpen = false;
      emit();
    },

    loadSavedVersion,
    overwriteWithMine,
    saveAsCopy,

    restoreDraft() {
      const offer = draftOffers[0];
      if (!offer) return false;
      draftOffers = draftOffers.slice(1);
      const held = conflict;
      if (offer.kind === 'conflict' && !held) {
        // Made on another version (or in a conflict): saving it would overwrite the server's
        // newer version. It goes into the editor, and the conflict dialog asks what to keep.
        conflict = { serverVersion: baseVersion, busy: null, actionError: null };
        conflictOpen = true;
        clearDebounce();
        clearRetry();
      }
      const ok = restoreContent(offer, offer.docSchemaVersion, 'draft');
      if (!ok) {
        conflict = held;
        conflictOpen = held !== null && conflictOpen;
      } else if (offer.key !== ownKey()) {
        // This session's draft holds it now (written first, in order), so the offered one goes.
        writeDraftNow();
        deleteDraft(offer.key);
      }
      emit();
      return ok;
    },

    async discardDraft() {
      const offer = draftOffers[0];
      if (!offer) return;
      draftOffers = draftOffers.slice(1);
      emit();
      // A new brew's draft shares its key with this session: once it wrote, the stored one isn't the offer.
      if (offer.key !== ownKey() || !draftWrittenThisSession) {
        deleteDraft(offer.key);
        await draftChain;
      }
    },

    async listSnapshots() {
      const history = opts.snapshots;
      if (!history || editId === null) return [];
      try {
        return await history.list(editId);
      } catch (e) {
        warn('reading local snapshots failed', e);
        return [];
      }
    },

    restoreSnapshot(snap) {
      return restoreContent(snap, snap.docSchemaVersion, 'snapshot');
    },

    shouldWarnOnUnload(scope = 'page') {
      if (!enabled() || !unsaved()) return false;
      // A new brew waiting for a sign-in lives in its draft, which /new loads again (APP-9).
      if (editId === null && !conflict && (waitingForSignIn() || failure?.kind === 'signedOut')) return !draftKeeps(scope);
      if (conflict || failure) return true;
      return inFlightSince !== null && now() - inFlightSince >= STALLED_SAVE_MS;
    },
  };
}

/** Text of the first heading in a document (for snapshot titles). */
export function findFirstHeading(doc: JSONContent): string {
  const visit = (node: JSONContent): string | null => {
    if (node.type === 'heading') return textOf(node).trim().slice(0, 100);
    for (const child of node.content ?? []) {
      if (child.type === 'text') continue;
      const found = visit(child);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(doc) ?? '';
}

function textOf(node: JSONContent): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}
