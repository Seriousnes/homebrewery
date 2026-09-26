// After an import's preview, "Create brew" opens the new brew in the editor: load the /edit route
// and the editor's chunk while the visitor reads the report, so the editor opens without waiting.
// The load starts when the browser is idle (at most IDLE_TIMEOUT_MS later), so it never competes
// with what the visitor does next.

const IDLE_TIMEOUT_MS = 3000;

let prefetched = false;

function whenIdle(run: () => void): void {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
  else window.setTimeout(run, 500);
}

/** Loads the /edit route and the editor chunk in the background, once. A failed load is retried next time. */
export function prefetchEditor(): void {
  if (prefetched) return;
  prefetched = true;
  whenIdle(() => {
    Promise.all([import('@/pages/edit'), import('@/editor/EditorApp/EditorApp')]).catch(() => {
      prefetched = false;
    });
  });
}
