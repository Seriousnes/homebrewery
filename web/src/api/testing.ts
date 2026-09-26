// Test helpers for code that calls the API (Vitest only; never import from app code).
// mockApi() replaces the global fetch; the app's `api` client looks fetch up on every call.
import { gunzipSync, strFromU8 } from 'fflate';
import { vi } from 'vitest';

export interface RecordedRequest {
  method: string;
  url: URL;
  /** Path plus query, e.g. '/api/vault?q=dragon'. */
  path: string;
  headers: Headers;
  credentials: RequestCredentials;
  /** The body as text (gunzipped when Content-Encoding is gzip), or null. */
  body: string | null;
  /** The body as sent. */
  rawBody: Uint8Array | null;
  /** body parsed as JSON when it is JSON. */
  json: unknown;
}

export type MockHandler = (request: RecordedRequest) => Response | Promise<Response>;

export interface MockApi {
  requests: RecordedRequest[];
  /** The last request (throws when there was none). */
  last(): RecordedRequest;
  restore(): void;
}

async function record(request: Request): Promise<RecordedRequest> {
  const url = new URL(request.url);
  let rawBody: Uint8Array | null = null;
  let body: string | null = null;
  if (request.body) {
    rawBody = new Uint8Array(await request.arrayBuffer());
    body = request.headers.get('Content-Encoding') === 'gzip' ? strFromU8(gunzipSync(rawBody)) : strFromU8(rawBody);
  }
  let json: unknown;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  return {
    method: request.method,
    url,
    path: url.pathname + url.search,
    headers: request.headers,
    credentials: request.credentials,
    body,
    rawBody,
    json,
  };
}

/** Stub global fetch with `handler`; call restore() (or vi.unstubAllGlobals()) afterwards. */
export function mockApi(handler: MockHandler): MockApi {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const recorded = await record(request);
      requests.push(recorded);
      return handler(recorded);
    }),
  );
  return {
    requests,
    last() {
      const request = requests.at(-1);
      if (!request) throw new Error('No request was made');
      return request;
    },
    restore: () => vi.unstubAllGlobals(),
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A problem+json error response, e.g. problemResponse(404, { title: 'Brew not found' }). */
export function problemResponse(status: number, problem: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ status, ...problem }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
  });
}

export function textResponse(text: string, status = 200, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(text, { status, headers: { 'Content-Type': contentType } });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}
