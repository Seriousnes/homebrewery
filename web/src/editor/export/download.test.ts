import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadHtml, formatBytes, REVOKE_DELAY_MS } from './download';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('downloadHtml', () => {
  it('clicks a temporary download link to a Blob URL, and revokes the URL later', async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:http://localhost/1';
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
      expect(this.isConnected).toBe(true);
    });

    downloadHtml('<!DOCTYPE html><p>x</p>', 'My brew.html');

    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.getAttribute('href')).toBe('blob:http://localhost/1');
    expect(clicks[0]!.download).toBe('My brew.html');
    expect(clicks[0]!.isConnected).toBe(false);
    expect(blobs[0]!.type).toBe('text/html;charset=utf-8');
    expect(await blobs[0]!.text()).toBe('<!DOCTYPE html><p>x</p>');
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DELAY_MS);
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/1');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [1023, '1023 bytes'],
    [1536, '2 KB'],
    [1024 * 1024 * 1.45, '1.4 MB'],
  ])('%d → %s', (bytes, text) => expect(formatBytes(bytes)).toBe(text));
});
