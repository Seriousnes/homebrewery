// autosave.ts: the plan §9 state machine, driven by a real TipTap editor (jsdom), fake timers and
// a fake API. The HTTP layer (PUT/POST shape, gzip, error parsing) is covered at the end with the
// real '@/api' calls on a stubbed fetch.
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrewMetaInput, SaveBrewRequest, SaveBrewResponse } from '@/api';
import { jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { isSettled } from '../pagination/state';
import { LAYOUT_NEUTRAL_META } from '../schema/plugins/meta';
import { DOC_SCHEMA_VERSION } from '../schema/version';
import {
  createAutosave,
  defaultAutosaveApi,
  SAVE_TIMEOUT_MS,
  STALLED_SAVE_MS,
  type AutosaveApi,
  type AutosaveController,
  type AutosaveOptions,
} from './autosave';
import { replaceDocument } from './applyDoc';
import { draftOfferKind, shouldOfferDraft, type Draft } from './drafts';
import { createdFromDraft, pendingNewBrewCreates, resetNewBrewCreates } from './newBrewCreates';
import {
  brewForEdit,
  conflictError,
  deferred,
  docOf,
  draftOf,
  fakeApi,
  httpError,
  memoryDrafts,
  memorySnapshots,
  mountEditor,
  networkError,
  paginationChange,
  saveResponse,
  texts,
  typeText,
  type FakeApi,
} from './testing';

interface Harness {
  editor: Editor;
  controller: AutosaveController;
  api: FakeApi;
  drafts: ReturnType<typeof memoryDrafts>;
  snapshots: ReturnType<typeof memorySnapshots>;
  external: { style: string; snippets: unknown; meta: BrewMetaInput | null };
  settle(): void;
  saves(): SaveBrewRequest[];
  status(): string;
}

let current: Harness | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-09-25T10:00:00.000Z') });
});

afterEach(() => {
  current?.controller.stop();
  current?.editor.destroy();
  current = undefined;
  vi.useRealTimers();
});

