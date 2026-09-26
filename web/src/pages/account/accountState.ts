import { classifyApiError, describeApiError, isApiError } from '@/api';
import { safeReturnTo } from '@/app/paths';

/** Router state /register passes to /account for a new account. */
export interface AccountWelcomeState {
  welcome: true;
  /** Where the user was going before registering. */
  returnTo: string | null;
}

export function readWelcomeState(state: unknown): AccountWelcomeState | null {
  if (!state || typeof state !== 'object' || (state as { welcome?: unknown }).welcome !== true) return null;
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  return { welcome: true, returnTo: typeof returnTo === 'string' ? safeReturnTo(returnTo, '') || null : null };
}

/** Same rules as the server's Handles.Rules (shown as the field hint). */
export const HANDLE_RULES = "3 to 32 characters: lower-case letters a-z, digits, '-' and '_'.";

/**
 * The message the handle field shows for a failed change, or null when the error policy handles
 * it (401 opens the sign-in prompt; network and server errors toast with Retry).
 */
export function handleErrorMessage(error: unknown): string | null {
  if (classifyApiError(error) !== 'caller' || !isApiError(error)) return null;
  if (error.status === 409) return error.detail ?? 'That handle is already taken. Choose another one.';
  return error.fieldError('handle') ?? describeApiError(error);
}
