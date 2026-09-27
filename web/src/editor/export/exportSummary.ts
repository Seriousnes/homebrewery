// The message after a PDF export (issue #2): what the file holds, and what couldn't be included.
import { ApiError } from '@/api/errors';
import type { ToastTone } from '@/ui';
import type { PdfExportResult } from './exportPdf';

/** The id of the export's toast (a new export replaces the last one's message). */
export const EXPORT_TOAST_ID = 'editor-export-pdf';

export interface ExportToast {
  title: string;
  description: string;
  tone: ToastTone;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The toast after an export: the file, its pages and size, and the files that aren't in it. */
export function exportSummary(
  result: Pick<PdfExportResult, 'filename' | 'report' | 'missingFiles'> & { pdf: Pick<Blob, 'size'> },
  formatBytes: (n: number) => string,
): ExportToast {
  const { report } = result;
  const parts = [`${plural(report.pages, 'page', 'pages')}, ${formatBytes(result.pdf.size)}.`];
  // A file of this site that the browser couldn't read is also one the server couldn't: count the larger.
  const missing = Math.max(result.missingFiles, report.failed.length);
  if (missing) parts.push(`${plural(missing, 'image, font or stylesheet', 'images, fonts or stylesheets')} couldn't be included.`);
  return { title: `Downloaded “${result.filename}”`, description: parts.join(' '), tone: missing ? 'warning' : 'success' };
}

/** The toast after a failed export. */
export function exportFailure(error: unknown): ExportToast {
  const title = "Couldn't make the PDF";
  if (!(error instanceof ApiError)) return { title, description: error instanceof Error ? error.message : String(error), tone: 'error' };
  if (error.status === 413) return { title, description: 'The brew is too large for a PDF: over 20 MB with its images and fonts.', tone: 'error' };
  if (error.status === 429) return { title, description: `You made several PDFs in a short time. ${error.detail ?? 'Try again in a minute.'}`, tone: 'error' };
  return { title, description: error.detail ?? error.title, tone: 'error' };
}
