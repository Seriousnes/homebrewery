import { lazy, Suspense } from 'react';

// The dev registry imports every route.tsx eagerly; this page pulls in marked-hbfm, so it loads
// on first visit only.
const LegacyRenderPage = lazy(() => import('./LegacyRenderPage').then((m) => ({ default: m.LegacyRenderPage })));

export function LazyLegacyRenderPage() {
  return (
    <Suspense fallback={null}>
      <LegacyRenderPage />
    </Suspense>
  );
}
