import type { Editor } from '@tiptap/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, toastStore } from '@/ui';
import { ExportHtmlButton } from './ExportHtmlButton';
import { EXPORT_TOAST_ID, exportSummary } from './exportSummary';
import type { ExportBrewOptions, ExportResult } from './exportHtml';

const editor = { isDestroyed: false } as unknown as Editor;
const chain = { styles: [{ kind: 'url' as const, href: '/themes/V3/5ePHB/style.scoped.css' }] };

function result(overrides: Partial<ExportResult['report']> = {}): ExportResult {
  return {
    html: '<!DOCTYPE html>',
    filename: 'My brew.html',
    report: { pages: 3, bytes: 2048, inlined: 4, inlinedBytes: 1500, external: [], failed: [], removed: 0, pageSize: '816px 1056px', fontsSettled: true, ...overrides },
  };
}

const toasts = () => toastStore.getState().toasts;

afterEach(() => {
  clearToasts();
});

describe('ExportHtmlButton', () => {
  it('waits for the editor and the theme', () => {
    const { rerender } = render(<ExportHtmlButton editor={null} chain={chain} userCss="" lang="en" title="T" />);
    expect(screen.getByRole('button', { name: 'Export HTML' })).toBeDisabled();
    rerender(<ExportHtmlButton editor={editor} chain={null} userCss="" lang="en" title="T" />);
    expect(screen.getByRole('button', { name: 'Export HTML' })).toBeDisabled();
    rerender(<ExportHtmlButton editor={editor} chain={chain} userCss="" lang="en" title="T" />);
    expect(screen.getByRole('button', { name: 'Export HTML' })).toBeEnabled();
  });

  it('exports the brew with its theme, CSS, language and title, downloads it and says what it holds', async () => {
    let finish: (r: ExportResult) => void = () => undefined;
    const exportBrew = vi.fn((_source: unknown, _options: ExportBrewOptions) => new Promise<ExportResult>((resolve) => (finish = resolve)));
    const download = vi.fn();
    const user = userEvent.setup();
    render(<ExportHtmlButton editor={editor} chain={chain} userCss=".page {}" lang="fr" title="Mon grimoire" exportBrew={exportBrew} download={download} />);
    const button = screen.getByRole('button', { name: 'Export HTML' });
    await user.click(button);
    await vi.waitFor(() => expect(exportBrew).toHaveBeenCalledTimes(1));
    expect(exportBrew.mock.calls[0]![0]).toBe(editor);
    expect(exportBrew.mock.calls[0]![1]).toMatchObject({ chain, userCss: '.page {}', lang: 'fr', title: 'Mon grimoire' });
    // Busy: a second click does nothing.
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(exportBrew).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish(result());
      await Promise.resolve();
    });
    expect(download).toHaveBeenCalledWith('<!DOCTYPE html>', 'My brew.html');
    expect(button).not.toHaveAttribute('aria-busy', 'true');
    expect(toasts()).toEqual([
      expect.objectContaining({ id: EXPORT_TOAST_ID, tone: 'success', title: 'Exported “My brew.html”', description: '3 pages, 2 KB. It opens without an internet connection.' }),
    ]);
  });

  it('reports a failure and nothing is downloaded', async () => {
    const download = vi.fn();
    const exportBrew = vi.fn(() => Promise.reject(new Error('The theme could not be loaded.')));
    const user = userEvent.setup();
    render(<ExportHtmlButton editor={editor} chain={chain} userCss="" lang="en" title="T" exportBrew={exportBrew} download={download} />);
    await user.click(screen.getByRole('button', { name: 'Export HTML' }));
    await vi.waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ tone: 'error', title: "Couldn't export the brew", description: 'The theme could not be loaded.' });
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Export HTML' })).toBeEnabled();
  });

  it('cancels the export when it goes away', async () => {
    let signal: AbortSignal | undefined;
    let finish: (r: ExportResult) => void = () => undefined;
    const exportBrew = vi.fn((_source: unknown, options: ExportBrewOptions) => {
      signal = options.signal;
      return new Promise<ExportResult>((resolve) => (finish = resolve));
    });
    const download = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<ExportHtmlButton editor={editor} chain={chain} userCss="" lang="en" title="T" exportBrew={exportBrew} download={download} />);
    await user.click(screen.getByRole('button', { name: 'Export HTML' }));
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

  it("warns about other sites' files and files that couldn't be included", () => {
    expect(exportSummary(result({ pages: 1, external: ['https://x/a.png'] }), bytes)).toEqual({
      title: 'Exported “My brew.html”',
      description: '1 page, 2048 B. 1 image or font from other sites is linked, not included: it shows only online.',
      tone: 'warning',
    });
    expect(exportSummary(result({ external: ['a', 'b'], failed: ['c'] }), bytes).description).toBe(
      '3 pages, 2048 B. 2 images or fonts from other sites are linked, not included: they show only online. 1 file of this site couldn\'t be included.',
    );
  });
});
