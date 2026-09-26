// Resources of the HTML export (P6.4): which URLs a page needs, and same-origin files fetched and
// turned into data: URIs so the exported file opens offline. Other hosts' files are never fetched
// (their images stay links and are listed in the report).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** How the export treats a URL. */
export type UrlKind =
  /** Already inline (data:). */
  | 'data'
  /** Served by this site (theme fonts and images under /fonts and /assets, the app's own files): inlined. */
  | 'same-origin'
  /** Another host over http(s): left as a link, listed in the report. */
  | 'external'
  /** Fragments (#filter), blob:, about: and anything else: left alone. */
  | 'other';

/** `url` made absolute against `base`, or null when it can't be parsed. */
export function absoluteUrl(url: string, base: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

/** The kind of `url` (resolved against `base`) for a document served from `origin`. */
export function classifyUrl(url: string, base: string, origin: string): UrlKind {
  const trimmed = url.trim();
  if (/^data:/i.test(trimmed)) return 'data';
  if (trimmed.startsWith('#') || trimmed === '') return 'other';
  const href = absoluteUrl(trimmed, base);
  if (!href) return 'other';
  const parsed = new URL(href);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'other';
  return parsed.origin === origin ? 'same-origin' : 'external';
}

const EXTENSION_TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

/** Types that say nothing about a file (servers send them for extensions they don't know). */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'text/plain']);

/** The media type of a fetched file: the response's, or one guessed from the extension. */
export function mediaType(url: string, contentType: string | null): string {
  const declared = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!GENERIC_TYPES.has(declared)) return declared;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // keep the raw URL
  }
  const ext = /\.([a-z0-9]+)$/i.exec(path.replace(/[?#].*$/, ''))?.[1]?.toLowerCase();
  return (ext && EXTENSION_TYPES[ext]) || declared || 'application/octet-stream';
}

/** Base64 of `bytes` (chunked: no argument-count limits, no FileReader). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x6000; // a multiple of 3: chunks encode without padding in between
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    let binary = '';
    const chunk = bytes.subarray(i, i + CHUNK);
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]!);
    out += btoa(binary);
  }
  return out;
}

export interface InlinedFile {
  /** data:<type>;base64,… */
  dataUri: string;
  /** Size of the file in bytes. */
  bytes: number;
  type: string;
}

export interface FetchDataUriOptions {
  fetch?: FetchLike;
  /** Per file (default 20 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Fetches `url` as a data: URI, or null on HTTP and network errors and after the timeout. */
export async function fetchDataUri(url: string, options: FetchDataUriOptions = {}): Promise<InlinedFile | null> {
  const fetchFn = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 20_000);
  try {
    const response = await fetchFn(url, { signal: controller.signal, credentials: 'same-origin' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = mediaType(url, response.headers.get('content-type'));
    return { dataUri: `data:${type};base64,${bytesToBase64(bytes)}`, bytes: bytes.length, type };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Fetches every URL (absolute, deduplicated) as a data: URI, a few at a time. The map holds null
 * for the ones that failed.
 */
export async function fetchDataUris(
  urls: Iterable<string>,
  options: FetchDataUriOptions & { concurrency?: number } = {},
): Promise<Map<string, InlinedFile | null>> {
  const queue = [...new Set(urls)];
  const results = new Map<string, InlinedFile | null>();
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (options.signal?.aborted) return;
      results.set(url, await fetchDataUri(url, options));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 6) }, worker));
  if (options.signal?.aborted) throw new DOMException('The export was cancelled.', 'AbortError');
  return results;
}
