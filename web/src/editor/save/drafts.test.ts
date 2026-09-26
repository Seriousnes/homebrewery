// drafts.ts: the stored draft's shape and the "Restore unsaved changes" rule (plan §9).
import { getSchema } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import {
  createDraftStore,
  draftDiffers,
  draftKey,
  draftOfferKind,
  draftOwnedBy,
  isDraft,
  readDraft,
  readDraftsFor,
  shouldOfferDraft,
} from './drafts';
import { jsonEqual } from './jsonEqual';
import { docOf, draftOf, memoryDrafts } from './testing';

const schema = getSchema(buildEditorExtensions());

describe('draft keys and shape', () => {
  it("keys drafts by editId, or 'new'", () => {
    expect(draftKey('abc')).toBe('abc');
    expect(draftKey(null)).toBe('new');
  });

  it('accepts drafts and rejects anything else in storage', async () => {
    expect(isDraft(draftOf())).toBe(true);
    expect(isDraft(draftOf({ baseVersion: null, editId: null, key: 'new' }))).toBe(true);
    expect(isDraft({ ...draftOf(), v: 2 })).toBe(false);
    expect(isDraft({ ...draftOf(), doc: { type: 'paragraph' } })).toBe(false);
    expect(isDraft({ ...draftOf(), baseVersion: '1' })).toBe(false);
    expect(isDraft('text')).toBe(false);
    const store = memoryDrafts([
      ['edit-1', draftOf()],
      ['broken', { ...draftOf(), style: 3 } as never],
    ]);
    expect(await readDraft(store, 'edit-1')).toMatchObject({ baseVersion: 1 });
    expect(await readDraft(store, 'broken')).toBeNull();
    expect(await readDraft(store, 'missing')).toBeNull();
  });

  it('a create key and an owner are strings or null (SAVE-8, SAVE-12)', () => {
    expect(isDraft(draftOf({ createKey: 'k', ownerId: 'u' }))).toBe(true);
    expect(isDraft(draftOf({ createKey: null, ownerId: null }))).toBe(true);
    expect(isDraft({ ...draftOf(), createKey: 5 })).toBe(false);
    expect(isDraft({ ...draftOf(), ownerId: {} })).toBe(false);
  });

  it("/new loads its owner's draft or an anonymous one, never another user's (SAVE-12)", () => {
    expect(draftOwnedBy(draftOf({ ownerId: 'alice' }), 'alice')).toBe(true);
    expect(draftOwnedBy(draftOf({ ownerId: 'alice' }), 'bob')).toBe(false);
    expect(draftOwnedBy(draftOf({ ownerId: 'alice' }), null)).toBe(false);
    expect(draftOwnedBy(draftOf({ ownerId: null }), 'bob')).toBe(true);
    expect(draftOwnedBy(draftOf(), null)).toBe(true); // drafts written before owners
  });
});

describe('draftDiffers', () => {
  const server = { doc: docOf('Hello world'), style: '', snippets: null, meta: { title: 'Brew', tags: ['a'], thumbnailUrl: null } };

  it('ignores key order and default attributes (jsonb reorders keys)', () => {
    const reordered = JSON.parse(JSON.stringify(docOf('Hello world'), (_k, v: unknown) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).reverse());
      return v;
    })) as object;
    expect(jsonEqual(reordered, docOf('Hello world'))).toBe(true);
    expect(draftDiffers(draftOf({ doc: reordered }), server, schema)).toBe(false);
    // The editor's JSON has every attribute; the stored one may lack defaults.
    const full = schema.nodeFromJSON(docOf('Hello world')).toJSON() as object;
    expect(draftDiffers(draftOf({ doc: full }), server, schema)).toBe(false);
  });

  it('finds differences in the document, style, snippets and meta', () => {
    expect(draftDiffers(draftOf({ doc: docOf('Hello there') }), server, schema)).toBe(true);
    expect(draftDiffers(draftOf({ style: '.page { color: red }' }), server, schema)).toBe(true);
    expect(draftDiffers(draftOf({ snippets: [{ name: 'x' }] }), server, schema)).toBe(true);
    expect(draftDiffers(draftOf({ meta: { title: 'Renamed' } }), server, schema)).toBe(true);
    expect(draftDiffers(draftOf({ meta: { tags: ['a', 'b'] } }), server, schema)).toBe(true);
  });

  it('treats null meta fields as "keep", empty strings as null, and skips authors', () => {
    expect(draftDiffers(draftOf({ meta: { title: null, tags: ['a'], thumbnailUrl: '', authors: ['someone'] } }), server, schema)).toBe(false);
    expect(draftDiffers(draftOf({ snippets: undefined }), server, schema)).toBe(false);
  });

  it('compares only what the baseline has', () => {
    expect(draftDiffers(draftOf({ style: 'x' }), { doc: docOf('Hello world') }, schema)).toBe(false);
  });

  it('counts an unreadable document as different', () => {
    expect(draftDiffers(draftOf({ doc: { type: 'doc', content: [{ type: 'nope' }] } }), server, schema)).toBe(true);
  });
});

