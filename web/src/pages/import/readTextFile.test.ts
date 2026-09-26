import { describe, expect, it } from 'vitest';
import { decodeImportBytes, formatBytes, isImportFileName, MAX_IMPORT_BYTES, readImportFile, sizeProblem, utf8Bytes, type ImportFileLike } from './readTextFile';

function file(name: string, bytes: Uint8Array | string, type = 'text/plain', size?: number): ImportFileLike {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return {
    name,
    type,
    size: size ?? data.length,
    arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer),
  };
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe('decodeImportBytes', () => {
  it('reads UTF-8 with and without a byte order mark', () => {
    expect(decodeImportBytes(new TextEncoder().encode('# Café ⚔'))).toEqual({ ok: true, text: '# Café ⚔', encoding: 'utf-8' });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Hi')]);
    expect(decodeImportBytes(bom)).toEqual({ ok: true, text: '# Hi', encoding: 'utf-8' });
  });

  it('reads UTF-16 with a byte order mark', () => {
    expect(decodeImportBytes(bytes(0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0xe9, 0x00))).toEqual({ ok: true, text: '# é', encoding: 'utf-16le' });
    expect(decodeImportBytes(bytes(0xfe, 0xff, 0x00, 0x23, 0x00, 0x20, 0x00, 0xe9))).toEqual({ ok: true, text: '# é', encoding: 'utf-16be' });
  });

  it('falls back to Windows-1252 for bytes that are not UTF-8, with a note', () => {
    // "Caf\xe9 \x93quoted\x94" in Windows-1252.
    const result = decodeImportBytes(bytes(0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('Café “q”');
      expect(result.encoding).toBe('windows-1252');
      expect(result.note).toMatch(/Windows-1252/);
    }
  });

  it('refuses binary data', () => {
    expect(decodeImportBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0x01)).ok).toBe(false);
  });
});

describe('readImportFile', () => {
  it('reads .txt and .md files', async () => {
    await expect(readImportFile(file('brew.txt', '# One'))).resolves.toMatchObject({ ok: true, text: '# One' });
    await expect(readImportFile(file('Brew.MD', '# Two', ''))).resolves.toMatchObject({ ok: true, text: '# Two' });
    await expect(readImportFile(file('notes.markdown', '# Three', 'text/markdown'))).resolves.toMatchObject({ ok: true });
    await expect(readImportFile(file('no-extension', '# Four', 'text/plain'))).resolves.toMatchObject({ ok: true });
  });

  /** The refusal message (fails when the file was accepted). */
  async function refusal(f: ImportFileLike): Promise<string> {
    const read = await readImportFile(f);
    if (read.ok) throw new Error(`${f.name} was accepted`);
    return read.message;
  }

  it('refuses other files, empty files and files over the limit', async () => {
    expect(await refusal(file('picture.png', bytes(1, 2, 3), 'image/png'))).toMatch(/\.txt or \.md/);
    await expect(readImportFile(file('page.html', '<p>x</p>', 'text/html'))).resolves.toMatchObject({ ok: false });
    await expect(readImportFile(file('empty.txt', ''))).resolves.toMatchObject({ ok: false, message: 'This file is empty.' });
    await expect(readImportFile(file('blank.txt', '  \n '))).resolves.toMatchObject({ ok: false, message: 'This file is empty.' });
    expect(await refusal(file('huge.txt', 'x', 'text/plain', MAX_IMPORT_BYTES + 1))).toMatch(/2 MB/);
    await expect(readImportFile(file('image.txt', bytes(0x89, 0x50, 0x00, 0x00)))).resolves.toMatchObject({ ok: false });
  });

  it('reports a failed read', async () => {
    const broken: ImportFileLike = { name: 'a.txt', size: 3, type: 'text/plain', arrayBuffer: () => Promise.reject(new Error('gone')) };
    expect(await refusal(broken)).toMatch(/could not be read/);
  });
});

describe('sizes', () => {
  it('formats byte counts', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('counts UTF-8 bytes and checks the limit', () => {
    expect(utf8Bytes('é')).toBe(2);
    expect(sizeProblem(MAX_IMPORT_BYTES)).toBeNull();
    expect(sizeProblem(MAX_IMPORT_BYTES + 1, 'This file')).toMatch(/^This file is 2 MB\. Brews of up to 2 MB/);
  });

  it('recognises file names', () => {
    expect(isImportFileName({ name: 'a.TXT', type: '' })).toBe(true);
    expect(isImportFileName({ name: 'a.docx', type: 'text/plain' })).toBe(false);
    expect(isImportFileName({ name: 'README', type: 'text/markdown' })).toBe(true);
    expect(isImportFileName({ name: 'README', type: '' })).toBe(false);
  });
});
