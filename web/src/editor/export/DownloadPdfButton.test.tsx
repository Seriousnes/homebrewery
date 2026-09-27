import type { Editor } from '@tiptap/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { clearToasts, toastStore } from '@/ui';
import { DownloadPdfButton } from './DownloadPdfButton';
import type { PdfExportOptions, PdfExportResult } from './exportPdf';
import { EXPORT_TOAST_ID, exportFailure, exportSummary } from './exportSummary';

const editor = { isDestroyed: false } as unknown as Editor;
const chain = { styles: [{ kind: 'url' as const, href: '/themes/V3/5ePHB/style.scoped.css' }] };
const pdf = new Blob(['%PDF-1.7'.padEnd(2048, ' ')], { type: 'application/pdf' });

function result(overrides: Partial<PdfExportResult['report']> = {}, missingFiles = 0): PdfExportResult {
  return {
    pdf,
    filename: 'My brew.pdf',
    missingFiles,
    report: { pages: 3, bytes: 9000, inlined: 4, inlinedBytes: 1500, external: [], failed: [], removed: 0, pageSize: '816px 1056px', fontsSettled: true, ...overrides },
  };
}

const toasts = () => toastStore.getState().toasts;
const button = () => screen.getByRole('button', { name: 'Download PDF' });

afterEach(() => {
  clearToasts();
});

describe('DownloadPdfButton', () => {
  it('waits for the editor and the theme', () => {
    const { rerender } = render(<DownloadPdfButton editor={null} chain={chain} userCss="" lang="en" title="T" />);
    expect(button()).toBeDisabled();
    rerender(<DownloadPdfButton editor={editor} chain={null} userCss="" lang="en" title="T" />);
    expect(button()).toBeDisabled();
    rerender(<DownloadPdfButton editor={editor} chain={chain} userCss="" lang="en" title="T" />);
    expect(button()).toBeEnabled();
  });

  it('exports the brew with its theme, CSS, language and title, downloads the PDF and says what it holds', async () => {
    let finish: (r: PdfExportResult) => void = () => undefined;
    const exportBrew = vi.fn((_source: unknown, _options: PdfExportOptions) => new Promise<PdfExportResult>((resolve) => (finish = resolve)));
    const download = vi.fn();
    const user = userEvent.setup();
    render(<DownloadPdfButton editor={editor} chain={chain} userCss=".page {}" lang="fr" title="Mon grimoire" exportBrew={exportBrew} download={download} />);
    await user.click(button());
    await vi.waitFor(() => expect(exportBrew).toHaveBeenCalledTimes(1));
    expect(exportBrew.mock.calls[0]![0]).toBe(editor);
    expect(exportBrew.mock.calls[0]![1]).toMatchObject({ chain, userCss: '.page {}', lang: 'fr', title: 'Mon grimoire' });
    // Busy: a second click does nothing.
    expect(button()).toHaveAttribute('aria-busy', 'true');
    await user.click(button());
    expect(exportBrew).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish(result());
      await Promise.resolve();
    });
    expect(download).toHaveBeenCalledWith(pdf, 'My brew.pdf');
    expect(button()).not.toHaveAttribute('aria-busy', 'true');
    expect(toasts()).toEqual([expect.objectContaining({ id: EXPORT_TOAST_ID, tone: 'success', title: 'Downloaded “My brew.pdf”', description: '3 pages, 2 KB.' })]);
  });

  it('needs no account and turns failures into an error toast', async () => {
    const exportBrew = vi.fn().mockRejectedValueOnce(new Error('The theme could not be loaded.'));
    const download = vi.fn();
    const user = userEvent.setup();
    render(<DownloadPdfButton editor={editor} chain={chain} userCss="" lang="en" title="T" exportBrew={exportBrew} download={download} />);
    await user.click(button());
    await vi.waitFor(() => expect(toasts()).toHaveLength(1));
    expect(exportBrew).toHaveBeenCalledOnce();
    expect(toasts()[0]).toMatchObject({ tone: 'error', title: "Couldn't make the PDF", description: 'The theme could not be loaded.' });
    expect(download).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(button()).toBeEnabled());
  });

  it('cancels the export when it goes away', async () => {
    let signal: AbortSignal | undefined;
    let finish: (r: PdfExportResult) => void = () => undefined;
    const exportBrew = vi.fn((_source: unknown, options: PdfExportOptions) => {
      signal = options.signal;
      return new Promise<PdfExportResult>((resolve) => (finish = resolve));
    });
    const download = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<DownloadPdfButton editor={editor} chain={chain} userCss="" lang="en" title="T" exportBrew={exportBrew} download={download} />);
    await user.click(button());
    await vi.waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal!.aborted).toBe(true);
    await act(async () => {
      finish(result());
      await Promise.resolve();
    });
    expect(download).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });
});

describe('exportSummary', () => {
  const bytes = (n: number) => `${n} B`;

  it("warns about files that aren't in the PDF", () => {
    expect(exportSummary(result({ pages: 1 }, 1), bytes)).toEqual({
      title: 'Downloaded “My brew.pdf”',
      description: `1 page, ${pdf.size} B. 1 image, font or stylesheet couldn't be included.`,
      tone: 'warning',
    });
    // The server's count and the browser's list overlap: the larger one is shown.
    expect(exportSummary(result({ failed: ['a', 'b', 'c'] }, 2), bytes).description).toBe(
      `3 pages, ${pdf.size} B. 3 images, fonts or stylesheets couldn't be included.`,
    );
  });
});

describe('exportFailure', () => {
  it('explains size and rate limits and shows the problem detail otherwise', () => {
    expect(exportFailure(new ApiError({ kind: 'http', status: 413, title: 'Payload Too Large' })).description).toBe(
      'The brew is too large for a PDF: over 20 MB with its images and fonts.',
    );
    expect(exportFailure(new ApiError({ kind: 'http', status: 429, title: 'Too many requests', detail: 'Try again in 12 seconds.' })).description).toBe(
      'You made several PDFs in a short time. Try again in 12 seconds.',
    );
    expect(
      exportFailure(new ApiError({ kind: 'http', status: 503, title: 'PDF export is busy', detail: 'Too many PDFs are being made right now. Try again in 5 seconds.' })),
    ).toEqual({ title: "Couldn't make the PDF", description: 'Too many PDFs are being made right now. Try again in 5 seconds.', tone: 'error' });
  });
});