function setup(
  options: Partial<AutosaveOptions> & {
    content?: JSONContent;
    paginate?: boolean;
    api?: FakeApi;
    draftEntries?: [string, Draft][];
    /** A draft store shared with another harness (another tab). */
    store?: ReturnType<typeof memoryDrafts>;
  } = {},
): Harness {
  const { content = docOf('Hello'), paginate = false, api = fakeApi(), draftEntries = [], store, ...rest } = options;
  const mounted = mountEditor(content, { paginate });
  const drafts = store ?? memoryDrafts(draftEntries);
  const snapshots = memorySnapshots(() => Date.now());
  const external = { style: '', snippets: null as unknown, meta: { title: 'Brew' } as BrewMetaInput | null };
  const controller = createAutosave({
    editId: 'edit-1',
    baseVersion: 1,
    getStyle: () => external.style,
    getSnippets: () => external.snippets,
    getMeta: () => external.meta,
    api,
    drafts,
    snapshots: snapshots.history,
    logger: { warn: () => {} },
    ...rest,
  });
  controller.attach(mounted.editor);
  controller.start();
  current = {
    editor: mounted.editor,
    controller,
    api,
    drafts,
    snapshots,
    external,
    settle: mounted.settle,
    saves: () => api.calls.filter((c) => c.method === 'save').map((c) => c.body as SaveBrewRequest),
    status: () => controller.getState().status,
  };
  return current;
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const docText = (doc: unknown) => JSON.stringify(doc);

/** The stored drafts of a brew, whichever session wrote them, newest first. */
const draftsOf = (store: ReturnType<typeof memoryDrafts>, editId = 'edit-1'): Draft[] =>
  [...store.map.values()].filter((d) => d.editId === editId).sort((a, b) => b.updatedAt - a.updatedAt);
/** The newest stored draft of a brew. */
const storedDraft = (h: Harness, editId = 'edit-1'): Draft | undefined => draftsOf(h.drafts, editId)[0];

describe('dirty rules and scheduling', () => {
  it('saves 3 s after the last change, with the whole brew', async () => {
    const h = setup();
    typeText(h.editor, ' world');
    expect(h.status()).toBe('dirty');
    await advance(2000);
    typeText(h.editor, '!'); // restarts the delay
    await advance(2999);
    expect(h.saves()).toHaveLength(0);
    await advance(1);
    expect(h.saves()).toHaveLength(1);
    const body = h.saves()[0]!;
    expect(body).toMatchObject({ baseVersion: 1, style: '', snippets: null, meta: { title: 'Brew' }, docSchemaVersion: DOC_SCHEMA_VERSION });
    expect(docText(body.doc)).toContain('Hello world!');
    expect(h.status()).toBe('saved');
    expect(h.controller.getState()).toMatchObject({ baseVersion: 2, unsaved: false, lastTrigger: 'auto', saveCount: 1 });
  });

  it('ignores pagination and id bookkeeping transactions', async () => {
    const h = setup();
    paginationChange(h.editor);
    h.editor.view.dispatch(h.editor.state.tr.insertText('#', 2).setMeta(LAYOUT_NEUTRAL_META, true).setMeta('addToHistory', false));
    expect(h.status()).toBe('saved');
    await advance(10_000);
    expect(h.saves()).toHaveLength(0);
  });

  it('counts undo as a change', async () => {
    const h = setup();
    typeText(h.editor, 'x');
    await advance(3000);
    h.editor.commands.undo();
    expect(h.status()).toBe('dirty');
    await advance(3000);
    expect(h.saves()).toHaveLength(2);
    expect(docText(h.saves()[1]!.doc)).not.toContain('Hellox');
  });

  it('counts style and meta edits (markDirty, externalChanged)', async () => {
    const h = setup();
    h.controller.externalChanged(); // nothing changed yet
    expect(h.status()).toBe('saved');
    h.external.style = '.page { color: red }';
    h.controller.externalChanged();
    expect(h.status()).toBe('dirty');
    await advance(3000);
    expect(h.saves()[0]).toMatchObject({ style: '.page { color: red }' });
    h.controller.externalChanged(); // same as saved
    expect(h.status()).toBe('saved');
    h.external.meta = { title: 'Renamed' };
    h.controller.markDirty();
    await advance(3000);
    expect(h.saves()[1]).toMatchObject({ baseVersion: 2, meta: { title: 'Renamed' } });
  });

  it('waits for pagination to settle before saving', async () => {
    const h = setup({ paginate: true });
    h.settle();
    typeText(h.editor, ' world');
    expect(isSettled(h.editor.state)).toBe(false);
    await advance(5000);
    expect(h.saves()).toHaveLength(0);
    h.settle(); // the pagination frames run: its PAGINATE transactions settle the state
    await advance(0);
    expect(h.saves()).toHaveLength(1);
    expect(h.status()).toBe('saved');
  });

  it('saves anyway when pagination never settles (settleTimeoutMs)', async () => {
    const h = setup({ paginate: true, settleTimeoutMs: 10_000 });
    typeText(h.editor, ' world');
    await advance(3000 + 9999);
    expect(h.saves()).toHaveLength(0);
    await advance(1);
    expect(h.saves()).toHaveLength(1);
  });
});

describe('saving', () => {
  it('uses the returned version as the next baseVersion', async () => {
    const h = setup();
    typeText(h.editor, 'a');
    await advance(3000);
    typeText(h.editor, 'b');
    await advance(3000);
    expect(h.saves().map((b) => b.baseVersion)).toEqual([1, 2]);
    expect(h.controller.getState().baseVersion).toBe(3);
  });

  it('never overlaps requests: changes during a save are saved after it', async () => {
    const pending = deferred<ReturnType<typeof saveResponse>>();
    const api = fakeApi({ saveBrew: () => pending.promise });
    const h = setup({ api });
    typeText(h.editor, 'a');
    await advance(3000);
    expect(h.status()).toBe('saving');
    typeText(h.editor, 'b');
    await advance(3000); // due, but a request is in flight: queued
    expect(api.calls).toHaveLength(1);
    await h.controller.saveNow(); // queued too
    expect(api.calls).toHaveLength(1);
    pending.resolve(saveResponse(2));
    await advance(0);
    expect(api.calls).toHaveLength(2);
    expect((api.calls[1]!.body as SaveBrewRequest).baseVersion).toBe(2);
  });

  it('saveNow saves at once, and reports when there is nothing to save', async () => {
    const h = setup();
    expect(await h.controller.saveNow()).toBe('unchanged');
    typeText(h.editor, 'a');
    const outcome = h.controller.saveNow();
    await advance(0);
    expect(await outcome).toBe('saved');
    expect(h.controller.getState()).toMatchObject({ status: 'saved', lastTrigger: 'now' });
    await advance(5000);
    expect(h.saves()).toHaveLength(1); // the debounced save found nothing left
  });

  it('flush (hidden / unmount) sends keepalive with gzip, and stop() flushes', async () => {
    const h = setup();
    typeText(h.editor, 'a');
    h.controller.flush('hidden');
    await advance(0);
    expect(h.api.calls[0]!.options).toMatchObject({ gzip: 'always', keepalive: true });
    typeText(h.editor, 'b');
    h.controller.stop();
    await advance(0);
    expect(h.api.calls).toHaveLength(2);
    expect(h.api.calls[1]!.options).toMatchObject({ gzip: 'always', keepalive: true });
  });

  it('skips keepalive when the compressed body is over the keepalive quota', async () => {
    const random = () => Array.from({ length: 12 }, () => Math.random().toString(36).slice(2, 12)).join('');
    const big = Array.from({ length: 1500 }, random);
    const h = setup({ content: docOf(...big) });
    typeText(h.editor, 'a');
    h.controller.flush('hidden');
    await advance(0);
    expect(h.api.calls[0]!.options).toMatchObject({ gzip: 'always', keepalive: false });
  });

  it('keeps the local document after a save (no replacement, history intact)', async () => {
    const h = setup();
    typeText(h.editor, ' one');
    await advance(3000);
    expect(texts(h.editor)).toEqual(['Hello one']);
    expect(undoDepth(h.editor.state)).toBe(1);
  });

  it('records a local snapshot after each save', async () => {
    const h = setup();
    typeText(h.editor, ' saved');
    await advance(3000);
    await advance(0);
    const [snapshot] = await h.snapshots.history.list('edit-1');
    expect(snapshot).toMatchObject({ version: 2, title: 'Brew', slot: 1 });
    expect(docText(snapshot!.doc)).toContain('Hello saved');
  });
});

describe('drafts', () => {
  it('writes every change to IndexedDB, throttled to 1 s (leading and trailing)', async () => {
    const h = setup({ delayMs: 60_000 });
    const set = vi.spyOn(h.drafts, 'set');
    typeText(h.editor, 'a');
    await advance(0);
    expect(set).toHaveBeenCalledTimes(1);
    typeText(h.editor, 'b');
    await advance(300);
    typeText(h.editor, 'c');
    await advance(300);
    expect(set).toHaveBeenCalledTimes(1);
    await advance(400);
    expect(set).toHaveBeenCalledTimes(2);
    const draft = storedDraft(h)!;
    expect(draft).toMatchObject({ editId: 'edit-1', baseVersion: 1, meta: { title: 'Brew' } });
    expect(docText(draft.doc)).toContain('Helloabc');
  });

  it('deletes the draft after a save that has everything', async () => {
    const h = setup();
    typeText(h.editor, 'a');
    await advance(0);
    expect(storedDraft(h)).toBeDefined();
    await advance(3000);
    expect(storedDraft(h)).toBeUndefined();
  });

  it('rewrites the draft on the new version when changes came in during the save', async () => {
    const pending = deferred<ReturnType<typeof saveResponse>>();
    const h = setup({ api: fakeApi({ saveBrew: () => pending.promise }) });
    typeText(h.editor, 'a');
    await advance(3000);
    typeText(h.editor, 'b'); // while saving
    await advance(1000);
    expect(storedDraft(h)).toMatchObject({ baseVersion: 1, pendingVersion: 2 });
    pending.resolve(saveResponse(2));
    await advance(0);
    expect(storedDraft(h)).toMatchObject({ baseVersion: 2, pendingVersion: null });
    expect(docText(storedDraft(h)!.doc)).toContain('Helloab');
  });

  it('offers a stored draft made on the loaded version, and restores it as one undo step', async () => {
    const onRestore = vi.fn();
    const draft = draftOf({ doc: docOf('Hello from the draft'), style: '.x{}', updatedAt: Date.now() - 60_000 });
    const h = setup({ draftEntries: [['edit-1', draft]], baseline: { doc: docOf('Hello'), style: '' }, onRestore });
    await advance(0);
    expect(h.controller.getState().draftOffer).toMatchObject({ baseVersion: 1, style: '.x{}' });
    expect(h.controller.restoreDraft()).toBe(true);
    expect(texts(h.editor)).toEqual(['Hello from the draft']);
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ style: '.x{}' }), 'draft');
    expect(h.controller.getState()).toMatchObject({ draftOffer: null, status: 'dirty' });
    h.external.style = '.x{}';
    await advance(3000);
    expect(h.saves()[0]).toMatchObject({ baseVersion: 1, style: '.x{}' });
    h.editor.commands.undo();
    expect(texts(h.editor)).toEqual(['Hello']);
  });

  it('does not offer a draft equal to the server (a stale one is a conflict offer: SAVE-2 below)', async () => {
    const same = setup({ draftEntries: [['edit-1', draftOf({ doc: docOf('Hello') })]], baseline: { doc: docOf('Hello') } });
    await advance(0);
    expect(same.controller.getState().draftOffer).toBeNull();
  });

  it('reads the old draft before writing a new one, and never writes over it', async () => {
    const h = setup({ draftEntries: [['edit-1', draftOf({ doc: docOf('Old draft') })]], baseline: { doc: docOf('Hello') } });
    typeText(h.editor, ' new'); // before the read resolves
    await advance(1000);
    expect(h.controller.getState().draftOffer).toMatchObject({ doc: docOf('Old draft') });
    // This session's draft has a key of its own: the offer stays stored until it is answered.
    expect(docText(h.drafts.map.get('edit-1')!.doc)).toContain('Old draft');
    const stored = draftsOf(h.drafts).map((d) => docText(d.doc));
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(expect.arrayContaining([expect.stringContaining('Hello new'), expect.stringContaining('Old draft')]));
  });

  it("discarding deletes the offered draft, not the session's own", async () => {
    const h = setup({ draftEntries: [['edit-1', draftOf()]], baseline: { doc: docOf('Hello') } });
    await advance(0);
    typeText(h.editor, ' mine');
    await advance(0);
    await h.controller.discardDraft();
    expect(h.controller.getState().draftOffer).toBeNull();
    expect(h.drafts.map.has('edit-1')).toBe(false);
    expect(docText(storedDraft(h)!.doc)).toContain('Hello mine');
  });
});

