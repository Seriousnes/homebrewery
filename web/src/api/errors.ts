// ApiError: one error type for every failed API call (plan §9). The server answers errors as
// problem+json (RFC 9457) — {type, title, status, detail, instance, errors?, …extensions} — except
// the save conflict, which is plain JSON {serverVersion} (SaveConflict). Both normalise here.

/** Why the call failed: an HTTP error status, or no response at all. */
export type ApiErrorKind = 'http' | 'network';

export interface ApiErrorInit {
  kind: ApiErrorKind;
  /** HTTP status; 0 for network errors. */
  status: number;
  title: string;
  detail?: string | null;
  type?: string | null;
  instance?: string | null;
  errors?: Record<string, readonly string[]>;
  extensions?: Record<string, unknown>;
  /** Seconds from a Retry-After header (429, 503), or null. */
  retryAfter?: number | null;
  method?: string;
  url?: string;
  /** The response body as parsed (JSON value or text), for diagnostics. */
  body?: unknown;
  cause?: unknown;
}

const STANDARD_KEYS = new Set(['type', 'title', 'status', 'detail', 'instance', 'errors']);

/** Short fallback titles when the server sends no problem title. */
export const DEFAULT_ERROR_TITLES: Readonly<Record<number, string>> = {
  0: 'Network error',
  400: 'The request was not valid',
  401: 'Sign in required',
  403: 'Access denied',
  404: 'Not found',
  408: 'Request timed out',
  409: 'Conflict',
  413: 'Too large',
  422: 'Not processable',
  423: 'Locked',
  429: 'Too many requests',
  500: 'Server error',
  502: 'Server unavailable',
  503: 'Server unavailable',
  504: 'Server timed out',
};

export function defaultErrorTitle(status: number): string {
  return DEFAULT_ERROR_TITLES[status] ?? (status >= 500 ? 'Server error' : `Request failed (${status})`);
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly title: string;
  readonly detail: string | null;
  readonly type: string | null;
  readonly instance: string | null;
  /** Validation errors by field or document path (ValidationProblem `errors`); empty when none. */
  readonly errors: Readonly<Record<string, readonly string[]>>;
  /** Problem extensions: every member other than type, title, status, detail, instance and errors. */
  readonly extensions: Readonly<Record<string, unknown>>;
  /** Lock reason code: a 423 (`Brew locked`, `Theme locked`) carries `code`. */
  readonly code: number | null;
  /** 409 on save: the version now stored (SaveConflict.serverVersion or the problem extension). */
  readonly serverVersion: number | null;
  readonly retryAfter: number | null;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;

  constructor(init: ApiErrorInit) {
    super(init.detail ? `${init.title}: ${init.detail}` : init.title, { cause: init.cause });
    this.kind = init.kind;
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail ?? null;
    this.type = init.type ?? null;
    this.instance = init.instance ?? null;
    this.errors = Object.freeze({ ...init.errors });
    this.extensions = Object.freeze({ ...init.extensions });
    this.code = finiteNumber(this.extensions.code);
    this.serverVersion = finiteNumber(this.extensions.serverVersion);
    this.retryAfter = init.retryAfter ?? null;
    this.method = init.method ?? 'GET';
    this.url = init.url ?? '';
    this.body = init.body;
  }

  /** True when the response carried field errors (a 400 ValidationProblem). */
  get hasFieldErrors(): boolean {
    return Object.keys(this.errors).length > 0;
  }

  /** The first message for a field, e.g. `fieldError('meta.title')`. */
  fieldError(field: string): string | undefined {
    return this.errors[field]?.[0];
  }

  /** Build from a response and its already-read body (parsed JSON, text or undefined). */
  static fromResponse(response: Response, body: unknown, request?: { method?: string; url?: string }): ApiError {
    const status = response.status;
    const problem = isRecord(body) ? body : null;
    const extensions: Record<string, unknown> = {};
    if (problem) {
      for (const [key, value] of Object.entries(problem)) if (!STANDARD_KEYS.has(key)) extensions[key] = value;
    }
    const title = nonEmptyString(problem?.title) ?? defaultErrorTitle(status);
    return new ApiError({
      kind: 'http',
      status,
      title,
      detail: nonEmptyString(problem?.detail),
      type: nonEmptyString(problem?.type),
      instance: nonEmptyString(problem?.instance),
      errors: normalizeErrors(problem?.errors),
      extensions,
      retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
      method: request?.method,
      url: request?.url ?? response.url,
      body,
    });
  }

  /** A request that got no response (offline, DNS, CORS, connection reset). */
  static network(cause: unknown, request?: { method?: string; url?: string }): ApiError {
    return new ApiError({
      kind: 'network',
      status: 0,
      title: defaultErrorTitle(0),
      detail: 'Could not reach the server. Check your connection and try again.',
      method: request?.method,
      url: request?.url,
      cause,
    });
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** An aborted fetch (AbortController / TanStack Query cancellation), which is not an API error. */
export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** Retry-After as seconds: delta-seconds or an HTTP date (clamped at 0); null when absent or invalid. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value == null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

function normalizeErrors(value: unknown): Record<string, readonly string[]> {
  if (!isRecord(value)) return {};
  const out: Record<string, readonly string[]> = {};
  for (const [key, messages] of Object.entries(value)) {
    if (Array.isArray(messages)) {
      const strings = messages.filter((m): m is string => typeof m === 'string');
      if (strings.length) out[key] = strings;
    } else if (typeof messages === 'string') {
      out[key] = [messages];
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
