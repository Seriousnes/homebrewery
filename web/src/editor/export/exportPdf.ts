// PDF export (issue #2): the brew as a PDF. exportBrewHtml builds the self-contained HTML file
// (paginated pages, theme and brew CSS, TOCs, inlined fonts and images); the API renders it with
// headless Chromium (POST /api/export/pdf), fetching other sites' images and fonts itself.
import type { JSONContent } from '@tiptap/core';
import { renderPdf, type RenderedPdf } from '@/api/exportPdf';
import type { BrewForEdit } from '@/api/types';
import { loadThemeChain } from '../canvas/themeLoader';
import { migrateDoc } from '../schema/migrations';
import { type ExportBrewOptions, exportBrewHtml, exportFileName, type ExportReport, type ExportSource } from './exportHtml';

export interface PdfExportResult {
  pdf: Blob;
  /** "<title>.pdf". */
  filename: string;
  /** The HTML export's report (pages, files of this site that couldn't be included, …). */
  report: ExportReport;
  /** Files the page asked for that are not in the PDF (the API's count). */
  missingFiles: number;
}

export interface PdfExportOptions extends ExportBrewOptions {
  /** Replaces the API call (tests). */
  render?: (html: string, options: { signal?: AbortSignal }) => Promise<RenderedPdf>;
}

/** The brew (an editor, finished paginating first, or a document) as a PDF. */
export async function exportBrewPdf(source: ExportSource, options: PdfExportOptions): Promise<PdfExportResult> {
  const { render = renderPdf, ...htmlOptions } = options;
  const exported = await exportBrewHtml(source, htmlOptions);
  options.signal?.throwIfAborted();
  const rendered = await render(exported.html, { signal: options.signal });
  return {
    pdf: rendered.pdf,
    filename: exportFileName(options.title, 'pdf'),
    report: exported.report,
    missingFiles: rendered.missingFiles,
  };
}

export interface StoredBrewPdfOptions {
  /** The brew's title as the lists show it (the file name). Default: meta.title. */
  title?: string;
  signal?: AbortSignal;
  /** Replaces loadThemeChain (tests). */
  loadChain?: typeof loadThemeChain;
  render?: PdfExportOptions['render'];
}

/** A stored brew: a cloud one (BrewForEdit) or a local one (web/src/editor/local). */
export interface StoredBrew {
  doc: unknown;
  docSchemaVersion: number;
  style: string;
  meta: Pick<BrewForEdit['meta'], 'title' | 'lang' | 'theme'>;
}

/** A saved brew (GET /api/brews/edit/{editId}, or a local brew) as a PDF: its stored pages, theme and CSS. */
export async function exportStoredBrewPdf(brew: StoredBrew, options: StoredBrewPdfOptions = {}): Promise<PdfExportResult> {
  const { signal, loadChain = loadThemeChain, render } = options;
  const doc = migrateDoc(brew.doc as JSONContent, brew.docSchemaVersion);
  const chain = await loadChain(brew.meta.theme, { signal });
  return exportBrewPdf(doc, {
    chain,
    userCss: brew.style,
    lang: brew.meta.lang,
    title: options.title ?? brew.meta.title,
    signal,
    render,
  });
}
