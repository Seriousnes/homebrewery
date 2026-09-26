import { lazy, Suspense } from 'react';

// The dev registry imports every route.tsx eagerly; this page pulls in EditorCanvas and the
// importer, so it loads on first visit only.
const ImportDevPage = lazy(() => import('./ImportDevPage').then((m) => ({ default: m.ImportDevPage })));

export function LazyImportDevPage() {
  return (
    <Suspense fallback={null}>
      <ImportDevPage />
    </Suspense>
  );
}
