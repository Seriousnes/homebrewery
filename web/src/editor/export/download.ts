// Saving an exported file (issue #2: the PDF): a Blob URL clicked through a temporary <a download>.

/** The Blob URL lives this long after the click (the browser has started the download by then). */
export const REVOKE_DELAY_MS = 60_000;

/** Starts the download of `file` as `filename`. */
export function downloadFile(file: Blob, filename: string, doc: Document = document): void {
  const win = doc.defaultView ?? window;
  const url = win.URL.createObjectURL(file);
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
