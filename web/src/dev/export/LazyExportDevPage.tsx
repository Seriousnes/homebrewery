import { lazy, Suspense } from 'react';

// The dev registry imports every route.tsx eagerly; this page pulls in EditorCanvas, pagination,
// the importer and the export, so it loads on first visit only.
const ExportDevPage = lazy(() => import('./ExportDevPage').then((m) => ({ default: m.ExportDevPage })));

export function LazyExportDevPage() {
  return (
    <Suspense fallback={null}>
      <ExportDevPage />
    </Suspense>
  );
}