describe('409 conflict', () => {
  function conflicted(api: FakeApi = fakeApi({ saveBrew: () => Promise.reject(conflictError(7)) })) {
    const h = setup({ api });
    typeText(h.editor, ' mine');
    return h;
  }

  it('stops autosave and opens the conflict dialog', async () => {
    const h = conflicted();
    await advance(3000);
    expect(h.controller.getState()).toMatchObject({ status: 'conflict', conflictOpen: true, conflict: { serverVersion: 7, busy: null } });
    typeText(h.editor, ' more');
    await advance(20_000);
    expect(h.saves()).toHaveLength(1); // stopped
    expect(await h.controller.saveNow()).toBe('conflict');
    expect(h.saves()).toHaveLength(1);
    expect(docText(storedDraft(h)!.doc)).toContain('Hello mine more'); // the draft is kept
    expect(h.controller.shouldWarnOnUnload()).toBe(true);
    h.controller.closeConflict();
    expect(h.controller.getState()).toMatchObject({ status: 'conflict', conflictOpen: false });
    h.controller.openConflict();
    expect(h.controller.getState().conflictOpen).toBe(true);
  });

  it('Overwrite with mine: PUT with baseVersion = serverVersion, then autosave resumes', async () => {
    let conflictOnce = true;
    const api = fakeApi({
      saveBrew: (_id, body) => {
        if (conflictOnce) {
          conflictOnce = false;
          return Promise.reject(conflictError(7));
        }
        return Promise.resolve(saveResponse(body.baseVersion + 1));
      },
    });
    const h = conflicted(api);
    await advance(3000);
    expect(await h.controller.overwriteWithMine()).toBe('saved');
    expect(h.saves()[1]).toMatchObject({ baseVersion: 7 });
    expect(h.controller.getState()).toMatchObject({ status: 'saved', conflict: null, baseVersion: 8 });
    typeText(h.editor, '!');
    await advance(3000);
    expect(h.saves()[2]).toMatchObject({ baseVersion: 8 });
  });

  it('Overwrite with mine when someone saved again: a new conflict with a message', async () => {
    let next = 7;
    const api = fakeApi({ saveBrew: () => Promise.reject(conflictError(next++)) });
    const h = conflicted(api);
    await advance(3000);
    expect(await h.controller.overwriteWithMine()).toBe('conflict');
    expect(h.controller.getState().conflict).toMatchObject({ serverVersion: 8, actionError: expect.stringContaining('saved again') as unknown });
  });

  it('Load the saved version: one undo step, mine kept as a snapshot, autosave resumes', async () => {
    const onServerBrew = vi.fn();
    const api = fakeApi({
      saveBrew: (_id, body) => (body.baseVersion === 1 ? Promise.reject(conflictError(7)) : Promise.resolve(saveResponse(body.baseVersion + 1))),
      fetchBrewForEdit: () => Promise.resolve(brewForEdit({ version: 7, doc: docOf('Theirs'), style: '.theirs{}' })),
    });
    const h = setup({ api, onServerBrew });
    typeText(h.editor, ' mine');
    await advance(3000);
    expect(await h.controller.loadSavedVersion()).toBe('saved');
    expect(texts(h.editor)).toEqual(['Theirs']);
    expect(onServerBrew).toHaveBeenCalledWith(expect.objectContaining({ version: 7, style: '.theirs{}' }));
    expect(h.controller.getState()).toMatchObject({ status: 'saved', conflict: null, baseVersion: 7, unsaved: false });
    expect(storedDraft(h)).toBeUndefined();
    await advance(0);
    const [mine] = await h.snapshots.history.list('edit-1');
    expect(mine).toMatchObject({ version: null, title: expect.stringContaining('your unsaved version') as unknown });
    expect(docText(mine!.doc)).toContain('Hello mine');
    // The caller applied the server style; that is the new baseline, not a change.
    h.external.style = '.theirs{}';
    h.controller.externalChanged();
    expect(h.status()).toBe('saved');
    // Undo brings mine back, and that is a change to save (on the server version).
    h.editor.commands.undo();
    expect(texts(h.editor)).toEqual(['Hello mine']);
    await advance(3000);
    expect(h.saves().at(-1)).toMatchObject({ baseVersion: 7 });
  });

  it('Save mine as a copy: POST without authors, then saves go to the new brew', async () => {
    const onCreated = vi.fn();
    const api = fakeApi({
      saveBrew: (id, body) => (id === 'edit-1' ? Promise.reject(conflictError(7)) : Promise.resolve(saveResponse(body.baseVersion + 1))),
    });
    const h = setup({ api, onCreated });
    h.external.meta = { title: 'Brew', authors: ['me', 'friend'] };
    typeText(h.editor, ' mine');
    await advance(3000);
    expect(await h.controller.saveAsCopy()).toBe('saved');
    const create = api.calls.find((c) => c.method === 'create')!.body as { meta: BrewMetaInput; doc: unknown };
    expect(create.meta).toMatchObject({ title: 'Brew', authors: null });
    expect(docText(create.doc)).toContain('Hello mine');
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ editId: 'new-1' }), 'copy');
    expect(h.controller.getState()).toMatchObject({ status: 'saved', editId: 'new-1', baseVersion: 1, conflict: null });
    expect(storedDraft(h)).toBeUndefined();
    typeText(h.editor, '!');
    await advance(3000);
    expect(api.calls.at(-1)).toMatchObject({ method: 'save', editId: 'new-1', body: { baseVersion: 1 } });
  });

  it('reports a failed conflict action in the dialog and stays in conflict', async () => {
    const api = fakeApi({ saveBrew: () => Promise.reject(conflictError(7)), fetchBrewForEdit: () => Promise.reject(networkError()) });
    const h = conflicted(api);
    await advance(3000);
    expect(await h.controller.loadSavedVersion()).toBe('failed');
    expect(h.controller.getState()).toMatchObject({ status: 'conflict', conflict: { busy: null, actionError: expect.stringContaining("Couldn't load") as unknown } });
  });
});

