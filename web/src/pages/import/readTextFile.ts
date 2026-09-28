// Reading an uploaded brew file (P6.1): a .txt or .md file of at most MAX_IMPORT_BYTES, decoded
// as UTF-8 (with or without a byte order mark), UTF-16 with a byte order mark, or, when the bytes
// aren't valid UTF-8, Windows-1252 (what older Windows editors save), with a note to check the
// special characters. Binary files are refused.

/** The largest brew text accepted from any source: the proxy's cap for upstream brews (2 MB). */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** File name endings accepted by the file picker and the checks below. */
export const IMPORT_FILE_EXTENSIONS = ['.txt', '.md', '.markdown'] as const;
/** The file input's accept attribute. */
export const IMPORT_FILE_ACCEPT = [...IMPORT_FILE_EXTENSIONS, 'text/plain', 'text/markdown'].join(',');

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export type DecodedText = { ok: true; text: string; encoding: TextEncodingName; note?: string } | { ok: false; message: string };

/** "1.5 MB", "820 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

/** The UTF-8 size of a text (what the size limit counts). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Null when the text fits MAX_IMPORT_BYTES, else the message. */
export function sizeProblem(bytes: number, what = 'This text'): string | null {
  if (bytes <= MAX_IMPORT_BYTES) return null;
  return `${what} is ${formatBytes(bytes)}. Brews of up to ${formatBytes(MAX_IMPORT_BYTES)} can be imported.`;
}

function decoder(encoding: TextEncodingName, fatal = false): TextDecoder {
  return new TextDecoder(encoding, { fatal, ignoreBOM: false });
}

/** Whether the bytes look binary: a NUL byte in the first 8 KB (text files have none in UTF-8 or 8-bit encodings). */
function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

const NOT_TEXT = 'This file doesn’t contain text. Choose the brew’s .txt or .md file.';

/** Decodes the bytes of a brew file (see the header for the rules). */
export function decodeImportBytes(bytes: Uint8Array): DecodedText {
  let result: { text: string; encoding: TextEncodingName; note?: string };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    result = { text: decoder('utf-8').decode(bytes), encoding: 'utf-8' };
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    result = { text: decoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    result = { text: decoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  } else {
    if (looksBinary(bytes)) return { ok: false, message: NOT_TEXT };
    try {
      result = { text: decoder('utf-8', true).decode(bytes), encoding: 'utf-8' };
    } catch {
      result = {
        text: decoder('windows-1252').decode(bytes),
        encoding: 'windows-1252',
        note: 'The file isn’t UTF-8 text, so it was read as Windows-1252 (Western European). Check accented letters and symbols in the preview.',
      };
    }
  }
  // A byte order mark the decoder kept, and NULs from a mislabelled file, are not text.
  const text = result.text.replace(/^\uFEFF/, '');
  // oxlint-disable-next-line no-control-regex
  if (/\u0000/.test(text)) return { ok: false, message: NOT_TEXT };
  return { ok: true, ...result, text };
}

export interface ImportFileLike {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Whether the file's name or type says it is a text or markdown file. */
export function isImportFileName(file: Pick<ImportFileLike, 'name' | 'type'>): boolean {
  const name = file.name.toLowerCase();
  if (IMPORT_FILE_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  return !/\.[a-z0-9]+$/.test(name) && (file.type === 'text/plain' || file.type === 'text/markdown');
}

/** Reads and decodes an uploaded brew file, or says why it can't be imported. */
export async function readImportFile(file: ImportFileLike): Promise<DecodedText> {
  if (!isImportFileName(file)) return { ok: false, message: 'Choose a .txt or .md file (the brew’s text, as the Homebrewery downloads it).' };
  if (file.size === 0) return { ok: false, message: 'This file is empty.' };
  const tooBig = sizeProblem(file.size, 'This file');
  if (tooBig) return { ok: false, message: tooBig };
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return { ok: false, message: 'The file could not be read. Choose it again.' };
  }
  const decoded = decodeImportBytes(new Uint8Array(buffer));
  if (decoded.ok && !decoded.text.trim()) return { ok: false, message: 'This file is empty.' };
  return decoded;
}
