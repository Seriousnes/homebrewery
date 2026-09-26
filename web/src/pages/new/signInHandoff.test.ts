import { describe, expect, it, vi } from 'vitest';
import { markAwaitingSignIn, saveLoadedDraft, SIGN_IN_HANDOFF_KEY, takeAwaitingSignIn } from './signInHandoff';

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe('sign-in hand-off of the /new draft', () => {
  it('is set by a signed-out visit and read once', () => {
    const store = memoryStore();
    expect(takeAwaitingSignIn(store)).toBe(false);
    markAwaitingSignIn(store);
    expect(store.map.get(SIGN_IN_HANDOFF_KEY)).toBe('1');
    expect(takeAwaitingSignIn(store)).toBe(true);
    expect(takeAwaitingSignIn(store)).toBe(false);
  });

  it('survives blocked storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => markAwaitingSignIn(broken)).not.toThrow();
    expect(takeAwaitingSignIn(broken)).toBe(false);
    expect(takeAwaitingSignIn(null)).toBe(false);
  });

  it('saves a loaded draft at once for a signed-out visitor, or right after their sign-in', () => {
    const take = vi.fn(() => true);
    expect(saveLoadedDraft(true, false, take)).toBe(true);
    expect(saveLoadedDraft(false, false, take)).toBe(false);
    expect(take).not.toHaveBeenCalled();
    expect(saveLoadedDraft(true, true, take)).toBe(true);
    // A leftover draft for someone signed in: shown, saved on the next edit.
    expect(saveLoadedDraft(true, true, () => false)).toBe(false);
    // No draft: the hand-off is still consumed.
    const consumed = vi.fn(() => true);
    expect(saveLoadedDraft(false, true, consumed)).toBe(false);
    expect(consumed).toHaveBeenCalledTimes(1);
  });
});
