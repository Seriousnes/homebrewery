import { lazy, Suspense } from 'react';

// Loaded on demand: the dev registry imports every route module eagerly, and this page pulls in
// the editor, pagination and CodeMirror.
const InspectorDevPage = lazy(() => import('./InspectorDevPage').then((m) => ({ default: m.InspectorDevPage })));

export function LazyInspectorDevPage() {
  return (
    <Suspense fallback={null}>
      <InspectorDevPage />
    </Suspense>
  );
}