describe('401, network and server errors', () => {
  it('401: keeps the draft, shows signedOut, and waits for a retry', async () => {
    let signedIn = false;
    const api = fakeApi({ saveBrew: (_id, body) => (signedIn ? Promise.resolve(saveResponse(body.baseVersion + 1)) : Promise.reject(httpError(401))) });
    const h = setup({ api });
    typeText(h.editor, ' unsaved');
    await advance(3000);
    expect(h.status()).toBe('signedOut');
    expect(docText(storedDraft(h)!.doc)).toContain('Hello unsaved');
    typeText(h.editor, '!');
    await advance(30_000);
    expect(h.saves()).toHaveLength(1); // no automatic retries while signed out
    expect(h.controller.shouldWarnOnUnload()).toBe(true);
    signedIn = true;
    h.controller.retry(); // e.g. the signed-in user changed
    await advance(0);
    expect(h.status()).toBe('saved');
    expect(storedDraft(h)).toBeUndefined();
  });

  it('network failure: offline, retried with back-off', async () => {
    let online = false;
    const api = fakeApi({ saveBrew: (_id, body) => (online ? Promise.resolve(saveResponse(body.baseVersion + 1)) : Promise.reject(networkError())) });
    const h = setup({ api });
    typeText(h.editor, 'x');
    await advance(3000);
    expect(h.controller.getState()).toMatchObject({ status: 'offline', retryAt: Date.now() + 2000 });
    await advance(2000);
    expect(h.saves()).toHaveLength(2);
    expect(h.controller.getState().retryAt).toBe(Date.now() + 5000);
    typeText(h.editor, 'y'); // no extra attempt per change while offline
    await advance(4000);
    expect(h.saves()).toHaveLength(2);
    online = true;
    await advance(1000);
    expect(h.saves()).toHaveLength(3);
    expect(h.status()).toBe('saved');
  });

  it('server errors: 5xx retried (Retry-After honoured), 400 waits for the next change', async () => {
    const errors = [httpError(503, {}, 20), httpError(400)];
    const api = fakeApi({
      saveBrew: (_id, body) => {
        const error = errors.shift();
        return error ? Promise.reject(error) : Promise.resolve(saveResponse(body.baseVersion + 1));
      },
    });
    const h = setup({ api });
    typeText(h.editor, 'x');
    await advance(3000);
    expect(h.controller.getState()).toMatchObject({ status: 'error', retryAt: Date.now() + 20_000 });
    await advance(20_000);
    expect(h.controller.getState()).toMatchObject({ status: 'error', retryAt: null }); // the 400
    await advance(60_000);
    expect(h.saves()).toHaveLength(2);
    typeText(h.editor, 'y');
    await advance(3000);
    expect(h.saves()).toHaveLength(3);
    expect(h.status()).toBe('saved');
  });
});

describe('new brews (/new)', () => {
  it('the first save POSTs, then saves PUT to the created brew', async () => {
    const onCreated = vi.fn();
    const h = setup({ editId: null, baseVersion: null, onCreated });
    expect(h.status()).toBe('saved');
    typeText(h.editor, ' new');
    await advance(0);
    expect(h.drafts.map.get('new')).toMatchObject({ key: 'new', editId: null, baseVersion: null });
    await advance(3000);
    expect(h.api.calls[0]).toMatchObject({ method: 'create' });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ editId: 'new-1' }), 'new');
    expect(h.controller.getState()).toMatchObject({ editId: 'new-1', baseVersion: 1, status: 'saved' });
    expect(h.drafts.map.has('new')).toBe(false);
    h.controller.setSession('new-1', 1); // the caller navigated to /edit/new-1: nothing changes
    typeText(h.editor, '!');
    await advance(3000);
    expect(h.api.calls[1]).toMatchObject({ method: 'save', editId: 'new-1', body: { baseVersion: 1 } });
  });

  it("applies the server's sanitized document outside the history, keeping the author's undo steps", async () => {
    const api = fakeApi({
      createBrew: () => Promise.resolve(brewForEdit({ editId: 'new-1', version: 1, doc: docOf('Hello new', 'sanitized') })),
    });
    const h = setup({ editId: null, baseVersion: null, api });
    typeText(h.editor, ' new');
    await advance(3000);
    expect(texts(h.editor)).toEqual(['Hello new', 'sanitized']);
    expect(h.status()).toBe('saved'); // the sync is not a change
    expect(undoDepth(h.editor.state)).toBe(1);
  });

  it("doesn't apply the sanitized document over changes made during the request", async () => {
    const pending = deferred<ReturnType<typeof brewForEdit>>();
    const h = setup({ editId: null, baseVersion: null, api: fakeApi({ createBrew: () => pending.promise }) });
    typeText(h.editor, ' new');
    await advance(3000);
    typeText(h.editor, ' more');
    pending.resolve(brewForEdit({ editId: 'new-1', version: 1, doc: docOf('Sanitized') }));
    await advance(0);
    expect(texts(h.editor)).toEqual(['Hello new more']);
    expect(storedDraft(h, 'new-1')).toMatchObject({ baseVersion: 1 });
  });
});

describe('sessions', () => {
  it('switching to another brew flushes the old one and starts over', async () => {
    const h = setup();
    typeText(h.editor, ' old');
    h.controller.setSession('edit-2', 5);
    await advance(0);
    expect(h.api.calls[0]).toMatchObject({ editId: 'edit-1', options: { keepalive: true } });
    expect(h.controller.getState()).toMatchObject({ editId: 'edit-2', baseVersion: 5, status: 'saved' });
  });

  it('takes the loaded version when it arrives after mounting (same editId), before checking the draft', async () => {
    const h = setup({ baseVersion: null, draftEntries: [['edit-1', draftOf({ baseVersion: 3, doc: docOf('Draft') })]] });
    await advance(0);
    expect(h.controller.getState()).toMatchObject({ baseVersion: null, draftOffer: null });
    h.controller.update({ ...optionsOf(h), api: h.api, baseVersion: 3, baseline: { doc: docOf('Hello') } });
    await advance(0);
    expect(h.controller.getState()).toMatchObject({ baseVersion: 3, draftOffer: { baseVersion: 3 } });
    typeText(h.editor, '!');
    await advance(3000);
    expect(h.saves()[0]).toMatchObject({ baseVersion: 3 });
    // Once this session saved, a stale prop can't move the version back.
    h.controller.setSession('edit-1', 3);
    expect(h.controller.getState().baseVersion).toBe(4);
  });

  it('replaceDocument with dirty false leaves nothing to save', async () => {
    const h = setup();
    replaceDocument(h.editor, docOf('Server copy'), { undoable: false, dirty: false });
    await advance(5000);
    expect(h.saves()).toHaveLength(0);
  });
});

