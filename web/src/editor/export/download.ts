// Saving the exported file (P6.4): a Blob URL clicked through a temporary <a download>.

/** The Blob URL lives this long after the click (the browser has started the download by then). */
export const REVOKE_DELAY_MS = 60_000;

/** Starts the download of `html` as `filename`. */
export function downloadHtml(html: string, filename: string, doc: Document = document): void {
  const win = doc.defaultView ?? window;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = win.URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.hidden = true;
  doc.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

/** "1.4 MB", "820 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
