import { lazy, Suspense } from 'react';

// The dev registry imports every route.tsx eagerly; this page pulls in EditorCanvas, pagination
// and the importer, so it loads on first visit only.
const SnippetsDevPage = lazy(() => import('./SnippetsDevPage').then((m) => ({ default: m.SnippetsDevPage })));

export function LazySnippetsDevPage() {
  return (
    <Suspense fallback={null}>
      <SnippetsDevPage />
    </Suspense>
  );
}
