import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { describeSaveError, errorReport } from './saveErrorMessages';

const http = (status: number, body: Record<string, unknown> = {}) =>
  ApiError.fromResponse(new Response(null, { status }), { status, ...body }, { method: 'PUT', url: '/api/brews/e1' });

describe('describeSaveError', () => {
  it.each([
    [http(401), /no longer signed in/, ['signIn']],
    [http(403, { detail: 'Only authors can save.' }), /Only authors can save\./, ['reload']],
    [http(403), /not one of its authors/, ['reload']],
    [http(404), /doesn't exist any more/, []],
    [http(409, { serverVersion: 4 }), /newer version/, ['reload']],
    [http(413), /too large/, ['report']],
    [http(423, { detail: 'Copied text.', code: 455 }), /locked: Copied text\./, []],
    [http(429), /Too many requests/, ['retry']],
    [http(400, { errors: { 'meta.title': ['Too long.'] } }), /couldn't be saved: Too long\./, ['report']],
    [http(500), /server had a problem/, ['retry', 'report']],
    [http(418, { title: "I'm a teapot" }), /problem saving: I'm a teapot/, ['report']],
    [ApiError.network(new TypeError('Failed to fetch')), /interrupted or timed out/, ['retry']],
    [new Error('boom'), /problem saving/, ['retry', 'report']],
  ])('%#: message and actions', (error, message, actions) => {
    const description = describeSaveError(error);
    expect(description.message).toMatch(message);
    expect(description.actions).toEqual(actions);
  });

  it('treats an abort as cancelled', () => {
    expect(describeSaveError(new DOMException('Aborted', 'AbortError')).message).toMatch(/cancelled/);
  });
});

describe('errorReport', () => {
  it('lists status, request, detail and field errors', () => {
    const report = errorReport(http(400, { title: 'Bad', detail: 'Nope', errors: { handle: ['Too short.'] } }));
    expect(report).toBe('Status: 400 Bad\nRequest: PUT /api/brews/e1\nDetail: Nope\nhandle: Too short.');
    expect(errorReport(ApiError.network(new TypeError('x')))).toMatch(/^Status: no response/);
    expect(errorReport(new RangeError('bad'))).toBe('RangeError: bad');
    expect(errorReport('plain')).toBe('plain');
  });
});
