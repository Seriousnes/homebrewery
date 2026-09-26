// State of the app's sign-in prompt (plan §9: a 401 shows a sign-in prompt). The prompt is a
// dialog (SignInPrompt.tsx, mounted once at the router root). It opens when the API layer raises
// onSignInRequired (any 401), or when a component calls openSignInPrompt(). While an inline
// sign-in form is on screen (the "Sign in required" page, the login page) the dialog stays
// closed: that form is the prompt.
import { useSyncExternalStore } from 'react';
import type { ApiError } from '@/api';

export type SignInPromptReason = 'api' | 'user';

export interface SignInPromptState {
  /** A prompt was asked for and not yet answered or dismissed. */
  requested: boolean;
  reason: SignInPromptReason;
  /** The 401 that asked for it, if any. */
  error: ApiError | null;
  /** How many inline sign-in forms are mounted. */
  inlineForms: number;
}

const INITIAL: SignInPromptState = { requested: false, reason: 'user', error: null, inlineForms: 0 };

let state: SignInPromptState = INITIAL;
const listeners = new Set<() => void>();

function update(next: Partial<SignInPromptState>): void {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

export const signInPromptStore = {
  get: (): SignInPromptState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Tests only. */
  reset: (): void => {
    update(INITIAL);
  },
};

/**
 * Ask for the sign-in dialog. A repeated request while it is open keeps the first one; a request
 * while an inline sign-in form is shown is dropped (that form is the answer).
 */
export function openSignInPrompt(reason: SignInPromptReason = 'user', error: ApiError | null = null): void {
  if (state.requested || state.inlineForms > 0) return;
  update({ requested: true, reason, error });
}

export function closeSignInPrompt(): void {
  if (state.requested) update({ requested: false, error: null });
}

/**
 * Called by an inline sign-in form while mounted; returns the cleanup. A pending dialog request
 * is dropped, because the form on the page answers it.
 */
export function registerInlineSignIn(): () => void {
  update({ inlineForms: state.inlineForms + 1, requested: false, error: null });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    update({ inlineForms: Math.max(0, state.inlineForms - 1) });
  };
}

export function useSignInPrompt(): SignInPromptState {
  return useSyncExternalStore(signInPromptStore.subscribe, signInPromptStore.get, signInPromptStore.get);
}

/**
 * The dialog opens this long after a request, so a page whose load failed with 401 can show its
 * inline sign-in form first (which cancels the request) instead of a dialog flashing over it.
 */
export const SIGN_IN_PROMPT_DELAY_MS = 150;
