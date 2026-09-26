// The S3 fidelity fixtures (web/e2e/fixtures/*.hbfm.txt, written by
// scripts/fidelity-fixtures.ts), loaded lazily by name for the dev harness pages.
const loaders = import.meta.glob<string>('../../../e2e/fixtures/*.hbfm.txt', { query: '?raw', import: 'default' });

const byName = new Map(Object.entries(loaders).map(([file, load]) => [file.replace(/^.*\//, '').replace(/\.hbfm\.txt$/, ''), load]));

/** Every fixture name, sorted. */
export const fixtureNames: string[] = [...byName.keys()].sort();

/** The fixture's text, or null when there is no fixture of that name. */
export async function loadFixture(name: string): Promise<string | null> {
  const load = byName.get(name);
  return load ? load() : null;
}

/**
 * Resolves when every image under `root` has loaded or failed (or after `timeoutMs`).
 * `forceEager` switches lazy images to eager first (as upstream's print does); don't use it on
 * ProseMirror-managed DOM.
 */
export async function settleImages(root: ParentNode, { timeoutMs = 15_000, forceEager = false } = {}): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  if (forceEager) for (const img of images) img.loading = 'eager';
  const pending = images
    .filter((img) => !img.complete)
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    );
  await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
