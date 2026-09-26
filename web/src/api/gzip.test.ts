import { gunzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { encodeJsonBody, GZIP_MIN_BYTES, jsonBodyOptions } from './gzip';

describe('encodeJsonBody', () => {
  it('sends small bodies as plain JSON', () => {
    const encoded = encodeJsonBody({ a: 1 });
    expect(encoded.gzipped).toBe(false);
    expect(encoded.body).toBe('{"a":1}');
    expect(encoded.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(encoded.jsonBytes).toBe(7);
  });

  it('gzips bodies at or over the threshold', () => {
    const value = { text: 'x'.repeat(GZIP_MIN_BYTES) };
    const encoded = encodeJsonBody(value);
    expect(encoded.gzipped).toBe(true);
    expect(encoded.headers['Content-Encoding']).toBe('gzip');
    expect(encoded.headers['Content-Type']).toBe('application/json');
    expect(encoded.body).toBeInstanceOf(Uint8Array);
    expect(encoded.sentBytes).toBeLessThan(encoded.jsonBytes / 10);
    expect(JSON.parse(strFromU8(gunzipSync(encoded.body as Uint8Array)))).toEqual(value);
  });

  it('counts UTF-8 bytes, not characters', () => {
    const value = 'é'.repeat(GZIP_MIN_BYTES / 2);
    expect(encodeJsonBody(value).gzipped).toBe(true);
    expect(encodeJsonBody('e'.repeat(GZIP_MIN_BYTES / 2)).gzipped).toBe(false);
  });

  it('honours always / never / minBytes', () => {
    expect(encodeJsonBody({ a: 1 }, { gzip: 'always' }).gzipped).toBe(true);
    expect(encodeJsonBody({ text: 'x'.repeat(GZIP_MIN_BYTES * 2) }, { gzip: 'never' }).gzipped).toBe(false);
    expect(encodeJsonBody({ text: 'xxxx' }, { minBytes: 4 }).gzipped).toBe(true);
  });

  it('round-trips non-ASCII text through gzip', () => {
    const value = { title: 'Drachen – Überfall 🐉', text: 'ü'.repeat(10) };
    const encoded = encodeJsonBody(value, { gzip: 'always' });
    expect(JSON.parse(strFromU8(gunzipSync(encoded.body as Uint8Array)))).toEqual(value);
  });

  it('jsonBodyOptions returns a serializer that ignores its argument', () => {
    const options = jsonBodyOptions({ a: 1 }, { gzip: 'never' });
    expect(options.bodySerializer()).toBe('{"a":1}');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});
