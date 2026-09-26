/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import { absoluteUrl, bytesToBase64, classifyUrl, fetchDataUri, fetchDataUris, mediaType } from './resources';

const BASE = 'http://localhost:5173/edit/abc';
const ORIGIN = 'http://localhost:5173';

describe('classifyUrl', () => {
  it('tells data, this site, other sites and the rest apart', () => {
    expect(classifyUrl('data:image/png;base64,AA', BASE, ORIGIN)).toBe('data');
    expect(classifyUrl('/assets/a.png', BASE, ORIGIN)).toBe('same-origin');
    expect(classifyUrl('../fonts/a.woff2', BASE, ORIGIN)).toBe('same-origin');
    expect(classifyUrl('http://localhost:5173/x', BASE, ORIGIN)).toBe('same-origin');
    expect(classifyUrl('https://i.imgur.com/a.png', BASE, ORIGIN)).toBe('external');
    expect(classifyUrl('//cdn.example.com/a.png', BASE, ORIGIN)).toBe('external');
    expect(classifyUrl('#filter', BASE, ORIGIN)).toBe('other');
    expect(classifyUrl('blob:http://localhost:5173/1', BASE, ORIGIN)).toBe('other');
    expect(classifyUrl('', BASE, ORIGIN)).toBe('other');
    expect(classifyUrl('http://[bad', BASE, ORIGIN)).toBe('other');
  });

  it('resolves relative urls', () => {
    expect(absoluteUrl(' /a.png ', BASE)).toBe('http://localhost:5173/a.png');
    expect(absoluteUrl('', BASE)).toBeNull();
    expect(absoluteUrl('http://[bad', BASE)).toBeNull();
  });
});

describe('mediaType', () => {
  it("uses the response's type, else the extension", () => {
    expect(mediaType('/a.bin', 'image/png; charset=binary')).toBe('image/png');
    expect(mediaType('/fonts/a.woff2?v=1', 'application/octet-stream')).toBe('font/woff2');
    expect(mediaType('/a.svg', null)).toBe('image/svg+xml');
    expect(mediaType('/a.unknown', null)).toBe('application/octet-stream');
    expect(mediaType('/a.png', 'text/plain;charset=UTF-8')).toBe('image/png');
    expect(mediaType('/a.unknown', 'text/plain')).toBe('text/plain');
  });
});

describe('bytesToBase64', () => {
  it('matches Buffer for sizes around the chunk boundary', () => {
    for (const size of [0, 1, 2, 3, 0x6000 - 1, 0x6000, 0x6000 + 1, 100_000]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 7919) & 255);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

const ok = (body: string, type = 'image/png') => Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': type } }));

describe('fetchDataUri', () => {
  it('fetches a file as a data: URI with credentials of this site', async () => {
    const fetch = vi.fn(() => ok('abc'));
    const file = await fetchDataUri('http://localhost:5173/a.png', { fetch });
    expect(file).toEqual({ dataUri: `data:image/png;base64,${btoa('abc')}`, bytes: 3, type: 'image/png' });
    expect(fetch).toHaveBeenCalledWith('http://localhost:5173/a.png', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('is null for HTTP errors, network errors and timeouts', async () => {
    expect(await fetchDataUri('/a', { fetch: () => Promise.resolve(new Response('', { status: 404 })) })).toBeNull();
    expect(
      await fetchDataUri('/a', {
        fetch: () => Promise.reject(new TypeError('offline')),
      }),
    ).toBeNull();
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    expect(await fetchDataUri('/a', { fetch: hanging, timeoutMs: 10 })).toBeNull();
  });
});

describe('fetchDataUris', () => {
  it('fetches every url once, a few at a time', async () => {
    let active = 0;
    let most = 0;
    const fetch = vi.fn(async (url: string) => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return url.endsWith('missing') ? new Response('', { status: 404 }) : ok(url);
    });
    const urls = ['/1', '/2', '/3', '/4', '/1', '/missing'];
    const files = await fetchDataUris(urls, { fetch, concurrency: 2 });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(most).toBeLessThanOrEqual(2);
    expect(files.get('/1')?.bytes).toBe(2);
    expect(files.get('/missing')).toBeNull();
  });

  it('rejects when cancelled', async () => {
    const controller = new AbortController();
    const fetch = () => {
      controller.abort();
      return ok('x');
    };
    await expect(fetchDataUris(['/a', '/b'], { fetch, signal: controller.signal })).rejects.toThrow('cancelled');
  });
});
