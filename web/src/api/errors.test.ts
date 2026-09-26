import { describe, expect, it } from 'vitest';
import { ApiError, defaultErrorTitle, isAbortError, isApiError, parseRetryAfter } from './errors';

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('ApiError.fromResponse', () => {
  it('normalises a validation problem', () => {
    const error = ApiError.fromResponse(response(400), {
      type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
      title: 'The brew is not valid.',
      status: 400,
      errors: { 'meta.title': ['too long', 'really'], doc: 'single string' },
      traceId: 'abc',
    }, { method: 'PUT', url: '/api/brews/x' });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.kind).toBe('http');
    expect(error.status).toBe(400);
    expect(error.title).toBe('The brew is not valid.');
    expect(error.detail).toBeNull();
    expect(error.errors).toEqual({ 'meta.title': ['too long', 'really'], doc: ['single string'] });
    expect(error.hasFieldErrors).toBe(true);
    expect(error.fieldError('meta.title')).toBe('too long');
    expect(error.extensions).toEqual({ traceId: 'abc' });
    expect(error.method).toBe('PUT');
    expect(error.url).toBe('/api/brews/x');
    expect(error.code).toBeNull();
    expect(error.serverVersion).toBeNull();
  });

  it('reads the lock code of a 423', () => {
    const error = ApiError.fromResponse(response(423), { title: 'Brew locked', detail: 'Share message', status: 423, code: 455 });
    expect(error.code).toBe(455);
    expect(error.detail).toBe('Share message');
    expect(error.message).toBe('Brew locked: Share message');
  });

  it('reads serverVersion from a plain SaveConflict body and from a problem extension', () => {
    expect(ApiError.fromResponse(response(409), { serverVersion: 7 }).serverVersion).toBe(7);
    expect(ApiError.fromResponse(response(409), { title: 'Version conflict', serverVersion: 3 }).serverVersion).toBe(3);
    expect(ApiError.fromResponse(response(409), { title: 'Version conflict', serverVersion: 3 }).title).toBe('Version conflict');
    expect(ApiError.fromResponse(response(409), { serverVersion: 'x' }).serverVersion).toBeNull();
  });

  it('keeps other extensions (upstreamStatus, chain)', () => {
    const error = ApiError.fromResponse(response(502), { title: 'Download failed', upstreamStatus: 404, chain: ['a', 'b'] });
    expect(error.extensions).toEqual({ upstreamStatus: 404, chain: ['a', 'b'] });
  });

  it('falls back to a default title for non-problem bodies (HTML, text, empty)', () => {
    const html = ApiError.fromResponse(response(502), '<html>Bad gateway</html>');
    expect(html.title).toBe('Server unavailable');
    expect(html.detail).toBeNull();
    expect(html.body).toBe('<html>Bad gateway</html>');
    expect(ApiError.fromResponse(response(404), undefined).title).toBe('Not found');
    expect(ApiError.fromResponse(response(418), undefined).title).toBe('Request failed (418)');
    expect(ApiError.fromResponse(response(599), '').title).toBe('Server error');
    expect(ApiError.fromResponse(response(400), ['array body']).errors).toEqual({});
  });

  it('parses Retry-After seconds', () => {
    const error = ApiError.fromResponse(response(429, { 'Retry-After': '12' }), { title: 'Too many requests' });
    expect(error.retryAfter).toBe(12);
  });
});

describe('ApiError.network', () => {
  it('has status 0 and kind network', () => {
    const cause = new TypeError('Failed to fetch');
    const error = ApiError.network(cause, { method: 'GET', url: '/api/x' });
    expect(error.status).toBe(0);
    expect(error.kind).toBe('network');
    expect(error.title).toBe('Network error');
    expect(error.cause).toBe(cause);
    expect(isApiError(error)).toBe(true);
  });
});

describe('helpers', () => {
  it('parseRetryAfter handles seconds, dates and garbage', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('isAbortError recognises DOMException and Error named AbortError', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    const error = new Error('x');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isApiError(new Error('x'))).toBe(false);
  });

  it('defaultErrorTitle', () => {
    expect(defaultErrorTitle(401)).toBe('Sign in required');
    expect(defaultErrorTitle(503)).toBe('Server unavailable');
  });
});
