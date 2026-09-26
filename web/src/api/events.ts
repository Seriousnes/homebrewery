// App-wide API events. A 401 anywhere asks the app to show its sign-in prompt (plan §9); the
// component that owns that prompt subscribes with onSignInRequired.
import type { ApiError } from './errors';

export interface SignInRequiredEvent {
  /** The 401 that caused it; null when requested directly (e.g. a "Sign in to save" button). */
  error: ApiError | null;
}

type Listener = (event: SignInRequiredEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to sign-in prompts. Returns the unsubscribe function. */
export function onSignInRequired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask the app to show its sign-in prompt. Listener errors are reported, never thrown. */
export function requestSignIn(error: ApiError | null = null): void {
  for (const listener of [...listeners]) {
    try {
      listener({ error });
    } catch (listenerError) {
      console.error('[api] sign-in listener failed', listenerError);
    }
  }
}
