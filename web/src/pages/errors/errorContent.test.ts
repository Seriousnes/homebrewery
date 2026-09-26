import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { errorContent, isChunkLoadError } from './errorContent';

const problem = (status: number, body: Record<string, unknown> = {}) => ApiError.fromResponse(new Response(null, { status }), { status, ...body });

describe('errorContent', () => {
  it('explains statuses without an error', () => {
    expect(errorContent({ status: 404 })).toMatchObject({ status: 404, title: 'Not found', transient: false });
    expect(errorContent({ status: 403 })).toMatchObject({ title: 'Access denied' });
    expect(errorContent({ status: 401 })).toMatchObject({ title: 'Sign in required' });
    expect(errorContent({})).toMatchObject({ status: 500, title: 'Something went wrong', transient: true });
    expect(errorContent({ status: 0 })).toMatchObject({ title: "Can't reach the server", transient: true });
  });

  it('uses the API error', () => {
    expect(errorContent({ error: problem(404, { title: 'Brew not found' }) })).toMatchObject({ status: 404, title: 'Brew not found' });
    expect(errorContent({ error: problem(403, { detail: 'Authors only.' }) })).toMatchObject({ title: 'Access denied', message: 'Authors only.' });
    expect(errorContent({ error: problem(503) })).toMatchObject({ status: 503, transient: true });
  });

  it('shows the lock reason and code for 423', () => {
    expect(errorContent({ error: problem(423, { title: 'Brew locked', detail: 'Copied text.', code: 455 }) })).toMatchObject({
      status: 423,
      title: 'This brew is locked',
      lockReason: 'Copied text.',
      code: 455,
      transient: false,
    });
  });

  it('treats a network failure as status 0', () => {
    expect(errorContent({ error: ApiError.network(new TypeError('Failed to fetch')) })).toMatchObject({
      status: 0,
      title: "Can't reach the server",
      transient: true,
    });
  });
});

describe('isChunkLoadError', () => {
  it('recognises failed dynamic imports in each browser', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: http://x/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Something else'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });
});
