import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import { PDF_MISSING_FILES_HEADER, renderPdf } from './exportPdf';
import { mockApi, problemResponse } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
});

const pdfResponse = (headers: Record<string, string> = {}) =>
  new Response('%PDF-1.7 test', { status: 200, headers: { 'Content-Type': 'application/pdf', ...headers } });

describe('renderPdf', () => {
  it('posts the HTML (gzipped when large) and returns the PDF and the missing-file count', async () => {
    const mock = mockApi(() => pdfResponse({ [PDF_MISSING_FILES_HEADER]: '2' }));
    const html = `<!DOCTYPE html><title>Brew</title>${'<p>filler</p>'.repeat(2000)}`;

    const result = await renderPdf(html);

    const request = mock.last();
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/export/pdf');
    expect(request.headers.get('Content-Encoding')).toBe('gzip');
    expect(request.json).toEqual({ html });
    expect(await result.pdf.text()).toBe('%PDF-1.7 test');
    expect(result.missingFiles).toBe(2);
  });

  it('reads a missing or odd header as 0', async () => {
    mockApi(() => pdfResponse());
    expect((await renderPdf('<p>x</p>')).missingFiles).toBe(0);
    mockApi(() => pdfResponse({ [PDF_MISSING_FILES_HEADER]: 'many' }));
    expect((await renderPdf('<p>x</p>')).missingFiles).toBe(0);
  });

  it('throws the API error (503 with Retry-After)', async () => {
    mockApi(() => problemResponse(503, { title: 'PDF export is busy', detail: 'Try again in 5 seconds.' }, { 'Retry-After': '5' }));
    const error = await renderPdf('<p>x</p>').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, title: 'PDF export is busy', retryAfter: 5 });
  });
});
