// What an error page says (plan §9: 401 → sign-in prompt, 403 and 404 → error pages; 423 → the
// lock message). Built on errorPageData() from the API's error policy.
import { type ErrorPageData, errorPageData, isApiError } from '@/api';

export interface ErrorContent extends ErrorPageData {
  /** For 423: the lock's share message (the API's `detail`), shown as the reason. */
  lockReason: string | null;
  /** The request can be tried again unchanged (network, 408, 429, 5xx). */
  transient: boolean;
}

const DEFAULTS: Record<number, { title: string; message: string }> = {
  0: { title: "Can't reach the server", message: 'Check your internet connection and try again.' },
  401: { title: 'Sign in required', message: 'You need to sign in to see this page.' },
  403: { title: 'Access denied', message: "You don't have permission to open this." },
  404: { title: 'Not found', message: 'There is nothing at this address. It may have been deleted, or the link is wrong.' },
  410: { title: 'Not found', message: 'There is nothing at this address. It may have been deleted, or the link is wrong.' },
  423: { title: 'This brew is locked', message: 'The administrators have locked this brew.' },
};

const GENERIC = { title: 'Something went wrong', message: 'The page could not be loaded. Try again in a moment.' };

export function errorContent({ error, status }: { error?: unknown; status?: number }): ErrorContent {
  if (error !== undefined && error !== null) {
    const data = errorPageData(error);
    const transient = isApiError(error) && (error.kind === 'network' || error.status === 408 || error.status === 429 || error.status >= 500);
    if (data.status === 423) {
      return { ...data, title: DEFAULTS[423]!.title, message: DEFAULTS[423]!.message, lockReason: isApiError(error) ? error.detail : null, transient };
    }
    if (isApiError(error) && error.kind === 'network') {
      return { ...data, status: 0, title: DEFAULTS[0]!.title, message: data.message, lockReason: null, transient: true };
    }
    return { ...data, lockReason: null, transient };
  }
  const code = status ?? 500;
  const text = DEFAULTS[code] ?? GENERIC;
  return { status: code, title: text.title, message: text.message, code: null, lockReason: null, transient: code === 0 || code >= 500 };
}

/** A dynamic import() that failed (Chromium, Firefox and Safari word it differently). */
export function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
      error.message,
    )
  );
}
