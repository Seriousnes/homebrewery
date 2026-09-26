// "Export HTML" (P6.4): the app bar's button that saves the brew as one self-contained .html file.
// The export code loads on the first click (it is not needed to edit or read a brew).
import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import type { ThemeChain } from '@/editor/canvas/themeLoader';
import { IconButton, toast } from '@/ui';
import type { ExportBrewOptions, ExportResult, ExportSource } from './exportHtml';
import { EXPORT_TOAST_ID, exportSummary } from './exportSummary';

export interface ExportHtmlButtonProps {
  editor: Editor | null;
  /** The canvas's theme chain; null while it loads (the button waits). */
  chain: Pick<ThemeChain, 'styles'> | null;
  /** The brew's CSS. */
  userCss: string;
  lang: string;
  title: string;
  /** Replaces exportBrewHtml (tests). */
  exportBrew?: (source: ExportSource, options: ExportBrewOptions) => Promise<ExportResult>;
  /** Replaces downloadHtml (tests). */
  download?: (html: string, filename: string) => void;
}

export function ExportHtmlButton({ editor, chain, userCss, lang, title, exportBrew, download }: ExportHtmlButtonProps) {
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const ready = editor !== null && !editor.isDestroyed && chain !== null;

  const run = async () => {
    if (!editor || editor.isDestroyed || !chain || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const [module, files] = await Promise.all([exportBrew ? null : import('./exportHtml'), import('./download')]);
      const exporter = exportBrew ?? module!.exportBrewHtml;
      const result = await exporter(editor, { chain, userCss, lang, title, signal: controller.signal });
      if (controller.signal.aborted) return;
      (download ?? files.downloadHtml)(result.html, result.filename);
      toast({ id: EXPORT_TOAST_ID, ...exportSummary(result, files.formatBytes) });
    } catch (error) {
      if (controller.signal.aborted) return;
      toast({
        id: EXPORT_TOAST_ID,
        title: "Couldn't export the brew",
        description: error instanceof Error ? error.message : String(error),
        tone: 'error',
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <IconButton
      icon="download"
      label="Export HTML"
      tooltip="bottom"
      disabled={!ready}
      loading={busy}
      onClick={() => void run()}
      data-testid="export-html"
    />
  );
}

