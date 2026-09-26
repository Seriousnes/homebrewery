// Messages for what can go wrong on /import (P6.1): the upstream download (GET
// /api/import/homebrewery/{shareId}: 400, 401, 404, 413, 429, 502 with upstreamStatus), the
// conversion (legacy renderer) and creating the brew (POST /api/brews).
import { isApiError } from '@/api';
import { formatBytes, MAX_IMPORT_BYTES } from './readTextFile';

export interface ImportProblem {
  title: string;
  message: string;
  /** Worth trying again later (network, 429, upstream trouble). */
  retry?: boolean;
}

/** HTTP statuses upstream answers for its own reasons; any other code is taken for a lock code. */
const HTTP_ERRORS = new Set([400, 401, 403, 405, 406, 408, 409, 410, 413, 414, 415, 422, 429]);

function seconds(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return 'in a minute';
  const s = Math.ceil(value);
  return s < 60 ? `in ${s} ${s === 1 ? 'second' : 'seconds'}` : `in ${Math.ceil(s / 60)} ${Math.ceil(s / 60) === 1 ? 'minute' : 'minutes'}`;
}

/** Why upstream refused (502 with upstreamStatus), in words. */
export function upstreamStatusMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `The Homebrewery refused the download (error ${status}). The brew may be private or locked.`;
  }
  if (status >= 500 && status <= 599) {
    return `The Homebrewery answered with error ${status}: it may be having problems, or the brew may be locked. Try again later.`;
  }
  if (HTTP_ERRORS.has(status)) return `The Homebrewery answered with error ${status}, so the brew could not be downloaded.`;
  return `The Homebrewery answered with code ${status}, which means the brew is locked by its moderators. Locked brews can’t be downloaded.`;
}

/** The message for a failed download from the Homebrewery. */
export function upstreamErrorProblem(error: unknown): ImportProblem {
  const title = 'Couldn’t download the brew';
  if (!isApiError(error)) return { title, message: 'Something went wrong. Try again.', retry: true };
  if (error.kind === 'network') return { title, message: 'Can’t reach the server. Check your connection and try again.', retry: true };
  switch (error.status) {
    case 400:
      return { title, message: 'That isn’t a Homebrewery share id. Share ids have 10 to 14 letters, digits, - or _.' };
    case 401:
      return { title, message: 'Sign in to download brews from the Homebrewery.' };
    case 404:
      return { title, message: 'The Homebrewery has no brew with this share id. Check the link; the brew may have been deleted.' };
    case 413:
      return { title, message: `This brew is larger than ${formatBytes(MAX_IMPORT_BYTES)}, the most that can be imported.` };
    case 429:
      return { title, message: `Too many downloads in a short time. Try again ${seconds(error.retryAfter)}.`, retry: true };
    case 502: {
      const upstream = error.extensions.upstreamStatus;
      if (typeof upstream === 'number') return { title, message: upstreamStatusMessage(upstream), retry: upstream >= 500 };
      return { title, message: 'The Homebrewery didn’t send the brew’s text (it may be down or slow). Try again later.', retry: true };
    }
    default:
      return { title, message: error.detail ?? error.title, retry: error.status >= 500 };
  }
}

/** The message for a failed conversion (hbfmToDoc). */
export function conversionProblem(error: unknown): ImportProblem {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'legacy-renderer') {
    return {
      title: 'This brew uses the legacy renderer',
      message:
        'Brews written for the Homebrewery’s legacy renderer use an older markdown dialect and can’t be imported. On the Homebrewery, open the brew’s Properties, switch the renderer to V3, check the brew still looks right, then import it again.',
    };
  }
  const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
  return { title: 'Couldn’t convert the brew', message: `The text could not be converted${detail}. Reload the page and try again.`, retry: true };
}

/** The message for a failed POST /api/brews (401 is handled by asking to sign in). */
export function createProblem(error: unknown): ImportProblem {
  const title = 'Couldn’t create the brew';
  if (!isApiError(error)) return { title, message: 'Something went wrong. Try again.', retry: true };
  if (error.kind === 'network') return { title, message: 'Can’t reach the server. Check your connection and try again.', retry: true };
  if (error.status === 400 || error.status === 422) {
    const fields = Object.entries(error.errors)
      .slice(0, 3)
      .map(([field, messages]) => `${field}: ${messages.join(' ')}`);
    return { title, message: fields.length ? `The server refused the brew. ${fields.join('; ')}.` : (error.detail ?? error.title) };
  }
  if (error.status === 413) return { title, message: 'The converted brew is too large to save.' };
  if (error.status === 429) return { title, message: `Too many requests. Try again ${seconds(error.retryAfter)}.`, retry: true };
  return { title, message: error.detail ?? error.title, retry: error.status >= 500 };
}
