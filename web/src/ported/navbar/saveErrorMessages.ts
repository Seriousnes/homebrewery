// What ErrorNavItem says for a failed request (port of the cases in legacy
// client/homebrew/navbar/error-navitem.jsx, mapped from upstream's HBErrorCodes to this API's
// statuses). Google Drive cases are gone; 412 (client out of date) has no counterpart.
import { describeApiError, isAbortError, isApiError } from '@/api';

/** Buttons the panel offers: sign in, reload the page, try again (when a retry is given), report. */
export type SaveErrorAction = 'signIn' | 'reload' | 'retry' | 'report';

export interface SaveErrorDescription {
  /** One sentence or two, shown in the panel. */
  message: string;
  actions: SaveErrorAction[];
}

export function describeSaveError(error: unknown): SaveErrorDescription {
  if (isAbortError(error)) return { message: 'The request was cancelled.', actions: ['retry'] };
  if (!isApiError(error)) {
    return { message: 'Looks like there was a problem saving.', actions: ['retry', 'report'] };
  }
  if (error.kind === 'network') {
    return {
      message:
        'The request to the server was interrupted or timed out. This can happen because of a network problem, ' +
        'or when saving a very large brew. Check your internet connection and try again.',
      actions: ['retry'],
    };
  }
  switch (error.status) {
    case 401:
      return {
        message: "You're no longer signed in. Were you signed out in another window? Sign in, then try again.",
        actions: ['signIn'],
      };
    case 403:
      return {
        message: error.detail ?? "You can't save this brew: you're not one of its authors any more.",
        actions: ['reload'],
      };
    case 404:
    case 410:
      return { message: "This brew doesn't exist any more. It may have been deleted.", actions: [] };
    case 409:
      return {
        message: 'Someone saved a newer version of this brew. Reload the page to get the latest changes.',
        actions: ['reload'],
      };
    case 413:
      return { message: error.detail ?? 'This brew is too large to save.', actions: ['report'] };
    case 423:
      return {
        message: error.detail ? `This brew is locked: ${error.detail}` : 'This brew is locked.',
        actions: [],
      };
    case 429:
      return { message: describeApiError(error), actions: ['retry'] };
    default:
      break;
  }
  if (error.hasFieldErrors) {
    return { message: `The brew couldn't be saved: ${describeApiError(error)}`, actions: ['report'] };
  }
  if (error.status >= 500) {
    return { message: 'The server had a problem saving. Try again in a moment.', actions: ['retry', 'report'] };
  }
  return { message: `Looks like there was a problem saving: ${describeApiError(error)}`, actions: ['report'] };
}

/** Plain-text details for a bug report (no request or response bodies). */
export function errorReport(error: unknown): string {
  if (!isApiError(error)) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const lines = [
    `Status: ${error.status === 0 ? 'no response' : error.status} ${error.title}`,
    error.method || error.url ? `Request: ${error.method ?? ''} ${error.url ?? ''}`.trim() : '',
    error.detail ? `Detail: ${error.detail}` : '',
    ...Object.entries(error.errors).map(([field, messages]) => `${field}: ${messages.join(' ')}`),
  ];
  return lines.filter(Boolean).join('\n');
}