describe('shouldOfferDraft', () => {
  const baseline = { doc: docOf('Hello') };

  it('offers a differing draft made on the loaded version', () => {
    expect(shouldOfferDraft(draftOf({ baseVersion: 4 }), 4, baseline, schema)).toBe(true);
  });

  it('never offers a draft made on another version, or one with nothing new', () => {
    expect(shouldOfferDraft(draftOf({ baseVersion: 3 }), 4, baseline, schema)).toBe(false);
    expect(shouldOfferDraft(draftOf({ baseVersion: 5 }), 4, baseline, schema)).toBe(false);
    expect(shouldOfferDraft(draftOf({ baseVersion: 4, doc: docOf('Hello') }), 4, baseline, schema)).toBe(false);
  });

  it('offers a draft whose in-flight save produced the loaded version (tab closed mid-save)', () => {
    const sent = { doc: docOf('Hello'), style: '', snippets: null, meta: null };
    expect(shouldOfferDraft(draftOf({ baseVersion: 3, pendingVersion: 4, pending: sent }), 4, baseline, schema)).toBe(true);
    // …but not when that save sent everything the draft has.
    expect(shouldOfferDraft(draftOf({ baseVersion: 3, pendingVersion: 4, pending: sent, doc: docOf('Hello') }), 4, baseline, schema)).toBe(false);
  });

  it("matches a new brew's draft (baseVersion null) only to a new brew", () => {
    const fresh = draftOf({ key: 'new', editId: null, baseVersion: null });
    expect(shouldOfferDraft(fresh, null, baseline, schema)).toBe(true);
    expect(shouldOfferDraft(fresh, 1, baseline, schema)).toBe(false);
  });
});

describe('draftOfferKind: restore, conflict or nothing (SAVE-1, SAVE-2)', () => {
  const baseline = { doc: docOf('Hello'), style: '', snippets: null };

  it('a differing draft on the loaded version is a plain restore', () => {
    expect(draftOfferKind(draftOf({ baseVersion: 4 }), 4, baseline, schema)).toBe('restore');
  });

  it('a draft on an older (or newer) version is a conflict, never dropped', () => {
    expect(draftOfferKind(draftOf({ baseVersion: 3 }), 4, baseline, schema)).toBe('conflict');
    expect(draftOfferKind(draftOf({ baseVersion: 5 }), 4, baseline, schema)).toBe('conflict');
    expect(shouldOfferDraft(draftOf({ baseVersion: 3 }), 4, baseline, schema)).toBe(false);
  });

  it('a draft written in conflict stays a conflict, even on the loaded version', () => {
    expect(draftOfferKind(draftOf({ baseVersion: 4, conflict: true }), 4, baseline, schema)).toBe('conflict');
    expect(shouldOfferDraft(draftOf({ baseVersion: 4, conflict: true }), 4, baseline, schema)).toBe(false);
  });

  it('pendingVersion counts only when the server holds exactly what that save sent', () => {
    const sent = { doc: docOf('Hello sent'), style: '', snippets: null, meta: null };
    const draft = draftOf({ baseVersion: 3, pendingVersion: 4, pending: sent, doc: docOf('Hello sent and more') });
    expect(draftOfferKind(draft, 4, { ...baseline, doc: docOf('Hello sent') }, schema)).toBe('restore');
    expect(draftOfferKind(draft, 4, { ...baseline, doc: docOf('Hello from another tab') }, schema)).toBe('conflict');
    // Without the sent content (an older draft) the match can't be checked.
    expect(draftOfferKind({ ...draft, pending: undefined }, 4, { ...baseline, doc: docOf('Hello sent') }, schema)).toBe('conflict');
  });

  it('nothing to offer when the draft holds nothing new', () => {
    expect(draftOfferKind(draftOf({ baseVersion: 2, doc: docOf('Hello') }), 4, baseline, schema)).toBeNull();
  });
});

describe('per-session keys (SAVE-10)', () => {
  it("keys an edit session's draft by editId and session; 'new' stays one key", () => {
    expect(draftKey('abc', 's1')).toBe('abc:s1');
    expect(draftKey(null, 's1')).toBe('new');
  });

  it("reads every stored draft of a brew (any session's, older formats too), newest first", async () => {
    const store = memoryDrafts([
      ['abc', draftOf({ key: 'abc', editId: 'abc', updatedAt: 1 })],
      ['abc:s2', draftOf({ key: 'abc:s2', editId: 'abc', updatedAt: 3 })],
      ['abcd:s1', draftOf({ key: 'abcd:s1', editId: 'abcd', updatedAt: 2 })],
      ['new', draftOf({ key: 'new', editId: null, baseVersion: null })],
      ['junk', { v: 7 } as never],
    ]);
    expect((await readDraftsFor(store, 'abc')).map((d) => d.key)).toEqual(['abc:s2', 'abc']);
    expect((await readDraftsFor(store, null)).map((d) => d.key)).toEqual(['new']);
  });

  it('accepts the new optional fields and rejects broken ones', () => {
    expect(isDraft(draftOf({ pending: { doc: docOf('x'), style: '', snippets: null, meta: null }, conflict: true }))).toBe(true);
    expect(isDraft({ ...draftOf(), pending: { doc: 'nope' } })).toBe(false);
    expect(isDraft({ ...draftOf(), conflict: 'yes' })).toBe(false);
  });
});

describe('createDraftStore when IndexedDB fails (SAVE-11)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to memory for the page, and says so', async () => {
    // Firefox with site data blocked: indexedDB exists, open() throws.
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    const store = createDraftStore();
    await store.set('new', draftOf({ key: 'new', editId: null, baseVersion: null }));
    expect(await readDraft(store, 'new')).toMatchObject({ key: 'new' });
    expect((await store.entries()).map(([key]) => key)).toEqual(['new']);
    expect(store.persistent?.()).toBe(false);
  });
});