describe('pendingVersion only while the outcome is unknown (SAVE-1)', () => {
  const theirV2 = { doc: docOf('Hello theirs'), style: '', snippets: null };

  it.each([
    ['409', conflictError(2)],
    ['400', httpError(400)],
    ['403', httpError(403)],
    ['503', httpError(503)],
  ])('a save the server answered %s was not applied: the draft has no pendingVersion', async (_name, error) => {
    const h = setup({ api: fakeApi({ saveBrew: () => Promise.reject(error) }) });
    typeText(h.editor, ' mine');
    await advance(3000);
    const draft = storedDraft(h)!;
    expect(draft).toMatchObject({ baseVersion: 1, pendingVersion: null });
    // Another client's v2 is not ours: never a plain "Restore" on top of it.
    expect(shouldOfferDraft(draft, 2, theirV2, h.editor.schema)).toBe(false);
  });

  it('a tab closed during a save: the draft keeps what the save sent, and is a plain restore only when the server has exactly that', async () => {
    const held = deferred<SaveBrewResponse>();
    const h = setup({ api: fakeApi({ saveBrew: () => held.promise }) });
    typeText(h.editor, ' sent');
    h.controller.flush('hidden'); // the keepalive PUT, held open (the page is going away)
    typeText(h.editor, ' later'); // typed after it started
    h.controller.flush('hidden');
    await advance(0);
    const draft = storedDraft(h)!;
    expect(draft).toMatchObject({ baseVersion: 1, pendingVersion: 2 });
    expect(docText(draft.pending?.doc)).toContain('Hello sent');
    expect(docText(draft.pending?.doc)).not.toContain('later');
    expect(docText(draft.doc)).toContain('Hello sent later');
    const ours = { doc: draft.pending!.doc, style: '', snippets: null, meta: { title: 'Brew' } };
    expect(shouldOfferDraft(draft, 2, ours, h.editor.schema)).toBe(true);
    expect(draftOfferKind(draft, 2, ours, h.editor.schema)).toBe('restore');
    expect(shouldOfferDraft(draft, 2, theirV2, h.editor.schema)).toBe(false);
    expect(draftOfferKind(draft, 2, theirV2, h.editor.schema)).toBe('conflict');
  });

  it('a network failure leaves the outcome unknown: pendingVersion and the sent content stay', async () => {
    const h = setup({ api: fakeApi({ saveBrew: () => Promise.reject(networkError()) }) });
    typeText(h.editor, ' sent');
    await advance(3000);
    expect(storedDraft(h)).toMatchObject({ baseVersion: 1, pendingVersion: 2 });
    expect(docText(storedDraft(h)!.pending?.doc)).toContain('Hello sent');
  });
});

describe('drafts that can no longer be saved as they are (SAVE-2, SAVE-10)', () => {
  const theirV2 = { doc: docOf('Hello theirs'), style: '', snippets: null };

  it('a draft left in conflict is offered as a conflict; restoring it asks before anything is saved', async () => {
    const store = memoryDrafts();
    const first = setup({ store, api: fakeApi({ saveBrew: () => Promise.reject(conflictError(2)) }) });
    typeText(first.editor, ' mine');
    await advance(3000);
    expect(first.status()).toBe('conflict');
    first.controller.stop(); // the author left the page (an in-app link): the draft stays
    first.editor.destroy();
    await advance(0);

    const next = setup({ store, baseVersion: 2, content: docOf('Hello theirs'), baseline: theirV2 });
    await advance(0);
    expect(next.controller.getState().draftOffer).toMatchObject({ kind: 'conflict', baseVersion: 1 });
    // Typing in the new session doesn't overwrite the offered draft.
    typeText(next.editor, '!');
    await advance(1000);
    expect(draftsOf(store).some((d) => docText(d.doc).includes('Hello mine'))).toBe(true);
    // Restoring puts it in the editor and opens the conflict: nothing overwrites v2 silently.
    expect(next.controller.restoreDraft()).toBe(true);
    expect(texts(next.editor)).toEqual(['Hello mine']);
    expect(next.controller.getState()).toMatchObject({ status: 'conflict', conflictOpen: true, conflict: { serverVersion: 2 }, draftOffer: null });
    await advance(20_000);
    expect(next.saves()).toHaveLength(0);
    // The session's own draft holds it now, marked as a conflict; the offered one is gone.
    const stored = draftsOf(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ baseVersion: 2, conflict: true });
    expect(docText(stored[0]!.doc)).toContain('Hello mine');
    // "Overwrite with mine" is the author's choice.
    expect(await next.controller.overwriteWithMine()).toBe('saved');
    expect(next.saves()[0]).toMatchObject({ baseVersion: 2 });
  });

  it('a draft made on an older version (stale) is offered as a conflict, not dropped', async () => {
    const h = setup({ baseVersion: 4, draftEntries: [['edit-1', draftOf({ baseVersion: 2 })]], baseline: { doc: docOf('Hello') } });
    await advance(0);
    expect(h.controller.getState().draftOffer).toMatchObject({ kind: 'conflict', baseVersion: 2 });
  });

  it('offers a draft made on the loaded version as a plain restore', async () => {
    const h = setup({ draftEntries: [['edit-1', draftOf()]], baseline: { doc: docOf('Hello') } });
    await advance(0);
    expect(h.controller.getState().draftOffer).toMatchObject({ kind: 'restore' });
    expect(h.controller.restoreDraft()).toBe(true);
    expect(h.controller.getState().conflict).toBeNull();
  });

  it("one tab's save doesn't delete another tab's draft, which is offered later (as a conflict)", async () => {
    const store = memoryDrafts();
    const tabB = setup({ store, api: fakeApi({ saveBrew: () => Promise.reject(networkError()) }) });
    typeText(tabB.editor, ' B-only-text');
    await advance(0);
    expect(draftsOf(store)).toHaveLength(1);
    // Tab A saves the same brew.
    const tabA = setup({ store });
    typeText(tabA.editor, ' A');
    await advance(3000);
    expect(tabA.status()).toBe('saved');
    expect(draftsOf(store).some((d) => docText(d.doc).includes('B-only-text'))).toBe(true);
    // Tab B dies; the brew is opened again at A's version.
    tabB.editor.destroy();
    const later = setup({ store, baseVersion: 2, content: docOf('Hello A'), baseline: { doc: docOf('Hello A'), style: '', snippets: null } });
    await advance(0);
    const offer = later.controller.getState().draftOffer;
    expect(offer).toMatchObject({ kind: 'conflict' });
    expect(docText(offer!.doc)).toContain('B-only-text');
    tabB.controller.stop();
    tabA.controller.stop();
    tabA.editor.destroy();
  });

  it('drops stored drafts of the brew that hold nothing new', async () => {
    const h = setup({ draftEntries: [['edit-1:old', draftOf({ key: 'edit-1:old', doc: docOf('Hello') })]], baseline: { doc: docOf('Hello') } });
    await advance(0);
    expect(h.controller.getState().draftOffer).toBeNull();
    expect(h.drafts.map.has('edit-1:old')).toBe(false);
  });
});

