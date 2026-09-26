import { lazy, Suspense } from 'react';

// The dev registry imports every route.tsx eagerly; this page pulls in EditorCanvas, pagination
// and the importer, so it loads on first visit only.
const ObjectsDevPage = lazy(() => import('./ObjectsDevPage').then((m) => ({ default: m.ObjectsDevPage })));

export function LazyObjectsDevPage() {
  return (
    <Suspense fallback={null}>
      <ObjectsDevPage />
    </Suspense>
  );
}
