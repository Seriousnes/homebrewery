import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, createApiClient, unwrap } from './client';
import { ApiError } from './errors';
import { emptyResponse, jsonResponse, mockApi, problemResponse, textResponse } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('calls the same origin with credentials included', async () => {
    const mock = mockApi(() => jsonResponse({ id: 'u1', handle: 'h', email: null, roles: [] }));
    const data = await unwrap(api.GET('/api/account/me'));
    expect(data).toEqual({ id: 'u1', handle: 'h', email: null, roles: [] });
    const request = mock.last();
    expect(request.url.origin).toBe(location.origin);
    expect(request.path).toBe('/api/account/me');
    expect(request.credentials).toBe('include');
    expect(request.method).toBe('GET');
  });

  it('resolves 204 to undefined', async () => {
    mockApi(() => emptyResponse(204));
    await expect(unwrap(api.GET('/api/account/me'))).resolves.toBeUndefined();
  });

  it('serialises path and query parameters', async () => {
    const mock = mockApi(() => jsonResponse({ items: [], total: 0, page: 1, pageSize: 20, sort: 'updated', dir: 'desc' }));
    await unwrap(api.GET('/api/vault', { params: { query: { q: 'red dragon', page: 2 } } }));
    expect(mock.last().path).toBe('/api/vault?q=red%20dragon&page=2');
    await unwrap(api.GET('/api/users/{handle}/brews', { params: { path: { handle: 'a b' } } }));
    expect(mock.last().path).toBe('/api/users/a%20b/brews');
  });

  it('throws ApiError for problem responses', async () => {
    mockApi(() => problemResponse(404, { title: 'Brew not found' }));
    const error = await unwrap(api.GET('/api/brews/edit/{editId}', { params: { path: { editId: 'x' } } }), {
      method: 'GET',
      url: '/api/brews/edit/x',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).title).toBe('Brew not found');
    expect((error as ApiError).url).toBe('/api/brews/edit/x');
  });

  it('throws ApiError for non-JSON error bodies', async () => {
    mockApi(() => textResponse('<html>proxy error</html>', 502, 'text/html'));
    const error = (await unwrap(api.GET('/api/themes')).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.title).toBe('Server unavailable');
  });

  it('turns a failed fetch into a network ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const error = (await unwrap(api.GET('/api/themes'), { method: 'GET', url: '/api/themes' }).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('network');
    expect(error.status).toBe(0);
  });

  it('rethrows aborts unchanged', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(abort)));
    await expect(unwrap(api.GET('/api/themes'))).rejects.toBe(abort);
  });

  it('createApiClient accepts its own base URL and fetch', async () => {
    const fetch = vi.fn((request: Request) => {
      expect(request.url).toBe('https://example.test/api/themes');
      return Promise.resolve(jsonResponse({ static: [], user: [] }));
    });
    const client = createApiClient({ baseUrl: 'https://example.test', fetch });
    await expect(unwrap(client.GET('/api/themes'))).resolves.toEqual({ static: [], user: [] });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