describe('changes typed while a retry or an overwrite runs (SAVE-3)', () => {
  it('offline, then typing during the retry: saved after it', async () => {
    const retry = deferred<SaveBrewResponse>();
    let call = 0;
    const api = fakeApi({
      saveBrew: (_id, body) => {
        call++;
        if (call === 1) return Promise.reject(networkError());
        if (call === 2) return retry.promise;
        return Promise.resolve(saveResponse(body.baseVersion + 1));
      },
    });
    const h = setup({ api });
    typeText(h.editor, 'a');
    await advance(3000);
    expect(h.status()).toBe('offline');
    await advance(2000); // the retry runs
    expect(h.status()).toBe('saving');
    typeText(h.editor, ' typed-during-retry');
    retry.resolve(saveResponse(2));
    await advance(0);
    expect(h.status()).toBe('dirty');
    await advance(3000);
    expect(h.saves()).toHaveLength(3);
    expect(docText(h.saves()[2]!.doc)).toContain('typed-during-retry');
    expect(h.status()).toBe('saved');
  });

  it('401, then typing while retry() runs: saved after it', async () => {
    const retry = deferred<SaveBrewResponse>();
    let call = 0;
    const api = fakeApi({
      saveBrew: (_id, body) => {
        call++;
        if (call === 1) return Promise.reject(httpError(401));
        if (call === 2) return retry.promise;
        return Promise.resolve(saveResponse(body.baseVersion + 1));
      },
    });
    const h = setup({ api });
    typeText(h.editor, 'a');
    await advance(3000);
    expect(h.status()).toBe('signedOut');
    h.controller.retry();
    await advance(0);
    typeText(h.editor, ' typed-during-retry');
    retry.resolve(saveResponse(2));
    await advance(3000);
    expect(h.saves()).toHaveLength(3);
    expect(h.status()).toBe('saved');
  });

  it('conflict, then typing while "Overwrite with mine" runs: saved after it', async () => {
    const overwrite = deferred<SaveBrewResponse>();
    let call = 0;
    const api = fakeApi({
      saveBrew: (_id, body) => {
        call++;
        if (call === 1) return Promise.reject(conflictError(7));
        if (call === 2) return overwrite.promise;
        return Promise.resolve(saveResponse(body.baseVersion + 1));
      },
    });
    const h = setup({ api });
    typeText(h.editor, 'a');
    await advance(3000);
    const outcome = h.controller.overwriteWithMine();
    await advance(0);
    typeText(h.editor, ' typed-during-overwrite');
    overwrite.resolve(saveResponse(8));
    expect(await outcome).toBe('saved');
    await advance(3000);
    expect(h.saves()).toHaveLength(3);
    expect(h.saves()[2]).toMatchObject({ baseVersion: 8 });
    expect(h.status()).toBe('saved');
  });

  it('a refused save (400) still waits for the next change', async () => {
    const api = fakeApi({ saveBrew: () => Promise.reject(httpError(400)) });
    const h = setup({ api });
    typeText(h.editor, 'a');
    await advance(60_000);
    expect(h.saves()).toHaveLength(1);
  });
});

describe('the brew is out of reach: 403, 404, 410 (SAVE-4)', () => {
  it.each([403, 404, 410])('%s: no retries, and "Save as a new brew" keeps the work on the server', async (status) => {
    const onCreated = vi.fn();
    const api = fakeApi({
      saveBrew: (id, body) => (id === 'edit-1' ? Promise.reject(httpError(status)) : Promise.resolve(saveResponse(body.baseVersion + 1))),
    });
    const h = setup({ api, onCreated });
    h.external.meta = { title: 'Brew', authors: ['me', 'friend'] };
    typeText(h.editor, ' mine');
    await advance(3000);
    expect(h.controller.getState()).toMatchObject({ status: 'lost', retryAt: null, conflict: null });
    typeText(h.editor, '!');
    await advance(120_000);
    expect(h.saves()).toHaveLength(1);
    expect(h.controller.shouldWarnOnUnload()).toBe(true);
    expect(await h.controller.saveAsCopy()).toBe('saved');
    const creates = api.calls.filter((c) => c.method === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toMatchObject({ meta: { title: 'Brew', authors: null } });
    expect(docText((creates[0]!.body as { doc: unknown }).doc)).toContain('Hello mine!');
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ editId: 'new-1' }), 'copy');
    expect(h.controller.getState()).toMatchObject({ status: 'saved', editId: 'new-1', baseVersion: 1, error: null });
    typeText(h.editor, '?');
    await advance(3000);
    expect(api.calls.at(-1)).toMatchObject({ method: 'save', editId: 'new-1' });
  });

  it('a failed copy keeps the state, with the reason', async () => {
    const api = fakeApi({ saveBrew: () => Promise.reject(httpError(404)), createBrew: () => Promise.reject(networkError()) });
    const h = setup({ api });
    typeText(h.editor, ' mine');
    await advance(3000);
    expect(await h.controller.saveAsCopy()).toBe('failed');
    expect(h.controller.getState()).toMatchObject({ status: 'lost', editId: 'edit-1' });
    expect(h.controller.getState().error?.message).toMatch(/reach the server/);
  });
});

describe('a save that never answers (SAVE-9)', () => {
  it('times out: offline and retried; leaving warns once it stalls', async () => {
    let call = 0;
    const api = fakeApi({ saveBrew: (_id, body) => (++call === 1 ? new Promise<SaveBrewResponse>(() => {}) : Promise.resolve(saveResponse(body.baseVersion + 1))) });
    const h = setup({ api });
    typeText(h.editor, 'x');
    await advance(3000);
    expect(h.status()).toBe('saving');
    expect(h.controller.shouldWarnOnUnload()).toBe(false);
    typeText(h.editor, 'y');
    await advance(STALLED_SAVE_MS);
    expect(h.controller.shouldWarnOnUnload()).toBe(true);
    await advance(SAVE_TIMEOUT_MS - STALLED_SAVE_MS);
    expect(h.controller.getState()).toMatchObject({ status: 'offline', retryAt: Date.now() + 2000 });
    const signal = (api.calls[0]!.options as { signal?: AbortSignal }).signal;
    expect(signal?.aborted).toBe(true);
    await advance(2000);
    expect(h.saves()).toHaveLength(2);
    expect(docText(h.saves()[1]!.doc)).toContain('Helloxy');
    expect(h.status()).toBe('saved');
  });

  it('a new brew whose POST never answers is retried too', async () => {
    let call = 0;
    const api = fakeApi({ createBrew: (body) => (++call === 1 ? new Promise(() => {}) : Promise.resolve(brewForEdit({ editId: 'new-1', doc: body.doc as JSONContent }))) });
    const h = setup({ editId: null, baseVersion: null, api });
    typeText(h.editor, ' new');
    await advance(3000 + SAVE_TIMEOUT_MS);
    expect(h.status()).toBe('offline');
    await advance(2000);
    expect(h.controller.getState()).toMatchObject({ status: 'saved', editId: 'new-1' });
  });
});

