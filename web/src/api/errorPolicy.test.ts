import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import {
  applyErrorPolicy,
  classifyApiError,
  describeApiError,
  errorPageData,
  isTransientError,
  retryDelay,
  shouldRetryQuery,
  type ErrorToast,
} from './errorPolicy';
import { onSignInRequired } from './events';

function httpError(status: number, problem: Record<string, unknown> = {}, headers: Record<string, string> = {}): ApiError {
  return ApiError.fromResponse(new Response(null, { status, headers }), { status, ...problem });
}

describe('classifyApiError', () => {
  it.each([
    [401, 'signIn'],
    [403, 'errorPage'],
    [404, 'errorPage'],
    [410, 'errorPage'],
    [423, 'errorPage'],
    [409, 'caller'],
    [400, 'toast'],
    [413, 'toast'],
    [429, 'toast'],
    [500, 'toast'],
    [502, 'toast'],
  ] as const)('%i → %s', (status, handling) => {
    expect(classifyApiError(httpError(status))).toBe(handling);
  });

  it('leaves validation problems to the caller', () => {
    expect(classifyApiError(httpError(400, { errors: { handle: ['Taken'] } }))).toBe('caller');
    expect(classifyApiError(httpError(422, { errors: { x: ['y'] } }))).toBe('caller');
  });

  it('toasts network errors and foreign errors', () => {
    expect(classifyApiError(ApiError.network(new TypeError('x')))).toBe('toast');
    expect(classifyApiError(new TypeError('bug'))).toBe('toast');
  });
});

describe('retry policy', () => {
  it('retries transient errors at most twice', () => {
    const e503 = httpError(503);
    expect(isTransientError(e503)).toBe(true);
    expect(shouldRetryQuery(0, e503)).toBe(true);
    expect(shouldRetryQuery(1, e503)).toBe(true);
    expect(shouldRetryQuery(2, e503)).toBe(false);
    expect(shouldRetryQuery(0, ApiError.network(null))).toBe(true);
    expect(shouldRetryQuery(0, httpError(501))).toBe(false);
    for (const status of [400, 401, 403, 404, 409, 413, 423]) expect(shouldRetryQuery(0, httpError(status))).toBe(false);
    expect(shouldRetryQuery(0, new Error('x'))).toBe(false);
  });

  it('respects Retry-After (and gives up on long ones)', () => {
    const soon = httpError(429, {}, { 'Retry-After': '3' });
    const late = httpError(429, {}, { 'Retry-After': '60' });
    expect(shouldRetryQuery(0, soon)).toBe(true);
    expect(retryDelay(0, soon)).toBe(3000);
    expect(shouldRetryQuery(0, late)).toBe(false);
    expect(retryDelay(0, httpError(500))).toBe(1000);
    expect(retryDelay(1, httpError(500))).toBe(2000);
    expect(retryDelay(9, httpError(500))).toBe(8000);
  });
});

describe('errorPageData', () => {
  it('describes 404, 403, 423 and 401', () => {
    expect(errorPageData(httpError(404, { title: 'Brew not found' }))).toMatchObject({ status: 404, title: 'Brew not found' });
    expect(errorPageData(httpError(404, { title: 'Not Found' })).title).toBe('Not found');
    expect(errorPageData(httpError(403, { title: 'Forbidden', detail: 'Not an author.' }))).toEqual({
      status: 403,
      title: 'Access denied',
      message: 'Not an author.',
      code: null,
    });
    expect(errorPageData(httpError(423, { title: 'Brew locked', detail: 'Removed for review.', code: 455 }))).toEqual({
      status: 423,
      title: 'Brew locked',
      message: 'Removed for review.',
      code: 455,
    });
    expect(errorPageData(httpError(401)).title).toBe('Sign in required');
    expect(errorPageData(ApiError.network(null)).title).toBe('Network error');
    expect(errorPageData(new Error('boom'))).toMatchObject({ status: 0, title: 'Something went wrong', message: 'boom' });
  });
});

