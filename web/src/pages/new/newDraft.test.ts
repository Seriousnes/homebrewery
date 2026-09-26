// Which 'new' draft /new loads (newDraft.ts): "Start over", newer editors, the create signal
// (SAVE-8) and the draft's owner (SAVE-12).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOC_SCHEMA_VERSION } from '@/editor/schema/version';
import { resetNewBrewCreates, trackNewBrewCreate } from '@/editor/save/newBrewCreates';
import { draftOf } from '@/editor/save/testing';
import { chooseNewDraft, waitForRunningCreates } from './newDraft';

afterEach(() => {
  resetNewBrewCreates();
  vi.useRealTimers();
});

const newDraft = draftOf({ key: 'new', editId: null, baseVersion: null, updatedAt: 5000 });
const context = { discardedAt: null, userId: 'alice' };

describe('chooseNewDraft', () => {
  it('loads the draft', () => {
    expect(chooseNewDraft(newDraft, context)).toEqual({ draft: newDraft, withheld: null, reason: 'loaded' });
    expect(chooseNewDraft(null, context)).toEqual({ draft: null, withheld: null, reason: 'none' });
  });

  it('skips a draft written before "Start over", and one from a newer editor', () => {
    expect(chooseNewDraft(newDraft, { ...context, discardedAt: 5000 }).reason).toBe('discarded');
    expect(chooseNewDraft(newDraft, { ...context, discardedAt: 4999 }).reason).toBe('loaded');
    expect(chooseNewDraft({ ...newDraft, docSchemaVersion: DOC_SCHEMA_VERSION + 1 }, context).reason).toBe('newer');
  });

  it('skips a draft this tab turned into a brew (the create signal)', () => {
    trackNewBrewCreate('k1', 6000).created('brew-1');
    expect(chooseNewDraft(newDraft, context)).toEqual({ draft: null, withheld: null, reason: 'created' });
    expect(chooseNewDraft({ ...newDraft, updatedAt: 7000 }, context).reason).toBe('loaded');
    expect(chooseNewDraft({ ...newDraft, updatedAt: 7000, createKey: 'k1' }, context).reason).toBe('created');
  });

  it("withholds another user's draft, and a signed-in user's from an anonymous visitor", () => {
    const alices = { ...newDraft, ownerId: 'alice' };
    expect(chooseNewDraft(alices, context).reason).toBe('loaded');
    expect(chooseNewDraft(alices, { ...context, userId: 'bob' })).toEqual({ draft: null, withheld: alices, reason: 'otherUser' });
    expect(chooseNewDraft(alices, { ...context, userId: null })).toEqual({ draft: null, withheld: alices, reason: 'otherUser' });
    expect(chooseNewDraft({ ...newDraft, ownerId: null }, { ...context, userId: 'bob' }).reason).toBe('loaded');
  });
});

describe('waitForRunningCreates', () => {
  it('returns at once when nothing runs', async () => {
    expect(await waitForRunningCreates()).toBe(false);
  });

  it('waits for every running create, or for the timeout', async () => {
    vi.useFakeTimers();
    const a = trackNewBrewCreate('a', 1);
    const b = trackNewBrewCreate('b', 2);
    let done = false;
    const waiting = waitForRunningCreates(10_000).then(() => (done = true));
    a.created('brew-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    b.failed();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await waiting;

    trackNewBrewCreate('c', 3); // never answers
    const timedOut = waitForRunningCreates(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await timedOut).toBe(true);
  });
});
