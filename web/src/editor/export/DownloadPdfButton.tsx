// "Download PDF" (issue #2, replaces P6.4's "Export HTML"): the app bar's button that saves the
// brew as a PDF. The browser builds the self-contained HTML export; the API renders it. Signed-in
// users only (the render runs on the server): anyone else gets the sign-in prompt. The export code
// loads on the first click (it is not needed to edit or read a brew).
import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import { requestSignIn } from '@/api/events';
import { ApiError } from '@/api/errors';
import type { ThemeChain } from '@/editor/canvas/themeLoader';
import { IconButton, toast } from '@/ui';
import type { ExportSource } from './exportHtml';
import type { PdfExportOptions, PdfExportResult } from './exportPdf';
import { EXPORT_TOAST_ID, exportFailure, exportSummary } from './exportSummary';

export interface DownloadPdfButtonProps {
  editor: Editor | null;
  /** The canvas's theme chain; null while it loads (the button waits). */
  chain: Pick<ThemeChain, 'styles'> | null;
  /** The brew's CSS. */
  userCss: string;
  lang: string;
  title: string;
  /** false: a click asks the reader to sign in. */
  signedIn: boolean;
  /** Replaces exportBrewPdf (tests). */
  exportBrew?: (source: ExportSource, options: PdfExportOptions) => Promise<PdfExportResult>;
  /** Replaces downloadFile (tests). */
  download?: (file: Blob, filename: string) => void;
}

export function DownloadPdfButton({ editor, chain, userCss, lang, title, signedIn, exportBrew, download }: DownloadPdfButtonProps) {
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const ready = editor !== null && !editor.isDestroyed && chain !== null;

  const run = async () => {
    if (!editor || editor.isDestroyed || !chain || busy) return;
    if (!signedIn) {
      requestSignIn();
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const [module, files] = await Promise.all([exportBrew ? null : import('./exportPdf'), import('./download')]);
      const exporter = exportBrew ?? module!.exportBrewPdf;
      const result = await exporter(editor, { chain, userCss, lang, title, signal: controller.signal });
      if (controller.signal.aborted) return;
      (download ?? files.downloadFile)(result.pdf, result.filename);
      toast({ id: EXPORT_TOAST_ID, ...exportSummary(result, files.formatBytes) });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) requestSignIn(error);
      else toast({ id: EXPORT_TOAST_ID, ...exportFailure(error) });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <IconButton
      icon="download"
      label="Download PDF"
      tooltip="bottom"
      disabled={!ready}
      loading={busy}
      onClick={() => void run()}
      data-testid="download-pdf"
    />
  );
}
