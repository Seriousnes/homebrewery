// Printing the canvas (plan §5): the @media print rules of EditorCanvas.module.css show only the
// pages without zoom; this waits for lazy images first, as upstream's printCurrentBrew did
// (legacy/shared/helpers.js:117-147).

/** Loads every lazy image in `root` now and resolves when all have loaded or failed. */
export async function loadLazyImages(root: ParentNode, timeoutMs = 15_000): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[loading="lazy"], img'));
  for (const img of images) if (img.loading === 'lazy') img.loading = 'eager';
  const pending = images.filter((img) => !img.complete);
  if (pending.length === 0) return;
  await Promise.race([
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Opens the print dialog for the canvas once its images are loaded. */
export async function printCanvas(canvas: HTMLElement, win: Window = window): Promise<void> {
  win.document.dispatchEvent(new CustomEvent('print:startprep'));
  try {
    await loadLazyImages(canvas);
    win.print();
  } finally {
    win.document.dispatchEvent(new CustomEvent('print:finishedprep'));
  }
}
