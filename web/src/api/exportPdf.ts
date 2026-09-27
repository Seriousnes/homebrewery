// PDF export (issue #2): POST /api/export/pdf renders an exported brew (the self-contained HTML of
// web/src/editor/export) with headless Chromium. Signed-in users only, rate limited.
import { api, type CallOptions, unwrap } from './client';
import { jsonBodyOptions } from './gzip';

/** Response header: how many files the page asked for are not in the PDF. */
export const PDF_MISSING_FILES_HEADER = 'X-Pdf-Missing-Files';

export interface RenderedPdf {
  pdf: Blob;
  /** Files the page asked for that are not in the PDF (other sites that failed, blocked requests). */
  missingFiles: number;
}

/**
 * The PDF of `html` (gzip-compressed when large). Errors: 400 (empty html), 401, 413 (over 20 MB),
 * 429 and 503 (retryAfter), 500 (the render failed or timed out).
 */
export async function renderPdf(html: string, { client = api, signal }: CallOptions = {}): Promise<RenderedPdf> {
  const body = { html };
  const { bodySerializer, headers } = jsonBodyOptions(body);
  let response: Response | undefined;
  const pdf = await unwrap(
    client.POST('/api/export/pdf', { body, bodySerializer, headers, parseAs: 'blob', signal }).then((result) => {
      response = result.response;
      return result;
    }),
    { method: 'POST', url: '/api/export/pdf' },
  );
  const missing = Number(response?.headers.get(PDF_MISSING_FILES_HEADER) ?? 0);
  return { pdf, missingFiles: Number.isInteger(missing) && missing > 0 ? missing : 0 };
}
