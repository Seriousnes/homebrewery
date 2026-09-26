// /new remembers, per browser tab, that a signed-out visitor was working on the draft (P7.2: "a
// draft survives the sign-in redirect"). When the visitor comes back signed in, that draft is saved
// at once; a draft left over from another time is only shown (it is saved on the next edit, or
// discarded with "Start over"), so an old draft never turns into a brew by itself.

export const SIGN_IN_HANDOFF_KEY = 'hb-new-awaiting-sign-in';

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): SessionStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null; // blocked storage
  }
}

/** A signed-out visitor is on /new: its draft waits for them to sign in. */
export function markAwaitingSignIn(store: SessionStore | null = sessionStore()): void {
  try {
    store?.setItem(SIGN_IN_HANDOFF_KEY, '1');
  } catch {
    // Quota or blocked storage: the draft is then shown, not saved at once.
  }
}

/** Whether a signed-out visit of /new is waiting for this sign-in (read once: it is cleared). */
export function takeAwaitingSignIn(store: SessionStore | null = sessionStore()): boolean {
  try {
    const waiting = store?.getItem(SIGN_IN_HANDOFF_KEY) === '1';
    store?.removeItem(SIGN_IN_HANDOFF_KEY);
    return waiting;
  } catch {
    return false;
  }
}

/**
 * Save a draft loaded on /new as soon as someone is signed in? Yes for a signed-out visitor (they
 * may sign in on this page), and for a signed-in one who comes back from signing in.
 */
export function saveLoadedDraft(hasDraft: boolean, signedIn: boolean, takeHandoff: () => boolean = takeAwaitingSignIn): boolean {
  if (!signedIn) return hasDraft;
  // Read (and clear) the hand-off even without a draft, so it can't apply to a later visit.
  const waiting = takeHandoff();
  return hasDraft && waiting;
}
