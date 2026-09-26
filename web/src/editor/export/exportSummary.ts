// The message after an export (P6.4): what the file holds, and what it only links to.
import type { ToastTone } from '@/ui';
import type { ExportResult } from './exportHtml';

/** The id of the export's toast (a new export replaces the last one's message). */
export const EXPORT_TOAST_ID = 'editor-export-html';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The toast after an export: what the file holds and what it doesn't. */
export function exportSummary(result: Pick<ExportResult, 'filename' | 'report'>, formatBytes: (n: number) => string): { title: string; description: string; tone: ToastTone } {
  const { report } = result;
  const parts = [`${plural(report.pages, 'page', 'pages')}, ${formatBytes(report.bytes)}.`];
  if (report.external.length) {
    const one = report.external.length === 1;
    parts.push(`${plural(report.external.length, 'image or font', 'images or fonts')} from other sites ${one ? 'is' : 'are'} linked, not included: ${one ? 'it shows' : 'they show'} only online.`);
  }
  if (report.failed.length) parts.push(`${plural(report.failed.length, 'file', 'files')} of this site couldn't be included.`);
  if (!report.external.length && !report.failed.length) parts.push('It opens without an internet connection.');
  return {
    title: `Exported “${result.filename}”`,
    description: parts.join(' '),
    tone: report.external.length || report.failed.length ? 'warning' : 'success',
  };
}