describe('describeApiError', () => {
  it('prefers detail, then field errors, then title', () => {
    expect(describeApiError(httpError(429, {}, { 'Retry-After': '5' }))).toBe('Too many requests. Try again in 5 s.');
    expect(describeApiError(httpError(429))).toMatch(/Wait a moment/);
    expect(describeApiError(httpError(400, { errors: { q: ['Too long.'] } }))).toBe('Too long.');
    expect(describeApiError(httpError(500))).toBe('The server had a problem. Try again.');
    expect(describeApiError(httpError(403, { title: 'Forbidden' }))).toBe('Forbidden');
    expect(describeApiError(ApiError.network(null))).toMatch(/Could not reach the server/);
    expect(describeApiError(new DOMException('x', 'AbortError'))).toBe('The request was cancelled.');
  });
});

describe('applyErrorPolicy', () => {
  const setup = () => {
    const toasts: ErrorToast[] = [];
    const retry = vi.fn();
    const onSignIn = vi.fn();
    return { toasts, retry, onSignIn, notify: (t: ErrorToast) => toasts.push(t) };
  };

  it('toasts transient query errors with a Retry action', () => {
    const { toasts, retry, notify } = setup();
    expect(applyErrorPolicy(httpError(503), { source: 'query', key: 'q1', retry, notify })).toBe('toast');
    expect(toasts).toHaveLength(1);
    const [t] = toasts;
    expect(t).toMatchObject({ id: 'api:q1', tone: 'error', title: "Couldn't load data", duration: null });
    t?.action?.onAction();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('toasts non-transient errors without Retry, and uses meta.errorTitle', () => {
    const { toasts, retry, notify } = setup();
    applyErrorPolicy(httpError(413, { detail: 'Brew too large' }), { source: 'mutation', meta: { errorTitle: "Couldn't save" }, retry, notify });
    expect(toasts[0]).toMatchObject({ title: "Couldn't save", description: 'Brew too large', duration: 8000 });
    expect(toasts[0]?.action).toBeUndefined();
  });

  it('raises the sign-in prompt on 401 (default: the events module)', () => {
    const { toasts, notify, onSignIn } = setup();
    expect(applyErrorPolicy(httpError(401), { source: 'query', notify, onSignIn })).toBe('signIn');
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(toasts).toHaveLength(0);

    const listener = vi.fn();
    const off = onSignInRequired(listener);
    const error = httpError(401);
    applyErrorPolicy(error, { source: 'mutation', notify });
    expect(listener).toHaveBeenCalledWith({ error });
    off();
    applyErrorPolicy(error, { source: 'mutation', notify });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('leaves 403/404 queries to the page, but toasts them for mutations', () => {
    const { toasts, notify } = setup();
    expect(applyErrorPolicy(httpError(404), { source: 'query', notify })).toBe('errorPage');
    expect(toasts).toHaveLength(0);
    expect(applyErrorPolicy(httpError(403, { detail: 'Not an author.' }), { source: 'mutation', notify })).toBe('errorPage');
    expect(toasts[0]).toMatchObject({ description: 'Not an author.' });
  });

  it('does nothing for 409, field errors, aborts and manual requests', () => {
    const { toasts, notify, onSignIn } = setup();
    expect(applyErrorPolicy(httpError(409, { serverVersion: 4 }), { source: 'mutation', notify })).toBe('caller');
    expect(applyErrorPolicy(httpError(400, { errors: { a: ['b'] } }), { source: 'mutation', notify })).toBe('caller');
    expect(applyErrorPolicy(new DOMException('x', 'AbortError'), { source: 'query', notify })).toBe('ignored');
    expect(applyErrorPolicy(httpError(401), { source: 'mutation', meta: { errorPolicy: 'manual' }, notify, onSignIn })).toBe('ignored');
    expect(applyErrorPolicy(httpError(500), { source: 'query', meta: { errorPolicy: 'manual' }, notify })).toBe('ignored');
    expect(toasts).toHaveLength(0);
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('a throwing sign-in listener does not break the policy', () => {
    const { notify } = setup();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const off = onSignInRequired(() => {
      throw new Error('listener bug');
    });
    expect(() => applyErrorPolicy(httpError(401), { source: 'query', notify })).not.toThrow();
    expect(errorLog).toHaveBeenCalled();
    off();
    errorLog.mockRestore();
  });
});
