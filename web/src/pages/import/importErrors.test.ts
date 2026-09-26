import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { conversionProblem, createProblem, upstreamErrorProblem, upstreamStatusMessage } from './importErrors';

function httpError(status: number, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): ApiError {
  return ApiError.fromResponse(new Response(null, { status, headers }), { status, ...body });
}

describe('upstreamErrorProblem', () => {
  it('explains each status of the import proxy', () => {
    expect(upstreamErrorProblem(httpError(400, { errors: { shareId: ['bad'] } })).message).toMatch(/10 to 14/);
    expect(upstreamErrorProblem(httpError(401)).message).toMatch(/Sign in/);
    expect(upstreamErrorProblem(httpError(404, { title: 'Brew not found' })).message).toMatch(/no brew with this share id/);
    expect(upstreamErrorProblem(httpError(413)).message).toMatch(/larger than 2 MB/);
  });

  it('says when to try again after 429', () => {
    const problem = upstreamErrorProblem(httpError(429, {}, { 'Retry-After': '42' }));
    expect(problem.message).toMatch(/in 42 seconds/);
    expect(problem.retry).toBe(true);
    expect(upstreamErrorProblem(httpError(429, {}, { 'Retry-After': '120' })).message).toMatch(/in 2 minutes/);
    expect(upstreamErrorProblem(httpError(429)).message).toMatch(/in a minute/);
  });

  it('uses upstreamStatus on 502', () => {
    expect(upstreamErrorProblem(httpError(502, { upstreamStatus: 455 })).message).toMatch(/code 455.*locked/);
    expect(upstreamErrorProblem(httpError(502, { upstreamStatus: 503 })).message).toMatch(/error 503/);
    expect(upstreamErrorProblem(httpError(502, { upstreamStatus: 403 })).message).toMatch(/refused/);
    expect(upstreamErrorProblem(httpError(502)).message).toMatch(/didn’t send/);
  });

  it('covers network failures and unknown errors', () => {
    expect(upstreamErrorProblem(ApiError.network(new TypeError('x'))).message).toMatch(/Can’t reach the server/);
    expect(upstreamErrorProblem(new Error('boom')).retry).toBe(true);
    expect(upstreamErrorProblem(httpError(500, { detail: 'Server trouble' })).message).toBe('Server trouble');
  });

  it('words upstream statuses', () => {
    expect(upstreamStatusMessage(410)).toMatch(/error 410/);
    expect(upstreamStatusMessage(423)).toMatch(/locked/);
    expect(upstreamStatusMessage(100)).toMatch(/locked/);
  });
});

describe('conversionProblem', () => {
  it('explains the legacy renderer', () => {
    const error = Object.assign(new Error('legacy'), { code: 'legacy-renderer' });
    const problem = conversionProblem(error);
    expect(problem.title).toMatch(/legacy renderer/);
    expect(problem.message).toMatch(/V3/);
  });

  it('reports other failures with their message', () => {
    expect(conversionProblem(new Error('probe failed')).message).toMatch(/\(probe failed\)/);
    expect(conversionProblem('odd').message).toMatch(/could not be converted\./);
  });
});

describe('createProblem', () => {
  it('lists field errors', () => {
    const problem = createProblem(httpError(400, { errors: { 'meta.title': ['must be at most 100 characters'] } }));
    expect(problem.message).toMatch(/meta\.title: must be at most 100 characters/);
  });

  it('covers other failures', () => {
    expect(createProblem(httpError(413)).message).toMatch(/too large/);
    expect(createProblem(httpError(429, {}, { 'Retry-After': '5' })).message).toMatch(/in 5 seconds/);
    expect(createProblem(ApiError.network(null)).retry).toBe(true);
    expect(createProblem(httpError(500, { title: 'Oops' })).message).toBe('Oops');
    expect(createProblem(null).message).toMatch(/Something went wrong/);
  });
});