describe('a new brew while nobody is signed in (APP-9)', () => {
  it('keeps the draft and sends nothing until someone signs in; leaving needs no warning', async () => {
    const h = setup({ editId: null, baseVersion: null, signedOut: true });
    typeText(h.editor, 'My secret draft');
    await advance(3000);
    expect(h.status()).toBe('signedOut');
    h.controller.retry();
    h.controller.flush('hidden');
    expect(await h.controller.saveNow()).not.toBe('saved');
    await advance(60_000);
    expect(h.api.calls).toHaveLength(0);
    expect(docText(h.drafts.map.get('new')!.doc)).toContain('My secret draft');
    expect(h.controller.shouldWarnOnUnload()).toBe(false);
    // Signed in: the brew is created at once.
    h.controller.update({ ...optionsOf(h), api: h.api, editId: null, baseVersion: null, signedOut: false });
    await advance(0);
    expect(h.api.calls.map((c) => c.method)).toEqual(['create']);
    expect(docText((h.api.calls[0]!.body as { doc: unknown }).doc)).toContain('My secret draft');
  });

  it('an existing brew still saves (its 401 is how autosave learns the session ended)', async () => {
    const api = fakeApi({ saveBrew: () => Promise.reject(httpError(401)) });
    const h = setup({ api, signedOut: true });
    typeText(h.editor, 'x');
    await advance(3000);
    expect(h.saves()).toHaveLength(1);
    expect(h.controller.shouldWarnOnUnload()).toBe(true);
  });
});

describe('HTTP (the real @/api calls on a stubbed fetch)', () => {
  const http: Partial<AutosaveApi> = defaultAutosaveApi;

  it('PUTs /api/brews/{editId} as JSON, gzip-compressed from 8 KiB', async () => {
    const server = mockApi((req) => jsonResponse(saveResponse((req.json as SaveBrewRequest).baseVersion + 1)));
    try {
      const h = setup();
      h.controller.update({ ...optionsOf(h), api: http });
      typeText(h.editor, ' small');
      await advance(3000);
      const small = server.last();
      expect(small.method).toBe('PUT');
      expect(small.path).toBe('/api/brews/edit-1');
      expect(small.headers.get('Content-Type')).toBe('application/json');
      expect(small.headers.get('Content-Encoding')).toBeNull();
      expect(small.json).toMatchObject({ baseVersion: 1, style: '', meta: { title: 'Brew' } });
      h.external.style = 'x'.repeat(10_000);
      h.controller.markDirty();
      await advance(3000);
      const large = server.last();
      expect(large.headers.get('Content-Encoding')).toBe('gzip');
      expect(large.rawBody!.length).toBeLessThan(2000);
      expect(large.json).toMatchObject({ baseVersion: 2 });
    } finally {
      server.restore();
    }
  });

  it('turns a 409 body into the conflict with serverVersion, and a 401 into signedOut', async () => {
    let status = 409;
    const server = mockApi(() => (status === 409 ? jsonResponse({ serverVersion: 12 }, 409) : problemResponse(401, { title: 'Unauthorized' })));
    try {
      const h = setup();
      h.controller.update({ ...optionsOf(h), api: http });
      typeText(h.editor, 'x');
      await advance(3000);
      expect(h.controller.getState()).toMatchObject({ status: 'conflict', conflict: { serverVersion: 12 } });
      status = 401;
      h.controller.stop();
      h.editor.destroy();
      const g = setup();
      g.controller.update({ ...optionsOf(g), api: http });
      typeText(g.editor, 'x');
      await advance(3000);
      expect(g.status()).toBe('signedOut');
    } finally {
      server.restore();
    }
  });

  it('POSTs /api/brews for a new brew', async () => {
    const server = mockApi((req) => jsonResponse(brewForEdit({ editId: 'fresh', version: 1, doc: (req.json as { doc: unknown }).doc }), 201));
    try {
      const h = setup({ editId: null, baseVersion: null });
      h.controller.update({ ...optionsOf(h), editId: null, baseVersion: null, api: http });
      typeText(h.editor, ' new');
      await advance(3000);
      expect(server.last()).toMatchObject({ method: 'POST', path: '/api/brews' });
      expect(server.last().json).toMatchObject({ style: '', docSchemaVersion: DOC_SCHEMA_VERSION });
      // SAVE-8: the create chain's key goes as the Idempotency-Key header.
      expect(server.last().headers.get('Idempotency-Key')).toMatch(/^[\w-]{16,}$/);
      expect(h.controller.getState().editId).toBe('fresh');
    } finally {
      server.restore();
    }
  });
});

/** The options a harness was built with (for update()). */
function optionsOf(h: Harness): AutosaveOptions {
  return {
    editId: 'edit-1',
    baseVersion: 1,
    getStyle: () => h.external.style,
    getSnippets: () => h.external.snippets,
    getMeta: () => h.external.meta,
    drafts: h.drafts,
    snapshots: h.snapshots.history,
    logger: { warn: () => {} },
  };
}

