// Import from the Homebrewery (upstream) through the API's proxy (P2.8): the server fetches the
// brew's text by share id; the client converts it (web/src/editor/import) and creates a brew.
import { useMutation } from '@tanstack/react-query';
import { api, type CallOptions, unwrap } from './client';
import { mergeMutationOptions, type MutationOverrides } from './hookOptions';
import { mutationKeys } from './keys';

/** The ids the proxy accepts (plan: ^[\w-]{10,14}$, ASCII). */
export const UPSTREAM_SHARE_ID = /^[A-Za-z0-9_-]{10,14}$/;

const UPSTREAM_PATH = /\/(?:share|download|source|print)\/([A-Za-z0-9_-]+)/;

/**
 * The share id in what the user pasted: a bare id, or an upstream URL such as
 * https://homebrewery.naturalcrit.com/share/<id> (also /download, /source, /print). Null otherwise.
 */
export function parseUpstreamShareId(input: string): string | null {
  const text = input.trim();
  if (UPSTREAM_SHARE_ID.test(text)) return text;
  let path = text;
  try {
    path = new URL(text).pathname;
  } catch {
    // Not an absolute URL: try the text as a path.
  }
  const id = UPSTREAM_PATH.exec(path)?.[1];
  return id && UPSTREAM_SHARE_ID.test(id) ? id : null;
}

/**
 * The upstream brew text (markdown with its ```metadata and ```css blocks). Signed-in users only,
 * rate limited. Errors: 400 errors.shareId, 404, 413 (over 2 MB), 429 (retryAfter), 502 (extension
 * upstreamStatus when upstream answered an error; a locked brew answers with its lock code).
 */
export async function fetchUpstreamBrew(shareId: string, { client = api, signal }: CallOptions = {}): Promise<string> {
  return unwrap(
    client.GET('/api/import/homebrewery/{shareId}', { params: { path: { shareId } }, parseAs: 'text', signal }),
    { method: 'GET', url: `/api/import/homebrewery/${shareId}` },
  );
}

/** Fetch an upstream brew's text on demand (a mutation: user-triggered, rate limited, never cached). */
export function useUpstreamImport(overrides?: MutationOverrides<string, string>) {
  return useMutation(
    mergeMutationOptions<string, string, unknown>(
      {
        mutationKey: mutationKeys.importUpstream,
        mutationFn: (shareId) => fetchUpstreamBrew(shareId),
        meta: { errorTitle: "Couldn't download the brew" },
      },
      overrides,
    ),
  );
}
