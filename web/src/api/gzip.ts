// Request bodies for brew create and save (plan §8.4, §9): JSON, gzip-compressed with fflate when
// large, sent with Content-Encoding: gzip. The API decompresses (UseRequestDecompression) and caps
// the decompressed body at 20 MB.
import { gzipSync, strToU8 } from 'fflate';

/** Bodies at least this large (UTF-8 bytes) are compressed in 'auto' mode. */
export const GZIP_MIN_BYTES = 8 * 1024;

export type GzipMode = 'auto' | 'always' | 'never';

export interface EncodedJsonBody {
  /** What fetch sends: the JSON text, or the gzip bytes. */
  body: string | Uint8Array<ArrayBuffer>;
  /** Headers to add to the request: Content-Type, plus Content-Encoding when gzipped. */
  headers: Record<string, string>;
  gzipped: boolean;
  /** Size of the uncompressed JSON in UTF-8 bytes. */
  jsonBytes: number;
  /** Size of what is sent. */
  sentBytes: number;
}

export interface EncodeJsonOptions {
  gzip?: GzipMode;
  minBytes?: number;
  /** fflate level 0-9 (default 6). */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/**
 * Serialize `value` as JSON and gzip it when `gzip` is 'always', or 'auto' (the default) and the
 * JSON is at least `minBytes`. Compression runs synchronously on the calling thread: about 20-40 ms
 * for a 2 MB document.
 */
export function encodeJsonBody(value: unknown, options: EncodeJsonOptions = {}): EncodedJsonBody {
  const { gzip = 'auto', minBytes = GZIP_MIN_BYTES, level = 6 } = options;
  const json = JSON.stringify(value) ?? 'null';
  const bytes = strToU8(json);
  const compress = gzip === 'always' || (gzip === 'auto' && bytes.length >= minBytes);
  if (!compress) {
    return {
      body: json,
      headers: { 'Content-Type': 'application/json' },
      gzipped: false,
      jsonBytes: bytes.length,
      sentBytes: bytes.length,
    };
  }
  // fflate allocates a fresh ArrayBuffer, so the view is Uint8Array<ArrayBuffer> (a valid BodyInit).
  const gz = gzipSync(bytes, { level });
  return {
    body: gz,
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    gzipped: true,
    jsonBytes: bytes.length,
    sentBytes: gz.length,
  };
}

/**
 * openapi-fetch request options that send `value` through encodeJsonBody: pass them next to the
 * typed `body` (which keeps type checking) — the serializer ignores its argument and returns the
 * pre-encoded bytes.
 */
export function jsonBodyOptions(
  value: unknown,
  options?: EncodeJsonOptions,
): { bodySerializer: () => string | Uint8Array<ArrayBuffer>; headers: Record<string, string>; encoded: EncodedJsonBody } {
  const encoded = encodeJsonBody(value, options);
  return { bodySerializer: () => encoded.body, headers: encoded.headers, encoded };
}