describe('idempotent create of a new brew (SAVE-8)', () => {
  afterEach(() => resetNewBrewCreates());

  const creates = (h: Harness) => h.api.calls.filter((c) => c.method === 'create');
  const keyOf = (call: FakeApi['calls'][number] | undefined) => (call?.options as { idempotencyKey?: string } | undefined)?.idempotencyKey;
  const created = (body: unknown) => brewForEdit({ editId: 'new-1', version: 1, doc: (body as { doc: JSONContent }).doc });
  const bodyText = (call: FakeApi['calls'][number] | undefined) => docText((call?.body as { doc?: unknown } | undefined)?.doc);

  it('a POST without an answer is sent again exactly, with the same key; what was typed since is PUT after it', async () => {
    let call = 0;
    const api = fakeApi({ createBrew: (body) => (++call === 1 ? Promise.reject(networkError()) : Promise.resolve(created(body))) });
    const h = setup({ editId: null, baseVersion: null, api });
    typeText(h.editor, ' one');
    await advance(3000);
    expect(h.status()).toBe('offline');
    const key = keyOf(creates(h)[0]);
    expect(key).toMatch(/^[\w-]{16,}$/);
    // The draft keeps the chain for a page that loads it (reload, "New brew").
    const draft = h.drafts.map.get('new')!;
    expect(draft).toMatchObject({ createKey: key, pendingVersion: null });
    expect(docText(draft.pending?.doc)).toContain('Hello one"');

    typeText(h.editor, ' two');
    await advance(2000); // the retry
    expect(creates(h)).toHaveLength(2);
    expect(keyOf(creates(h)[1])).toBe(key);
    expect(creates(h)[1]!.body).toEqual(creates(h)[0]!.body);
    expect(h.controller.getState()).toMatchObject({ editId: 'new-1', baseVersion: 1, unsaved: true });
    expect(texts(h.editor)).toEqual(['Hello one two']); // the replayed body isn't applied over newer text

    await advance(3000);
    expect(h.saves()).toHaveLength(1);
    expect(h.saves()[0]).toMatchObject({ baseVersion: 1 });
    expect(docText(h.saves()[0]!.doc)).toContain('Hello one two');
    expect(h.status()).toBe('saved');
    expect(h.drafts.map.has('new')).toBe(false);
  });

  it('a timeout and a 503 keep the chain too', async () => {
    let call = 0;
    const api = fakeApi({
      createBrew: (body) => {
        call++;
        if (call === 1) return new Promise(() => {});
        if (call === 2) return Promise.reject(httpError(503));
        return Promise.resolve(created(body));
      },
    });
    const h = setup({ editId: null, baseVersion: null, api, retryDelaysMs: [1000] });
    typeText(h.editor, ' new');
    await advance(3000 + SAVE_TIMEOUT_MS);
    expect(h.status()).toBe('offline');
    await advance(1000);
    expect(h.status()).toBe('error');
    await advance(1000);
    expect(creates(h)).toHaveLength(3);
    expect(new Set(creates(h).map(keyOf)).size).toBe(1);
    expect(creates(h)[2]!.body).toEqual(creates(h)[0]!.body);
    expect(h.controller.getState()).toMatchObject({ status: 'saved', editId: 'new-1' });
  });

  it('a refused POST (400) is not sent again: the next one sends the changes as they are, with the same key; a 422 starts a new key', async () => {
    let call = 0;
    const api = fakeApi({
      createBrew: (body) => {
        call++;
        if (call === 1) return Promise.reject(httpError(400, { errors: { doc: ['bad'] } }));
        if (call === 2) return Promise.reject(httpError(422));
        return Promise.resolve(created(body));
      },
    });
    const h = setup({ editId: null, baseVersion: null, api });
    typeText(h.editor, ' a');
    await advance(3000);
    expect(h.status()).toBe('error');
    expect(h.drafts.map.get('new')).toMatchObject({ pending: null });
    typeText(h.editor, ' b');
    await advance(3000);
    typeText(h.editor, ' c');
    await advance(3000);
    const [first, second, third] = creates(h);
    expect(bodyText(second)).toContain('Hello a b"');
    expect(keyOf(second)).toBe(keyOf(first));
    expect(keyOf(third)).not.toBe(keyOf(second));
    expect(bodyText(third)).toContain('Hello a b c"');
    expect(h.controller.getState()).toMatchObject({ status: 'saved', editId: 'new-1' });
  });

  it('401: the key and the body wait for the sign-in, then go again unchanged', async () => {
    let call = 0;
    const api = fakeApi({ createBrew: (body) => (++call === 1 ? Promise.reject(httpError(401)) : Promise.resolve(created(body))) });
    const h = setup({ editId: null, baseVersion: null, api });
    typeText(h.editor, ' a');
    await advance(3000);
    expect(h.status()).toBe('signedOut');
    typeText(h.editor, ' b');
    h.controller.retry();
    await advance(0);
    expect(creates(h)).toHaveLength(2);
    expect(keyOf(creates(h)[1])).toBe(keyOf(creates(h)[0]));
    expect(creates(h)[1]!.body).toEqual(creates(h)[0]!.body);
    await advance(3000);
    expect(docText(h.saves()[0]?.doc)).toContain('Hello a b');
  });

  it('a chain loaded from the draft: its unanswered POST goes first, with its key; then the page is PUT', async () => {
    const pending = { doc: docOf('Sent before'), style: '.a{}', snippets: null, meta: { title: 'T' } };
    const h = setup({
      editId: null,
      baseVersion: null,
      content: docOf('Sent before and after'),
      createChain: { key: 'chain-key', pending, docSchemaVersion: DOC_SCHEMA_VERSION },
    });
    typeText(h.editor, '!');
    await advance(3000);
    expect(keyOf(creates(h)[0])).toBe('chain-key');
    expect(creates(h)[0]!.body).toEqual({ ...pending, docSchemaVersion: DOC_SCHEMA_VERSION });
    await advance(3000);
    expect(docText(h.saves()[0]?.doc)).toContain('Sent before and after!');
    expect(h.status()).toBe('saved');
  });

  it('a chain without an unanswered POST sends the page with its key; a new brew after that gets a new key', async () => {
    const h = setup({ editId: null, baseVersion: null, createChain: { key: 'chain-key', pending: null, docSchemaVersion: DOC_SCHEMA_VERSION } });
    typeText(h.editor, ' now');
    await advance(3000);
    expect(keyOf(creates(h)[0])).toBe('chain-key');
    expect(bodyText(creates(h)[0])).toContain('Hello now');
    h.controller.setSession(null, null);
    typeText(h.editor, '!');
    await advance(3000);
    expect(creates(h)).toHaveLength(2);
    expect(keyOf(creates(h)[1])).not.toBe('chain-key');
  });

  it('an existing brew ignores a chain, and "Save mine as a copy" sends no key', async () => {
    const api = fakeApi({ saveBrew: () => Promise.reject(conflictError(3)) });
    const h = setup({ api, createChain: { key: 'chain-key', pending: null, docSchemaVersion: DOC_SCHEMA_VERSION } });
    typeText(h.editor, 'x');
    await advance(3000);
    await h.controller.saveAsCopy();
    expect(creates(h)).toHaveLength(1);
    expect(keyOf(creates(h)[0])).toBeUndefined();
    expect(h.drafts.map.get('new')).toBeUndefined();
  });

  it('the create signal: pending while the POST runs, created once the draft is gone, failed once the draft keeps it', async () => {
    const first = deferred<ReturnType<typeof brewForEdit>>();
    const h = setup({ editId: null, baseVersion: null, api: fakeApi({ createBrew: () => first.promise }) });
    typeText(h.editor, ' new');
    await advance(3000);
    const [running] = pendingNewBrewCreates();
    expect(running).toMatchObject({ key: keyOf(creates(h)[0]), status: 'pending' });
    const draft = h.drafts.map.get('new')!;
    first.reject(networkError());
    await running!.settled;
    expect(running!.status).toBe('failed');
    expect(h.drafts.map.get('new')?.pending).not.toBeNull();
    expect(createdFromDraft(draft)).toBeNull();

    const second = deferred<ReturnType<typeof brewForEdit>>();
    h.controller.update({ ...optionsOf(h), editId: null, baseVersion: null, api: fakeApi({ createBrew: () => second.promise }) });
    h.controller.retry();
    await advance(0);
    const [again] = pendingNewBrewCreates();
    second.resolve(brewForEdit({ editId: 'new-1', version: 1, doc: docOf('Hello new') }));
    await again!.settled;
    expect(again).toMatchObject({ status: 'created', editId: 'new-1' });
    expect(h.drafts.map.has('new')).toBe(false); // deleted before the signal
    expect(createdFromDraft(draft)).toBe(again);
    expect(pendingNewBrewCreates()).toEqual([]);
  });

  it('drafts carry their owner (SAVE-12), who stays when the session is gone', async () => {
    const h = setup({ editId: null, baseVersion: null, signedOut: true, ownerId: null });
    typeText(h.editor, 'a');
    await advance(1000);
    expect(h.drafts.map.get('new')?.ownerId).toBeNull();
    const withOwner = (ownerId: string | null): AutosaveOptions => ({ ...optionsOf(h), editId: null, baseVersion: null, signedOut: true, ownerId });
    h.controller.update(withOwner('user-a'));
    typeText(h.editor, 'b');
    await advance(1000);
    expect(h.drafts.map.get('new')?.ownerId).toBe('user-a');
    h.controller.update(withOwner(null));
    typeText(h.editor, 'c');
    await advance(1000);
    expect(h.drafts.map.get('new')).toMatchObject({ ownerId: 'user-a', createKey: null });
    expect(h.api.calls).toEqual([]);
  });
});
