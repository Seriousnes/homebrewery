// The import preview in its own chunk (TipTap, pagination, NodeViews): /import stays small until a
// brew has been converted.
import { lazy, Suspense } from 'react';
import { Spinner } from '@/ui';
import type { ImportPreviewProps } from './ImportPreview';
import styles from './ImportPreview.module.css';

const ImportPreviewChunk = lazy(() => import('./ImportPreview'));

export function LazyImportPreview(props: ImportPreviewProps) {
  return (
    <Suspense
      fallback={
        <div className={styles.fallback} data-testid="import-preview-loading">
          <Spinner label="Loading the preview" />
        </div>
      }
    >
      <ImportPreviewChunk {...props} />
    </Suspense>
  );
}
