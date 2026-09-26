// What a deliberate sign-out (navbar account menu, account page) does beyond the API call:
// pages with unsaved work get to save it first (an editor's pending autosave would otherwise land
// after the session ended and stay only in this browser's draft), and pages that show private
// data learn that the user signed out, as opposed to a session that expired (a 401), after which
// the editor keeps the work on the page for "Sign in to save".

type BeforeSignOut = () => unknown;

const beforeHooks = new Set<BeforeSignOut>();
const signedOutListeners = new Set<() => void>();

/** How long a sign-out waits for pending saves before it goes ahead anyway. */
export const SIGN_OUT_SAVE_TIMEOUT_MS = 5000;

/** Run `hook` (and wait for its promise) before the logout request. Returns the cleanup. */
export function registerBeforeSignOut(hook: BeforeSignOut): () => void {
  beforeHooks.add(hook);
  return () => {
    beforeHooks.delete(hook);
  };
}

/** Every registered hook, settled or timed out (failures are ignored: signing out goes on). */
export async function runBeforeSignOut(timeoutMs = SIGN_OUT_SAVE_TIMEOUT_MS): Promise<void> {
  if (beforeHooks.size === 0) return;
  // A hook that throws at once counts as settled, like one whose promise rejects.
  const all = Promise.allSettled([...beforeHooks].map((hook) => Promise.resolve().then(hook)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([all, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** `listener` runs after each deliberate sign-out. Returns the cleanup. */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => {
    signedOutListeners.delete(listener);
  };
}

export function notifySignedOut(): void {
  for (const listener of [...signedOutListeners]) listener();
}
