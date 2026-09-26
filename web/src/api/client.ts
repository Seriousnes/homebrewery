// Typed API client (plan §9): openapi-fetch over the OpenAPI types in schema.d.ts (generated from
// shared/openapi.json by `npm run api:types`). Same origin, with credentials, so the Identity cookie
// travels with every call; SameOriginWriteGuard accepts the browser's Origin header on writes.
import createClient, { type Client } from 'openapi-fetch';
import { ApiError, isAbortError } from './errors';
import type { paths } from './schema';

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** Default: this page's origin (the SPA and the API share it; Vite and Caddy proxy /api). */
  baseUrl?: string;
  /** Default: the global fetch, looked up on every call (so tests can stub it at any time). */
  fetch?: (request: Request) => Promise<Response>;
}

export function defaultBaseUrl(): string {
  // Absolute, because Request() outside a document (tests, workers) can't resolve '/api/…'.
  return typeof location !== 'undefined' && location.origin !== 'null' ? location.origin : '';
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return createClient<paths>({
    baseUrl: options.baseUrl ?? defaultBaseUrl(),
    credentials: 'include',
    fetch: options.fetch ?? ((request: Request) => globalThis.fetch(request)),
  });
}

/** The app's client. Endpoint functions in this folder take an optional `client` to override it. */
export const api: ApiClient = createApiClient();

/** Per-call options every endpoint function accepts. */
export interface CallOptions {
  signal?: AbortSignal;
  client?: ApiClient;
}

type AnyFetchResult = { data?: unknown; error?: unknown; response: Response };

/**
 * Await an openapi-fetch call and return its data, or throw an ApiError: an HTTP error status
 * becomes ApiError.fromResponse (problem+json normalised), a failed fetch becomes ApiError.network.
 * Aborts are rethrown unchanged so TanStack Query treats them as cancellations. A 204 (or an empty
 * 200) resolves to undefined at run time, whatever the declared type.
 */
export async function unwrap<R extends AnyFetchResult>(
  pending: Promise<R>,
  request?: { method?: string; url?: string },
): Promise<Exclude<R['data'], undefined>> {
  let result: R;
  try {
    result = await pending;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw ApiError.network(error, request);
  }
  const { response } = result;
  if (!response.ok) {
    throw ApiError.fromResponse(response, result.error, { method: request?.method, url: request?.url ?? response.url });
  }
  return result.data as Exclude<R['data'], undefined>;
}
