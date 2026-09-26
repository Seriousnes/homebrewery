// Central error policy (plan §9): 401 → sign-in prompt, 403/404 (and 423 locks) → error page data,
// 409 → the caller (autosave's conflict dialog, "handle taken"), everything else → a toast with a
// retry. TanStack Query's caches call applyErrorPolicy for every failed query and mutation (see
// web/src/app/queryClient.ts); a query or mutation opts out with meta { errorPolicy: 'manual' }.
import { type ApiError, isAbortError, isApiError } from './errors';
import { requestSignIn } from './events';

/** What the policy does with an error. */
export type ErrorHandling = 'signIn' | 'errorPage' | 'caller' | 'toast';

/** 'auto' (default): apply this policy. 'manual': the caller handles every error itself. */
export type ErrorPolicy = 'auto' | 'manual';

/** `meta` understood by the policy on queries and mutations (typed through TanStack's Register). */
export interface ApiRequestMeta {
  errorPolicy?: ErrorPolicy;
  /** Toast title for this request's failures, e.g. "Couldn't delete the brew". */
  errorTitle?: string;
  [key: string]: unknown;
}

export function classifyApiError(error: unknown): ErrorHandling {
  if (!isApiError(error)) return 'toast';
  switch (error.status) {
    case 401:
      return 'signIn';
    case 403:
    case 404:
    case 410:
    case 423:
      return 'errorPage';
    case 409:
      return 'caller';
    case 400:
    case 422:
      // Field errors belong next to the fields (forms, the inspector); bare 400s are toasts.
      return error.hasFieldErrors ? 'caller' : 'toast';
    default:
      return 'toast';
  }
}

/** Errors worth retrying unchanged: no response, 408, 429, 502, 503, 504, other 5xx except 501. */
export function isTransientError(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.kind === 'network') return true;
  const s = error.status;
  return s === 408 || s === 429 || (s >= 500 && s !== 501);
}

/** TanStack `retry` for queries: transient errors, at most twice; a long Retry-After is not waited for. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2 || !isTransientError(error)) return false;
  const retryAfter = isApiError(error) ? error.retryAfter : null;
  return retryAfter == null || retryAfter <= MAX_RETRY_AFTER_S;
}

const MAX_RETRY_AFTER_S = 10;

/** TanStack `retryDelay`: Retry-After when given, else 1 s, 2 s, 4 s … up to 8 s. */
export function retryDelay(attempt: number, error: unknown): number {
  const retryAfter = isApiError(error) ? error.retryAfter : null;
  if (retryAfter != null) return Math.min(retryAfter, MAX_RETRY_AFTER_S) * 1000;
  return Math.min(1000 * 2 ** attempt, 8000);
}

/** What an error page shows for a failed page load (P7 pages render it from `query.error`). */
export interface ErrorPageData {
  status: number;
  title: string;
  message: string;
  /** Lock reason code for 423. */
  code: number | null;
}

export function errorPageData(error: unknown): ErrorPageData {
  if (!isApiError(error)) {
    return { status: 0, title: 'Something went wrong', message: describeApiError(error), code: null };
  }
  const page = (title: string, fallback: string): ErrorPageData => ({
    status: error.status,
    title,
    message: error.detail ?? fallback,
    code: error.code,
  });
  switch (error.status) {
    case 401:
      return page('Sign in required', 'Sign in to see this page.');
    case 403:
      return page('Access denied', "You don't have permission to open this.");
    case 404:
    case 410:
      return page(error.title !== 'Not Found' ? error.title : 'Not found', 'There is nothing at this address. It may have been deleted, or the link is wrong.');
    case 423:
      return page(error.title, 'This brew is locked.');
    default:
      return page(error.kind === 'network' ? error.title : 'Something went wrong', describeApiError(error));
  }
}

/** One sentence for a toast or an inline message. */
export function describeApiError(error: unknown): string {
  if (isAbortError(error)) return 'The request was cancelled.';
  if (!isApiError(error)) return error instanceof Error && error.message ? error.message : 'Something went wrong.';
  if (error.kind === 'network') return error.detail ?? 'Could not reach the server.';
  if (error.status === 429) {
    return error.retryAfter != null
      ? `Too many requests. Try again in ${error.retryAfter} s.`
      : 'Too many requests. Wait a moment and try again.';
  }
  if (error.status === 413) return error.detail ?? 'This is too large to send.';
  if (error.hasFieldErrors) {
    const first = Object.values(error.errors)[0]?.[0];
    if (first) return first;
  }
  if (error.status >= 500) return error.detail ?? 'The server had a problem. Try again.';
  return error.detail ?? error.title;
}

/** The toast the policy asks for (structurally a ToastInput of web/src/ui). */
export interface ErrorToast {
  id?: string;
  title: string;
  description: string;
  tone: 'error';
  action?: { label: string; onAction: () => void };
  /** null: stays until dismissed. */
  duration?: number | null;
}

export interface ErrorPolicyContext {
  source: 'query' | 'mutation';
  meta?: ApiRequestMeta | Record<string, unknown>;
  /** Stable key (a query hash) so repeated failures replace one toast instead of stacking. */
  key?: string;
  /** Runs the request again (refetch, or re-execute the mutation). */
  retry?: () => void;
  notify: (toast: ErrorToast) => void;
  /** Default: requestSignIn (web/src/api/events.ts). */
  onSignIn?: (error: ApiError) => void;
}

export const ERROR_TOAST_DURATION_MS = 8000;

/** The id of the toast the policy raises for a request key (so a later success can remove it). */
export function errorToastId(key: string): string {
  return `api:${key}`;
}

/**
 * Apply the policy to one failed request. Returns what was done, or 'ignored' for cancellations
 * and requests with meta.errorPolicy 'manual'.
 */
export function applyErrorPolicy(error: unknown, ctx: ErrorPolicyContext): ErrorHandling | 'ignored' {
  if (isAbortError(error)) return 'ignored';
  const meta = (ctx.meta ?? {}) as ApiRequestMeta;
  if (meta.errorPolicy === 'manual') return 'ignored';
  const handling = classifyApiError(error);
  const title = typeof meta.errorTitle === 'string' && meta.errorTitle
    ? meta.errorTitle
    : ctx.source === 'query' ? "Couldn't load data" : "Couldn't complete that";
  const toastId = ctx.key ? errorToastId(ctx.key) : undefined;
  switch (handling) {
    case 'signIn':
      (ctx.onSignIn ?? requestSignIn)(error as ApiError);
      return handling;
    case 'errorPage':
      // A failed page load renders errorPageData(query.error); a failed action can't, so it toasts.
      if (ctx.source === 'mutation') {
        ctx.notify({ id: toastId, title, description: describeApiError(error), tone: 'error', duration: ERROR_TOAST_DURATION_MS });
      }
      return handling;
    case 'caller':
      return handling;
    case 'toast': {
      const retry = ctx.retry && isTransientError(error) ? ctx.retry : undefined;
      ctx.notify({
        id: toastId,
        title,
        description: describeApiError(error),
        tone: 'error',
        ...(retry ? { action: { label: 'Retry', onAction: retry }, duration: null } : { duration: ERROR_TOAST_DURATION_MS }),
      });
      return handling;
    }
  }
}
